/**
 * test/web-translate.test.mjs —— 免费接口 + 三家官方接口这四路现译（lib/services/web-translate.js）。
 *
 * ★ 夹具口径（两份，分得很清）：
 *  · `trans-keyless.json` = **真回包**，逐字节来自 translate.googleapis.com
 *    （`tmp/probe-trans.mjs` 经本机系统代理抓的，route.via=proxy、状态 200、0.24~0.91s/发），URL 也一并记下来了，
 *    所以假 fetch 能按**整条查询串**精确匹配 —— 少个参数、没编码、打错主机都会当场报「没登记」，
 *    而不是被前缀匹配蒙过去（那正是"离线全绿、真机读不出结构"的形状）。
 *  · `trans-{baidu,tencent,aliyun}.json` = **一份里两种来历**，逐条打在 `provenance` 上（`tmp/probe-cloud-err.mjs`）：
 *    - `live`：假标识符 + 假签名发出去，对方**点名**回的那一句错误（三家各一条，含状态码与耗时）。
 *      百度的价值尤其大：**没有凭据也拿到了"错误照样回 200"的实测形状**（52003），
 *      阿里那一条是 404 + `Code/Message`（⇒ 判档必须先读回包再看状态码）。
 *    - `synthetic`：成功样本本机没有凭据发不出去，形状照官网响应示例拼。用例不许把它当实测读数。
 *    ★ 两家云是**先查标识符、后验签名** ⇒ 这一发只能证明"请求形状被受理"，**证明不了签名字节正确**
 *      （spec §9.4 未验证清单第一条）。所以签名这一半由用例**独立复算**兜（下面 wt-7/8/9，公式从官网文档抄，不吃被测实现）。
 *
 * ★ 每个用例都断言**假 net 真收到的那一份 URL 与 opts**，不是断言我们以为传出去的东西
 *   （密钥那一条尤其：只有从 calls[].url 里搜得到才算漏，源码扫字符串会漏掉拼接出来的那一发）。
 */
import { check, runAll, assert, fixture, makeFakeFacility } from './_helpers.mjs';
import { createHash, createHmac } from 'node:crypto';
import {
  createWebTranslator, maskQuery, parseKeyless, parseBaidu, parseTencent, parseAliyun,
  normalizeEngine, WEB_ENGINES,
} from '../lib/services/web-translate.js';
import { createTransStore } from '../lib/stores.js';
import {
  DEFAULT_PREFS, KEYLESS_ENDPOINT, TRANSLATE_ENDPOINTS, TRANS_ERROR_KEYS, TRANS_ERROR_LABELS,
  TRANS_IN_MAX, TRANS_OUT_MAX, engineZhLabel, TRANSLATE_ENGINES, TRANSLATE_CRED_FIELDS,
  TRANS_ROW_ENGINES, LEGACY_TRANSLATE_ENGINES, TENCENT_REGION, TENCENT_VERSION, ALIYUN_VERSION,
} from '../lib/domain.js';

const KL = JSON.parse(await fixture('trans-keyless.json'));
const BD = JSON.parse(await fixture('trans-baidu.json'));
const TC = JSON.parse(await fixture('trans-tencent.json'));
const AL = JSON.parse(await fixture('trans-aliyun.json'));
const KL0 = KL.responses[0];
const pick = (doc, id) => doc.responses.find((r) => r.id === id);
const DESC_SRC = 'An open-source toolkit for agent memory with 1342 stars and MIT license';
const APPID = '2026100600000001';
const KEY = 'sekret-key-must-not-leave';
const TC_ID = 'AKIDtcProbeId0000000000000000000000';
const TC_KEY = 'tc-sekret-must-not-leave';
const AL_ID = 'LTAIaliProbeKeyId000000000000000';
const AL_SECRET = 'aliSecretMustNotLeave00000000000000';
const NOW = 1_760_000_000_000;
/** 每一档要填的那两格（键名与假值）：从 domain 那张表派生，不在用例里手抄第二份名单。 */
const CRED_SAMPLE = {
  baiduAppid: APPID, baiduKey: KEY,
  tencentSecretId: TC_ID, tencentSecretKey: TC_KEY,
  aliyunAccessKeyId: AL_ID, aliyunAccessKeySecret: AL_SECRET,
};
const fullCred = (engine) => Object.fromEntries((TRANSLATE_CRED_FIELDS[engine] ?? []).map((f) => [f.key, CRED_SAMPLE[f.key]]));

/** RFC3986 百分号编码：用例自己抄一份（官网规则），用来独立复算阿里那一路的签名。 */
const pct = (v) => encodeURIComponent(String(v))
  .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28')
  .replace(/\)/g, '%29').replace(/\*/g, '%2A');
const b64hmac1 = (key, str) => createHmac('sha1', String(key)).update(Buffer.from(str, 'utf8')).digest('base64');

/** 按真机那条 URL 逐字拼一遍（夹具里存的 path 就是这一串，配不上就是用例拼错了）。 */
function keylessUrl(q) {
  const p = new URLSearchParams();
  p.set('client', 'gtx'); p.set('sl', 'auto'); p.set('tl', 'zh-CN'); p.set('dt', 't'); p.set('q', q);
  return `${KEYLESS_ENDPOINT}?${p.toString()}`;
}

/**
 * 假 net：`routes` 是 `[{ match, ...响应 }]`。match 四种写法，语义在此统一（各用例别靠"反正匹配得上"混着用）：
 *  · `'baidu'` / `'tencent'` / `'aliyun'` / `'keyless'` —— 按**那一档的端点前缀**放行
 *    （官方那三档的 URL 每次带新 salt / Timestamp / Nonce + 签名，逐字匹配没意义）；
 *  · 函数 —— 自己判整条 URL；
 *  · 其余字符串 —— **当作原文**，按真机那条免费 URL 逐字精确匹配。少个参数、没编码、打错主机都当场报「没登记」。
 *
 * ★ `neverResolves` 会挂到 signal 上：真宿主的 fetch 认 abort，假的一定要照样认，
 *   否则「service 侧超时收口」这条判据就变成等一个永远不回来的 promise（wt-13）。
 */
