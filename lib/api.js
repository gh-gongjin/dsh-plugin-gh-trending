/**
 * lib/api.js —— 宿主可见的唯一 HTTP 面：路由表 + SSE hub。
 * 三件事：写操作回环闸门 → 表驱动分派 → 错误码集中翻译成 HTTP 语义。
 *
 * openSse / createHub 是 sysops / modelwatch lib/api.js 同名实现的同源拷贝（帧语义不许两边漂）：
 * `: ok` 冲缓冲、25s `: ping` 心跳（unref）、心跳写失败当场摘牌。
 *
 * 回环闸门拦所有写操作（触发检查 / 保存偏好）+ 一条会花上游配额的 GET（/api/repo）：
 * 本插件对系统零破坏面，纯读面板的 GET 不闸是为了真机排障时能从别机看面板。
 *
 * ★ 宿主只给 handler 传 (req,res)：body 必须自己从流里拼（bodyArg 只有测试会喂）。
 */
import {
  TRENDING_SOURCE_NOTE, BOARDS, BOARD_LABELS, LANG_CHECK, EVENTS_IN_SNAPSHOT,
  TRANSPORT_HINT, TRANSPORT_VIA_LABELS, transportHint, transportSourceLabel, PROXY_MODES, PROXY_URL_MAX,
  LLM_SWITCHES, switchRowLabel, LLM_NOT_READY_HINT,
  TRANSLATE_ENGINES, TRANSLATE_ENGINE_LABELS, TRANSLATE_ENGINE_HINTS, TRANSLATE_REGISTER,
  TRANSLATE_COMMON_NOTE, DEFAULT_TRANSLATE_ENGINE, LEGACY_TRANSLATE_ENGINES,
  TRANS_ERROR_LABELS, SECRET_SAVED_HINT, TRANSLATE_CRED_NOTE, DESC_ZH_BLOCKED_NOTE,
  PREF_CRED_FIELDS, PREF_SECRET_KEYS, GH_CRED_FIELDS, GH_TOKEN_NOTE, GH_TOKEN_REGISTER,
  credFieldsOf,
} from './domain.js';
import { crossBoards } from './check.js';
import { descZhFor } from './desc-zh.js';
import { descZhView, descZhRows, boardDescZhHead, createBoardZhRunner } from './board-zh.js';
import { starsView } from './stars.js';
import { createAllStarsRunner } from './services/all-stars.js';
import { applyZh, readmeZhOnScreen } from './services/repo.js';
import { normalizeLanguage } from './services/gh.js';
import { parseProxyUrl } from './services/net.js';

export const ROUTE_PREFIX = '/gh-trending';
export const GLOBAL_KEY = '__GH_TRENDING__';

/* ------------------------------------------------------------------ *
 * 响应 / 请求体
 * ------------------------------------------------------------------ */
export function jsonOk(res, data) {
  return json(res, 200, { ok: true, data });
}
function errBody(code, message) {
  return { ok: false, error: { code, message } };
}
export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
  return true;
}
export function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req && typeof req === 'object' && req.__parsedBody && typeof req.__parsedBody === 'object') {
      return resolve(req.__parsedBody);
    }
    if (!req || typeof req.on !== 'function') return resolve({});
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BAD_JSON' }));
        req.destroy?.();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' })); }
    });
    req.on('error', (e) => reject(Object.assign(new Error(String(e?.message ?? e)), { code: 'BAD_JSON' })));
  });
}

/* ------------------------------------------------------------------ *
 * 错误码 → HTTP 状态码（集中一张表）
 * ------------------------------------------------------------------ */
const CODE_STATUS = {
  GHT_RECORDS_UNAVAILABLE: 501,
  GHT_RECORDS_CLOSED: 503,
  GHT_RECORDS_INVALID: 400,
  GHT_RECORDS_NOT_FOUND: 404,
  GHT_RECORDS_DUPLICATE: 409,
  CHECK_BUSY: 409,
  BAD_JSON: 400,
  INVALID_PARAM: 400,
  FORBIDDEN: 403,
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
};
export function statusFor(code) {
  return CODE_STATUS[code] ?? 500;
}

/* ------------------------------------------------------------------ *
 * SSE：单条连接 + 广播 hub（同源拷贝，见文件头）
 * ------------------------------------------------------------------ */
export const SSE_HEARTBEAT_MS = 25000;

export function openSse(res, opts = {}) {
  const {
    onBroken = null,
    setIntervalMod = setInterval,
    clearIntervalMod = clearInterval,
    heartbeatMs = SSE_HEARTBEAT_MS,
  } = opts;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  res.write(': ok\n\n');
  const hb = setIntervalMod(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch {
      closed = true;
      clearIntervalMod(hb);
      onBroken?.();
    }
  }, heartbeatMs);
  if (typeof hb.unref === 'function') hb.unref();
  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearIntervalMod(hb);
    },
  };
}

export function createHub(onFirst, onLast) {
  const clients = new Set();
  const api = {
    add(client) {
      clients.add(client);
      if (clients.size === 1) onFirst?.();
    },
    remove(client) {
      if (!clients.delete(client)) return;
      try { client.close?.(); } catch { /* 关不上的连接已断，无需解释 */ }
      if (clients.size === 0) onLast?.();
    },
    get count() { return clients.size; },
    broadcast(event, data) {
      for (const c of [...clients]) {
        try { c.send(event, data); } catch { api.remove(c); }
      }
    },
    dispose() {
      for (const c of [...clients]) api.remove(c);
    },
  };
  return api;
}

/**
 * 最近一发的传输路径（谁真的把包发出去了）。
 * 界面把它原样念出来，是为了让「代理没生效」和「网络不通」在两行字里就能分开 ——
 * 本插件最初那起故障就是被写成一句「直连未通」，用户看不出自己其实配了代理、也看不出代理通了没。
 * route 来自 createNetTransport().describe()：代理地址已打码，凭据永不出进程边界。
 * ★ export 出去是给 test/client.test.mjs 造快照用的：视图形状由这一处构造，用例不再手搓一份。
 */
