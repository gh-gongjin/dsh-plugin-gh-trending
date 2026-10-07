/**
 * ============================================================
 * dsh-plugin-gh-trending —— Host Half（宿主半边）index.js
 * ============================================================
 *
 * 装配四件事（与 modelwatch 同形，业务面更小）：
 *   1. 五仓储（state / events / prefs / seen / repo）+ 检查服务 + 详情服务 + lib/api.js 门面接到 ctx；
 *   2. 按需探测宿主能力（storageDomain / timer / webServer），缺哪项就怎么降级；
 *   3. 经 `webserver/index-inject` 把配置与能力表推给浏览器半边；
 *   4. 注册 `/gh-trending` 前缀路由，生命周期结束时先停定时器、后关存储句柄。
 *
 * 铁律（spec §0）：
 *   · 零 @deepseek-ai/* import —— link: 挂载会解析出第二份模块实例；
 *   · 零第三方依赖 —— 出网只走 lib/services/net.js（直连=全局 fetch，代理=自带 CONNECT 隧道）；
 *   · 对 github.com / api.github.com 全程只读 GET：不 POST、不带 key、不下载 zip、不 clone；
 *   · 不推任何通知：不碰 ctx.schedule / ctx.jobs，变化只落面板。
 *
 * 为什么 inject = []：Cordis 的 Context 是代理，未 inject 的属性读了就抛；
 * 把 webServer / storageDomain / timer 写进 inject 会让「宿主缺任一服务」直接卡死插件加载。
 *
 * ⚠️ ctx.inject 回调跑在独立 fiber，不在 apply 同步段执行；能力位与路由注册只能在回调里做
 *    （sysops 病历：apply 顶层锁死能力快照 ⇒ 满屏降级横幅 + 路由全 404）。
 */
import { createApiHandler, ROUTE_PREFIX, GLOBAL_KEY } from './lib/api.js';
import { createCaps } from './lib/caps.js';
import { createStateStore, createEventStore, createPrefsStore, createSeenStore, createRepoCacheStore, createTransStore } from './lib/stores.js';
import { createCheckService } from './lib/check.js';
import {
  BOARDS, BOARD_LABELS, BOARD_ADDED_LABELS, TRENDING_SOURCE_NOTE, LANG_CHECK,
  CHECK_INTERVALS, CHECK_INTERVAL_LABELS, DEFAULT_PREFS,
  REPO_CACHE_HOURS, REPO_CACHE_HOUR_LABELS, repoCacheTtlMs,
  TOP_N_MIN, TOP_N_MAX, KEEP_EVENTS_MIN, KEEP_EVENTS_MAX, KEEP_EVENTS_STEP,
  EVENT_KIND_LABELS, CROSS_MIN_BOARDS,
  PROXY_MODES, PROXY_MODE_LABELS, PROXY_MODE_HINTS, PROXY_URL_MAX,
} from './lib/domain.js';
import { normalizeLanguage } from './lib/services/gh.js';
import { createNetTransport, parseProxyUrl } from './lib/services/net.js';
import { createRepoDetailService } from './lib/services/repo.js';
import { createLlmTranslator } from './lib/services/llm.js';
import { createWebTranslator } from './lib/services/web-translate.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'gh-trending';

/** 零硬 inject：三项服务全部按需注入，缺了也不阻塞加载。 */
export const inject = [];

/**
 * 默认配置。panelOrder:16 排在模型监控（14）下方。
 * autoCheckOnStart：启动 5s 后跑第一轮（给 storageDomain 注入回调留落地窗口）。
 */
