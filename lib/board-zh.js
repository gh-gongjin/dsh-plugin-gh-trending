/**
 * lib/board-zh.js —— 榜面描述列的**混合来源视图** + 每轮检查后的补译批次
 * （第二十二轮，用户裁定「按 C 来：榜面也接现译」，三条口径逐条选定：每轮检查后补 / 每轮 12 发·并发 2 / 复用「描述现译」那一档）。
 *
 * 四条口径，改这个文件就是改这四条：
 *  1. **B 优先，这里只补没命中的**：内置离线表（`lib/desc-zh.js` 那张死表，本文件只读它、绝不改它）里有的那句不重发。
 *     第八轮那句「B 优先，C 只补未命中的行」原样成立，改判的只是"未命中的行"从详情那一条扩到榜面那几行。
 *  2. **读路径零发**：快照装配只调这里的纯函数 `descZhView`（吃内存里的库行），一发不派；
 *     派活只发生在 `createBoardZhRunner().run()`，而它只挂在一轮检查之后（`lib/api.js` 的 update 订阅）。
 *     ★ 界面因此永远不会"因为翻译而转圈"，配额也只在轮次节拍上花。
 *  3. **闸门排在发活之前**（顺序一条不许调换）：单闸 → 有没有那一路引擎 → **本地库在不在** → 开关开没开 → 引擎 ready → 账本读得出来 → 逐字复用 → 失败冷却 → 每轮上限。
 *     ★ 「库不可用」是闸门不是事后报错：无存储时译文落不了库，下一帧 `descZhView` 读不到它 ⇒ 每轮把同一批行重译一遍，
 *       那是纯烧额度而界面上一个字都不会变（能力位那句「变化史与偏好改动留不下来」说的就是这种机器）。
 *     ★ 「读不出账」同样闸在发之前（`read_failed`）：`entries()` 是"哪些原文已经译过"的唯一凭据，读不出来就当新行重发一遍，
 *       烧的是整份额度、换的是界面不动 —— 视图吃的还是同一张读不出来的表。
 *  4. **命中判据与 B 同一条律**：主键 + 原文逐字相同。★ 比的是 `transSrcKey` 归一后的那一份 —— 库里存的正是它，
 *     两侧必须用同一个函数（在这里再写一个 `.replace(/\s+/g,' ')` 就是第二份真相）。仓库改了描述 ⇒ 旧行读不出来 ⇒ 退回原文并重新排队。
 *
 * 这个文件**不碰宿主模型句柄**（`hc-8` 那条「唯一使用者」仍是 `lib/services/llm.js`）：它只吃装配层给的 `getTranslator()` ——
 * 派给哪一路由 `lib/api.js` 的 `pickTranslator` 按 `prefs.translateEngine` 选，与详情那一发是同一个人、同一张表、同一套落款。
 */
import { descZhFor, DESC_ZH_LABEL, DESC_ZH_NOTE } from './desc-zh.js';
import { transSrcKey } from './services/llm.js';
import { descIsZh } from './services/repo.js';
import {
  BOARDS, DESC_ZH_LIVE_NOTE, DESC_ZH_VIAS,
  BOARD_ZH_BATCH_MAX, BOARD_ZH_CONCURRENCY, BOARD_ZH_FAIL_COOLDOWN_MS,
  engineZhLabel,
} from './domain.js';

/** 冷却表的键：同一主键的同一句原文算一次失败（换了原文就是新的一发，该再试）。 */
function failKey(repo, src) {
  return `${String(repo ?? '')}|${src}`;
}

/**
 * 三榜屏上那些行去重：同一仓库在日/周/月都挂着 ⇒ 只排队一次，取它名次最好的那条。
 * ★ 只给**批次**用（少发一发是一发）；视图不吃它，见 `allVisibleRows`。
 */