export function netView(deps, boards = {}) {
  const route = deps.getTransportRoute?.() ?? null;
  if (!route) return { route: null, hint: TRANSPORT_HINT, view: null };
  const view = {
    via: route.via ?? 'idle',
    viaLabel: TRANSPORT_VIA_LABELS[route.via] ?? String(route.via ?? '未知'),
    source: route.source ?? '',
    sourceLabel: transportSourceLabel(route.source),
    proxy: route.proxy ?? '',
    reason: route.reason ?? '',
    targetHost: route.targetHost ?? '',
    at: route.at ?? 0,
    status: transportStatus(route, boards),
  };
  // 整句话在宿主拼好：客户端只搬字，它一重排或补个标点，两处口径就漂了
  const parts = [view.viaLabel, view.sourceLabel, view.proxy];
  // 「没能出网」这一档，原因就是这一行要说的全部；其余档的原因与 transportHint 重复，留在 title 里
  if (view.via === 'failed') parts.push(view.reason);
  view.text = parts.filter(Boolean).join(' · ');
  return { route, hint: transportHint(route), view };
}

/**
 * 状态点：这一行说的是「包从哪条路出去、那条路通到了没有」，不是「数据新不新」。
 * via=failed ⇒ 配置坏到根本没出网；via 是 proxy/direct 时，只有榜面全坏且坏因是传输类才判没通 ——
 * 源自己回 500 是数据源的事，别把黑锅扣在代理头上（那是本插件最初把两种故障写成一句话的地方）。
 */
function transportStatus(route, boards) {
  if (!route || route.via === 'idle') return 'idle';
  if (route.via === 'failed') return 'err';
  const seen = BOARDS.map((b) => boards?.[b]).filter((x) => x?.hasData === true);
  if (!seen.length) return 'idle';
  const allBad = seen.every((x) => x.ok !== true);
  const anyTransport = seen.some((x) => x.transport === true);
  return allBad && anyTransport ? 'err' : 'ok';
}

/* ------------------------------------------------------------------ *
 * 快照装配（一份真相：界面看到的字段全部来自这里，客户端不补任何判定）
 * ------------------------------------------------------------------ */

/**
 * 离开这台机器之前的那道闸：把密钥那一格摘掉。
 * ★ 三个出口（snapshot / GET prefs / POST prefs 的回执）必须走同一个函数：少一处就是一份第二真相，
 *   而「哪一处漏了」在本地测不出来（浏览器控制台里能看到的那一格就是证据）。
 * 密钥只在 `lib/services/web-translate.js` 里参与签名计算、以及在 `lib/services/repo.js` 里拼那一条 `Authorization` 请求头，
 * 两条路吃的都是宿主内存里的 prefsStore 原值，不经过这里。
 * ★ 第二十一轮起这里摘的是**四把**（三把云密钥 + GitHub 令牌）：清单从 domain 的字段表派生，加一格出口就自动多扫一格。
 */
export function publicPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return prefs;
  // ★ 密钥清单从 domain 的凭据字段表派生（第二十一轮起四把：三把云密钥 + GitHub 令牌）：手抄就会漏掉新增那一家，密钥原样穿进快照。
  const rest = { ...prefs };
  for (const k of PREF_SECRET_KEYS) delete rest[k];
  return rest;
}

/**
 * 现译这一路的界面视图：开关状态 + **当前引擎** + 那一档能不能发。键恒在，关着也给 false（客户端不许猜）。
 * ★ export 出来是给 `test/client.test.mjs` 的夹具现造的（同 netView 那条律）：客户端那半边的
 *   fixture 一旦自己拼形状，宿主少给一个键它照样绿。
 *
 * ★ 快照键名与 deps 键名都叫 `translator` 而不是 `llm`：`hc-8` 那条判据扫的是「`<对象>.llm` 这种取句柄的形状」，
 *   它分不清宿主服务对象和详情载荷；界面半边一旦写 `snap.llm.ready` 就撞上同一条正则，
 *   而这条命中的意思是「把宿主模型句柄传出了白名单文件」——键名换成 `translator` 才是它本来的语义。
 *
 * ★ 第九轮（引擎可选）新增、第十轮（五档 + 三家凭据 + 注册地址）落定的那几格全部来自 domain，界面一个字都不自己写：
 *   `engine` 是当前档、`engines` 是设置页那五个按钮的顺序（客户端不排表）、`engineHint` 与 `notReadyHint` 都只说**当前这一档**。
 *   ★ 没给五档各自的 `tiers`：界面只需要"选中的这档能不能发"，另四档的可用性摆出来就是四行没人点的话。
 *   标识符（`baiduAppid` / `tencentSecretId` / `aliyunAccessKeyId`）不在这里给：它们不是密钥，本来就在 `prefs` 里，界面从 prefs 取 —— 一个值不许有两处出口。
 *   三把密钥（`baiduKey` / `tencentSecretKey` / `aliyunAccessKeySecret`）**永远不回显**：`credFields[].has` 那位布尔就是全部真相，
 *   `credStored` 只由它派生出来管「清除」那颗按钮摆不摆（`hc-19` 与 `client-52` 两头钉 `'value' in f === false`）。
 */
export function translatorView(deps, prefs) {
  const engine = translateEngineOf(prefs);
  const live = pickTranslator(deps, prefs);
  const ready = live?.ready?.() === true;
  // 发不出去的原因由那一路服务自己说（它才知道是没代理还是没凭据）；模型那档没有 this 说法，恒给那一句。
  const why = ready ? '' : (engine === 'host_llm' ? 'unavailable' : String(live?.why?.() ?? 'transport'));
  // ★ 这一档要吃凭据的几格（免费接口与宿主模型 ⇒ 空表，界面上连输入框都不摆）。
  //   `value` 永不在这里：非密钥格走 `prefs`（本来就在快照里），密钥格只给一位 `has` 布尔。
  const credFields = credFieldsOf(engine).map((f) => ({
    key: f.key, label: f.label, secret: f.secret === true, maxLength: f.maxLength,
    has: String(prefs?.[f.key] ?? '').trim() !== '',
  }));
  // ★ 第十五轮：设置页那几行开关**摆不摆、摆哪几行**由当前那一路服务自己说（`kinds()`）—— 没声明 `kinds()` 就按"一路都不 serve"处理
  //   （那几行整段不摆）：不许宿主替服务猜能力，也不许客户端自己补一行。
  //   ★ 第十七轮（用户改判第十五轮③）：翻译四档的 `kinds()` 现在两路都报 ⇒ 两行开关**回到屏上**；
  //   这一处的过滤逻辑一字未动（它守的是"清单只有一份真相"），动的是服务那份声明本身。
  //   行名与说明句里"这一段是什么"改由 `switchRowLabel(key, engine)` 说 —— 只有宿主模型那一档叫摘要。
  const served = Array.isArray(live?.kinds?.()) ? live.kinds() : [];
  const switchRows = LLM_SWITCHES.filter((s) => served.includes(s.kind)).map((s) => ({
    key: s.key, kind: s.kind, row: s.row, label: switchRowLabel(s.key, engine), on: prefs[s.key] === true,
  }));
  return {
    ready,
    note: TRANSLATE_COMMON_NOTE,
    notReadyHint: engine === 'host_llm' ? LLM_NOT_READY_HINT : (TRANS_ERROR_LABELS[why] || ''),
    switchRows,
    engine,
    engines: [...TRANSLATE_ENGINES],
    engineLabels: { ...TRANSLATE_ENGINE_LABELS },
    engineHint: TRANSLATE_ENGINE_HINTS[engine] || '',
    credFields,
    credStored: credFields.some((f) => f.has),
    secretSavedHint: SECRET_SAVED_HINT,
    credNote: TRANSLATE_CRED_NOTE,
    register: TRANSLATE_REGISTER[engine] ?? null,
  };
}

