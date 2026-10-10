/**
 * test/client.test.mjs —— 浏览器半边（client.js）在 vm 沙箱里跑。
 *
 * 四条判据的来处（都是真机踩过的）：
 *  · factory 必须 return module.exports（宿主 ModuleLoader 吃返回值当导出）；
 *  · 一份真相：榜名 / 新增列名 / 档位 / 事件类型 / 来源注 / 语言判定 / 传输提示只能来自载荷或快照；
 *  · 表头、列值、列模板逐列同向（对齐序列与 col 宽是真机截图「错位」的病根）；
 *  · snapFixture 跟着 lib/api.js 的 snapshotOf 一起长：宿主每加一个键这里就补一个，
 *    否则用例是在测客户端自己编的形状（nameImage 那次：fixture 少一键 ⇒ 全绿而真机坏）。
 *
 * 页签化（S2）后整页不再是「六段一路滚」：client-30 逐页签验路由，client-17 验页签条，
 * client-33~38 验总览小结与故障口径（连续轮数 / 补发次数 / 下次自动检查 / 传输提示）。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { check, runAll, assert } from './_helpers.mjs';
import {
  BOARDS, BOARD_LABELS, BOARD_ADDED_LABELS, CHECK_INTERVALS, CHECK_INTERVAL_LABELS,
  EVENT_KIND_LABELS, TRENDING_SOURCE_NOTE, LANG_CHECK, TOP_N_MIN, TOP_N_MAX,
  KEEP_EVENTS_MIN, KEEP_EVENTS_MAX, KEEP_EVENTS_STEP, DEFAULT_PREFS,
  TRANSPORT_HINT, TRANSPORT_HINT_TAIL, TRANSPORT_VIA_LABELS, TRANSPORT_SOURCE_LABELS,
  FETCH_ATTEMPTS, PROXY_MODES, PROXY_MODE_LABELS, PROXY_MODE_HINTS, PROXY_URL_MAX,
  TRANSLATE_ENGINES, TRANSLATE_ENGINE_LABELS, TRANSLATE_ENGINE_HINTS, TRANSLATE_CRED_NOTE, TRANSLATE_CRED_FIELDS,
  TRANSLATE_REGISTER, SECRET_SAVED_HINT,
  // ★ 第二十一轮：密钥格名清单换成 domain 派生那一份（含 ghToken）；旧的 TRANSLATE_SECRET_KEYS 只列三家翻译的，
  //   拿它当"全部密钥"就漏扫了新加那把（hc-0 那条「手抄必漏」）。
  PREF_SECRET_KEYS, GH_CRED_FIELDS, GH_TOKEN_NOTE, REPO_RATE_ANON, REPO_RATE_AUTH, RATE_LABEL_ANON, RATE_LABEL_AUTH,
  REPO_FIELD_LABELS, REPO_ERROR_LABELS, REPO_FLAG_LABELS, REPO_README_SOURCE_LABELS,
  REPO_CACHE_HOURS, REPO_CACHE_HOUR_LABELS, REPO_SECTION_LABELS,
  README_ZH_GATE_SUFFIXES,
  TRANSLATE_COMMON_NOTE, LLM_SWITCH_LABELS, LLM_README_LABEL_TRANSLATE, LLM_KINDS, LLM_NOT_READY_HINT, llmZhLabel,
  // 第二十二轮：榜面那一列的两种来源，落款与那句"发不出去"的实话都在 domain，用例只认名字不抄文本。
  engineZhLabel, DESC_ZH_LIVE_NOTE, DESC_ZH_BLOCKED_NOTE,
  // ★ 第二十三轮：明星那一屏的档位名 / 列名 / 三句 note 全归 domain（判据见 client-32 末尾那一段豁免清单的理由）。
  STARS_NO_STORE_NOTE, STARS_QUOTA_OFF_NOTE, STARS_QUOTA_WAITING_NOTE, STARS_ALL_STARS_NOTE,
  STARS_COL_STARS_ADDED, STARS_COL_ROUNDS_PEAK, STARS_COL_STARS,
  STARS_VIEW_LABELS, STARS_VIEW_DISABLED_LABELS, STARS_SORT_LABELS,
} from '../lib/domain.js';
import { netView, translatorView, githubView, publicPrefs } from '../lib/api.js';
import { DESC_ZH_ROWS, DESC_ZH_LABEL, DESC_ZH_NOTE } from '../lib/desc-zh.js';
// ★ 第二十二轮：`descZh` 那一格改由宿主自己的装配函数现造（同 netView / translatorView 那条律）。
//   上一版在这里手搓 `{label, note, hits}` ⇒ 宿主换成 `{hits, heads, liveNote}` 之后客户端 57 条照样绿，
//   而真机的榜面那一列会整列空掉。夹具跟着源走，形状漂移才会当场红。
import { descZhView, descZhRows, boardDescZhHead } from '../lib/board-zh.js';
import { transSrcKey } from '../lib/services/llm.js';
import { repoView, applyZh } from '../lib/services/repo.js';
// ★ 第二十三轮：`stars` 那一格同样由宿主的 starsView 现造（同 netView / descZhView 那条律）。
//   上一版若在这里手搓 `{headline, rows, views...}`，宿主改一次键名客户端 58 条照样绿，真机那一屏却是空的。
import { starsView } from '../lib/stars.js';

/** 载荷 = index.js 里 webserver/index-inject 推的那一份，逐键对齐。 */
const PAYLOAD = {
  panelId: 'gh-trending', panelOrder: 16, routePrefix: '/gh-trending', api: '/gh-trending/api',
  label: 'GitHub 热榜', capabilities: { storageDomain: true, timer: true, webServer: true },
  capabilityRows: [], boards: BOARDS, boardLabels: BOARD_LABELS, boardAddedLabels: BOARD_ADDED_LABELS,
  sourceNote: TRENDING_SOURCE_NOTE, langCheck: LANG_CHECK, crossMin: 2,
  intervals: CHECK_INTERVALS, intervalLabels: CHECK_INTERVAL_LABELS,
  // ★ 第十二轮：详情缓存时长的档位与话术（键名与 index.js 推的那一份由 hc-12 逐键对齐钉着）
  cacheHours: REPO_CACHE_HOURS, cacheHourLabels: REPO_CACHE_HOUR_LABELS,
  topNRange: { min: TOP_N_MIN, max: TOP_N_MAX },
  keepEventsRange: { min: KEEP_EVENTS_MIN, max: KEEP_EVENTS_MAX, step: KEEP_EVENTS_STEP },
  proxyModes: PROXY_MODES, proxyModeLabels: PROXY_MODE_LABELS, proxyModeHints: PROXY_MODE_HINTS,
  proxyUrlMax: PROXY_URL_MAX,
  eventKindLabels: EVENT_KIND_LABELS, defaults: { ...DEFAULT_PREFS }, builtAt: 1,
};

/**
 * 沙箱跑 client.js。opts：
 *  · fetch —— 替 api() 与 useStream 的出网口（默认抛，免得测试真联网）
 *  · snap / tab —— 顶掉 GhTrendingPage 的 useState 初值，用来逐页签测路由
 *  · states —— 按"本次渲染里第几个 useState"顶初值（★ 只配单组件渲染用，见上面 stateSets 那条）
 *  · stylePresent —— 假装 document 里已有同 id 的 style（测 reload 不叠两份）
 */
function loadClient(payload = PAYLOAD, opts = {}) {
  const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const loaded = {};
  const styleOps = [];
  const docListeners = {};
  const effects = [];
  // ★ 第二十三轮：组件内部状态（StarsCard 的 view / sort）没有入参口子，判据就只能从"点之后它把什么写回状态"取。
  //   `stateSets` 记下每次 setter 被谁调用（带初值做身份），`opts.stateInits` 按"本次渲染里第几个 useState"顶初值。
  //   两者都只在**单组件渲染**里用（顶的是整页的第 N 个 useState，跨组件没有意义）。
  const stateSets = [];
  let setCursor = 0;
  const fakeDoc = {
    getElementById: (id) => (opts.stylePresent ? { id } : null),
    createElement: (tag) => {
      const el = { tag, _t: '' };
      Object.defineProperty(el, 'textContent', { set(v) { this._t = v; }, get() { return this._t; } });
      el.remove = () => styleOps.push('remove');
      return el;
    },
    head: { appendChild(el) { styleOps.push('append:' + el.id); }, },
    // 详情对话框吃 keydown（Esc 关）：记下来才能让用例自己跑那一条 effect，不靠正则猜
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => {
      const list = docListeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (init) => {
      const idx = setCursor++;
      const forced = Array.isArray(opts.states) ? opts.states[idx] : undefined;
      // detail 的初值认形状不认 null：IDLE_DETAIL 是对象，跟 snap 那条 `init === null` 撞不上，
      // 而「顶掉第一个对象初值」会把别处初值一起顶掉 ⇒ 按键名挑出来。
      const v = forced !== undefined ? forced
        : ((opts.snap !== undefined && init === null) ? opts.snap
          : (opts.tab && init === 'overview' ? opts.tab
            : (opts.detail && init && init.view === null && init.loading === false ? opts.detail : init)));
      return [v, (next) => { stateSets.push({ idx, init, next }); }];
    },
    // 不跑 effect（useStream 那一跑就会留一个每 5 秒重连的活定时器），只记下来让用例点名跑
    useEffect: (fn, deps) => { effects.push({ fn, deps }); },
    useRef: (init) => ({ current: init ?? null }),
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          loaded.exports = factory((name) => {
            if (name === 'react') return fakeReact;
            throw new Error(`client 要了白名单外的依赖：${name}`);
          });
        },
      },
    },
    document: fakeDoc,
    fetch: opts.fetch ?? (async () => { throw new Error('沙箱不发真请求'); }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, TextDecoder: global.TextDecoder, URL,
  };
  vm.createContext(sandbox);
  // ★ 载荷必须在跑代码之前就位：PANEL_ID 是 factory 顶层读的，晚塞就测不到覆盖
  if (payload !== null && Object.keys(payload).length) sandbox.__GH_TRENDING__ = payload;
  vm.runInContext(code, sandbox);
  const exports = loaded.exports;
  assert.ok(exports && typeof exports === 'object' && typeof exports.apply === 'function',
    'factory 必须 return module.exports（返回 module 外层拿不到 apply ⇒ 真机 invalid plugin）');
  return { exports, sandbox, styleOps, effects, docListeners, stateSets };
}

const AT = 1790700000000;
const atOff = (d) => AT + d;
const row = (repo, rank, over = {}) => ({
  rank, repo, name: over.name || repo, repoId: 1000 + rank, desc: '一个描述', lang: 'Rust', langColor: '#dea584',
  stars: 12345, forks: 42, added: 512, delta: 0, ...over,
});
/**
 * 观测史一行的形状 = `createSeenStore().touch()` 真正落库的那一份（键恒小写，格名照抄 `seenStore`，用例不自立一套）。
 * ★ 为什么不省略 `roundsTotal` / `bestRank`：那一屏的「在榜」列全吃这两格，夹具给少了 ⇒ 客户端测的是"没有这一格"。
 */
const seenRow = (repo, over = {}) => ({
  repo, name: repo, repoId: 1,
  firstAt: atOff(-6 * 86400000), firstBoard: 'daily',
  lastAt: atOff(-60000), lastBoard: 'daily', boards: ['daily'],
  roundsTotal: 1, bestRank: 1, ...over,
});
/** 默认那一份榜史：三档各有行，且「回落」那一档必须真有一行不在屏上（否则置灰与缺位那几条判据是空跑）。 */
function defaultSeenRows(dailyRepo) {
  const rows = [
    seenRow(dailyRepo, { roundsTotal: 7, bestRank: 1, lastAt: atOff(-60000) }),
    seenRow('a/two', { roundsTotal: 4, bestRank: 2 }),
    seenRow('a/three', { roundsTotal: 1, bestRank: 3 }),
    seenRow('w/one', { roundsTotal: 2, bestRank: 5, lastBoard: 'weekly', boards: ['weekly'] }),
    seenRow('g/gone', { roundsTotal: 6, bestRank: 2, lastAt: atOff(-2 * 86400000) }),
  ];
  return new Map(rows.map((r) => [r.repo, r]));
}

/**
 * 一份与 lib/api.js 的 snapshotOf 同形的快照。
 * ⚠️ 宿主的 snapshotOf 每加一个键都要在这里跟着加，否则「两头都断言」会退化成客户端自己编形状
 *    （nameImage 那次的教训：fixture 少一个键 ⇒ 用例全绿、真机坏）。
 * ⚠️ 第二参 `starsOver` 只喂 `starsView` 的**入参**（榜史 / 那一批 search / 存储位 / 开关），不是往快照里塞 `stars`：
 *    塞进去的那一份是客户端自己编的形状，正是这条律要防的那种假绿。
 */
function snapFixture(over = {}, starsOver = {}) {
  const b = (board, rows, bo = {}) => ({
    label: BOARD_LABELS[board], hasData: true, ok: true, error: undefined,
    at: atOff(-60000), bodyChangedAt: atOff(-3600000), lastFetchAt: atOff(-60000), failStreak: 0,
    transport: false,
    rowsTotal: 20, rows, empty: rows.length === 0, ...bo,
  });
  const boards = {
    // 第一行刻意用内置表里真那一条（主键 + 原文都取自 `DESC_ZH_ROWS`）：宿主视图判命中靠两者逐字相同，
    // 夹具只改原文不改主键的话，这一列在客户端测试里就永远不会命中 —— 假绿的另一种写法。
    daily: b('daily', [row(DESC_ZH_ROWS[0][0], 1, { desc: DESC_ZH_ROWS[0][1] }), row('a/two', 2, { delta: 4 }), row('a/three', 3, { delta: -2 })]),
    weekly: b('weekly', [row('w/one', 1, { desc: 'A plain english line' })]),
    monthly: b('monthly', [], { rowsTotal: 0 }),
  };
  // ★ 描述列的中文（第二十二轮起两种来源并排）：hits / heads 全部由宿主的 `descZhView` + `boardDescZhHead` 现算，
  //   喂进去的 transRows 就是 KV 里那一行的形状 —— 用例不手搓落款，也就不会自己编日期。
  //   a/one 的 desc 取内置表里真那一句原文 ⇒ 走 builtin；w/one 走库里逐字命中的现译行 ⇒ 走 live。
  // ★ 10-10：参与行集合与宿主**同一个出处**（`descZhRows`），所以这一段排在 `stars` 之后算 ——
  //   api.js 里也是那份顺序（先有那一档的行，才有"这一档开着的屏上那些行"）。夹具自己 `allVisibleRows(boards)` 就是第二份真相。
  const transRows = starsOver.transRows ?? [
    { repo: 'w/one', kind: 'desc', src: 'A plain english line', zh: '这一句是现译的中文', at: atOff(-120000), chars: 8, engine: 'keyless' },
  ];
  // ★ net 这一份视图是宿主 netView 现造的（它 export 出来就是给这里用）：
  //   用例手搓形状就等于客户端在测自己编的字段，真机少一个键照样全绿。
  const net = netView({
    getTransportRoute: () => ({
      via: 'proxy', source: 'registry', proxy: 'http://127.0.0.1:7897',
      reason: '', targetHost: 'github.com', at: atOff(-60000),
    }),
  }, boards).view;
  // ★ 第二十三轮：`prefs` 先算出来，`starsView` 与快照吃的是**同一份**（出网前那道闸摘掉的密钥夹具也拿不到）。
  //   默认是**非默认值**那条律不变（出厂 desc 开 / readme 关 / 全站高星关）。
  const prefs = publicPrefs({
    ...DEFAULT_PREFS, intervalMin: 180, llmDesc: false, llmReadme: true, translateEngine: 'host_llm',
    baiduAppid: 'stored-appid', tencentSecretId: 'AKIDstored', aliyunAccessKeyId: 'LTAIstored',
    baiduKey: 'sekret-in-store', tencentSecretKey: 'sekret-in-store', aliyunAccessKeySecret: 'sekret-in-store',
    ...(starsOver.prefs || {}),
  });
  /**
   * 「明星仓库」那一格：入参逐条对齐 `lib/api.js:470` 那次调用（`roundAt` 同样取三榜最新那个 `at`，
   * 存储位同样吃 `seenStore.available`）。`search` 默认 `null` = 本机从没取回过那一档（出厂开关关着）。
   */
  const stars = starsView({
    seenRows: starsOver.seenRows ?? defaultSeenRows(DESC_ZH_ROWS[0][0]),
    boards,
    roundAt: starsOver.roundAt ?? Math.max(boards.daily.at, boards.weekly.at, boards.monthly.at, 0),
    prefs,
    search: starsOver.search ?? null,
    storageAvailable: starsOver.storageAvailable ?? true,
  });
  const zhView = descZhView(descZhRows({
    boards,
    allStarsRows: stars.allStars.rows,
    allStarsEnabled: prefs.allStarsEnabled === true,
  }), transRows, { nowMs: AT });
  const heads = {};
  for (const k of BOARDS) heads[k] = boardDescZhHead(boards[k].rows, zhView.hits);
  return {
    at: AT,
    caps: { storageDomain: true, timer: true, webServer: true },
    capabilityRows: [
      { key: 'storageDomain', label: '本地存储', ok: true, detail: '', fallback: '' },
      { key: 'timer', label: '宿主定时器', ok: false, detail: '宿主未提供 ctx.timer.interval', fallback: '退到 setInterval' },
    ],
    // 故意填**非默认值**（出厂是 desc 开 / readme 关）：两个方向都反着默认，界面上才分得清"回填"和"写死"
    // ★ 三家凭据那三格标识符走 `publicPrefs`（宿主出网前的同一道闸）：密钥那一格从来不在载荷里，
    //   fixture 要是自己拼出 `baiduKey`，客户端"永不回填密钥"这条判据就当场失效（假绿）。
    prefs,
    storage: { available: true },
    sourceNote: TRENDING_SOURCE_NOTE,
    langCheck: LANG_CHECK,
    descZh: { hits: zhView.hits, heads, liveNote: '' },
    // ★ 现译这一路的视图同样是宿主 translatorView 现造的（同 netView 那条律）：手搓就等于客户端在测自己编的键。
    //   档选 host_llm：这一路是 ready 的，免费/官方那一路在客户端测试里没有句柄，选它就得造假。
    translator: translatorView({ translator: { ready: () => true, kinds: () => [...LLM_KINDS] } }, { translateEngine: 'host_llm', llmDesc: false, llmReadme: true }),
    // ★ 第二十一轮：GitHub 那一格的视图由宿主 githubView 现造（同 netView / translatorView 那条律：夹具不手搓形状）。
    //   这一份是「没填令牌」那一形状；存过那一形状在 client-52 的 ⑧ 里单独喂。
    github: githubView({}),
    transportHint: TRANSPORT_HINT,
    net,
    // nextCheckAt 0 = 没在跑表（停表 / 检查服务缺位），界面据此不说「下次自动检查」
    cadence: { intervalMin: 180, effectiveMs: 10800000, backoffExp: 0, nextCheckAt: 0, fetchAttempts: FETCH_ATTEMPTS },
    boards,
    // ★ 第二十三轮：明星那一屏的原料（宿主 starsView 现造，见上面那次调用的注释）。
    stars,
    cross: { rising: [], cooling: [], note: '跨榜同现由这一次检查的三张榜交叉算出，不额外发请求。' },
    events: [],
    ...over,
  };
}

/**
 * 一份仓库详情。★ 用**真的 repoView() + 真的 applyZh()** 现造，不手搓字段：
 * 详情这一层是「宿主拼好的中文」直通，用例自己拼形状就等于客户端在测自己编的键
 * （与 snapFixture 同一条律，nameImage 那次就是这么全绿而真机坏的）。
 * `zh` 那两路默认全空（= 没开现译 / B 命中 / 模型没给），要译文的那几个用例自己传 `zhOf`。
 */
function detailFixture(srcOver = {}, { cached = true, ageMs = 3 * 3600000, rate = { left: 41, resetAt: 0 }, zhOf = null, ...optOver } = {}) {
  const src = {
    repo: 'vitejs/vite', name: 'vitejs/vite', ok: true, at: atOff(-30000),
    desc: 'Next generation frontend tooling', lang: 'TypeScript', stars: 66000, forks: 5400,
    issues: 500, topics: ['build-tools', 'vite'], license: 'MIT',
    pushedAt: '2026-09-30T08:00:00Z', createdAt: '2017-12-04T00:00:00Z',
    homepage: 'https://vitejs.dev', htmlUrl: 'https://github.com/vitejs/vite',
    readmeSource: 'zh_file', readmePath: 'README-zh_CN.md',
    readmeExcerpt: 'Vite 是一种前端构建工具。\n这是节选的正文。',
    readmeChars: 195, readmeCut: true, zhCjk: 195,
    ...srcOver,
  };
  const view = repoView(src, { cached, ageMs, rate, ...optOver });
  return applyZh(view, typeof zhOf === 'function' ? zhOf(view) : (zhOf ?? {}));
}
/** 现译成功那一路的行形状（时刻固定，断言才不会被本地时区牵走）。 */
const ZH_AT = Date.UTC(2026, 9, 6, 1, 20);
const zhRow = (zh) => ({ ok: true, zh, cached: false, at: ZH_AT, label: llmZhLabel(ZH_AT), stored: true, note: '' });
/** 段表取样（第十一轮起载荷里没有 narrative，句子在 sections[].blocks[] 上）。 */
const secOfView = (v, key) => (v.sections ?? []).find((s) => s.key === key);
const secBlocks = (v, key) => secOfView(v, key)?.blocks ?? [];

/* ---------------- 渲染树工具 ---------------- */
function texts(node, acc = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return acc;
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { for (const n of node) texts(n, acc); return acc; }
  if (typeof node === 'object' && 'children' in node) { for (const c of node.children) texts(c, acc); }
  return acc;
}
const text = (node) => texts(node).join('');
/** fake react 不会调用函数组件：路由/装配类断言要先递归展开。 */
function mount(node, depth = 0) {
  if (Array.isArray(node)) return node.map((n) => mount(n, depth));
  if (!node || typeof node !== 'object') return node;
  const kids = () => (node.children || []).map((c) => mount(c, depth + 1));
  if (typeof node.type === 'function' && depth < 20) {
    return mount(node.type({ ...(node.props || {}), children: kids() }), depth + 1);
  }
  return { ...node, children: kids() };
}
const render = (el, props = {}) => mount(el(props));
function findByClass(node, cls, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const n of node) findByClass(n, cls, acc); return acc; }
  if (String(node.props?.className || '').split(/\s+/).includes(cls)) acc.push(node);
  if (Array.isArray(node.children)) { for (const c of node.children) findByClass(c, cls, acc); }
  return acc;
}
function findAllType(node, type, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const n of node) findAllType(n, type, acc); return acc; }
  if (node.type === type) { acc.push(node); return acc; }   // 找到表就不再往表内递归（免得吃到嵌套同名）
  if (Array.isArray(node.children)) { for (const c of node.children) findAllType(c, type, acc); }
  return acc;
}
const kidsOf = (node, type) => (node?.children || []).filter((c) => c && c.type === type);
/** 设置卡的一行：按行首标签找，不靠序号（多加一行就把所有下标挪一遍是假绿的温床）。 */
const setRow = (tree, label) => findByClass(tree, 'gt-setrow').find((r) => text(r).startsWith(label));
const cellsOf = (table, section) => {
  const sec = kidsOf(table, section)[0];
  const tr = sec ? kidsOf(sec, 'tr')[0] : null;
  return tr ? (tr.children || []).filter((c) => c && (c.type === 'th' || c.type === 'td')) : [];
};
const hasCls = (n, cls) => String(n?.props?.className || '').split(/\s+/).includes(cls);
/** vm 沙箱造出来的对象带着另一个 realm 的原型，strict deepEqual 会判「同构但不同源」⇒ 先剥回普通值再比。 */
const plain = (v) => JSON.parse(JSON.stringify(v));
const clientSrc = (stripComments = true) => {
  const raw = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  return stripComments ? raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '') : raw;
};

/* ---------------- 载荷与纯函数 ---------------- */
check('client-01 顶层零宿主依赖：只要 react，inject 只声明 slots', () => {
  const { exports } = loadClient();
  assert.equal(exports.inject.join(','), 'slots');
  assert.equal(typeof exports.apply, 'function');
});

check('client-02 require 白名单：要别的依赖当场抛（宿主 bundle 只给 react）', () => {
  const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const wanted = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(wanted)], ['react'], `client 里出现了 react 之外的 require：${wanted.join(',')}`);
});

check('client-03 载荷缺席时的硬回落：面板号 / API 前缀 / 三榜键', () => {
  const { exports } = loadClient(null);
  assert.equal(exports.PANEL_ID, 'gh-trending');
  const t = exports.__test;
  assert.equal(t.API_BASE(), '/gh-trending/api');
  assert.deepEqual(plain(t.BOARDS()), ['daily', 'weekly', 'monthly']);
  assert.equal(t.boardLabel('daily'), 'daily', '没有载荷就没有中文名：回落到键，不自己编一份文案');
});

