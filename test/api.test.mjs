/**
 * test/api.test.mjs —— HTTP 门面（lib/api.js）：路由表、回环闸门、SSE 帧、快照装配。
 *
 * ★ 关键口径：宿主只给 handler 传 (req,res)，POST 的 body 必须自己从流里拼。
 *   所以这里的 POST 一律用 _helpers.makeReq 的**流式 req**，不喂 bodyArg —— 喂了就把这个坑圆掉
 *   （sysops、appearance 各踩过一次，见项目记忆「宿主 handler 只传两个参数」）。
 */
import { check, runAll, assert, makeFakeFacility, makeReq, makeRes, flush } from './_helpers.mjs';
import {
  createApiHandler, snapshotOf, isLoopback, statusFor, openSse, createHub,
  ROUTE_PREFIX, ROUTES, readBody, translatorView, githubView,
} from '../lib/api.js';
import { createStateStore, createEventStore, createSeenStore, createPrefsStore, createTransStore, createSearchStore } from '../lib/stores.js';
import { createCaps } from '../lib/caps.js';
import { BOARDS, DEFAULT_PREFS, TRENDING_SOURCE_NOTE, LANG_CHECK, TRANSPORT_HINT, FETCH_ATTEMPTS,
  TRANSLATE_COMMON_NOTE, LLM_NOT_READY_HINT, LLM_SWITCH_LABELS, LLM_KINDS, LLM_SWITCHES,
  TRANSLATE_ENGINES, TRANSLATE_ENGINE_LABELS, TRANSLATE_ENGINE_HINTS, TRANSLATE_REGISTER, TRANSLATE_CRED_NOTE,
  TRANSLATE_CRED_FIELDS, TRANSLATE_CRED_ALL, SECRET_SAVED_HINT, credFieldsOf,
  // ★ 第二十一轮：凭据清单在 domain 派生成一份（PREF_CRED_FIELDS / PREF_SECRET_KEYS），
  //   用例扫的是派生后那一份 —— 在本文件里再抄一遍键名就是第二真相，新增那把必然漏。
  PREF_CRED_FIELDS, PREF_SECRET_KEYS, GH_CRED_FIELDS, GH_TOKEN_NOTE, GH_TOKEN_REGISTER,
  LLM_README_LABEL_TRANSLATE,
  DEFAULT_TRANSLATE_ENGINE, engineZhLabel, ENGINE_LABEL_ZH, TRANS_ERROR_LABELS,
  // 第二十二轮：榜面那一列的两种来源各有一句落款/一句实话，判据从 domain 取（在测试里手抄就成了第二真相）。
  DESC_ZH_LIVE_NOTE, DESC_ZH_BLOCKED_NOTE, BOARD_ZH_BATCH_MAX,
  REPO_ERROR_LABELS, REPO_SECTION_LABELS, REPO_README_SOURCE_LABELS,
  README_ZH_GATE_SUFFIXES,
  // 第二十三轮：明星那一屏的句子与预算同样从 domain 取（在测试里手抄「未开启」那一句或那个发数，就是第二份真相）。
  STARS_QUOTA_OFF_NOTE, STARS_NO_STORE_NOTE, starsQuotaLine, SEARCH_MAX_PER_ROUND,
} from '../lib/domain.js';
import { DESC_ZH_ROWS, DESC_ZH_LABEL, DESC_ZH_NOTE, descZhFor } from '../lib/desc-zh.js';
// ★ 第二十三轮：明星那一屏的装配判据吃的是**同一个纯视图**（`lib/stars.js`）。
//   用例在测试里自己排一遍榜史/判一遍档就是第二份真相 —— 那样哪天宿主口径改了，用例照样绿而界面是旧的。
import { starsView } from '../lib/stars.js';
// ★ 命中判据的一半（归一后的原文）必须由库里那一份函数给出：测试里自己 `.replace(/\s+/g,' ')` 就是第二份真相，
//   哪天归一口径改了，用例照样绿而榜面不再复用。
import { transSrcKey } from '../lib/services/llm.js';
// ★ 详情的载荷一律由**真的 repoView()** 造（10-06 的教训：手搓形状少了宿主内部那格，用例照样绿）。
import { repoView } from '../lib/services/repo.js';
// ★ 第十五轮：假那一路的桩要跟真服务对表（能力声明不一致时，派活判据测的是桩不是闸门）。
import { createWebTranslator } from '../lib/services/web-translate.js';

const crow = (repo, rank, over = {}) => ({ rank, repo, name: repo, stars: 1000, added: 50, ...over });
const stateRow = (board, rows, over = {}) => ({
  board, at: 5000, ok: true, etag: 'W/"x"', bodyChangedAt: 5000, lastFetchAt: 5000,
  failStreak: 0, rows, prevRows: [], ...over,
});

/**
 * 「全站高星」那一发的桩：形状**逐格对齐 `searchRepositories()` 的成功回包**（`{ok, at, rate:{left,limit,resetAt,authed}, rows}`），
 * 行形状对齐 domain 的 `SEARCH_ROW_SHAPE`，取值抄 `test/fixtures/repo-search.json` 第 4 条（与 `test/store.test.mjs` 同一份出处）。
 * ★ 桩的 `at` 取 `7777` —— 与 `mkApi` 那个 `now()` 同一个数，坏轮冻结那类判据才分得开"发起时刻"和"成功时刻"。
 */
const SEARCH_ROW = Object.freeze({
  rank: 4, repo: 'freecodecamp/freecodecamp', name: 'freeCodeCamp/freeCodeCamp',
  desc: "freeCodeCamp.org's open-source codebase and curriculum. Learn math, programming, and computer science for free.",
  lang: 'TypeScript', stars: 456734,
});
const searchOk = (over = {}) => ({
  ok: true, at: 7777, rate: { left: 9, limit: 10, resetAt: 1791518294000, authed: false }, rows: [SEARCH_ROW], ...over,
});
/** 失败桩：`errText` 是**原样回执**（不进 `REPO_ERROR_LABELS`，两套池子那条），额度四格刻意与成功桩全不一样。 */
const searchBad = (over = {}) => ({
  ok: false, errKey: 'rate_limited', errText: '限额用尽（403，重置于 2026/10/9 04:38:14）', transport: false, ...over,
});

async function mkApi({ prefs = {}, states = {}, events = [], checkImpl, route = null, repoService = null, translator = null, webTranslator = null, searchFetcher = null, seenStore = null, now = () => 7777 } = {}) {
  const facility = makeFakeFacility();
  // ★ 第二十二轮把 `warn` 从裸数组改成"可调用的假 logger"：榜面补译的失败与降级全走 `logger.warn`，
  //   上一版这里是 `{warn: []}` ⇒ 代码里的 `logger?.warn?.()` 直接 TypeError，测试崩在用例断言之前。
  const warns = [];
  const logger = { warns, warn: (m) => { warns.push(String(m)); }, info: [] };
  const opts = { getFacility: () => facility, logger };
  const stores = {
    state: createStateStore(opts),
    events: createEventStore(opts),
    seen: createSeenStore(opts),
    prefs: createPrefsStore(opts),
    trans: createTransStore(opts),
    // ★ 第二十三轮：装配层多接一张表（全站高星那一批，单行 key=`batch`）。这里用**真仓储 + 假设施**，
    //   不用手搓对象 —— 判据吃的是 schema 认过的形状（手搓会让"落库形状变了"这一类改动在装配层测不出来）。
    search: createSearchStore(opts),
  };
  const caps = createCaps({ logger });
  caps.mark('storageDomain', true);
  caps.mark('timer', true);
  caps.mark('webServer', true);

  const prefsView = { ...DEFAULT_PREFS, ...prefs };
  const fakeCheck = checkImpl ?? {
    run: async (o = {}) => ({ at: 9000, trigger: o.trigger, produced: {}, producedCross: { rising: 0, cooling: 0 }, anyOk: true }),
    checkLanguage: async (language) => ({ status: language === 'jolang' ? 'unknown' : language === 'down' ? 'fetch-failed' : 'boarded', slug: language }),
  };

  const fanout = new Set();
  const routeRef = { current: route };
  // ★ 那一发的**计数包装**由工厂自己套（注入的桩也照数）：「读路径零发」这条判据吃的是产品侧信号 ——
  //   装配层有没有在打开面板时替用户花配额，只看得到"这一发真被打过没有"。
  const searchCalls = [];
  const innerSearchFetcher = searchFetcher ?? (async () => searchOk());
  const countedSearchFetcher = async (...args) => { searchCalls.push(args); return innerSearchFetcher(...args); };
  const handler = createApiHandler({
    check: fakeCheck,
    stateStore: stores.state,
    eventStore: stores.events,
    prefsStore: stores.prefs,
    // 第二十二轮：榜面那一列的中文视图要吃译文表，补译批次也要读写它。
    transStore: stores.trans,
    // 第二十三轮：明星那一屏的两张本地表（读），加上装配层绑好的那一发（只在轮次后写）。
    seenStore: seenStore ?? stores.seen,
    searchStore: stores.search,
    searchFetcher: countedSearchFetcher,
    getPrefs: () => prefsView,
    repoService,
    translator,
    webTranslator,
    caps,
    logger,
    now,
    getTransportRoute: () => routeRef.current,
    // ★ 与装配层 `index.js` 的 `onPrefsChanged` 同一条读法：回调里先 `reloadPrefs()`（把内存视图刷成库里的值）再推帧。
    //   上一版这里只计数 ⇒ 视图永远停在初始值：runner 的 `off` 闸吃的是 `getPrefs()`，视图没刷就永远过不了闸，
    //   「开启即拉」那条判据会假绿（把 kick 挪到 onPrefsChanged 之前这种接错，在这儿一样测不出来）。
    onPrefsChanged: async () => { prefsChanged.n += 1; Object.assign(prefsView, await stores.prefs.read()); },
    subscribeEvent: (fn) => { fanout.add(fn); return () => fanout.delete(fn); },
    sseTimers: { setIntervalMod: () => ({ unref() {} }), clearIntervalMod: () => {} },
  });
  const prefsChanged = { n: 0 };
  handler.__prefsChanged = prefsChanged;
  handler.__warns = warns;
  handler.__fanout = fanout;
  handler.__stores = stores;
  handler.__searchCalls = searchCalls;
  handler.__routeRef = routeRef;
  handler.__getRoute = () => routeRef.current;
  handler.__facility = facility;
  handler.__caps = caps;
  handler.__prefsView = prefsView;
  handler.__setPrefs = (p) => Object.assign(prefsView, p);

  // 预置库：直接走真仓储（schema 与串行队列都在路径上）
  for (const [board, row] of Object.entries(states)) {
    if (row) await stores.state.write(board, row);
  }
  for (const ev of events) await stores.events.append(ev);
  if (Object.keys(prefs).length) await stores.prefs.patch(prefs);

  return handler;
}

async function call(handler, req, bodyArg) {
  const res = makeRes();
  const r = await handler(req, res, bodyArg);
  await flush(5);
  return { res, ret: r };
}

const get = (path, socket = { remoteAddress: '127.0.0.1' }) => makeReq({ method: 'GET', url: `${ROUTE_PREFIX}${path}`, socket });
const post = (path, body, socket = { remoteAddress: '127.0.0.1' }) => makeReq({ method: 'POST', url: `${ROUTE_PREFIX}${path}`, body, socket });

/* ---------------- 快照装配 ---------------- */
check('snapshotOf：三榜齐全 + 一份真相字段一个不少（客户端不补判定）', async () => {
  const h = await mkApi({
    states: {
      daily: stateRow('daily', Array.from({ length: 9 }, (_x, i) => crow(`a/${i}`, i + 1))),
      weekly: stateRow('weekly', [crow('b/1', 1)]),
      monthly: null,
    },
    prefs: { topN: 5 },
  });
  const snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 7777,
  });
  assert.equal(snap.at, 7777);
  assert.deepEqual(Object.keys(snap.boards), BOARDS);
  assert.equal(snap.boards.daily.label, '日榜');
  assert.equal(snap.boards.daily.rowsTotal, 9, 'rowsTotal 是榜面真实长度');
  assert.equal(snap.boards.daily.rows.length, 5, 'rows 按 prefs.topN 切');
  assert.equal(snap.boards.daily.empty, false);
  assert.equal(snap.boards.monthly.hasData, false);
  assert.equal(snap.boards.monthly.ok, false);
  assert.equal(snap.boards.monthly.error, '还没跑过第一轮检查');
  assert.equal(snap.boards.monthly.rows.length, 0);
  assert.equal(snap.sourceNote, TRENDING_SOURCE_NOTE);
  assert.deepEqual(snap.langCheck, LANG_CHECK);
  assert.equal(snap.prefs.topN, 5);
  assert.equal(snap.storage.available, true);
  assert.ok(Array.isArray(snap.events));
  assert.ok(snap.caps.storageDomain);
  assert.equal(snap.capabilityRows.length, 3);
  assert.equal(snap.cross.note, '跨榜同现由这一次检查的三张榜交叉算出，不额外发请求。');
});

check('snapshotOf：内置预译的 hits 只覆盖屏上那些行；descZh 键恒在，客户端不许自己判「有没有送到」', async () => {
  const [r1, s1, z1] = DESC_ZH_ROWS[0];
  const [r2, s2] = DESC_ZH_ROWS[1];
  const [r3, s3, z3] = DESC_ZH_ROWS[2];
  const h = await mkApi({
    states: {
      daily: stateRow('daily', [
        crow(r1, 1, { desc: s1 }),                       // 命中
        crow('not/in-table', 2, { desc: s2 }),            // 主键不在表里：原文照显示
        crow('f/3', 3, { desc: '' }),
        crow('f/4', 4, { desc: '' }),
        crow('f/5', 5, { desc: '' }),
        crow(r2, 6, { desc: s2 }),                        // 本该命中，但被 prefs.topN 切掉 ⇒ 不许出现在 hits
      ]),
      weekly: stateRow('weekly', [crow(r3, 1, { desc: `${s3} 后面被仓库自己改了一句` })]), // 原文变了 ⇒ 不译
      monthly: stateRow('monthly', [crow(r3, 1, { desc: s3 })]),                          // 命中
    },
    prefs: { topN: 5 },
  });
  const snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    transStore: h.__stores.trans, caps: h.__caps, now: () => 9,
  });
  assert.equal(snap.boards.daily.rowsTotal, 6);
  assert.equal(snap.boards.daily.rows.length, 5, '先确认 topN=5 真的把第 6 行切掉了');
  assert.deepEqual(Object.keys(snap.descZh.hits), [r1, r3], 'hits 只该是屏上命中的那两条主键');
  // ★ 第二十二轮：hits 的值从「一句译文」升成「一句译文 + 它是谁译的」—— 同一列现在并排两种来源，
  //   界面不自己判来源就没法落款，而「内置预译」和「现译」说的是两件不同的事（一个是编译期死的，一个是这台机器此刻发的）。
  assert.deepEqual(snap.descZh.hits[r1], { zh: z1, via: 'builtin', label: DESC_ZH_LABEL, note: DESC_ZH_NOTE, src: s1 });
  assert.deepEqual(snap.descZh.hits[r3], { zh: z3, via: 'builtin', label: DESC_ZH_LABEL, note: DESC_ZH_NOTE, src: s3 });
  // 卡头按**这一张榜**算条数：拿三榜合并的数字冒充本榜，日榜就会念出一句和屏上对不上的话。
  assert.equal(snap.descZh.heads.daily, `描述中译为${DESC_ZH_LABEL}`, '本榜命中 1 条 ⇒ 沿用内置那一句');
  assert.equal(snap.descZh.heads.weekly, '', '原文被仓库改过 ⇒ 这一榜一条中文都没有，卡头那一段整段不出现');
  assert.equal(snap.descZh.heads.monthly, `描述中译为${DESC_ZH_LABEL}`);
  assert.deepEqual(Object.keys(snap.descZh.heads), BOARDS, 'heads 的键恒为三榜，切榜时客户端不用判 undefined');
  assert.equal(snap.descZh.liveNote, '', '这一帧没有「该有中文却拿不到」的行 ⇒ 不唠叨');

  const bare = await mkApi({ states: { daily: null, weekly: null, monthly: null } });
  const empty = await snapshotOf({
    stateStore: bare.__stores.state, eventStore: bare.__stores.events, prefsStore: bare.__stores.prefs,
    transStore: bare.__stores.trans, caps: bare.__caps, now: () => 9,
  });
  assert.deepEqual(Object.keys(empty.descZh).sort(), ['heads', 'hits', 'liveNote'], '形状恒定：三键，不多不少');
  assert.deepEqual(empty.descZh.hits, {}, '一行榜面数据都没有时给空对象，不给 undefined');
  assert.deepEqual(empty.descZh.heads, { daily: '', weekly: '', monthly: '' });
});