/**
 * GitHub 访问这一路（第二十一轮，用户裁定「填 GitHub 令牌把配额抬到 5000/h」）。
 * ★ 与 `translatorView` 同一条律：键名、长度、是否密钥、说明句、去哪创建令牌**全部**从 domain 那张表派生，界面一个字不写。
 * ★ 令牌**永不回显**：这里只给一位 `has` 布尔（同 `credFields[].has` 的形状），
 *   `'value' in f === false` 由 `hc-19` 钉；屏上那句「库里已存（留空不改动）」靠的就是这一位。
 *   ⚠️ 这一路**没有"当前能不能发"那位**：令牌是可选加速件，空着照样按匿名发 —— 摆一个 false 会把"没填"说成"坏了"。
 */
export function githubView(prefs) {
  const fields = GH_CRED_FIELDS.map((f) => ({
    key: f.key, label: f.label, secret: f.secret === true, maxLength: f.maxLength,
    has: String(prefs?.[f.key] ?? '').trim() !== '',
  }));
  return {
    credFields: fields,
    credStored: fields.some((f) => f.has),
    secretSavedHint: SECRET_SAVED_HINT,
    note: GH_TOKEN_NOTE,
    register: GH_TOKEN_REGISTER,
  };
}

/**
 * 当前档到底是哪一档。★ 旧值先搬家（`official` → `baidu`）再判脏 ——
 * 顺序反了的话，库里第九轮存的那份偏好会在读的那一刻被抹回出厂档，界面显示"免费接口"而凭据还躺在库里没人念。
 */
export function translateEngineOf(prefs) {
  const e = prefs?.translateEngine;
  const v = LEGACY_TRANSLATE_ENGINES[e] ?? e;
  return TRANSLATE_ENGINES.includes(v) ? v : DEFAULT_TRANSLATE_ENGINE;
}

/**
 * 这一发派给谁。★ 只有这一处读 `prefs.translateEngine`：客户端不选路，两个服务也不互相知道对方在。
 * `host_llm` ⇒ llm.js（宿主句柄的唯一使用者）；其余四档 ⇒ web-translate.js（免费 / 百度 / 腾讯 / 阿里）。
 */
export function pickTranslator(deps, prefs) {
  return translateEngineOf(prefs) === 'host_llm' ? (deps.translator ?? null) : (deps.webTranslator ?? null);
}

/**
 * 详情载荷的中文两路。★ **B 优先**：内置表命中的那句绝不重发 —— 一次点击最多两发（描述 + 摘要），
 * 且两发都只在"开关开着 + 有原文可译"时才发。摘要只在默认 README 是英文那一档才要（本来就是中文的仓库不许多一段转述）。
 * `force=refresh`：用户按「重新取一次」就是要新答案，译文缓存一起绕开。
 * ★ 第九轮：派给谁由 `pickTranslator` 按 `prefs.translateEngine` 选，这里只认"当前那一个"服务；
 *   没选中的那一路**连 enabled 都不问**，两路服务互相不知道对方在（免得哪天变成两发都发）。
 * ★ 派活之前有**三道源侧闸门**（第十一轮立两道，第十九轮补第三道；都在派活之前，不靠错误处理兜）：
 *   ① `descSelfZh`（仓库自己写的描述本身就是中文，判据见 domain 的 DESC_SELF_ZH_MIN_CJK）⇒ 描述这一发不派 ——
 *      派出去的是一句中文、回来的还是同一句中文，界面上却挂「中文描述（免费接口 · 某时刻）」，那是句假话；
 *   ② `readmeSource !== 'en_default'` ⇒ 摘要这一发不派，**只有默认篇是英文的仓库才译**：要译的原文已经是中文的三种形状都挡在这里 ——
 *      `zh_default`（默认 README 整篇就是中文）、`zh_file`（默认篇是英文但已抓到仓库另写的那份中文篇，第十五轮第二路；`readmeExcerpt` 已是那份中文的节选）、
 *      `zh_section`（整篇里嵌一段达标中文小节，那一段本来就在屏上）。`none`（没 README）由 `readmeExcerpt` 那一格挡。
 *      两格各在自家：① 读 `view.sectionFields.descSelfZh`（那一格只给宿主自己，`applyZh` 拼完段就删），
 *      ② 读载荷里也带着的 `view.readmeSource`。两句都由宿主判，客户端不重算。
 *      ★ 闸门排在派活之前 ⇒ 闸门改了判据，库里残留的旧 `readme:*` 译文行也不会被读出来（`translate()` 压根没被叫到）。
 *   ③ **第十九轮（用户裁定「中英混排那两种也算有中文」）**：`readmeZhOnScreen(readmeExcerpt).hit` ⇒ 摘要这一发也不派。
 *      这一条管的正是 ② 那五档接不住的两种形状：默认篇**够不上**档名那条 20 字、却仍然带着中文的仓库
 *      （`via='cjk'`：节选里 CJK ≥ `README_ZH_GATE_MIN_CJK=8`，真机 claude-mem 9 字；
 *        `via='lang'`：节选里出现「中文」字样的语言切换行，中文篇在子目录、路径没认出来或那一发 404 —— 手上只剩这一行可凭）。
 *      ★ 为什么不动 ② 那条 20：20 定的是**档名**（「默认 README 本身就是中文」这句敢不敢说），降到 8 会把只有一行切换标签的英文篇改名成中文 ⇒ 档名说谎；
 *        两条律问的不是同一件事。命中时段名跟着补半句实话（`README_ZH_GATE_SUFFIXES`），客户端不重算。
 *      ★ 「日本語」不算中文（3 字够不着 8、也不含「中文」）⇒ 纯日文篇照旧派摘要，别把用户在用的那一屏挡掉。
 * ★ 第十五轮第三道闸门曾在这里（`enabled('readme')` 对翻译四档恒 false：那四档只有翻译能力，
 *   摘要那一路的提示词是「整理成一段简体中文摘要」⇒ 不派）。**第十七轮用户改判放回**：那一发本来就出得来中文，
 *   撤掉等于删了人家在用的那一屏 ⇒ 闸门撤走，只留措辞：那四档给的是节选的**节译**，段名与开关说明句都跟着档位说实话
 *   （`domain.summarySectionLabel` / `switchRowLabel`）。
 */