check('client-04 fmtAge：刚刚 / 分 / 时 / 天 / 从未，且模板里不许再拼一遍「前」', () => {
  const { fmtAge } = loadClient().exports.__test;
  assert.equal(fmtAge(0, AT), '从未');
  assert.equal(fmtAge(AT - 30000, AT), '刚刚');
  assert.equal(fmtAge(AT - 5 * 60000, AT), '5 分钟前');
  assert.equal(fmtAge(AT - 3 * 3600000, AT), '3 小时前');
  assert.equal(fmtAge(AT - 2 * 86400000, AT), '2 天前');
  assert.equal(fmtAge(AT + 1000, AT), '刚刚', '时钟回拨不出现负数');
  assert.ok(!/\)}前/.test(clientSrc()), 'fmtAge 自带「前」，模板再拼一次就是「5 分钟前前」');
});

check('client-05 fmtCount：计数走 1000 进制，K/M 有效位随量级收紧', () => {
  const { fmtCount } = loadClient().exports.__test;
  assert.equal(fmtCount(900), '900');
  assert.equal(fmtCount(1234), '1.2K');
  assert.equal(fmtCount(12345), '12K');
  assert.equal(fmtCount(1000000), '1.0M');
  assert.equal(fmtCount(12000000), '12M');
  assert.equal(fmtCount(undefined), '—');
  assert.equal(fmtCount('abc'), '—', '解析不出来的数说 —，不冒充 0');
});

check('client-06 deltaCell：宿主给了 delta 才说话，没给是「新进」不是「持平」', () => {
  const { deltaCell } = loadClient().exports.__test;
  for (const [v, want] of [
    [4, { text: '▲4', cls: 'gt-up' }],
    [-2, { text: '▼2', cls: 'gt-down' }],
    [0, { text: '—', cls: 'gt-flat' }],
    [undefined, { text: '新进', cls: 'gt-flat' }],
    [null, { text: '新进', cls: 'gt-flat' }],
    ['3', { text: '新进', cls: 'gt-flat' }],
  ]) assert.deepEqual(plain(deltaCell(v)), want, `${String(v)} 的格子不对（'3' 不是有限数 ⇒ 不猜方向）`);
});

check('client-07 kindLabel 只吃载荷映射：没登记过的 kind 原样显示，不编文案', () => {
  const { kindLabel } = loadClient().exports.__test;
  assert.equal(kindLabel('board_enter'), '进榜');
  assert.equal(kindLabel('first_on_board'), '首次上榜');
  assert.equal(kindLabel('whatever'), 'whatever');
});

check('client-08 mergeFrame：update 帧整体替换，非快照帧原样留着', () => {
  const { mergeFrame } = loadClient().exports.__test;
  const prev = { at: 1, boards: {} };
  assert.equal(mergeFrame(prev, { at: 2, boards: {} }).at, 2, '不许做增量合并 —— 增量就得自己补字段');
  assert.equal(mergeFrame(prev, null), prev);
  assert.equal(mergeFrame(prev, 'x'), prev);
  assert.equal(mergeFrame(prev, { kind: 'event', at: 9 }), prev, '带 kind:event 的是变化帧，不是快照');
});

check('client-09 consumeSse：跨块拼帧、注释行丢弃、坏帧只丢这一帧', async () => {
  const { consumeSse } = loadClient().exports.__test;
  const parts = [
    ': ok\n\nevent: snapshot\ndata: {"at":1',
    '} \n\n',
    ': ping\n\nevent: update\ndata: {broken\n\n',
    'event: update\ndata: {"at":3}\n\n',
  ];
  let i = 0;
  const res = {
    body: {
      getReader: () => ({
        read: async () => (i < parts.length
          ? { done: false, value: new TextEncoder().encode(parts[i++]) }
          : { done: true }),
      }),
    },
  };
  const got = [];
  await consumeSse(res, (ev, data) => got.push([ev, data]));
  assert.deepEqual(got.map((g) => g[0]), ['snapshot', 'update'], '坏帧丢掉后流必须继续，下一帧就是全量快照');
  assert.deepEqual(plain(got[0][1]), { at: 1 }, '跨 chunk 的 data 要拼回来');
  assert.deepEqual(plain(got[1][1]), { at: 3 });
});

check('client-10 api()：拆 {ok,data} 信封，业务错误带 message+code，非 JSON 回 HTTP 状态', async () => {
  const calls = [];
  const { exports } = loadClient(PAYLOAD, {
    fetch: async (url, opts2) => {
      calls.push({ url, opts: opts2 });
      if (url.endsWith('/snapshot')) return { ok: true, status: 200, json: async () => ({ ok: true, data: { at: 5 } }) };
      if (url.endsWith('/check')) return { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'CHECK_BUSY', message: '已有一轮检查在跑' } }) };
      return { ok: false, status: 500, json: async () => { throw new Error('不是 JSON'); } };
    },
  });
  const { api } = exports.__test;
  assert.deepEqual(await api('/snapshot'), { at: 5 });
  const busy = await api('/check', { method: 'POST' }).then(() => null, (x) => x);
  assert.equal(busy.message, '已有一轮检查在跑');
  assert.equal(busy.code, 'CHECK_BUSY', 'code 要跟着抛出去，界面才分得清「忙」和「坏」');
  const bad = await api('/nope').then(() => null, (x) => x);
  assert.equal(bad.message, 'HTTP 500');
  assert.equal(calls[0].url, '/gh-trending/api/snapshot');
});

/* ---------------- 页头与三榜状态 ---------------- */
check('client-11 页头信号：坏榜点名 > 无数据 > 三榜在位，等待首帧不装好', () => {
  const { Header } = loadClient().exports.__test.components;
  const pill = (snap, conn = { ok: true, note: '' }, lastErr = '') => {
    const node = findByClass(render(Header, { snap, conn, checking: false, lastErr, onCheck() {} }), 'gt-pill')[0];
    return { text: text(node), cls: node.children[0].props.className, tip: node.props.title || '' };
  };
  assert.deepEqual([pill(null).text, pill(null).cls], ['等待首帧', 'gt-dot'], '没快照就是没快照');
  const allOk = pill(snapFixture());
  assert.equal(allOk.text, '三榜数据在位');
  assert.match(allOk.cls, /gt-dot-ok/);
  const twoBad = pill(snapFixture({ boards: {
    daily: { label: '日榜', hasData: true, ok: true, at: 1, lastFetchAt: 1, rowsTotal: 3, rows: [], empty: false },
    weekly: { label: '周榜', hasData: true, ok: false, error: '趋势页返回 500', at: 1, lastFetchAt: 1, rowsTotal: 3, rows: [], empty: false },
    monthly: { label: '月榜', hasData: true, ok: false, error: '超时', at: 1, lastFetchAt: 1, rowsTotal: 0, rows: [], empty: true },
  } }));
  assert.equal(twoBad.text, '周榜、月榜故障', '坏榜逐榜点名');
  assert.match(twoBad.cls, /gt-dot-err/);
  assert.match(twoBad.tip, /周榜：趋势页返回 500/);
  assert.match(twoBad.tip, /月榜：超时/);
  const noData = pill(snapFixture({ boards: { daily: { hasData: false }, weekly: { hasData: false }, monthly: { hasData: false } } }));
  assert.equal(noData.text, '还没有榜面数据');
  assert.ok(!/gt-dot-(ok|err)/.test(noData.cls), '没数据不是故障，不许点红');
  const withErr = pill(snapFixture(), { ok: false, note: '推流断开，正在重连' }, '宿主忙');
  assert.match(withErr.tip, /推流断开/);
  assert.ok(!/检查失败/.test(withErr.tip), '检查失败是页头上的可见文字，不该只藏在悬浮提示里');
  // 手动检查的回执跟着按钮走：页签化之后它必须常驻页头，不能只活在某一个页签里
  const headText = (props) => text(render(Header, {
    snap: snapFixture(), conn: { ok: true, note: '' }, checking: false, onCheck() {}, ...props,
  }));
  assert.match(headText({ lastErr: '宿主忙' }), /检查失败：宿主忙/);
  const errNode = findByClass(render(Header, { snap: snapFixture(), conn: { ok: true, note: '' }, checking: false, lastErr: '宿主忙', onCheck() {} }), 'gt-receipt-err')[0];
  assert.ok(errNode, '失败回执要有失败的颜色，不能和跑完一轮的告知一个样');
  assert.match(text(findByClass(render(Header, { snap: snapFixture(), conn: { ok: true, note: '' }, checking: false, checkNote: '本轮 10:33 完成，记录 2 项变化', onCheck() {} }), 'gt-receipt')[0]),
    /本轮 10:33 完成，记录 2 项变化/);
  assert.ok(!hasCls(findByClass(render(Header, { snap: snapFixture(), conn: { ok: true, note: '' }, checking: false, checkNote: '本轮 10:33 完成', onCheck() {} }), 'gt-receipt')[0], 'gt-receipt-err'),
    '跑完一轮不是成功状态：三榜全红时页头再抹一道绿，等于两头互相打脸');
  assert.equal(findByClass(render(Header, { snap: snapFixture(), conn: { ok: true, note: '' }, checking: false, lastErr: '', onCheck() {} }), 'gt-receipt').length, 0,
    '没点过检查就不许凭空摆一条回执');
});

check('client-12 页头控件：首帧前与检查中都不许再点，标题与语言来自载荷', () => {
  const { Header } = loadClient().exports.__test.components;
  const btn = (snap, checking) => findByClass(render(Header, { snap, conn: { ok: true, note: '' }, checking, lastErr: '', onCheck() {} }), 'gt-btn-main')[0];
  assert.equal(btn(null, false).props.disabled, true);
  assert.equal(btn(snapFixture(), true).props.disabled, true);
  assert.equal(btn(snapFixture(), false).props.disabled, false);
  assert.equal(text(btn(snapFixture(), true)), '检查中…');
  const t = text(render(Header, {
    snap: snapFixture({ prefs: { intervalMin: 180, topN: 15, keepEvents: 300, language: 'rust' } }),
    conn: { ok: true, note: '' }, checking: false, lastErr: '', onCheck() {},
  }));
  assert.match(t, /GitHub 热榜/);
  assert.match(t, /只看 rust/, '语言过滤生效时页头要说，否则用户以为榜变小了');
  assert.match(t, /检查于 /);
});

check('client-13 三榜状态卡：各挂各的闸，坏榜说清「显示的是上次成功数据」', () => {
  const { StatusCard } = loadClient().exports.__test.components;
  const snap = snapFixture({ boards: {
    daily: { label: '日榜', hasData: true, ok: true, at: atOff(-120000), lastFetchAt: atOff(-120000), bodyChangedAt: 1, failStreak: 0, transport: false, rowsTotal: 15, rows: [], empty: false },
    weekly: { label: '周榜', hasData: true, ok: false, error: '趋势页返回 500', at: atOff(-7200000), lastFetchAt: atOff(-60000), bodyChangedAt: 1, failStreak: 2, transport: false, rowsTotal: 19, rows: [], empty: false },
    monthly: { label: '月榜', hasData: false, ok: false, error: '还没跑过第一轮检查', at: 0, lastFetchAt: 0, bodyChangedAt: 0, failStreak: 0, transport: false, rowsTotal: 0, rows: [], empty: true },
  } });
  const tree = render(StatusCard, { snap, conn: { ok: false, note: '推流不可用：fetch 不存在' }, lastErr: '' });
  const rows = findByClass(tree, 'gt-srcrow');
  assert.equal(rows.length, 3, '一张榜一行，缺榜不许少一行冒充正常');
  const d = text(rows[0]);
  assert.match(d, /日榜/);
  assert.match(d, /榜上 15 条/);
  assert.match(d, /榜面数据 2 分钟前/);
  assert.match(d, /最近取回 2 分钟前/, '304 轮只推 lastFetchAt，两个时钟要分开说');
  const w = text(rows[1]);
  assert.match(w, /故障 · 趋势页返回 500/);
  assert.match(w, /显示 2 小时前的上次成功数据/, '冻结口径必须说清显示的是旧档');
  assert.match(text(rows[2]), /故障 · 还没跑过第一轮检查/);
  assert.ok(!/显示 /.test(text(rows[2])), '没有旧档就不许编「显示上次成功数据」');
  assert.ok(rows[0].children[0].props.className.includes('gt-dot-ok'));
  assert.ok(rows[1].children[0].props.className.includes('gt-dot-err'), '好/坏各点各的灯');
  const notes = findByClass(tree, 'gt-notice');
  assert.equal(notes.length, 1);
  assert.equal(text(notes[0]), '推流不可用：fetch 不存在');
});

check('client-14 三榜状态卡：存储掉线 / 推流断开就地落卡（零浮层）', () => {
  const { StatusCard } = loadClient().exports.__test.components;
  const snap = { ...snapFixture(), storage: { available: false } };
  const tree = render(StatusCard, { snap, conn: { ok: false, note: '推流断开，正在重连' } });
  const notices = findByClass(tree, 'gt-notice');
  assert.equal(notices.length, 2);
  assert.match(text(notices[0]), /存储不可用/);
  assert.ok(hasCls(notices[0], 'gt-notice-err'), '存储坏了是红色左边，不是普通提示');
  assert.ok(!hasCls(notices[1], 'gt-notice-err'), '推流断开只是提示档');
  assert.ok(!/检查失败/.test(text(tree)),
    '手动检查的回执归页头（每个页签都看得见），三榜卡不重复播报一遍');
  assert.ok(!/toast|notification|alert\(/.test(clientSrc()), '界面里不许有浮层、通知或弹窗');
});

/* ---------------- 榜单表 ---------------- */
check('client-15 榜单表列模板：col / th / td 逐列同数，右对齐列头有压过 th 的点名规则', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  const tree = render(BoardCard, { snap: snapFixture(), board: 'daily' });
  const tbl = findAllType(tree, 'table')[0];
  assert.ok(tbl, '表格没渲染出来，判据空转');
  const cols = kidsOf(kidsOf(tbl, 'colgroup')[0], 'col');
  const ths = cellsOf(tbl, 'thead');
  const tds = cellsOf(tbl, 'tbody');
  assert.equal(cols.length, 8);
  assert.equal(ths.length, cols.length, '表头列数 ≠ 列模板');
  assert.equal(tds.length, cols.length, '数据格数 ≠ 列模板（fixed 布局下整行错位）');
  const seq = (list) => list.map((n) => hasCls(n, 'gt-r')).join(',');
  assert.equal(seq(ths), seq(tds), '表头与列值对齐方向逐列不一致');
  assert.equal(seq(ths), 'true,false,false,false,true,true,true,false');
  assert.deepEqual(ths.map(text), ['#', '仓库', '描述', '语言', '累计 ★', '今日新增', '较上轮', '']);
  assert.ok(hasCls(ths[7], 'gt-tail') && text(ths[7]) === '', '兜底列必须空且带 gt-tail');
  const tailCol = cols[7];
  assert.ok(hasCls(tailCol, 'gt-tail') && !tailCol.props.style, '兜底列宽度归 CSS，不许内联写宽');
  assert.equal(cols[0].props.style.width, 46);
  assert.ok(hasCls(cols[1], 'gt-col-repo') && !cols[1].props.style, '仓库列宽走 CSS（窄视口要能回退）');
  assert.ok(hasCls(cols[2], 'gt-col-desc') && !cols[2].props.style, '描述列 width:auto 吃余量');

  const code = clientSrc();
  assert.match(code, /\.gt-tbl th\{[^}]*text-align:left/);
  assert.match(code, /\.gt-tbl th\.gt-r\{text-align:right\}/, '缺这条点名 ⇒ th 默认左对齐压过 .gt-r，表头跟列值错开');
  assert.match(code, /\.gt-tbl\{[^}]*table-layout:fixed/);
  assert.match(code, /\.gt-tbl col\.gt-col-repo\{width:268px\}/);
  assert.match(code, /\.gt-tbl col\.gt-col-desc\{width:auto\}/);
  assert.match(code, /\.gt-tbl col\.gt-tail,\.gt-tbl th\.gt-tail,\.gt-tbl td\.gt-tail\{width:0;padding:0\}/, '兜底列恒为 0，不能只写在媒体查询里');
  const mq = (code.match(/@media \(max-width:1000px\)\{[^\n]*\}/) || [])[0];
  assert.ok(mq, '缺窄视口回退');
  assert.match(mq, /col\.gt-col-repo\{width:auto\}/);
  assert.match(mq, /col\.gt-col-desc\{width:160px\}/);
  assert.ok(!/col\.gt-tail/.test(mq), '兜底列收起规则不许只写在媒体查询里（否则宽视口空洞又回到表尾）');
  // 三个数值列的死数：累计★ / 新增 / 较上轮 —— 用户口径「第四列窄一点」，量出来的需宽都放得下（见 §9.3 第五轮）
  assert.deepEqual(cols.slice(3, 7).map((c) => c.props.style.width), [112, 64, 72, 56],
    '数值列宽改了要连同 tmp/probe-cols.mjs 的需宽读数一起对，别把"新进 / 154.3K / 本周新增"挤断');
});

/** ★ 真机病历 2026-10-05（用户截图）：`col.gt-repo` 与 `a.gt-repo`、`col.gt-desc` 与 `span.gt-desc` 撞名，
 *  而单元格那两条带 `display:block` —— col 一被改成 block 就**退出列布局**，整表列宽从它俩起向左错两格：
 *  仓库吃 104（那是给语言的）、描述吃 78、本轮新增吃兜底列的 0（整列隐形），余量全灌进「较上轮」。
 *  上面那条断言钉的是**规则原文**，原文在、规则不生效 —— 所以这条钉的是"名字不许撞"这个前提。 */
check('client-46 列模板的类名不许和格子里的元素撞名（col 被改成 display:block 就退出列布局）', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  const tree = render(BoardCard, { snap: snapFixture(), board: 'daily' });
  const cols = kidsOf(kidsOf(findAllType(tree, 'table')[0], 'colgroup')[0], 'col');
  const colCls = cols.map((c) => String(c.props.className || '')).filter(Boolean);
  assert.ok(colCls.length >= 1, 'colgroup 里一个带类名的列都没有 ⇒ 这条判据没东西可扫了（列名本身在 client-15 钉）');
  const css = (clientSrc().match(/const CSS = `([\s\S]*?)`;/) || [])[1];
  assert.ok(css, '抠不出 CSS 原文 ⇒ 这条判据没东西可扫');
  const offenders = [];
  // 注释先剥掉：规则前面挂一段注释就会让下面的选择器判据认不出裸类（真机那次撞名的写法正是带注释的）
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*\}/g) || []) {
    if (!/display\s*:/.test(rule)) continue;
    const sel = rule.split('{')[0];
    for (const one of sel.split(',')) {
      const bare = one.trim();
      // 只认"裸类"选择器（`.gt-repo`）：带标签或祖先限定的（`a.gt-repo` / `.gt-tbl col.gt-col-repo`）打不到 col
      if (/^\.[\w-]+$/.test(bare) && colCls.includes(bare.slice(1))) offenders.push(`${bare} → ${bare.slice(1)} 也是列名`);
    }
  }
  assert.deepEqual(offenders, [], `这些类既是列名又被裸类规则改了 display ⇒ 列宽整体错位：${offenders.join(' / ')}`);
});

/** 描述列的中文来自内置离线预译表（2026-10-05 裁定的 B）：钉的是渲染结果，不是代码里那句话。 */
check('client-47 描述列：命中预译的行显示译文、悬停看得见原文，没命中的行仍是原文（同一列两种来源要分得清）', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  const zh = DESC_ZH_ROWS[0][2];
  const tree = render(BoardCard, { snap: snapFixture(), board: 'daily' });
  const trs = kidsOf(kidsOf(findAllType(tree, 'table')[0], 'tbody')[0], 'tr');
  assert.equal(trs.length, 3, `夹具给的是 3 行，实得 ${trs.length} ⇒ 判据扫不到现场`);
  const descCell = (i) => kidsOf(trs[i], 'td')[2];
  const span = (i) => descCell(i).children[0];
  assert.equal(text(descCell(0)), zh, 'a/one 在命中表里 ⇒ 描述列该显示译文');
  assert.equal(span(0).props.title.includes(`原文：${DESC_ZH_ROWS[0][1]}`), true,
    '悬停必须看得见原文：译文是预译的，读的人有权核对翻的是哪一句');
  assert.equal(span(0).props.title.includes(DESC_ZH_NOTE), true, '悬停里那句来源 + 时间戳该是宿主给的原话');
  assert.equal(span(0).props.title.includes(DESC_ZH_LABEL), true, '落款跟着**这一行自己的**来源走');
  assert.equal(text(descCell(1)), '一个描述', '没命中的行被译文串台 = 指鹿为马');
  assert.equal(text(descCell(2)), '一个描述');
  assert.equal(span(1).props.title, '一个描述', '没译文时悬停就是原文，别挂半句解释');

  // 第二十二轮：同一列并排两种来源，现译那一行说的是另一套话（不许拿内置那句落款盖它）
  const w = render(BoardCard, { snap: snapFixture(), board: 'weekly' });
  const wTr = kidsOf(kidsOf(findAllType(w, 'table')[0], 'tbody')[0], 'tr')[0];
  const wSpan = kidsOf(wTr, 'td')[2].children[0];
  assert.equal(text(kidsOf(wTr, 'td')[2]), '这一句是现译的中文', '库里逐字命中的现译行照样上屏（这一轮的改判点）');
  assert.equal(wSpan.props.title.includes(`原文：A plain english line`), true);
  assert.equal(wSpan.props.title.includes(DESC_ZH_LIVE_NOTE), true, '现译那一行悬停给的是现译那句说明，不是内置表的注');
  assert.equal(wSpan.props.title.includes(DESC_ZH_NOTE), false, '两种来源的说明句不许同时出现在一行上');
  assert.equal(wSpan.props.title.includes(engineZhLabel('keyless', atOff(-120000))), true,
    '落款的档名与时刻读的是库里那一行（客户端不自己起名、不自己编日期）');
});

check('client-48 卡头那句中文来源只在真有命中的卡上出现，整句逐字读载荷（客户端不许自己数条数、编日期）', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  const headSub = (board, snap) => kidsOf(findByClass(render(BoardCard, { snap, board }), 'gt-card-h')[0], 'span')[1];
  const daily = headSub('daily', snapFixture());
  assert.equal(text(daily).includes(`描述中译为${DESC_ZH_LABEL}`), true, '命中了却不报来源与时间戳 = 让人误以为是现译');
  const weekly = text(headSub('weekly', snapFixture()));
  assert.equal(weekly.includes('描述中文为现译 1 条'), true, '第二十二轮：这一榜的中文来自补译，句子要跟着说实话');
  assert.equal(weekly.includes('预译'), false, '现译那一档不许混进内置表的词');
  // 载荷说是什么就是什么：换成别的句子，界面跟着换 ⇒ 证明它读的是载荷，不是自己拼的
  const swapped = snapFixture({
    descZh: {
      hits: { 'a/two': { zh: '甲乙丙', via: 'live', label: '换过的来源 · 2099-01-01', note: '换过的注', src: 'x' } },
      heads: { daily: '载荷给的那一整句', weekly: '', monthly: '' },
      liveNote: '',
    },
  });
  assert.equal(text(headSub('daily', swapped)).includes('载荷给的那一整句'), true);
  assert.equal(text(headSub('daily', swapped)).includes('条'), false, '条数由宿主算：界面自己数一遍就是第二份真相');
  assert.equal(text(headSub('weekly', swapped)).includes('描述中文'), false, 'heads 给空串 ⇒ 整段不出现');
  assert.equal(text(headSub('monthly', swapped)).includes('描述中文'), false, '空榜没行，别说这句');
  const noHit = snapFixture({ descZh: { hits: {}, heads: { daily: '', weekly: '', monthly: '' }, liveNote: '' } });
  assert.doesNotMatch(text(headSub('daily', noHit)), /描述中文/, '一个都没命中还挂着来源标签 = 多此一举');
});

check('client-58 现译这一路发不出去时榜面给一句实话（.gt-notice），其余三种情形一个字都不多', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  const notices = (board, over = {}) => {
    const tree = render(BoardCard, { snap: snapFixture({ descZh: { hits: {}, heads: { daily: '', weekly: '', monthly: '' }, liveNote: DESC_ZH_BLOCKED_NOTE, ...over } }), board });
    return findByClass(tree, 'gt-notice').map((n) => text(n));
  };
  assert.equal(notices('daily').some((t) => t === DESC_ZH_BLOCKED_NOTE), true, '宿主给了那句实话 ⇒ 榜面原样念，一个字不改');
  assert.equal(notices('monthly').length, 0, '月榜那一档没有行（rows 空）⇒ 不挂这句：那屏连原文都没显示，说"只显内置预译"是空话');
  const quiet = findByClass(
    render(BoardCard, { snap: snapFixture({ descZh: { hits: {}, heads: { daily: '', weekly: '', monthly: '' }, liveNote: '' } }), board: 'daily' }),
    'gt-notice',
  );
  assert.equal(quiet.length, 0, 'liveNote 是空串（开关关着 / 发得出去 / 没有欠着的行）时不许凭空多一段');
});

