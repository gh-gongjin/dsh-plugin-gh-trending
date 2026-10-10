/**
 * lib/stars.js —— 「明星仓库」那一屏的**纯视图**（第二十三轮，spec §8.8）。
 *
 * 四条律，改这个文件就是改这四条：
 *  1. **不碰 IO**：不发请求、不读库、不写库（与 `descZhView` 同一条律）—— 原料全由调用端喂进来（`seen` 行 / 三榜切片后的行 / `search` 那一批）。
 *     ★ 于是"这一屏打开时出不出网"这件事在结构上就是零，不靠某处 if 兜着。
 *  2. **每行的读数取法复用 `visibleBoardRows`**（`lib/board-zh.js`）：同一仓库在日/周/月都挂着 ⇒ 取它**名次最好**那条的读数。
 *     ★ 不另写一遍"取最好那条"：两处实现哪天漂了，界面上那一格就同时是两个答案。
 *  3. **`added` 只吃日榜**（§8.8 第 2 条）：周/月榜的"新增"是**另一个周期**，混进同一列就是把两件事演成一件 ——
 *     那一列的标签因此叫「累计 ★（今日新增）」而不是草图那句「本轮新增」。这一轮不在日榜 ⇒ `null`（界面上 `—`），
 *     ★ 与 `0` 分开：「今天没涨」与「这一轮它不在日榜」是两件事。
 *  4. **档位归属在宿主判**（`group` 进每一行）：界面只做"筛与不筛"，不判档。
 *     ★ 判序是 `回落 → 常客 → 新星`：掉榜这一件事信息量最大，所以「上了四轮但这轮没在榜」归回落而不是常客；
 *     三档**故意不互斥**也没关系 —— 「全部」那一档兜住任何归属意外，界面不许自己补互斥逻辑（§7.7）。
 *
 * ⚠️ 拿不到的读数一律给 `null`，**不硬造**：`回落` 那些行这一轮不在任何一张榜上，本地就没有它们的 `stars/desc/lang`
 *   （§0 本轮 ④ 那份清单里，`repo` 缓存只覆盖"用户点过详情"的仓库，拿它当明星那一屏的星数来源会把"没点过"演成"星数少"）。
 *   `null` 在界面上是 `—`、在排序里垫底 —— 与第 3 条 `added` 同一条律。
 */
import {
  STARS_WINDOW_MS, STARS_MIN_ROUNDS, STARS_REGULAR_ROUNDS, STARS_RISING_ROUNDS, STARS_ROWS_MAX,
  STARS_NO_STORE_NOTE, starsHeadline, starsThinNote,
  starsViewsOf, starsSortsOf,
  STARS_COL_STARS_ADDED, STARS_COL_ROUNDS_PEAK, STARS_COL_STARS, STARS_MISSING_CELL,
  STARS_ALL_STARS_NOTE, STARS_QUOTA_OFF_NOTE, starsQuotaLine,
} from './domain.js';
import { visibleBoardRows } from './board-zh.js';

const numOr0 = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0);
const keyOf = (v) => String(v ?? '').trim().toLowerCase();
/** 读数：拿不到给 null（不是 0 —— 0 是"真的是 0"，null 是"本地没有这一格"）。 */
const reading = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const textOf = (v) => (typeof v === 'string' ? v : '');

/** `seenStore.readAll()` 给 Map，测试与别处可能给数组：两种形状都收，视图不关心来源。 */
function toRows(seenRows) {
  if (seenRows instanceof Map) return [...seenRows.values()];
  return Array.isArray(seenRows) ? seenRows : [];
}

/**
 * 每行属于哪一档。★ 判序 = 回落 → 常客 → 新星（见文件头第 4 条）。
 * `rounds <= 0` 且这一轮在榜归**新星**：那是"本机第一次见到它"，判据 `roundsTotal <= STARS_RISING_ROUNDS` 天然含 0，不另开一档。
 */
function groupOf({ rounds, inBoard }) {
  if (!inBoard) return 'cooling';
  if (rounds >= STARS_REGULAR_ROUNDS) return 'regular';
  if (rounds <= STARS_RISING_ROUNDS) return 'rising';
  return 'regular';   // 今日不可达（REGULAR = RISING + 1）；两常数哪天被拉开，这一行的归属落在"过了新星线"这一侧
}

/** stars 降序（`null` 按 `-1` 参与比较 ⇒ 垫底），同星按累计轮数，再同按仓库主键字典序（每帧顺序必须确定）。 */
function byStarsDesc(a, b) {
  return (b.stars ?? -1) - (a.stars ?? -1) || b.rounds - a.rounds || a.repo.localeCompare(b.repo);
}