async function attachZh(deps, view, { refresh = false } = {}) {
  const prefs = await deps.prefsStore?.read?.().catch(() => ({})) ?? {};
  const tr = pickTranslator(deps, prefs);
  if (!tr || view?.ok !== true) return applyZh(view ?? {}, {});
  // ★ 开关关着就**压根不派这一路**：不派就不进 jobs，载荷里的 `zh.descModel` 与两句话全是空 ⇒
  //   没开过设置的用户看到的那一屏，和 C 之前的详情载荷逐字相同（「开关全关 ⇒ 句柄零调用」这条判据的现场）。
  const want = (kind) => tr.enabled?.(kind) === true;
  const jobs = [];
  if (want('desc') && view.sectionFields?.descSelfZh !== true && !descZhFor(view.repo, view.desc) && view.desc) {
    jobs.push(['descModel', tr.translate({ repo: view.repo, kind: 'desc', text: view.desc, force: refresh })]);
  }
  if (want('readme') && view.readmeSource === 'en_default' && view.readmeExcerpt
      && !readmeZhOnScreen(view.readmeExcerpt).hit) {
    jobs.push(['summary', tr.translate({ repo: view.repo, kind: 'readme', text: view.readmeExcerpt, force: refresh })]);
  }
  const done = await Promise.all(jobs.map(([, p]) => p));
  return applyZh(view, Object.fromEntries(jobs.map(([k], i) => [k, done[i]])));
}

/**
 * 读观测史整表（明星那一屏的「在榜轮数 / 峰值名次 / 窗口内候选」全吃这一份）。
 * ★ 与 `readTransRows` 同一条降级律：读不到给**空 Map** + 一句日志，载荷形状不因一次 KV 抖动而变（`storage.available` 那一位说真话）。
 * ★ 为什么读整表而不是按候选取：那一屏的窗口判据在 `lib/stars.js` 现算（§8.8 那条「存储侧不遍历全表做衰减」的另一半），
 *   按仓库逐个 get 会把这一帧的成本挂在屏上行数上。
 */
async function readSeenRows(deps) {
  if (typeof deps.seenStore?.readAll !== 'function') return new Map();
  try {
    return (await deps.seenStore.readAll()) ?? new Map();
  } catch (e) {
    deps.logger?.warn?.(`[gh-trending] 读观测史失败，明星那一屏这一帧按「没有榜史」装配：${e?.message ?? e}`);
    return new Map();
  }
}

/**
 * 读「全站高星」那一批（单行 `batch`，没落库就是 `null` —— 「从没取回过」与「取回过但是空批」必须是两件事，见 `starsView` 的 `hasData`）。
 * ★ 读失败同样给 `null` 并留一句：那一档的 `error` 只能来自**落库那一行**（上一轮的真实回执），装配层不许现编一句故障。
 */
async function readSearchRow(deps) {
  if (typeof deps.searchStore?.read !== 'function') return null;
  try {
    return (await deps.searchStore.read()) ?? null;
  } catch (e) {
    deps.logger?.warn?.(`[gh-trending] 读全站高星那一批失败，那一档这一帧按「本机还没取回过」装配：${e?.message ?? e}`);
    return null;
  }
}

/**
 * 读整张译文表（榜面那一列的 hits 装配要吃全表，逐行 get 会把成本挂在榜面行数上）。
 * ★ 读不到就回空数组并留一句日志：`descZh` 的形状不许因为一次 KV 抖动而变，而「榜面只显内置预译」在那些机器上是真话。
 */
async function readTransRows(deps) {
  if (typeof deps.transStore?.entries !== 'function') return [];
  try {
    return await deps.transStore.entries();
  } catch (e) {
    deps.logger?.warn?.(`[gh-trending] 读译文表失败，榜面这一列只按内置预译给：${e?.message ?? e}`);
    return [];
  }
}

