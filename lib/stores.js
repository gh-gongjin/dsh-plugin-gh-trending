/**
 * lib/stores.js —— 七张表的仓储（state / events / prefs / seen / repo / trans / search），共用 kv-records-base 的域登记表。
 *
 * 与 sysops / modelwatch 同口径：
 *  · 域名字排他，同一设施同一域只 open 一次；
 *  · 写全部走串行队列（KV 没有事务，串行是唯一能保证「谁最后写」确定的办法）；
 *  · 脏行在 put 之前被 schema 挡下并包成带 code 的 INVALID；
 *  · 读用 `[...t.entries()]` —— entries() 是 lazy iterator，Node 22+ 上 `.map()` 不报错但返回另一个迭代器。
 *
 * ★ state 表按榜分三行（key = board），这是相对 modelwatch 的有意偏离：
 *   把三源摊成 ok/error/top/prevTop… 一串键，每加一榜就多四个键，旧档还得留一堆可选字段。
 */
import {
  GHT_DOMAIN, BOARDS, DEFAULT_PREFS, CHECK_INTERVALS,
  TOP_N_MIN, TOP_N_MAX, KEEP_EVENTS_MIN, KEEP_EVENTS_MAX, PROXY_MODES, REPO_CACHE_MAX, REPO_CACHE_HOURS, TRANS_MAX,
  TRANSLATE_ENGINES, DEFAULT_TRANSLATE_ENGINE, LEGACY_TRANSLATE_ENGINES, PREF_CRED_FIELDS,
} from './domain.js';
import { normalizeLanguage } from './services/gh.js';
import { parseProxyUrl, maskProxyUrl } from './services/net.js';
import { acquireDomain, releaseDomain, createRecordRepo, RecordsError, RECORDS_ERROR } from './kv-records-base.js';

const PREFS_KEY = 'prefs';

function repoFor({ getFacility, logger }, table) {
  return createRecordRepo({ getFacility, logger, domain: GHT_DOMAIN, table });
}

/**
 * 榜 id 校验：库里只许出现三行，越界值直接挡（不静默写成第四行）。
 * ★ 挡下来必须是 **rejected promise**，不能是同步 throw：宿主半边这些方法都在定时器回调里被 await，
 *   同步异常从 timer 回调里漏出去会把宿主整块打挂（sysops 定时器血案同条教训）。
 */
function badBoard(board) {
  return new RecordsError(RECORDS_ERROR.INVALID, `未知榜：${board}`);
}

export function createStateStore(opts = {}) {
  const repo = repoFor(opts, 'state');
  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    read(board) {
      if (!BOARDS.includes(board)) return Promise.reject(badBoard(board));
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(board);
        return row === undefined ? null : row;
      });
    },

    /** 三榜一起读（快照与首轮装配用）。单榜坏行不拖死另外两榜。 */
    readAll() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const map = {};
        for (const board of BOARDS) {
          const row = t.get(board);
          map[board] = row === undefined ? null : row;
        }
        return map;
      });
    },
    write(board, row) {
      if (!BOARDS.includes(board)) return Promise.reject(badBoard(board));
      return repo.enqueue(async () => {
        const value = repo.parseOrInvalid({ ...row, board });
        const t = await repo.tableOf();
        await t.put(board, value);
        return value;
      });
    },
  };
}

