/**
 * ============================================================
 * lib/services/web-translate.js —— 免费接口 / 三家官方接口的现译（spec §8.4，第九轮起、第十轮扩档）
 * ============================================================
 *
 * 用户裁定（2026-10-06）：第九轮「两条都做，设置页选」+「与宿主模型并存，默认落在免费接口」；
 * 第十轮「**腾讯，阿里都接上，切换官方接口时，下面显示去哪个网址注册key**」+ 两条 AskUserQuestion：
 *   「改判铁律，两家都接」⇒ 翻译域允许**厂商标识符**（appid / SecretId / AccessKeyId）进查询串；
 *   「分段器并排五档」⇒ 这一份文件管四路（免费 / 百度 / 腾讯 / 阿里），第五路 `host_llm` 在 `llm.js`。
 * 所以这一档和 `llm.js` 是**同形换体**：`translate({repo, kind, text, force})` 返回同一套字段，
 * 谁被派活由 `prefs.translateEngine` 决定（见 lib/api.js 的 `pickTranslator`），几家共用 `trans` 那一张表。
 *
 * 四条从 §0 铁律里带进来的约束，改这个文件时不许退回去：
 *  1. **只读 GET**：四路都是 GET（第十轮为此改判的是"凭据"那半条，不是"只读"这半条）。
 *     腾讯 v1 与阿里 RPC 都把参数放在查询串里 ⇒ 官方文档里那两种 POST 形状我们没用上。
 *  2. **密钥不上线**：三家的密钥各自只参与一次摘要
 *     （百度 MD5(appid+q+salt+密钥) / 腾讯 Base64(HMAC-SHA1(SecretKey, 待签串)) / 阿里 Base64(HMAC-SHA1(Secret+"&", 待签串))），
 *     出网的 URL 里只有**标识符 + 摘要 + 一次性数**，**密钥本身一个字节都不出去**；
 *     诊断读数里也一律打码（`maskQuery`），快照与日志更不许念它（`hc-19` 钉这三把密钥）。
 *  3. **待签串在缓存命中判定之后才算**：腾讯与阿里的查询串里躺着 `Timestamp` / `Nonce`，
 *     每次尝试都得换新的 ⇒ 组 URL 这一步不许提到查库前面，否则"命中复用"那一档永远拿不到干净口径。
 *  4. **失败不抛、各说各的**：连不上 / 非 2xx / 回包读不出结构 / 没有中文 / 太长，是五个不同的档位
 *     （`TRANS_ERROR_LABELS`），并成一句「翻译失败」就等于把用户支出去自己复现。
 *     厂商原话（`error_msg` / `Response.Error.Message` / `Code+Message`）一律进 `errText` 带回界面。
 *
 * 实测口径（这台机器，2026-10-06，逐条读数在 tmp/round10-sources.md）：
 *  · 免费接口经 127.0.0.1:7897 五发全 200、0.40~1.07s/发；**直连 12s 超时** ⇒ 这一路离不开代理。
 *  · 百度域名直连可达，未注册时回真错误体 `52003 UNAUTHORIZED USER`。
 *  · 腾讯 `tmt.tencentcloudapi.com` 与阿里 `mt.aliyuncs.com` 的 **GET 形状实测被受理**
 *    （各走到 `AuthFailure.SecretIdNotFound` / `InvalidAccessKeyId.NotFound`）；
 *    ⚠️ 但两家都是**先查密钥 ID、后验签名** ⇒ 本机无凭据**证明不了签名字节正确**（spec §9.4 未验证清单第一条）。
 *  · 必应那条"免密钥"的路已经死了：`edge.microsoft.com/translate/auth` 实测 404（所以没做进来）。
 */
import { createHash, createHmac } from 'node:crypto';
import {
  LLM_KINDS, TRANS_TIMEOUT_MS, TRANS_IN_MAX, TRANS_OUT_MAX, CJK_RE,
  TRANSLATE_ENGINES, TRANSLATE_ENDPOINTS, TRANS_ERROR_LABELS, engineZhLabel,
  LEGACY_TRANSLATE_ENGINES, DEFAULT_TRANSLATE_ENGINE, credFieldsOf,
  TENCENT_REGION, TENCENT_VERSION, ALIYUN_VERSION,
} from '../domain.js';