export const DEFAULT_CONFIG = {
  panelId: 'gh-trending',
  panelOrder: 16,
  label: 'GitHub 热榜',
  intervalMin: DEFAULT_PREFS.intervalMin,
  topN: DEFAULT_PREFS.topN,
  keepEvents: DEFAULT_PREFS.keepEvents,
  language: DEFAULT_PREFS.language,
  proxyMode: DEFAULT_PREFS.proxyMode,
  proxyUrl: DEFAULT_PREFS.proxyUrl,
  autoCheckOnStart: true,
};

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 逐键钳制用户配置（profile 可覆盖）；只认已知键，脏值绝不带进运行时。 */
export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!CHECK_INTERVALS.includes(Number(cfg.intervalMin))) cfg.intervalMin = DEFAULT_CONFIG.intervalMin;
  cfg.topN = clampInt(cfg.topN, DEFAULT_CONFIG.topN, TOP_N_MIN, TOP_N_MAX);
  cfg.keepEvents = clampInt(cfg.keepEvents, DEFAULT_CONFIG.keepEvents, KEEP_EVENTS_MIN, KEEP_EVENTS_MAX);
  cfg.autoCheckOnStart = Boolean(cfg.autoCheckOnStart);
  if (typeof cfg.label !== 'string' || !cfg.label) cfg.label = DEFAULT_CONFIG.label;
  if (typeof cfg.panelId !== 'string' || !cfg.panelId) cfg.panelId = DEFAULT_CONFIG.panelId;
  cfg.panelOrder = Number.isFinite(Number(cfg.panelOrder)) ? Math.trunc(Number(cfg.panelOrder)) : DEFAULT_CONFIG.panelOrder;
  // 语言：形状不合法的配置值直接回落全站（脏值不拼进 URL）
  const lang = normalizeLanguage(cfg.language);
  cfg.language = lang.ok ? lang.slug : DEFAULT_CONFIG.language;
  // 代理：模式吃封闭集合，地址必须能解析；custom 却给不出地址时退回 system ——
  // 装配层宁可多读一次注册表，也不要带着「自定义模式 + 空地址」进入运行期（那样每轮三发都是同一句配置报错）。
  if (!PROXY_MODES.includes(cfg.proxyMode)) cfg.proxyMode = DEFAULT_CONFIG.proxyMode;
  const rawProxy = typeof cfg.proxyUrl === 'string' ? cfg.proxyUrl.trim() : '';
  // 超长不截断：截断会把「粘错成一整段 PAC 脚本」的地址变成一个看着能用的假地址，那比丢回默认更糟
  cfg.proxyUrl = rawProxy.length > 0 && rawProxy.length <= PROXY_URL_MAX && parseProxyUrl(rawProxy).ok ? rawProxy : '';
  if (cfg.proxyMode === 'custom' && !cfg.proxyUrl) cfg.proxyMode = DEFAULT_CONFIG.proxyMode;
  return cfg;
}

/** 模块级最近一次装配的运行时快照，仅测试可观测性用（见 __peek）。 */
let lastRuntime = null;

/** 测试钩子：读装配后的运行时诊断（timerBackend / cadenceMs）。生产路径不依赖它。 */
export function __peek(key) {
  const rt = lastRuntime;
  if (!rt || !key) return undefined;
  try {
    if (key === 'timerBackend') return rt.check.timerBackend;
    if (key === 'cadenceMs') return rt.check.cadenceMs;
    if (key === 'backoffExponent') return rt.check.backoffExponent;
  } catch { return undefined; }
  return undefined;
}