/** 追加式变更流水：id = `e-<毫秒>-<同毫秒序号>`（宿主发号，前端不许自带 id）。 */
export function createEventStore(opts = {}) {
  const repo = repoFor(opts, 'events');
  const now = opts.now ?? (() => Date.now());
  let seq = 0;
  let lastAt = -1;

  async function allRows(t) {
    return [...t.entries()].map(([, v]) => v).sort((a, b) => b.at - a.at || (b.id < a.id ? -1 : 1));
  }

  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    append({ kind, board = '', repo: repoKey = '', name = '', detail = '' }) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const at = now();
        if (at === lastAt) seq += 1; else { lastAt = at; seq = 0; }
        // board 空串必须转 undefined：schema 里它是 optionalEnum，'' 既不是缺省也不是合法榜名，
        // 直接送进去会把跨榜/源故障这类「不属于任何一张榜」的事件全部挡成 INVALID（血案预防）。
        const row = repo.parseOrInvalid({ id: `e-${at}-${seq}`, at, kind, board: board || undefined, repo: repoKey, name, detail });
        await t.put(row.id, row);
        return row;
      });
    },
    /** limit 钳在 [1,500]；board 传了就直接从库里按 key 取那一榜的行（省一遍全表扫，且天然满足「榜行数不固定」）。 */
    list(limit = 100, board = '') {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        let rows = await allRows(t);
        if (board && BOARDS.includes(board)) rows = rows.filter((r) => r.board === board);
        const n = Number(limit);
        const eff = Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(1, Math.trunc(n))) : 100;
        return rows.slice(0, eff);
      });
    },
    trim(keep) {
      return repo.enqueue(async () => {
        const n = Number(keep);
        if (!Number.isFinite(n) || n < 1) return 0;
        const t = await repo.tableOf();
        const rows = await allRows(t);
        const doomed = rows.slice(n);
        for (const row of doomed) await t.delete(row.id);
        return doomed.length;
      });
    },
  };
}

/** 观测史（key = 小写 owner/name）：答「这仓库头一回上榜是何时、在哪几张榜出现过」。 */
export function createSeenStore(opts = {}) {
  const repo = repoFor(opts, 'seen');
  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    readAll() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const map = new Map();
        for (const [k, v] of [...t.entries()]) map.set(k, v);
        return map;
      });
    },
    /**
     * 记一行「本轮在榜」。返回 { fresh, seen }：
     *  fresh=true 表示这台机器第一次见到该仓库 ⇒ check 产 first_on_board 事件。
     * ⚠️ 只读改一张表，不碰 state：改名判定不吃这里（改名的 key 也变了，只能靠 repoId 对 prevRows）。
     * ★ 第二十三轮起的两格（判据见 spec §0 本轮 ⑥）：
     *  · `roundsTotal` 一轮内同现三榜**只 +1** —— 判据是「这次收到的 `at` 与行里 `lastAt` 是不是同一轮」，
     *    因为 check 对三榜用的是**同一个 t0**；不这么判就是"上一轮在两张榜 ⇒ +2"，那一列的数字就与"轮"无关了。
     *  · `bestRank` 只降不升（同轮跨榜取最小，历史最好者胜出）；`rank` 不是正整数就当没这个读数，不抬也不降。
     *  ★ 上一版写下的那一行没有这两格 ⇒ 这里按 `0` / 缺位起算，读取侧（`lib/stars.js`）同样按 `0` 补，schema 不凭空造格。
     */
    touch({ repo: repoKey, name, repoId, board, at, rank }) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const cur = t.get(repoKey);
        const r = Number(rank);
        const best = Number.isFinite(r) && r > 0 ? r : null;
        if (!cur) {
          const row = repo.parseOrInvalid({
            repo: repoKey, name, repoId, firstAt: at, firstBoard: board,
            lastAt: at, lastBoard: board, boards: [board],
            roundsTotal: 1, ...(best !== null ? { bestRank: best } : {}),
          });
          await t.put(repoKey, row);
          return { fresh: true, seen: row };
        }
        const boards = cur.boards.includes(board) ? cur.boards : [...cur.boards, board];
        const sameRound = Number(cur.lastAt) === Number(at);
        const curBest = Number(cur.bestRank);
        const bestRank = best === null
          ? (Number.isFinite(curBest) && curBest > 0 ? curBest : undefined)
          : (Number.isFinite(curBest) && curBest > 0 ? Math.min(curBest, best) : best);
        const next = repo.parseOrInvalid({
          ...cur, name, repoId: repoId ?? cur.repoId, lastAt: at, lastBoard: board, boards,
          roundsTotal: Math.max(1, (Number(cur.roundsTotal) || 0) + (sameRound ? 0 : 1)),
          ...(bestRank === undefined ? {} : { bestRank }),
        });
        await t.put(repoKey, next);
        return { fresh: false, seen: next };
      });
    },
  };
}