export async function snapshotOf(deps) {
  const { stateStore, eventStore, prefsStore, caps, now } = deps;
  const t = now();
  const prefs = await prefsStore.read();

  let states = {};
  let stateRead = true;
  try {
    states = (await stateStore.readAll()) ?? {};
  } catch {
    stateRead = false;
  }

  let events = [];
  try { events = await eventStore.list(EVENTS_IN_SNAPSHOT); } catch { /* 无存储：空列表，available 位说真话 */ }

  const boards = {};
  for (const board of BOARDS) {
    const s = states[board] ?? null;
    const rows = Array.isArray(s?.rows) ? s.rows : [];
    boards[board] = {
      label: BOARD_LABELS[board],
      hasData: Boolean(s),
      ok: s ? s.ok === true : false,
      error: s?.error ?? (stateRead ? '还没跑过第一轮检查' : '存储不可用'),
      // 榜面数据的真实时间：304 轮只推 lastFetchAt，所以「数据有多新」必须看 at / bodyChangedAt
      at: s?.at ?? 0,
      bodyChangedAt: s?.bodyChangedAt ?? 0,
      lastFetchAt: s?.lastFetchAt ?? 0,
      failStreak: s?.failStreak ?? 0,
      transport: s?.transport === true,
      rowsTotal: rows.length,
      rows: rows.slice(0, prefs.topN),
      empty: rows.length === 0,
    };
  }

  const cross = crossBoards(states);
  /**
   * 「全站高星」那一批在**这里读一次**，两处用：现译的参与行集合（下面那个 `descZhRows`）和 `starsView` 的那一档。
   * ★ 一处读、两处用是律：读两遍会让同一帧里"补译看到的行"与"屏上看到的行"来自两次不同的读，
   *   中间恰好落库一次就是两个答案（下一帧又多一批发或不发，全看运气）。
   */
  const search = await readSearchRow(deps);
  // 描述列的中文：**屏上那些行**里两种来源并排 —— 内置预译优先，其次库里逐字命中的现译行（判据见 lib/board-zh.js）。
  // ★ 10-10 改判（用户裁定 A）：参与行集合走 `descZhRows` —— 那一档**开着**时它那一批也是"屏上那些行"
  //   （明星那一屏整批展示，不做 `topN` 切片）；关着 ⇒ 一行都不进，出厂那档不给没用它的人烧翻译额度。
  // ★ 这一趟是**纯读**：补译批次挂在检查轮次之后（`createApiHandler` 的 update 订阅），读路径一发都不派 ⇒ 面板不会因为翻译而变慢。
  // ★ 空 hits 也照样给：键的存在与否不许随数据变，否则客户端要猜「是没译还是没送到」。
  const zhView = descZhView(descZhRows({
    boards,
    allStarsRows: search?.rows ?? [],
    allStarsEnabled: prefs.allStarsEnabled === true,
  }), await readTransRows(deps), { nowMs: t });
  const heads = {};
  for (const b of BOARDS) heads[b] = boardDescZhHead(boards[b].rows, zhView.hits);
  // 那句"发不出去"只在**开关开着、库也存得下、只是这一路此刻给不出译文**时写：
  //   开关关着 ⇒ 榜面不唠叨（那一行开关自己就摆设置页）；无存储 ⇒ 「下一轮会自动再试」是假话，那里另有存储横幅。
  // ★ 10-10：判据吃 `boardMissing`（只数榜面那组）而不是 `missing` —— 这句话的措辞和落点都在榜面那张卡上，
  //   三榜一行都不欠、只有那一档欠着时念它就是假话。
  const liveTr = pickTranslator(deps, prefs);
  const liveNote = zhView.boardMissing > 0 && deps.transStore?.available === true
    && liveTr?.enabled?.('desc') === true && liveTr?.ready?.() !== true
    ? DESC_ZH_BLOCKED_NOTE : '';
  const descZh = { hits: zhView.hits, heads, liveNote };
  /**
   * 「明星仓库」那一屏（第二十三轮 §8.8）。★ 排在 `boards` 之后装配，因为它吃**切片后**的那三榜
   *   （`prefs.topN` 之内的行才是"屏上那些行"；拿整表去算会让界面上看得见 15 行、载荷里数着 25 行）。
   * ★ 与榜面那一条同律：**读路径零发** —— 这一趟只读两张本地表（`seen` / `search`），那一发 search 挂在轮次订阅上。
   *   （`search` 那一批在上面现译那处已经读过，这里复用**同一个值** ⇒ 一帧里那两屏看到的是同一批行。）
   * ★ `roundAt` 取「最近一轮成功取回的时刻」（三榜里最新的那个 `at`），不是本地时钟：
   *   窗口那句说的是"相对最近一轮的 7 天"，用 `now()` 会让一屏榜史在插件停摆两周后自己清空 —— 数据没变，读数却变了。
   *   三榜都还没成功过才退回 `t`（那一刻本来就没有候选，`seen` 里最多是上一批遗留，交给窗口判据）。
   */
  const roundAt = BOARDS.reduce((m, b) => Math.max(m, Number(states[b]?.at) || 0), 0) || t;
  const stars = starsView({
    seenRows: await readSeenRows(deps),
    boards,
    roundAt,
    prefs,
    search,
    // ★ 那位「存储不可用」的判据吃的是**观测史那张表**：明星这一屏的轮数与名次全从它来，它读不到就没有榜史可念（能力边界 ①）。
    storageAvailable: deps.seenStore?.available === true,
  });
  // 传输路径要判「这条路通没通」，吃的是刚装配好的三榜状态位，所以只能排在榜面之后
  const net = netView(deps, boards);
  return {
    at: t,
    caps: caps.read(),
    capabilityRows: caps.rows(),
    // ★ 出网那一趟摘掉密钥（同 GET/POST /api/prefs 那两处，走的是同一个 `publicPrefs`）
    prefs: publicPrefs(prefs),
    storage: { available: Boolean(stateStore.available) && stateRead },
    sourceNote: TRENDING_SOURCE_NOTE,
    langCheck: LANG_CHECK,
    // 内置离线预译的描述（来源 + 时间戳由 note 说，客户端不自己编日期）
    descZh,
    // 模型现译这一路：开关状态 + 宿主给没给句柄。★ 键恒在（关着也要给 false），客户端不猜。
    translator: translatorView(deps, prefs),
    // GitHub 访问这一路（第二十一轮）：令牌有没有填 + 那一行怎么摆。★ 键恒在，没填也给 `has:false`。
    github: githubView(prefs),
    transportHint: net.hint,
    // 最近一发的传输路径（直连 / 代理隧道 / 没出网）；没出过网给 null，界面就不说这句话
    net: net.view,
    // 节拍与下一次自动检查：检查服务没装配（无存储 / 裸宿主）时如实给 null，界面就不说这句话
    cadence: deps.check?.cadence ?? null,
    boards,
    // 「明星仓库」那一屏（本地榜史 + 可选的全站高星那一批）：键恒在，没数据也给空 rows 与那三句人话。
    stars,
    cross: {
      rising: cross.rising.slice(0, prefs.topN),
      cooling: cross.cooling.slice(0, prefs.topN),
      note: '跨榜同现由这一次检查的三张榜交叉算出，不额外发请求。',
    },
    events,
  };
}

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */
export const ROUTES = {
  'GET /api/snapshot': {
    handler: (deps) => async (req, res) => jsonOk(res, await snapshotOf(deps)),
  },
  'GET /api/stream': {
    handler: (deps) => async (req, res) => {
      const hub = deps.hub;
      let client;
      const sse = openSse(res, { onBroken: () => hub.remove(client), ...(deps.sseTimers ?? {}) });
      client = { send: sse.send, close: sse.close };
      hub.add(client);
      res.on?.('close', () => hub.remove(client));
      sse.send('snapshot', await snapshotOf(deps));
      return true; // 不 end：保持长连接
    },
  },
  'POST /api/check': {
    handler: (deps) => async (req, res) => jsonOk(res, await deps.check.run({ trigger: 'manual' })),
  },
  'GET /api/events': {
    handler: (deps) => async (req, res, body, url) => {
      const rawLimit = url?.searchParams?.get('limit');
      const n = Number(rawLimit);
      const limit = Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(1, Math.trunc(n))) : 100;
      const board = String(url?.searchParams?.get('board') ?? '');
      return jsonOk(res, { events: await deps.eventStore.list(limit, board) });
    },
  },
  'GET /api/prefs': {
    handler: (deps) => async (req, res) => jsonOk(res, publicPrefs(await deps.prefsStore.read())),
  },
  /**
   * 仓库详情。★ 这是第一条**要闸回环的 GET**：它 GET 的是上游、花的是匿名限额（60 次/小时/机器），
   * 放给别机就等于让别人替你烧配额、还借本机的代理出网。「GET 一律不闸」在这里得让位。
   */
  'GET /api/repo': {
    loopback: true,
    handler: (deps) => async (req, res, body, url) => {
      const name = String(url?.searchParams?.get('name') ?? '').trim();
      if (!name) return json(res, 400, errBody('INVALID_PARAM', '缺少 ?name=owner/repo'));
      const refresh = ['1', 'true'].includes(String(url?.searchParams?.get('refresh') ?? '').toLowerCase());
      const svc = deps.repoService;
      if (!svc) return json(res, 501, errBody('GHT_RECORDS_UNAVAILABLE', '详情服务未装配，这一版给不出仓库详情'));
      return jsonOk(res, await attachZh(deps, await svc.load(name, { refresh }), { refresh }));
    },
  },
  'POST /api/prefs': {
    handler: (deps) => async (req, res, body) => {
      const patch = {};
      const src = body && typeof body === 'object' ? body : {};
      for (const k of ['intervalMin', 'topN', 'keepEvents']) {
        if (src[k] !== undefined) patch[k] = src[k];
      }
      for (const k of ['proxyMode', 'proxyUrl']) {
        if (src[k] !== undefined) patch[k] = src[k];
      }
      // ★ 第二十七轮：这里原来有一段 `repoCacheHours` 的封闭档位 400 校验（第十二轮），随那一档一起撤掉 ——
      //   详情改条件请求以后没有一个"时长"可选了，这一格的白名单不收它 ⇒ 老客户端手滑发过来也只会被丢掉，
      //   不会像 `translateEngine` 那样需要 400（那一路脏值会决定往哪个域名出网，这一格什么都不决定）。
      // 现译引擎（第九轮）：封闭集合，脏档直接 400 —— 这一格决定往哪个域名出网，
      // 落库一个认不出的值等于让 clampPrefs 悄悄把用户的选择换成出厂档，界面上还显示他选的那个。
      if (src.translateEngine !== undefined) {
        if (!TRANSLATE_ENGINES.includes(src.translateEngine)) {
          return json(res, 400, errBody('INVALID_PARAM', `现译引擎必须是 ${TRANSLATE_ENGINES.join(' | ')} 之一，收到 ${JSON.stringify(src.translateEngine)}`));
        }
        patch.translateEngine = src.translateEngine;
      }
      // 各家凭据那几格（清单从 domain 的字段表**派生**：三家六格 + 第二十一轮的 GitHub 令牌）：只钳长度。
      // 空串对 `secret:true` 的那几格是**有意**的「清除」，不当"没改动"处理
      //（界面上留空 = 不改动，那是客户端的草稿语义；真发 PATCH 时带的就是库里要成的值）。
      for (const f of PREF_CRED_FIELDS) {
        if (src[f.key] === undefined) continue;
        if (typeof src[f.key] !== 'string') {
          return json(res, 400, errBody('INVALID_PARAM', `${f.key} 只认字符串，收到 ${JSON.stringify(src[f.key])}`));
        }
        const raw = src[f.key].trim();
        if (raw.length > f.maxLength) {
          return json(res, 400, errBody('INVALID_PARAM', `${f.key} 过长（${raw.length} 字，上限 ${f.maxLength} 字）`));
        }
        patch[f.key] = raw;
      }
      // 现译两个开关 + 全站高星那一档（第二十三轮）：只认严格布尔。'1' / 'on' 这类"看着像开"的值必须 400，
      // 不能让一次表单序列化的差别变成"用户的额度被一个没打算开的开关烧掉"。
      for (const k of ['llmDesc', 'llmReadme', 'allStarsEnabled']) {
        if (src[k] === undefined) continue;
        if (typeof src[k] !== 'boolean') {
          return json(res, 400, errBody('INVALID_PARAM', `${k} 只认 true / false，收到 ${JSON.stringify(src[k])}`));
        }
        patch[k] = src[k];
      }
      if (patch.proxyMode !== undefined && !PROXY_MODES.includes(patch.proxyMode)) {
        return json(res, 400, errBody('INVALID_PARAM', `代理模式必须是 ${PROXY_MODES.join(' | ')} 之一，收到 ${JSON.stringify(patch.proxyMode)}`));
      }
      if (typeof patch.proxyUrl === 'string') {
        const raw = patch.proxyUrl.trim();
        if (raw.length > PROXY_URL_MAX) {
          return json(res, 400, errBody('INVALID_PARAM', `代理地址过长（${raw.length} 字，上限 ${PROXY_URL_MAX} 字）`));
        }
        // 空串是「清掉自定义地址」，非空必须先能解析 —— 存进去一个解析不了的地址，下一轮三发会全部报同一句话
        if (raw) {
          const parsed = parseProxyUrl(raw);
          if (!parsed.ok) return json(res, 400, errBody('INVALID_PARAM', `代理地址不可用：${parsed.reason}`));
        }
        patch.proxyUrl = raw;
      }
      if (src.language !== undefined) {
        const norm = normalizeLanguage(src.language);
        if (!norm.ok) {
          return json(res, 400, errBody('INVALID_PARAM', norm.reason));
        }
        // 就地验证：形状对不代表站点认。拿一张周榜页判 <title>（一次 GET，不写库、不缓存）。
        if (norm.slug) {
          const verdict = await deps.check.checkLanguage(norm.slug);
          if (verdict.status === 'unknown') {
            return json(res, 400, errBody('INVALID_PARAM', `GitHub 不认识语言「${norm.slug}」：${LANG_CHECK.unknown}`));
          }
          if (verdict.status === 'fetch-failed') {
            return json(res, 400, errBody('INVALID_PARAM', `没能打开趋势页验证语言「${norm.slug}」，暂不保存：${verdict.reason ?? ''}`));
          }
        }
        patch.language = norm.slug;
      }
      // 模式与地址是成对的：只把模式切成 custom 而库里没有地址，下一轮三发只会一起报「没给出代理地址」，
      // 那句报错在界面上看着像插件坏了。当场拒掉，理由写在 400 里。
      if (patch.proxyMode !== undefined || patch.proxyUrl !== undefined) {
        const cur = await deps.prefsStore.read();
        const mode = patch.proxyMode ?? cur.proxyMode;
        const url = patch.proxyUrl !== undefined ? patch.proxyUrl : cur.proxyUrl;
        if (mode === 'custom' && !url) {
          return json(res, 400, errBody('INVALID_PARAM', '选「自定义地址」就得填一个地址，形如 127.0.0.1:7897'));
        }
      }
      // ★ 转换判据必须在写入**之前**取（写完再读到的就是新值，那一次保存永远"看不出来"是开启）：
      //   只有库里本来不是 `true` 的，这一趟才算「关 → 开」。
      const wasAllStarsOn = patch.allStarsEnabled === true
        ? (await deps.prefsStore.read()).allStarsEnabled === true
        : null;
      const saved = await deps.prefsStore.patch(patch);
      await deps.onPrefsChanged?.();
      // ★ 10-09 改判（用户裁定「开启的时候默认拉取一次」）：库里 `false` → 这一趟递来 `true` ⇒ 当场把这一发交给 runner 决定，不让人等到下一轮检查。
      //   四条口径钉在这里，各有一条判据：
      //   · **认出的是转换**：已经开着再存一次 `true`（连点、改别的键时顺带带上、旧面板重放）⇒ 走不到 runner ——
      //     "白烧额度"那条律收窄成了"没有变化的保存不该发"，而不是"保存一律不发"；
      //   · 关掉那一趟照样一发不派（也不删库里已攒的那一批）；
      //   · 这一发**在回执之前 await 完**（与 `POST /api/check` 同一条"写操作可以等出网"的读法，单发预算 15s 有顶）：
      //     界面此刻那颗按钮是 disabled 的，回执回来时那一批已经在载荷里 ⇒ 不留"点完了但结果在别处"的悬空态；
      //   · ★ 同日第二条裁定「上次间隔时间范围内已经拉取过就不要拉取」：**发不发由 runner 那道 `fresh` 闸判**（窗口 = 生效的
      //     `prefs.intervalMin`，判据 = `search` 行的 `ok === true` 与 `at`），门面这里**不数分钟、不读库存行** ——
      //     在门面再判一次同一个窗口就是第二真相（§0），而界面那一句「上次取回 …」念的也正是库里那一格。
      if (patch.allStarsEnabled === true && wasAllStarsOn !== true) {
        const shot = await deps.allStars.runOnEnable();
        if (shot?.sent > 0) {
          // 发过就追帧（与检查轮那一路同一条读法）：坏轮的 `ok/error/lastFetchAt` 三格本来就是要让界面看见的变化。
          // ★ 被 `fresh` 挡下时 `sent===0` ⇒ 不追帧：库里一个字没变，而"这一档开着"那一位已经跟着**同一次回执**上屏了。
          const snap = await snapshotOf(deps);
          deps.hub?.broadcast('update', snap);
        }
      }
      return jsonOk(res, publicPrefs(saved));
    },
  },
};