function mkNet(routes = []) {
  const calls = [];
  const onEndpoint = (e) => (url) => url.startsWith(`${TRANSLATE_ENDPOINTS[e]}?`);
  return {
    calls,
    fetch: async (url, opts = {}) => {
      calls.push({ url, opts });
      const hit = routes.find((r) => (typeof r.match === 'function' ? r.match(url)
        : WEB_ENGINES.includes(r.match) ? onEndpoint(r.match)(url)
        : url === keylessUrl(r.match)));
      if (!hit) throw new Error(`假 net 没登记这条 URL：${url.slice(0, 120)}`);
      if (hit.delay) await new Promise((r) => setTimeout(r, hit.delay));
      if (hit.throw) throw hit.throw;
      if (hit.neverResolves) {
        const sig = opts.signal;
        if (!sig) throw new Error('用例没拿到 signal：service 侧没把超时传给 fetch，那条判据就是空的');
        // ★ 这里必须挂一个**不 unref** 的定时器：service 那份超时定时器是 unref 的（不该拖住宿主进程），
        //   全进程只剩它时 Node 会带着未完成的 await 直接退出（llm 套件同一坑，做法照它抄）。
        await new Promise((r) => setTimeout(r, hit.hangMs ?? 60));
        if (!sig.aborted) throw new Error('假 fetch 到点没被 abort ⇒ service 那个超时定时器压根没响');
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      }
      const body = hit.body === undefined ? undefined : (typeof hit.body === 'string' ? JSON.parse(hit.body) : hit.body);
      return {
        status: hit.status ?? 200,
        headers: { get: (k) => hit.headers?.[String(k).toLowerCase()] ?? null },
        text: async () => hit.bodyText ?? JSON.stringify(body ?? ''),
        json: async () => {
          if (hit.jsonThrows) throw new SyntaxError('Unexpected token < in JSON at position 0');
          if (body === undefined || body === null) throw new SyntaxError('empty');
          return body;
        },
      };
    },
  };
}

/** 夹具里存的是**原始字节**（字符串），用例要对象时显式 parse 一次 —— 别让夹具假装它是对象。 */
const rawBody = (r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body);

/** 装配：默认开描述档、引擎按需。`store` 传 'off' 就是拿不到存储域。 */
function mkT({ prefs = {}, net, store = null, now = () => NOW, timeoutMs, warns = [] } = {}) {
  const facility = makeFakeFacility();
  const transStore = store === 'off' ? { available: false, get: async () => null, put: async () => { throw new Error('存储不可用'); } }
    : (store ?? createTransStore({ getFacility: () => facility, logger: { warn: (m) => warns.push(String(m)) } }));
  const prefsView = { ...DEFAULT_PREFS, llmDesc: true, llmReadme: false, translateEngine: 'keyless', ...prefs };
  const t = createWebTranslator({
    net: net ?? mkNet([{ match: DESC_SRC, body: KL0.body }]),
    getPrefs: () => prefsView, transStore, logger: { warn: (m) => warns.push(String(m)) }, now, timeoutMs,
  });
  return { t, prefsView, transStore, warns, facility };
}

/** 装上某一档的凭据（其余各档留空：没选中的那一路连凭据都不该有值）。 */
const withCred = (engine, over = {}) => ({ translateEngine: engine, ...fullCred(engine), ...over });

/* ---------------- 闸门：该不该发 ---------------- */
check('wt-1 开关关着 ⇒ off 且零出网（那一档压根不该连网）', async () => {
  const net = mkNet([]);
  const { t } = mkT({ prefs: { llmDesc: false }, net });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, false);
  assert.equal(r.errKey, 'off');
  assert.equal(r.note, TRANS_ERROR_LABELS.off, '那句原因是 domain 给的，不是本地拼的');
  assert.equal(net.calls.length, 0, '开关关着却出了网');
});

check('wt-2 三家官方档各缺任一格凭据 ⇒ no_credential 且零出网（缺标识符与缺密钥同罪，不发出去挨那句鉴权错误）', async () => {
  for (const engine of Object.keys(TRANSLATE_CRED_FIELDS)) {
    const fields = TRANSLATE_CRED_FIELDS[engine];
    assert.equal(fields.length, 2, `${engine} 这一家的凭据形状变了：设置页那两格是按这个画的`);
    // 只缺标识符 / 只缺密钥 / 两格全缺 / 空格里混空白 —— 四种都算缺（"缺密钥就把标识符先发出去试试"是最难看的一种漏）
    const drops = [...fields.map((f) => ({ [f.key]: '' })), ...fields.map((f) => ({ [f.key]: '   ' })),
      Object.fromEntries(fields.map((f) => [f.key, '']))];
    for (const drop of drops) {
      const net = mkNet([]);
      const { t } = mkT({ prefs: { ...withCred(engine), ...drop }, net });
      const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
      assert.equal(r.ok, false, JSON.stringify({ engine, drop }));
      assert.equal(r.errKey, 'no_credential', JSON.stringify({ engine, drop }));
      assert.equal(r.note, TRANS_ERROR_LABELS.no_credential);
      assert.equal(net.calls.length, 0, `${engine} 缺凭据却出了网`);
      assert.equal(t.ready(), false);
      assert.equal(t.why(), 'no_credential');
      assert.equal(t.currentEngine(), engine);
    }
  }
});

check('wt-3 没有传输层（net 没给 fetch）⇒ transport 那句，不是「翻译失败」一句糊过去', async () => {
  const { t } = mkT({ net: {} });
  assert.equal(t.ready(), false);
  assert.equal(t.why(), 'transport');
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.errKey, 'transport');
});

check('wt-4 路数不认、引擎不归本文件管与空原文：各归各档，都不出网', async () => {
  const net = mkNet([]);
  const { t } = mkT({ net });
  assert.equal((await t.translate({ repo: 'a/b', kind: 'nope', text: 'x' })).errKey, 'error');
  assert.equal((await t.translate({ repo: 'a/b', kind: 'desc', text: '   ' })).errKey, '');
  // 宿主模型那一路归 llm.js 管：万一选路出 bug 把它派到这里，也要当场点名，不许悄悄改用免费接口去译
  const llm = mkT({ prefs: { translateEngine: 'host_llm' }, net: mkNet([]) });
  assert.equal((await llm.t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC })).errKey, 'error');
  assert.equal(llm.t.peek().calls, 0, '不归本文件管的档位连一次都不该发');
  assert.equal(net.calls.length, 0, '闸门档都该在出网之前');
});