export function visibleBoardRows(boards = {}, order = BOARDS) {
  const best = new Map();
  for (const board of order) {
    for (const row of boards?.[board]?.rows ?? []) {
      const repo = String(row?.repo ?? '').trim().toLowerCase();
      if (!repo) continue;
      const cur = best.get(repo);
      if (!cur || (Number(row.rank) || Infinity) < (Number(cur.rank) || Infinity)) best.set(repo, row);
    }
  }
  return [...best.values()];
}

/**
 * 三榜屏上那些行**原样并成一列**（不去重）—— 视图吃的是这一份。
 * ★ 为什么不复用 `visibleBoardRows`：两张榜上同一仓库的 desc 文本**可以不同**（三张榜是三次独立抓取，
 *   仓库在两次抓取之间改了描述）。按名次去重会留下"另一张榜那句旧原文"，于是那一行判成没命中、
 *   而命中着的那一行被丢掉 —— 第十一轮那条判据（`hits` 要覆盖 `[r1, r3]`，r3 的正是在月榜上命中的）
 *   测的就是这件事。视图按仓库记一次命中，谁逐字对上算谁。
 */
export function allVisibleRows(boards = {}, order = BOARDS) {
  const out = [];
  for (const board of order) out.push(...(boards?.[board]?.rows ?? []));
  return out;
}

/**
 * 屏上行 + 库里的 desc 行 → 这一列的中文视图。
 * @returns {hits, todo, missing, counts} —— 「显示什么」与「还该发哪些」各一遍，两遍读的是同一套判据。
 *  · `hits[repo] = { zh, via, label, note, src }`：内置优先，其次库里逐字命中的现译行；两种来源的落款各说各的。
 *     ★ `src` 是**这句中文真正对应的那一份原文**（归一口径）：同一仓库在两张榜上的 desc 可以不同，
 *       卡头那种"这一榜译了几条"的计数必须能认出这一点，否则周榜会替月榜那句中文认领功劳。
 *  · `todo`：**已有命中的仓库一律不再派**（那是白烧额度），剩下的按仓库去重、名次升序截到 `batchMax`。
 *  · `missing`：屏上「本该有中文但这一帧没有」的**仓库**数 —— 自写中文的行不算（那句中文本来就在屏上）。
 * ★ 两趟而不是单趟：单趟会让周榜那句旧原文先把仓库记成欠着，月榜后来逐字对上的那一句就没机会了（见 `allVisibleRows`）。
 */
export function descZhView(rows = [], transRows = [], {
  nowMs = 0, failed = null, cooldownMs = BOARD_ZH_FAIL_COOLDOWN_MS, batchMax = BOARD_ZH_BATCH_MAX,
} = {}) {
  const byRepo = new Map();
  for (const row of transRows) {
    if (row?.kind !== 'desc' || !row?.repo) continue;
    byRepo.set(String(row.repo).toLowerCase(), row);
  }
  const hits = {};
  const counts = { builtin: 0, live: 0 };
  for (const row of rows) {
    const repo = String(row?.repo ?? '').trim().toLowerCase();
    if (!repo || hits[repo]) continue;
    const desc = String(row?.desc ?? '');
    const builtin = descZhFor(repo, desc);
    if (builtin) {
      hits[repo] = { zh: builtin, via: 'builtin', label: DESC_ZH_LABEL, note: DESC_ZH_NOTE, src: transSrcKey(desc) };
      counts.builtin += 1;
      continue;
    }
    const stored = byRepo.get(repo);
    // ★ 逐字比对用的是库里那一份口径（transSrcKey）：原文变了这一条自动失效，宁可退回原文也不拿旧译文冒充。
    if (stored?.zh && stored.src === transSrcKey(desc)) {
      hits[repo] = {
        zh: stored.zh, via: 'live',
        label: engineZhLabel(stored.engine, stored.at), note: DESC_ZH_LIVE_NOTE, src: stored.src,
      };
      counts.live += 1;
    }
  }

  const todo = [];
  let missing = 0;
  const queued = new Set();
  for (const row of rows) {
    const repo = String(row?.repo ?? '').trim().toLowerCase();
    if (!repo || hits[repo] || queued.has(repo)) continue;
    const desc = String(row?.desc ?? '');
    if (!desc.trim()) continue;
    if (descIsZh(desc).isZh) continue;
    queued.add(repo);
    missing += 1;
    const coolingAt = failed?.get?.(failKey(repo, transSrcKey(desc)));
    if (coolingAt && nowMs - Number(coolingAt) < cooldownMs) continue;
    todo.push({ repo, desc, rank: Number(row.rank) || Infinity });
  }
  todo.sort((a, b) => a.rank - b.rank || a.repo.localeCompare(b.repo));
  return { hits, todo: todo.slice(0, batchMax), missing, counts };
}