/**
 * 仓库详情缓存（key = 小写 owner/name）：覆盖写，写完整表按 `at` 裁最老。
 * ★ 读写的 key 一律小写归一：GitHub 的 owner/name 大小写不敏感，`Vitejs/Vite` 与 `vitejs/vite`
 *   必须是同一行，否则两个人点同一个仓库会各存一份、各烧一次限额。
 */
export function createRepoCacheStore(opts = {}) {
  const repo = repoFor(opts, 'repo');
  const maxRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0 ? Math.trunc(opts.maxRows) : REPO_CACHE_MAX;
  const keyOf = (k) => String(k ?? '').trim().toLowerCase();

  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    get(key) {
      const k = keyOf(key);
      if (!k) return Promise.reject(new RecordsError(RECORDS_ERROR.INVALID, '详情缓存的 key 是空串'));
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(k);
        return row === undefined ? null : row;
      });
    },
    put(row) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const value = repo.parseOrInvalid(row);
        const k = keyOf(value.repo);
        if (!k) throw new RecordsError(RECORDS_ERROR.INVALID, '详情缓存行没有 repo 键');
        await t.put(k, { ...value, repo: k });
        const doomed = [...t.entries()].map(([key, v]) => ({ key, at: v?.at ?? 0 }))
          .sort((a, b) => b.at - a.at)
          .slice(maxRows);
        for (const d of doomed) await t.delete(d.key);
        return { key: k, dropped: doomed.length };
      });
    },
    list() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        return [...t.entries()].map(([key, v]) => ({ key, at: v?.at ?? 0, ok: v?.ok === true }))
          .sort((a, b) => b.at - a.at);
      });
    },
  };
}

/**
 * 模型现译的译文表（key = `kind:owner/name`，主键小写）：覆盖写，写满按 `at` 裁最老。
 * ★ 一仓库一路一行（同一条描述重译就覆盖旧行）：库里同时躺两份译文时，界面要说清哪一份作数 —— 不值那道工序。
 * ★ 命中判据在调用方（`llm.js` 拿 `row.src` 与原文逐字比），这里只负责存取：仓储不替业务判"新旧"。
 */
export function createTransStore(opts = {}) {
  const repo = repoFor(opts, 'trans');
  const maxRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0 ? Math.trunc(opts.maxRows) : TRANS_MAX;
  const keyOf = (kind, k) => `${String(kind ?? '').trim()}:${String(k ?? '').trim().toLowerCase()}`;

  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    get(kind, key) {
      const full = keyOf(kind, key);
      if (full.endsWith(':')) return Promise.reject(new RecordsError(RECORDS_ERROR.INVALID, `译文行的键不完整：${full}`));
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(full);
        return row === undefined ? null : row;
      });
    },
    put(row) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const value = repo.parseOrInvalid(row);
        const full = keyOf(value.kind, value.repo);
        if (full.endsWith(':')) throw new RecordsError(RECORDS_ERROR.INVALID, '译文行没有 kind 或 repo 键');
        await t.put(full, { ...value, repo: full.split(':')[1] });
        const doomed = [...t.entries()].map(([key, v]) => ({ key, at: v?.at ?? 0 }))
          .sort((a, b) => b.at - a.at)
          .slice(maxRows);
        for (const d of doomed) await t.delete(d.key);
        return { key: full, dropped: doomed.length };
      });
    },
    list() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        return [...t.entries()].map(([key, v]) => ({ key, at: v?.at ?? 0, chars: v?.chars ?? 0 }))
          .sort((a, b) => b.at - a.at);
      });
    },
    /**
     * 整表读一遍（第二十二轮：榜面那一列的中文视图每帧要吃全表）。
     * ★ 为什么不是「按屏上那些行逐个 `get`」：45 行要排 45 次队列，而 `hits` 是**读路径**上的装配 ——
     *   逐行 get 等于把每开一次面板的成本挂在榜面行数上。一次 `tableOf` 扫完才是常数成本。
     * ★ 回的是 schema 认过的整行：这里不裁字段 —— 命中判据与落款各自要读的格子不同，仓储替业务挑一遍就是第二份真相。
     */
    entries() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        // ★ 只骑 `entries()` 这条已验证的边（本仓库存 `list()` 与裁剪逻辑用的就是它），不赌 `values()` 存在与否。
        return [...t.entries()].map(([, v]) => v).filter((v) => v?.kind && v?.repo);
      });
    },
  };
}