check('client-16 新增列名跟着榜走：今日 / 本周 / 本月来自载荷，缺载荷回落中性词', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  // 空榜不渲染表（client-20 的口径），所以逐榜判列名得先给每档塞一行
  const withRow = (board) => snapFixture({ boards: { ...snapFixture().boards,
    [board]: { ...snapFixture().boards[board], rows: [row('x/1', 1)], rowsTotal: 1, empty: false } } });
  const addedLabel = (tree) => text(cellsOf(findAllType(tree, 'table')[0], 'thead')[5]);
  for (const board of BOARDS) {
    assert.equal(addedLabel(render(BoardCard, { snap: withRow(board), board })),
      BOARD_ADDED_LABELS[board], `${board} 的新增列名不对`);
  }
  const { exports: bare } = loadClient({ ...PAYLOAD, boardAddedLabels: undefined });
  assert.equal(addedLabel(render(bare.__test.components.BoardCard, { snap: withRow('monthly'), board: 'monthly' })),
    '新增', '不许拿日榜文案套月榜');
});

check('client-17 页签条：七签齐且有序，当前签高亮，计数徽标只在有数时出现', () => {
  const { TabBar } = loadClient().exports.__test.components;
  const clicked = [];
  const snap = snapFixture({ events: [{ id: 'e1', at: AT, kind: 'board_enter', repo: 'a/one' }] });
  const tree = render(TabBar, { tab: 'weekly', onTab: (t) => clicked.push(t), snap });
  const nav = findByClass(tree, 'gt-tabs')[0];
  assert.ok(nav, '页签条没渲染出来，判据空转');
  const btns = kidsOf(nav, 'button');
  assert.deepEqual(btns.map((b) => b.children[0]), ['总览', '日榜', '周榜', '月榜', '明星仓库', '变化记录', '设置'],
    '三榜签标题来自载荷 boardLabels，其余四个是界面结构名（★ 第二十三轮插入第七签「明星仓库」，位置紧跟三榜：它读的是同一批榜史）');
  assert.deepEqual(btns.map((b) => hasCls(b, 'on')), [false, false, true, false, false, false, false]);
  for (const b of btns) b.props.onClick();
  assert.deepEqual(clicked, ['overview', 'daily', 'weekly', 'monthly', 'stars', 'events', 'settings'], '回调必须带页签键');
  assert.deepEqual(findByClass(tree, 'gt-tab-n').map(text), ['20', '20', String(snap.stars.rows.length), '1'],
    '徽标 = 该榜榜面条数 / 明星那一屏的行数 / 流水条数；0 与缺位都不给徽标（0 冒充有数最坏）');

  const first = render(TabBar, { tab: 'overview', onTab() {}, snap: undefined });
  assert.equal(kidsOf(findByClass(first, 'gt-tabs')[0], 'button').length, 7, '首帧前七签照样齐');
  assert.deepEqual(findByClass(first, 'gt-tab-n').map(text), [], '没有快照就不许编计数');
  assert.ok(kidsOf(findByClass(first, 'gt-tabs')[0], 'button')[0].props.className.includes('on'));

  const { exports: bare } = loadClient({ ...PAYLOAD, boardLabels: undefined });
  const t = text(render(bare.__test.components.TabBar, { tab: 'x', onTab() {}, snap }));
  assert.ok(/daily/.test(t), '载荷缺 boardLabels 时回落榜单键本身，不编中文名');
});

check('client-18 计数徽标：显示切出来的条数 / 榜面真实条数，来源注来自载荷', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  const tree = render(BoardCard, { snap: snapFixture(), board: 'daily' });
  assert.equal(text(findByClass(tree, 'gt-card-n')[0]), '3 / 20 条', 'topN 截了 3 行也要说榜上本来 20 条');
  assert.match(text(tree), /榜面数据 1 分钟前 · 最近取回 1 分钟前/, '页签化后两个时钟都上卡头，304 轮才看得出差别');
  const bad = render(BoardCard, { snap: snapFixture({ boards: { ...snapFixture().boards,
    daily: { ...snapFixture().boards.daily, ok: false, transport: true, error: '超时', failStreak: 2 } } }), board: 'daily' });
  assert.match(text(bad), /最近尝试 /, '坏榜的 lastFetchAt 是「发起尝试」的时刻：没取回成功就不能写「最近取回」（真机截图抓到）');
  assert.ok(!/最近取回/.test(text(bad)));
  assert.equal(text(findByClass(tree, 'gt-note')[0]), TRENDING_SOURCE_NOTE);
  const noNote = render(BoardCard, { snap: { ...snapFixture(), sourceNote: undefined }, board: 'daily' });
  assert.equal(text(findByClass(noNote, 'gt-note')[0]), '来源文案未就位');
});

check('client-19 行内状态：新面孔 / 改名 / 升降 / 缺描述与缺语言都如实写', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  const snap = snapFixture({ boards: {
    ...snapFixture().boards,
    daily: { label: '日榜', hasData: true, ok: true, at: AT, lastFetchAt: AT, bodyChangedAt: 1, failStreak: 0, rowsTotal: 3, rows: [
      row('a/new', 1, { fresh: true, delta: undefined }),
      row('a/renamed', 2, { renamedFrom: 'a/old', name: 'a/new-name', desc: '' }),
      row('a/nolang', 3, { lang: undefined, langColor: undefined, delta: -1 }),
    ] },
  } });
  const tree = render(BoardCard, { snap, board: 'daily' });
  const trs = kidsOf(kidsOf(findAllType(tree, 'table')[0], 'tbody')[0], 'tr');
  assert.equal(trs.length, 3);
  assert.ok(hasCls(trs[0], 'gt-new'), '本机首次见到的行要有底色');
  assert.deepEqual(findByClass(trs[0], 'gt-tag').map(text), ['新面孔']);
  assert.ok(texts(trs[0]).includes('新进'), 'delta 缺失的行说新进');
  assert.deepEqual(findByClass(trs[1], 'gt-tag').map(text), ['原 a/old']);
  assert.match(text(trs[1]), /a\/new-name/);
  const link = findAllType(trs[0], 'a')[0];
  assert.equal(link.props.href, 'https://github.com/a/new');
  assert.equal(link.props.target, '_blank');
  assert.equal(link.props.rel, 'noreferrer', '新窗口外链不许带 referer');
  assert.equal(link.props.title, 'a/new', '显示名可能大小写不同，title 给主键');
  assert.equal(text(kidsOf(trs[1], 'td')[2]), '—', '无描述的仓库（实测确实有）说 —，不留空行');
  assert.equal(text(kidsOf(trs[2], 'td')[3]), '—', '无语言仓库不是解析失败');
  assert.equal(findByClass(trs[2], 'gt-lang').length, 0);
  assert.equal(findAllType(kidsOf(trs[0], 'td')[3], 'i')[0].props.style.background, '#dea584', '语言色用页面原值，插件不另存色表');
  assert.equal(text(kidsOf(trs[2], 'td')[6]), '▼1');
});

check('client-20 空榜与坏榜的措辞分开：这一档真没人上榜 ≠ 没取到', () => {
  const { BoardCard } = loadClient().exports.__test.components;
  const boards = (board, v) => ({ ...snapFixture().boards, [board]: v });
  const emptyOk = { label: '月榜', hasData: true, ok: true, at: AT, lastFetchAt: AT, bodyChangedAt: 1, failStreak: 0, rowsTotal: 0, rows: [], empty: true };
  let tree = render(BoardCard, { snap: snapFixture({ boards: boards('monthly', emptyOk) }), board: 'monthly' });
  let t = text(tree);
  assert.match(t, /这一档今天没有上榜仓库/);
  assert.ok(!/故障/.test(t), '空榜不是故障');
  assert.equal(findAllType(tree, 'table').length, 0, '空榜不渲染表');

  const badWithRows = { label: '周榜', hasData: true, ok: false, error: '趋势页返回 500', at: AT, lastFetchAt: AT, bodyChangedAt: 1, failStreak: 1, rowsTotal: 19, rows: [row('w/one', 1)], empty: false };
  tree = render(BoardCard, { snap: snapFixture({ boards: boards('weekly', badWithRows) }), board: 'weekly' });
  t = text(tree);
  assert.match(t, /本轮周榜故障：趋势页返回 500/);
  assert.match(t, /下面显示的是上次成功数据/);
  assert.equal(findByClass(tree, 'gt-notice-err').length, 1);
  assert.equal(findAllType(tree, 'table').length, 1, '坏轮不许把自己清空');

  const never = { label: '日榜', hasData: false, ok: false, error: '还没跑过第一轮检查', at: 0, lastFetchAt: 0, bodyChangedAt: 0, failStreak: 0, rowsTotal: 0, rows: [], empty: true };
  t = text(render(BoardCard, { snap: snapFixture({ boards: boards('daily', never) }), board: 'daily' }));
  assert.match(t, /日榜：还没跑过第一轮检查/);
});

/* ---------------- 跨榜 / 流水 / 设置 / 环境 ---------------- */
check('client-21 跨榜同现：升温说跨度与最好名次，收敛点名退掉的榜', () => {
  const { CrossCard } = loadClient().exports.__test.components;
  const snap = snapFixture({ cross: {
    rising: [{ repo: 't/three', name: 'T/Three', span: 3, boards: ['daily', 'weekly', 'monthly'], bestRank: 4 },
      { repo: 'p/pair', name: 'P/Pair', span: 2, boards: ['daily', 'weekly'], bestRank: 2 }],
    cooling: [{ repo: 'c/one', name: 'C/One', lostBoards: ['monthly'], boards: ['daily'] }],
    note: '跨榜同现由这一次检查的三张榜交叉算出，不额外发请求。',
  } });
  const t = text(render(CrossCard, { snap }));
  assert.match(t, /持续升温/);
  assert.match(t, /热度回落/, '收敛段的段标题是本页措辞，不复用事件枚举「热度收敛」');
  assert.match(t, /日榜 \+ 周榜 \+ 月榜/, '榜名逐档翻译');
  assert.match(t, /最高第 4 名/);
  assert.match(t, /退出 月榜/);
  assert.match(t, /同时上 ≥2 张榜/, '阈值来自载荷 crossMin');
  assert.match(t, /不额外发请求/);
  const empty = text(render(CrossCard, { snap: snapFixture() }));
  assert.match(empty, /这一轮没有仓库同时在多张榜上/);
  assert.match(empty, /没有仓库从多榜掉到只剩一榜/);
  assert.ok(!/undefined|NaN/.test(empty), '空态里不许漏出未定义的键');
});

check('client-22 变化流水：类型片 / 榜名 / 详情三段齐，时间吃快照时钟', () => {
  const { EventsCard } = loadClient().exports.__test.components;
  const snap = snapFixture({ events: [
    { id: 'e-1', at: AT - 5 * 60000, kind: 'board_enter', board: 'daily', repo: 'a/one', detail: '第 1 名' },
    { id: 'e-2', at: AT - 3600000, kind: 'source_error', repo: '', detail: '趋势页返回 500' },
    { id: 'e-3', at: AT - 2 * 86400000, kind: 'renamed', board: 'weekly', repo: 'a/renamed', detail: 'a/old → a/new' },
  ] });
  const tree = render(EventsCard, { snap });
  assert.equal(text(findByClass(tree, 'gt-card-n')[0]), '3 条');
  const lis = kidsOf(findByClass(tree, 'gt-tl')[0], 'li');
  assert.equal(lis.length, 3);
  assert.deepEqual(lis.map((li) => text(kidsOf(li, 'span')[0])), ['进榜', '数据源故障', '仓库改名']);
  assert.equal(texts(kidsOf(lis[0], 'span')[1]).join('|'), 'a/one|日榜|第 1 名');
  assert.equal(texts(kidsOf(lis[1], 'span')[1]).join('|'), '趋势页返回 500', '不属于任何榜的事件不许挂榜名');
  assert.equal(text(findByClass(lis[0], 'gt-ago')[0]), '5 分钟前');
  assert.equal(text(findByClass(lis[1], 'gt-ago')[0]), '1 小时前');
  assert.equal(text(findByClass(lis[2], 'gt-ago')[0]), '2 天前');
  assert.deepEqual(lis.map((li) => li.props['data-kind']), ['board_enter', 'source_error', 'renamed'], 'data-kind 是圆点配色的唯一把手');
  const noStore = text(render(EventsCard, { snap: { ...snapFixture({ events: [] }), storage: { available: false } } }));
  assert.match(noStore, /存储不可用，变化不会留痕/);
  assert.match(text(render(EventsCard, { snap: snapFixture({ events: [] }) })), /还没有记录/);
});

check('client-23 设置卡：档位高亮自库里的偏好，越界按钮当场哑掉', () => {
  const { SettingsCard } = loadClient().exports.__test.components;
  const saved = [];
  const mk = (prefs) => render(SettingsCard, {
    snap: { ...snapFixture(), prefs },
    saving: false, savedNote: '', savedErr: false, language: prefs.language,
    onLanguage() {}, onInterval() {}, onSave: (p) => saved.push(p),
  });
  const tree = mk({ intervalMin: 180, topN: 15, keepEvents: 300, language: '' });
  const segBtns = kidsOf(findByClass(setRow(tree, '检查间隔'), 'gt-seg')[0], 'button');
  assert.deepEqual(segBtns.map(text), ['1 小时', '3 小时', '12 小时', '24 小时'], '档位文案来自载荷');
  assert.deepEqual(segBtns.map((b) => hasCls(b, 'on')), [false, true, false, false]);
  const mid = findByClass(tree, 'gt-step');
  assert.equal(mid.length, 4, '两个步进器各一对加减');
  assert.deepEqual(mid.map((b) => b.props.disabled), [false, false, false, false]);
  const atMin = findByClass(mk({ intervalMin: 180, topN: TOP_N_MIN, keepEvents: KEEP_EVENTS_MIN, language: '' }), 'gt-step');
  assert.deepEqual(atMin.map((b) => b.props.disabled), [true, false, true, false], '到下限不许再减（顺序：topN− topN+ keep− keep+）');
  const atMax = findByClass(mk({ intervalMin: 180, topN: TOP_N_MAX, keepEvents: KEEP_EVENTS_MAX, language: '' }), 'gt-step');
  assert.deepEqual(atMax.map((b) => b.props.disabled), [false, true, false, true], '到上限不许再加');
  atMax[0].props.onClick();
  atMax[2].props.onClick();
  assert.deepEqual(plain(saved), [{ topN: TOP_N_MAX - 1 }, { keepEvents: KEEP_EVENTS_MAX - KEEP_EVENTS_STEP }]);
  const labels = text(tree);
  assert.match(labels, /条（5–25，超出榜长即显示全榜）/);
  assert.match(labels, /条（超出裁老，50–2000）/);
  assert.match(labels, /检查间隔/);
  assert.match(labels, /语言过滤/);
});

check('client-24 设置卡：语言是自由文本 + 保存按钮，判定口径来自载荷', () => {
  const { SettingsCard } = loadClient().exports.__test.components;
  const sent = [];
  const tree = render(SettingsCard, {
    snap: snapFixture(), saving: false, savedNote: '', savedErr: false, language: 'typescript',
    onLanguage() {}, onInterval() {}, onSave: (p) => sent.push(p),
  });
  const langRow = setRow(tree, '语言过滤');
  const input = findAllType(langRow, 'input')[0];
  assert.equal(input.props.value, 'typescript');
  assert.equal(input.props.type, 'text');
  assert.match(input.props.placeholder, /留空 = 全站/);
  const save = findByClass(langRow, 'gt-btn').filter((b) => text(b) === '保存');
  assert.equal(save.length, 1, '语言行自己只有一个保存（出网方式那行的保存在另一行，见 client-39）');
  save[0].props.onClick();
  assert.deepEqual(plain(sent), [{ language: 'typescript' }]);
  assert.match(text(tree), /站点不认识这个语言/, 'langCheck 文案来自载荷');
  // 载荷没到：不渲染控件，免得用户对着默认值改
  const { exports: bare } = loadClient({ ...PAYLOAD, intervals: undefined, intervalLabels: undefined });
  const t = text(render(bare.__test.components.SettingsCard, {
    snap: snapFixture(), saving: false, savedNote: '', savedErr: false, language: '', onLanguage() {}, onInterval() {}, onSave() {},
  }));
  assert.match(t, /配置未就位/);
  assert.match(text(render(SettingsCard, {
    snap: null, saving: false, savedNote: '', savedErr: false, language: '', onLanguage() {}, onInterval() {}, onSave() {},
  })), /配置未就位/);
});

check('client-25 保存反馈：成功与失败各有各的颜色，判定看状态位不看文案前缀', () => {
  const { SettingsCard } = loadClient().exports.__test.components;
  const props = (savedNote, savedErr, saving = false) => render(SettingsCard, {
    snap: snapFixture(), saving, savedNote, savedErr, language: '', onLanguage() {}, onInterval() {}, onSave() {},
  });
  const ok = findByClass(props('已保存', false), 'gt-saved')[0];
  assert.equal(text(ok), '已保存');
  const bad = findByClass(props('保存失败：越界', true), 'gt-sub').filter((n) => text(n).startsWith('保存失败'))[0];
  assert.ok(bad, '失败反馈没落在提示档上');
  assert.equal(findByClass(props('保存失败：越界', true), 'gt-saved').length, 0, '失败不许顶着成功绿（文案里就带「失败」二字，靠字符串猜会绿）');
  assert.match(text(props('', false, true)), /保存中…/);
  // 整页必须把状态位传下去，并且 catch 分支真的置位
  const src = clientSrc();
  assert.match(src, /savedErr \? 'gt-sub' : 'gt-saved gt-num'/);
  assert.match(src, /setSavedErr\(true\)/);
});

check('client-26 运行环境卡：能力表与传输路径逐行照宿主说的，缺表就说缺', () => {
  const { EnvCard } = loadClient().exports.__test.components;
  const snap = snapFixture();
  const tree = render(EnvCard, { snap });
  const rows = findByClass(tree, 'gt-srcrow');
  assert.equal(rows.length, 3);
  // 传输路径排在能力表之前：用户点开这一页的来意是「抓取为什么失败」
  assert.equal(text(rows[0]), `传输路径${snap.net.text}`);
  assert.ok(rows[0].children[0].props.className.includes('gt-dot-ok'), '路走通了就是绿点，别用中性档含糊过去');
  assert.match(rows[0].children[2].props.title, /registry/, 'title 给机器键，正文给人话');
  assert.equal(text(rows[1]), '本地存储在位');
  assert.match(text(rows[2]), /宿主定时器/);
  assert.match(text(rows[2]), /宿主未提供 ctx\.timer\.interval/, '降级原因照宿主原文，界面不自己解释一遍');
  assert.ok(rows[2].children[0].props.className.includes('gt-dot-err'));
  assert.match(text(tree), /宿主能力 · 只读/);
  assert.match(text(render(EnvCard, { snap: { ...snap, capabilityRows: [] } })), /当前快照没有带回能力表/);
  // 状态位是宿主算的（netView 里的 transportStatus），界面只把它翻成点的颜色
  const err = render(EnvCard, { snap: { ...snap, net: { ...snap.net, status: 'err', text: '没能出网 · 设置页的自定义地址 · 自定义代理地址不可用：没给出 host:port' } } });
  const errRow = findByClass(err, 'gt-srcrow')[0];
  assert.ok(errRow.children[0].props.className.includes('gt-dot-err'));
  assert.match(text(errRow), /没能出网/);
  const idle = render(EnvCard, { snap: { ...snap, net: { ...snap.net, status: 'idle', text: TRANSPORT_VIA_LABELS.idle } } });
  const idleRow = findByClass(idle, 'gt-srcrow')[0];
  assert.ok(!/gt-dot-(ok|err)/.test(idleRow.children[0].props.className), '还没出过网不许抢成功或故障的颜色');
  // 传输层没接线（裸宿主 / 老快照）：这一行整个不出现，而不是写一句「未知」
  assert.equal(findByClass(render(EnvCard, { snap: { ...snap, net: null } }), 'gt-srcrow').length, 2);
});

/* ---------------- 装配与整页 ---------------- */
/** 假 slots 宿主：记录 inject / register / effect 三条通路。 */
function makeSlotCtx() {
  const seen = { effects: [], injects: [], specs: [], comps: [], disposers: [] };
  const ctx = {
    effect(fn, name) { seen.effects.push({ name, disposer: fn() }); },
    slots: {
      inject(name, fn) { seen.injects.push(name); seen.disposers.push(fn()); },
      register(spec, comp) { seen.specs.push(spec); seen.comps.push(comp); return () => {}; },
    },
  };
  return { ctx, seen };
}

check('client-27 apply：没路由前缀就一个入口都不注册（点开空白页更糟）', () => {
  const { exports } = loadClient(null);
  const { ctx, seen } = makeSlotCtx();
  exports.apply(ctx);
  assert.deepEqual([seen.effects.length, seen.injects.length, seen.specs.length], [0, 0, 0],
    'cfg().routePrefix 缺席 ⇒ 样式、侧栏图标、整页一个都不挂');
});

check('client-28 apply：图标位 + 整页各注册一次，order 与 label 来自载荷', () => {
  const { exports } = loadClient();
  const { ctx, seen } = makeSlotCtx();
  exports.apply(ctx);
  assert.deepEqual(seen.effects.map((e) => e.name), ['gh-trending:style']);
  assert.deepEqual(seen.injects, ['sidebar.panellist', 'main']);
  assert.equal(seen.specs.length, 2);
  const [side, main] = seen.specs;
  assert.equal(side.name, 'sidebar.panellist');
  assert.equal(side.id, 'gh-trending');
  assert.equal(side.order, 16, '排在模型监控(14)下方');
  assert.equal(typeof side.label, 'function', '宿主吃的是 label 函数');
  assert.equal(side.label(), 'GitHub 热榜');
  assert.equal(main.name, 'main');
  assert.equal(main.key, 'gh-trending');
  assert.equal(typeof seen.comps[0], 'function', '图标必须是组件');
  // ★ slots.inject 回调必须把 slots.register 的撤销器 return 出去（箭头函数带括号就对了；写成块语句漏 return 就卸载不掉）
  assert.deepEqual(seen.disposers.map((d) => typeof d), ['function', 'function'], '入口撤销器没交回宿主 ⇒ 重新激活时叠两份入口');
  const icon = mount(seen.comps[0]({}));
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props.width, 20);
  const iconSrc = (fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .match(/function TrendingPanelIcon[\s\S]*?\n    }/) || [''])[0];
  assert.ok(iconSrc, '找不到图标函数，判据空转');
  assert.match(iconSrc, /stroke: 'currentColor'/);
  assert.ok(!/#[0-9a-f]{3,6}/i.test(iconSrc), '图标不许写死色值（侧栏图标要跟宿主主题）');
});

check('client-29 样式注入：同 id 已存在就跳过（reload 不叠两份），撤销器能摘掉', () => {
  const a = loadClient();
  const effects = [];
  a.exports.apply({ effect: (fn) => effects.push(fn()), slots: { inject: (_n, fn) => fn(), register: () => () => {} } });
  assert.deepEqual(a.styleOps, ['append:dsh-plugin-gh-trending:style']);
  assert.equal(effects.length, 1, '样式一个撤销器（入口的撤销器由 slots.inject 的返回值交回）');
  effects[0]();
  assert.deepEqual(a.styleOps, ['append:dsh-plugin-gh-trending:style', 'remove']);
  const b = loadClient(PAYLOAD, { stylePresent: true });
  b.exports.apply({ effect: () => {}, slots: { inject: (_n, fn) => fn(), register: () => () => {} } });
  assert.deepEqual(b.styleOps, [], 'document 里已有同 id style ⇒ 一份都不许再塞');
});

check('client-30 页签路由：七签各自成页、页签条常驻，首帧前每页都有话说', () => {
  const page = (opts) => render(loadClient(PAYLOAD, opts).exports.__test.components.GhTrendingPage, {});
  const titles = (tree) => findByClass(tree, 'gt-card-t').map(text);

  const before = page({});
  assert.equal(findByClass(before, 'gt-root').length, 1);
  assert.equal(findByClass(before, 'gt-tabs').length, 1, '页签条常驻：换页不能把它一起换掉');
  assert.equal(kidsOf(findByClass(before, 'gt-tabs')[0], 'button').length, 7);
  assert.deepEqual(titles(before), ['三榜状态', '日榜', '周榜', '月榜', '跨榜同现'], '默认落在总览页');
  const t = text(before);
  assert.match(t, /等待首帧/);
  assert.match(t, /还没有记录|还没有数据/, '首帧前要有话说，不能一片空白');
  // ★ 第二十三轮：明星那一页的首帧前分支同样要有话说 —— 它读的是「本机攒下的榜史」，没快照就是没榜史。
  const starsBefore = page({ tab: 'stars' });
  assert.deepEqual(titles(starsBefore), ['明星仓库']);
  assert.match(text(starsBefore), /等待首帧/);
  assert.equal(findAllType(starsBefore, 'table').length, 0, '没有载荷就不摆一张空表（摆出来是把"没数据"演成"没仓库"）');
  assert.deepEqual(titles(page({ tab: 'settings' })), ['运行环境']);
  assert.match(text(page({ tab: 'settings' })), /配置未就位/);

  const snap = snapFixture();
  const views = {
    overview: ['三榜状态', '日榜', '周榜', '月榜', '跨榜同现'],
    daily: ['日榜'],
    weekly: ['周榜'],
    monthly: ['月榜'],
    stars: ['明星仓库'],
    events: ['变化记录'],
    settings: ['设置', '运行环境'],
  };
  for (const [tab, want] of Object.entries(views)) {
    const tree = page({ snap, tab });
    assert.deepEqual(titles(tree), want, `${tab} 页的卡片不对`);
    assert.equal(findByClass(tree, 'gt-tabs').length, 1, `${tab} 页丢了页签条`);
    assert.equal(findByClass(tree, 'gt-modal-mask').length, 0, `${tab} 页默认态里一个浮层都不许在（浮层只能由点击换来）`);
  }

  const daily = page({ snap, tab: 'daily' });
  assert.equal(findAllType(daily, 'table').length, 1, '一榜一页：日榜页里只该有一张表');
  assert.equal(findByClass(daily, 'gt-mini').length, 0, '榜页不掺总览的速览小结');
  assert.equal(findByClass(daily, 'gt-seg').length, 0, '设置卡的间隔分段器不许漏到榜页');
  const ov = page({ snap, tab: 'overview' });
  assert.equal(findAllType(ov, 'table').length, 0, '总览给的是每榜前 3 的速览，不重排 8 列大表');
  assert.equal(findByClass(ov, 'gt-mini').length, 6, '速览行：日 3 + 周 1 + 跨榜两个小计的标题行 2（速览只活在总览）');
});