/** 这一份文件负责的档位：从五档里**减**掉宿主模型那一路（新增一档不会漏接，手抄清单会）。 */
export const WEB_ENGINES = TRANSLATE_ENGINES.filter((e) => e !== 'host_llm');

/** 与 llm.js 同一条命中判据：折叠空白后逐字相同。两侧必须用同一个形状，否则库里同一句会存两份。 */
function srcKey(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 库里/界面传来的旧档名先搬家（`official` → `baidu`）；脏值仍按出厂档（同一判据只在 domain 里有一份）。 */
export function normalizeEngine(e) {
  const v = LEGACY_TRANSLATE_ENGINES[e] ?? e;
  return TRANSLATE_ENGINES.includes(v) ? v : DEFAULT_TRANSLATE_ENGINE;
}

/**
 * 查询串里的凭据打码：`appid` / `SecretId` / `AccessKeyId` 只留头 4 位，`sign` / `signature` / `salt` / `key` 整段遮掉。
 * 诊断读数只许出现这个形状。★ 三家标识符写法不同（appid / SecretId / AccessKeyId），正则要一并认，
 *   否则新增那两家的读数就是原样出镜 —— 这一条由 `wt-16` 逐档钉住。
 */
export function maskQuery(url = '') {
  return String(url)
    .replace(/([?&](?:sign|signature|salt|token)=)[^&]*/gi, '$1***')
    .replace(/([?&](?:key|secret|password)=)[^&]*/gi, '$1***')
    .replace(/([?&](?:appid|secretid|accesskeyid)=)([^&]{1,4})[^&]*/gi, '$1$2***');
}

/** 百度通用版的签名：MD5(appid + q + salt + 密钥)。★ 密钥只进这个字符串摘要，不进 URL。 */
export function baiduSign({ appid, q, salt, key }) {
  return createHash('md5').update(`${appid}${q}${salt}${key}`, 'utf8').digest('hex');
}

/** RFC3986 的百分号编码（`encodeURIComponent` 少办 `! ' ( ) *`，阿里那一路要按官网口径补上）。 */
export function pctEncode(v) {
  return encodeURIComponent(String(v ?? ''))
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28')
    .replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

const b64hmac1 = (key, str) => createHmac('sha1', String(key)).update(Buffer.from(str, 'utf8')).digest('base64');

/**
 * 腾讯签名方法 v1（GET 可用）。逐字照官方 Node SDK 的 `formatSignString` + `Sign.sign`：
 *   待签串 = `METHOD` + `host` + `/` + `?` + 字典序 `k=v`（**v 是原值，这一步不做百分号编码**）
 *   签名  = `Base64(HMAC-SHA1(SecretKey, 待签串))`
 * ★ 签名与上线是两套编码：这里按原值签，出网由 `URLSearchParams` 再编码一次 —— 顺序换一下签名就全废。
 * ★ `Signature` 不参与待签串（它本来就不在 params 里）。
 */
export function tencentSign({ secretKey, method = 'GET', host, params }) {
  const canon = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return b64hmac1(secretKey, `${String(method).toUpperCase()}${host}/?${canon}`);
}

/**
 * 阿里 RPC V2 签名（官网《V2版本RPC风格请求体&签名机制》逐字）：
 *   待签串 = `GET&` + percentEncode("/") + `&` + percentEncode(字典序规范化查询串)
 *   签名  = `Base64(HMAC-SHA1(AccessKeySecret + "&", 待签串))`
 * ★ 与腾讯那一档**正好相反**：这里签的就是百分号编码后的串，所以出网也照同一份编码拼，两边必须同函数。
 */
export function aliyunSign({ secret, method = 'GET', params }) {
  const canon = Object.keys(params).sort().map((k) => `${pctEncode(k)}=${pctEncode(params[k])}`).join('&');
  return b64hmac1(`${secret}&`, `${String(method).toUpperCase()}&${pctEncode('/')}&${pctEncode(canon)}`);
}

/**
 * 免费接口（Google 网页版）的回包 → 译文。
 * 形状是嵌套数组 `[[[zh, src, ...], [zh, src, ...]], ...]`（真机读数 tmp/p-g1.json 逐字照此），
 * 读不出这个形状就是 `bad_json` —— 它不是官方接口，形状变了要能点名，别当成"没译出来"。
 */
export function parseKeyless(body) {
  const segs = Array.isArray(body) ? body[0] : null;
  if (!Array.isArray(segs)) return { ok: false, errKey: 'bad_json' };
  const zh = segs.map((s) => (Array.isArray(s) ? String(s[0] ?? '') : '')).join('');
  return zh ? { ok: true, zh } : { ok: false, errKey: 'empty' };
}

/**
 * 把厂商点名的错误抽成一句回执（三家形状各不相同，认不出来就给空串，由调用方按 `bad_json` 说）。
 * ★ 三种嵌套都要认：百度平铺（`error_code`）、腾讯在 `Response.Error`（也可能直接给裸 `Error`）、阿里平铺 `Code`。
 * ★ 第十六轮：**厂商请求号排在最前面**（腾讯在 Response.RequestId、阿里在顶层 RequestId、百度那串叫 log_id —— 三家不在同一个位置）。
 *   调用点把状态码与这一句拼起来再 slice(0, 200)，砍的是**尾巴**；错误体多长由厂商说了算，
 *   号要是跟在正文后面，一句长错误就能把那串唯u4e00u80fdu62a5u7ed9u5382u5546u5ba2u670du7684u4e1cu897f\u6574个吃掉。
 *   排到前面之后它必然落在 HTTP 403 + 请求号 + 64 字（VENDOR_ID_MAX 钉着这个上界）之内，那 200 怎么砍都砍不到它。
 */
const VENDOR_ID_MAX = 64;
function vendorErr(body) {
  if (!body || typeof body !== 'object') return '';
  const node = body?.Response?.Error ?? body?.Error ?? null;
  const code = body.error_code ?? node?.Code ?? body.Code ?? body?.HostId ?? '';
  const msg = body.error_msg ?? node?.Message ?? body.Message ?? '';
  const reqId = String(
    body?.Response?.RequestId ?? body.RequestId ?? node?.RequestId ?? body.log_id ?? body?.Error?.log_id ?? ''
  ).trim().slice(0, VENDOR_ID_MAX);
  return [reqId && `请求号 ${reqId}`, `${code} ${msg}`.trim()].filter(Boolean).join(' ');
}

/** 百度通用版：成功 `{"trans_result":[{"src","dst"}]}`；失败也见过 200 体里带 error_code 的那一种。 */
export function parseBaidu(body) {
  const rows = Array.isArray(body?.trans_result) ? body.trans_result : null;
  if (!rows) return { ok: false, errKey: vendorErr(body) ? 'http' : 'bad_json', errText: vendorErr(body) };
  const zh = rows.map((r) => String(r?.dst ?? '')).join('');
  return zh ? { ok: true, zh } : { ok: false, errKey: 'empty' };
}

/** 腾讯 TextTranslate：译文在 `Response.TargetText`；错误在 `Response.Error.{Code,Message}`（状态码非 2xx 也要念它）。 */
export function parseTencent(body) {
  const zh = body?.Response?.TargetText;
  if (typeof zh === 'string' && zh) return { ok: true, zh };
  const err = vendorErr(body?.Response ?? body);
  return { ok: false, errKey: err ? 'http' : 'bad_json', errText: err };
}

/** 阿里 TranslateGeneral：译文在 `Data.Translated`（官网调用指南逐字），文档里那层 `TranslateGeneralResponse` 包装也认。 */
export function parseAliyun(body) {
  const zh = body?.Data?.Translated ?? body?.TranslateGeneralResponse?.Data?.Translated;
  if (typeof zh === 'string' && zh) return { ok: true, zh };
  const err = vendorErr(body?.TranslateGeneralResponse ?? body);
  return { ok: false, errKey: err ? 'http' : 'bad_json', errText: err };
}

/** 每档一个解析器。★ 键与 `TRANSLATE_ENGINES` 同名单（宿主模型那档不在这一张表里）。 */
const PARSERS = { keyless: parseKeyless, baidu: parseBaidu, tencent: parseTencent, aliyun: parseAliyun };

/** 把查询参数拼成 URL。★ 全部走 `URLSearchParams`，不许手拼（原文里带 `&` 与 `#` 是常态）。 */
function withQuery(base, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.set(k, String(v ?? ''));
  return `${base}?${usp.toString()}`;
}

/**
 * @param net        `createNetTransport` 那一份（`net.fetch`）—— 代理仲裁与 github 那两发同一条路
 * @param getPrefs   现取现算的偏好（引擎、两档开关、各家凭据）
 * @param transStore 译文表（与 llm.js 共用一张，谁译的记在行里的 `engine`）
 */
export function createWebTranslator({
  net, getPrefs = () => ({}), transStore, logger,
  now = () => Date.now(), timeoutMs = TRANS_TIMEOUT_MS,
} = {}) {
  const fetchFn = net?.fetch ?? null;
  const inflight = new Map();
  /** 诊断读数（用例与真机走查都从这里取）。★ url 一律打码后再存。 */
  const stats = { calls: 0, cached: 0, failed: 0, lastUrl: '', lastStatus: 0, lastMs: 0, lastEngine: '', lastErrText: '' };

  /**
   * ★ 第十五轮这里曾写 `['desc']`（以"逐字译不是摘要"为由不派 `readme` 那一发，设置页那行开关也跟着不摆）。
   *   **第十七轮用户改判放回**：那一发本来就出得来中文，撤掉等于把人家在用的那一屏删了。
   *   留下的只有措辞：段名与那一行的说明句按档位说「中文节译」（`domain.summarySectionLabel` / `switchRowLabel`），
   *   不再挂一句"摘要"指着一段逐字翻译。第十五轮那个"断在半句"的现场（`节选 600 / 整篇 16,433`）也不再复现 ——
   *   节选本身已经是 1,600 预算 + 句末收口那一份（第十五轮①②），这一发喂出去的就是它。
   */
  const SERVED_KINDS = ['desc', 'readme'];
  const kinds = () => [...SERVED_KINDS];

  const enabled = (kind) => {
    if (!SERVED_KINDS.includes(kind)) return false;
    const p = getPrefs() || {};
    return kind === 'readme' ? p.llmReadme === true : p.llmDesc === true;
  };

  /** 这一档引擎现在**能不能**发一发（设置页与能力位都念这句，别在界面里另判一遍）。 */
  function engine() {
    const p = getPrefs() || {};
    const e = normalizeEngine(p.translateEngine);
    if (!fetchFn) return { engine: e, can: false, why: 'transport' };
    if (e !== 'keyless') {
      // ★ 缺哪一格都不发（不是"缺密钥就把标识符先发出去试试"）：标识符本身也是账号信息，白给一次不算体面。
      const missing = credFieldsOf(e).filter((f) => !String(p[f.key] ?? '').trim());
      if (missing.length) return { engine: e, can: false, why: 'no_credential' };
    }
    return { engine: e, can: true, why: '' };
  }

  const blank = { ok: false, zh: '', cached: false, at: 0, label: '', stored: false, note: '', errKey: '', errText: '', engine: '' };
  const fail = (errKey = '', errText = '') => ({
    ...blank, errKey, errText, note: TRANS_ERROR_LABELS[errKey] || '',
  });

  /**
   * 组这一发的 URL。★ 一次性数（salt / Timestamp / Nonce）在这里现算 —— 调用点已经在缓存判定之后（§0 第 3 条）。
   * 返回 `{url}`；长度闸门（`TRANS_IN_MAX`）也在这里统一吃，四家一个口径。
   */
  function buildUrl(e, src, p) {
    const q = src.slice(0, TRANS_IN_MAX);
    const base = TRANSLATE_ENDPOINTS[e];
    if (e === 'keyless') {
      return withQuery(base, { client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q });
    }
    const cred = (key) => String(p[key] ?? '').trim();
    if (e === 'baidu') {
      const appid = cred('baiduAppid');
      const salt = String(now());
      return withQuery(base, {
        q, from: 'auto', to: 'zh', appid, salt,
        sign: baiduSign({ appid, q, salt, key: cred('baiduKey') }),
      });
    }
    if (e === 'tencent') {
      const host = new URL(base).host;
      const params = {
        Action: 'TextTranslate', Version: TENCENT_VERSION, Region: TENCENT_REGION,
        Timestamp: String(Math.floor(now() / 1000)), Nonce: String(Math.floor(now() % 1e6) + 1),
        SecretId: cred('tencentSecretId'),
        ProjectId: '0', Source: 'en', Target: 'zh', SourceText: q,
      };
      // 腾讯官网那七个公共参数里没有 `SignatureMethod`（默认就是 HmacSHA1）⇒ 不发明没写的那一格。
      return withQuery(base, { ...params, Signature: tencentSign({ secretKey: cred('tencentSecretKey'), host, params }) });
    }
    // 阿里：签名要百分号编码，出网也必须用**同一份**编码（用 URLSearchParams 会把空格编成 `+`，两边就不是同一个串了）。
    // ★ 公共参数里没有 `RegionId`：官网《通用版调用指南》那条示例 URL 里就没有它，发明一格只会多一种错法。
    const params = {
      Action: 'TranslateGeneral', Version: ALIYUN_VERSION, Format: 'JSON',
      AccessKeyId: cred('aliyunAccessKeyId'),
      SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0',
      SignatureNonce: `${now()}-${Math.floor(Math.random() * 1e6)}`,
      Timestamp: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      SourceLanguage: 'en', TargetLanguage: 'zh', SourceText: q, FormatType: 'text', Scene: 'general',
    };
    const canon = Object.keys(params).sort().map((k) => `${pctEncode(k)}=${pctEncode(params[k])}`).join('&');
    const sig = aliyunSign({ secret: cred('aliyunAccessKeySecret'), params });
    return `${base}?${canon}&Signature=${pctEncode(sig)}`;
  }

  /** 真发一发（GET）。返回 `{ok:true, zh}` 或 `{ok:false, errKey, errText}`，**不抛**。 */
  async function call(kind, src, e) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const p = getPrefs() || {};
    const url = buildUrl(e, src, p);
    stats.calls += 1;
    stats.lastEngine = e;
    stats.lastUrl = maskQuery(url);
    const t0 = now();
    let res = null;
    let threw = null;
    try {
      res = await fetchFn(url, { method: 'GET', signal: ac.signal, headers: { accept: 'application/json' } });
    } catch (err) {
      threw = err;
    } finally {
      clearTimeout(timer);
      stats.lastMs = now() - t0;
    }
    if (threw) {
      // 连不上 / 代理不通 / 超时都归 `transport` 一档：这一档那句话本来就写着"要经代理，代理没开或不通就是这句"，
      // 再切一档 timeout 只会让界面多一句用户分不清的话；报错原文（含 UND_ERR_*）走 errText。
      stats.failed += 1;
      const text = String(threw?.message ?? threw).slice(0, 200);
      stats.lastErrText = text;
      return { ok: false, errKey: 'transport', errText: text };
    }
    stats.lastStatus = Number(res?.status) || 0;
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    // ★ 先看回包里有没有厂商点名的错误，再看状态码：阿里那一路**错误也带非 2xx**（实测 404 + Code/Message），
    //   腾讯的 `Response.Error` 也回 200 —— 只按状态码分档就会把"对方已经告诉你的原因"圆成一句"回了错误状态"。
    //   读不出 JSON 时状态码仍然说话：4xx/5xx 是"接口回了错误状态"（`http`），2xx 却读不出结构才是"形状变了"（`bad_json`）。
    if (!body) {
      stats.failed += 1;
      const status = Number(res?.status) || 0;
      const r = {
        ok: false,
        errKey: status >= 400 ? 'http' : 'bad_json',
        errText: status ? `HTTP ${status}` : '',
      };
      stats.lastErrText = r.errText;
      return r;
    }
    const parsed = (PARSERS[e] ?? parseKeyless)(body);
    if (!parsed.ok) {
      stats.failed += 1;
      const statusNote = Number(res?.status) === 200 ? '' : `HTTP ${res?.status ?? '?'} `;
      const r = { ok: false, errKey: parsed.errKey || 'bad_json', errText: `${statusNote}${parsed.errText ?? ''}`.trim().slice(0, 200) };
      stats.lastErrText = r.errText;
      return r;
    }
    const zh = parsed.zh.trim();
    if (!zh) { stats.failed += 1; return { ok: false, errKey: 'empty' }; }
    if (zh.length > TRANS_OUT_MAX) { stats.failed += 1; return { ok: false, errKey: 'too_long', errText: `${zh.length} 字` }; }
    // 没汉字就当没译出来：接口把英文原样吐回来时，宁可显示原文，也不给一句"顶着中文标签的英文"。
    if (!(zh.match(CJK_RE) || []).length) { stats.failed += 1; return { ok: false, errKey: 'empty' }; }
    return { ok: true, zh };
  }

  /** 完整闸门：开关 → 引擎能不能发 → 表里逐字复用 → 真发一发 → 尽力落库。 */
  async function translate({ repo, kind, text, force = false } = {}) {
    if (!LLM_KINDS.includes(kind)) return fail('error', `未知的现译路数：${kind}`);
    const src = srcKey(text);
    if (!src) return fail();
    if (!enabled(kind)) return fail('off');
    const { engine: e, can, why } = engine();
    if (!can) return fail(why || 'transport');
    if (!WEB_ENGINES.includes(e)) return fail('error', `这一档不归本文件管：${e}`);

    const key = String(repo ?? '').trim().toLowerCase();
    const rowKey = `${kind}:${key}`;
    if (transStore?.available && !force) {
      const row = await transStore.get(kind, key).catch(() => null);
      // ★ 复用只看「主键 + 原文逐字」，**不看引擎**（第九轮口径）：换了引擎旧译文照用，落款跟着行里的 engine 走。
      if (row && row.kind === kind && row.src === src && row.zh) {
        stats.cached += 1;
        return {
          ...blank, ok: true, zh: row.zh, cached: true, at: row.at, engine: row.engine ?? 'host_llm',
          label: engineZhLabel(row.engine, row.at), stored: true,
        };
      }
    }

    if (inflight.has(rowKey)) return inflight.get(rowKey);
    const p = (async () => {
      const r = await call(kind, src, e);
      if (!r.ok) return fail(r.errKey, r.errText);
      const at = now();
      let stored = true;
      if (transStore?.available) {
        await transStore.put({ repo: key, kind, src, zh: r.zh, at, chars: r.zh.length, engine: e })
          .catch((err) => {
            stored = false;
            logger?.warn?.(`[gh-trending] 译文写库失败（${err?.message ?? err}），这次显示完就丢，下次点开重译`);
          });
      } else stored = false;
      return {
        ...blank, ok: true, zh: r.zh, cached: false, at, engine: e, label: engineZhLabel(e, at),
        stored, note: stored ? '' : TRANS_ERROR_LABELS.store,
      };
    })().finally(() => inflight.delete(rowKey));
    inflight.set(rowKey, p);
    return p;
  }

  return {
    /** 这一档引擎在位且发得出（免费接口看传输层，官方那三家还要看各自的凭据两格）。 */
    ready: () => engine().can,
    why: () => engine().why,
    currentEngine: () => engine().engine,
    kinds,
    enabled,
    translate,
    peek: (k) => (k ? stats[k] : { ...stats }),
    dispose: () => inflight.clear(),
  };
}