/**
 * 「全站高星」那一批（第二十三轮，key 恒为 `batch`）。★ 刻意照 `stateStore` 那三行的读法，而不是照 `repoCacheStore`：
 *  · 一行覆盖写，不做 TTL、不做 LRU —— 它是**那一档的数据本身**，不是"点过才有"的缓存（三条理由见 domain 的 `searchRecord`）；
 *  · 坏轮由调用方写 `{ok:false, error, transport, at: 上一批的成功时刻, rows: 上一批}`（冻结），这里只负责存取，不替业务判新旧。
 * ★ 只有 `read` / `write` 两个门面方法：那一档最多一行，`list()` 摆出来就是给未来的第二真相留门。
 */
export function createSearchStore(opts = {}) {
  const repo = repoFor(opts, 'search');
  const BATCH_KEY = 'batch';
  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    read() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(BATCH_KEY);
        return row === undefined ? null : row;
      });
    },
    write(row) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const value = repo.parseOrInvalid(row);
        await t.put(BATCH_KEY, value);
        return value;
      });
    },
  };
}

/** 偏好：整行一份；读时与 DEFAULT_PREFS 合并（库里 undefined = 从未写入）。 */
export function createPrefsStore(opts = {}) {
  const repo = repoFor(opts, 'prefs');
  const logger = opts.logger;

  function clampPrefs(raw) {
    const p = { ...DEFAULT_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (!CHECK_INTERVALS.includes(Number(p.intervalMin))) p.intervalMin = DEFAULT_PREFS.intervalMin;
    // 详情缓存时长（第十二轮）：与 intervalMin 同一条律 —— 只认封闭档位，越界退回出厂 24 小时。
    // ★ 不做"就近取档"：库里躺着 5 或 100 时，把它折进某一档等于替用户改了他没选过的东西。
    if (!REPO_CACHE_HOURS.includes(Number(p.repoCacheHours))) p.repoCacheHours = DEFAULT_PREFS.repoCacheHours;
    p.topN = Math.min(TOP_N_MAX, Math.max(TOP_N_MIN, Number(p.topN) || DEFAULT_PREFS.topN));
    p.keepEvents = Math.min(KEEP_EVENTS_MAX, Math.max(KEEP_EVENTS_MIN, Number(p.keepEvents) || DEFAULT_PREFS.keepEvents));
    const lang = normalizeLanguage(p.language);
    if (!lang.ok) {
      logger?.warn?.(`[gh-trending] 库里的语言 slug 形状不合法（${p.language}），已回落全站`);
      p.language = '';
    } else p.language = lang.slug;
    // 代理：模式只认封闭集合；地址**原样保留**（parseProxyUrl 会把 user:pass 折成 base64，
    // 归一化等于把用户的凭据改写成另一个串再存回去）。地址坏到不能用就落空 + 留日志 ——
    // 写路径在 api 层已经 400 拦过，落到这里只剩 profile 手改或库被外部改动的场合。
    if (!PROXY_MODES.includes(p.proxyMode)) p.proxyMode = DEFAULT_PREFS.proxyMode;
    if (typeof p.proxyUrl !== 'string') p.proxyUrl = DEFAULT_PREFS.proxyUrl;
    else p.proxyUrl = p.proxyUrl.trim();
    if (p.proxyUrl && !parseProxyUrl(p.proxyUrl).ok) {
      logger?.warn?.(`[gh-trending] 库里的代理地址不可用（${maskProxyUrl(p.proxyUrl)}），已清空自定义地址`);
      p.proxyUrl = '';
    }
    // 现译两开关：只认 `true`。库里躺着外部改出来的 `'yes'` / `1` 时按关处理 ——
    // 这一对开关后面挂的是"要不要花用户的额度"，宁可少发一发，不可多发一发。
    p.llmDesc = p.llmDesc === true;
    p.llmReadme = p.llmReadme === true;
    // 「全站高星」那一档（第二十三轮）：与上面两枚同一条律 —— 只认 `true`。
    // ★ 这一格后面挂的是"每轮检查后要不要多打一发 api.github.com"，比那两发更必须宁可少发：库里躺着 `'yes'` / `1` 时按关处理。
    p.allStarsEnabled = p.allStarsEnabled === true;
    // 现译引擎（第九轮，第十轮起五档）：旧档名先搬家，再判脏回落出厂档。
    // ★ 顺序不能反：先判脏就把库里的 `official` 当成脏值抹回「免费接口」，用户重启一次引擎行悄悄换档、
    //   下面那两格凭据也读不到了（凭据还在库里，只是没人念它）。
    if (LEGACY_TRANSLATE_ENGINES[p.translateEngine]) p.translateEngine = LEGACY_TRANSLATE_ENGINES[p.translateEngine];
    if (!TRANSLATE_ENGINES.includes(p.translateEngine)) p.translateEngine = DEFAULT_TRANSLATE_ENGINE;
    // 各家凭据那几格：只钳长度、不归一化内容（同代理地址那条律：改写用户填的串等于换成另一个值）。
    // ★ 清单从 domain 的字段表派生（第十轮起三家六格，第二十一轮起再加 GitHub 令牌 = `PREF_CRED_FIELDS`）—— 手抄就会漏掉新增那几家，密钥原样穿到快照里。
    for (const f of PREF_CRED_FIELDS) {
      p[f.key] = typeof p[f.key] === 'string' ? p[f.key].trim().slice(0, f.maxLength) : '';
    }
    return p;
  }

  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    /**
     * 读偏好。默认宽容（界面永远拿到可用值），`{strict:true}` 时把「域不可用」如实抛给调用方 ——
     * 装配层要靠这一次区分决定能力位：宽容地把 open 失败当"没写过偏好"，界面上就会显示「存储在位」而写不进去。
     */
    read(opts = {}) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(PREFS_KEY);
        return clampPrefs(row === undefined ? null : row);
      }).catch((e) => {
        // 域不可用不是崩溃：回落默认值，界面经 available 位知道「写不进去」（spec §4 末段）。
        if (opts.strict) throw e;
        if (e?.code === RECORDS_ERROR.UNAVAILABLE || e?.code === RECORDS_ERROR.CLOSED) return clampPrefs(null);
        throw e;
      });
    },
    /** 读-并-写整行：只发半份 = 把其余键静默抹掉（sysops 最终评审 Critical-1 同条教训）。 */
    patch(fields) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const cur = t.get(PREFS_KEY) ?? {};
        const merged = clampPrefs({ ...cur, ...(fields && typeof fields === 'object' ? fields : {}) });
        // 落库吃 schema（parseOrInvalid），**回给调用方吃 merged**：
        // schema 会把空串 language（=全站，出厂默认）归一成"没有这个键"，直接回它界面就缺字段。
        await t.put(PREFS_KEY, repo.parseOrInvalid(merged));
        return merged;
      });
    },
  };
}

export { RECORDS_ERROR, RecordsError, acquireDomain, releaseDomain };