/** 某 path 上被登记的方法集合（405 判定用）。 */
function methodsForPath(path) {
  const out = [];
  for (const key of Object.keys(ROUTES)) {
    const [m, p] = key.split(' ');
    if (p === path) out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 回环闸门（POST 全闸；GET 只有 /api/repo 闸，理由见那条路由的注释）
 * ------------------------------------------------------------------ */
function isLoopIp(ip) {
  const s = String(ip ?? '').replace(/^\[|\]$/g, '');
  return /^127\./.test(s) || s === '::1' || s.toLowerCase() === 'localhost';
}
export function isLoopback(req) {
  const ip = req?.socket?.remoteAddress ?? '';
  if (!isLoopIp(ip)) return false;
  const xff = req?.headers?.['x-forwarded-for'];
  if (xff) {
    for (const hop of String(xff).split(',')) {
      if (!isLoopIp(hop.trim())) return false;
    }
  }
  return true;
}

function toUrl(raw) {
  if (raw instanceof URL) return raw;
  if (raw && typeof raw === 'object' && typeof raw.pathname === 'string') return raw;
  return new URL(String(raw ?? '/'), 'http://127.0.0.1');
}
function stripPrefix(pathname) {
  if (pathname.startsWith(ROUTE_PREFIX)) {
    const rest = pathname.slice(ROUTE_PREFIX.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/**
 * 造路由 handler。deps 需带 check/stateStore/eventStore/prefsStore/caps/logger/now，
 * 可选 subscribeEvent(fn)->unsub（check 服务的帧汇进 hub 广播）；
 * ★ 第二十三轮多三格：`seenStore`（明星那一屏读榜史）、`searchStore`（读/写那一批全站高星）、
 *   `searchFetcher`（装配层用 `createSearchFetcher()` 绑好的**无参**那一发 —— 令牌在它里面，本文件不认识那个键名）。
 */
export function createApiHandler(deps) {
  const hub = createHub();
  const d = { ...deps, hub };
  /**
   * 榜面补译批次（第二十二轮，用户裁定「按 C 来：榜面也接现译」）。
   * ★ 它只挂在这一处 —— 一轮检查之后。`GET /api/snapshot` 与 SSE 首帧都只读不算活，
   *   所以"打开面板"这个动作一发都不派，配额严格按检查节拍花（出厂 60 分钟一轮，手动「重新取一次」也算一轮）。
   * ★ 派给哪一路与详情那一发同一个人（`pickTranslator` 按 `prefs.translateEngine`），本文件不另选路。
   */
  const boardZh = createBoardZhRunner({
    transStore: deps.transStore,
    getTranslator: () => pickTranslator(d, deps.getPrefs?.() ?? {}),
    logger: deps.logger,
    now: deps.now ?? (() => Date.now()),
  });
  /**
   * 「全站高星」那一发（第二十三轮 §8.8 步骤 5）。★ 与 `boardZh` **并列、各管各的闸门、不共享在途状态**：
   *   补译那一路的闸是「引擎开没开 / 库在不在 / 账本读不读得出」，这一路的闸是「用户开没开 / 库在不在 / 这一轮发过没」，
   *   两处顺序还**故意相反**（`off` 在前 vs `no_store` 在前，理由见 `lib/services/all-stars.js` 头部），合成一个 runner 就必然要选一个顺序。
   * ★ `fetchBatch` 是装配层用 `createSearchFetcher()` 绑好的**无参**函数 —— 令牌在那一路里，本文件从头到尾不认识它的键名（hc-21）。
   *   没接（`deps.searchFetcher` 缺位）也不要紧：出厂 `allStarsEnabled=false` ⇒ 第一道闸 `off` 就返回，走不到那一发。
   * ★ 轮次身份吃的是**检查事件的 `at`**（`check.js` emit 那一份 t0），不是快照的装配时刻：
   *   偏好变更那类 `update` 不带 `at` ⇒ runner 报 `no_round` 一发不派 —— 那正是口径要的（改一次节拍不该烧一发 search 的配额）。
   *   ★ 10-09 就地改判补一句：**这一条管的是"顺带保存"那一路**；「关 → 开」那一趟由 `POST /api/prefs` 直接调
   *     `runOnEnable()`（见下面那条路由），当场发一发 —— 用户点「开」授权的就是这一发出网，不是"等 60 分钟"。
   *     ★ 同日第二条裁定给那一趟又加一道 `fresh` 闸（窗口 = `prefs.intervalMin`，判据 = 库里最后一次**成功**取回）⇒
   *       "当场"指的是**当场决定发不发**，不是"必发"；挡下时 `sent=0`，门面不追帧（见 all-stars.js 口径 5）。
   */
  const allStars = createAllStarsRunner({
    searchStore: deps.searchStore,
    fetchBatch: deps.searchFetcher,
    getPrefs: () => deps.getPrefs?.() ?? {},
    logger: deps.logger,
    now: deps.now ?? (() => Date.now()),
  });
  /**
   * ★ 10-09 改判：把这一枚 runner 递回路由层，因为「关 → 开」那一趟要在保存偏好的回执里当场发一发。
   *   路由表认的是**这一个实例**（预算与闸门仍只在 `lib/services/all-stars.js` 一处，门面不数发数）。
   */
  d.allStars = allStars;
  const unsubs = [];
  if (typeof deps.subscribeEvent === 'function') {
    const unsub = deps.subscribeEvent((ev) => {
      // 检查完推 'update'：载荷直接给全量快照 —— 帧的形状就是 GET snapshot 的形状，
      // 浏览器半边合并时无需凭空补任何字段（sysops S17 的教训）。
      if (ev?.type !== 'update') return;
      const broadcast = () => Promise.resolve(snapshotOf(d))
        .then((snap) => { hub.broadcast('update', snap); return snap; })
        .catch((e) => {
          deps.logger?.warn?.(`[gh-trending] update 帧装配失败：${e?.message ?? e}`);
          return null;
        });
      // 两段：先把榜面推上去（一发不派，界面立刻有东西看），再**并行**跑两件轮次后的活；**只有真改变了载荷**才推第二帧，
      // 否则一轮检查白刷三次面板。★ 第二帧的条件两路各一条：
      //  · 补译：`ok > 0`（一句都没补成 ⇒ 载荷没变，不追帧）；
      //  · 全站高星：`sent > 0`（发过就追 —— 那一轮的 `ok/error/lastFetchAt` 三格本身就是要让界面看见的变化，坏轮不追帧等于把故障藏一轮）。
      // ★ 补译的参与行集合走 `descZhRows`（10-10 改判）：行从**刚装配好的那一帧**取（榜面切片 + 那一档那一批），
      //   不回头再读一次库 —— 视图与批次吃同一份行，才不会出现"屏上欠着的那几行不是这一轮补的那几行"。
      Promise.resolve()
        .then(broadcast)
        .then((snap) => (snap
          ? Promise.all([
            boardZh.run(descZhRows({
              boards: snap.boards,
              allStarsRows: snap.stars?.allStars?.rows ?? [],
              allStarsEnabled: snap.prefs?.allStarsEnabled === true,
              dedupe: true,
            })),
            allStars.run(ev?.at),
          ])
          : null))
        .then((both) => {
          if (!both) return null;                 // 首帧装配就失败 ⇒ 两件轮次后的活一件都没派，别在这里解构 null
          const [zh, stars] = both;
          return (zh?.ok > 0 || stars?.sent > 0) ? broadcast() : null;
        })
        .catch((e) => deps.logger?.warn?.(`[gh-trending] 这一轮的轮次后任务没走完：${e?.message ?? e}`));
    });
    if (typeof unsub === 'function') unsubs.push(unsub);
  }

  async function handler(req, res, bodyArg) {
    const url = toUrl(req.url);
    const path = stripPrefix(url.pathname);
    const method = req.method ?? 'GET';

    if (method === 'POST' && !isLoopback(req)) {
      return json(res, 403, errBody('FORBIDDEN', '写操作（触发检查 / 保存偏好）仅接受来自本机回环的请求'));
    }

    const key = `${method} ${path}`;
    const entry = ROUTES[key];
    if (!entry) {
      const allowed = methodsForPath(path);
      if (allowed.length) {
        return json(res, 405, errBody('METHOD_NOT_ALLOWED', `请求方法 ${method} 不被允许，${path} 仅支持 ${allowed.join(' | ')}`));
      }
      return json(res, 404, errBody('NOT_FOUND', `未知路由 ${method} ${path}`));
    }
    // 闸 GET 的那一条（详情）在这里补闸：闸在路由表上，不靠"它是 POST"这条粗规则
    if (entry.loopback && !isLoopback(req)) {
      return json(res, 403, errBody('FORBIDDEN', '这个接口会替调用方去 GitHub 花配额，只接受来自本机回环的请求'));
    }

    let body = bodyArg;
    if (body === undefined && method === 'POST') {
      try { body = await readBody(req); } catch (e) {
        return json(res, statusFor(e?.code), errBody(e?.code ?? 'BAD_JSON', e?.message ?? String(e)));
      }
    }
    try {
      return await entry.handler(d)(req, res, body ?? {}, url);
    } catch (e) {
      const code = typeof e?.code === 'string' ? e.code : 'INTERNAL';
      return json(res, statusFor(code), errBody(code, e?.message ?? String(e)));
    }
  }

  handler.dispose = () => {
    hub.dispose();
    for (const u of unsubs) { try { u(); } catch { /* 退订失败无需解释 */ } }
  };
  return handler;
}