check('snapshotOf：榜面那一列也吃库里的现译行（第二十二轮改判）—— B 优先、逐字命中才算数、卡头两路并报', async () => {
  const [bKey, bSrc, bZh] = DESC_ZH_ROWS[0];
  const liveRepo = 'live/one';
  const liveSrc = 'An english description worth translating';
  const staleRepo = 'live/stale';
  const h = await mkApi({
    states: {
      daily: stateRow('daily', [
        crow(bKey, 1, { desc: bSrc }),                    // 内置命中
        crow(liveRepo, 2, { desc: liveSrc }),             // 库里逐字命中 ⇒ 现译
        crow(staleRepo, 3, { desc: 'The repo reworded this line afterwards' }), // 库里躺的是旧原文 ⇒ 作废
      ]),
      weekly: stateRow('weekly', [crow(liveRepo, 1, { desc: liveSrc })]),   // 同一仓库两张榜都挂着 ⇒ 视图里只有一条
      monthly: null,
    },
    prefs: { topN: 5 },
  });
  // B 命中的那一行库里也有一批现译旧行：内置表是编译期核对过的，必须压过这台机器攒下的行（第八轮「B 优先」原样成立）。
  await h.__stores.trans.put({ repo: bKey, kind: 'desc', src: transSrcKey(bSrc), zh: '模型重新译的那一句', at: 70, engine: 'keyless' });
  await h.__stores.trans.put({ repo: liveRepo, kind: 'desc', src: transSrcKey(liveSrc), zh: '模型给的中文', at: 66, engine: 'host_llm' });
  await h.__stores.trans.put({ repo: staleRepo, kind: 'desc', src: 'The repo reworded this line', zh: '上一版的中文', at: 65, engine: 'keyless' });
  const snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    transStore: h.__stores.trans, caps: h.__caps, now: () => 99,
  });
  assert.equal(snap.descZh.hits[bKey].via, 'builtin', 'B 有这句 ⇒ 库里那行现译不能把它盖掉');
  assert.equal(snap.descZh.hits[bKey].zh, bZh);
  assert.deepEqual(snap.descZh.hits[liveRepo], {
    zh: '模型给的中文', via: 'live', label: engineZhLabel('host_llm', 66), note: DESC_ZH_LIVE_NOTE, src: transSrcKey(liveSrc),
  }, '现译那一行的落款跟的是**行里的 engine 与 at**，不是这一帧的档名和时刻（第九轮那条律）');
  assert.equal(snap.descZh.hits[staleRepo], undefined, '原文变了 ⇒ 旧译文指鹿为马，宁可退回原文');
  assert.equal(snap.descZh.heads.daily, '描述中文：内置预译 1 条 · 现译 1 条', '两路各报各的条数');
  assert.equal(snap.descZh.heads.weekly, '描述中文为现译 1 条', '这一榜只有一路有货 ⇒ 另一路的“0 条”整段省掉');
  assert.equal(snap.descZh.heads.monthly, '', '没跑过检查的榜不给任何中文句子');
});

check('snapshotOf：liveNote 只在「开关开着、库存得下、这一路此刻给不出」时说；其余几种闭嘴各有各的理由', async () => {
  const h = await mkApi({
    states: { daily: stateRow('daily', [crow('x/1', 1, { desc: 'A plain english description' })]), weekly: null, monthly: null },
    prefs: { translateEngine: 'host_llm', llmDesc: true, topN: 5 },
  });
  const base = (over) => ({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    transStore: h.__stores.trans, caps: h.__caps, now: () => 5, translator: mkTranslatorStub({ ready: false }),
    ...over,
  });

  // ① 开关开 + 库在 + 引擎没就绪 ⇒ 说实话，并指回设置页
  let s = await snapshotOf(base());
  assert.equal(s.descZh.liveNote, DESC_ZH_BLOCKED_NOTE, '开关开着却发不出去 ⇒ 榜面要讲清"只显内置预译"是这一时的故障');

  // ② 开关关着 ⇒ 不唠叨（那一行开关自己就摆在设置页，榜面不该替它重复一遍）
  s = await snapshotOf(base({ translator: mkTranslatorStub({ ready: false, enabled: () => false }) }));
  assert.equal(s.descZh.liveNote, '', '开关关着却念"下一轮会自动再试" ⇒ 那句是假话，用户根本没开');

  // ③ 引擎就绪 ⇒ 缺的那几句由这一轮批次去补，不在这里道歉
  s = await snapshotOf(base({ translator: mkTranslatorStub({ ready: true }) }));
  assert.equal(s.descZh.liveNote, '', '发得出去的时候不写故障句（否则每一帧都在喊一句此刻并不成立的话）');

  // ④ 存不下 ⇒ 不说"下一轮会自动再试"：无存储的机器上下一轮也留不下译文，那里另有能力位横幅
  const noStore = createTransStore({ getFacility: () => undefined, logger: { warn: () => {} } });
  s = await snapshotOf(base({ transStore: noStore }));
  assert.equal(s.descZh.liveNote, '', '无存储时那句"下一轮自动再试"兑现不了 ⇒ 宁可不说');
  assert.deepEqual(s.descZh.hits, {}, '读不到库也不炸：这一列退回"只显内置预译"，而那在那些机器上是真话');

  // ⑤ 屏上没有「该有中文却缺着」的行 ⇒ 即使引擎没就绪也不说一句
  const covered = await mkApi({
    states: { daily: stateRow('daily', [crow(DESC_ZH_ROWS[0][0], 1, { desc: DESC_ZH_ROWS[0][1] })]), weekly: null, monthly: null },
    prefs: { translateEngine: 'host_llm', llmDesc: true, topN: 5 },
  });
  s = await snapshotOf({
    stateStore: covered.__stores.state, eventStore: covered.__stores.events, prefsStore: covered.__stores.prefs,
    transStore: covered.__stores.trans, caps: covered.__caps, now: () => 5,
    translator: mkTranslatorStub({ ready: false }),
  });
  assert.equal(s.descZh.liveNote, '', '内置表已经覆盖屏上每一行 ⇒ 没有欠着的行，就不该出现"这一时发不出去"');
});

check('读路径零发：GET /api/snapshot 与 SSE 首帧一发不派，补译只挂在一轮检查之后', async () => {
  // ★ 这一例的桩必须履行 `translate()` 那半份契约（自己落库）：runner 按设计不碰库，
  //   桩不写库就测不出「补完之后下一帧真读得到」，而那正是本轮用户要看到的效果。
  let trans = null;
  const jobs = [];
  const stub = {
    ready: () => true,
    kinds: () => [...LLM_KINDS],
    enabled: (kind) => kind === 'desc',
    async translate(arg) {
      jobs.push(arg);
      await trans.put({
        repo: String(arg.repo).toLowerCase(), kind: arg.kind, src: transSrcKey(arg.text),
        zh: `补的中文（${arg.repo}）`, at: 66, engine: 'host_llm',
      });
      return { ok: true, zh: `补的中文（${arg.repo}）`, cached: false, at: 66, label: engineZhLabel('host_llm', 66), stored: true, note: '', errKey: '', errText: '', engine: 'host_llm' };
    },
  };
  const h = await mkApi({
    prefs: { translateEngine: 'host_llm', llmDesc: true, topN: 5 },
    states: { daily: stateRow('daily', [crow('a/1', 1, { desc: 'One english line' }), crow('b/2', 2, { desc: 'Another english line' })]), weekly: null, monthly: null },
    translator: stub,
  });
  trans = h.__stores.trans;

  const res = makeRes();
  await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` }), res);
  await flush(5);
  assert.equal(jobs.length, 0, '打开面板（SSE 首帧）一发不派 ⇒ 界面不会因为翻译而变慢');
  const viaGet = await call(h, get('/api/snapshot'));
  assert.equal(jobs.length, 0, `GET /api/snapshot 派了 ${jobs.length} 发 ⇒ 读路径必须零发`);
  assert.equal(viaGet.res.json().data.descZh.hits['a/1'], undefined);

  for (const fn of h.__fanout) fn({ type: 'update', at: 1234 });
  await flush(20);
  assert.deepEqual(jobs.map((j) => j.repo).sort(), ['a/1', 'b/2'], '一轮检查后才补，补的是屏上没命中的那几行');
  assert.ok(jobs.every((j) => j.kind === 'desc'), '榜面这一路只补描述，摘要档各开各的');
  const joined = res.writes.join('');
  const frames = joined.split('event: update\ndata: ').length - 1;
  assert.equal(frames, 2, '补成真推第二帧；只推一帧的话榜面会一直停在"没补"的那一屏');
  const second = JSON.parse(joined.split('event: update\ndata: ')[2].split('\n\n')[0]);
  assert.equal(second.descZh.hits['a/1'].via, 'live', '第二帧里现译行读得到');
  assert.equal(second.descZh.heads.daily, '描述中文为现译 2 条');
  h.dispose();
});

check('补译这一轮的闸门与上限：开关关 / 引擎没就绪 / 选中的那一路没接 ⇒ 零发；一轮最多 BOARD_ZH_BATCH_MAX 发', async () => {
  const gate = async ({ llmDesc = true, ready = true, enabled = null, count = 20, engine = 'host_llm', wire = 'translator' }) => {
    // ★ 桩的 `enabled` 跟着 `llmDesc` 走：真那一路（lib/services/llm.js）读的就是这一格偏好，
    //   桩写死 `() => true` 的话，"开关关着所以零发"测的是桩不是闸门（第十五轮那条"桩=真服务"的对齐判据）。
    const stub = mkTranslatorStub({ ready, enabled: enabled ?? ((kind) => (kind === 'desc' ? llmDesc : false)) });
    const h = await mkApi({
      prefs: { translateEngine: engine, llmDesc, topN: count },
      states: { daily: stateRow('daily', Array.from({ length: count }, (_x, i) => crow(`z/${i}`, i + 1, { desc: `English line number ${i}` }))), weekly: null, monthly: null },
      translator: wire === 'translator' ? stub : null,
      webTranslator: wire === 'webTranslator' ? stub : null,
    });
    for (const fn of h.__fanout) fn({ type: 'update', at: 1 });
    await flush(30);
    const n = stub.jobs.length;
    h.dispose();
    return n;
  };
  assert.equal(await gate({ llmDesc: false }), 0, '「描述现译」开关关着 ⇒ 榜面这一路一发不派（用户裁定的第三条：不新增开关，就用这一档）');
  assert.equal(await gate({ ready: false }), 0, '引擎没就绪 ⇒ 不发（发了也只是失败冷却，白占一次额度）');
  assert.equal(await gate({ enabled: () => false }), 0, '那一路自己判了关 ⇒ 不发');
  assert.equal(await gate({ engine: 'baidu', wire: 'translator' }), 0, '选中的是免费/官方那一路，而接上的只有宿主模型那一路 ⇒ 不发（两路服务互相不知道对方在）');
  assert.equal(await gate({ count: 20 }), BOARD_ZH_BATCH_MAX, `一轮最多 ${BOARD_ZH_BATCH_MAX} 发（20 行屏上只补这么多）`);
});

/* ---------------- 10-10 改判（用户裁定 A）：那一档开着时接上现译 ---------------- */

/** 往「全站高星」那张表落一批（真仓储、真 schema 认过的行形状），让快照读得到那一档。 */
async function writeSearchBatch(h, rows) {
  await h.__stores.search.write({
    at: 7000, lastFetchAt: 7000, ok: true, error: '', transport: false, rows,
    rateLeft: 9, rateLimit: 10, rateResetAt: 0, rateAuthed: false,
  });
}

check('★ 快照那一列吃的是同一份集合：那一档开着 ⇒ 它那一批里库里已译的行上屏；关掉 ⇒ 译文躺在库里也不给（屏上退回原文）', async () => {
  const siteZh = '那一档那一行的中文';
  const snapOf = async (enabled) => {
    const h = await mkApi({
      prefs: { translateEngine: 'host_llm', llmDesc: true, allStarsEnabled: enabled, topN: 5 },
      states: { daily: stateRow('daily', [crow('b/1', 1, { desc: 'A board line' })]), weekly: null, monthly: null },
    });
    await writeSearchBatch(h, [SEARCH_ROW]);
    await h.__stores.trans.put({ repo: SEARCH_ROW.repo, kind: 'desc', src: transSrcKey(SEARCH_ROW.desc), zh: siteZh, at: 60, engine: 'host_llm' });
    const data = (await call(h, get('/api/snapshot'))).res.json().data;
    h.dispose();
    return data;
  };
  const on = await snapOf(true);
  assert.equal(on.descZh.hits[SEARCH_ROW.repo]?.zh, siteZh, '开着 ⇒ 那一档那一行的现译上屏（用户裁定的就是这一格）');
  assert.equal(on.descZh.hits[SEARCH_ROW.repo].via, 'live');
  const off = await snapOf(false);
  assert.equal(off.descZh.hits[SEARCH_ROW.repo], undefined,
    '★ 关掉 ⇒ 参与集合里压根没有它，库里那句不上的屏：出厂关着的档不该给没用它的人烧翻译额度，也不该显示"补好的中文"');
  assert.equal(off.stars.allStars.rows[0].desc, SEARCH_ROW.desc, '载荷那一行的原文一个字没动（不译不等于改写）');
});

check('★ 轮次后补译吃的也是那份集合：开着 ⇒ 那一档的未译行进批次；关掉 ⇒ 同一份库只补榜面', async () => {
  const once = async (enabled) => {
    const stub = mkTranslatorStub({ ready: true });
    const h = await mkApi({
      prefs: { translateEngine: 'host_llm', llmDesc: true, allStarsEnabled: enabled, topN: 5 },
      states: { daily: stateRow('daily', [crow('b/1', 1, { desc: 'Board one' }), crow('b/2', 2, { desc: 'Board two' })]), weekly: null, monthly: null },
      translator: stub,
    });
    await writeSearchBatch(h, [SEARCH_ROW]);
    for (const fn of h.__fanout) fn({ type: 'update', at: 1234 });
    await flush(20);
    const repos = stub.jobs.map((j) => j.repo).sort();
    h.dispose();
    return repos;
  };
  assert.deepEqual(await once(true), ['b/1', 'b/2', SEARCH_ROW.repo], '开着 ⇒ 那一档那一行也在补的名单里（榜面两行 + 它一行）');
  assert.deepEqual(await once(false), ['b/1', 'b/2'], '关掉 ⇒ 只补榜面两行，那一档一行都不派');
});

check('★ liveNote 的欠账只数榜面那一组：三榜一句不欠、只有那一档欠着 ⇒ 榜面不念那句「这一列只显内置预译」', async () => {
  const [bKey, bSrc] = DESC_ZH_ROWS[0];
  const probe = async (boardRow) => {
    const h = await mkApi({
      prefs: { translateEngine: 'host_llm', llmDesc: true, allStarsEnabled: true, topN: 5 },
      states: { daily: boardRow, weekly: null, monthly: null },
      // ★ 引擎这一路要**接上但没就绪**：那句话的四格判据里有"这一路此刻给不出"，桩没接（null）时条件压根不成立，
      //   那样两档都会是空串 —— 判据看着绿，实际是空跑（对照那一档会一起假绿）。
      translator: mkTranslatorStub({ ready: false }),
    });
    await writeSearchBatch(h, [SEARCH_ROW]);
    const data = (await call(h, get('/api/snapshot'))).res.json().data;
    h.dispose();
    return data.descZh.liveNote;
  };
  assert.equal(await probe(stateRow('daily', [crow(bKey, 1, { desc: bSrc })])), '',
    '★ 榜面被内置表覆盖、只有那一档欠着 ⇒ 榜面念"这一列只显内置预译"是假话（判据必须吃 boardMissing）');
  assert.equal(await probe(stateRow('daily', [crow('x/1', 1, { desc: 'A plain english description' })])), DESC_ZH_BLOCKED_NOTE,
    '对照：榜面自己就欠着、引擎这会儿发不出去 ⇒ 那一句照旧要说（换成 boardMissing 也不能把真故障念成没事）');
});

/* ---------------- 第二十三轮 · 步骤 5：明星那一屏进快照 + 轮次后那一发 ---------------- */

/** 从 SSE 的 writes 里数 `event: update` 帧（追帧判据吃的是"浏览器真收到了几帧"，不是内部计数）。 */
const updateFrames = (raw) => raw.split('event: update\ndata: ').length - 1;
/** 第 i 个 update 帧（**1 起**：`split` 把分隔符吃掉之后，索引 0 是帧前的那一段）。 */
const frameAt = (raw, i) => JSON.parse(raw.split('event: update\ndata: ')[i].split('\n\n')[0]);

check('明星那一屏进快照：stars 那两层的键表恒在，SSE 首帧与 GET 同形；读路径零发（打开面板与 GET 各一派零发）', async () => {
  const h = await mkApi({ states: { daily: stateRow('daily', [crow('a/1', 1)]), weekly: null, monthly: null } });
  const res = makeRes();
  await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` }), res);
  await flush(5);
  assert.equal(h.__searchCalls.length, 0, 'SSE 首帧的装配里派了那一发 ⇒ 每开一次面板就烧一次 search 配额');

  const frame = JSON.parse(res.writes.join('').split('event: snapshot\ndata: ')[1].split('\n\n')[0]);
  const viaGet = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.equal(h.__searchCalls.length, 0, 'GET /api/snapshot 派了那一发 ⇒ 读路径不再是零发');

  assert.deepEqual(Object.keys(frame.stars).sort(), Object.keys(viaGet.stars).sort(), '两种通路的 stars 必须同形');
  assert.deepEqual(Object.keys(viaGet.stars).sort(), [
    'allStars', 'headline', 'minRounds', 'missingCell', 'roundsAvailable', 'roundsPeakLabel', 'rows',
    'sorts', 'starsAddedLabel', 'starsLabel', 'thin', 'thinNote', 'views',
  ].sort(), 'stars 那一层的键表变了就是改了客户端的契约（客户端不猜键，缺一个键就是一块白屏）');
  assert.deepEqual(Object.keys(viaGet.stars.allStars).sort(), ['error', 'hasData', 'note', 'ok', 'rows', 'statLine', 'transport']);

  // search 表一行都没有：那一档给**空数组**而不是 undefined，并念那句「未开启」（出厂关着）
  assert.deepEqual(viaGet.stars.allStars.rows, []);
  assert.equal(viaGet.stars.allStars.hasData, false);
  assert.equal(viaGet.stars.allStars.error, '');
  assert.equal(viaGet.stars.allStars.statLine, STARS_QUOTA_OFF_NOTE, '开关关着却念"还没取回过"，等于让用户以为开了但坏了');
  assert.equal(viaGet.stars.rows.length, 1, '榜史那一段照旧装配（全站高星关着不影响本地明星那一屏）');
  h.dispose();
});