/** 卡头那一句的文本（`0 条` 的那一路整段省掉；两路都没命中给空串 ⇒ 界面上整段不出现）。 */
export function boardDescHeadText({ builtin = 0, live = 0 } = {}) {
  if (builtin > 0 && live > 0) return `描述中文：内置预译 ${builtin} 条 · 现译 ${live} 条`;
  if (live > 0) return `描述中文为现译 ${live} 条`;
  if (builtin > 0) return `描述中译为${DESC_ZH_LABEL}`;
  return '';
}

/**
 * 按**这一张榜**的行数各算一句（三张卡各说各的条数，不拿三榜合并的数字冒充本榜）。
 * ★ 计数只认**这一行的原文逐字就是那句中文的原文**（`hit.src`）：同一仓库两张榜上的 desc 可以不同，
 *   命中记在仓库上，功劳却只能记在原文对得上的那一张榜上 —— 否则周榜会念出一句屏上对不上的话。
 */
export function boardDescZhHead(rows = [], hits = {}) {
  let builtin = 0;
  let live = 0;
  for (const row of rows) {
    const hit = hits?.[String(row?.repo ?? '').trim().toLowerCase()];
    if (!hit || hit.src !== transSrcKey(row?.desc ?? '')) continue;
    if (hit.via === 'builtin') builtin += 1;
    else if (hit.via === 'live') live += 1;
  }
  return boardDescHeadText({ builtin, live });
}

/**
 * 补译批次。★ 只有一把闸：同一时刻只跑一批，正在跑时再触发**当场返回 skipped='busy'**（不排队 —— 排队的下场是
 *   两批吃同一份 todo 各发一遍，而 `check` 那边「单闸返回 CHECK_BUSY」是同一条教训的另一个现场）。
 * @param transStore   译文表：读它做逐字复用，写它由 `translate()` 自己管（这里不碰落库，免得两份写库口径）
 * @param getTranslator 当前那一路的现译服务（装配层用 `pickTranslator` 给，本文件不知道有哪五档）
 */