export function starsView({
  seenRows, boards = {}, roundAt = 0, prefs = {}, search = null, storageAvailable = true,
} = {}) {
  const enabled = prefs?.allStarsEnabled === true;
  const views = starsViewsOf(enabled);
  const sorts = starsSortsOf();
  const searchRows = search?.ok === true || Array.isArray(search?.rows)
    ? (search.rows ?? []).map((r) => ({
      rank: numOr0(r?.rank), repo: keyOf(r?.repo), name: textOf(r?.name) || keyOf(r?.repo),
      desc: textOf(r?.desc), lang: textOf(r?.lang), stars: reading(r?.stars),
    }))
    : [];
  const allStars = {
    note: STARS_ALL_STARS_NOTE,
    // ★ 开着才念额度那一句，关着念那句「未开启」—— **选哪一句是宿主的事**（界面只搬字，不再判 `prefs.allStarsEnabled`）。
    statLine: enabled
      ? starsQuotaLine({
        at: search?.at ?? 0, left: search?.rateLeft ?? null, limit: search?.rateLimit ?? null,
        resetAt: search?.rateResetAt ?? 0, authed: search?.rateAuthed === true,
      })
      : STARS_QUOTA_OFF_NOTE,
    // ★ 故障那三格与三榜那三行**同一族读数、同一形状**（§1 表里那句「上一批照常显示并挂一句故障」）：
    //   界面只念 `error` 那一份原样回执，不判档、不拼句、不看 `at` 自己算"坏在哪一轮"。
    //   `hasData` 说的是"这一档在本机落过库没有"，与"这一轮成没成"（`ok`）是两件事 ⇒ 两格都得给，缺一个就得让界面去猜。
    hasData: search !== null && search !== undefined,
    ok: search?.ok === true,
    error: search && search.ok !== true ? textOf(search.error) : '',
    transport: search && search.ok !== true ? search.transport === true : false,
    rows: searchRows,
  };

  // 能力边界 ①（§8.8）：存储缺位 ⇒ 这一屏没有榜史可读。★ 句子必须是那**一句**，不是空表那句「还没跑过第一轮检查」。
  if (storageAvailable !== true) {
    return {
      headline: STARS_NO_STORE_NOTE,
      minRounds: STARS_MIN_ROUNDS, roundsAvailable: 0, thin: false, thinNote: '',
      views, sorts,
      starsAddedLabel: STARS_COL_STARS_ADDED, roundsPeakLabel: STARS_COL_ROUNDS_PEAK, starsLabel: STARS_COL_STARS,
      missingCell: STARS_MISSING_CELL,
      rows: [], allStars,
    };
  }

  const bestRows = visibleBoardRows(boards);
  const bestByRepo = new Map(bestRows.map((r) => [keyOf(r.repo), r]));
  const dailyByRepo = new Map((Array.isArray(boards?.daily?.rows) ? boards.daily.rows : []).map((r) => [keyOf(r.repo), r]));
  const seenList = toRows(seenRows);
  const seenByRepo = new Map(seenList.map((r) => [keyOf(r.repo), r]));

  // 候选集：窗口内的观测史 **并入** 这一轮屏上的那些行（后者保证"这一轮的新面孔一定在屏上"，即使它的 `seen` 行还没写进去）。
  const windowFrom = numOr0(roundAt) - STARS_WINDOW_MS;
  const candidates = new Set();
  for (const row of seenList) {
    const repo = keyOf(row?.repo);
    if (!repo) continue;
    if (numOr0(row?.lastAt) >= windowFrom) candidates.add(repo);
  }
  for (const repo of bestByRepo.keys()) candidates.add(repo);

  const rows = [];
  for (const repo of candidates) {
    const seen = seenByRepo.get(repo);
    const live = bestByRepo.get(repo);
    const inBoard = live !== undefined;
    const rounds = numOr0(seen?.roundsTotal);
    const daily = dailyByRepo.get(repo);
    rows.push({
      repo,
      // 显示名：屏上那条优先（它带着这一轮的原始大小写），回落行退回观测史里最后一次看到的那一份。
      name: textOf(live?.name) || textOf(seen?.name) || repo,
      desc: inBoard ? textOf(live?.desc) : '',
      lang: inBoard ? textOf(live?.lang) : '',
      stars: inBoard ? reading(live?.stars) : null,
      // ★ 只吃日榜：不在日榜就是 `null`，界面上 `—`、排序里垫底；在日榜但那一格坏了给 `0`（「今天没涨」是真话）。
      added: daily ? numOr0(daily.added) : null,
      rounds,
      bestRank: numOr0(seen?.bestRank),
      group: groupOf({ rounds, inBoard }),
    });
  }

  // 截断在宿主做（§8.8 第 1 条末尾）：先按累计轮数、同轮按星数，再截 STARS_ROWS_MAX；★ 之后载荷恒按星数降序重排。
  const truncated = [...rows]
    .sort((a, b) => b.rounds - a.rounds || (b.stars ?? -1) - (a.stars ?? -1) || a.repo.localeCompare(b.repo))
    .slice(0, STARS_ROWS_MAX);
  const out = truncated.sort(byStarsDesc);
  const roundsAvailable = out.reduce((m, r) => Math.max(m, r.rounds), 0);
  const thin = roundsAvailable < STARS_MIN_ROUNDS;

  return {
    headline: starsHeadline({ windowMs: STARS_WINDOW_MS, count: out.length }),
    minRounds: STARS_MIN_ROUNDS,
    roundsAvailable,
    thin,
    thinNote: thin ? starsThinNote({ roundsAvailable, minRounds: STARS_MIN_ROUNDS }) : '',
    views,
    sorts,
    starsAddedLabel: STARS_COL_STARS_ADDED,
    roundsPeakLabel: STARS_COL_ROUNDS_PEAK,
    starsLabel: STARS_COL_STARS,
    missingCell: STARS_MISSING_CELL,
    rows: out,
    allStars,
  };
}