check('快照里的 stars 与直接调 starsView 同源（不许第二份真相），且候选吃的是 topN 切片后的那三榜', async () => {
  const h = await mkApi({
    prefs: { topN: 5 },
    states: {
      daily: stateRow('daily', Array.from({ length: 8 }, (_x, i) => crow(`a/${i + 1}`, i + 1, { stars: 1000 - i * 100 }))),
      weekly: null, monthly: null,
    },
  });
  await h.__stores.seen.touch({ repo: 'a/1', name: 'A/1', board: 'daily', at: 4000, rank: 3 });
  await h.__stores.seen.touch({ repo: 'a/1', name: 'A/1', board: 'daily', at: 5000, rank: 1 });

  const snap = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.deepEqual(snap.stars.rows.map((r) => r.repo), ['a/1', 'a/2', 'a/3', 'a/4', 'a/5'],
    '屏上只有前五名 ⇒ 明星那一屏的候选只能是那五行（rank 6~8 在载荷里却在屏上没有，就是"界面显示 5 行、数着 8 行"）');
  assert.ok(!snap.stars.rows.some((r) => ['a/6', 'a/7', 'a/8'].includes(r.repo)), '切片之后的榜没喂进 starsView');
  assert.equal(snap.stars.rows[0].rounds, 2, '在榜轮数从观测史来（同轮三榜只 +1，跨两轮才 +2）');
  assert.equal(snap.stars.rows[0].bestRank, 1, '峰值名次取历史最好（只降不升）');

  // ★ 期望值由**同一个纯视图**现算，喂的是快照自己已经给出去的那三榜与那份偏好：
  //   这条判据钉的是"装配层没有另拼一份原料"（比如漏了 prefs、拿 states 当 boards、自己补时刻）。
  const expected = starsView({
    seenRows: await h.__stores.seen.readAll(),
    boards: snap.boards,
    roundAt: snap.boards.daily.at,
    prefs: snap.prefs,
    search: await h.__stores.search.read(),
    storageAvailable: true,
  });
  assert.deepEqual(snap.stars, expected, '快照里的 stars 与直接调 starsView 不同源 ⇒ 界面上那句话有了第二份出处');
  h.dispose();
});

check('roundAt 取的是「最近一轮成功取回」而不是本地时钟：插件停摆三十天后，那一屏榜史照旧在屏上（数据没变，读数不许变）', async () => {
  // ★ 时刻用**真实量级**的 epoch：拿 7777 这种小数字试，三十天前就负了，`numOr0` 把负数折成 0 ⇒
  //   窗口判据两头都成立、变异照样绿（本轮变异 M4 的第一版就是这么漏过去的）。
  const NOW = 1_800_000_000_000;
  const stale = NOW - 30 * 24 * 3600 * 1000;
  const h = await mkApi({
    now: () => NOW,
    states: { daily: stateRow('daily', [crow('a/1', 1)], { at: stale, bodyChangedAt: stale, lastFetchAt: stale }), weekly: null, monthly: null },
  });
  await h.__stores.seen.touch({ repo: 'z/old', name: 'Z/Old', board: 'daily', at: stale, rank: 2 });
  const snap = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.ok(snap.stars.rows.some((r) => r.repo === 'z/old'),
    '窗口按本地时钟算 ⇒ 停摆三十天后一屏榜史自己清空（那批行一个字没变，只是"现在几点"变了）');
  assert.equal(snap.stars.rows.find((r) => r.repo === 'z/old').group, 'cooling');
  assert.equal(snap.stars.rows.find((r) => r.repo === 'a/1').group, 'rising', '这一轮在榜、本机第一次见到 ⇒ 新星；回落与新星用的是同一个时刻，不是两套时钟');
  h.dispose();
});

check('观测史那张表读不出（available 不是真）⇒ 那一屏念「存储不可用」那一句，而不是空表那句「还没跑过检查」', async () => {
  const h = await mkApi({ seenStore: { available: false, readAll: async () => { throw new Error('storageDomain 掉了'); } } });
  const snap = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.equal(snap.stars.headline, STARS_NO_STORE_NOTE, '能力边界 ①：装配层把"读失败"当"没数据"，界面就会说错原因');
  assert.deepEqual(snap.stars.rows, []);
  assert.ok(h.__warns.some((w) => w.includes('观测史')), '读失败要留一句可查的日志');
  h.dispose();
});

check('那一发只挂轮次：带 at 的检查事件后派满 SEARCH_MAX_PER_ROUND 发就收口；换轮重新允许；装配层恒给它零个实参（令牌不在这一层）', async () => {
  const h = await mkApi({ prefs: { allStarsEnabled: true } });
  for (const fn of h.__fanout) fn({ type: 'update', at: 1234 });
  await flush(20);
  assert.equal(h.__searchCalls.length, SEARCH_MAX_PER_ROUND, `一轮检查应当发 ${SEARCH_MAX_PER_ROUND} 发`);
  for (const fn of h.__fanout) fn({ type: 'update', at: 1234 });
  await flush(20);
  assert.equal(h.__searchCalls.length, SEARCH_MAX_PER_ROUND, '同一轮的第二次触发穿过了预算闸门 ⇒ 每轮 1 发变成了每事件 1 发');
  for (const fn of h.__fanout) fn({ type: 'update', at: 2345 });
  await flush(20);
  assert.equal(h.__searchCalls.length, SEARCH_MAX_PER_ROUND * 2, '换了轮次必须重新给预算');
  assert.ok(h.__searchCalls.every((args) => args.length === 0),
    '装配层给那一发递了实参 ⇒ 令牌会从这一层流出去（api 门面从头到尾不该认识它）');

  const row = await h.__stores.search.read();
  assert.equal(row.ok, true);
  assert.deepEqual(row.rows.map((r) => r.repo), ['freecodecamp/freecodecamp']);
  assert.equal(h.__facility.rowCount('gh_trending', 'search'), 1, '那一档恒一行：覆盖写，不追加（append 会让界面上的"上一批"变成历史堆）');
  h.dispose();
});