check('wt-5 引擎档名归一：旧值 official 搬家到 baidu，脏值落出厂档（本文件只认四路 web）', () => {
  assert.equal(normalizeEngine('official'), 'baidu', '第九轮那一档叫 official');
  assert.equal(normalizeEngine('keyless'), 'keyless');
  assert.equal(normalizeEngine(''), DEFAULT_PREFS.translateEngine);
  assert.equal(normalizeEngine('no-such-engine'), DEFAULT_PREFS.translateEngine);
  assert.deepEqual(WEB_ENGINES, ['keyless', 'baidu', 'tencent', 'aliyun']);
});

/* ---------------- 免费档：真回包 ---------------- */
check('wt-6 免费档按夹具里那条实测 URL 逐字发 GET，回包解析成中文（URL 精确匹配，不出网）', async () => {
  const net = mkNet([{ match: DESC_SRC, body: KL0.body, headers: { 'content-type': KL0.contentType } }]);
  const { t } = mkT({ net });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, true);
  assert.equal(r.zh, parseKeyless(rawBody(KL0)).zh, '解析口径就是那份真回包的读法');
  assert.match(r.zh, /开源工具包/);
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].url, keylessUrl(DESC_SRC), 'URL 必须与真机抓的那条逐字相同（少一个 dt=t 就不算同一条）');
  assert.equal(net.calls[0].url, `${KEYLESS_ENDPOINT}${KL0.path}`, '夹具里存的 path 与代码拼出来的对得上');
  assert.equal(net.calls[0].opts.method, 'GET', '只读 GET 是 §0 铁律');
  for (const banned of ['cookie', 'authorization', 'token']) {
    assert.equal(new RegExp(banned, 'i').test(JSON.stringify(net.calls[0].opts.headers ?? {})), false, `请求头里出现了 ${banned}`);
  }
  assert.equal(r.engine, 'keyless');
  assert.equal(r.label, engineZhLabel('keyless', NOW));
  assert.equal(r.stored, true);
});

check('wt-7 夹具口径：免费档那一份是真回包（有抓取时刻与代理路径），三样样本都能读出中文', () => {
  assert.ok(Number.isFinite(KL.capturedAt) && KL.capturedAt > 0, '没有抓取时刻就不能叫实测');
  assert.equal(KL.route.via, 'proxy', '这台机器直连 translate.googleapis.com 会超时，实测读数必须登记是从代理取的');
  assert.equal(KL.responses.length, 3);
  for (const r of KL.responses) {
    assert.equal(r.status, 200);
    const p = parseKeyless(rawBody(r));
    assert.equal(p.ok, true, `${r.q.slice(0, 30)} 读不出结构`);
    assert.equal((p.zh.match(/[\u4e00-\u9fff]/g) || []).length > 0, true, '真回包里没汉字，夹具该换了');
    assert.ok(r.ms > 0 && r.ms < 5000, `单发 ${r.ms}ms 不在实测带内`);
  }
});

/* ---------------- 三家官方档：签名独立复算 ---------------- */
check('wt-8 百度档：签名按官网公式独立复算，URL 里没有密钥本体（只有它的 MD5 摘要）', async () => {
  const ok = pick(BD, 'ok');
  const net = mkNet([{ match: 'baidu', body: ok.body }]);
  const { t } = mkT({ prefs: withCred('baidu'), net });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, true, r.note || r.errKey);
  assert.equal(r.engine, 'baidu');
  const url = net.calls[0].url;
  assert.equal(url.startsWith(`${TRANSLATE_ENDPOINTS.baidu}?`), true);
  const usp = new URL(url).searchParams;
  assert.equal(usp.get('appid'), APPID, 'appid 是公开身份，要在 URL 里');
  assert.equal(usp.get('to'), 'zh');
  assert.equal(usp.get('from'), 'auto');
  assert.equal(usp.get('q'), DESC_SRC);
  // 独立复算（公式从官网文档抄，不吃 baiduSign 的实现）：签名错了真机只会回 54003，界面上看不出为什么
  const salt = usp.get('salt');
  const expect = createHash('md5').update(`${APPID}${DESC_SRC}${salt}${KEY}`, 'utf8').digest('hex');
  assert.equal(usp.get('sign'), expect, '签名 = MD5(appid + q + salt + 密钥)');
  assert.equal(url.includes(KEY), false, '密钥本体出了网');
  assert.equal(usp.get('key'), null, '密钥不许作为参数名出现');
  assert.equal(net.calls[0].opts.method, 'GET');
  assert.equal(r.zh, parseBaidu(ok.body).zh);
});

check('wt-9 腾讯档：v1 签名按官方 SDK 口径独立复算（签**原值**、出网才编码），密钥本体与 SignatureMethod 都不许出现', async () => {
  const ok = pick(TC, 'ok');
  const net = mkNet([{ match: 'tencent', body: ok.body }]);
  const { t } = mkT({ prefs: withCred('tencent'), net });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, true, r.note || r.errKey);
  assert.equal(r.engine, 'tencent');
  const url = net.calls[0].url;
  assert.equal(url.startsWith(`${TRANSLATE_ENDPOINTS.tencent}?`), true);
  const u = new URL(url);
  const usp = u.searchParams;
  assert.equal(usp.get('Action'), 'TextTranslate');
  assert.equal(usp.get('Version'), TENCENT_VERSION, '版本号写错就是 InvalidAction（本轮对照组成因）');
  assert.equal(usp.get('Region'), TENCENT_REGION, '地域是带连字符的 ap-guangzhou（写成 ap_guangzhou 实测 InvalidParameterValue）');
  assert.equal(usp.get('SecretId'), TC_ID, 'SecretId 是公开身份，要在 URL 里');
  assert.equal(usp.get('ProjectId'), '0');
  assert.equal(usp.get('Source'), 'en');
  assert.equal(usp.get('Target'), 'zh');
  assert.equal(usp.get('SourceText'), DESC_SRC);
  assert.equal(usp.get('SignatureMethod'), null, '腾讯公共参数只有那七个，不发明没写的那一格');
  assert.equal(usp.get('secretkey'), null);
  assert.equal(url.includes(TC_KEY), false, 'SecretKey 本体出了网');
  assert.equal(net.calls[0].opts.method, 'GET');
  // 独立复算：待签串 = GET + host + "/" + "?" + 字典序 `k=v`（v 用**解码后的原值**，这一步不再编码）
  const raw = (k) => [...usp.keys()].filter((x) => x !== 'Signature').sort().map((x) => `${x}=${k === 'raw' ? usp.get(x) : pct(usp.get(x))}`).join('&');
  const expect = b64hmac1(TC_KEY, `GET${u.host}/?${raw('raw')}`);
  assert.equal(usp.get('Signature'), expect, '签名 = Base64(HMAC-SHA1(SecretKey, GET + host + / + ? + 字典序原值))');
  // 反向判据：改成"编码后再签"必须算出**另一个值**（原文里有空格 ⇒ 两种口径必然分开）。少这一条，前一条会被两种实现同时蒙过。
  assert.notEqual(usp.get('Signature'), b64hmac1(TC_KEY, `GET${u.host}/?${raw('pct')}`),
    '编码后再签也算出同一个串 ⇒ 这条样本没有鉴别力，该换原文');
  assert.equal(r.zh, parseTencent(ok.body).zh);
});