/**
 * 插件入口。
 * @param ctx 宿主 Context（代理对象，未 inject 的属性读了会抛）。
 * @param config profile 为本插件写的 config —— 只能从第二个参数拿，读 ctx.config 会抛。
 * @returns 生命周期清理器（同步执行）。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);

  /* ---- 1. 宿主服务句柄：由 ctx.inject 回调延后填入 ---- */
  let storageFacility;
  let intervalFn = null;
  let webServer;

  /* ---- 2. 能力：现取现算 ---- */
  const getFacility = () => storageFacility;
  const caps = createCaps({ logger: ctx.logger });
  let storageOpenFailure = '';
  function syncCaps() {
    caps.mark(
      'storageDomain',
      Boolean(storageFacility) && !storageOpenFailure,
      !storageFacility ? '宿主未提供 ctx.storageDomain，榜面只能当场看、变化史留不下来' : storageOpenFailure,
    );
    caps.mark('timer', Boolean(intervalFn), intervalFn ? '' : '宿主未提供 ctx.timer.interval，已退到 setInterval（进程退出前会显式清）');
    caps.mark('webServer', Boolean(webServer), webServer ? '' : '宿主未提供 webServer，一个入口都不注册');
  }

  /* ---- 3. 仓储与偏好同步视图 ---- */
  const stateStore = createStateStore({ getFacility, logger: ctx.logger });
  const eventStore = createEventStore({ getFacility, logger: ctx.logger, now: () => Date.now() });
  const seenStore = createSeenStore({ getFacility, logger: ctx.logger });
  const prefsStore = createPrefsStore({ getFacility, logger: ctx.logger });
  const repoStore = createRepoCacheStore({ getFacility, logger: ctx.logger });
  const transStore = createTransStore({ getFacility, logger: ctx.logger });

  let prefsView = {
    intervalMin: resolved.intervalMin,
    // ★ 这一格必须在**初始值**里就有：`repoService` 的 TTL 按 `prefsView.repoCacheHours` 现取现算，
    //   而首次 `reloadPrefs()` 是异步的 —— 装配与第一次点击之间读到的该是出厂档，不是 undefined。
    repoCacheHours: DEFAULT_PREFS.repoCacheHours,
    topN: resolved.topN,
    keepEvents: resolved.keepEvents,
    language: resolved.language,
    proxyMode: resolved.proxyMode,
    proxyUrl: resolved.proxyUrl,
  };
  async function reloadPrefs() {
    try {
      // strict：装配层要知道「读不到」是因为域坏了还是因为没写过 —— 宽容读会把前者伪装成后者，
      // 能力位就会谎报「本地存储在位」，而实际上每次写都在失败。
      prefsView = await prefsStore.read({ strict: true });
      storageOpenFailure = '';
    } catch (e) {
      if (storageFacility) {
        storageOpenFailure = '存储域 open 失败，偏好转默认值，改动落不了库';
        ctx.logger?.warn?.(`[gh-trending] 存储域不可用（${e?.message ?? e}），偏好转默认值`);
      }
    }
    syncCaps();
  }
  const getPrefs = () => prefsView;

  /* ---- 3.5 传输层：直连=宿主全局 fetch，代理=插件自带 CONNECT 隧道 ---- */
  const net = createNetTransport({ getPrefs, logger: ctx.logger });

  /* ---- 3.6 详情服务：点击榜单条目才按需取，同一份传输层出网，结果进第五张表 ---- */
  const repoService = createRepoDetailService({
    repoStore,
    fetchFn: net.fetch,
    logger: ctx.logger,
    now: () => Date.now(),
    // ★ 第十二轮（用户裁定「进设置页，默认 24 小时」）：TTL 按**当时**的偏好现算，不在这里抄成一个数 ——
    //   `prefsView` 在 reloadPrefs 后就是新值，装配时锁死会让改档到宿主重启才生效（界面却已经显示新档了）。
    getTtlMs: () => repoCacheTtlMs(getPrefs().repoCacheHours),
    // ★ 第二十一轮（用户裁定「填 GitHub 令牌把配额抬到 5000/h」）：令牌同样**现取现算**，理由与上面那格一模一样 ——
    //   装配时抄进一个字符串的话，"保存了要重启才生效"和"清掉了还在带着发"两种假话都会出现。
    //   ★ 这里只是**读**偏好，不参与拼 URL：令牌的唯一去处是 `repo.js` 那条 `Authorization` 请求头。
    getGhToken: () => getPrefs().ghToken,
  });

  /* ---- 3.7 模型现译：宿主句柄的唯一使用者是 lib/services/llm.js（spec §0 第八轮改判「默认零调用」） ----
   * 这里把整个 ctx 交给它，只因为它要自己 `ctx.inject(['llm'])` —— 名单写在哪个文件，句柄就算哪个文件拿的，
   * `hc-8` 那条判据按这个口径扫（装配层留 `'llm'` 字面量就等于把闸门挪到了白名单外）。
   * 描述那一档出厂就开着（10-06 用户裁定），但它只在「点开详情 + 内置表没命中」时才发；
   * 摘要那一档出厂关着 ⇒ 不动设置就一次都不会发（`test/llm.test.mjs` 用 spy 句柄钉这两条）。 */
  const translator = createLlmTranslator({
    ctx,
    getPrefs,
    transStore,
    logger: ctx.logger,
    now: () => Date.now(),
  });

  /* ---- 3.8 现译引擎另两档（第九轮，用户裁定「两条都做，设置页选」）----
   * 免费接口 / 官方接口都从**同一条传输层**出网（`net.fetch`）：代理仲裁、隧道、报错口径与 github 那两发一致，
   * 不在这里另立一套。`hc-7` 的扫描面按目录真读派生出这个文件，它一样只许 GET。
   * 出厂档是 `keyless`（不花宿主模型额度、不要求注册），但两档都只在"点开详情 + 内置表没命中 + 开关开着"时才发。 */
  const webTranslator = createWebTranslator({
    net,
    getPrefs,
    transStore,
    logger: ctx.logger,
    now: () => Date.now(),
  });

  /* ---- 4. 检查服务 + 事件扇出 ---- */
  const fanout = new Set();
  const check = createCheckService({
    getPrefs,
    stateStore,
    eventStore,
    seenStore,
    logger: ctx.logger,
    now: () => Date.now(),
    getIntervalFn: () => intervalFn,
    fetchFn: net.fetch,
    onEvent: (ev) => { for (const f of [...fanout]) { try { f(ev); } catch { /* 单个订阅者坏不掉别人 */ } } },
  });

  async function onPrefsChanged() {
    await reloadPrefs();
    net.invalidate();          // 代理模式/地址改了：注册表缓存立刻作废，下一发按新地址仲裁
    check.setCadence(prefsView.intervalMin);
    // ★ 偏好一改就得推一帧：快照里跟着偏好算的键（`translator` 两档、`cadence`、`net`）是宿主算的，
    //   客户端只并 `prefs` 那一格 —— 不推的话，真机走查抓到的是「点了『开』，高亮还停在『关』」，
    //   要等下一轮检查（出厂 60 分钟）才跟上。帧的形状就是 GET snapshot 那一份，客户端无需补字段。
    for (const f of [...fanout]) {
      try { f({ type: 'update' }); } catch { /* 单个订阅者坏不掉别人 */ }
    }
  }

  /* ---- 5. api 门面 ---- */
  const apiHandler = createApiHandler({
    check,
    stateStore,
    eventStore,
    prefsStore,
    repoService,
    translator,
    webTranslator,
    caps,
    logger: ctx.logger,
    now: () => Date.now(),
    getTransportRoute: net.describe,
    onPrefsChanged,
    subscribeEvent: (fn) => { fanout.add(fn); return () => fanout.delete(fn); },
  });

  /* ---- 6. 生命周期收口：先停定时器与推流，后关存储句柄 ---- */
  function teardown() {
    try { check.dispose(); } catch (e) { ctx.logger?.warn?.(`[gh-trending] 停检查服务失败：${e?.message ?? e}`); }
    try { apiHandler.dispose?.(); } catch (e) { ctx.logger?.warn?.(`[gh-trending] 释放接口订阅失败：${e?.message ?? e}`); }
    // 现译：先掐句柄（在途那发由各自的超时收，dispose 只保证之后不再发），再清在途表
    try { translator.dispose(); } catch (e) { ctx.logger?.warn?.(`[gh-trending] 释放现译服务失败：${e?.message ?? e}`); }
    // 第九轮那两档（免费 / 官方）同理：清在途表 ⇒ 之后不再往翻译域名发一发
    try { webTranslator.dispose(); } catch (e) { ctx.logger?.warn?.(`[gh-trending] 释放翻译接口服务失败：${e?.message ?? e}`); }
    for (const s of [stateStore, eventStore, seenStore, prefsStore, repoStore, transStore]) {
      Promise.resolve(s.close?.()).catch((e) => ctx.logger?.warn?.(`[gh-trending] 关闭存储句柄失败：${e?.message ?? e}`));
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => teardown, 'gh-trending:lifecycle');
  lastRuntime = { check, teardown };

  /* ---- 7. 启动节拍与首轮检查 ---- */
  check.setCadence(prefsView.intervalMin);
  if (resolved.autoCheckOnStart) {
    const t = setTimeout(() => {
      check.run({ trigger: 'startup' }).catch((e) => ctx.logger?.warn?.(`[gh-trending] 启动首轮检查失败：${e?.message ?? e}`));
    }, 5000);
    if (typeof t.unref === 'function') t.unref();
  }

  ctx.inject(['storageDomain'], (s) => {
    storageFacility = s.storageDomain;
    syncCaps();
    void reloadPrefs().then(() => check.setCadence(prefsView.intervalMin));
  });

  ctx.inject(['timer'], (t) => {
    if (t.timer && typeof t.timer.interval === 'function') intervalFn = (fn, ms) => t.timer.interval(fn, ms);
    syncCaps();
    try {
      check.setCadence(prefsView.intervalMin);   // 宿主定时器就绪后重挂节拍（能力位不再自相矛盾）
    } catch (e) {
      ctx.logger?.warn?.(`[gh-trending] 宿主定时器就绪后重挂节拍失败：${e?.message ?? e}`);
    }
  });

  ctx.inject(['webServer'], (w) => {
    webServer = w.webServer;
    syncCaps();
    const register = () => {
      const disposer = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res, body) => apiHandler(req, res, body) });
      return typeof disposer === 'function' ? disposer : () => {};
    };
    if (typeof w.effect === 'function') w.effect(register, 'gh-trending:route');
    else register();
  });

  /* ---- 8. 入口载荷：只有 webServer 到位才推（点开空白页比看不到入口更糟）---- */
  ctx.on('webserver/index-inject', (table) => {
    if (!webServer) return;
    syncCaps();
    table.push({
      kind: 'global',
      name: GLOBAL_KEY,
      value: {
        panelId: resolved.panelId,
        label: resolved.label,
        panelOrder: resolved.panelOrder,
        routePrefix: ROUTE_PREFIX,
        api: `${ROUTE_PREFIX}/api`,
        capabilities: caps.read(),
        capabilityRows: caps.rows(),
        boards: BOARDS,
        boardLabels: BOARD_LABELS,
        boardAddedLabels: BOARD_ADDED_LABELS,
        sourceNote: TRENDING_SOURCE_NOTE,
        langCheck: LANG_CHECK,
        crossMin: CROSS_MIN_BOARDS,
        intervals: CHECK_INTERVALS,
        intervalLabels: CHECK_INTERVAL_LABELS,
        // ★ 第十二轮：详情缓存时长进设置页（与检查频率同形状：封闭档位 + 一张中文标签表）。
        cacheHours: REPO_CACHE_HOURS,
        cacheHourLabels: REPO_CACHE_HOUR_LABELS,
        proxyModes: PROXY_MODES,
        proxyModeLabels: PROXY_MODE_LABELS,
        proxyModeHints: PROXY_MODE_HINTS,
        proxyUrlMax: PROXY_URL_MAX,
        topNRange: { min: TOP_N_MIN, max: TOP_N_MAX },
        keepEventsRange: { min: KEEP_EVENTS_MIN, max: KEEP_EVENTS_MAX, step: KEEP_EVENTS_STEP },
        eventKindLabels: EVENT_KIND_LABELS,
        defaults: { ...DEFAULT_PREFS },
        builtAt: Date.now(),
      },
    });
  });

  return teardown;
}