check('不带 at 的 update（保存偏好那类）一发不派、一帧不追，并留一句可查的 warn', async () => {
  const h = await mkApi({ prefs: { allStarsEnabled: true } });
  const res = makeRes();
  await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` }), res);
  await flush(5);
  const before = updateFrames(res.writes.join(''));
  for (const fn of h.__fanout) fn({ type: 'update' });
  await flush(20);
  assert.equal(h.__searchCalls.length, 0, '保存一次设置就多打一发 search ⇒ 那是白烧额度，不是轮次');
  assert.ok(h.__warns.some((w) => w.includes('轮次')), '跳过要留一句（用户开了却没见数据，那句话得能查到底是哪一轮没认出来）');
  assert.equal(updateFrames(res.writes.join('')) - before, 1, '一件轮次后的活都没干成 ⇒ 载荷没变，不该追第二帧');
  h.dispose();
});

/* --------- 10-09 改判：开启即拉（「关 → 开」那一趟当场发一发，不再让人等到下一轮检查） --------- */

check('开启即拉：库里 false → 递来 true 的那一趟当场发一发，回执回来时那一批已经在库里、也在快照里', async () => {
  // 延迟桩：把「回执之前发完」和「回执之后自己发」这两种接法分开 —— 不延迟的话 5ms 的 flush 会把差别圆掉。
  const slow = async () => { await flush(25); return searchOk(); };
  const h = await mkApi({ searchFetcher: slow });
  assert.equal(h.__searchCalls.length, 0, '前提：装配完还没出过网');
  const sres = makeRes();
  await h(get('/api/stream'), sres);
  await flush(5);
  const base = updateFrames(sres.writes.join(''));
  const { res } = await call(h, post('/api/prefs', { allStarsEnabled: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(h.__searchCalls.length, SEARCH_MAX_PER_ROUND,
    `点「开」的那一趟应当当场派 ${SEARCH_MAX_PER_ROUND} 发（用户裁定 10-09：开启的时候默认拉取一次，不是等下一轮检查）`);
  const row = await h.__stores.search.read();
  assert.equal(row && row.ok, true, '回执都回来了库里还没有那一批 ⇒ 这一发其实是在后台飘（"点完了但结果在别处"）');
  assert.deepEqual(row.rows.map((r) => r.repo), ['freecodecamp/freecodecamp']);
  assert.equal(updateFrames(sres.writes.join('')) - base, 1,
    '发过就追帧：savePrefs 的回执只并 prefs 那一格，那一批行不追帧就上不了屏（面板停在"已开启、没取回"）');
  const snap = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.equal(snap.prefs.allStarsEnabled, true);
  assert.equal(snap.stars.allStars.hasData, true);
  assert.equal(snap.stars.allStars.ok, true);
  assert.equal(snap.stars.allStars.statLine,
    starsQuotaLine({ at: 7777, left: 9, limit: 10, resetAt: 1791518294000, authed: false }),
    '那一发取回后屏上念的额度句仍只出自 domain 的 starsQuotaLine（装配层不自己拼）');
  h.dispose();
});

check('开启即拉认的是「转换」：已经开着再存 true（连点、改别的键时顺带带上）一发不派 —— 白烧额度那条律只是收窄，没被删', async () => {
  const h = await mkApi({ prefs: { allStarsEnabled: true } });
  await call(h, post('/api/prefs', { allStarsEnabled: true }));
  assert.equal(h.__searchCalls.length, 0, '库里本来就开着 ⇒ 这一趟不是"开启"，不该再花一发');
  await call(h, post('/api/prefs', { topN: 12, allStarsEnabled: true }));
  assert.equal(h.__searchCalls.length, 0, '顺带把那一档一起 POST 过来 ⇒ 转换判据吃的是库里的旧值，不是请求里有没有这个键');
  assert.equal((await h.__stores.prefs.read()).topN, 12, '前提：这一趟真存进了库（不是因为 400 才没发）');
  h.dispose();
});

check('关掉那一趟与没碰那一档的保存都不派；出厂关着时任何保存都不派（装了这一路不等于替用户出网）', async () => {
  const on = await mkApi({ prefs: { allStarsEnabled: true } });
  await call(on, post('/api/prefs', { allStarsEnabled: false }));
  assert.equal(on.__searchCalls.length, 0, '「开 → 关」不许发（关掉不删库里已攒的那一批，也不该顺手取一次）');
  await call(on, post('/api/prefs', { topN: 12 }));
  assert.equal(on.__searchCalls.length, 0, '没带 allStarsEnabled 的保存不该派');
  on.dispose();
  const off = await mkApi();
  await call(off, post('/api/prefs', { intervalMin: 30 }));
  assert.equal(off.__searchCalls.length, 0, '出厂关着 ⇒ 保存别的偏好也不该让这一路出网');
  off.dispose();
});

check('开启那一发坏了也要当场看得见：回执 200、库里落坏轮、载荷那三格（hasData/ok/error）把故障说出嘴', async () => {
  const h = await mkApi({ searchFetcher: async () => searchBad() });
  const sres = makeRes();
  await h(get('/api/stream'), sres);
  await flush(5);
  const base = updateFrames(sres.writes.join(''));
  const { res } = await call(h, post('/api/prefs', { allStarsEnabled: true }));
  assert.equal(res.statusCode, 200, '那一发失败是出网的事，不该把"保存偏好"本身回成 5xx');
  assert.equal(updateFrames(sres.writes.join('')) - base, 1,
    '坏轮 sent>0 也要追帧：那一轮的 ok/error/lastFetchAt 三格本来就是要让界面看见的变化（藏着等于没出口）');
  const row = await h.__stores.search.read();
  assert.equal(row.ok, false);
  assert.equal(row.error, '限额用尽（403，重置于 2026/10/9 04:38:14）', '原样回执，不过 REPO_ERROR_LABELS（两套池子那条）');
  assert.equal(row.at, 0, '没有上一批可冻结时 at 落 0 ⇒ 界面上那句额度还念"等待"，不会编一个"上次取回"');
  const snap = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.equal(snap.stars.allStars.hasData, true, '落过库（坏轮那一条）就说"落过"');
  assert.equal(snap.stars.allStars.ok, false);
  assert.equal(snap.stars.allStars.error, row.error);
  h.dispose();
});

check('开启即拉与检查轮各花各的预算：点完「开」再走一轮检查 ⇒ 两发都派得出（互不侵占），同一趟连点两次只有一发', async () => {
  const h = await mkApi();
  await call(h, post('/api/prefs', { allStarsEnabled: true }));
  assert.equal(h.__searchCalls.length, SEARCH_MAX_PER_ROUND, '开启那一趟派了一发');
  await call(h, post('/api/prefs', { allStarsEnabled: true }));
  assert.equal(h.__searchCalls.length, SEARCH_MAX_PER_ROUND, '同一毫秒内的第二次「开」（转换已吃过）不再派 ⇒ 连点不叠发');
  for (const fn of h.__fanout) fn({ type: 'update', at: 4321 });
  await flush(20);
  assert.equal(h.__searchCalls.length, SEARCH_MAX_PER_ROUND * 2,
    '检查轮那一发不能被开启那一趟占掉（占了就等于"点完开后这一轮不刷新了"，而那一轮的预算本来就独立）');
  h.dispose();
});

check('★ 间隔内已经拉取过就不再拉（10-09 第二条裁定）：库里五分钟前刚成功取回 ⇒ 点「开」0 发、不追帧，而屏上那一批照旧在载荷里', async () => {
  const T0 = 1_700_000_000_000, MIN = 60_000;
  const h = await mkApi({ now: () => T0 });
  await h.__stores.search.write({
    at: T0 - 5 * MIN, lastFetchAt: T0 - 5 * MIN, ok: true, error: '', transport: false, rows: [SEARCH_ROW],
    rateLeft: 9, rateLimit: 10, rateResetAt: 1791518294000, rateAuthed: false,
  });
  const sres = makeRes();
  await h(get('/api/stream'), sres);
  await flush(5);
  const base = updateFrames(sres.writes.join(''));
  const { res } = await call(h, post('/api/prefs', { allStarsEnabled: true }));
  assert.equal(res.statusCode, 200, '挡下也是保存成功 —— 那一档现在确实是开着的');
  assert.equal(h.__searchCalls.length, 0, `出厂间隔 60 分、上一发五分钟前成功 ⇒ 这一趟不该再烧一发（用户裁定 10-09 第二条）`);
  assert.equal(updateFrames(sres.writes.join('')) - base, 0,
    '一发没派就不追第二帧：库里一个字没变，而"开着"那一位已经跟着同一次回执上屏了（追帧等于为一个没发生的变化推帧）');
  const row = await h.__stores.search.read();
  assert.equal(row.at, T0 - 5 * MIN, '挡下的那一趟不写库（连 lastFetchAt 都不许推进，否则"上一次发起"会说假话）');
  const snap = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.equal(snap.prefs.allStarsEnabled, true, '开关位仍随回执上屏（分段器那枚不该还灰着）');
  assert.equal(snap.stars.allStars.rows.length, 1, '不发不等于没东西看：本机那一批就在载荷里，屏上直接端上来');
  assert.equal(snap.stars.allStars.hasData, true);
  h.dispose();
});

check('★ 窗口吃的是生效偏好那一格，装配层不自己数分钟：同一份库（61 分钟前）在 60 档发、把间隔拨到 24 小时就不发', async () => {
  const T0 = 1_700_000_000_000, MIN = 60_000;
  const seed = async (h) => h.__stores.search.write({
    at: T0 - 61 * MIN, lastFetchAt: T0 - 61 * MIN, ok: true, error: '', transport: false, rows: [SEARCH_ROW],
    rateLeft: 9, rateLimit: 10, rateResetAt: 0, rateAuthed: false,
  });
  const a = await mkApi({ now: () => T0 });
  await seed(a);
  await call(a, post('/api/prefs', { allStarsEnabled: true }));
  assert.equal(a.__searchCalls.length, SEARCH_MAX_PER_ROUND, '61 分钟 > 出厂 60 分钟的窗口 ⇒ 过期了，点开发');
  a.dispose();

  const b = await mkApi({ now: () => T0 });
  await call(b, post('/api/prefs', { intervalMin: 1440 }));
  assert.equal(b.__searchCalls.length, 0, '前提：关着时改间隔不该让这一路出网');
  await seed(b);
  await call(b, post('/api/prefs', { allStarsEnabled: true }));
  assert.equal(b.__searchCalls.length, 0, '同一份库、窗口换成 24 小时 ⇒ 挡住（窗口只有一个来源：设置页那一格，门面不许再判一次）');
  assert.equal((await b.__stores.prefs.read()).intervalMin, 1440, '前提：那一格真存进了库并按生效值递给 runner（不是 400 才没发）');
  b.dispose();
});

check('发过就追第二帧：成功轮把那一批带进载荷，坏轮把故障那三格带进载荷（把故障藏一轮等于没出口）', async () => {
  const framesOf = async (fetcher) => {
    const h = await mkApi({ prefs: { allStarsEnabled: true }, searchFetcher: fetcher });
    const res = makeRes();
    await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` }), res);
    await flush(5);
    const base = updateFrames(res.writes.join(''));
    for (const fn of h.__fanout) fn({ type: 'update', at: 1234 });
    await flush(20);
    const raw = res.writes.join('');
    const frames = updateFrames(raw) - base;
    return { frames, snap: frames > 0 ? frameAt(raw, base + frames) : null, h };
  };

  const good = await framesOf(async () => searchOk());
  assert.equal(good.frames, 2, '成功轮取回了一批却不追帧 ⇒ 界面要停到下一轮才看得见');
  assert.equal(good.snap.stars.allStars.hasData, true);
  assert.equal(good.snap.stars.allStars.ok, true);
  assert.deepEqual(good.snap.stars.allStars.rows.map((r) => r.repo), ['freecodecamp/freecodecamp']);
  assert.equal(good.snap.stars.allStars.error, '');
  assert.equal(good.snap.stars.allStars.statLine, starsQuotaLine({
    at: 7777, left: 9, limit: 10, resetAt: 1791518294000, authed: false,
  }), '额度那一句的出处只能是 domain 的 starsQuotaLine（装配层自己拼就是第二份真相）');
  good.h.dispose();

  const bad = await framesOf(async () => searchBad());
  assert.equal(bad.frames, 2, '坏轮 sent>0 却不追帧 ⇒ 那一轮的 ok/error/lastFetchAt 本来就是要让界面看见的变化');
  assert.equal(bad.snap.stars.allStars.ok, false);
  assert.equal(bad.snap.stars.allStars.transport, false);
  assert.equal(bad.snap.stars.allStars.error, '限额用尽（403，重置于 2026/10/9 04:38:14）', '界面念的是落库那一份原样回执，不许过 REPO_ERROR_LABELS（两套池子，那句 60 次/小时在 search 这一档是假话）');
  assert.ok(!bad.snap.stars.allStars.error.includes('60'), '故障句里混进了 REST core 的额度数字');
  assert.deepEqual(bad.snap.stars.allStars.rows, []);
  assert.equal(bad.snap.stars.allStars.hasData, true, '落过库（坏轮那一条）就说"落过"，与"这一轮成没成"是两件事');
  bad.h.dispose();

  const off = await mkApi();
  const offRes = makeRes();
  await off(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` }), offRes);
  await flush(5);
  const offBase = updateFrames(offRes.writes.join(''));
  for (const fn of off.__fanout) fn({ type: 'update', at: 1234 });
  await flush(20);
  assert.equal(off.__searchCalls.length, 0, '出厂关着却派了一发 ⇒ 装了就替用户出网');
  assert.equal(updateFrames(offRes.writes.join('')) - offBase, 1, '一发都没派还追帧 ⇒ 面板白刷一次');
  off.dispose();
});

check('偏好里每一个布尔开关都吃严格布尔（清单派生自 DEFAULT_PREFS：新增一格忘了过闸门会被这条逮住）', async () => {
  const boolKeys = Object.entries(DEFAULT_PREFS).filter(([, v]) => typeof v === 'boolean').map(([k]) => k);
  assert.ok(boolKeys.includes('allStarsEnabled'), '全站高星那一档不是布尔偏好 ⇒ 这一档的开关口径要重写');
  assert.ok(boolKeys.length >= 3, `派生出的布尔开关只有 ${boolKeys.join(', ')} —— 比现译两档还少，说明 DEFAULT_PREFS 读法变了，这条判据会空转`);
  for (const k of boolKeys) {
    for (const dirty of ['true', 'false', 1, 0, 'on', {}, []]) {
      const h = await mkApi();
      const { res } = await call(h, post('/api/prefs', { [k]: dirty }));
      assert.equal(res.statusCode, 400, `${k} 收到 ${JSON.stringify(dirty)} 居然过了闸门`);
      assert.equal((await h.__stores.prefs.read())[k], DEFAULT_PREFS[k], `${k} 被拒的那一发把库里原有的值改掉了`);
      h.dispose();
    }
    const flipped = !DEFAULT_PREFS[k];
    const h = await mkApi();
    const ok = await call(h, post('/api/prefs', { [k]: flipped }));
    assert.equal(ok.res.statusCode, 200, `${k} 的合法布尔被拒了 ⇒ 那一格永远存不进库`);
    assert.equal((await h.__stores.prefs.read())[k], flipped, `${k} 过了闸门却没落库（界面上那个开关下次打开会弹回原值）`);
    const snap = (await call(h, get('/api/snapshot'))).res.json().data;
    assert.equal(snap.prefs[k], flipped, '落库了却没进快照 ⇒ 那一档的界面状态是上一帧的');
    h.dispose();
  }
});

check('snapshotOf：跨榜同现是三榜交叉算出来的，不再发请求', async () => {
  const h = await mkApi({
    states: {
      daily: stateRow('daily', [crow('t/three', 5), crow('p/pair', 2)]),
      weekly: stateRow('weekly', [crow('t/three', 4), crow('p/pair', 9)]),
      monthly: stateRow('monthly', [crow('t/three', 7)]),
    },
  });
  const snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 1,
  });
  assert.deepEqual(snap.cross.rising.map((r) => r.repo), ['t/three', 'p/pair']);
  assert.equal(snap.cross.rising[0].span, 3);
  assert.deepEqual(snap.cross.cooling, []);
});

check('snapshotOf：坏榜的旧档照样给得出（冻结口径在界面上看得见）', async () => {
  const h = await mkApi({
    states: {
      daily: stateRow('daily', [crow('a/1', 1)], { ok: false, error: '趋势页返回 500（共尝试 3 次）', failStreak: 2, lastFetchAt: 8000, transport: true }),
      weekly: stateRow('weekly', [crow('w/1', 1)]),
      monthly: stateRow('monthly', []),
    },
  });
  const snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 9000,
  });
  assert.equal(snap.boards.daily.ok, false);
  assert.equal(snap.boards.daily.error, '趋势页返回 500（共尝试 3 次）');
  assert.equal(snap.boards.daily.transport, true, '传输类那一位要交给界面决定提不提「直连未通」');
  assert.equal(snap.boards.weekly.transport, false, '成功轮不该留着上一轮的传输标记');
  assert.equal(snap.boards.daily.rows.length, 1, '坏轮榜面留在原地，不自我清空');
  assert.equal(snap.boards.daily.at, 5000, 'at = 最后一次成功解析');
  assert.equal(snap.boards.daily.lastFetchAt, 8000, 'lastFetchAt = 最后一次发起请求');
  assert.equal(snap.boards.daily.failStreak, 2);
  assert.equal(snap.boards.monthly.empty, true);
  assert.equal(snap.boards.monthly.ok, true);
});

check('snapshotOf：cadence 与传输提示随快照走，检查服务缺位时如实给 null', async () => {
  const h = await mkApi({ states: { daily: stateRow('daily', [crow('a/1', 1)]) } });
  const bare = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 1,
  });
  assert.equal(bare.cadence, null, '没装配检查服务 ⇒ 不许编一个「下次自动检查」时刻');
  assert.equal(bare.transportHint, TRANSPORT_HINT, '文案单点在 lib/domain.js，界面只搬运');

  const cadence = { intervalMin: 180, effectiveMs: 14400000, backoffExp: 2, nextCheckAt: 99000, fetchAttempts: FETCH_ATTEMPTS };
  const withCheck = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 1, check: { run: async () => ({}), cadence },
  });
  assert.equal(withCheck.cadence, cadence, '快照原样转出去，不重新拼一份');
});

check('snapshotOf：net 与 transportHint 说的是最近那一发的实话（经代理 / 没出网 / 还没出过网）', async () => {
  const h = await mkApi({
    route: { via: 'proxy', source: 'registry', proxy: 'http://127.0.0.1:7897', reason: '', targetHost: 'github.com', at: 4321 },
  });
  let snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 1, getTransportRoute: h.__getRoute,
  });
  assert.deepEqual([snap.net.via, snap.net.viaLabel, snap.net.source], ['proxy', '代理隧道', 'registry']);
  assert.deepEqual([snap.net.sourceLabel, snap.net.text], ['Windows 系统代理', '代理隧道 · Windows 系统代理 · http://127.0.0.1:7897'],
    '整句话在宿主拼好，客户端只搬字');
  assert.equal(snap.net.status, 'idle', '一台没跑过检查的机器：路刚定下来，还没有成败可说');
  assert.equal(snap.net.proxy, 'http://127.0.0.1:7897');
  assert.match(snap.transportHint, /本轮经代理 http:\/\/127\.0\.0\.1:7897 取 github\.com 未通/);

  h.__routeRef.current = { via: 'failed', source: 'custom', reason: '自定义代理地址不可用：缺端口', proxy: null };
  snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 1, getTransportRoute: h.__getRoute,
  });
  assert.equal(snap.net.viaLabel, '没能出网');
  assert.equal(snap.net.text, '没能出网 · 设置页的自定义地址 · 自定义代理地址不可用：缺端口',
    '没出网这一档，原因就是这一行要说的全部，别让它只活在 tooltip 里');
  assert.match(snap.transportHint, /本轮没有出网：自定义代理地址不可用：缺端口/);

  const bare = await mkApi();
  const none = await snapshotOf({
    stateStore: bare.__stores.state, eventStore: bare.__stores.events, prefsStore: bare.__stores.prefs,
    caps: bare.__caps, now: () => 1, getTransportRoute: bare.__getRoute,
  });
  assert.equal(none.net, null, '还没出过网就如实给 null，界面不编一条传输路径');
  assert.equal(none.transportHint, TRANSPORT_HINT);
});

check('snapshotOf.net.status：这个点是「路通没通」，不是「数据新不新」', async () => {
  const snapWith = async ({ states, route }) => {
    const h = await mkApi({ states, route });
    return snapshotOf({
      stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
      caps: h.__caps, now: () => 1, getTransportRoute: h.__getRoute,
    });
  };
  const proxy = { via: 'proxy', source: 'env:HTTPS_PROXY', proxy: 'http://127.0.0.1:7897', reason: '', targetHost: 'github.com', at: 1 };
  const good = { daily: stateRow('daily', [crow('a/1', 1)]), weekly: stateRow('weekly', [crow('a/1', 1)]), monthly: stateRow('monthly', [crow('a/2', 1)]) };
  assert.equal((await snapWith({ states: good, route: proxy })).net.status, 'ok', '经代理拿到了榜 ⇒ 绿');

  const transportDown = {
    daily: stateRow('daily', [], { ok: false, error: '趋势页请求失败：fetch failed（共尝试 3 次）', transport: true, rows: [] }),
    weekly: stateRow('weekly', [], { ok: false, transport: true, rows: [] }),
    monthly: stateRow('monthly', [], { ok: false, transport: true, rows: [] }),
  };
  assert.equal((await snapWith({ states: transportDown, route: proxy })).net.status, 'err', '三榜全坏且坏因是传输类 ⇒ 这条路没通');

  // 源自己回 500：包发出去了、也答回来了，黑锅不能扣在代理头上（那正是本插件最初把两种故障写成一句话的地方）
  const sourceDown = {
    daily: stateRow('daily', [], { ok: false, error: '趋势页返回 500', transport: false, rows: [] }),
    weekly: stateRow('weekly', [], { ok: false, error: '趋势页返回 500', transport: false, rows: [] }),
    monthly: stateRow('monthly', [], { ok: false, error: '趋势页返回 500', transport: false, rows: [] }),
  };
  assert.equal((await snapWith({ states: sourceDown, route: proxy })).net.status, 'ok');

  assert.equal((await snapWith({ states: good, route: { via: 'failed', source: 'custom', reason: '没给出 host:port' } })).net.status, 'err',
    '配置坏到根本没出网 ⇒ 哪怕榜面还是上次的成功数据也判 err');
  // 只有部分榜坏：另一张榜还拿得到，路就是通的
  assert.equal((await snapWith({ states: { daily: stateRow('daily', [crow('a/1', 1)]), weekly: stateRow('weekly', [], { ok: false, transport: true, rows: [] }) }, route: proxy })).net.status, 'ok');
  // 来源话术：带变量名的 env 键要留住名字，查不到的键原样交回而不是编一个翻译
  assert.deepEqual([(await snapWith({ states: good, route: proxy })).net.sourceLabel,
    (await snapWith({ states: good, route: { ...proxy, source: 'martian' } })).net.sourceLabel,
    (await snapWith({ states: good, route: { ...proxy, source: 'mode:direct', via: 'direct' } })).net.sourceLabel],
  ['环境变量 HTTPS_PROXY', 'martian', '设置页选了直连'],
  '只有 env 这一档带尾巴；mode:direct 整串就是键，别再拼一遍「直连」');
});

check('snapshotOf：存储掉线时如实说「存储不可用」而不是崩', async () => {
  const h = await mkApi({ states: { daily: stateRow('daily', [crow('a/1', 1)]) } });
  await h.__stores.state.close();
  await h.__stores.prefs.close();
  const snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 1,
  });
  assert.equal(snap.storage.available, false);
  assert.equal(snap.boards.daily.hasData, false);
  assert.equal(snap.boards.daily.error, '存储不可用');
  // ★ 期望值 = 出厂值**摘掉全部密钥**那一份：`publicPrefs` 是出网前的那道闸（见下面「密钥不回显」那一发），
  //   密钥清单从 domain 派生（手抄就会漏掉新增那一家 ⇒ 快照里带着密钥穿出去）。
  //   第二十一轮那份清单多了一把 GitHub 令牌，这一发跟着变宽，不新写一条。
  const prefsOut = { ...DEFAULT_PREFS };
  for (const k of PREF_SECRET_KEYS) delete prefsOut[k];
  assert.deepEqual(snap.prefs, prefsOut, 'prefs 读不到要回落出厂值而不是抛');
  for (const k of PREF_SECRET_KEYS) assert.equal(k in snap.prefs, false, `${k} 不许出现在快照里`);
});

/* ---------------- 路由 ---------------- */
check('GET /api/snapshot：200 + {ok:true,data} 信封', async () => {
  const h = await mkApi();
  const { res } = await call(h, get('/api/snapshot'));
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.data.boards.daily);
});

check('GET /api/events：limit 与 board 从 query 里取，非法值回落而不是空表', async () => {
  const h = await mkApi({
    events: [
      { kind: 'board_enter', board: 'daily', repo: 'a/1', detail: '第 1 名' },
      { kind: 'board_exit', board: 'weekly', repo: 'b/1', detail: '原第 2 名' },
      { kind: 'rising_cross', repo: 'c/1', detail: '同时上榜 2 张' },
    ],
  });
  const all = (await call(h, get('/api/events'))).res.json();
  assert.equal(all.data.events.length, 3);
  const one = (await call(h, get('/api/events?limit=1'))).res.json();
  assert.equal(one.data.events.length, 1);
  const daily = (await call(h, get('/api/events?board=daily'))).res.json();
  assert.deepEqual(daily.data.events.map((e) => e.repo), ['a/1']);
  const bogus = (await call(h, get('/api/events?board=yearly&limit=abc'))).res.json();
  assert.equal(bogus.data.events.length, 3, '非法过滤条件当"不过滤"，不静默返回空表');
});

check('POST /api/check：body 从流里拼出来（宿主只传两个参数）', async () => {
  let seenTrigger;
  const h = await mkApi({
    checkImpl: {
      run: async (o) => { seenTrigger = o.trigger; return { at: 1, produced: {}, anyOk: true }; },
      checkLanguage: async () => ({ status: 'boarded', slug: '' }),
    },
  });
  const { res } = await call(h, post('/api/check', {}));   // 只给流式 req，不给 bodyArg
  assert.equal(res.statusCode, 200);
  assert.equal(seenTrigger, 'manual', 'trigger 必须由 api 层写死为 manual，不吃请求体');
  assert.equal(res.json().data.at, 1);
});

check('POST /api/check：忙时 409 + CHECK_BUSY（不是 500）', async () => {
  const h = await mkApi({
    checkImpl: {
      run: async () => { throw Object.assign(new Error('已有一轮检查在跑，等它结束'), { code: 'CHECK_BUSY' }); },
      checkLanguage: async () => ({ status: 'boarded', slug: '' }),
    },
  });
  const { res } = await call(h, post('/api/check', {}));
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'CHECK_BUSY');
});

check('POST /api/prefs：只认已知键，多余键不进库', async () => {
  const h = await mkApi();
  const { res } = await call(h, post('/api/prefs', { topN: 20, hacker: 'DROP TABLE', language: '' }));
  assert.equal(res.statusCode, 200);
  const saved = res.json().data;
  assert.equal(saved.topN, 20);
  assert.equal('hacker' in saved, false);
  const back = await h.__stores.prefs.read();
  assert.equal(back.topN, 20);
  assert.equal(back.intervalMin, DEFAULT_PREFS.intervalMin, '没发的键保持原值（读-并-写整行）');
});

check('POST /api/prefs：改间隔后必须回调 onPrefsChanged（节拍跟着偏好走）', async () => {
  const h = await mkApi();
  await call(h, post('/api/prefs', { intervalMin: 720 }));
  assert.equal(h.__prefsChanged.n, 1);
  await call(h, post('/api/prefs', { topN: 21 }));
  assert.equal(h.__prefsChanged.n, 2);
});

check('POST /api/prefs：语言就地验证四档，unknown / fetch-failed 一律 400 不入库', async () => {
  const h = await mkApi();
  const okRust = await call(h, post('/api/prefs', { language: 'rust' }));
  assert.equal(okRust.res.statusCode, 200);
  assert.equal((await h.__stores.prefs.read()).language, 'rust');

  const unknown = await call(h, post('/api/prefs', { language: 'jolang' }));
  assert.equal(unknown.res.statusCode, 400);
  assert.equal(unknown.res.json().error.code, 'INVALID_PARAM');
  assert.match(unknown.res.json().error.message, /GitHub 不认识语言/);
  assert.equal((await h.__stores.prefs.read()).language, 'rust', '验不过就不许把脏 slug 写进库');

  const down = await call(h, post('/api/prefs', { language: 'down' }));
  assert.equal(down.res.statusCode, 400);
  assert.match(down.res.json().error.message, /没能打开趋势页/);

  const cleared = await call(h, post('/api/prefs', { language: '' }));
  assert.equal(cleared.res.statusCode, 200);
  assert.equal((await h.__stores.prefs.read()).language, '', '清空 = 回到全站，不碰网');
});

check('POST /api/prefs：代理模式与地址各拦一遍，custom 没地址当场拒，坏地址进不了库', async () => {
  const h = await mkApi();
  const badMode = await call(h, post('/api/prefs', { proxyMode: 'vpn' }));
  assert.equal(badMode.res.statusCode, 400);
  assert.match(badMode.res.json().error.message, /system \| custom \| direct/);

  const badUrl = await call(h, post('/api/prefs', { proxyUrl: '127.0.0.1' }));
  assert.equal(badUrl.res.statusCode, 400);
  assert.match(badUrl.res.json().error.message, /缺端口/);
  assert.equal((await h.__stores.prefs.read()).proxyUrl, DEFAULT_PREFS.proxyUrl, '拦下来就不许进库');
  assert.equal(h.__prefsChanged.n, 0, '没存进去就不该回调传输层作废缓存');

  const longUrl = await call(h, post('/api/prefs', { proxyUrl: `http://${'a'.repeat(300)}:8080` }));
  assert.equal(longUrl.res.statusCode, 400);
  assert.match(longUrl.res.json().error.message, /过长/, '超长是拒收不是截断——截断会把粘错的整段 PAC 变成一个看着能用的假地址');

  const customNoAddr = await call(h, post('/api/prefs', { proxyMode: 'custom' }));
  assert.equal(customNoAddr.res.statusCode, 400);
  assert.match(customNoAddr.res.json().error.message, /自定义地址/);

  const socks = await call(h, post('/api/prefs', { proxyUrl: 'socks5://127.0.0.1:1080' }));
  assert.equal(socks.res.statusCode, 400);
  assert.match(socks.res.json().error.message, /只支持 http/);

  const ok = await call(h, post('/api/prefs', { proxyMode: 'custom', proxyUrl: '127.0.0.1:7897' }));
  assert.equal(ok.res.statusCode, 200);
  const saved = await h.__stores.prefs.read();
  assert.deepEqual([saved.proxyMode, saved.proxyUrl], ['custom', '127.0.0.1:7897']);
  assert.equal(h.__prefsChanged.n, 1, '存成功要回调（传输层据此立刻重读代理）');

  const backToSystem = await call(h, post('/api/prefs', { proxyMode: 'system' }));
  assert.equal(backToSystem.res.statusCode, 200, '从 custom 切回 system 不该因为库里还留着旧地址而报错');
});