check('wt-10 阿里档：RPC V2 签名独立复算，签的就是出网那一份百分号编码串（空格编成 %20 不是 +）', async () => {
  const ok = pick(AL, 'ok');
  const net = mkNet([{ match: 'aliyun', body: ok.body }]);
  const { t } = mkT({ prefs: withCred('aliyun'), net });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, true, r.note || r.errKey);
  assert.equal(r.engine, 'aliyun');
  const url = net.calls[0].url;
  assert.equal(url.startsWith(`${TRANSLATE_ENDPOINTS.aliyun}?`), true);
  const u = new URL(url);
  const usp = u.searchParams;
  assert.equal(usp.get('Action'), 'TranslateGeneral');
  assert.equal(usp.get('Version'), ALIYUN_VERSION);
  assert.equal(usp.get('Format'), 'JSON', '不带 Format 时实测回 404 那档之外还会撞内容协商：官网列的公共参数里就有它');
  assert.equal(usp.get('AccessKeyId'), AL_ID, 'AccessKeyId 是公开身份，要在 URL 里');
  assert.equal(usp.get('SignatureMethod'), 'HMAC-SHA1');
  assert.equal(usp.get('SignatureVersion'), '1.0');
  assert.equal(usp.get('SourceLanguage'), 'en');
  assert.equal(usp.get('TargetLanguage'), 'zh');
  assert.equal(usp.get('SourceText'), DESC_SRC);
  assert.equal(usp.get('FormatType'), 'text', '参数名是 FormatType（官网调用指南逐字），不是 Format');
  assert.equal(usp.get('Scene'), 'general');
  assert.equal(usp.get('RegionId'), null, '这一格官网示例 URL 里没有 ⇒ 不发明');
  assert.match(usp.get('Timestamp'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, '时间戳是 yyyy-MM-ddTHH:mm:ssZ（带毫秒那种格式官网没写）');
  assert.equal(url.includes(AL_SECRET), false, 'AccessKeySecret 本体出了网');
  assert.equal(net.calls[0].opts.method, 'GET');
  // 独立复算：规范化串直接取 URL 上 Signature 之前那一段（签名与出网**同源**，所以这一段就是待签内容）
  const qs = u.search.slice(1);
  const i = qs.lastIndexOf('&Signature=');
  assert.ok(i > 0, 'URL 里没有 Signature 参数');
  const canon = qs.slice(0, i);
  const keys = canon.split('&').map((s) => s.split('=')[0]);
  assert.deepEqual(keys, [...keys].sort(), '规范化查询串必须按 key 字典序');
  assert.equal(canon.includes('SourceText=An%20open-source'), true, '空格要编成 %20（编成 + 是 URLSearchParams 的口径，两边就不是同一个串了）');
  const expect = b64hmac1(`${AL_SECRET}&`, `GET&%2F&${pct(canon)}`);
  assert.equal(usp.get('Signature'), expect, '签名 = Base64(HMAC-SHA1(Secret + "&", GET&%2F&percentEncode(规范化串)))');
  assert.equal(r.zh, parseAliyun(ok.body).zh);
});

check('wt-11 一次性数每发都换：force 重发时 Timestamp/Nonce 必须不同（同一个 Nonce 重放会被鉴权拒）', async () => {
  const ok = pick(TC, 'ok');
  let clock = NOW;
  const net = mkNet([{ match: 'tencent', body: ok.body }]);
  const { t } = mkT({ prefs: withCred('tencent'), net, now: () => (clock += 3_000) });
  await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC, force: true });
  assert.equal(net.calls.length, 2);
  const [a, b] = net.calls.map((c) => new URL(c.url).searchParams);
  assert.notEqual(a.get('Timestamp'), b.get('Timestamp'));
  assert.notEqual(a.get('Nonce'), b.get('Nonce'));
  assert.notEqual(a.get('Signature'), b.get('Signature'), '一次性数换了签名却没换 ⇒ 上一发的签名被抄了过来');

  // 阿里档也要单独盯一遍：它的那一格叫 `SignatureNonce`，与腾讯的 `Nonce` 不是同一个键（只测腾讯等于没测阿里）
  const okAl = pick(AL, 'ok');
  const netAl = mkNet([{ match: 'aliyun', body: okAl.body }]);
  const { t: al } = mkT({ prefs: withCred('aliyun'), net: netAl, now: () => (clock += 3_000) });
  await al.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  await al.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC, force: true });
  assert.equal(netAl.calls.length, 2);
  const [x, y] = netAl.calls.map((c) => new URL(c.url).searchParams);
  assert.notEqual(x.get('SignatureNonce'), y.get('SignatureNonce'), '一次性数写死 ⇒ 重放会被鉴权拒，界面上只剩一句「翻译接口回了错误」');
  assert.notEqual(x.get('Signature'), y.get('Signature'), 'Nonce 换了签名却没换 ⇒ 上一发抄过来的');
});

