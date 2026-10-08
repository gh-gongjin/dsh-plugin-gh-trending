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
  REPO_CACHE_HOURS,
  LLM_SWITCHES, switchRowLabel, LLM_NOT_READY_HINT,
  TRANSLATE_ENGINES, TRANSLATE_ENGINE_LABELS, TRANSLATE_ENGINE_HINTS, TRANSLATE_REGISTER,
  TRANSLATE_COMMON_NOTE, DEFAULT_TRANSLATE_ENGINE, LEGACY_TRANSLATE_ENGINES,
  TRANS_ERROR_LABELS, SECRET_SAVED_HINT, TRANSLATE_CRED_NOTE, DESC_ZH_BLOCKED_NOTE,
  PREF_CRED_FIELDS, PREF_SECRET_KEYS, GH_CRED_FIELDS, GH_TOKEN_NOTE, GH_TOKEN_REGISTER,
  credFieldsOf,
} from './domain.js';
import { crossBoards } from './check.js';
import { descZhFor } from './desc-zh.js';
import { descZhView, visibleBoardRows, allVisibleRows, boardDescZhHead, createBoardZhRunner } from './board-zh.js';
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
  // 描述列的中文：**屏上那些行**里两种来源并排 —— 内置预译优先，其次库里逐字命中的现译行（判据见 lib/board-zh.js）。
  // ★ 这一趟是**纯读**：补译批次挂在检查轮次之后（`createApiHandler` 的 update 订阅），读路径一发都不派 ⇒ 面板不会因为翻译而变慢。
  // ★ 空 hits 也照样给：键的存在与否不许随数据变，否则客户端要猜「是没译还是没送到」。
  const zhView = descZhView(allVisibleRows(boards), await readTransRows(deps), { nowMs: t });
  const heads = {};
  for (const b of BOARDS) heads[b] = boardDescZhHead(boards[b].rows, zhView.hits);
  // 那句"发不出去"只在**开关开着、库也存得下、只是这一路此刻给不出译文**时写：
  //   开关关着 ⇒ 榜面不唠叨（那一行开关自己就摆设置页）；无存储 ⇒ 「下一轮会自动再试」是假话，那里另有存储横幅。
  const liveTr = pickTranslator(deps, prefs);
  const liveNote = zhView.missing > 0 && deps.transStore?.available === true
    && liveTr?.enabled?.('desc') === true && liveTr?.ready?.() !== true
    ? DESC_ZH_BLOCKED_NOTE : '';
  const descZh = { hits: zhView.hits, heads, liveNote };
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
      // 详情缓存时长（第十二轮，用户裁定「进设置页，默认 24 小时」）：封闭档位，越界直接 400。
      // ★ 不许让它落进 `clampPrefs` 悄悄回 24 —— 那等于库里一个值、分段器上另一个值（同 `translateEngine` 那条理由）。
      if (src.repoCacheHours !== undefined) {
        const h = Number(src.repoCacheHours);
        if (!REPO_CACHE_HOURS.includes(h)) {
          return json(res, 400, errBody('INVALID_PARAM',
            `详情缓存时长（小时）必须是 ${REPO_CACHE_HOURS.join(' | ')} 之一，收到 ${JSON.stringify(src.repoCacheHours)}`));
        }
        patch.repoCacheHours = h;
      }
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
      // 现译两个开关：只认严格布尔。'1' / 'on' 这类"看着像开"的值必须 400，
      // 不能让一次表单序列化的差别变成"用户的额度被一个没打算开的开关烧掉"。
      for (const k of ['llmDesc', 'llmReadme']) {
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
      const saved = await deps.prefsStore.patch(patch);
      await deps.onPrefsChanged?.();
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
 * 可选 subscribeEvent(fn)->unsub（check 服务的帧汇进 hub 广播）。
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
      // 两段：先把榜面推上去（一发不派，界面立刻有东西看），再补译；**只有真补成了行**才推第二帧，
      // 否则一轮检查白刷三次面板。批次失败不追帧 —— 失败那几句已经进日志，而 liveNote 那句实话在首帧里就给到了。
      Promise.resolve()
        .then(broadcast)
        .then((snap) => (snap ? boardZh.run(visibleBoardRows(snap.boards)) : null))
        .then((r) => (r && r.ok > 0 ? broadcast() : null))
        .catch((e) => deps.logger?.warn?.(`[gh-trending] 榜面补译这一轮没走完：${e?.message ?? e}`));
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