check('POST /api/prefs：形状不合法的 slug 连验都不验（不拼进 URL）', async () => {
  let langChecks = 0;
  const h = await mkApi({
    checkImpl: {
      run: async () => ({ at: 1 }),
      checkLanguage: async () => { langChecks += 1; return { status: 'boarded', slug: 'x' }; },
    },
  });
  const { res } = await call(h, post('/api/prefs', { language: 'c++' }));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /形状不合法/);
  assert.equal(langChecks, 0);
});

check('POST /api/prefs：非法数值由仓储钳回区间（界面拿到的永远是可用值）', async () => {
  const h = await mkApi();
  const { res } = await call(h, post('/api/prefs', { topN: 9999, keepEvents: 1, intervalMin: 5 }));
  const saved = res.json().data;
  assert.equal(saved.topN, 25);
  assert.equal(saved.keepEvents, 50);
  assert.equal(saved.intervalMin, DEFAULT_PREFS.intervalMin);
});

check('★ POST /api/prefs：详情缓存档（第十二轮）撤销后，那一格走白名单丢弃 —— 不 400、不入库、不回显', async () => {
  const h = await mkApi();
  // 为什么不报 400（第十二轮那一路报）：这一格什么都不决定，脏值不会改变出网对象；
  //   而 `translateEngine` 的脏值会决定往哪个域名发 ⇒ 那一格必须当场拒。撤档以后重发它是"旧面板的肌肉记忆"，
  //   给 400 等于让用户的保存按钮凭空失败。
  const { res } = await call(h, post('/api/prefs', { repoCacheHours: 6 }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  assert.equal('repoCacheHours' in res.json().data, false, '回执里还带着那一格 ⇒ 界面能读到一个设置页摆不出来的档位');
  assert.equal('repoCacheHours' in (await h.__stores.prefs.read()), false, '白名单没拦住 ⇒ 库里攒了一条没有出头的键');

  // 只发这一格 = 空 patch：别的键一个字不许被动（同 10-09 那条"读-并-写整行"的律）
  const before = await h.__stores.prefs.read();
  await call(h, post('/api/prefs', { repoCacheHours: 72, intervalMin: before.intervalMin }));
  const after = await h.__stores.prefs.read();
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '撤档之后补丁的键集不该凭多空出一格');
  assert.equal(after.topN, before.topN, '带一个不认的键就把别的值一起改了');
});

/* ---------------- 闸门与错误翻译 ---------------- */
check('回环闸门：写操作与花配额的详情读都闸；纯读面板的 GET 从别机也能看（排障要用）', async () => {
  const h = await mkApi();
  const lan = { remoteAddress: '192.168.1.20' };
  const blocked = await call(h, post('/api/check', {}, lan));
  assert.equal(blocked.res.statusCode, 403);
  assert.equal(blocked.res.json().error.code, 'FORBIDDEN');
  const allowed = await call(h, get('/api/snapshot', lan));
  assert.equal(allowed.res.statusCode, 200);
  const repoBlocked = await call(h, get('/api/repo?name=a/b', lan));
  assert.equal(repoBlocked.res.statusCode, 403);
  assert.match(repoBlocked.res.json().error.message, /配额/);
  const eventsFromLan = await call(h, get('/api/events', lan));
  assert.equal(eventsFromLan.res.statusCode, 200, '别机看流水不花配额，不该闸');
});

/* ---------------- 仓库详情 GET ---------------- */
const repoViewStub = (name) => repoView({ ok: true, repo: name, desc: 'Next gen tooling', lang: 'TypeScript', stars: 10 }, { rate: { left: 57, resetAt: 1 } });

check('GET /api/repo：?name 透给详情服务，载荷原样交回（视图不在 api 层再拼一遍）', async () => {
  const calls = [];
  const h = await mkApi({ repoService: { load: async (name, opt) => { calls.push({ name, opt }); return repoViewStub(name); }, rate: () => ({ limit: 60, left: null, resetAt: 0 }) } });
  const { res } = await call(h, get('/api/repo?name=Vitejs/Vite'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().data.repo, 'Vitejs/Vite');
  // ★ 段表由详情服务拼好、api 层原样交回：这一屏在门面里被重拼过一次的话，改字段就得改两处
  assert.equal(JSON.stringify(res.json().data.sections), JSON.stringify(repoViewStub('Vitejs/Vite').sections));
  assert.deepEqual(calls, [{ name: 'Vitejs/Vite', opt: { refresh: false } }]);
});

check('GET /api/repo：refresh=1 / true 才转成重取，其他写法一律按缓存优先', async () => {
  for (const [q, want] of [['refresh=1', true], ['refresh=true', true], ['refresh=TRUE', true], ['refresh=0', false], ['refresh=yes', false], ['', false]]) {
    const seen = [];
    const h = await mkApi({ repoService: { load: async (name, opt) => { seen.push(opt.refresh); return repoViewStub(name); } } });
    await call(h, get(`/api/repo?name=a/b${q ? `&${q}` : ''}`));
    assert.equal(seen[0], want, `?${q || '（不带 refresh）'} ⇒ ${want}`);
  }
});

check('GET /api/repo：缺 name 是 400，不拿空串去打接口；服务没装配是 501（不是 500 也不是空面）', async () => {
  const h = await mkApi({ repoService: { load: async () => { throw new Error('不该被调用'); } } });
  const missing = await call(h, get('/api/repo'));
  assert.equal(missing.res.statusCode, 400);
  assert.equal(missing.res.json().error.code, 'INVALID_PARAM');
  const blank = await call(h, get('/api/repo?name=%20%20'));
  assert.equal(blank.res.statusCode, 400, '全是空格的 name 也算没给');

  const noSvc = await mkApi();
  const notAssembled = await call(noSvc, get('/api/repo?name=a/b'));
  assert.equal(notAssembled.res.statusCode, 501);
  assert.equal(notAssembled.res.json().error.code, 'GHT_RECORDS_UNAVAILABLE');
});

check('GET /api/repo：详情服务报的坏名字不升级为 500 —— 那是用户输入，照 200 给"没出网"这句话', async () => {
  const h = await mkApi({ repoService: { load: async (name) => repoView({ ok: false, repo: name, errKey: 'bad_key', errText: '不像 owner/name', at: 1 }) } });
  const { res } = await call(h, get('/api/repo?name=oops'));
  assert.equal(res.statusCode, 200, '取不到详情是这一条的目的没达成，不是接口坏了');
  assert.equal(res.json().data.ok, false);
  assert.equal(res.json().data.errKey, 'bad_key');
  assert.equal(res.json().data.error, REPO_ERROR_LABELS.bad_key, '那句人话来自 domain 一张表，不是 api 层现写');
  assert.deepEqual(res.json().data.sections, [], '坏名字的载荷里一段都不该有（api 层不补话）');
});

check('GET /api/repo：服务抛错按 code 翻成 HTTP（限额/传输这类失败自己带 code 才走 5xx）', async () => {
  const h = await mkApi({ repoService: { load: async () => { throw Object.assign(new Error('存储域坏了'), { code: 'GHT_RECORDS_UNAVAILABLE' }); } } });
  const { res } = await call(h, get('/api/repo?name=a/b'));
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error.code, 'GHT_RECORDS_UNAVAILABLE');
  const plain = await mkApi({ repoService: { load: async () => { throw new Error('没 code 的意外'); } } });
  const r2 = await call(plain, get('/api/repo?name=a/b'));
  assert.equal(r2.res.statusCode, 500);
});

/* ---------------- 详情载荷的现译那一路（attachZh：C 只补 B 没命中的行） ---------------- */

/** 假现译服务：记下每一发的 {repo,kind,text,force}，按需回帧。 */
function mkTranslatorStub({ ok = true, zh = '模型给的中文', at = 7777, note = '', errText = 'provider_error: quota exceeded', enabled = () => true, ready = true, engine = 'host_llm' } = {}) {
  const jobs = [];
  return {
    jobs,
    ready: () => ready,
    kinds: () => [...LLM_KINDS],
    enabled,
    async translate(arg) {
      jobs.push(arg);
      return ok
        ? { ok: true, zh, cached: false, at, label: engineZhLabel(engine, at), stored: true, note: '', errKey: '', errText: '', engine }
        // 形状 = llm.js 里 `fail('error', '<宿主 finish 帧的回执>')` 那一支：note 是库里那句文案，errText 是回执原文，两样都得往载荷走
        : { ok: false, zh: '', cached: false, at: 0, label: '', stored: false, note, errKey: 'error', errText, engine: '' };
    },
  };
}
/** 假「免费/官方」那一路（lib/services/web-translate.js 的同形接口）：★ 返回形状逐格照那一份，含 `engine`。 */
function mkWebStub({ zh = '机器给的中文', engine = 'keyless', at = 7777, enabled, ready = true } = {}) {
  const jobs = [];
  // ★ 第十五轮曾写 `() => ['desc']`（那一档不派摘要）；**第十七轮用户改判放回** ⇒ 两路都报。
  //   真那一路的 `kinds()` 现在就是这两档，`:897` 那条"桩 = 真服务"的对齐判据跟着走。
  const kinds = () => ['desc', 'readme'];
  return {
    jobs,
    ready: () => ready,
    why: () => '',
    currentEngine: () => engine,
    kinds,
    enabled: enabled ?? ((kind) => kinds().includes(kind)),
    async translate(arg) {
      jobs.push(arg);
      // ★ 落款与 `engine` 用**同一个**档名：上一版落款取构造参数、行里那个取 `getPrefs().translateEngine`，
      //   于是「按引擎选路」那一档（prefs=baidu、构造 engine=baidu… 而实现读的是 prefs）拿到「免费接口 · …」的落款 —— 用例当场红。
      //   桩就该只有一处取档名，取的就是它自己塞进行里那一份（真服务从 prefs 现取，那条在 wt 套件钉）。
      return { ok: true, zh, cached: false, at, label: engineZhLabel(engine, at), stored: true, note: '', errKey: '', errText: '', engine };
    },
  };
}
// ★ 载荷必须是**真的 repoView() 出来的形状**（10-06 的教训）：上一版这里手搓 `{ok,repo,desc,narrative,...}`，
//   少了宿主内部那一格 sectionFields，attachZh 重拼段表就得到空话头「仓库没有写描述。」而用例照样绿。
const detailWith = (over = {}) => repoView({ ok: true, repo: 'vitejs/vite', desc: 'Next gen tooling', lang: 'TypeScript', stars: 10, ...over });
/** 段表取字：别在断言里手抄句子，同一份字段先让 repoView 拼一遍。 */
const secOf = (secs, key) => secs?.find((s) => s.key === key);
const secText = (secs, key) => (secOf(secs, key)?.blocks ?? []).map((b) => b.text).join('\n');
/** 没派活时该看到的那一段（= 服务那一层原样交回的 what 段）。 */
const whatOf = (over = {}) => secText(detailWith(over).sections, 'what');

check('attachZh：两个开关全关时那一屏逐字不变 —— 不派活、载荷里 zh 全空、段表不重拼', async () => {
  const stub = mkTranslatorStub({ enabled: () => false });
  // ★ 引擎必须显式指回宿主模型那一档：默认档现在是免费接口，不指的话这个 stub 压根不会被派活，
  //   "开关关着所以零调用"这条判据就成了假绿（零调用是因为没接它，不是因为开关关）。
  const h = await mkApi({ prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => detailWith() }, translator: stub });
  const { res } = await call(h, get('/api/repo?name=vitejs/vite'));
  const d = res.json().data;
  assert.equal(stub.jobs.length, 0, `开关关着却派了 ${stub.jobs.length} 发`);
  assert.deepEqual(d.zh, { builtin: '', descModel: null, descNote: '', descErr: '', summary: null, summaryNote: '', summaryErr: '' });
  assert.equal(JSON.stringify(d.sections), JSON.stringify(detailWith().sections), '没派活就不该重拼段表');
  assert.equal('sectionFields' in d, false, '宿主内部那格不许漏进给客户端的载荷');
});