/* ---------------- 回包判档：三家形状各读各的 ---------------- */
check('wt-12 厂商点名的错误一律当回执带回：三家形状不同，认不出来就得点名 bad_json', () => {
  const bd = parseBaidu(pick(BD, 'err_54003').body);
  assert.equal(bd.ok, false);
  assert.equal(bd.errKey, 'http', '200 但体里带 error_code ⇒ 是接口回了错误，不是读不出结构');
  assert.match(bd.errText, /54003/);
  assert.match(bd.errText, /请检查/);
  const tc = parseTencent({ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'The SecretId is not found' }, RequestId: 'x' } });
  assert.equal(tc.ok, false);
  assert.equal(tc.errKey, 'http');
  assert.match(tc.errText, /AuthFailure\.SecretIdNotFound/, '腾讯的错误在 Response.Error 里，不在顶层');
  const al = parseAliyun({ Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified access key is not found.', HostId: 'mt.aliyuncs.com' });
  assert.equal(al.ok, false);
  assert.equal(al.errKey, 'http');
  assert.match(al.errText, /InvalidAccessKeyId\.NotFound/);
  assert.match(al.errText, /Specified access key/, '厂商那句原话要整段带回去，别只念错误码');
  // 成功侧：百度分段要按顺序拼，阿里两种包装都要认
  assert.equal(parseBaidu(pick(BD, 'ok_multi_seg').body).zh, '用 AI 轻松打造出色网站。无需编写代码，几秒即可部署。', '多段要按顺序拼起来');
  assert.equal(parseAliyun(pick(AL, 'ok').body).ok, true);
  assert.equal(parseAliyun(pick(AL, 'ok_wrapped').body).zh, parseAliyun(pick(AL, 'ok').body).zh,
    '官网文档那条示例是带 TranslateGeneralResponse 外壳的 ⇒ 两种形状都要读得出同一句');
  // 认不出的形状必须能点名（这三家都没有 trans_result/TargetText/Translated 时）
  assert.equal(parseBaidu({ trans_result: [] }).errKey, 'empty');
  assert.equal(parseBaidu({}).errKey, 'bad_json', '既没 trans_result 也没 error_code ⇒ 形状不认识，要能点名');
  assert.equal(parseTencent({ Response: {} }).errKey, 'bad_json');
  assert.equal(parseAliyun({}).errKey, 'bad_json');
});

check('wt-13 非 2xx 也要先读回包：阿里实测错误就是 404 + Code/Message，只按状态码分档会把原因圆掉', async () => {
  const live = pick(AL, 'err_no_credential');
  assert.equal(live.provenance, 'live', '这一档的判据靠真回包钉着');
  assert.equal(live.status, 404);
  const net = mkNet([{ match: 'aliyun', status: live.status, body: live.body }]);
  const { t } = mkT({ prefs: withCred('aliyun'), net });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, false);
  assert.equal(r.errKey, 'http');
  assert.match(r.errText, /InvalidAccessKeyId\.NotFound/);
  assert.match(r.errText, /HTTP 404/, '状态码也要留在回执里');
  assert.equal(r.note, TRANS_ERROR_LABELS.http);
  // 非 2xx 且体不是 JSON ⇒ 状态码自己说话（`http`）；2xx 却读不出结构才是"接口形状变了"（`bad_json`），两句不许混
  const net2 = mkNet([{ match: 'aliyun', status: 200, jsonThrows: true, bodyText: '<html>oops</html>' }]);
  const b = mkT({ prefs: withCred('aliyun'), net: net2 });
  const r2 = await b.t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r2.errKey, 'bad_json');
  const net3 = mkNet([{ match: 'aliyun', status: 503, jsonThrows: true, bodyText: '<html>unavailable</html>' }]);
  const c = mkT({ prefs: withCred('aliyun'), net: net3 });
  const r3 = await c.t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r3.errKey, 'http');
  assert.match(r3.errText, /HTTP 503/);
});

check('wt-14 免费档那几种失败各有各的档（并成一句「翻译失败」就等于把用户支出去自己复现）', async () => {
  const cases = [
    [{ status: 401, bodyText: 'Unauthorized' }, 'http'],
    [{ body: {} }, 'bad_json'],
    [{ jsonThrows: true, bodyText: '<html>' }, 'bad_json'],
    [{ body: [[[DESC_SRC, DESC_SRC]]] }, 'empty'],
    [{ body: [[['英'.repeat(TRANS_OUT_MAX + 5)]]] }, 'too_long'],
    [{ body: [] }, 'bad_json'],
    [{ body: [[[]]] }, 'empty'],
  ];
  for (const [resp, key] of cases) {
    const net = mkNet([{ match: DESC_SRC, ...resp }]);
    const { t } = mkT({ net });
    const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
    assert.equal(r.ok, false);
    assert.equal(r.errKey, key, `回包 ${JSON.stringify(resp).slice(0, 50)} 判成了 ${r.errKey}`);
    assert.equal(r.note, TRANS_ERROR_LABELS[key], '那句原因来自 domain');
    assert.equal(r.zh, '');
    assert.ok(TRANS_ERROR_KEYS.includes(r.errKey), `${r.errKey} 不在登记的档位表里`);
  }
});

check('wt-15 连不上 / 超时都归 transport，报错原文留在 errText 里（界面那句"代理没开"才有凭据）', async () => {
  const thrown = mkNet([{ match: DESC_SRC, throw: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7897'), { code: 'ECONNREFUSED' }) }]);
  const a = mkT({ net: thrown });
  const r1 = await a.t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r1.errKey, 'transport');
  assert.match(r1.errText, /ECONNREFUSED/);
  assert.equal(a.warns.length, 0, '连不上是一发的常态，不该在设置页留一堆告警');

  const hang = mkNet([{ match: DESC_SRC, neverResolves: true }]);
  const b = mkT({ net: hang, timeoutMs: 20 });
  const r2 = await b.t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r2.errKey, 'transport', '超时那一发必须由 service 侧的 signal 收（真宿主不会替我们 abort）');
  assert.equal(hang.calls[0].opts.signal?.aborted, true, 'signal 没被点着 ⇒ 那个定时器压根没响，那句 transport 是白给的');
  assert.match(r2.errText, /abort/i);
});

/* ---------------- 复用与落库 ---------------- */
check('wt-16 逐字复用：同主键同原文命中库里那行、零出网，落款跟着**那一行自己的**引擎', async () => {
  const facility = makeFakeFacility();
  const store = createTransStore({ getFacility: () => facility });
  // 库里躺一行第八轮宿主模型译的（engine 缺档）：换到免费档之后旧译文照用，但署名的还是它当初的来源
  await store.put({ repo: 'a/b', kind: 'desc', src: DESC_SRC, zh: '旧的一句中文。', at: 1_759_000_000_000 });
  const net = mkNet([]);
  const { t } = mkT({ net, store });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, true);
  assert.equal(r.cached, true);
  assert.equal(r.zh, '旧的一句中文。');
  assert.equal(net.calls.length, 0, '逐字命中却重发 ⇒ 白烧一份额度');
  assert.equal(r.engine, 'host_llm', '缺 engine 的老行按第八轮那档落款');
  assert.match(r.label, /^模型现译 ·/);
});