check('client-31 根规则铁律：自带 border-box、禁 container query（modelwatch 曾整页塌成竖线）', () => {
  const code = clientSrc();
  assert.match(code, /\.gt-root\{[\s\S]*?box-sizing:border-box/, '根是 content-box 时 100% + padding 会把右半边顶出可视区');
  assert.ok(!/container-type|@container/.test(code), '宿主主区是 flex，容器查询算出 0 宽 ⇒ 整页塌成竖线');
  const rootRule = (code.match(/\.gt-root\{[^}]*\}/) || [''])[0];
  assert.ok(rootRule, '找不到 .gt-root 规则块，下面这一串根规则断言全部失效');
  assert.ok(!/max-width/.test(rootRule), '根设 max-width ⇒ 宿主主区比它宽时两侧各留一大片空白（真机 2026-10-08 用户截图）');
  assert.ok(!/margin:0 auto/.test(rootRule), '不限宽的根再居中无意义，且会掩盖宿主包裹层的左偏移');
  // 高度链：宿主 frame `height:100%` → centerCol `flex column + overflow:hidden` → 槽出口 `display:contents`
  //（dsh-client-ui-layout/lib/client.js:73、dsh-client-ui-renderer/lib/client.js:1094）⇒ 根的布局父级是 centerCol，
  // 它高度确定但**不自动传给 column flex 的 item**，所以根必须自己 flex:1 吃余量；centerCol 是 overflow:hidden ⇒ 超出的直接裁。
  assert.ok(!/vh|max-height/.test(rootRule), '根拿视口单位封顶就比可用区高出一个宿主标题栏，多出来那截被 centerCol 裁掉（真机 2026-10-08 底部那段「跨榜同现」）');
  assert.ok(/flex:1/.test(rootRule) && /min-height:0/.test(rootRule), '根必须吃满宿主给的那一格并允许收缩到内容以下，否则内部滚动区拿不到界');
  assert.ok(/overflow:hidden/.test(rootRule) && !/overflow-y:auto/.test(rootRule), '根自己不滚：滚动权只在一层（整页一张卡→卡内；多段页→.gt-panel），两层都滚会互相抢');
  const panelRule = (code.match(/\.gt-panel\{[^}]*\}/) || [''])[0];
  assert.ok(/flex:1/.test(panelRule) && /min-height:0/.test(panelRule) && /overflow-y:auto/.test(panelRule),
    '总览与设置是多段页，整页滚在 .gt-panel 这一层');
  assert.match(code, /\.gt-panel>\*\{flex:none\}/,
    '滚动容器的直接子不许收缩：panel 会滚之后子项默认 flex-shrink:1 就把三张段按比例压扁，卡自己的 overflow:hidden 裁掉压掉那截（真机 2026-10-08：三榜状态卡最后一条提示只露上半截），而且内容"适配"了以后该出现的滚动条反而不出现');
  assert.ok(/\.gt-root>\.gt-card\{[^}]*flex:1[^}]*\}/.test(code) && /\.gt-root>\.gt-card>\.gt-card-b\{[^}]*flex:1/.test(code),
    '「吃满高度」必须作用域在 .gt-root 的直接子：写成裸 .gt-card 会让总览那几张卡也跟着撑满一屏');
  assert.match(code, /@media \(max-width:900px\)\{\.gt-cols\{grid-template-columns:minmax\(0,1fr\)\}\}/, '双列窄视口退单列，轨道必须 minmax(0,1fr)');
  assert.match(code, /\.gt-tbl td\{[\s\S]*?text-overflow:ellipsis/, '长仓库名要截断，不许撑破 fixed 表');
  assert.match(code, /\.gt-root a\{color:inherit;text-decoration:none\}/,
    '外链不吃这一条就是浏览器默认蓝 + 下划线（真机截图抓到，离线断言全绿看不见）');
  assert.match(code, /\.gt-notice\{[\s\S]*?border-left:3px solid/, '就地落卡的提示有左边色条，浮层一律禁止');
  // 详情对话框是唯一的浮层，且只能由点击换来 ⇒ 它的层序与滚动权也得当场钉住（截图看不到断言，但断言能挡住改版）
  assert.match(code, /\.gt-modal-mask\{position:fixed;inset:0;z-index:40/,
    '遮罩必须压过 sticky 的页签条（z-index:2）：压不过就点得到榜单、点不到关闭');
  assert.match(code, /\.gt-modal\{[\s\S]*?max-height:86vh;overflow-y:auto/,
    '对话框自己滚：根容器已经在滚，两层都滚会互相抢');
  assert.match(code, /\.gt-modal-mask\{[\s\S]*?rgba\(15,17,21,\.34\);background:color-mix/,
    '遮罩底色先给死值再给 color-mix：不认 color-mix 的浏览器只留第一行，反过来写就丢宿主皮肤');
  assert.match(code, /\.gt-modal-sec\{display:flex;flex-direction:column;[\s\S]*?gap:6px/,
    '真机截图抓到：段名与正文吃块级默认 0 距 ⇒「中文说明 · …」和下面那句挤在一起，两组之间也分不出层级');
  // 页头标题跟兄弟插件对表：modelwatch / stock / sysops / it-tools 四家都是 17px（`tmp/probe-title.mjs` 逐家抠规则原文量的墨迹），
  // 我们那 16px 与 api-catalog 同档，用户在真机上判的是「这个字感觉太小了点，比其他插件的小」。
  assert.match(code, /\.gt-title\{font-size:17px/, '页头标题掉回 16px 就比四家兄弟插件小一档（离板对表读数 17px/ink 17 vs 16px/ink 16）');
});

check('client-32 一份真相：枚举文案在 client 里一个都不许出现', () => {
  const body = clientSrc();
  const banned = [
    ...Object.values(BOARD_LABELS),
    ...Object.values(BOARD_ADDED_LABELS),
    ...Object.values(CHECK_INTERVAL_LABELS),
    ...Object.values(EVENT_KIND_LABELS),
    TRENDING_SOURCE_NOTE,
    TRANSPORT_HINT,
    ...Object.values(LANG_CHECK),
    ...Object.values(PROXY_MODE_LABELS),
    ...Object.values(PROXY_MODE_HINTS),
    ...Object.values(TRANSPORT_VIA_LABELS),
    ...Object.values(TRANSPORT_SOURCE_LABELS),
    TRANSPORT_HINT_TAIL,
    // 详情这一层的单点：失败种类、旗标、README 来源与元数据列名都只归宿主（repoView 现造）
    ...Object.values(REPO_ERROR_LABELS),
    ...Object.values(REPO_FLAG_LABELS),
    ...Object.values(REPO_README_SOURCE_LABELS),
    // ★ 第十九轮：摘要闸门命中时档名后那半句也只归宿主（客户端自己拼一份，两处就会跟着 domain 的字面漂）
    ...Object.values(README_ZH_GATE_SUFFIXES),
    // 列名里两字的（'主页'）会撞上本面板自己的按钮词（'项目主页 ↗'）⇒ 只钉三字以上的，别误伤
    ...Object.values(REPO_FIELD_LABELS).filter((s) => s.length > 2),
    // ★ 第二十三轮（明星那一屏，§7.7 那条「界面不数条、不拼句、不判档」在这里的落点）：
    //   三句 note + 两个并进列名 + 档位名 + 排序名，写死的只许在 domain。
    STARS_NO_STORE_NOTE, STARS_QUOTA_OFF_NOTE, STARS_QUOTA_WAITING_NOTE, STARS_ALL_STARS_NOTE,
    STARS_COL_STARS_ADDED, STARS_COL_ROUNDS_PEAK,
    STARS_VIEW_LABELS.regular, STARS_VIEW_LABELS.rising, STARS_VIEW_DISABLED_LABELS.allStars,
    ...Object.values(STARS_SORT_LABELS),
    // 那两句带数字的句子没法整串钉住（客户端自己拼一份就把两处钉死在同一句话上）⇒ 钉它唯一的静态片段
    '本屏 =', '不够判「在榜」',
    /* ★ 三条豁免，逐条给理由（写了才不会被下一个人当疏漏补上）：
       · STARS_COL_STARS（'累计 ★'）：榜面表头从第十四轮起就写死同一串（`client.js:567`），
         这一屏改由"换载荷值 ⇒ 屏上跟着换"那条判据钉（client-61 ③），比子串扫描更硬。
       · STARS_VIEW_LABELS.cooling（'回落'）撞跨榜卡头的段标题「热度回落」，STARS_VIEW_LABELS.all（'全部'）
         与 STARS_VIEW_DISABLED_LABELS 去掉前缀后的'全站高星'都是中文高频词/故障句主语 —— 子串扫描会误伤，
         这两档的名字同样由 client-60「档位名单逐字吃 stars.views」那条判据管。
       · STARS_MISSING_CELL（'—'）：榜面在第十二轮就有三处硬编码缺位格，这一屏改吃 `stars.missingCell`
         并由 client-61 ① 验"换载荷值屏上跟着换"；把整表的破折号一起清了是另一轮的活。 */
  ];
  // 豁免清单的前提得在盘上成立（那三串长这样）：domain 哪天改了字面，这条先红，提醒上面那段理由同步改。
  assert.equal(STARS_COL_STARS, '累计 ★');
  assert.equal(STARS_VIEW_LABELS.cooling, '回落');
  assert.ok(body.includes('累计 ★') && body.includes('热度回落'),
    '上面两条豁免之所以是豁免，是因为榜面与跨榜卡头真的各写着这两串；写它的地方没了就把豁免撤掉、请回 banned 清单');
  for (const s of banned) {
    assert.ok(!body.includes(s), `client.js 里出现了宿主单点的文案「${s}」⇒ 两处会漂，界面上必须吃载荷`);
  }
  // 键的兜底表可以有（三档 id 是协议），但只能活在 cfg() 读不到时的那一处表达式里，不许再立一份常量
  assert.ok(/'daily', 'weekly', 'monthly'/.test(body));
  assert.ok(!/const BOARDS\s*=\s*\[/.test(body), '不许在浏览器半边再立一份 BOARDS 数组（兜底只能写在 cfg() 读不到时的表达式里）');
  assert.ok(!/MOVE_THRESHOLD|CHECK_INTERVALS\s*=/.test(body), '阈值与档位表只归 lib/domain.js');
});

/* ---------------- 页签化与故障口径（S2 新增） ---------------- */
check('client-33 fmtIn：与 fmtAge 同一套量级词，方向朝前；没值给空串', () => {
  const { fmtIn } = loadClient().exports.__test;
  assert.equal(fmtIn(0, AT), '');
  assert.equal(fmtIn(undefined, AT), '', '没有下次时刻就交空串，由调用方决定这句话说不说');
  assert.equal(fmtIn('abc', AT), '');
  assert.equal(fmtIn(AT + 30000, AT), '30 秒后');
  assert.equal(fmtIn(AT + 5 * 60000, AT), '5 分钟后');
  assert.equal(fmtIn(AT + 3 * 3600000, AT), '3 小时后');
  assert.equal(fmtIn(AT + 2 * 86400000, AT), '2 天后');
  assert.equal(fmtIn(AT - 1000, AT), '就在下一轮', '时刻已过 ⇒ 说就在下一轮，不许出现负数');
  assert.ok(!/\)}后/.test(clientSrc()), 'fmtIn 自带「后」，模板再拼一次就是「5 分钟后后」');
});

check('client-34 故障口径：连续轮数与补发次数照宿主说的，代理提示只在传输类时出现', () => {
  const { StatusCard } = loadClient().exports.__test.components;
  const b = (over) => ({
    hasData: true, ok: true, at: atOff(-60000), lastFetchAt: atOff(-60000), bodyChangedAt: 1,
    failStreak: 0, transport: false, rowsTotal: 15, rows: [], empty: false, ...over,
  });
  const boards = {
    daily: b({ ok: false, error: '趋势页请求失败：fetch failed（共尝试 3 次）', transport: true, at: atOff(-3 * 3600000), failStreak: 3 }),
    weekly: b({}),
    monthly: b({ ok: false, error: '趋势页返回 500', failStreak: 0 }),
  };
  const snap = snapFixture({
    boards,
    cadence: { intervalMin: 60, effectiveMs: 480000, backoffExp: 3, nextCheckAt: atOff(420000), fetchAttempts: FETCH_ATTEMPTS },
  });
  const tree = render(StatusCard, { snap, conn: { ok: true, note: '' }, lastErr: '' });
  const rows = findByClass(tree, 'gt-srcrow');
  assert.match(text(rows[0]), /共尝试 3 次/, '补发次数由宿主拼在 error 里，客户端不另算一遍');
  assert.match(text(rows[0]), /已连续 3 轮/);
  assert.match(text(rows[0]), /显示 3 小时前的上次成功数据/);
  assert.match(text(rows[2]), /故障 · 趋势页返回 500/);
  assert.ok(!/已连续/.test(text(rows[2])), 'failStreak 为 0 的榜不许编「已连续 N 轮」');
  const notices = findByClass(tree, 'gt-notice');
  assert.equal(notices.length, 2);
  assert.equal(text(notices[0]), TRANSPORT_HINT, '文案单点来自宿主快照');
  assert.ok(!hasCls(notices[0], 'gt-notice-err'), '重试与退避都在跑 ⇒ 提示档，不是红色');
  assert.match(text(notices[1]), /下次自动检查 7 分钟后/, '退避把节拍推到 8 分钟：把「什么时候自愈」如实说清');

  const quiet = render(StatusCard, {
    snap: { ...snap, transportHint: undefined, cadence: null, boards: { ...boards, daily: b({ ok: false, error: '趋势页返回 500', failStreak: 1 }) } },
    conn: { ok: true, note: '' }, lastErr: '',
  });
  assert.equal(findByClass(quiet, 'gt-notice').length, 0, '不是传输类就不提代理；没在跑表就不报下次时间');
});

check('client-35 总览页：状态 → 三榜速览 → 跨榜，一屏看完不排大表', () => {
  const { OverviewTab } = loadClient().exports.__test.components;
  const tree = render(OverviewTab, { snap: snapFixture(), conn: { ok: true, note: '' }, lastErr: '', onGo() {} });
  assert.deepEqual(findByClass(tree, 'gt-card-t').map(text),
    ['三榜状态', '日榜', '周榜', '月榜', '跨榜同现']);
  assert.equal(findByClass(tree, 'gt-boards3').length, 1, '三榜速览并排一行，窄视口靠 auto-fit 收列');
  assert.equal(findByClass(tree, 'gt-tbl').length, 0, '总览不重排 8 列大表，那是榜页的活');
  assert.equal(findByClass(tree, 'gt-link').length, 3, '只有三榜的「完整榜单 →」；总览不再摆流水小结');
});

check('client-36 速览小结：前 3 行、名次与新增照原文，跳转带榜键；空榜与坏榜措辞分开', () => {
  const { BoardMini } = loadClient().exports.__test.components;
  const went = [];
  const tree = render(BoardMini, { snap: snapFixture(), board: 'daily', onGo: (t) => went.push(t) });
  assert.equal(text(findByClass(tree, 'gt-card-n')[0]), '20 条', '说榜面真实条数，不是切出来的 3 条');
  const items = findByClass(tree, 'gt-mini');
  assert.equal(items.length, 3, '只给前 3 行');
  assert.deepEqual(items.map((n) => text(findByClass(n, 'gt-rank')[0])), ['1', '2', '3']);
  assert.deepEqual(items.map((n) => text(findByClass(n, 'gt-mini-n')[0])), ['+512', '+512', '+512']);
  assert.equal(findAllType(items[0], 'a')[0].props.href, `https://github.com/${DESC_ZH_ROWS[0][0]}`);
  assert.equal(findAllType(items[0], 'a')[0].props.rel, 'noreferrer');
  assert.equal(text(findByClass(tree, 'gt-link')[0]), '完整榜单 →');
  findByClass(tree, 'gt-link')[0].props.onClick();
  assert.deepEqual(went, ['daily'], '跳转必须带榜键，否则切过去还是同一榜');

  assert.match(text(render(BoardMini, { snap: snapFixture(), board: 'monthly', onGo() {} })),
    /这一档今天没有上榜仓库/);
  const broken = { ...snapFixture().boards.weekly, ok: false, error: '趋势页返回 500', rows: [] };
  const bt = render(BoardMini, { snap: { ...snapFixture(), boards: { ...snapFixture().boards, weekly: broken } }, board: 'weekly', onGo() {} });
  assert.equal(text(findByClass(bt, 'gt-empty')[0]), '趋势页返回 500', '坏且无旧档 ⇒ 只说故障，不冒充「今天没人上榜」');
});

check('client-37 总览不再摆流水小结（用户口径去掉），流水只活在变化记录页签', () => {
  const comps = loadClient().exports.__test.components;
  assert.equal(comps.EventMini, undefined, '小结组件整个删掉，不是藏起来（留着就还会有人接回去）');
  const tree = render(comps.OverviewTab, { snap: snapFixture({ events: [
    { id: 'e1', at: atOff(-60000), kind: 'board_enter', repo: 'a/one' },
  ] }), conn: { ok: true, note: '' }, onGo() {} });
  assert.ok(!/最近变化/.test(text(tree)), '总览里不再出现「最近变化」这张卡');
  assert.ok(!/全部 →/.test(text(tree)), '连带它那个「全部 →」跳转按钮一起走');
  const events = render(comps.EventsCard, { snap: snapFixture({ events: [
    { id: 'e1', at: atOff(-60000), kind: 'board_enter', repo: 'a/one' },
  ] }) });
  assert.match(text(events), /进榜/, '流水本身没坏：变化记录页签照旧看全量');
});

check('client-38 页签样式：下划线用重量档不抢招牌色，速览靠 auto-fit，前缀不许撞 modelwatch', () => {
  const code = clientSrc();
  assert.match(code, /\.gt-tabs\{[\s\S]*?border-bottom:1px solid var\(--gt-line\)/);
  assert.match(code, /\.gt-tabs\{[\s\S]*?flex:none\}/,
    '真机截图抓到：根是 column flex 且高度由宿主定死，超高就收缩 ⇒ 页签条被压成 1px、按钮被裁掉。flex:none 是唯一解（第九轮撤了 overflow-x:auto，收缩压力还在，别把它一起删）');
  const tabsRule = (/\.gt-tabs\{[^}]*\}/.exec(code) || [''])[0];
  assert.ok(tabsRule && !/overflow/.test(tabsRule),
    '页签条一句 overflow-x:auto「防六签挤不下」就够在真机上多长出一条没意义的滚动条：它让 nav 成了两轴滚动容器，而 .gt-tab.on:after{bottom:-1px} 把可滚溢出撑到 34 > clientHeight 33 ⇒ 页签条右端一条竖向滚动条（用户圈的正是它，`tmp/probe-sbar.mjs` 在真宿主上量到 overflowsY:1、scrollWidth==clientWidth 说明根本没有横向溢出要防）');
  assert.match(code, /\.gt-tab\.on:after\{[\s\S]*?background:var\(--gt-fg\)/,
    '当前签靠近黑下划线 + 字重分主次（宿主令牌语义：状态色留给状态）');
  assert.match(code, /\.gt-link\{[\s\S]*?margin-left:auto/);
  assert.match(code, /\.gt-card-h \.gt-card-n\+\.gt-link\{margin-left:2px\}/,
    '两个 margin-left:auto 会把空白对半分，计数飘到中间');
  assert.match(code, /\.gt-boards3\{[\s\S]*?repeat\(auto-fit,minmax\(240px,1fr\)\)/);
  // 页签化带来的两条：钉顶的页头+页签条，和按整页高算的卡内滚动区
  assert.match(code, /\.gt-topbar\{[\s\S]*?position:sticky;top:0;[\s\S]*?flex:none/,
    '页头与页签条包成一块 sticky：滚到榜底还切得动签。两条各 sticky 到 top:0 会互相盖住，flex:none 同 .gt-tabs 的收缩教训');
  assert.match(code, /\.gt-topbar\{[\s\S]*?padding-top:16px/, '顶部间距由顶栏自己拿');
  assert.match(code, /\.gt-root\{[\s\S]*?padding:0 20px 28px/,
    '根不能再留 padding-top：sticky 只贴到内容盒上沿，那 16px 的缝里会露出滚上来的卡片（真机量到 gap:16）');
  const scrollRule = (code.match(/\.gt-scroll\{[^}]*\}/) || [''])[0];
  assert.ok(/flex:1/.test(scrollRule) && /min-height:0/.test(scrollRule),
    '卡内滚动区吃 flex 传下来的余量：窗口多高它就多高，thead 的 sticky 相对它才成立');
  assert.ok(!/max-height|vh|calc\(/.test(scrollRule),
    '「视口减一个魔数」封顶换台机器就偏（原 calc(100vh - 220px) 那个 220 是页头+页签+卡头+卡脚的经验值，宿主标题栏多高它不知道）');
  assert.ok(!/mw-/.test(code), '照抄 modelwatch 的帧语义可以，类名前缀必须换（两份 CSS 抢同一批类名会互相盖）');
});

check('client-39 设置卡的出网方式：三档吃载荷、地址是草稿、切自定义得带着地址一起发', () => {
  const { SettingsCard } = loadClient().exports.__test.components;
  const sent = [];
  const drafts = [];
  const mk = (over = {}) => render(SettingsCard, {
    snap: { ...snapFixture(), prefs: { ...snapFixture().prefs, ...over.prefs } },
    saving: false, savedNote: '', savedErr: false,
    language: '', onLanguage() {}, onInterval() {},
    proxyUrl: over.proxyUrl ?? '', onProxyUrl: (v) => drafts.push(v),
    onSave: (p) => sent.push(p),
  });
  const row = (tree) => setRow(tree, '出网方式');
  const base = mk();
  const btns = kidsOf(findByClass(row(base), 'gt-seg')[0], 'button');
  assert.deepEqual(btns.map(text), Object.values(PROXY_MODE_LABELS), '三档话术来自载荷，客户端不自己起名');
  assert.deepEqual(btns.map((b) => hasCls(b, 'on')), [true, false, false], '高亮跟着库里的 proxyMode');
  assert.equal(text(row(base)).includes(PROXY_MODE_HINTS.system), true, '提示跟着当前档走，不是三句一起念');

  const custom = mk({ prefs: { proxyMode: 'custom' }, proxyUrl: ' http://127.0.0.1:7897 ' });
  assert.deepEqual(kidsOf(findByClass(row(custom), 'gt-seg')[0], 'button').map((b) => hasCls(b, 'on')), [false, true, false]);
  const cRow = row(custom);
  assert.equal(text(cRow).includes(PROXY_MODE_HINTS.custom), true);
  const input = findAllType(cRow, 'input')[0];
  assert.equal(input.props.value, ' http://127.0.0.1:7897 ', '输入框吃草稿原样（含正在打的空格），不回显库里的规整值');
  assert.equal(input.props.maxLength, PROXY_URL_MAX, '长度上限来自载荷，超了宿主只会拒不会截');
  input.props.onChange({ target: { value: 'socks5://x' } });
  assert.deepEqual(plain(drafts), ['socks5://x']);

  // 保存只发地址（模式留在原档）：地址先存对，再切档，两步都能走通
  const save = findByClass(cRow, 'gt-btn').filter((b) => text(b) === '保存');
  assert.equal(save.length, 1, '出网方式行自己只有一个保存');
  save[0].props.onClick();
  assert.deepEqual(plain(sent), [{ proxyUrl: 'http://127.0.0.1:7897' }], '发出去的是 trim 过的草稿');

  sent.length = 0;
  const modes = (tree) => kidsOf(findByClass(row(tree), 'gt-seg')[0], 'button');
  modes(base)[1].props.onClick();
  modes(base)[2].props.onClick();
  assert.deepEqual(plain(sent), [
    { proxyMode: 'custom', proxyUrl: '' },
    { proxyMode: 'direct' },
  ], '切自定义把地址一起发（库里没地址时宿主会当场拒，见 api 套件）；切直连只发模式');

  sent.length = 0;
  const same = mk({ prefs: { proxyMode: 'system', proxyUrl: '127.0.0.1:7897' }, proxyUrl: ' 127.0.0.1:7897 ' });
  assert.equal(findByClass(row(same), 'gt-btn').filter((b) => text(b) === '保存')[0].props.disabled, true,
    '草稿与库里一致 ⇒ 保存哑掉（点一下什么都没改，不该发一跳）');
  // 真机走查抓到的一半：清得掉才算配置闭环 —— 按 all+delete 就是「不要这个地址了」
  const clearing = mk({ prefs: { proxyMode: 'system', proxyUrl: '127.0.0.1:7897' }, proxyUrl: '' });
  const clearBtn = findByClass(row(clearing), 'gt-btn').filter((b) => text(b) === '保存')[0];
  assert.equal(clearBtn.props.disabled, false);
  clearBtn.props.onClick();
  assert.deepEqual(plain(sent), [{ proxyUrl: '' }]);

  // 旧宿主载荷没给 proxyModes：这一行整个不出现（三个空按钮的分段器比没有更难解释）
  const { exports: stale } = loadClient({ ...PAYLOAD, proxyModes: undefined });
  const staleTree = render(stale.__test.components.SettingsCard, {
    snap: snapFixture(), saving: false, savedNote: '', savedErr: false,
    language: '', onLanguage() {}, onInterval() {}, proxyUrl: '', onProxyUrl() {}, onSave() {},
  });
  assert.equal(text(staleTree).includes('出网方式'), false);
  // 分段器从 1 个变 3 个是「现译两档」带来的，不是这条断言松了：按行首标签点名是哪三行，
  // 多一行少一行都得当场报错（只写数字的话，下次再加一档又是「3 !== 4」这种看不出根因的红）。
  // 第九轮加了「现译引擎」一行 ⇒ 这里四行：这一行吃的同样是 snap.translator，旧宿主没给那个键就整段不出现。
  const segRows = findByClass(staleTree, 'gt-setrow')
    .filter((r) => findByClass(r, 'gt-seg').length)
    .map((r) => text(findByClass(r, 'gt-setlabel')[0]));
  assert.deepEqual(segRows, ['检查间隔', '详情缓存', '现译引擎', '描述现译', '摘要现译'],
    '旧宿主只撤出网方式那一行；现译引擎与两档开关吃的是 snap.translator 这个键，载荷带着就照常渲染');
  // 草稿只初始化一次（与语言同一个坑）：每次 update 帧都覆盖输入框会吃掉用户正在打的字
  const src = clientSrc();
  assert.match(src, /if \(proxyInit\.current \|\| !snap\) return;/);
  assert.match(src, /if \(patch\.proxyUrl !== undefined\) setProxyUrl\(saved\.proxyUrl \?\? ''\)/,
    '保存成功后用库里的规整值收口草稿');
});

/* ---------------- 仓库详情弹框（#11 新增） ---------------- */
check('client-40 repoLinkProps：普通左键拦下来弹详情，修饰键/中键与没接 onRepo 一律放行', () => {
  const { repoLinkProps } = loadClient().exports.__test;
  const calls = [];
  const fire = (p, over) => {
    let prevented = false;
    const e = { button: 0, preventDefault: () => { prevented = true; }, ...over };
    p.onClick(e);
    return prevented;
  };
  const p = repoLinkProps('a/one', (r) => calls.push(r));
  assert.equal(p.href, 'https://github.com/a/one', 'href 必须留着：中键/右键「新标签页打开」靠它');
  assert.equal(p.target, '_blank');
  assert.equal(p.rel, 'noreferrer');
  assert.equal(p.title, 'a/one');
  assert.equal(fire(p), true, '普通左键要拦住');
  assert.deepEqual(plain(calls), ['a/one']);
  calls.length = 0;
  for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.equal(fire(p, { [mod]: true }), false, `${mod} 组合键是「在新标签页打开」，不是弹框`);
    assert.equal(calls.length, 0);
  }
  assert.equal(fire(p, { button: 1 }), false, '中键交给浏览器');
  assert.equal(fire(p, { button: 2 }), false, '右键交给浏览器');
  assert.equal(fire(p, { button: undefined }), false, 'button 缺失不当成左键（宁可开 GitHub 也不要弹个空框）');

  const noHook = repoLinkProps('a/one', undefined);
  assert.equal(noHook.onClick({ button: 0, preventDefault: () => { throw new Error('不该拦'); } }), undefined,
    '没接 onRepo 就把点击整个交回浏览器：拦了又什么都不做，等于把点开的路堵死');
});

check('client-41 详情弹框直通 repoView：段名、块、元数据成对、节选与配额行都照原文', () => {
  const { DetailModal } = loadClient().exports.__test.components;
  const v = detailFixture();
  const tree = render(DetailModal, { detail: { repo: v.repo, loading: false, view: v, err: '' }, onClose() {}, onRefresh() {} });
  assert.equal(findByClass(tree, 'gt-modal-mask').length, 1);
  const dlg = findByClass(tree, 'gt-modal')[0];
  assert.equal(dlg.props.role, 'dialog');
  assert.equal(dlg.props['aria-modal'], 'true');
  const t = text(tree);
  assert.ok(t.includes(v.name) && t.includes(v.repo), '标题给可读名，但 owner/repo 也必须在场（同名仓库靠它分辨）');

  // ★ 段表原样摆：段名按宿主顺序、每块的文本逐字，客户端一个字不加（第十一轮起没有 narrative）
  assert.ok(Array.isArray(v.sections) && v.sections.length >= 3, `夹具该给三张以上段，否则这组断言在测空气（实得 ${JSON.stringify(v.sections?.map((s) => s.key))}）`);
  assert.deepEqual(findByClass(tree, 'gt-modal-h2').map(text), v.sections.map((s) => s.label), '段名与段序照宿主那份，客户端不排表');
  // ★ 第十二轮（用户裁定「四段来源落款全撤」）两头都钉：载荷里段对象只有四格，屏上也没有那四句字面。
  //   只钉一头会假绿 —— 宿主撤了格子而客户端还留着渲染行，或者反过来（行撤了、字面还从别的键冒出来）。
  for (const s of v.sections) assert.deepEqual(Object.keys(s).sort(), ['blocks', 'facts', 'key', 'label'], `${s.key} 段的格子不是这四格`);
  for (const gone of [
    '这一段读的是 api.github.com 的 description / language / license / topics 字段',
    '这些数字与日期是 api.github.com 的元数据字段，不是本插件算的',
    '下面是仓库自己写的 README 正文（去掉标记后的节选），不是译文',
    '这一段是现译给的，不是仓库自己写的中文',
  ]) assert.ok(!t.includes(gone), `来源落款又回到屏上了：${gone}`);
  for (const block of v.sections.flatMap((s) => s.blocks.map((b) => ({ key: s.key, ...b })))) {
    assert.ok(t.includes(block.text), `${block.key} 段的 ${block.kind} 块没原样出现：${block.text}`);
  }
  // 四种 kind 各自摆成各自的形状（从前客户端自己判"这段算小字"，第十一轮交回宿主）
  // ★ 第十二轮起基准夹具喂不出 `sub` 了（README 那句说明撤掉之后，小字块只剩旗标句与失败句）
  //   ⇒ 取样夹具带上一面旗标，四种 kind 由**这一份**喂齐； kinds 全集从它算，不从基准那份算。
  const kindFix = detailFixture({ archived: true });
  const kindTree = render(DetailModal, { detail: { repo: kindFix.repo, loading: false, view: kindFix, err: '' }, onClose() {}, onRefresh() {} });
  const kinds = new Set(kindFix.sections.flatMap((s) => s.blocks.map((b) => b.kind)));
  // ★ 类名是**逐级加重**的（p ⊂ sub ⊂ num），所以按最特异那一枚找节点、再要 className 逐字相等：
  //   只判"文在不在"的话，把 num 摆成 p 也照样绿。
  const asClass = { p: 'gt-modal-p', sub: 'gt-modal-p gt-sub', num: 'gt-modal-p gt-sub gt-num', excerpt: 'gt-modal-readme' };
  for (const k of Object.keys(asClass)) {
    const want = kindFix.sections.flatMap((s) => s.blocks).filter((b) => b.kind === k);
    if (!want.length) continue;
    const token = asClass[k].split(' ').pop();
    const hit = findByClass(kindTree, token).some((n) => n.props.className === asClass[k] && text(n) === want[0].text);
    assert.equal(hit, true, `${k} 块没按登记的类名摆出来（该是 class="${asClass[k]}"）：${want[0].text}`);
  }
  assert.deepEqual([...kinds].sort(), ['excerpt', 'num', 'p', 'sub'], '夹具只喂到部分 kind ⇒ 剩下那几种压根没被渲染层验过');
  assert.ok(!/机器翻译|AI 解读/.test(t), '没做翻译也没做解读，不许在界面上这么写');

  const dl = findByClass(tree, 'gt-modal-facts')[0];
  const heatFacts = (v.sections.find((s) => s.key === 'heat')?.facts ?? []);
  assert.ok(heatFacts.length > 0, '夹具没给热度段 ⇒ 元数据那组断言在测空气');
  assert.deepEqual(kidsOf(dl, 'dt').map(text), heatFacts.map((f) => f.label), '列名逐条来自宿主 sections[].facts[].label');
  assert.deepEqual(kidsOf(dl, 'dd').map(text), heatFacts.map((f) => f.value));
  assert.equal(findByClass(tree, 'gt-modal-facts').length, 1, '只有 heat 段带 facts ⇒ 一张元数据表，别处不许再摆一张');
  // ★ 同屏一个数只出现一次（用户撤掉「总览最近变化小结」时立的那条律）
  for (const f of heatFacts) assert.equal((t.match(new RegExp(f.value.replace(/[/\\{}()*+?.$|^-]/g, '\\$&'), 'g')) || []).length, 1, `${f.label} 的值 ${f.value} 在同屏出现了不止一次`);

  const self = v.sections.find((s) => s.key === 'self');
  assert.ok(t.includes(self.label) && self.blocks.every((b) => t.includes(b.text)), 'README 那段的段名与说明句照原文');
  assert.equal(text(findByClass(tree, 'gt-modal-readme')[0]), v.readmeExcerpt);
  // 落款是宿主拼的整句，这里只许照搬：客户端自己拼过一次，把「整篇原文 4,235」当成了屏上字数
  const meta = self.blocks.find((b) => b.kind === 'num');
  assert.ok(meta && meta.text.length > 0, '夹具的落款没被拼出来，下面这条断言就在测空气');
  assert.ok(t.includes(meta.text), `落款没原样出现：${meta.text}`);
  assert.ok(!/节选 \$\{|readmeChars \} 字/.test(clientSrc()), '「节选 N 字」这句必须由宿主拼，客户端不许自己数');
  assert.match(t, /缓存于 3 小时前/, 'cached:true 要说这是缓存的，并把 ageMs 折算成人话');
  assert.match(t, /匿名配额剩 41 \/ 60/);
  assert.ok(!/重置$|重置，/.test(t) && !/分钟后重置/.test(t), 'resetAt 为 0（没拿到响应头）时不说「N 后重置」');

  const fresh = detailFixture({ at: Date.now() - 2 * 3600000 }, { cached: false, ageMs: 0 });
  const freshTree = render(DetailModal, { detail: { repo: fresh.repo, loading: false, view: fresh, err: '' }, onClose() {}, onRefresh() {} });
  assert.match(text(freshTree), /取回于 2 小时前/);
  const withReset = detailFixture({ at: Date.now() - 1000 }, { cached: false, ageMs: 0, rate: { left: 3, resetAt: Date.now() + 5 * 60000 } });
  assert.match(text(render(DetailModal, { detail: { repo: withReset.repo, loading: false, view: withReset, err: '' }, onClose() {}, onRefresh() {} })),
    /匿名配额剩 3 \/ 60，5 分钟后重置/);

  const flags = detailFixture({ archived: true, isFork: true });
  const flagTree = render(DetailModal, { detail: { repo: flags.repo, loading: false, view: flags, err: '' }, onClose() {}, onRefresh() {} });
  const flagSub = findByClass(flagTree, 'gt-sub').filter((n) => n.props.className === 'gt-modal-p gt-sub').map(text);
  for (const label of Object.values(REPO_FLAG_LABELS)) {
    assert.ok(flagSub.includes(label), `旗标句没原样出现在 heat 段的小字块里：${label}`);
  }
  assert.equal(findByClass(tree, 'gt-notice').length, 0, '正常仓库不该有旗标卡（旗标是段里的块，不是卡）');

  // 段缺数据 ⇒ 整段不摆：README 来源没登记档位时 self 段压根不在载荷里，界面上也不许冒出来
  const noSelf = detailFixture({ readmeSource: '', readmeExcerpt: '', readmeChars: 0 });
  const noSelfTree = render(DetailModal, { detail: { repo: noSelf.repo, loading: false, view: noSelf, err: '' }, onClose() {}, onRefresh() {} });
  assert.equal(noSelf.sections.some((s) => s.key === 'self'), false, '夹具这一行没造出"缺数据的段"');
  assert.equal(findByClass(noSelfTree, 'gt-modal-h2').map(text).some((x) => x.startsWith('仓库自己怎么介绍它')), false, '宿主没给的段，客户端不许自己补一个空段');

  const links = findAllType(tree, 'a').map((a) => a.props.href);
  assert.ok(links.includes('https://github.com/vitejs/vite'), '对话框里必须能一键去 GitHub');
  assert.ok(links.includes('https://vitejs.dev'), 'homepage 有就给出，没有就不给');
  assert.ok(!findAllType(render(DetailModal, {
    detail: { repo: 'x/y', loading: false, view: detailFixture({ homepage: '', htmlUrl: '' }), err: '' }, onClose() {}, onRefresh() {},
  }), 'a').some((a) => a.props.href === ''), 'homepage 空串不许留一个 href="" 的链接');
});

check('client-42 详情的三种「没内容」各说各的：还在取 / 请求本身坏了 / 取回来但宿主说没拿到', () => {
  const { DetailModal } = loadClient().exports.__test.components;
  const mk = (detail) => render(DetailModal, { detail, onClose() {}, onRefresh() {} });
  const loading = mk({ repo: 'a/one', loading: true, view: null, err: '' });
  assert.match(text(loading), /正在取这份仓库的详情/);
  assert.match(text(loading), /四发出网|最多四发/, '这一发比榜面慢，得把等待说清楚');
  assert.equal(findByClass(loading, 'gt-notice').length, 0, '还在取不是坏了');
  assert.equal(findByClass(loading, 'gt-modal-facts').length, 0);

  const broken = mk({ repo: 'a/one', loading: false, view: null, err: 'HTTP 503' });
  assert.match(text(broken), /详情请求本身失败：HTTP 503/);
  assert.ok(hasCls(findByClass(broken, 'gt-notice')[0], 'gt-notice-err'), '请求本身坏了走红档');

  for (const [errKey, errText] of [
    ['not_found', '/repos/a/one 返回 404'],
    ['rate_limited', '限额用尽（403，重置于 未知时刻）'],
    ['config', '/repos/a/one 没出发：代理地址解析不了'],
    ['bad_key', '这个名字不像 owner/name'],
  ]) {
    const v = repoView({ repo: 'a/one', ok: false, errKey, errText, at: AT }, { cached: false });
    const tree = mk({ repo: 'a/one', loading: false, view: v, err: '' });
    const t = text(tree);
    assert.ok(t.includes(REPO_ERROR_LABELS[errKey]), `${errKey} 的宿主句子没出现`);
    assert.ok(t.includes(errText), `${errKey} 的原文原因没出现`);
    assert.equal(findByClass(tree, 'gt-modal-facts').length, 0, 'ok:false 时宿主给的是空 facts，界面不许自己补');
    assert.ok(!/这是.*的项目/.test(t), '没取到就不许拼一句中文叙述');
  }
});

check('client-43 关闭的三条路：× / 点遮罩空白 / Esc，点框内不关，卸载摘掉监听', () => {
  const { escClose } = loadClient().exports.__test;
  let n = 0;
  const close = () => { n += 1; };
  escClose({ key: 'Escape' }, close);
  escClose({ key: 'Esc' }, close);
  escClose({ key: 'Enter' }, close);
  escClose(null, close);
  assert.equal(n, 1, '只认 Escape');

  const { exports, effects, docListeners } = loadClient();
  const { DetailModal } = exports.__test.components;
  let closed = 0;
  const tree = render(DetailModal, { detail: { repo: 'a/one', loading: false, view: detailFixture(), err: '' }, onClose: () => { closed += 1; }, onRefresh() {} });
  assert.equal(effects.length, 1, 'DetailModal 只挂一条 effect（keydown），多了就是有人在页面级偷偷注册');
  const cleanup = effects[0].fn();
  assert.equal((docListeners.keydown || []).length, 1);
  (docListeners.keydown || []).forEach((fn) => fn({ key: 'Escape' }));
  assert.equal(closed, 1, 'Esc 走的是同一条 onClose');
  cleanup();
  assert.equal((docListeners.keydown || []).length, 0, '不摘掉的话每开一次就多一个监听，关掉的框也会被 Esc 唤起');

  findByClass(tree, 'gt-modal-x')[0].props.onClick();
  assert.equal(closed, 2, '× 按钮');
  const mask = findByClass(tree, 'gt-modal-mask')[0];
  mask.props.onClick({ target: 'DIALOG', currentTarget: 'MASK' });
  assert.equal(closed, 2, '点框内冒泡到遮罩不许关（读到一半没了才是真恼人）');
  mask.props.onClick({ target: 'MASK', currentTarget: 'MASK' });
  assert.equal(closed, 3, '点空白处关');

  const refresh = findByClass(tree, 'gt-modal-f');
  assert.equal(findAllType(refresh, 'button').length, 1, '页脚只有一个「重新取一次」');
});

check('client-44 触发与 URL：三处仓库名都接了 onRepo，点一行才发一发 GET /api/repo?name=', async () => {
  const seen = [];
  const page = (opts) => render(loadClient(PAYLOAD, {
    ...opts,
    fetch: async (url) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => ({ ok: true, data: detailFixture() }) }; },
  }).exports.__test.components.GhTrendingPage, {});
  const cross = { rising: [{ repo: 'c/rise', name: 'c/rise', boards: ['daily', 'weekly'], bestRank: 2 }], cooling: [], note: '' };

  const board = page({ snap: snapFixture(), tab: 'daily' });
  const overview = page({ snap: snapFixture(), tab: 'overview' });
  const crossTree = page({ snap: snapFixture({ cross }), tab: 'overview' });
  // 列名现在带 gt-col- 前缀（client-15 钉着），`.gt-repo` 只剩仓库链接一个用处；仍按标签挑，防的是同名再回来
  const anchors = [
    // ★ 日榜首行刻意用 `a/two`（不在任何中文表里）：换到内置表那条主键上，这一条断言的期望值就跟着表跑（见上面 seen 那一句）。
    ['日榜表', findByClass(board, 'gt-repo').find((a) => text(a) === 'a/two')],
    ['总览速览', findByClass(overview, 'gt-mini-t').find((a) => text(a) === 'a/two')],
    ['跨榜同现', findByClass(crossTree, 'gt-mini-t').find((a) => a.props.href === 'https://github.com/c/rise')],
  ];
  assert.deepEqual(seen, [], '光是把三页渲染出来不该取任何详情（详情只在点击时取）');
  for (const [where, a] of anchors) {
    assert.ok(a, `${where} 找不到仓库名那一列`);
    assert.equal(typeof a.props.onClick, 'function', `${where} 的仓库名没接 onRepo`);
    assert.equal(a.props.target, '_blank', `${where} 丢了 href/新标签页语义`);
    a.props.onClick({ button: 0, preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
  }
  // ★ 第一格取 `a/two` 而不是日榜第一行：日榜首行的主键是内置预译表里真那一条（夹具为了让中文列真命中，
  //   见 snapFixture），拿它拼这条 URL 断言会把"编码斜杠"这条判据拴在一个会变动的夹具键上。
  const encoded = encodeURIComponent('a/two');
  assert.deepEqual(plain(seen), [
    `/gh-trending/api/repo?name=${encoded}`,
    `/gh-trending/api/repo?name=${encoded}`,
    '/gh-trending/api/repo?name=c%2Frise',
  ], 'owner/repo 里的斜杠必须编码，否则多出一个路径段 ⇒ 宿主读到的 name 是坏的');
});

check('client-45 打开态整页：遮罩挂在 gt-root 内、页签条常驻、「重新取一次」走 &refresh=1', () => {
  const seen = [];
  const detail = { repo: 'a/one', loading: false, view: detailFixture(), err: '' };
  const { exports } = loadClient(PAYLOAD, {
    snap: snapFixture(), tab: 'daily', detail,
    fetch: async (url) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => ({ ok: true, data: detailFixture() }) }; },
  });
  const tree = render(exports.__test.components.GhTrendingPage, {});
  const root = findByClass(tree, 'gt-root')[0];
  assert.equal(findByClass(tree, 'gt-modal-mask').length, 1);
  assert.ok(root.children.some((c) => c && c.type === 'div' && String(c.props.className || '').includes('gt-modal-mask')),
    '遮罩必须在 .gt-root 之内：--gt-* 变量与 box-sizing 都声明在根上，飘到外面就是一片无样式');
  assert.equal(findByClass(tree, 'gt-tabs').length, 1, '开着框也不该把页签条换掉');
  assert.equal(findByClass(tree, 'gt-card-t').length, 1, '底下的日榜表还在原处（框是盖上去的，不是换页）');
  findByClass(tree, 'gt-modal-x')[0].props.onClick();
  const btn = findAllType(findByClass(tree, 'gt-modal-f')[0], 'button')[0];
  btn.props.onClick();
  assert.deepEqual(plain(seen), ['/gh-trending/api/repo?name=a%2Fone&refresh=1'],
    '重新取一次必须带 refresh=1：不带就命中 12h 缓存，等于按钮白点');
});

/* ---------------- 模型现译（#19 新增） ---------------- */
check('client-49 设置卡的现译两档：键位吃载荷、点出去的是严格布尔，没句柄时换成那句「改了也不会译」', () => {
  const { SettingsCard } = loadClient().exports.__test.components;
  const sent = [];
  const mk = (over = {}) => render(SettingsCard, {
    snap: { ...snapFixture(), ...over.snap },
    saving: over.saving === true, savedNote: '', savedErr: false,
    language: '', onLanguage() {}, onInterval() {}, proxyUrl: '', onProxyUrl() {},
    onSave: (p) => sent.push(p),
  });
  const segRows = (tree) => findByClass(tree, 'gt-setrow')
    .filter((r) => findByClass(r, 'gt-seg').length)
    .map((r) => text(findByClass(r, 'gt-setlabel')[0]));
  const btns = (tree, label) => kidsOf(findByClass(setRow(tree, label), 'gt-seg')[0], 'button');

  const base = mk();
  // 夹具是 desc 关 / readme 开（出厂是 desc 开 / readme 关）：两头都反着默认，高亮才分得清吃的是载荷还是写死
  assert.deepEqual(btns(base, '描述现译').map(text), ['关', '开'], '两档各一个开/关，档位话术客户端不自己起');
  assert.deepEqual(btns(base, '描述现译').map((b) => hasCls(b, 'on')), [true, false]);
  assert.deepEqual(btns(base, '摘要现译').map((b) => hasCls(b, 'on')), [false, true]);
  assert.deepEqual(segRows(base), ['检查间隔', '详情缓存', '出网方式', '现译引擎', '描述现译', '摘要现译'],
    '行序：检查间隔 → 详情缓存（第十二轮加档的地方）→ 出网方式 → 现译引擎 → 现译两档');
  const t = text(base);
  assert.ok(t.includes(LLM_SWITCH_LABELS.llmDesc) && t.includes(LLM_SWITCH_LABELS.llmReadme), '每一档那句说明来自载荷');
  assert.ok(t.includes(TRANSLATE_COMMON_NOTE), '这一屏要当场说清「只补内置表没命中的那一句，命中过不重发」');

  btns(base, '描述现译')[1].props.onClick();
  btns(base, '摘要现译')[0].props.onClick();
  assert.deepEqual(plain(sent), [{ llmDesc: true }, { llmReadme: false }], '一次点击只发那一档那一个键');
  assert.equal(typeof sent[0].llmDesc, 'boolean', '必须是真布尔：宿主那一关对 "true" 这种字符串直接 400');
  assert.equal(sent[1].llmReadme, false);

  const busy = mk({ saving: true });
  assert.deepEqual([...btns(busy, '描述现译'), ...btns(busy, '摘要现译')].map((b) => b.props.disabled), [true, true, true, true],
    '保存中四颗全哑：连着点会把两档写成一开一关的反话');

  const noHandle = mk({ snap: { translator: translatorView({ translator: { ready: () => false, kinds: () => [...LLM_KINDS] } }, { translateEngine: 'host_llm', llmDesc: false, llmReadme: true }) } });
  const noT = text(noHandle);
  assert.ok(noT.includes(LLM_NOT_READY_HINT), '宿主没给模型服务 ⇒「现译引擎」那一行要换成那句「改了也不会译」');
  assert.equal(noT.split(LLM_NOT_READY_HINT).length - 1, 1, '那句话整屏只许念一次（三行都念一遍是多此一举）');
  assert.ok(noT.includes(LLM_SWITCH_LABELS.llmDesc), '开关那两行照旧说自己管什么，不重复念"能不能发"');
  assert.deepEqual(btns(noHandle, '摘要现译').map((b) => hasCls(b, 'on')), [false, true], '开关位仍照库里（没句柄不许谎报成关）');
  btns(noHandle, '描述现译')[1].props.onClick();
  assert.deepEqual(plain(sent.slice(2)), [{ llmDesc: true }], '没句柄时开关仍可保存（库里的事实与有没有句柄是两件事）');

  // ★ 第十五轮曾裁「翻译四档没有摘要能力 ⇒ 那一行压根不摆」；**第十七轮用户改判放回**（「我前面是有摘要现译的，给我放出来」）。
  //   这条判据留下的是能留下的那一半：行清单仍由**载荷**给，客户端不自己补行；变的是四档现在也摆这一行。
  const oneRow = mk({
    snap: {
      translator: translatorView(
        { webTranslator: { ready: () => true, why: () => '', kinds: () => ['desc', 'readme'] } },
        { translateEngine: 'keyless', llmDesc: false, llmReadme: true },
      ),
    },
  });
  assert.deepEqual(segRows(oneRow), ['检查间隔', '详情缓存', '出网方式', '现译引擎', '描述现译', '摘要现译'],
    '免费接口那一档现在两行都摆（第十七轮）；开关位仍照库里：描述关、摘要开');
  const oneT = text(oneRow);
  assert.deepEqual(btns(oneRow, '描述现译').map((b) => hasCls(b, 'on')), [true, false], '两行的开关位各自照库里，不许互相顶（按钮序是「关 / 开」）');
  assert.deepEqual(btns(oneRow, '摘要现译').map((b) => hasCls(b, 'on')), [false, true], '免费接口这一档的摘要开关位同样照库里 —— 放回的就是这一行');
  assert.ok(oneT.includes(LLM_README_LABEL_TRANSLATE), '翻译档的摘要那一行必须念「是节译不是摘要」那句 —— 不放回假名是本轮唯一保留的口径');
  assert.equal(oneT.includes(LLM_SWITCH_LABELS.llmReadme), false, '宿主模型那句「另给一段中文摘要」不许出现在免费接口这一档');

  // 渲染半边那条律（载荷给几行就摆几行，客户端不自己补）单独钉：喂一份**只登记一行**的载荷。
  // ★ 真服务第十七轮起两档都报 desc+readme，所以这一份**不是**当前真形状 —— 它只测渲染，别当能力声明引。
  const trulyOne = mk({
    snap: { translator: translatorView(
      { webTranslator: { ready: () => true, why: () => '', kinds: () => ['desc'] } },
      { translateEngine: 'keyless', llmDesc: true, llmReadme: true },
    ) },
  });
  assert.deepEqual(segRows(trulyOne), ['检查间隔', '详情缓存', '出网方式', '现译引擎', '描述现译'],
    '载荷只登记一行时客户端不许自己补出第二行');
  assert.equal(text(trulyOne).includes('摘要现译'), false);

  const legacy = mk({ snap: { translator: undefined } });
  assert.equal(text(legacy).includes('描述现译'), false, '旧宿主载荷没给 translator 键 ⇒ 整段不摆（点了没反应的开关比没有更糟）');
  assert.deepEqual(segRows(legacy), ['检查间隔', '详情缓存', '出网方式'],
    '旧宿主只撤现译那几行；详情缓存吃的是入口载荷，这份载荷里带着就照常渲染');
});

check('client-52 设置卡的现译引擎五档 + 各家凭据与注册行：档名吃载荷、密钥只进不回、不吃凭据的档不摆这两行', () => {
  const { SettingsCard } = loadClient().exports.__test.components;
  const sent = [];
  const typed = [];
  const CRED_ID = { baiduAppid: 'public-id', tencentSecretId: 'public-id', aliyunAccessKeyId: 'public-id' };
  const SECRET_VAL = 'sekret-must-not-surface';
  /** 视图由宿主 translatorView 现造（同 netView 那条律）；「库里存没存过」跟着喂给它的 prefs 走。 */
  const trOf = (engine, withCred = true) => translatorView(
    { webTranslator: { ready: () => true, why: () => '', kinds: () => ['desc'] }, translator: { ready: () => true } },
    {
      translateEngine: engine, llmDesc: false, llmReadme: true,
      ...(withCred ? Object.fromEntries((TRANSLATE_CRED_FIELDS[engine] || []).map((f) => [f.key, f.secret ? SECRET_VAL : CRED_ID[f.key]])) : {}),
    },
  );
  const mk = (over = {}) => render(SettingsCard, {
    snap: { ...snapFixture(), translator: over.translator ?? trOf(over.engine ?? 'baidu', over.noCred !== true) },
    saving: over.saving === true, savedNote: '', savedErr: false,
    language: '', onLanguage() {}, onInterval() {}, proxyUrl: '', onProxyUrl() {},
    credDraft: over.credDraft ?? null,
    onCred: (k, v) => typed.push([k, v]),
    onSave: (p) => sent.push(p),
  });
  const segBtns = (tree, label) => kidsOf(findByClass(setRow(tree, label), 'gt-seg')[0], 'button');
  const btn = (row, name) => findByClass(row, 'gt-btn').filter((b) => text(b) === name)[0];
  const CRED_ENGINES = ['baidu', 'tencent', 'aliyun'];

  // ① 五档并排（用户裁定 10-06：分段器并排五档）：名字、顺序、高亮、hint 全来自载荷，客户端一个字不写
  const tree = mk({ engine: 'baidu' });
  const names = TRANSLATE_ENGINES.map((e) => TRANSLATE_ENGINE_LABELS[e]);
  assert.deepEqual(segBtns(tree, '现译引擎').map(text), names, '五枚按钮：档名与顺序来自 snap.translator');
  assert.deepEqual(segBtns(tree, '现译引擎').map((b) => hasCls(b, 'on')), TRANSLATE_ENGINES.map((e) => e === 'baidu'),
    '高亮跟着库里的 translateEngine，不跟着数组下标');
  assert.deepEqual(segBtns(tree, '现译引擎').map((b) => b.props.disabled), TRANSLATE_ENGINES.map((e) => e === 'baidu'),
    '已选中那颗哑掉（重复点等于白发一发），其余四颗可点');
  const rowText = text(setRow(tree, '现译引擎'));
  assert.ok(rowText.includes(TRANSLATE_ENGINE_HINTS.baidu), '这一档是什么、要不要注册、离不离得开代理，由载荷那句说');
  for (const e of TRANSLATE_ENGINES.filter((x) => x !== 'baidu')) {
    assert.equal(rowText.includes(TRANSLATE_ENGINE_HINTS[e]), false, `${e} 的 hint 不许一起念：一句只跟当前档`);
  }
  sent.length = 0;
  segBtns(tree, '现译引擎')[2].props.onClick();
  assert.deepEqual(plain(sent), [{ translateEngine: 'tencent' }], '点档只发那一个键，不顺手把凭据一起发出去');

  // ② 三家各自的凭据行：两格的键名/标签/长度/是否密钥全来自 TRANSLATE_CRED_FIELDS
  for (const engine of CRED_ENGINES) {
    const fields = TRANSLATE_CRED_FIELDS[engine];
    const t = mk({ engine });
    const row = setRow(t, '接口凭据');
    assert.ok(row, `${engine} 这一档要吃什么凭据，界面上就得摆出来`);
    const inputs = findAllType(row, 'input');
    assert.equal(inputs.length, 2, `${engine}：两格，一格标识符一格密钥`);
    assert.deepEqual(inputs.map((i) => i.props.maxLength), fields.map((f) => f.maxLength), `${engine}：长度上限来自载荷表`);
    assert.deepEqual(inputs.map((i) => i.props.type), fields.map((f) => (f.secret ? 'password' : 'text')),
      `${engine}：密钥框必须是 password，截图上不能是一串明文`);
    assert.deepEqual(inputs.map((i) => i.props.autoComplete), fields.map((f) => (f.secret ? 'new-password' : 'off')),
      `${engine}：密钥格别被浏览器自动填上`);
    // 标识符不是密钥 ⇒ 快照里有它，回填；密钥被 publicPrefs 摘掉了 ⇒ 界面无从"填回原值"，永远空着起步
    assert.equal(inputs[0].props.value, snapFixture().prefs[fields[0].key], `${engine}：标识符从快照回填（载荷里本来就有）`);
    assert.equal(inputs[1].props.value, '', `${engine}：密钥格永远空着`);
    assert.equal(inputs[1].props.placeholder, SECRET_SAVED_HINT, `${engine}：库里存过 ⇒「留空不改动」那句挂在 placeholder 上`);
    assert.deepEqual(inputs.map((i) => i.props.placeholder), [fields[0].label, SECRET_SAVED_HINT],
      `${engine}：格子的名字挂在 placeholder 上（标识符那格永远是自己的名字，密钥那格存过就说"留空不改动"）`);
    assert.ok(text(row).includes(TRANSLATE_CRED_NOTE), `${engine}：这一行往出网参数里放东西，边界要说在填之前`);
    assert.equal(text(t).includes(SECRET_VAL), false, `${engine}：密钥本体不许出现在任何文案里`);
    assert.equal('value' in (trOf(engine).credFields[1]), false, '载荷里密钥那一格只许给 has 一位，不许带值');

    // 打字打出去的是「键名 + 值」，键名来自载荷表（客户端不写死六格）
    typed.length = 0;
    inputs.forEach((inp, i) => inp.props.onChange({ target: { value: `t${i}` } }));
    assert.deepEqual(plain(typed), fields.map((f, i) => [f.key, `t${i}`]), `${engine}：每格各归各的键名`);

    // 注册行（用户裁定 10-06：切换官方接口时，下面显示去哪个网址注册 key）
    const reg = setRow(t, '注册拿密钥');
    assert.ok(reg, `${engine}：选中它就当下要注册，注册地址必须在这行下面`);
    const links = findAllType(reg, 'a');
    assert.deepEqual(links.map((a) => a.props.href), TRANSLATE_REGISTER[engine].links.map((l) => l.url));
    assert.deepEqual(links.map((a) => text(a)), TRANSLATE_REGISTER[engine].links.map((l) => l.label));
    assert.deepEqual(links.map((a) => [a.props.target, a.props.rel]), links.map(() => ['_blank', 'noreferrer']),
      '外链不许把面板导航带走（没有 noreferrer 还会把来源 URL 递给厂商）');
    assert.ok(text(reg).includes(TRANSLATE_REGISTER[engine].quota), `${engine}：额度那句跟注册链接一起说`);
    for (const other of CRED_ENGINES.filter((x) => x !== engine)) {
      assert.equal(text(reg).includes(TRANSLATE_REGISTER[other].links[0].url), false,
        `${engine} 档上不许念 ${other} 的注册地址（五档并排时把三家网址堆一起等于没答）`);
    }
  }

  // ③ 库里还没存密钥 ⇒ 不念「库里已存」那句谎；一家都没存 ⇒ 连「清除」都不摆（点了等于把空存成空）
  const fresh = mk({ engine: 'tencent', noCred: true });
  const freshRow = setRow(fresh, '接口凭据');
  const freshInputs = findAllType(freshRow, 'input');
  assert.equal(freshInputs[1].props.placeholder, TRANSLATE_CRED_FIELDS.tencent[1].label);
  assert.equal(btn(freshRow, '清除'), undefined, '没凭据时不给「清除」');
  assert.equal(trOf('tencent', false).credStored, false, '前提：这一档确实一格都没存');
  assert.equal(btn(freshRow, '保存').props.disabled, true, '草稿与库里一致 ⇒ 保存哑掉');

  // ④ 保存的四种情形：只改标识符 / 密钥留空 / 改了密钥 / 草稿里带着别家的格
  sent.length = 0;
  const onlyId = mk({ engine: 'baidu', credDraft: { baiduAppid: ' new-appid ' } });
  btn(setRow(onlyId, '接口凭据'), '保存').props.onClick();
  assert.deepEqual(plain(sent), [{ baiduAppid: 'new-appid' }], '密钥框留空 = 不改动 ⇒ 那一格压根不进 patch');

  sent.length = 0;
  const blankKey = mk({ engine: 'baidu', credDraft: { baiduKey: '   ' } });
  const blankRow = setRow(blankKey, '接口凭据');
  assert.equal(btn(blankRow, '保存').props.disabled, true, '密钥格打了空格又删掉 ⇒ 与库里一致，不许发');
  btn(blankRow, '保存').props.onClick();
  assert.deepEqual(plain(sent), [{}], '点到它发出去的也必须是一空包：密钥框留空绝不能变成「把库里的密钥清掉」');

  sent.length = 0;
  const withKey = mk({ engine: 'aliyun', credDraft: { aliyunAccessKeySecret: ' ak ' } });
  btn(setRow(withKey, '接口凭据'), '保存').props.onClick();
  assert.deepEqual(plain(sent), [{ aliyunAccessKeySecret: 'ak' }], '发了密钥就该是 trim 过的草稿');

  sent.length = 0;
  const cross = mk({ engine: 'tencent', credDraft: { tencentSecretId: 'AKIDnew', baiduAppid: 'junk', baiduKey: 'junk' } });
  btn(setRow(cross, '接口凭据'), '保存').props.onClick();
  assert.deepEqual(plain(sent), [{ tencentSecretId: 'AKIDnew' }], '换档时留下的别家草稿不串台：只发当前这一档的两格');

  // ⑤ 清除 = 把**这一档**那两格写成空串，别家的凭据一格都不许多动
  sent.length = 0;
  btn(setRow(tree, '接口凭据'), '清除').props.onClick();
  assert.deepEqual(plain(sent), [{ baiduAppid: '', baiduKey: '' }]);
  assert.deepEqual(Object.keys(sent[0]).sort(), TRANSLATE_CRED_FIELDS.baidu.map((f) => f.key).sort(),
    '一键清三家是这次改判之后的新风险：清除的键必须逐字等于当前档的字段表');

  // ⑥ 不吃凭据的两档（免费接口 / 宿主模型）：这两行压根不摆
  for (const e of ['keyless', 'host_llm']) {
    const other = mk({ engine: e });
    assert.equal(setRow(other, '接口凭据'), undefined, `${e} 档不摆凭据行（填了没人吃 = 多此一举）`);
    assert.equal(setRow(other, '注册拿密钥'), undefined, `${e} 档不摆注册地址`);
    assert.equal(findAllType(other, 'input').length, findAllType(tree, 'input').length - 2,
      `${e} 档连输入框都不摆（填了没人吃的框比没有更难解释）`);
  }

  // ⑦ 草稿收口（与代理地址同一条律）：发出去过的格子丢掉草稿，密钥格发完即清
  const src = clientSrc();
  assert.match(src, /if \(Object\.keys\(credDraft \|\| \{\}\)\.some\(\(k\) => patch\[k\] !== undefined\)\)/,
    '保存成功后要把发出去过的那些键从草稿里丢掉：留着的话下一次保存会把旧密钥当新密钥再发一遍');
  assert.equal(PREF_SECRET_KEYS.some((k) => src.includes(k)), false,
    `界面半边不许出现密钥格键名（读了也永远是空，写成读它就是骗自己）：${PREF_SECRET_KEYS.filter((k) => src.includes(k)).join(',')}`);
  assert.match(src, /const storedCred = \(f\) => \(f\.secret \? '' : String\(snap\?\.prefs\?\.\[f\.key\] \?\? ''\)\)/,
    '回填与"是否改动"的判据只有一条通道，且密钥那一格在这一条上恒为空');
  // 注册那两枚链接的观感判据（真机截图抓出来的：它们被 .gt-link 的 margin-left:auto 推到行尾，标签与链接之间一大片空）
  const css = (clientSrc().match(/const CSS = `([\s\S]*?)`;/) || [])[1];
  const rules = (css || '').replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*\}/g) || [];
  const pushed = rules.filter((r) => /\.gt-link\b/.test(r.split('{')[0]) && /margin-left\s*:\s*auto/.test(r));
  assert.ok(pushed.length, '前提：.gt-link 默认就是"推到行尾"（卡头那颗靠它）⇒ 下面这条才有东西要压');
  const tamed = rules.filter((r) => /\.gt-setrow\b[^{}]*\.gt-link/.test(r.split('{')[0]) && /margin-left\s*:\s*0/.test(r));
  assert.equal(tamed.length >= 1, true, '设置行里的链接必须贴回标签：只改图不算修，规则改回去截图就白截了');
});

check('client-56 ★GitHub 令牌行（第二十一轮）：格表/说明句/创建网址全吃 snap.github，密钥格永不回填，清除只在存过时摆', () => {
  const { SettingsCard } = loadClient().exports.__test.components;
  const sent = [];
  const typed = [];
  const GH_VAL = 'ghp-must-not-surface';
  const mk = (over = {}) => render(SettingsCard, {
    snap: { ...snapFixture(), github: over.github ?? githubView({}) },
    saving: over.saving === true, savedNote: '', savedErr: false,
    language: '', onLanguage() {}, onInterval() {}, proxyUrl: '', onProxyUrl() {},
    credDraft: over.credDraft ?? null,
    onCred: (k, v) => typed.push([k, v]),
    onSave: (p) => sent.push(p),
  });
  const btn = (row, name) => findByClass(row, 'gt-btn').filter((b) => text(b) === name)[0];

  // ① 存过令牌那一形状：password 格 + 「留空不改动」placeholder + 说明句 + 「清除」在场
  const filled = mk({ github: githubView({ ghToken: GH_VAL }) });
  const frow = setRow(filled, 'GitHub 令牌');
  assert.ok(frow, '填过令牌就要看得见这一行（不然用户没法确认"配额为什么还是 60"）');
  const finputs = findAllType(frow, 'input');
  assert.equal(finputs.length, GH_CRED_FIELDS.length, '格数来自载荷表，界面不写死一格');
  assert.deepEqual(finputs.map((i) => i.props.type), GH_CRED_FIELDS.map((f) => (f.secret ? 'password' : 'text')),
    '令牌框必须是 password，截图上不能是一串明文');
  assert.deepEqual(finputs.map((i) => i.props.autoComplete), GH_CRED_FIELDS.map((f) => (f.secret ? 'new-password' : 'off')));
  assert.deepEqual(finputs.map((i) => i.props.maxLength), GH_CRED_FIELDS.map((f) => f.maxLength));
  assert.equal(finputs[0].props.value, '', '密钥格永不回填：载荷里根本没有那一格，写出来读就是骗自己');
  assert.equal(finputs[0].props.placeholder, SECRET_SAVED_HINT, '库里存过 ⇒ placeholder 说"留空不改动"');
  assert.ok(text(frow).includes(GH_TOKEN_NOTE), '这一行的边界话（只发给 api.github.com、只进请求头）来自 domain');
  assert.equal(text(filled).includes(GH_VAL), false, '令牌本体不许出现在任何文案里');
  assert.ok(btn(frow, '清除'), '存过 ⇒ 给「清除」');
  sent.length = 0;
  btn(frow, '清除').props.onClick();
  assert.deepEqual(plain(sent), [Object.fromEntries(GH_CRED_FIELDS.map((f) => [f.key, '']))],
    '清除只发 GitHub 那一格的空串，三家翻译的凭据一格都不许多动');

  // ② 没存过（出厂形状）：不念「库里已存」、不摆清除、草稿空 ⇒ 保存哑掉
  const bare = mk();
  const brow = setRow(bare, 'GitHub 令牌');
  assert.ok(brow, '没填也要摆这一行 —— 它就是"去哪填"的入口');
  assert.equal(findAllType(brow, 'input')[0].props.placeholder, GH_CRED_FIELDS[0].label);
  assert.equal(btn(brow, '清除'), undefined, '库里没东西时给「清除」等于把空存成空');
  assert.equal(btn(brow, '保存').props.disabled, true, '草稿空 ⇒ 保存哑掉（不许发一发没改动的 POST）');

  // ③ 打字与保存：键名从载荷表来（界面里没有 'ghToken' 这个字面量），值原样递草稿
  typed.length = 0;
  findAllType(frow, 'input')[0].props.onChange({ target: { value: ' x ' } });
  assert.deepEqual(plain(typed), GH_CRED_FIELDS.map((f) => [f.key, ' x ']), '每格各归各的键名');
  sent.length = 0;
  const draft = mk({ github: githubView({}), credDraft: { ghToken: ' ghp-new ' } });
  const drow = setRow(draft, 'GitHub 令牌');
  assert.equal(findAllType(drow, 'input')[0].props.value, ' ghp-new ', '输入框吃草稿原样（含正在打的空格），与代理地址同一条律');
  assert.equal(btn(drow, '保存').props.disabled, false, '草稿有改动 ⇒ 保存要能点');
  btn(drow, '保存').props.onClick();
  assert.deepEqual(plain(sent), [{ ghToken: 'ghp-new' }], '发出去的是 trim 过的那一份，且只发这一格');

  // ④ 「创建令牌」那一行：网址与额度那句全来自 gh.register，界面一个字不写；外链带走 noreferrer
  const reg = setRow(filled, '创建令牌');
  assert.ok(reg, '这一行是"去哪拿令牌"的唯一入口');
  const links = findAllType(reg, 'a');
  assert.deepEqual(links.map((a) => a.props.href), githubView({}).register.links.map((l) => l.url));
  assert.deepEqual(links.map((a) => text(a)), githubView({}).register.links.map((l) => l.label));
  assert.deepEqual(links.map((a) => [a.props.target, a.props.rel]), links.map(() => ['_blank', 'noreferrer']),
    '外链不许把面板导航带走');
  assert.ok(text(reg).includes(githubView({}).register.quota), '额度那句跟创建链接一起说');

  // ⑤ 载荷缺这一格（旧宿主）⇒ 整段不摆，不摆半截行
  const legacy = render(SettingsCard, {
    snap: { ...snapFixture(), github: undefined },
    saving: false, savedNote: '', savedErr: false, language: '', onLanguage() {}, onInterval() {},
    proxyUrl: '', onProxyUrl() {}, credDraft: null, onCred() {}, onSave() {},
  });
  assert.equal(setRow(legacy, 'GitHub 令牌'), undefined, '载荷没给 github ⇒ 连输入框都不摆（摆了就是发出去没人吃的框）');
  assert.equal(setRow(legacy, '创建令牌'), undefined);
});

check('client-57 详情弹框那句配额跟着宿主的 rate.label 走：给「已认证配额 / 5000」就念这一串（第二十一轮）', () => {
  const { DetailModal } = loadClient().exports.__test.components;
  const mkDetail = (v) => render(DetailModal, { detail: { repo: v.repo, loading: false, view: v, err: '' }, onClose() {}, onRefresh() {} });
  // 匿名那一形状（出厂、没填令牌）：repoView 里 label 由 authed 派生，不靠界面猜
  const anon = detailFixture();
  assert.equal(anon.rate.label, RATE_LABEL_ANON, '前提：authed 没给 ⇒ 视图必须落在「匿名配额」');
  assert.equal(anon.rate.limit, REPO_RATE_ANON, '前提：读不到 x-ratelimit-limit 时给出厂那一格（保守）');
  assert.match(text(mkDetail(anon)), new RegExp(`${RATE_LABEL_ANON}剩 41 / ${REPO_RATE_ANON}`));
  // ★ 已认证那一形状（5000 那一发是合成的，本机没令牌可抓，见 test/repo.test.mjs 第二十一轮那段注释）
  const authed = detailFixture({ at: Date.now() - 1000 }, {
    cached: false, ageMs: 0,
    rate: { left: 4987, resetAt: 0, limit: REPO_RATE_AUTH, authed: true },
  });
  assert.equal(authed.rate.label, RATE_LABEL_AUTH);
  const t = text(mkDetail(authed));
  assert.match(t, new RegExp(`${RATE_LABEL_AUTH}剩 4987 / ${REPO_RATE_AUTH}`), '填了令牌还念「匿名配额剩 N/60」就是屏上那句在说谎');
  assert.equal(t.includes(RATE_LABEL_ANON), false, '两个词不许同时出现在同一屏');
  // 界面不抄那两个词（抄一份就有第二个真相，宿主报错读数时会被界面圆成"看着对"的那一句）
  const src = clientSrc();
  assert.equal(new RegExp(`${RATE_LABEL_ANON}|${RATE_LABEL_AUTH}`).test(src), false,
    'client.js 里出现了那两个字面量 ⇒ 它不再只念载荷');
});

check('client-50 详情弹框的现译分段：描述那句换的是落款，摘要另起一段且段名点名是谁译的', () => {
  const { DetailModal } = loadClient().exports.__test.components;
  const mk = (v) => render(DetailModal, { detail: { repo: v.repo, loading: false, view: v, err: '' }, onClose() {}, onRefresh() {} });

  const desc = detailFixture({}, { zhOf: () => ({ descModel: zhRow('下一代前端构建工具。') }) });
  assert.equal(desc.zh.builtin, '', '夹具必须落在 B 没命中的那一行，否则这一路压根不该有译文（用例就在测空气）');
  const line = secBlocks(desc, 'what')[0];
  assert.ok(line, '夹具的 what 段一块都没有 ⇒ 下面这组断言在测空气');
  assert.equal(line.text.startsWith(`中文描述（${llmZhLabel(ZH_AT)}）：`), true, `落款没拼上现译时刻：${line.text}`);
  const ps = findByClass(mk(desc), 'gt-modal-p').map(text);
  assert.ok(ps.includes(line.text), '现译那一句由宿主并进段表后原样显示，客户端不许重拼');
  assert.ok(text(mk(desc)).includes('仓库自己写的描述（原文）：Next generation frontend tooling'), '译文不许把原文顶掉');

  const en = detailFixture(
    { readmeSource: 'en_default', readmePath: 'README.md', readmeExcerpt: 'Vite is a frontend build tool.', zhCjk: 0, readmeChars: 4200 },
    { zhOf: () => ({ summary: zhRow('这是一个前端构建工具的中文摘要。') }) });
  const enTree = mk(en);
  const h2s = findByClass(enTree, 'gt-modal-h2').map(text);
  // 摘要段挂在 self 段之后：self 那段自己得在屏上有个名字（第十二轮起它的 README 档名只出现在段名里）
  assert.ok(h2s.includes(`${REPO_SECTION_LABELS.self} · ${REPO_README_SOURCE_LABELS.en_default}`), `self 段名没点出 README 那一档：${h2s.join(' | ')}`);
  assert.ok(h2s.includes(`中文摘要 · ${llmZhLabel(ZH_AT)}`), `摘要段名没带现译时刻：${h2s.join(' | ')}`);
  const secs = findByClass(enTree, 'gt-modal-sec');
  const sumSec = text(secs[secs.length - 1]);
  assert.ok(sumSec.includes('这是一个前端构建工具的中文摘要。'));
  // ★ 第十二轮（四段来源落款全撤）：那句「由宿主模型从上面那段英文节选整理，不是仓库自己写的中文」不再上屏，
  //   "这不是仓库自己写的中文"改由段名里的「模型现译 · 时刻」说。两头钉：载荷没这格、屏上没这句。
  assert.equal('note' in en.zh.summary, false, '摘要载荷还带着那句说明');
  assert.equal(sumSec.includes('从上面那段英文节选整理'), false, '撤掉的来源落款又回到屏上了');
  assert.equal(text(findByClass(enTree, 'gt-modal-readme')[0]), 'Vite is a frontend build tool.', '英文节选与中文摘要并存，摘要不替换节选');
});

check('client-51 现译没成时那一格各说各的；回执有才念，zh 全空时详情里不出现「模型」两个字', () => {
  const { DetailModal } = loadClient().exports.__test.components;
  const mk = (v) => render(DetailModal, { detail: { repo: v.repo, loading: false, view: v, err: '' }, onClose() {}, onRefresh() {} });
  // 形状 = llm.js 的 fail()：闸门那一档 errText 为空，真发出去却坏了的那一档带 finish 帧的回执原文
  const row = (note, errText = '') => ({ ok: false, zh: '', cached: false, at: 0, label: '', stored: false, note, errText });

  const both = detailFixture(
    { readmeSource: 'en_default', readmePath: 'README.md', readmeExcerpt: 'Vite is a frontend tool.', zhCjk: 0 },
    { zhOf: () => ({ descModel: row('模型这次没给中文，上面显示的是原文。', 'provider_error: bad response'), summary: row('中文摘要没成，先看上面那段英文节选。') }) });
  const bt = text(mk(both));
  assert.ok(bt.includes('模型这次没给中文，上面显示的是原文。'), '描述那一路的失败句要落在描述那一段下面');
  assert.ok(bt.includes('回执：provider_error: bad response'), '那句文案承诺了「finish 帧里给的回执」⇒ 有回执就得念出来');
  assert.ok(bt.includes('中文摘要没成，先看上面那段英文节选。'), '摘要那一路的失败句要落在摘要那一段里');
  assert.deepEqual(secBlocks(both, 'what').slice(-2).map((b) => b.kind), ['sub', 'num'], '失败句是小字块、回执是数字块：这两块的轻重不同，摆成一样就等于没分');
  assert.ok(bt.includes('Next generation frontend tooling'), '没译成就势必要有原文，否则看着像仓库没写描述');
  assert.ok(bt.includes('原文，未翻译'), '失败时段里保持未翻译那一版，不许偷偷换成「中文描述」');
  // ★ 摘要没成那一档（第十一轮改判）：段照摆，但段名要写「没取到」，且没有回执就不摆回执那块
  const sumSec = findByClass(mk(both), 'gt-modal-sec').map(text).find((s) => s.startsWith(REPO_SECTION_LABELS.summaryAny));
  assert.ok(sumSec, '用户开过摘要开关，屏上得有个交代（整段不摆等于悄悄吞掉）');
  assert.match(sumSec, /没取到/);
  assert.equal(/中文摘要没成[\s\S]*回执/.test(sumSec), false, '摘要那一路没有回执（errText 空）⇒ 那一块整个不许出现，不许念成「回执：」');
  assert.equal(sumSec.includes('这是一个前端构建工具的中文摘要。'), false, '没成功就不许摆一句假的摘要正文');

  const off = detailFixture();   // zh 全空 = 开关关着 / B 命中 / 压根没派活
  assert.deepEqual(off.zh, { builtin: '', descModel: null, descNote: '', descErr: '', summary: null, summaryNote: '', summaryErr: '' });
  const ot = text(mk(off));
  assert.equal(ot.includes('模型'), false, '没开过现译的用户，详情里不该冒出「模型」字样');
  // ★ 第十七轮：中文那一段的段名有三个词（摘要/节译/现译），全空时三个都不许出现。
  assert.equal([REPO_SECTION_LABELS.summary, REPO_SECTION_LABELS.summaryTranslate, REPO_SECTION_LABELS.summaryAny]
    .some((n) => ot.includes(n)), false, 'zh 全空却摆出中文那一段的段名 = 凭空多一段');
  assert.equal(ot.includes('从上面那段英文节选整理'), false, '开关没开过的用户，屏上不该看到任何现译落款话术（第十二轮起那句已经整个不在树上了）');
});

check('client-53 设置卡：详情缓存一行分段器（第十二轮），选中项读库里的档位，点击发的是那一档', () => {
  const sent = [];
  // 载荷是 loadClient 时烘进 cfg() 的，所以两份载荷要各 load 一次（同 client-45 那组凭据行的做法）
  const S = loadClient().exports.__test.components.SettingsCard;
  const mk = (prefs, el = S) => render(el, {
    snap: { ...snapFixture(), prefs },
    saving: false, savedNote: '', savedErr: false, language: prefs.language,
    onLanguage() {}, onInterval() {}, onSave: (p) => sent.push(p),
  });
  const tree = mk({ intervalMin: 180, topN: 15, keepEvents: 300, language: '', repoCacheHours: 12 });
  const row = setRow(tree, '详情缓存');
  assert.ok(row, '设置页没有「详情缓存」这一行 ⇒ 用户改不了缓存时长（第十二轮的裁定落不了地）');
  const btns = kidsOf(findByClass(row, 'gt-seg')[0], 'button');
  assert.deepEqual(btns.map(text), ['6 小时', '12 小时', '24 小时', '3 天'], '档位文案全部来自载荷，界面一个字不写');
  assert.deepEqual(btns.map((b) => hasCls(b, 'on')), [false, true, false, false], '选中项读的是库里那份，不是出厂值');
  btns[0].props.onClick();
  assert.deepEqual(plain(sent), [{ repoCacheHours: 6 }], '点击只发选中的那一档，不许顺手带上别的键');
  // 出厂那一档 = 24 小时（用户裁定）：载荷里的 defaults 与库里的缺省必须指同一档
  assert.equal(PAYLOAD.defaults.repoCacheHours, 24);
  assert.deepEqual(REPO_CACHE_HOURS, [6, 12, 24, 72], '档位是封闭集合，多一档要连着改话术表');
  // 旧宿主没推 cacheHours ⇒ 这一行整个不摆（一排空按钮比没有更难解释，同出网方式那条判据）
  const legacy = { ...PAYLOAD }; delete legacy.cacheHours; delete legacy.cacheHourLabels;
  const legacyTree = mk({ intervalMin: 180, topN: 15, keepEvents: 300, language: '' },
    loadClient(legacy).exports.__test.components.SettingsCard);
  assert.equal(setRow(legacyTree, '详情缓存'), undefined, '载荷没给档位还摆这一行 = 摆一排没有文案的按钮');
});


check('client-54 名次徽标分档：前三名金/银/铜、第 4 名起中性，两处渲染点同一个类名（色值与兄弟插件对表）', () => {
  const { RankBadge, BoardCard, BoardMini } = loadClient().exports.__test.components;
  // ① 单点：类名跟着名次走，中性那一档不许拿到金档类
  const cls = (r) => render(RankBadge, { rank: r }).props.className;
  assert.equal(cls(1), 'gt-rank gt-rank-1');
  assert.equal(cls(2), 'gt-rank gt-rank-2');
  assert.equal(cls(3), 'gt-rank gt-rank-3');
  assert.equal(cls(4), 'gt-rank gt-rank-n', '第 4 名拿到奖牌色 = 前三名不再分得出来，这一档才是「其余」');
  for (const r of [15, 0, null, undefined, 'abc']) {
    assert.equal(cls(r), 'gt-rank gt-rank-n', `坏名次 ${String(r)} 必须落中性档，不许 NaN 拼进类名`);
  }
  // ② 两处渲染点都真带上档类（只钉 RankBadge 不算：调用点若自己拼类名会把档吃掉）
  // 夹具默认只排到第 3 名 ⇒ 这里补到第 5 名，让「其余走中性」那一档真在屏上有一行（否则那条断言是空跑）
  const base = snapFixture();
  const five = ['a/one', 'a/two', 'a/three', 'a/four', 'a/five'].map((k, i) => row(k, i + 1));
  const snap = snapFixture({ boards: { ...base.boards, daily: { ...base.boards.daily, rows: five } } });
  const boardBadges = findByClass(render(BoardCard, { snap, board: 'daily' }), 'gt-rank').map((n) => n.props.className);
  assert.equal(boardBadges.length, 5, '前提：榜页这一屏要有第 4、5 名，否则「其余走中性」那一档没人验');
  assert.deepEqual(boardBadges.slice(0, 3), ['gt-rank gt-rank-1', 'gt-rank gt-rank-2', 'gt-rank gt-rank-3']);
  assert.equal(boardBadges[3], 'gt-rank gt-rank-n');
  const mini = findByClass(render(BoardMini, { snap: snapFixture(), board: 'daily', onGo() {} }), 'gt-rank');
  assert.deepEqual(mini.map((n) => n.props.className),
    ['gt-rank gt-rank-1', 'gt-rank gt-rank-2', 'gt-rank gt-rank-3'], '总览速览那三行同样分档');
  // ③ CSS 侧：三档色值逐字钉住（观感口径跟 modelwatch 的 .mw-rank-1/2/3 对表，改一处要连着改另一处）
  const css = (clientSrc().match(/const CSS = `([\s\S]*?)`;/) || [])[1] || '';
  const SIBLING = { 1: '#e8b530', 2: '#c3c9d2', 3: '#cf9a63' };
  for (const [n, bg] of Object.entries(SIBLING)) {
    assert.ok(new RegExp(`\.gt-rank-${n}\{background:${bg};color:#[0-9a-f]{6}\}`).test(css),
      `第 ${n} 名的色档缺一条规则 ⇒ 类名挂着而屏上还是灰的（「规则文本在、效果死」那一族）`);
  }
  assert.ok(/\.gt-rank-n\{background:var\(--gt-soft\);color:var\(--gt-faint\);border:1px solid var\(--gt-line\)\}/.test(css),
    '中性档必须吃宿主令牌，别把灰也写成死色');
  assert.ok(!/^\.gt-rank\{[^}]*background/m.test(css), '底色只许由档类给，底座再上一次底色就是两份真相');
});

check('client-55 同一条失败句在详情里只念一次：摘要段那块跟着描述段去重（第十六轮）', () => {
  const { DetailModal } = loadClient().exports.__test.components;
  const mk = (v) => text(render(DetailModal, { detail: { repo: v.repo, loading: false, view: v, err: '' }, onClose() {}, onRefresh() {} }));
  const count = (t, s) => t.split(s).length - 1;
  // 形状 = llm.js 的 `fail()` 那一份：两路挂在同一个档上（`pickTranslator` 只选一个服务），
  // note 与 errText 必然是**逐字相同**的两个副本 ⇒ 老写法会在描述段与摘要段各念一遍同一句话。
  const row = { ok: false, zh: '', cached: false, at: 0, label: '', stored: false, errKey: 'transport',
    note: '没能连上翻译接口（免费接口那一路要经代理，代理没开或不通就是这句），原文照给', errText: '请求号 R-1 connect ECONNREFUSED' };
  const en = { readmeSource: 'en_default', readmePath: 'README.md', readmeExcerpt: 'Vite is a frontend tool.', zhCjk: 0 };
  const both = detailFixture(en, { zhOf: () => ({ descModel: row, summary: row }) });
  const t = mk(both);
  assert.equal(count(t, '没能连上翻译接口'), 1, '同一条失败句在详情里念了两遍（描述行与摘要行各一遍）');
  assert.equal(count(t, '回执：'), 1, '回执同理：一句原因摆两处就是多此一举');
  assert.ok(t.includes(REPO_SECTION_LABELS.summaryAny), '撤的是重复那句，不是这一路的结论 —— 摘要段还得在屏上（失败行没有引擎 ⇒ 段名是「中文现译 · 没取到」）');
  assert.match(secOfView(both, 'summary').label, /没取到/);
  assert.deepEqual(secOfView(both, 'summary').blocks, [], '两块都与描述段逐字相同 ⇒ 摘要段只留段名（段名那句「没取到」是新信息）');
  // 两路原因不同（描述挂在传输、摘要回得太长）⇒ 各说各的，去重不许把摘要那句一起吞掉
  const diff = detailFixture(en, { zhOf: () => ({ descModel: row,
    summary: { ...row, note: '翻译接口回得太长，不像一句译文，原文照给', errText: '1,842 字' } }) });
  const td = mk(diff);
  assert.equal(count(td, '1,842 字'), 1, '摘要自己的回执被去重去掉了');
  assert.ok(td.includes('翻译接口回得太长'), '原因不同却撤掉摘要那句 = 把一次失败说成没有失败');
});

/* ---------------- 第二十三轮：明星仓库那一屏（§7.7 形状 B / §8.8 第 6 步） ---------------- */

/** 落库那一批 search 行的形状 = `SEARCH_ROW_SHAPE`（主键小写、六格，rank 之外不带任何派生格）。 */
const searchRowOf = (rank, repo, over = {}) => ({
  rank, repo, name: repo, desc: 'A plain english line', lang: 'JavaScript', stars: 400000 - rank * 1000, ...over,
});
const searchBatchOf = (rows, bo = {}) => ({
  ok: true, at: atOff(-60000), rows, rateLeft: 8, rateLimit: 10, rateResetAt: 0, rateAuthed: false, ...bo,
});
/** 单组件渲染 StarsCard：把内部两个状态（第 0 个 = 视图，第 1 个 = 排序）顶成指定值。 */
const starsWith = (view, snap, props = {}, sort) => {
  const states = sort === undefined ? [view] : [view, sort];
  const lc = loadClient(PAYLOAD, { states });
  return { lc, tree: render(lc.exports.__test.components.StarsCard, { snap, onRepo() {}, onSave() {}, ...props }) };
};
/** 明星那一屏的一行格（tbody 第 i 行）。 */
const starsCells = (tree, i = 0) => kidsOf(kidsOf(findAllType(tree, 'table')[0], 'tbody')[0], 'tr')
  .map((tr) => kidsOf(tr, 'td'))[i];

check('client-59 明星那一屏：形状 B 七列 / 全站高星档六列，col·th·td 逐列同数且整页一张卡（§8.8 第 6 步）', () => {
  const { StarsCard, GhTrendingPage } = loadClient().exports.__test.components;
  const snap = snapFixture();
  const tree = render(StarsCard, { snap, onRepo() {}, onSave() {} });
  const tbl = findAllType(tree, 'table')[0];
  assert.ok(tbl, '表没渲染出来，判据空转');
  const cols = kidsOf(kidsOf(tbl, 'colgroup')[0], 'col');
  const ths = cellsOf(tbl, 'thead');
  const tds = cellsOf(tbl, 'tbody');
  assert.equal(cols.length, 7, '形状 B 是七列（九列那一版把首屏吃成两三行表，用户已否）');
  assert.equal(ths.length, cols.length, '表头列数 ≠ 列模板');
  assert.equal(tds.length, cols.length, '数据格数 ≠ 列模板（fixed 布局下整行错位）');
  const seq = (list) => list.map((n) => hasCls(n, 'gt-r')).join(',');
  assert.equal(seq(ths), seq(tds), '表头与列值对齐方向逐列不一致');
  // 列名逐字吃载荷：两个"并进"列的名字只归 domain
  assert.deepEqual(ths.map(text), ['#', '仓库', '描述', '语言', snap.stars.starsAddedLabel, snap.stars.roundsPeakLabel, '']);
  assert.ok(hasCls(ths[6], 'gt-tail') && text(ths[6]) === '', '兜底列必须空且带 gt-tail');
  // 列宽律与榜面同一条：数值列拿死数、唯一读得出内容的那列吃余量、末尾兜底 0
  assert.equal(cols[0].props.style.width, 46);
  assert.ok(hasCls(cols[1], 'gt-col-repo') && !cols[1].props.style, '仓库列宽走 CSS（窄视口要能回退）');
  assert.ok(hasCls(cols[2], 'gt-col-desc') && !cols[2].props.style, '描述列 width:auto 吃余量');
  assert.deepEqual(cols.slice(3, 6).map((c) => c.props.style.width), [112, 132, 104],
    '三个数值列的死数改了要连同需宽读数一起对（累计★ / 今日新增并进那格 / 在榜并进那格）');
  assert.ok(hasCls(cols[6], 'gt-tail') && !cols[6].props.style, '兜底列宽度归 CSS，不许内联写宽');

  // 卡头只摆三件（标题 / 视图分段器 / 那一档的开关）；排序分段器与统计那句在卡体首行 .gt-bar
  const head = findByClass(tree, 'gt-card-h')[0];
  const body = findByClass(tree, 'gt-card-b')[0];
  assert.equal(findByClass(head, 'gt-seg').length, 1, '卡头有第二个分段器 = 控件全挤回卡头，窄面板会把卡头顶到 81~165px（A 被否的主因）');
  assert.deepEqual(findByClass(head, 'gt-seg').flatMap((s) => kidsOf(s, 'button').map(text)), snap.stars.views.map((o) => o.label));
  assert.equal(findByClass(head, 'gt-btn').length, 1);
  assert.equal(findByClass(body, 'gt-bar').length, 1, '.gt-bar（排序 + 统计那句）是卡体首行，不是卡头');
  assert.deepEqual(findByClass(body, 'gt-bar').flatMap((s) => findByClass(s, 'gt-seg').flatMap((g) => kidsOf(g, 'button').map(text))),
    snap.stars.sorts.map((o) => o.label), '排序分段器在卡体那一行里（按钮挂在 gt-seg 下，不是 gt-bar 直接子）');
  assert.equal(findByClass(tree, 'gt-note').length, 0, '原型卡脚那两句是客户端自拼的框架句，不进生产（§8.8 落地改口 13）');

  // 整页一张卡：section.gt-card 是 .gt-root 的直接子（照 BoardCard），不是 .gt-panel 的孙子
  const page = render(loadClient(PAYLOAD, { tab: 'stars', snap }).exports.__test.components.GhTrendingPage, {});
  const root = findByClass(page, 'gt-root')[0];
  const sections = kidsOf(root, 'section');
  assert.equal(sections.length, 1, '明星页就是一张卡');
  assert.ok(hasCls(sections[0], 'gt-card'), '卡不是 .gt-root 的直接子 ⇒ 宿主 flex 链断在这一层，卡没高度');
  assert.equal(kidsOf(root, 'div').filter((n) => hasCls(n, 'gt-panel')).length, 0, '这一页不许再套一层 .gt-panel');

  // 名次徽标的语义（第十四轮那套色档在这一屏的用法）：奖牌只给"有依据的名次"
  const badges = (t) => findByClass(t, 'gt-rank').map((n) => n.props.className);
  assert.deepEqual(badges(tree).slice(0, 3), ['gt-rank gt-rank-1', 'gt-rank gt-rank-2', 'gt-rank gt-rank-3'],
    '按总星排时前三行拿金银铜（排序后的第几名 = 这一屏当前的读数）');
  assert.deepEqual(badges(tree).slice(3), ['gt-rank gt-rank-n', 'gt-rank gt-rank-n']);
  assert.deepEqual(badges(starsWith('all', snap, {}, 'added').tree), Array(5).fill('gt-rank gt-rank-n'),
    '按今日新增排就不许涂金银铜：那一个顺序里没有"名次"这件事');
  // 那一档的徽标读的是载荷 rank（GitHub 给的位置），不是重排后的行号 —— 两者可以不等
  const rankSnap = snapFixture({}, { prefs: { allStarsEnabled: true }, search: searchBatchOf([
    searchRowOf(3, 'c/third', { stars: 999000 }), searchRowOf(1, 'a/first', { stars: 100 }), searchRowOf(2, 'b/sec', { stars: 200 }),
  ]) });
  const rankTree = starsWith('allStars', rankSnap).tree;
  assert.deepEqual(findByClass(rankTree, 'gt-rank').map(text), ['3', '2', '1'],
    '徽标数字 = 载荷 rank：把行号当名次就是把"我排的序"说成"GitHub 给的序"');
  assert.deepEqual(badges(rankTree), ['gt-rank gt-rank-3', 'gt-rank gt-rank-2', 'gt-rank gt-rank-1'],
    '颜色跟着 rank 走，不跟着行号走（第一行是 GitHub 的第 3 名 ⇒ 铜色）');

  // CSS 侧：几何契约那四条规则原文（「规则文本在、效果死」那一族）
  const css = (clientSrc().match(/const CSS = `([\s\S]*?)`;/) || [])[1] || '';
  assert.match(css, /\.gt-root>\.gt-card\{flex:1;min-height:0;display:flex;flex-direction:column\}/);
  assert.match(css, /\.gt-root>\.gt-card>\.gt-card-b\{flex:1;min-height:0\}/);
  assert.match(css, /\.gt-bar\{[^}]*flex:none/, '卡体那一行必须 flex:none，否则会被滚动区挤掉');
  assert.match(css, /\.gt-scroll\{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden/);

  // 全站高星那一档：列集跟着收（六列）、排序分段器不摆、统计那句换成宿主拼好的整句
  const allSnap = snapFixture({}, { prefs: { allStarsEnabled: true }, search: searchBatchOf([searchRowOf(1, 'freecodecamp/freecodecamp')]) });
  const { tree: all } = starsWith('allStars', allSnap);
  const allCols = kidsOf(kidsOf(findAllType(all, 'table')[0], 'colgroup')[0], 'col');
  const allThs = cellsOf(findAllType(all, 'table')[0], 'thead');
  assert.equal(allCols.length, 6, '那一档没有「轮」与「今日新增」的概念，摆出来就是把「被我抓过」说成「在榜过」');
  assert.equal(allThs.length, 6);
  assert.equal(cellsOf(findAllType(all, 'table')[0], 'tbody').length, 6);
  assert.deepEqual(allThs.map(text), ['#', '仓库', '描述', '语言', allSnap.stars.starsLabel, '']);
  assert.deepEqual(allCols.slice(3, 5).map((c) => c.props.style.width), [112, 64]);
  assert.equal(findByClass(all, 'gt-bar').flatMap((s) => findByClass(s, 'gt-seg')).length, 0,
    '那一档的排序分段器不摆：宿主已按 stars 降序给行，界面再排一遍就是第二真相');
  assert.equal(text(findByClass(all, 'gt-card-n')[0]), allSnap.stars.allStars.statLine, '统计那句整段吃 allStars.statLine');
  assert.ok(allSnap.stars.allStars.statLine.includes('search 额度剩 8 / 10'), '前提：额度那三个数由宿主从响应头拼（客户端不许自己数）');
});

check('client-60 档位名单 / 排序名单 / 那两句整句逐字吃载荷：换载荷值屏上跟着换，未开启那一枚灰着但说得清为什么', () => {
  const { StarsCard } = loadClient().exports.__test.components;
  const snap = snapFixture();
  const tree = render(StarsCard, { snap, onRepo() {}, onSave() {} });
  // ① 两份名单逐字对齐载荷
  assert.deepEqual(kidsOf(findByClass(tree, 'gt-seg')[0], 'button').map(text), snap.stars.views.map((o) => o.label),
    '视图分段器的签不是 stars.views 那一份');
  assert.deepEqual(kidsOf(findByClass(tree, 'gt-seg')[1], 'button').map(text), snap.stars.sorts.map((o) => o.label),
    '排序分段器的签不是 stars.sorts 那一份');
  // ② 未开启：那一枚照摆但 disabled，签上换成「全站高星 · 未开启」，note 整句上屏
  const offBtn = kidsOf(findByClass(tree, 'gt-seg')[0], 'button').at(-1);
  assert.equal(offBtn.props.disabled, true, '出厂关着 ⇒ 那一枚灰着，但绝不藏（同 §7.6 那条 ready:false 开关照摆的律）');
  assert.equal(text(offBtn), STARS_VIEW_DISABLED_LABELS.allStars, '灰着还要说清为什么；那半句只归 domain');
  assert.ok(text(tree).includes(snap.stars.allStars.note), '未开启时那句"这一路是什么、开了会怎样"必须在屏上');
  assert.equal(snap.stars.allStars.statLine, STARS_QUOTA_OFF_NOTE, '前提：关着时宿主给的那句就是「未开启」那句');
  // ③ 统计那句逐字读载荷（客户端不数条、不拼句）
  assert.equal(text(findByClass(tree, 'gt-card-n')[0]), snap.stars.headline);
  assert.match(snap.stars.headline, /个仓库$/, '前提：那句里的条数由宿主数（界面自己数就是第二真相）');
  // ④ 换载荷值 ⇒ 屏上跟着换（这才是"名单与句子只有一份"的硬判据）
  const swapped = JSON.parse(JSON.stringify(snap.stars));
  swapped.views = [{ id: 'all', label: '甲档', disabled: false }, { id: 'allStars', label: '乙档', disabled: false }];
  swapped.sorts = [{ id: 'stars', label: '丙序' }];
  swapped.headline = '丁句 9 个仓库';
  swapped.starsAddedLabel = '戊列';
  swapped.roundsPeakLabel = '己列';
  swapped.starsLabel = '庚列';
  const t2 = render(StarsCard, { snap: { ...snap, stars: swapped }, onRepo() {}, onSave() {} });
  // ★ 只扫"名单与句子"那三处（分段器签 / 表头 / 统计那句），不扫整屏文本：
  //   STARS_ALL_STARS_NOTE 里本来就有「这一档没有『在榜轮数 / 今日新增 / 峰值名次』这些概念」那句 —— 载荷原话上屏是应该的，
  //   拿整屏文本扫会把"宿主那句照搬"误判成"客户端抄了名单"。
  const owned = [
    ...findByClass(t2, 'gt-seg').flatMap((s) => kidsOf(s, 'button').map(text)),
    ...cellsOf(findAllType(t2, 'table')[0], 'thead').map(text),
    ...findByClass(t2, 'gt-card-n').map(text),
  ].join('|');
  for (const s of ['甲档', '乙档', '丙序', '丁句 9 个仓库', '戊列', '己列']) {
    assert.ok(owned.includes(s), `换了载荷屏上没换：缺「${s}」`);
  }
  // 反向：domain 那一份名单与列名（含 client-32 豁免掉的 '累计 ★'）在这一屏一处都不许残留
  for (const s of [STARS_COL_STARS, STARS_COL_STARS_ADDED, STARS_COL_ROUNDS_PEAK,
    ...Object.values(STARS_VIEW_LABELS), ...Object.values(STARS_SORT_LABELS)]) {
    assert.ok(!owned.includes(s), `名单里残留宿主那一份的「${s}」⇒ 客户端自己抄了一份档位名或列名`);
  }
  // ⑤ 开着那一档时签上换回干净名字、且按得动（disabled 位跟着载荷走，不是客户端判的）
  const onTree = render(StarsCard, { snap: snapFixture({}, { prefs: { allStarsEnabled: true } }), onRepo() {}, onSave() {} });
  const onBtn = kidsOf(findByClass(onTree, 'gt-seg')[0], 'button').at(-1);
  assert.equal(text(onBtn), STARS_VIEW_LABELS.allStars);
  assert.equal(onBtn.props.disabled, false);
  assert.ok(!text(onTree).includes(STARS_QUOTA_OFF_NOTE), '已经开启了还念那句"未开启"就是两句假话');
  assert.ok(!hasCls(findByClass(onTree, 'gt-notice').filter((n) => text(n) === STARS_QUOTA_OFF_NOTE)[0] || { props: {} }, 'gt-notice'),
    '开着时那句「未开启」的 note 整段撤掉（同一屏上不该同时有开启与未开启两句话）');
});

check('client-61 缺位与置灰：0 与「没有这一格」分得开，那一列整列置灰不藏列（addedCell / starsPick 各形状）', () => {
  const lc = loadClient();
  const { addedCell, starsPick, fmtCount } = lc.exports.__test;
  const { StarsCard } = lc.exports.__test.components;
  // ① addedCell 的形状：★ null 与 0 是两件事（返回值出自 vm 沙箱，先 `plain()` 剥回本 realm 再比）
  assert.deepEqual(plain(addedCell(null, '—')), { text: '—', cls: 'gt-flat' });
  assert.deepEqual(plain(addedCell(undefined, '—')), { text: '—', cls: 'gt-flat' });
  assert.deepEqual(plain(addedCell('abc', '—')), { text: '—', cls: 'gt-flat' }, '坏值念缺位，不许 NaN 上屏');
  assert.deepEqual(plain(addedCell(0, '—')), { text: '+0', cls: 'gt-flat' }, '「今天没涨」是真话，与缺位两种说法');
  assert.deepEqual(plain(addedCell(512, '—')), { text: `+${fmtCount(512)}`, cls: 'gt-up' });
  assert.deepEqual(plain(addedCell(-30, '—')), { text: `−${fmtCount(30)}`, cls: 'gt-down' }, '跌用 − 不用 ASCII 减号（跟榜面 deltaCell 同一套）');
  assert.equal(addedCell(1500, '—').text, `+${fmtCount(1500)}`, '千以上走 fmtCount 那一套量级词，别自己拼 1500');
  // ② starsPick：缺位垫底 + 档位过滤 + 那一档按星数降序（全是本地重排，不发请求）
  const rows = [
    { repo: 'a/x', group: 'regular', stars: 10, added: 5, rounds: 2 },
    { repo: 'a/y', group: 'cooling', stars: null, added: null, rounds: 9 },
    { repo: 'a/z', group: 'rising', stars: 999, added: 0, rounds: 0 },
  ];
  assert.deepEqual(plain(starsPick(rows, 'all', 'stars', []).map((r) => r.repo)), ['a/z', 'a/x', 'a/y'],
    '拿不到的读数按 -1 参与比较 ⇒ 垫底（把 null 当 0 排序会把"没抓到"演成"星数少"）');
  assert.deepEqual(plain(starsPick(rows, 'cooling', 'stars', []).map((r) => r.repo)), ['a/y'], '档位归属吃载荷的 group，界面不判档');
  assert.deepEqual(plain(starsPick(rows, 'all', 'added', []).map((r) => r.repo)), ['a/x', 'a/z', 'a/y'],
    '按今日新增排：added 缺位的行垫底，0 不算缺位');
  assert.deepEqual(plain(starsPick(rows, 'all', 'rounds', []).map((r) => r.repo)), ['a/y', 'a/x', 'a/z']);
  assert.equal(starsPick(null, 'all', 'stars', null).length, 0, '载荷缺位给空表，不炸');
  const sr = [{ rank: 1, repo: 'b/low', stars: 100 }, { rank: 2, repo: 'b/high', stars: 900 }];
  assert.deepEqual(plain(starsPick([], 'allStars', 'added', sr).map((r) => r.repo)), ['b/high', 'b/low'],
    '那一档恒按 stars 降序（排序分段器不摆在这一屏，换 sort 也不该改这一屏的顺序）');
  // ③ 薄快照：那一列整列置灰、每格给缺位，并把那句理由原样搬上屏（不藏列）
  const thinSnap = snapFixture({}, { seenRows: new Map() });
  assert.equal(thinSnap.stars.thin, true, '前提：没有榜史时宿主判的是薄快照');
  const thinTree = render(StarsCard, { snap: thinSnap, onRepo() {}, onSave() {} });
  const thinThs = cellsOf(findAllType(thinTree, 'table')[0], 'thead');
  assert.ok(hasCls(thinThs[5], 'off'), '轮数不够时那一列的表头必须带 off（藏列的话那天攒够了会凭空长出来）');
  const thinLast = kidsOf(kidsOf(findAllType(thinTree, 'table')[0], 'tbody')[0], 'tr')
    .map((tr) => kidsOf(tr, 'td').at(5));
  assert.ok(thinLast.length > 0 && thinLast.every((td) => hasCls(td, 'off') && text(td) === thinSnap.stars.missingCell),
    '整列每格一起置灰并给缺位格，不许留空或写 0');
  assert.ok(text(thinTree).includes(thinSnap.stars.thinNote), '那句理由（要满几轮、攒到几轮）必须说在屏上');
  // ④ 缺位的星数：★ 血案点 —— fmtCount(null) 给 '0'，所以这一格必须先判 Number.isFinite
  assert.equal(fmtCount(null), '0', '前提：fmtCount 本身把 null 说成 0 ⇒ 星数格必须自己挡住缺位');
  const snap = snapFixture();
  const cells = kidsOf(kidsOf(findAllType(render(StarsCard, { snap, onRepo() {}, onSave() {} }), 'table')[0], 'tbody')[0], 'tr')
    .map((tr) => kidsOf(tr, 'td')).find((tds) => text(tds[1]).includes('g/gone'));
  assert.ok(cells, '前提：夹具的回落行（本地没有星数、描述与语言）在屏上有一行');
  assert.equal(text(cells[4]), snap.stars.missingCell.repeat(2), '回落行的累计星数与今日新增都念缺位');
  assert.ok(!/0/.test(text(cells[4]) + text(cells[2]) + text(cells[3])), '念成 0 就是把"没抓到"演成"星数少 / 没描述"');
  assert.equal(text(cells[3]), snap.stars.missingCell, '回落行连语言都没有 ⇒ 缺位格');
  assert.equal(text(cells[5]), '6 轮#2', '回落行仍念榜史：轮数与峰值来自观测史，这一格是真有的读数');
  // ⑤ 缺位格吃载荷值，不写死 '—'（客户端自己抄一个符号 = 宿主换字面就两处漂）
  const alt = JSON.parse(JSON.stringify(snap.stars));
  alt.missingCell = '◇';
  const altCells = kidsOf(kidsOf(findAllType(render(StarsCard, { snap: { ...snap, stars: alt }, onRepo() {}, onSave() {} }), 'table')[0], 'tbody')[0], 'tr')
    .map((tr) => kidsOf(tr, 'td')).find((tds) => text(tds[1]).includes('g/gone'));
  assert.equal(text(altCells[3]), '◇', '换了载荷的缺位格屏上没换 ⇒ 界面写死了缺位符号');
  // ⑥ bestRank 缺位时那半句整段不出现（不硬造 '#0'）
  const noPeak = JSON.parse(JSON.stringify(snap.stars));
  noPeak.rows = noPeak.rows.map((r) => ({ ...r, bestRank: 0 }));
  const np = kidsOf(kidsOf(findAllType(render(StarsCard, { snap: { ...snap, stars: noPeak }, onRepo() {}, onSave() {} }), 'table')[0], 'tbody')[0], 'tr')
    .map((tr) => kidsOf(tr, 'td').at(5));
  assert.ok(np.every((td) => /轮$/.test(text(td)) && !text(td).includes('#')), '峰值名次拿不到时不摆 #0');
  // ⑦ CSS 侧：置灰与那两个"并进"小字的规则原文（类名挂着而屏上是灰的 = 规则没写）
  const css = (clientSrc().match(/const CSS = `([\s\S]*?)`;/) || [])[1] || '';
  assert.match(css, /\.gt-tbl td\.off,\.gt-tbl th\.off\{color:var\(--gt-faint\);background:repeating-linear-gradient/,
    '整列置灰必须有斜纹底 + 弱字色：只写 color 会被读成"这格是 0"');
  assert.match(css, /\.gt-delta\{margin-left:6px;font-size:11px\}/, '今日新增并进总星那一格的小字规则缺失 ⇒ 两个数糊成一句');
  assert.match(css, /\.gt-faint2\{color:var\(--gt-faint\);margin-left:5px\}/, '峰值名次并进在榜那一格的小字');
  // ⑧ 置灰的判据只有载荷那一份：界面拿 `roundsAvailable` 复算就是第二真相 ⇒ 两份故意矛盾的载荷各钉一个方向
  const grayOn = JSON.parse(JSON.stringify(snap.stars));
  grayOn.thin = true; grayOn.roundsAvailable = 99; grayOn.thinNote = '哨兵：这一列的证据不够';
  const grayOnTree = render(StarsCard, { snap: { ...snap, stars: grayOn }, onRepo() {}, onSave() {} });
  const onTds = kidsOf(kidsOf(findAllType(grayOnTree, 'table')[0], 'tbody')[0], 'tr').map((tr) => kidsOf(tr, 'td').at(5));
  assert.ok(hasCls(cellsOf(findAllType(grayOnTree, 'table')[0], 'thead')[5], 'off')
    && onTds.length > 0 && onTds.every((td) => hasCls(td, 'off') && text(td) === grayOn.missingCell),
    '载荷说 thin=true 就得整列置灰 —— 那个数够不够门由宿主判，界面复算就是把判定搬回屏上');
  assert.ok(text(grayOnTree).includes(grayOn.thinNote), '薄快照那句理由吃载荷原文，不自己拼');
  const grayOff = JSON.parse(JSON.stringify(snap.stars));
  grayOff.thin = false; grayOff.roundsAvailable = 1;
  const grayOffTree = render(StarsCard, { snap: { ...snap, stars: grayOff }, onRepo() {}, onSave() {} });
  const offTds = kidsOf(kidsOf(findAllType(grayOffTree, 'table')[0], 'tbody')[0], 'tr').map((tr) => kidsOf(tr, 'td').at(5));
  assert.ok(!hasCls(cellsOf(findAllType(grayOffTree, 'table')[0], 'thead')[5], 'off')
    && offTds.every((td) => !hasCls(td, 'off') && /轮/.test(text(td))),
    '载荷说 thin=false 就不许置灰：界面自己判会把"最深那位只上了 1 轮"演成不够格，而这一格读数本来是真的');
  // ⑦ 续（CSS 原文的最后一条，仍属上面那段置灰判据）
  assert.match(css, /\.gt-seg button:disabled:not\(\.on\)\{/, '缺 :not(.on) 会把"当前那枚"（同时 disabled）顶成条纹灰 ⇒ 分段器看不出选中档');
});

check('client-62 中文列沿用榜面那套混合视图；故障 / 没取回 / 空表 / 没存储四种"没内容"各说各的', () => {
  const { StarsCard } = loadClient().exports.__test.components;
  const snap = snapFixture();
  const tree = render(StarsCard, { snap, onRepo() {}, onSave() {} });
  // ① 命中行显示译文、悬停看得见原文与落款（同一张命中表，榜面译过就不该再花一发）
  const d0 = starsCells(tree, 0)[2];
  assert.equal(text(d0), DESC_ZH_ROWS[0][2]);
  assert.ok(d0.children[0].props.title.includes(`原文：${DESC_ZH_ROWS[0][1]}`));
  assert.ok(d0.children[0].props.title.includes(DESC_ZH_NOTE), '落款那句来源 + 时间戳读的是载荷，客户端不自己编日期');
  // ② 没命中的行显示原文；★ 这一屏的行不带 langColor ⇒ 色点走 CSS 那一份灰，不内联造色（§8.8 落地改口 12）
  assert.equal(text(starsCells(tree, 1)[2]), '一个描述');
  assert.equal(findAllType(starsCells(tree, 1)[2], 'i').length, 0, '描述格里不该有色点（色点只归语言那一格）');
  assert.equal(findAllType(tree, 'i').length, findAllType(tree, 'i').filter((n) => n.props.style === undefined).length,
    '语言色点不许内联带色：这一屏的星行没有 langColor，硬凑就是把猜的当读数');
  // ③ 那一档列收了，中文列仍走同一套（这一批还没补译 ⇒ 显示原文）
  const allSnap = snapFixture({}, { prefs: { allStarsEnabled: true }, search: searchBatchOf([searchRowOf(1, 'freecodecamp/freecodecamp')]) });
  assert.equal(text(starsCells(starsWith('allStars', allSnap).tree, 0)[2]), 'A plain english line');
  // ③′ ★ 10-10 改判：那一档开着 ⇒ 宿主已把它的行并进现译集合，库里逐字命中的那句在屏上就是中文（客户端仍只取值）
  const hitRow = searchRowOf(1, 'freecodecamp/freecodecamp');
  const siteRows = [{ repo: hitRow.repo, kind: 'desc', src: transSrcKey(hitRow.desc), zh: '那一档补出来的中文', at: atOff(-120000), chars: 20, engine: 'host_llm' }];
  const onTree = starsWith('allStars', snapFixture({}, { prefs: { allStarsEnabled: true }, search: searchBatchOf([hitRow]), transRows: siteRows })).tree;
  const onCell = starsCells(onTree, 0)[2];
  assert.equal(text(onCell), '那一档补出来的中文', '那一档的行命中 ⇒ 中文上屏：hits 的键表由宿主决定，客户端不判"这行属于哪一屏"');
  assert.ok(onCell.children[0].props.title.includes(`原文：${hitRow.desc}`), '悬停仍看得见 GitHub 那句原文');
  assert.ok(onCell.children[0].props.title.includes(DESC_ZH_LIVE_NOTE), '落款念的是 domain 那一句现译说明（两屏共用同一句，客户端不另写一套）');
  // ③″ 同一张 trans 表、同一批行，开关拨回关 ⇒ 那句中文立刻下屏（参与集合里压根没有它）
  const offTree = starsWith('allStars', snapFixture({}, { prefs: { allStarsEnabled: false }, search: searchBatchOf([hitRow]), transRows: siteRows })).tree;
  assert.equal(text(starsCells(offTree, 0)[2]), 'A plain english line',
    '★ 关掉那一档 ⇒ 宿主不再给它的 hits，屏上退回原文（客户端不许自己拿 transRows 补出中文，那是第二份真相）');
  // ④ 故障：本轮没取回 ⇒ 一句 err，上一批的行照旧在屏上（§1 那条「上一批照常显示并挂一句故障」）
  const bad = snapFixture({}, { prefs: { allStarsEnabled: true },
    search: searchBatchOf([searchRowOf(1, 'freecodecamp/freecodecamp')], { ok: false, error: '限额用尽（403，重置于 10-09 11:20）' }) });
  const badTree = starsWith('allStars', bad).tree;
  const err = findByClass(badTree, 'gt-notice-err')[0];
  assert.ok(err, '故障必须在屏上说，不是安静地少一行');
  assert.ok(text(err).includes('限额用尽（403，重置于 10-09 11:20）'), '那句原因念的是落库那一行的原样回执');
  assert.equal(kidsOf(kidsOf(findAllType(badTree, 'table')[0], 'tbody')[0], 'tr').length, 1,
    '上一批的行照旧在屏上（撤掉它才是把"这一轮坏了"演成"没人高星"）');
  // ⑤ 开了但本机从没取回过：那一句是「已开启、还没取回」，与空表那句分开
  const waiting = snapFixture({}, { prefs: { allStarsEnabled: true }, search: null });
  assert.equal(waiting.stars.allStars.statLine, STARS_QUOTA_WAITING_NOTE, '前提：没落库时宿主给的是那句等待');
  assert.ok(text(waiting.stars.allStars.statLine) && text(starsWith('allStars', waiting).tree).includes(STARS_QUOTA_WAITING_NOTE));
  // ⑥ 这一档真没行 ⇒ 空表那句是界面措辞，但 colSpan 必须跟着当前列数（列收了还写 7 就漏一格）
  const emptyThin = snapFixture({}, { seenRows: new Map() });
  const emptyTd = cellsOf(findAllType(starsWith('regular', emptyThin).tree, 'table')[0], 'tbody')[0];
  assert.equal(emptyTd.props.colSpan, 7, '薄夹具没有常客档的行 ⇒ 空表，colSpan 要等于当前列数');
  assert.match(text(emptyTd), /没有符合条件的仓库/);
  const emptyAll = starsWith('allStars', snapFixture({}, { prefs: { allStarsEnabled: true }, search: searchBatchOf([]) })).tree;
  assert.equal(cellsOf(findAllType(emptyAll, 'table')[0], 'tbody')[0].props.colSpan, 6, '那一档空表时 colSpan 跟六列走');
  // ⑦ 能力边界 ①：没存储时那句是 STARS_NO_STORE_NOTE，不是空表那句
  const noStore = snapFixture({}, { storageAvailable: false });
  assert.equal(noStore.stars.headline, STARS_NO_STORE_NOTE, '前提：宿主在装配层就给那一句');
  assert.ok(text(render(StarsCard, { snap: noStore, onRepo() {}, onSave() {} })).includes(STARS_NO_STORE_NOTE),
    '两件事不许演成一件：没有榜史 ≠ 榜上没人');
});

check('client-63 那一档的开关：出去的是严格布尔，开启绝不跳档、关掉才把人送回去', () => {
  const { StarsCard } = loadClient().exports.__test.components;
  const snap = snapFixture();
  // ① 未开启时点开关 ⇒ onSave 只带那一个键的严格布尔，且**一个状态都不动**（开启 ≠ 跳档，§0 本轮 ⑧）
  //   ★ 这一趟的 view 故意停在 'allStars'：若写成第一档，"开启时也跳档"那个变异就空跑了（条件本来不成立 ⇒ 屏幕不动也测不出）。
  const a = loadClient(PAYLOAD, { states: ['allStars'] });
  const saved = [];
  const treeA = render(a.exports.__test.components.StarsCard, { snap, onRepo() {}, onSave: (p) => saved.push(p) });
  findByClass(treeA, 'gt-btn')[0].props.onClick();
  assert.deepEqual(plain(saved), [{ allStarsEnabled: true }], '出去的就是那一个键的严格布尔（多带一格 = 替宿主做决定）');
  assert.deepEqual(a.stateSets, [], '开启时把视图跳到那一档 = 让人以为刚点的是个视图按钮');
  // ② 已开启且人停在那一档时点关闭 ⇒ 存 false，并把视图送回**载荷名单的第一档**（档位 id 用哨兵，硬编码 'all' 会红）
  const firstId = '哨兵首档';
  const onSnap = snapFixture({}, { prefs: { allStarsEnabled: true } });
  const swapped = JSON.parse(JSON.stringify(onSnap.stars));
  swapped.views = [{ id: firstId, label: '首档', disabled: false },
    { id: 'allStars', label: STARS_VIEW_LABELS.allStars, disabled: false }];
  const b = loadClient(PAYLOAD, { states: ['allStars'] });
  const savedB = [];
  const treeB = render(b.exports.__test.components.StarsCard, {
    snap: { ...onSnap, stars: swapped }, onRepo() {}, onSave: (p) => savedB.push(p),
  });
  b.stateSets.length = 0;
  findByClass(treeB, 'gt-btn')[0].props.onClick();
  assert.deepEqual(plain(savedB), [{ allStarsEnabled: false }]);
  assert.deepEqual(b.stateSets.map((s) => [s.idx, s.next]), [[0, firstId]],
    '关掉后把视图送回 stars.views 的第一档（那一枚这时 disabled，不送人就困在这一屏）');
  // ③ 保存中那枚开关按钮 disabled；没在保存时按得动
  assert.equal(findByClass(render(StarsCard, { snap, saving: true, onRepo() {}, onSave() {} }), 'gt-btn')[0].props.disabled, true);
  assert.equal(findByClass(render(StarsCard, { snap, onRepo() {}, onSave() {} }), 'gt-btn')[0].props.disabled, false);
  // ④ 视图分段器的点击只换本地状态：不写 prefs、不触发检查（§0「选择不许有副作用」）
  const d = loadClient(PAYLOAD, { states: ['all'] });
  const savedD = [];
  const treeD = render(d.exports.__test.components.StarsCard, { snap, onRepo() {}, onSave: (p) => savedD.push(p) });
  kidsOf(findByClass(treeD, 'gt-seg')[0], 'button').forEach((btn) => btn.props.onClick());
  assert.deepEqual(savedD.length, 0, '换档写了 prefs = 选择有副作用');
  assert.deepEqual(d.stateSets.map((s) => [s.idx, s.next]), snap.stars.views.map((o, i) => [0, o.id]),
    '每枚按钮发的是自己那一档的 id（且发的是视图那一路的状态，不是排序）');
  // ⑤ 仓库名走的是同一根 onRepo（榜面那条律在这里同样作数：出网只在点仓库名那一下）
  const clicked = [];
  const treeE = render(StarsCard, { snap, onRepo: (r) => clicked.push(r), onSave() {} });
  const link = findAllType(treeE, 'a')[0];
  link.props.onClick({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
  assert.deepEqual(clicked, ['addyosmani/agent-skills'], '第一行的仓库名点开的是那一行自己的主键（小写归一那份）');
  assert.equal(link.props.className, 'gt-repo');
});

await runAll('client');