check('attachZh：B 命中的行不派描述那一路（内置表优先），摘要档各开各的', async () => {
  const [hitKey, hitSrc] = DESC_ZH_ROWS[0];
  // ★ 两档都开：只开 readme 的话，「描述那一发没派」是开关挡的，不是 B 优先挡的 —— 那条判据就成了假绿。
  const stub = mkTranslatorStub({ enabled: () => true });
  const h = await mkApi({
    prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => detailWith({ repo: hitKey, desc: hitSrc, readmeSource: 'en_default', readmeExcerpt: 'an english excerpt' }) },
    translator: stub,
  });
  const d = (await call(h, get(`/api/repo?name=${hitKey}`))).res.json().data;
  assert.deepEqual(stub.jobs.map((j) => j.kind), ['readme'], '描述那一发必须省下来：B 有这句，模型不该再花一次额度');
  assert.equal(d.zh.builtin, d.desc ? descZhFor(hitKey, hitSrc) : '', 'builtin 那一格给的就是内置表那句');
  assert.equal(d.zh.descModel, null);
  const over = { repo: hitKey, desc: hitSrc, readmeSource: 'en_default', readmeExcerpt: 'an english excerpt' };
  assert.equal(secText(d.sections, 'what'), whatOf(over), 'B 命中那一行的描述那句不许被现译口径盖掉（摘要段是另一路，它照常加）');
  assert.ok(!/模型现译|免费接口/.test(secText(d.sections, 'what')), 'B 命中的那一句里不该出现现译落款');
  assert.match(secText(d.sections, 'what'), new RegExp(`中文描述（${DESC_ZH_LABEL}，不是现译）：`));
  assert.equal(d.zh.summary.label, engineZhLabel('host_llm', 7777), '落款跟着这一行的引擎走（夹具那一路是宿主模型）');
});

check('attachZh：描述档只在开关开 + B 没命中 + 确有原文时派；摘要档只认 en_default', async () => {
  const on = (kind) => kind === 'desc';
  const [bHitKey, bHitSrc] = DESC_ZH_ROWS[0];
  for (const [view, want, why] of [
    [detailWith({ desc: '' }), [], '没原文就别派活（界面那边连一句"没译出来"都不该出现；全空白的 desc 由现译层按同一条律折成"没原文"，见 test/llm.test.mjs 的闸门那一发）'],
    [detailWith({ repo: bHitKey, desc: bHitSrc }), [], '内置表就有这一句 ⇒ B 优先，描述这一发压根不派（只开描述档也挡得住）'],
    [detailWith({ desc: 'Next gen tooling' }), ['desc'], '这一发是该派的'],
    [detailWith({ desc: 'Next gen tooling', readmeSource: 'zh_default', readmeExcerpt: '中文正文' }), ['desc'], 'README 本来就是中文 ⇒ 不派摘要（★ 这一档只开描述档，摘要那一路的承重判据在下面 readme-only 那一圈：三档中文各钉一发）'],
    [detailWith({ desc: 'Next gen tooling', readmeSource: 'none' }), ['desc'], '没 README ⇒ 不派摘要'],
    [detailWith({ desc: 'Next gen tooling', readmeSource: 'en_default' }), ['desc'], '英文 README 但节选为空 ⇒ 不派摘要'],
    [detailWith({ desc: '', readmeSource: 'en_default', readmeExcerpt: 'x' }), [], 'desc 为空时只可能派摘要，这里开关只管描述'],
  ]) {
    const stub = mkTranslatorStub({ enabled: on });
    const h = await mkApi({ prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => view }, translator: stub });
    const { res } = await call(h, get('/api/repo?name=vitejs/vite'));
    assert.deepEqual(stub.jobs.map((j) => j.kind), want, `${why}｜实际派了 ${JSON.stringify(stub.jobs.map((j) => j.kind))}`);
    assert.equal(res.statusCode, 200);
  }
  // 摘要档单独走一遍：开 readme、关 desc —— ★ 只有 `en_default` 派，三种「README 有中文」的形状一档都不许派
  const only = mkTranslatorStub({ enabled: (k) => k === 'readme' });
  const h2 = await mkApi({
    prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => detailWith({ desc: 'Next gen tooling', readmeSource: 'en_default', readmeExcerpt: 'an english excerpt' }) },
    translator: only,
  });
  await call(h2, get('/api/repo?name=vitejs/vite'));
  assert.deepEqual(only.jobs.map((j) => j.kind), ['readme']);
  assert.equal(only.jobs[0].text, 'an english excerpt', '摘要档喂的是那段节选，不是整篇 README');
  for (const [src, extra, why] of [
    ['zh_default', { readmeExcerpt: '这份 README 整篇就是中文写的。' }, '默认篇本身就是中文'],
    ['zh_file', { readmePath: 'docs/i18n/README.zh-CN.md', readmeExcerpt: '这份是仓库另写的中文 README。' },
      '默认篇是英文、但抓到了仓库另写的那份中文篇（第十五轮第二路的产物：节选出自那份**中文**正文）'],
    ['zh_section', { readmeSection: '中文说明', readmeExcerpt: '这段是仓库自己写的中文说明。' }, '整篇里嵌着一段达标的中文小节'],
  ]) {
    const stub = mkTranslatorStub({ enabled: (k) => k === 'readme' });
    const hz = await mkApi({
      prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => detailWith({ desc: 'Next gen tooling', readmeSource: src, ...extra }) },
      translator: stub,
    });
    const dz = (await call(hz, get('/api/repo?name=vitejs/vite'))).res.json().data;
    assert.deepEqual(stub.jobs, [], `${why} ⇒ 摘要那一发不派（给一段中文挂「中文摘要」的落款 = 把仓库自己写的话说成模型转述）｜实派 ${JSON.stringify(stub.jobs.map((j) => j.kind))}（${src}）`);
    assert.equal(dz.sections.find((s) => s.key === 'self').label,
      `${REPO_SECTION_LABELS.self} · ${REPO_README_SOURCE_LABELS[src]}${src === 'zh_section' ? '（小节「中文说明」）' : ''}`,
      `段名那句档名跟着 ${src} 走（第十二轮撤了段里那句说明，档名与小节名只剩这一处）`);
  }
});

check('attachZh：第三道闸门（第十九轮）—— `en_default` 但屏上那段已经带着中文 ⇒ 摘要那一发也不派', async () => {
  // 用户裁定（2026-10-07 第十九轮）：「这两种也算有中文」⇒ 中英混排那档、和中文篇在子目录没抓到的那档，
  // 都不许再派摘要。★ 三条各钉在**只开摘要档**的现场上（开两档的话描述那一发会把"没派摘要"圆掉，同第十八轮那条假绿的教训）。
  for (const [excerpt, wantVia, why] of [
    ['Install the CLI. 中文说明：先运行 npm install，再执行 init 命令即可。', 'cjk',
      '中英混排（真机 thedotmack/claude-mem 的形状：节选 9 个 CJK，够不上档名那条 20）'],
    ['English | 中文 | Français — a memory plugin for Claude Code.', 'lang',
      '语言切换行只有两三个字（ant-design 英文篇整篇 2 个 CJK）⇒ 吃「中文」字样这条'],
  ]) {
    const stub = mkTranslatorStub({ enabled: (k) => k === 'readme' });
    const h = await mkApi({
      prefs: { translateEngine: 'host_llm' },
      repoService: { load: async () => detailWith({ desc: 'Next gen tooling', readmeSource: 'en_default', readmeExcerpt: excerpt }) },
      translator: stub,
    });
    const d = (await call(h, get('/api/repo?name=vitejs/vite'))).res.json().data;
    assert.deepEqual(stub.jobs, [], `${why} ⇒ 摘要那一发不派｜实派 ${JSON.stringify(stub.jobs.map((j) => j.kind))}`);
    assert.equal(d.zh.summary, null, '没派活就不该有摘要那一格');
    assert.ok(d.sections.find((s) => s.key === 'self').label.endsWith(README_ZH_GATE_SUFFIXES[wantVia]),
      `闸门命中而段名没跟着说实话（档名仍念「默认 README 是英文」）⇒ 屏上自相矛盾：via=${wantVia}｜${d.sections.find((s) => s.key === 'self').label}`);
  }
});

/**
 * ★ 这一条必须是**独立的一条 check**：同一圈里那两条命中例的断言会先炸，
 *   「误挡日文」这个现场就永远轮不到报红（第十九轮证伪电池第 ③ 条（阈值抬成 1）就是这么漏的）。
 */
check('attachZh：第三道闸门的反面 —— 「日本語」是日文不是中文 ⇒ 那一屏照常被译（不许顺手挡）', async () => {
  // 真机 m-abozaid/esp32-c3-adblock：节选里 3 个 CJK 全是「日本語」那三个字（CJK 计数含假名）。
  // 挡了它就是少做用户在用的那一屏 —— 不是保守，是功能没了。
  const ja = mkTranslatorStub({ enabled: (k) => k === 'readme' });
  const hj = await mkApi({
    prefs: { translateEngine: 'host_llm' },
    repoService: { load: async () => detailWith({ desc: 'Next gen tooling', readmeSource: 'en_default', readmeExcerpt: 'English | 日本語 — blocks ads on an ESP32-C3 dongle.' }) },
    translator: ja,
  });
  const dj = (await call(hj, get('/api/repo?name=vitejs/vite'))).res.json().data;
  assert.deepEqual(ja.jobs.map((j) => j.kind), ['readme'], '纯日文切换行被判成"已有中文"⇒ 那一屏被误挡（少做不是保守，是功能没了）');
  assert.equal(dj.sections.find((s) => s.key === 'self').label,
    `${REPO_SECTION_LABELS.self} · ${REPO_README_SOURCE_LABELS.en_default}`, '没命中的档名一个字都不许多');
});

check('attachZh：第一道闸门 —— 仓库自己写的描述本身就是中文 ⇒ 描述那一发压根不派', async () => {
  // 派出去的是一句中文、回来的还是同一句中文，界面上却挂「中文描述（免费接口 · 某时刻）」—— 那是句假话。
  const zhDesc = '每周更新的技术文章与开源项目推荐，纯人工整理。';
  const stub = mkTranslatorStub({ enabled: () => true, zh: zhDesc });
  const h = await mkApi({
    prefs: { translateEngine: 'host_llm' },
    repoService: { load: async () => detailWith({ desc: zhDesc, descSelfZh: true }) },
    translator: stub,
  });
  const d = (await call(h, get('/api/repo?name=vitejs/vite'))).res.json().data;
  assert.deepEqual(stub.jobs.map((j) => j.kind), [], '自带中文的描述还派了现译');
  assert.equal(d.zh.descModel, null);
  assert.match(secText(d.sections, 'what'), /仓库自己写的描述（这句本身就是中文，没有调用翻译接口）：/);
  // 反向：闸门吃的是宿主算好的那一格，不是描述"看起来像不像中文"—— 没这一格时照派
  const en = mkTranslatorStub({ enabled: () => true });
  const h2 = await mkApi({ prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => detailWith({ desc: 'Next gen tooling' }) }, translator: en });
  await call(h2, get('/api/repo?name=vitejs/vite'));
  assert.deepEqual(en.jobs.map((j) => j.kind), ['desc'], 'descSelfZh 缺位（旧行）时描述档得照常派，闸门不许顺手把英文也挡了');
});

check('attachZh：译文进了段表，来源与时刻由宿主写死（客户端不拼这句）', async () => {
  const stub = mkTranslatorStub({ zh: '下一代前端工具。', at: Date.UTC(2026, 9, 6, 1, 20) });
  const h = await mkApi({ prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => detailWith({ desc: 'Next gen tooling', lang: 'TypeScript', stars: 10 }) }, translator: stub });
  const d = (await call(h, get('/api/repo?name=vitejs/vite'))).res.json().data;
  assert.equal(d.zh.descModel.zh, '下一代前端工具。');
  const what = secText(d.sections, 'what');
  assert.match(what, /这是一个用 TypeScript 写的项目。/, '重拼不许把语言那一格丢掉');
  assert.ok(what.includes('中文描述（模型现译 · 10-06 09:20）：下一代前端工具。'), what);
  assert.ok(what.includes('仓库自己写的描述（原文）：Next gen tooling'), '译文是加出来的，不是把原文换掉的');
  assert.doesNotMatch(what, /未翻译/, '给了译文还留着"未翻译"那句话');
  // ★ 数字归 heat 段：what 段不许再念一遍星标（同屏两份影子是用户立过的那条律）
  assert.doesNotMatch(what, /10 星|累计/);
  assert.deepEqual(secOf(d.sections, 'heat')?.facts?.map((f) => f.value), ['10']);
});

check('attachZh：现译失败只换那一格，详情整页与原文照给，且把那句原因带给界面', async () => {
  const stub = mkTranslatorStub({ ok: false, note: '模型这一发超时了，原文照给', errText: 'AbortError: 8000ms 到点', enabled: () => true });
  const h = await mkApi({ prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => detailWith({ desc: 'Next gen tooling' }) }, translator: stub });
  const d = (await call(h, get('/api/repo?name=vitejs/vite'))).res.json().data;
  assert.equal(d.ok, true, '模型失败不该把详情整页打挂');
  assert.equal(d.zh.descModel, null);
  assert.equal(d.zh.descNote, '模型这一发超时了，原文照给');
  assert.equal(d.zh.descErr, 'AbortError: 8000ms 到点', '那句 note 承诺的是「宿主在 finish 帧里给的回执」⇒ 回执必须一路带到载荷，段里才有东西可念');
  const what = secText(d.sections, 'what');
  assert.match(what, /仓库自己写的描述（原文，未翻译）：Next gen tooling/, '失败那一行不许顺手把"未翻译"改成别的口径');
  assert.deepEqual(secOf(d.sections, 'what').blocks.slice(-2), [
    { kind: 'sub', text: '模型这一发超时了，原文照给' },
    { kind: 'num', text: '回执：AbortError: 8000ms 到点' },
  ]);
});

check('attachZh：ok:false 的详情不派活（连"不像 owner/name"这种坏名字也不会去喂模型）', async () => {
  const stub = mkTranslatorStub({ enabled: () => true });
  const h = await mkApi({ prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => repoView({ ok: false, repo: 'oops', desc: 'x', errKey: 'bad_key', at: 1 }) }, translator: stub });
  const d = (await call(h, get('/api/repo?name=oops'))).res.json().data;
  assert.equal(stub.jobs.length, 0);
  assert.equal(d.zh.builtin, '', '没取到详情就不给"命中"这种假信号');
  assert.deepEqual(d.sections, [], '失败行不给段表');
});

check('attachZh：?refresh=1 把 force 传到现译层（用户点「重新取一次」就是要新答案）', async () => {
  const stub = mkTranslatorStub({ enabled: () => true });
  const seen = [];
  const h = await mkApi({
    prefs: { translateEngine: 'host_llm' }, repoService: { load: async (name, opt) => { seen.push(opt.refresh); return detailWith({ desc: 'Next gen tooling' }); } },
    translator: stub,
  });
  await call(h, get('/api/repo?name=vitejs/vite'));
  assert.equal(stub.jobs[0].force, false);
  await call(h, get('/api/repo?name=vitejs/vite&refresh=1'));
  assert.equal(stub.jobs[1].force, true);
  assert.deepEqual(seen, [false, true], 'force 得同时绕开详情缓存与译文缓存，别只绕一半');
});

check('attachZh：没装配现译服务（旧宿主 / 装配失败）时详情照给，zh 那一格是全空而不是缺键', async () => {
  const h = await mkApi({ prefs: { translateEngine: 'host_llm' }, repoService: { load: async () => detailWith({ desc: 'Next gen tooling' }) } });
  const d = (await call(h, get('/api/repo?name=vitejs/vite'))).res.json().data;
  assert.equal(JSON.stringify(d.sections), JSON.stringify(detailWith({ desc: 'Next gen tooling' }).sections), '没装配现译 ⇒ 那一屏逐字是详情服务拼出来的原样');
  assert.equal('sectionFields' in d, false, 'sectionFields 是宿主内部重拼用的那一格，不许漏进给客户端的载荷');
  assert.deepEqual(Object.keys(d.zh).sort(), ['builtin', 'descErr', 'descModel', 'descNote', 'summary', 'summaryErr', 'summaryNote']);
  assert.equal(d.zh.descModel, null);
});

check('快照 translator 视图：键恒在，开关行清单/状态读的是库里那份，note / 标签 / 没就绪那句全部来自 domain', async () => {
  const stub = mkTranslatorStub({ ready: false, enabled: () => false });
  const h = await mkApi({ prefs: { translateEngine: 'host_llm', llmDesc: true, llmReadme: false }, translator: stub });
  const snap = await snapshotOf({
    stateStore: h.__stores.state, eventStore: h.__stores.events, prefsStore: h.__stores.prefs,
    caps: h.__caps, now: () => 7777, translator: stub,
  });
  assert.deepEqual(Object.keys(snap.translator).sort(), [
    'credFields', 'credNote', 'credStored', 'engine', 'engineHint', 'engineLabels', 'engines',
    'notReadyHint', 'note', 'ready', 'register', 'secretSavedHint', 'switchRows',
  ].sort());
  assert.equal(snap.translator.ready, false, 'ready 说的是这一档发不发得出，不是开关开没开');
  // ★ 第十五轮：两行开关并成一张表（行名 / 说明句 / 开没开都在行里），旧的 `descOn` / `readmeOn` / `switchLabels` 三格整格撤
  assert.deepEqual(snap.translator.switchRows, [
    { key: 'llmDesc', kind: 'desc', row: '描述现译', label: LLM_SWITCH_LABELS.llmDesc, on: true },
    { key: 'llmReadme', kind: 'readme', row: '摘要现译', label: LLM_SWITCH_LABELS.llmReadme, on: false },
  ], '开关状态取自库里那份（prefs.patch 过 true），不是 spy 的默认值；行序就是 LLM_SWITCHES 那份');
  assert.deepEqual(snap.translator.switchRows.map((r) => r.key), LLM_SWITCHES.map((s) => s.key), '行清单与行名以 domain 为准，用例不手抄');
  assert.equal(snap.translator.note, TRANSLATE_COMMON_NOTE);
  assert.equal(snap.translator.notReadyHint, LLM_NOT_READY_HINT);
  // ★ 五档的名单与档名由 domain 给（`hc-7` 那条一份真相的律）：界面排表就是排这个数组，不自己抄五份
  assert.deepEqual(snap.translator.engines, TRANSLATE_ENGINES);
  assert.deepEqual(snap.translator.engineLabels, TRANSLATE_ENGINE_LABELS);
  assert.equal(snap.translator.engine, 'host_llm');
  // 宿主模型与免费接口那两档不吃凭据 ⇒ 连输入框都不摆（`credFields` 空表就是界面渲染的依据）
  assert.deepEqual(snap.translator.credFields, []);
  assert.equal(snap.translator.credStored, false);
  assert.equal(snap.translator.register, null, '没有"去哪注册"这一说的一档不该给外链');
  assert.equal(snap.translator.engineHint, TRANSLATE_ENGINE_HINTS.host_llm);
  assert.equal(snap.translator.credNote, TRANSLATE_CRED_NOTE);
  assert.equal(snap.translator.secretSavedHint, SECRET_SAVED_HINT);
});