check('wt-17 第九轮那批旧行（engine:official）继续读得出，落款不冒充新档', async () => {
  const store = createTransStore({ getFacility: () => makeFakeFacility() });
  await store.put({ repo: 'a/b', kind: 'desc', src: DESC_SRC, zh: '旧的一句中文。', at: NOW, engine: 'official' });
  const net = mkNet([]);
  const { t } = mkT({ net, store });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, true, r.note || r.errKey);
  assert.equal(r.cached, true, '旧行读不出来 ⇒ 换档等于把用户库里的译文全废一遍');
  assert.equal(r.engine, 'official', '行里写的是当初那一档，就照它落款');
  assert.equal(net.calls.length, 0);
  assert.ok(TRANS_ROW_ENGINES.includes('official'));
});

check('wt-18 原文改一个字就作废重译，且库里记的是折过空白的同一份（绝不拿上一版译文指鹿为马）', async () => {
  const store = createTransStore({ getFacility: () => makeFakeFacility() });
  await store.put({ repo: 'a/b', kind: 'desc', src: DESC_SRC, zh: '旧的一句中文。', at: 1, engine: 'keyless' });
  const net = mkNet([{ match: 'keyless', body: KL0.body }]);
  const { t } = mkT({ net, store });
  // 带双空格：喂进去的写法与库里存的写法不该是两个形状（这里独立折一遍，不吃 service 里那份实现）
  const changed = `${DESC_SRC}  (new)`;
  const folded = changed.replace(/\s+/g, ' ').trim();
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: changed });
  assert.equal(r.cached, false);
  assert.equal(net.calls.length, 1, '原文变了却没重发 ⇒ 拿上一版译文指鹿为马');
  const row = await store.get('desc', 'a/b');
  assert.equal(row.src, folded, '新行记的是折叠后的原文（键只是主键，不是命中判据）');
  assert.equal(row.engine, 'keyless', '这一行是谁译的要记进行里，换档之后落款才跟得上');
  // 同一份原文换个空白写法再点一次：必须命中库里那一行、零出网
  const again = await t.translate({ repo: 'a/b', kind: 'desc', text: `${DESC_SRC} (new)` });
  assert.equal(again.cached, true, '存的时候折了、判的时候没折 ⇒ 每次点开都重烧一份额度');
  assert.equal(net.calls.length, 1);
});

check('wt-19 force（重新取一次）绕开表，且把新行写回去', async () => {
  const store = createTransStore({ getFacility: () => makeFakeFacility() });
  await store.put({ repo: 'a/b', kind: 'desc', src: DESC_SRC, zh: '旧的一句中文。', at: 1, engine: 'keyless' });
  const net = mkNet([{ match: DESC_SRC, body: KL0.body }]);
  const { t } = mkT({ net, store });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC, force: true });
  assert.equal(net.calls.length, 1, '按了「重新取一次」还吃缓存 ⇒ 按钮白点');
  assert.equal(r.cached, false);
  assert.notEqual(r.zh, '旧的一句中文。');
  assert.equal((await store.get('desc', 'a/b')).zh, r.zh, '重译的新行得写回去，否则下一次点开又是旧的');
});

check('wt-20 存储不可用：译文照样显示，但如实说"这次显示完就丢"', async () => {
  const { t } = mkT({ store: 'off', net: mkNet([{ match: DESC_SRC, body: KL0.body }]) });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, true);
  assert.equal(r.stored, false);
  assert.equal(r.note, TRANS_ERROR_LABELS.store);
});

check('wt-21 同一句并发只发一发（点开两次详情不该烧两份额度）', async () => {
  const net = mkNet([{ match: 'keyless', body: KL0.body, delay: 10 }]);
  const { t } = mkT({ net });
  const [a, b] = await Promise.all([
    t.translate({ repo: 'X/y', kind: 'desc', text: DESC_SRC }),
    t.translate({ repo: 'X/y', kind: 'desc', text: DESC_SRC }),
  ]);
  assert.equal(net.calls.length, 1, `并发两发出了 ${net.calls.length} 发`);
  assert.equal(a.zh, b.zh);
});

check('wt-22 命中缓存那一发不组 URL：官方档的待签串在查库之后才算（否则一次性数每次白算）', async () => {
  const ok = pick(TC, 'ok');
  const store = createTransStore({ getFacility: () => makeFakeFacility() });
  await store.put({ repo: 'a/b', kind: 'desc', src: DESC_SRC, zh: '库里已有的一句。', at: NOW, engine: 'tencent' });
  const net = mkNet([{ match: 'tencent', body: ok.body }]);
  const { t } = mkT({ prefs: withCred('tencent'), net, store });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.cached, true);
  assert.equal(net.calls.length, 0);
  assert.equal(t.peek().calls, 0, 'peek().calls 记的是真发出去的发数');
  assert.equal(t.peek().lastUrl, '', '没发过却留了读数 ⇒ 组 URL 提到了缓存判定前面');
});

/* ---------------- 诊断读数 ---------------- */
check('wt-23 打码：三家的标识符各留头 4 位，签名/密钥/一次性数整段遮掉（stats 与日志里只许出现打码形状）', async () => {
  assert.equal(maskQuery('https://x/y?q=a&sign=abcdef123456&salt=999'), 'https://x/y?q=a&sign=***&salt=***');
  assert.equal(maskQuery(`https://x?appid=${APPID}&sign=zz`), `https://x?appid=${APPID.slice(0, 4)}***&sign=***`);
  assert.equal(maskQuery('https://x?Q=1&SIGN=2&Key=3'), 'https://x?Q=1&SIGN=***&Key=***', '参数名大小写混写得照样遮（百度与网页版各有一种写法）');
  assert.equal(maskQuery(`https://x?SecretId=${TC_ID}&Signature=abc%3D%3D`), `https://x?SecretId=${TC_ID.slice(0, 4)}***&Signature=***`, '腾讯那一路的标识符写法不一样也要认');
  assert.equal(maskQuery(`https://x?AccessKeyId=${AL_ID}&Signature=abc`), `https://x?AccessKeyId=${AL_ID.slice(0, 4)}***&Signature=***`);
  for (const [engine, doc, secret] of [['baidu', BD, KEY], ['tencent', TC, TC_KEY], ['aliyun', AL, AL_SECRET]]) {
    const ok = pick(doc, 'ok');
    const net = mkNet([{ match: engine, body: ok.body }]);
    const { t } = mkT({ prefs: withCred(engine), net });
    const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
    assert.equal(r.ok, true, `${engine}: ${r.note || r.errKey}`);
    const peek = t.peek();
    assert.equal(peek.lastUrl.includes(secret), false, `${engine}：诊断读数里不许有密钥`);
    const live = new URL(net.calls[0].url).searchParams.get('sign')
      ?? new URL(net.calls[0].url).searchParams.get('Signature');
    assert.equal(peek.lastUrl.includes(live), false, `${engine}：签名也不许原样躺在读数里`);
    assert.equal(peek.calls, 1);
    assert.equal(peek.lastEngine, engine);
    assert.equal(peek.lastStatus, 200);
  }
});