export function createBoardZhRunner({
  transStore, getTranslator, logger, now = () => Date.now(),
  batchMax = BOARD_ZH_BATCH_MAX, concurrency = BOARD_ZH_CONCURRENCY, cooldownMs = BOARD_ZH_FAIL_COOLDOWN_MS,
} = {}) {
  const failed = new Map();
  let running = null;
  const stats = { rounds: 0, sent: 0, ok: 0, failedCount: 0, busy: 0, skipped: 0, last: null };

  /** 失败冷却表只在进程内存里：落库要新增一张表，而"这台机器今天译不动"这件事不值得活过重启。 */
  function markFailed(key, at) {
    if (failed.size > 500) {
      for (const [k, t] of failed) { if (at - Number(t) >= cooldownMs) failed.delete(k); }
    }
    failed.set(key, at);
  }

  async function drain(todo, tr) {
    const queue = [...todo];
    let sent = 0;
    let ok = 0;
    let bad = 0;
    const worker = async () => {
      while (queue.length) {
        const job = queue.shift();
        const src = transSrcKey(job.desc);
        sent += 1;
        const r = await tr.translate({ repo: job.repo, kind: 'desc', text: job.desc }).catch((e) => {
          logger?.warn?.(`[gh-trending] 榜面补译这一发抛了（${job.repo}）：${e?.message ?? e}`);
          return { ok: false, errKey: 'error', errText: String(e?.message ?? e) };
        });
        if (r?.ok === true) { ok += 1; continue; }
        bad += 1;
        markFailed(failKey(job.repo, src), now());
        logger?.warn?.(`[gh-trending] 榜面补译失败（${job.repo}）：${r?.note || r?.errKey || '未给出原因'}`);
      }
    };
    const size = Math.max(1, Math.min(Number(concurrency) || 1, todo.length));
    await Promise.all(Array.from({ length: size }, worker));
    return { sent, ok, bad };
  }

  function skipped(why, extra = {}) {
    stats.skipped += 1;
    return Promise.resolve({ skipped: why, sent: 0, ok: 0, failed: 0, planned: 0, ...extra });
  }

  /**
   * 跑一轮补译。返回 `{skipped?, planned, sent, ok, failed}`；`skipped` 有值就是这一轮一发都没派，理由就那四种之一。
   * ★ 闸门全部在第一个 await 之前判完 ⇒ 「同一时刻只跑一批」不是靠运气（`run` 里一旦先 await，两次触发都会穿过去）。
   */
  function run(rows = []) {
    if (running) {
      stats.busy += 1;
      return skipped('busy');
    }
    const tr = typeof getTranslator === 'function' ? getTranslator() : null;
    if (!tr) return skipped('no_engine');
    if (transStore?.available !== true) return skipped('no_store');
    if (tr.enabled?.('desc') !== true) return skipped('off');
    if (tr.ready?.() !== true) return skipped('unavailable');

    running = (async () => {
      const at = now();
      // ★ 读不出来就**不发**（返回 `read_failed`）：`entries()` 是"哪些原文已经译过"的唯一账本，
      //   拿不到账就把屏上每一行当新行重译一遍 —— 界面上一个字都不会变（视图同样读不到），烧的却是整份额度。
      const transRows = await Promise.resolve(transStore.entries()).catch((e) => {
        logger?.warn?.(`[gh-trending] 读译文表失败，这一轮榜面不补译：${e?.message ?? e}`);
        return null;
      });
      if (!transRows) {
        logger?.warn?.('[gh-trending] 账本读不出来 ⇒ 这一轮榜面补译整轮作废，不重烧已经花掉的额度');
        stats.last = { at, planned: 0, sent: 0, ok: 0, failed: 0, readFailed: true };
        return { skipped: 'read_failed', planned: 0, sent: 0, ok: 0, failed: 0 };
      }
      const { todo } = descZhView(rows, transRows, { nowMs: at, failed, cooldownMs, batchMax });
      stats.rounds += 1;
      if (!todo.length) {
        stats.last = { at, planned: 0, sent: 0, ok: 0, failed: 0 };
        return { skipped: 'nothing', planned: 0, sent: 0, ok: 0, failed: 0 };
      }
      const { sent, ok, bad } = await drain(todo, tr);
      stats.sent += sent;
      stats.ok += ok;
      stats.failedCount += bad;
      stats.last = { at, planned: todo.length, sent, ok, failed: bad };
      return { planned: todo.length, sent, ok, failed: bad };
    })().finally(() => { running = null; });
    return running;
  }

  return {
    run,
    get running() { return running !== null; },
    /** 视图与批次共用的一份 hits 装配（快照那侧调它，纯函数、零发）。 */
    view(rows, transRows = [], opts = {}) {
      return descZhView(rows, transRows, { nowMs: now(), failed, ...opts });
    },
    peek: (k) => (k ? stats[k] : { ...stats, cooling: failed.size }),
    dispose: () => { failed.clear(); running = null; },
  };
}

/** `via` 的封闭集合在这里过一道手（用例与界面都念这一格，别在别处再写一遍字面量）。 */
export const BOARD_DESC_ZH_VIAS = DESC_ZH_VIAS;