/**
 * ★ 第十七轮（用户改判第十五轮③「非 host_llm 不派摘要」）新增的一条：
 *   开关行**回到五档**之后，"这一段是什么"这句措辞是仅剩的说实话那道口 —— 所以两头都钉：
 *   翻译四档那一行念「节译」（不给用户挂假名），宿主模型那一行仍念「摘要」（不把真摘要说矮）。
 */
check('switchRows 那句说明跟着档位走：四档翻译路念「节译」，只有宿主模型那档念「摘要」（第十七轮）', async () => {
  const web = { ready: () => true, why: () => '', currentEngine: () => 'keyless',
    kinds: () => ['desc', 'readme'], enabled: () => true, translate: async () => ({ ok: true }) };
  for (const engine of TRANSLATE_ENGINES.filter((e) => e !== 'host_llm')) {
    const v = translatorView({ webTranslator: web }, { translateEngine: engine, llmDesc: true, llmReadme: true });
    assert.deepEqual(v.switchRows.map((r) => r.key), ['llmDesc', 'llmReadme'], `${engine}：两行开关都该在（第十七轮放回的就是这一行）`);
    const readme = v.switchRows.find((r) => r.key === 'llmReadme');
    assert.equal(readme.label, LLM_README_LABEL_TRANSLATE, `${engine}：那一行的说明句没跟着档位 → ${readme.label}`);
    assert.equal(readme.row, '摘要现译', '行名不跟着变（用户要放回的就是叫这个名字的那一行），"是什么"由上面那句说明说');
    assert.equal(v.switchRows.find((r) => r.key === 'llmDesc').label, LLM_SWITCH_LABELS.llmDesc, `${engine}：描述那行不该被摘要那句带跑`);
  }
  const host = translatorView({ translator: { ready: () => true, kinds: () => ['desc', 'readme'], enabled: () => true } },
    { translateEngine: 'host_llm', llmDesc: true, llmReadme: true });
  assert.equal(host.switchRows.find((r) => r.key === 'llmReadme').label, LLM_SWITCH_LABELS.llmReadme, '宿主模型那一档给的是摘要，那句得改回来');
  // 反向那头：那一行压根不摆的情况只剩"服务没声明能力"（旧宿主 / 装配失败），不再按档位砍行
  assert.deepEqual(translatorView({ webTranslator: { ready: () => true, why: () => '' } },
    { translateEngine: 'keyless', llmDesc: true, llmReadme: true }).switchRows, [],
    '服务没声明 kinds() ⇒ 一行都不摆（不许宿主替服务猜能力），但这与档位无关');
});

check('translator 视图逐档说话：免费档缺代理与官方档缺凭据是两句不同的话（不许并成一句「翻译没就绪」）', async () => {
  const base = { llmDesc: true, llmReadme: false };
  // ① 免费档 + 传输层没通（web-translate 的 why 给 transport）
  const noNet = { ready: () => false, why: () => 'transport' };
  assert.equal(translatorView({ webTranslator: noNet }, { ...base, translateEngine: 'keyless' }).notReadyHint,
    TRANS_ERROR_LABELS.transport);
  // ② 三家官方档 + 没凭据 ⇒ 必须是那句"去设置页填"，而不是"连不上"
  const noCred = { ready: () => false, why: () => 'no_credential' };
  for (const engine of Object.keys(TRANSLATE_CRED_FIELDS)) {
    const v = translatorView({ webTranslator: noCred }, { ...base, translateEngine: engine });
    assert.equal(v.notReadyHint, TRANS_ERROR_LABELS.no_credential, `${engine} 那句原因说错了档`);
    assert.equal(v.engine, engine);
    assert.equal(v.engineHint, TRANSLATE_ENGINE_HINTS[engine], `${engine} 这一档是什么、吃不吃代理由 domain 说`);
    // ③ 界面要画的那几格：键、标签、是不是密钥、长度上限，一格一格与 domain 的字段表对齐（客户端不排表）
    assert.deepEqual(v.credFields.map((f) => f.key), credFieldsOf(engine).map((f) => f.key), `${engine}：凭据格的顺序与键名不一致`);
    assert.deepEqual(v.credFields.map((f) => [f.label, f.secret, f.maxLength]),
      TRANSLATE_CRED_FIELDS[engine].map((f) => [f.label, f.secret === true, f.maxLength]), `${engine}：格子的标签或上限与 domain 不一致`);
    assert.deepEqual(v.register, TRANSLATE_REGISTER[engine], `${engine}：「去哪注册拿 key」那一行是给用户看的，缺了就没法填`);
    assert.ok(v.register.links.length >= 1 && v.register.links.every((l) => /^https:\/\//.test(l.url)), `${engine}：注册地址要是 https 外链`);
    for (const f of v.credFields) assert.equal(f.has, false, `${engine}/${f.key}：库里没值却说"已存"`);
    assert.equal(v.credStored, false, '库里没值 ⇒ 这一位必须是 false');
    assert.equal(JSON.stringify(v).includes('no_credential'), false, '视图里不许漏内部档位键（界面只念 note 那句）');
  }
  // ④ 库里存了三家的凭据：每一档的视图只摆**自己那两格**，而且密钥本体一个字节都不出现（唯一痕迹是 has 布尔）
  const withCred = { ready: () => true, why: () => '' };
  const prefsAll = { ...base, baiduAppid: '2026x', baiduKey: 'sekret-bd', tencentSecretId: 'AKIDtc', tencentSecretKey: 'sekret-tc', aliyunAccessKeyId: 'LTAI', aliyunAccessKeySecret: 'sekret-ali' };
  for (const engine of Object.keys(TRANSLATE_CRED_FIELDS)) {
    const v = translatorView({ webTranslator: withCred }, { ...prefsAll, translateEngine: engine });
    assert.equal(v.ready, true);
    assert.equal(v.credStored, true, `${engine}：密钥没落进视图的 has 位 ⇒ 界面上看不出"已经填过"`);
    assert.deepEqual(v.credFields.filter((f) => f.secret).map((f) => f.has), [true], `${engine}：密钥那一格的 has 位不对`);
    assert.deepEqual(v.credFields.filter((f) => !f.secret).map((f) => f.has), [true], `${engine}：标识符那一格的 has 位不对`);
    for (const f of v.credFields) assert.equal('value' in f, false, `${engine}/${f.key}：视图里出现 value 位就是准备回显`);
    const text = JSON.stringify(v);
    for (const k of ['baiduKey', 'tencentSecretKey', 'aliyunAccessKeySecret']) {
      assert.equal(text.includes(prefsAll[k]), false, `${engine} 的视图里漏出了 ${k} 本体`);
    }
    // 标识符也不许多一处出口：它本来就在 prefs 里，视图只给 has 位
    for (const k of ['baiduAppid', 'tencentSecretId', 'aliyunAccessKeyId']) {
      assert.equal(text.includes(prefsAll[k]), false, `${engine} 的视图里出现了 ${k}（一个值不许有两处出口）`);
    }
  }
  // ⑤ 免费与宿主模型那两档不给"去哪注册"：它们不需要注册，摆出来就是多一行没人点的话
  assert.equal(translatorView({ webTranslator: withCred }, { ...prefsAll, translateEngine: 'keyless' }).credFields.length, 0);
  assert.equal(translatorView({ translator: withCred }, { ...prefsAll, translateEngine: 'host_llm' }).register, null);
  // ⑥ 脏值与缺档一律回落出厂那档（免费接口），不猜用户想要哪一路；旧档名 official 搬家到百度
  assert.equal(translatorView({ webTranslator: noNet }, { ...base, translateEngine: 'deepl' }).engine, DEFAULT_TRANSLATE_ENGINE);
  assert.equal(translatorView({ webTranslator: noNet }, { ...base }).engine, DEFAULT_TRANSLATE_ENGINE);
  assert.equal(translatorView({ webTranslator: noCred }, { ...base, translateEngine: 'official' }).engine, 'baidu',
    '库里第九轮存的旧档名要搬家，不能被当成脏值抹回出厂档');
  // ⑦ 这一档压根没装配（裸宿主 / 装配失败）：说"连不上"是冤枉，给一句能行动的
  assert.equal(translatorView({}, { ...base, translateEngine: 'keyless' }).notReadyHint, TRANS_ERROR_LABELS.transport);
});

check('现译派活按引擎选路：五档各自只派一路，没选中的那一路连 enabled 都不问（用户裁定「二选一」+「分段器并排五档」）', async () => {
  const view = () => detailWith({ desc: 'Next gen tooling', readmeSource: 'en_default', readmeExcerpt: 'an english excerpt' });
  // ★ 没选中的那一路把 `enabled` 换成"一问就抛"：attachZh 的闸门顺序是 先问开关 → 再派活，
  //   所以这一抛证的是"连开关都没问"，比事后数 jobs 更硬（jobs 为 0 也可能只是开关返回了 false）。
  const refuse = () => { throw new Error('没选中的那一路不该被问开关'); };
  for (const engine of TRANSLATE_ENGINES) {
    const llm = mkTranslatorStub({ engine: 'host_llm', enabled: engine === 'host_llm' ? () => true : refuse });
    const web = mkWebStub({ zh: '机器给的中文', engine, enabled: engine === 'host_llm' ? refuse : undefined });
    const h = await mkApi({ prefs: { translateEngine: engine, llmDesc: true, llmReadme: true }, repoService: { load: async () => view() }, translator: llm, webTranslator: web });
    const d = (await call(h, get('/api/repo?name=vitejs/vite'))).res.json().data;
    // ★ 第十五轮曾按档位分"两路 / 只一路"；**第十七轮用户改判放回** ⇒ 五档都派两发（描述 + 摘要那一路）。
    //   钉的仍是老的那条：没选中的那一路连 enabled 都不问（refuse 那一抛）。
    const wantKinds = ['desc', 'readme'];
    if (engine === 'host_llm') {
      assert.equal(web.jobs.length, 0, `${engine} 档却派给了免费/官方那一路`);
      assert.deepEqual(llm.jobs.map((j) => j.kind).sort(), wantKinds);
      assert.equal(d.zh.descModel.engine, 'host_llm');
    } else {
      assert.equal(llm.jobs.length, 0, `${engine} 档却碰了宿主模型句柄（「句柄只许一个使用者」那条律）`);
      assert.deepEqual(web.jobs.map((j) => j.kind).sort(), wantKinds,
        `${engine} 档少派了一发：放回后这一档两路都要派（描述 + 节选译中文）`);
      assert.equal(d.zh.descModel.engine, engine);
    }
    // 落款跟着**这一行的引擎**走（档名从 domain 那张表取，用例不手抄五份）
    assert.match(d.zh.descModel.label, new RegExp(`^${ENGINE_LABEL_ZH[engine]} ·`), `${engine} 的落款档名不对`);
    // ★ 第十二轮（四段来源落款全撤）：摘要载荷不再有 `note` 那句说明，"是谁译的"只剩段名那一份。
    //   这一发钉的是**换档之后段名跟着那一行**，不是跟着当前设置。
    //   ★ 第十七轮：段名的**词**跟着档位走 —— 宿主模型那档叫「中文摘要」，翻译四档叫「中文节译」（放回来但不挂假名）。
    const sum = d.sections.find((s) => s.key === 'summary');
    const word = engine === 'host_llm' ? REPO_SECTION_LABELS.summary : REPO_SECTION_LABELS.summaryTranslate;
    assert.equal('note' in d.zh.summary, false, `${engine} 档的摘要载荷还带着那句说明`);
    assert.match(sum.label, new RegExp(`^${word} · ${ENGINE_LABEL_ZH[engine]} ·`), `${engine} 档的摘要段名：词或档名不对 → ${sum?.label}`);
  }
});

check('假那两路桩的能力声明 = 真服务的声明（形状不对齐时，派活判据测的是桩不是闸门）', async () => {
  const real = createWebTranslator({ getPrefs: () => ({ ...DEFAULT_PREFS, llmDesc: true, llmReadme: true }) });
  assert.deepEqual(mkWebStub({}).kinds(), real.kinds(), '假免费那一路如果哪天"什么都能译"，上面那条选路判据就测不到真闸门');
  // ★ 第十七轮放回：真那一路两档都 serve，摘要那一发**只**照 llmReadme 这一个开关（能力声明不再挡它）。
  assert.equal(real.enabled('readme'), true, '上面那份 prefs 是 llmReadme:true ⇒ 开着就该放行（第十五轮那道能力闸门已经撤走）');
  assert.equal(real.enabled('desc'), true);
  assert.equal(createWebTranslator({ getPrefs: () => ({ ...DEFAULT_PREFS, llmDesc: true, llmReadme: false }) }).enabled('readme'), false,
    '开关关着 ⇒ 不派：放回的是能力，不是自动派活');
});

check('库里没 translateEngine 这一格（第九轮之前存的库）：按出厂那档派活，不整屏报错', async () => {
  const web = mkWebStub({ zh: '免费接口给的中文', engine: DEFAULT_TRANSLATE_ENGINE });
  const llm = mkTranslatorStub({ enabled: () => { throw new Error('出厂那档是免费接口，不该碰宿主模型句柄'); } });
  const h = await mkApi({ repoService: { load: async () => detailWith({ desc: 'Next gen tooling' }) }, translator: llm, webTranslator: web });
  const d = (await call(h, get('/api/repo?name=vitejs/vite'))).res.json().data;
  assert.deepEqual(web.jobs.map((j) => j.kind), ['desc'], '缺档要真的派到免费那一路，而不是"谁也没派"这种假绿');
  assert.equal(d.zh.descModel.engine, DEFAULT_TRANSLATE_ENGINE);
  assert.equal(translatorView({ translator: mkTranslatorStub({}), webTranslator: null }, { translateEngine: undefined }).engine, DEFAULT_TRANSLATE_ENGINE);
});

check('密钥不回显：四把密钥 POST 进去之后，三个出口（回执 / GET / snapshot）与序列化全文里都不许出现它们', async () => {
  const h = await mkApi();
  const CRED = { baiduAppid: '20261234567890', baiduKey: 'sekret-bd', tencentSecretId: 'AKIDtc0123456789', tencentSecretKey: 'sekret-tc', aliyunAccessKeyId: 'LTAI0123456789', aliyunAccessKeySecret: 'sekret-ali',
    ghToken: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH' };
  // 扫描面 = 两家表里**打了 secret 标记**的那些键，且必须与 domain 派生的那份一致（不一致就是新增那把没进闸门）
  const secretKeys = [...TRANSLATE_CRED_ALL, ...GH_CRED_FIELDS].filter((f) => f.secret).map((f) => f.key);
  assert.deepEqual(PREF_SECRET_KEYS, secretKeys, '回显闸门吃的清单与字段表对不上 ⇒ 有一把密钥不在闸门里');
  const idKeys = TRANSLATE_CRED_ALL.filter((f) => !f.secret).map((f) => f.key);
  const { res } = await call(h, post('/api/prefs', { translateEngine: 'tencent', ...CRED }));
  const saved = res.json().data;
  for (const k of idKeys) assert.equal(saved[k], CRED[k], `${k} 不是密钥，照常回填给界面`);
  for (const k of secretKeys) assert.equal(k in saved, false, `回执里不许带 ${k}`);
  const got = (await call(h, get('/api/prefs'))).res.json().data;
  for (const k of secretKeys) assert.equal(k in got, false, `GET /api/prefs 也不回显 ${k}`);
  const snap = (await call(h, get('/api/snapshot'))).res.json().data;
  for (const k of secretKeys) assert.equal(k in snap.prefs, false, `快照里也不回显 ${k}`);
  const whole = JSON.stringify(snap);
  for (const k of secretKeys) assert.equal(whole.includes(CRED[k]), false, `序列化全文里搜到了 ${k} 本体`);
  // 库里那一格确实写进去了（否则"不回显"就成了"没存"这种假绿）
  for (const k of secretKeys) assert.equal((await h.__stores.prefs.read())[k], CRED[k], `${k} 压根没落库`);
  assert.equal(snap.translator.engine, 'tencent');
  assert.equal(snap.translator.credStored, true, '唯一的痕迹就是那位 has 布尔');
  // 没选中的那两家也存在库里：视图只摆当前这一档的两格（其余两家不许跑到同一屏上）
  assert.deepEqual(snap.translator.credFields.map((f) => f.key), ['tencentSecretId', 'tencentSecretKey']);
  // ★ 第二十一轮：GitHub 那一把**不跟着翻译档走** —— 选哪一档翻译都在，因为它发的是 api.github.com，不是厂商。
  assert.equal(snap.github.credStored, true, '令牌落了库却看不出"已经填过" ⇒ 用户只能重填一遍（下一次保存会当新密钥再发）');
  assert.equal(snap.github.credFields.find((f) => f.key === 'ghToken').has, true);
  // 留空串是「清除」：界面上那颗「清除」按钮发的就是这一格
  const cleared = (await call(h, post('/api/prefs', { tencentSecretId: '', tencentSecretKey: '', ghToken: '' }))).res.json().data;
  assert.equal(cleared.tencentSecretId, '');
  assert.equal((await h.__stores.prefs.read()).tencentSecretKey, '');
  assert.equal((await h.__stores.prefs.read()).ghToken, '', '令牌清不掉 ⇒ 界面显示空了，出网那一份还带着旧令牌');
});

check('translateEngine 只认现行五档：脏值与旧档名一律 400，且把合法值念出来（不许静默回落把用户的设置吞掉）', async () => {
  const h = await mkApi();
  const { res } = await call(h, post('/api/prefs', { translateEngine: 'Bing' }));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, new RegExp(TRANSLATE_ENGINES.join('|')));
  // 写路径**不搬家**：旧档名只由读路径（clampPrefs）迁，POST 收到它就是发错版了 ⇒ 400 比"替你猜一个"诚实
  const legacy = await call(h, post('/api/prefs', { translateEngine: 'official' }));
  assert.equal(legacy.res.statusCode, 400, '旧档名被写路径悄悄收下 ⇒ 客户端与库里的档名从此分两副面孔');
  for (const engine of TRANSLATE_ENGINES) {
    const ok = await call(h, post('/api/prefs', { translateEngine: engine }));
    assert.equal(ok.res.statusCode, 200, `${engine} 应当是合法档`);
    assert.equal((await h.__stores.prefs.read()).translateEngine, engine);
  }
});

check('凭据那一叠格的形状闸门：非字符串 400、超长 400（超长那条会把签名算成另一份，界面上只会看到厂商回 5xxxx / InvalidParameter）', async () => {
  // ★ 清单从 domain 派生（第二十一轮那把 GitHub 令牌自动进来）：这里再手抄一遍键名就等着漏扫。
  assert.deepEqual(PREF_CRED_FIELDS.map((f) => f.key), [...TRANSLATE_CRED_ALL, ...GH_CRED_FIELDS].map((f) => f.key),
    '写路径扫的清单与两家字段表对不上 ⇒ 新增那一格没进 400 闸门');
  for (const f of PREF_CRED_FIELDS) {
    const h = await mkApi();
    const bad = await call(h, post('/api/prefs', { [f.key]: 20261234567890 }));
    assert.equal(bad.res.statusCode, 400, `${f.key}：数字型必须是 400，不是静默转字符串`);
    const longVal = await call(h, post('/api/prefs', { [f.key]: 'k'.repeat(f.maxLength + 130) }));
    assert.equal(longVal.res.statusCode, 400, `${f.key}：超长居然过了闸门`);
    assert.match(longVal.res.json().error.message, /过长/);
    assert.equal((await h.__stores.prefs.read())[f.key], '', `${f.key}：被拒的那一发不许已经落库一半`);
    // 恰好到上限的那一发要过（钳制与拒绝的边界得有人钉着，否则"上限"只是注释里的一句话）
    const edge = await call(h, post('/api/prefs', { [f.key]: 'k'.repeat(f.maxLength) }));
    assert.equal(edge.res.statusCode, 200, `${f.key}：上限内的值被拒了（上限 ${f.maxLength}）`);
  }
});

/* ---------------- 第二十一轮：GitHub 那一格的视图 ---------------- */
check('githubView：只给 has 布尔，不给 value；说明句与「去哪创建」外链全部来自 domain（客户端不排表）', async () => {
  assert.deepEqual(Object.keys(githubView({})).sort(),
    ['credFields', 'credStored', 'note', 'register', 'secretSavedHint'].sort(),
    '载荷键换了名字客户端就得跟着改，这一格得有人钉住');
  const empty = githubView({ ghToken: '' });
  assert.deepEqual(empty.credFields.map((f) => [f.key, f.label, f.secret, f.maxLength]),
    GH_CRED_FIELDS.map((f) => [f.key, f.label, f.secret === true, f.maxLength]), '格子的标签或上限与 domain 不一致');
  assert.equal(empty.credFields[0].has, false, '库里没值却说"已存" ⇒ 界面上那颗清除按钮白摆着');
  assert.equal(empty.credStored, false);
  assert.equal(empty.note, GH_TOKEN_NOTE);
  assert.deepEqual(empty.register, GH_TOKEN_REGISTER);
  assert.ok(empty.register.links.length >= 1 && empty.register.links.every((l) => /^https:\/\//.test(l.url)),
    '令牌那一行的创建地址也要 https 外链');
  const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH';
  const filled = githubView({ ghToken: TOKEN });
  assert.equal(filled.credStored, true);
  assert.equal(filled.credFields[0].has, true);
  assert.equal('value' in filled.credFields[0], false, '视图里出现 value 位就是准备回显');
  assert.equal(JSON.stringify(filled).includes(TOKEN), false, '视图里漏出了令牌本体');
  // ★ 只有一格空格也算没填（与 repo.js 那条 trim 同口径，否则界面上显示"已保存"而那一发仍按匿名算）
  assert.equal(githubView({ ghToken: '   ' }).credStored, false);
});

check('快照里 github 那一格恒在（客户端没有兜底表，缺了就是白屏而不是少一行）', async () => {
  const h = await mkApi();
  const snap = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.deepEqual(Object.keys(snap.github).sort(), ['credFields', 'credStored', 'note', 'register', 'secretSavedHint'].sort());
  assert.equal(snap.github.credStored, false);
  assert.equal(snap.github.credFields.length, GH_CRED_FIELDS.length, '格数由 domain 给，用例不抄数');
});

check('POST /api/prefs：现译两开关只吃严格布尔 —— "true" / 1 / on 一律 400，别让表单序列化烧掉用户的额度', async () => {
  for (const dirty of ['true', 'false', 1, 0, 'on', {}, []]) {
    const h = await mkApi();
    const { res } = await call(h, post('/api/prefs', { llmDesc: dirty }));
    assert.equal(res.statusCode, 400, `收到 ${JSON.stringify(dirty)} 居然过了闸门`);
    assert.equal(res.json().error.code, 'INVALID_PARAM');
    assert.equal((await h.__stores.prefs.read()).llmDesc, DEFAULT_PREFS.llmDesc, '被拒的那一发一个键都不许落库');
  }
  const h = await mkApi();
  const okRes = await call(h, post('/api/prefs', { llmDesc: false, llmReadme: true }));
  assert.equal(okRes.res.statusCode, 200);
  const back = await h.__stores.prefs.read();
  assert.equal(back.llmDesc, false);
  assert.equal(back.llmReadme, true);
});

check('isLoopback：::1 / localhost / IPv6 写法都算本机，XFF 里混进公网跳点就不算', () => {  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '[::1]' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: 'localhost' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '10.0.0.5' } }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1, ::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } }), false,
    '反代把公网来源伪装成回环 ⇒ 闸门必须站住');
});