check('wt-24 入参长度闸门：超 3,500 字的原文截断后再喂，库里记的是**折过但没截**的那一份', async () => {
  const long = `word ${'word '.repeat(TRANS_IN_MAX)}`;
  const net = mkNet([{ match: 'keyless', body: KL0.body }]);
  const { t, transStore } = mkT({ net });
  await t.translate({ repo: 'a/b', kind: 'desc', text: long });
  const q = new URL(net.calls[0].url).searchParams.get('q');
  assert.equal(q.length, TRANS_IN_MAX, `实际喂出去 ${q.length} 字`);
  // ★ 喂出去的是截断的那一份，库里存的必须是完整的：否则另一句「前 3,500 字相同、后面不同」的长原文会误命中这一行
  const row = await transStore.get('desc', 'a/b');
  assert.equal(row.src.length, long.replace(/\s+/g, ' ').trim().length, '落库的原文被截了');
  assert.ok(row.src.length > TRANS_IN_MAX, '库里那份还没截断的原文应当长于入参上限');
  // 同一句（空白写法不同）再点一次：必须命中库里那行、不再出网 —— 这才证明「喂的」与「存的」用的是同一条折叠规则
  const again = await t.translate({ repo: 'a/b', kind: 'desc', text: `  word  ${'word '.repeat(TRANS_IN_MAX)}  ` });
  assert.equal(again.cached, true, '换了空白写法就不命中 ⇒ 每次点开都重烧一份额度');
  assert.equal(net.calls.length, 1, '命中缓存却还出网');
});

check('wt-25 五档引擎名与各张表在 domain 里只有一份（本套件不新增档位）', () => {
  assert.deepEqual(TRANSLATE_ENGINES, ['keyless', 'baidu', 'tencent', 'aliyun', 'host_llm']);
  assert.deepEqual(Object.keys(LEGACY_TRANSLATE_ENGINES), ['official'], '旧档名搬家表只留历史上真写过的那一个');
  for (const legacy of Object.keys(LEGACY_TRANSLATE_ENGINES)) {
    assert.equal(TRANSLATE_ENGINES.includes(LEGACY_TRANSLATE_ENGINES[legacy]), true, `${legacy} 搬去了不存在的档`);
  }
  assert.deepEqual([...TRANS_ROW_ENGINES].sort(), [...TRANSLATE_ENGINES, 'official'].sort(), '表里允许的引擎 = 现行五档 + 旧档名');
  for (const e of TRANSLATE_ENGINES) assert.ok(e === 'host_llm' || TRANSLATE_ENDPOINTS[e], `${e} 没有端点却能被选中`);
  const keys = [...new Set([...TRANS_ERROR_KEYS])];
  assert.equal(keys.length, TRANS_ERROR_KEYS.length, '档位表里有重复');
  for (const k of TRANS_ERROR_KEYS) assert.ok(TRANS_ERROR_LABELS[k], `${k} 没有对应那句`);
});

check('wt-26 夹具口径：三家官方档各有一条无凭据真回包，成功样本明确登记为合成', () => {
  for (const [v, doc, parser] of [['baidu', BD, parseBaidu], ['tencent', TC, parseTencent], ['aliyun', AL, parseAliyun]]) {
    const live = doc.responses.filter((r) => r.provenance === 'live');
    assert.equal(live.length, 1, `${v}：真回包必须恰好一条（多于一条说明夹具被合成样本混进来了）`);
    const r = live[0];
    assert.equal(r.id, 'err_no_credential', `${v}：本机唯一发得出去的那一发就是"没凭据"，成功样本不可能是实测`);
    assert.ok(Number.isFinite(r.capturedAt) && r.capturedAt > 0, `${v}：没有抓取时刻就不能叫实测`);
    assert.equal(r.via, 'direct', `${v}：这三家境内直连可达，实测读数登记的是直连`);
    assert.ok(r.ms > 0 && r.ms < 5000, `${v}：单发 ${r.ms}ms 不在实测带内`);
    assert.equal(new URL(r.probeUrl).host, new URL(doc.endpoint).host, `${v}：夹具抓的那一发与代码用的不是同一个端点`);
    const p = parser(rawBody(r));
    assert.equal(p.ok, false, `${v}：无凭据那一发不该读得出译文`);
    assert.equal(p.errKey, 'http', `${v}：对方点名的错误要判成"接口回了错误"`);
    assert.ok(p.errText.length > 4, `${v}：错误回执是空的 ⇒ 厂商那句原话没带回来`);
    const syn = doc.responses.filter((r2) => r2.provenance === 'synthetic');
    assert.ok(syn.length >= 1, `${v}：一条成功样本都没有 ⇒ 正常路径没法测`);
    for (const s of syn) {
      assert.equal(s.capturedAt, undefined, `${v}/${s.id}：合成样本不许带抓取时刻（带了就是冒充实测）`);
      const q = parser(rawBody(s));
      if (s.id.startsWith('err_')) {
        assert.equal(q.ok, false, `${v}/${s.id}：错误样本被读成了成功`);
        assert.equal(q.errKey, 'http', `${v}/${s.id}：对方点名的错误要判成"接口回了错误"`);
      } else {
        assert.equal(q.ok, true, `${v}/${s.id} 读不出结构 ⇒ 形状与代码对不上，夹具该换了`);
        assert.match(q.zh, /[\u4e00-\u9fff]/);
      }
    }
  }
});

check('wt-27 真机：免费档经本机代理真发一发（SKIP_LOCAL=1 跳过；这条是夹具之外的最后一道）', async () => {
  const { createNetTransport } = await import('../lib/services/net.js');
  const net = createNetTransport({ getPrefs: () => ({ proxyMode: 'system', proxyUrl: '' }), env: process.env });
  const svc = createWebTranslator({
    net, getPrefs: () => ({ ...DEFAULT_PREFS, llmDesc: true, translateEngine: 'keyless' }),
    transStore: createTransStore({ getFacility: () => makeFakeFacility() }),
  });
  const t0 = Date.now();
  const r = await svc.translate({ repo: 'torvalds/linux', kind: 'desc', text: 'The Linux kernel' });
  assert.equal(r.ok, true, `${r.errKey} ${r.errText}`);
  assert.match(r.zh, /[\u4e00-\u9fff]/);
  assert.ok(Date.now() - t0 < 8000, '单发实测带是 0.24~1.07s，超 8s 说明走的是超时那档');
  assert.equal(svc.peek().lastUrl.includes('translate.googleapis.com'), true);
});

check('wt-28 这一档 serve 两路：kinds() 报 desc+readme，摘要开关开着的节选真的译（第十七轮放回）', async () => {
  // ★ 第十五轮这里曾写 `['desc']`，理由是「逐字译不是摘要」（10-07 那屏译文停在「安装询问你的」）。
  //   **第十七轮用户改判放回**（原话「我前面是有摘要现译的，你在哪一次改坏了，给我放出来」）：
  //   那一发本来就出得来中文，撤掉等于删了人家在用的那一屏。留下的只有措辞 —— 段名说「中文节译」（`domain.summarySectionLabel`），
  //   而第十五轮那个"断在半句"的现场不再复现：节选本身已经是 1,600 预算 + 句末收口那一份（第十五轮①②）。
  const README = 'an english readme excerpt';
  const net = mkNet([{ match: README, body: KL0.body }]);
  const { t } = mkT({ prefs: { llmReadme: true }, net });
  assert.deepEqual(t.kinds(), ['desc', 'readme'], '这一档 serve 哪几路是设置页那两行开关的唯一真相（api.translatorView 照它摆）');
  assert.equal(t.enabled('desc'), true, '声明了能力不代表能发：描述那一路仍照自己的开关（别把闸门做成一刀切）');
  assert.equal(t.enabled('readme'), true, '摘要那一路只认 llmReadme 这一个开关，不再被能力声明挡死');
  const r = await t.translate({ repo: 'a/b', kind: 'readme', text: README });
  assert.equal(r.ok, true, '放回的那一发必须真发得出去，不是只把开关摆出来');
  assert.equal(r.engine, 'keyless', '这一行是谁译的记进行里 ⇒ 段名才署得出「免费接口」，不许顶一句「模型现译」');
  assert.equal(net.calls.length, 1);
  // 放回 ≠ 自动派活：开关关着仍然 off 且零出网（烧额度的是用户那一下点击）
  const offNet = mkNet([]);
  const { t: t2 } = mkT({ prefs: { llmReadme: false }, net: offNet });
  assert.equal(t2.enabled('readme'), false);
  const r2 = await t2.translate({ repo: 'a/b', kind: 'readme', text: README });
  assert.equal(r2.errKey, 'off');
  assert.equal(offNet.calls.length, 0, '开关关着还出网 = 白烧用户额度');
});

check('wt-29 回执把厂商请求号排在最前：错误体再长也砍不掉那串号（第十六轮）', async () => {
  // 为什么排前面而不是排后面：调用点那句是 `${statusNote}${errText}`.slice(0, 200)（call() 里），
  // 砍的是**尾巴**。那串号掉在尾巴上 = 用户找客服时报不出任何东西。三家的位置还各不相同：
  // 腾讯在 `Response.RequestId`（错误体 `Response.Error` 的兄弟格）、阿里在顶层 `RequestId`、百度给的是 `log_id`。
  const long = 'The SecretId is not found, please ensure that your SecretId is correct. '.repeat(6);
  const tc = parseTencent({ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: long }, RequestId: '4f68c5ef-3f20-4e63-b846-f76589b1033e' } });
  assert.equal(tc.errText.startsWith('请求号 4f68c5ef-3f20-4e63-b846-f76589b1033e '), true, `请求号没排在最前：${tc.errText.slice(0, 60)}`);
  assert.match(tc.errText, /AuthFailure\.SecretIdNotFound/, '错误码还得在（排前面不能把原因挤掉）');
  const al = parseAliyun({ RequestId: '01A110D9-9E5F-5082-B755-1CF7B78E7B4A', Code: 'InvalidAccessKeyId.NotFound', Message: 'x'.repeat(400), HostId: 'mt.aliyuncs.com' });
  assert.ok(al.errText.includes('01A110D9-9E5F-5082-B755-1CF7B78E7B4A'), '阿里那发在 Error 体之外，照样要认');
  assert.match(al.errText, /InvalidAccessKeyId\.NotFound/);
  const bd = parseBaidu({ error_code: '54003', error_msg: '请检查接口中启用图片功能，及是否开通使用：翻译，检测，AI翻译，长期有效等', log_id: '2048237833' });
  assert.match(bd.errText, /^请求号 2048237833 /, '百度那串叫 log_id，不是 RequestId');
  // 没给请求号（真回包 err_no_credential 就没有）⇒ 不许凭空拼出「请求号 」那种半截话
  const bdLive = parseBaidu(rawBody(pick(BD, 'err_no_credential')));
  assert.equal(bdLive.errText.startsWith('请求号'), false, '没有请求号时那三个字不该出现');
  assert.match(bdLive.errText, /52003 UNAUTHORIZED USER/);
  // 真走一遍出网那一条，量的是**最坏情况**：状态码前缀 + 顶满 64 字的请求号 + 400 字的错误体。
  // 号排在尾巴上的写法在这一发里必然被调用点那句 slice(0,200) 吃掉 ⇒ 这一条才是"排前面"的真判据。
  const worstId = 'R'.repeat(64);
  const net = mkNet([{ match: 'tencent', status: 403, body: { Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: long + 'x'.repeat(300) }, RequestId: worstId } } }]);
  const { t } = mkT({ prefs: withCred('tencent'), net });
  const r = await t.translate({ repo: 'a/b', kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, false);
  assert.equal(r.errKey, 'http');
  assert.ok(r.errText.length <= 200, `回执 ${r.errText.length} 字，顶穿了界面那格`);
  assert.ok(r.errText.includes(worstId), `那串号被 slice 吃掉了：${r.errText}`);
  assert.match(r.errText, /^HTTP 403 请求号 R{64} /, '状态码在前、请求号紧随其后（界面那行一上来就报得出号）');
});

await runAll('web-translate');