check('路由表：未知 404、同路径换方法是 405 且说清支持什么', async () => {
  const h = await mkApi();
  const nf = await call(h, get('/api/nope'));
  assert.equal(nf.res.statusCode, 404);
  assert.equal(nf.res.json().error.code, 'NOT_FOUND');
  const bad = await call(h, makeReq({ method: 'DELETE', url: `${ROUTE_PREFIX}/api/prefs` }));
  assert.equal(bad.res.statusCode, 405);
  assert.match(bad.res.json().error.message, /GET \| POST/);
  const put = await call(h, makeReq({ method: 'PUT', url: `${ROUTE_PREFIX}/api/snapshot` }));
  assert.equal(put.res.statusCode, 405);
});

check('坏 JSON 回 400 BAD_JSON，而不是 500 或静默当空体', async () => {
  const h = await mkApi();
  const { res } = await call(h, makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/prefs`, body: '{oops' }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'BAD_JSON');
});

check('空 body 的 POST 当"不发任何键"处理（全量保持原值）', async () => {
  const h = await mkApi({ prefs: { topN: 20 } });
  const { res } = await call(h, makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/prefs`, body: '' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.topN, 20);
});

check('错误码 → HTTP 状态码集中一张表（各层不再自己猜）', () => {
  assert.equal(statusFor('GHT_RECORDS_UNAVAILABLE'), 501);
  assert.equal(statusFor('GHT_RECORDS_CLOSED'), 503);
  assert.equal(statusFor('GHT_RECORDS_INVALID'), 400);
  assert.equal(statusFor('GHT_RECORDS_NOT_FOUND'), 404);
  assert.equal(statusFor('GHT_RECORDS_DUPLICATE'), 409);
  assert.equal(statusFor('CHECK_BUSY'), 409);
  assert.equal(statusFor('BAD_JSON'), 400);
  assert.equal(statusFor('METHOD_NOT_ALLOWED'), 405);
  assert.equal(statusFor('从没登记过的码'), 500);
});

check('存储层错误按 code 翻译：无 storageDomain 时 GET 快照仍 200、POST 偏好 501', async () => {
  const caps = createCaps({});
  const opts = { getFacility: () => undefined };
  const h = createApiHandler({
    check: { run: async () => ({ at: 1 }), checkLanguage: async () => ({ status: 'boarded', slug: '' }) },
    stateStore: createStateStore(opts),
    eventStore: createEventStore(opts),
    prefsStore: createPrefsStore(opts),
    caps,
    logger: { warn: () => {} },
    now: () => 1,
    sseTimers: { setIntervalMod: () => ({ unref() {} }), clearIntervalMod: () => {} },
  });
  const snap = await call(h, get('/api/snapshot'));
  assert.equal(snap.res.statusCode, 200, '无存储只是看不了历史，不该让面板打不开');
  assert.equal(snap.res.json().data.storage.available, false);
  assert.equal(snap.res.json().data.boards.daily.error, '存储不可用');
  const save = await call(h, post('/api/prefs', { topN: 9 }));
  assert.equal(save.res.statusCode, 501);
  assert.equal(save.res.json().error.code, 'GHT_RECORDS_UNAVAILABLE');
});

/* ---------------- SSE ---------------- */
check('openSse：先 ": ok" 冲缓冲，帧是 event/data 双行 + 空行分隔', () => {
  const res = makeRes();
  const sse = openSse(res, { setIntervalMod: () => ({ unref() {} }), clearIntervalMod: () => {} });
  assert.equal(res.statusCode, 200);
  assert.match(res.head['Content-Type'], /text\/event-stream/);
  assert.equal(res.writes[0], ': ok\n\n');
  sse.send('snapshot', { at: 1 });
  assert.equal(res.writes[1], 'event: snapshot\ndata: {"at":1}\n\n');
  sse.close();
  sse.send('update', { at: 2 });
  assert.equal(res.writes.length, 2, '关闭后不再往断掉的连接里写');
});

check('openSse：心跳写失败当场摘牌（死连接不能留在 hub 里）', () => {
  const res = makeRes();
  const broken = { n: 0 };
  let hbFn = null;
  const sse = openSse(res, {
    setIntervalMod: (fn) => { hbFn = fn; return { unref() {} }; },
    clearIntervalMod: () => {},
    onBroken: () => { broken.n += 1; },
  });
  res.write = () => { throw new Error('write after end'); };
  hbFn();
  assert.equal(broken.n, 1);
  void sse;
});

check('createHub：首客连上/末客断开各回调一次，broadcast 遇到坏连接只摘它', () => {
  const marks = [];
  const hub = createHub(() => marks.push('first'), () => marks.push('last'));
  const good = { sent: [], send(ev) { this.sent.push(ev); }, closed: 0, close() { this.closed += 1; } };
  const bad = { send() { throw new Error('断了'); }, closed: 0, close() { this.closed += 1; } };
  hub.add(good);
  hub.add(bad);
  assert.deepEqual(marks, ['first']);
  hub.broadcast('update', {});
  assert.deepEqual(good.sent, ['update']);
  assert.equal(hub.count, 1, '坏连接当场摘牌');
  hub.remove(bad);                       // 重复摘不报错也不二次回调
  assert.equal(marks.length, 1);
  hub.remove(good);
  assert.deepEqual(marks, ['first', 'last']);
  assert.equal(good.closed, 1);
  hub.add(good);
  hub.dispose();
  assert.equal(hub.count, 0);
});

check('GET /api/stream：首帧 snapshot 的形状 = GET /api/snapshot 的形状', async () => {
  const h = await mkApi({ states: { daily: stateRow('daily', [crow('a/1', 1)]), weekly: null, monthly: null } });
  const res = makeRes();
  const req = makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` });
  await h(req, res);
  await flush(5);
  const raw = res.writes.join('');
  assert.match(raw, /^: ok\n\n/);
  assert.match(raw, /event: snapshot\ndata: /);
  const frame = JSON.parse(raw.split('event: snapshot\ndata: ')[1].split('\n\n')[0]);
  const viaGet = (await call(h, get('/api/snapshot'))).res.json().data;
  assert.deepEqual(Object.keys(frame).sort(), Object.keys(viaGet).sort(),
    'update/snapshot 两种通路必须同形，否则浏览器半边要凭空补字段（sysops S17 教训）');
  assert.equal(frame.boards.daily.rows.length, viaGet.boards.daily.rows.length);
  assert.equal(res.ended, false, '长连接不许 end');
});

check('检查完的一帧经 subscribeEvent 汇进 hub，载荷就是全量快照', async () => {
  const h = await mkApi();
  const seen = [];
  const res = makeRes();
  // 先挂一条 SSE（它会进 hub），再让 check 发 update 帧
  await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` }), res);
  await flush(5);
  assert.equal(h.__fanout.size, 1, 'api 门面必须订阅检查服务的事件扇出');
  for (const fn of h.__fanout) fn({ type: 'not-update' });
  await flush(5);
  seen.push(res.writes.length);
  for (const fn of h.__fanout) fn({ type: 'update', at: 1234 });
  await flush(10);
  assert.ok(res.writes.length > seen[0], 'update 帧该落到长连接上');
  const joined = res.writes.join('');
  assert.match(joined, /event: update\ndata: /);
  const frame = JSON.parse(joined.split('event: update\ndata: ')[1].split('\n\n')[0]);
  assert.ok(frame.boards, 'update 帧带的是全量快照，不是增量');
  assert.equal(frame.at, 7777, '快照时刻由 api 层的 now 提供，不吃帧里的 at');
  h.dispose();
  assert.equal(h.__fanout.size, 0, 'dispose 必须退订，否则 reload 后一轮检查广播两份');
});

check('readBody：拼流、超大体拒收、__parsedBody 逃生舱只给测试', async () => {
  const req = makeReq({ method: 'POST', url: '/x', body: { a: 1 } });
  const p = readBody(req);
  await flush(5);
  assert.deepEqual(await p, { a: 1 });
  const destroyed = { n: 0 };
  const big = { on: (_ev, fn) => { if (_ev === 'data') fn(Buffer.alloc(1_000_001, 'x')); }, destroy() { destroyed.n += 1; } };
  await assert.rejects(() => readBody(big), (e) => e.code === 'BAD_JSON');
  assert.deepEqual(await readBody({}), {}, '没有流的 req ⇒ 空体，不崩');
});

check('路由表本身：登记的方法与闸门口径一致（写全闸 + 花配额的 GET 也闸，纯读面板的 GET 不闸）', () => {
  assert.deepEqual(Object.keys(ROUTES).sort(), [
    'GET /api/events', 'GET /api/prefs', 'GET /api/repo', 'GET /api/snapshot', 'GET /api/stream', 'POST /api/check', 'POST /api/prefs',
  ]);
  assert.ok(Object.keys(ROUTES).every((k) => k.startsWith('GET ') || k.startsWith('POST ')));
  const gated = Object.entries(ROUTES).filter(([k, v]) => v.loopback === true || k.startsWith('POST ')).map(([k]) => k).sort();
  assert.deepEqual(gated, ['GET /api/repo', 'POST /api/check', 'POST /api/prefs'],
    '闸的是"会替调用方动东西"的入口：写操作 + 会烧匿名配额的详情读');
  const unGated = Object.keys(ROUTES).filter((k) => !k.startsWith('POST ') && ROUTES[k].loopback !== true);
  assert.deepEqual(unGated.sort(), ['GET /api/events', 'GET /api/prefs', 'GET /api/snapshot', 'GET /api/stream'],
    '纯读面板的不闸，真机排障要从别机看得清');
});

await runAll('api');
