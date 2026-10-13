/**
 * lib/favs.js —— 「收藏」那一屏的**纯视图**（第三十二轮，spec §8.15）。
 *
 * 两条律，改这个文件就是改这两条：
 *  1. **不碰 IO**：不发请求、不读库、不写库（与 `lib/stars.js` 同一条律）—— 原料全由调用端喂进来
 *     （`fav` 行 + 本机已有的那一份译文命中表）。★ 于是"这一屏打开时出不出网"在结构上就是零。
 *  2. **快照不刷新**：`stars` / `desc` / `lang` 恒是库里那一行**收藏那一刻**的值，本函数一个字都不与榜上的新读数合并
 *     （§8.15 ③）。要新值走详情那一条链，那一屏出不出网由设置页那一档管着 —— 不在这里替它决定。
 *     ★ 第三十三轮（§8.16）那一格中文**不改这一条**：`descZh` 是调用端喂进来的"本机已有的那一份译文"
 *     （命中判据在 `lib/board-zh.js` 的 `descZhHits`，比的就是库里那一刻存下的那份**原文**，逐字相同才用），
 *     而 `desc` **恒是原文、绝不被中文覆盖** —— 覆盖之后屏上那一格与库里那一格同名不同值，
 *     "快照不刷新"就只剩注释能证明；悬停那一句也必须看得到原文。
 */
import {
  FAV_SORTS, FAV_DEFAULT_SORT, favSortsOf,
  FAV_STAMP_LABELS, FAV_COL_STARS,
  FAV_NOTE, FAV_EMPTY_NOTE, FAV_NO_STORE_NOTE, STARS_MISSING_CELL, favFromCell,
} from './domain.js';

const keyOf = (v) => String(v ?? '').trim().toLowerCase();
const textOf = (v) => (typeof v === 'string' ? v : '');
const numOr0 = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0);
/** 读数：拿不到给 `null`（不是 `0` —— `0` 是"真的是 0"，`null` 是"那一刻没有这一格"）。 */
const reading = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

/**
 * 收藏那一屏的视图。★ `storageAvailable` **不给默认值**：调用端没说 ⇒ `available` 落 `false` ——
 *   "存得下"是一句好话，说它要拿出依据，而缺位正是拿不出依据那一形（宿主那一路恒传 `favStore?.available === true` 一个布尔，走不到这一支）。
 */
export function favView({ favRows, descHits = null, storageAvailable } = {}) {
  const src = favRows instanceof Map ? [...favRows.values()] : Array.isArray(favRows) ? favRows : [];
  const rows = src
    .filter((r) => r && typeof r.repo === 'string' && r.repo.trim() !== '')
    .map((r) => ({
      repo: keyOf(r.repo),
      name: textOf(r.name) || keyOf(r.repo),
      desc: textOf(r.desc),
      // ★ `descZh` 那一格（第三十三轮 §8.16 ②；序号名第三十五轮起作废，行现在共十格）：本机已有的那一份中文，`{zh, via, label, note, src}` 或 `null`。
      //   命中判据**不在这里写**（那是 `lib/board-zh.js` 的 `descZhHits`，与榜面同一个函数）；★ `desc` 那一格不被它覆盖。
      descZh: descHits?.[keyOf(r.repo)] || null,
      lang: textOf(r.lang),
      langColor: textOf(r.langColor),
      stars: reading(r.stars),
      addedAt: numOr0(r.addedAt),
      from: textOf(r.from),
      // ★ 「来自 日榜」整句由宿主拼好下发（§8 一份真相）：客户端把 `from` 和「来自」接起来就是第二真相。
      fromCell: favFromCell(r.from),
    }))
    // 宿主给**恒定的那一种序**（`addedAt` 倒序，新收的在最上）；重排是界面的展示动作（§8.15 ⑤）。
    // ★ 同刻按主键字典序收尾：顺序必须每帧确定，否则同一份库存会渲染出两种顺序。
    .sort((a, b) => b.addedAt - a.addedAt || a.repo.localeCompare(b.repo));

  return {
    // ★ `available` 说的是**这一屏的原料那张表**（`fav`）：它读不到时那一屏既不是空态也不许念「还没有收藏」。
    available: storageAvailable === true,
    rows,
    count: rows.length,
    sorts: favSortsOf(),
    sortIds: FAV_SORTS,
    defaultSort: FAV_DEFAULT_SORT,
    cols: { stars: FAV_COL_STARS, ...FAV_STAMP_LABELS },
    missingCell: STARS_MISSING_CELL,
    note: FAV_NOTE,
    emptyNote: FAV_EMPTY_NOTE,
    noStoreNote: FAV_NO_STORE_NOTE,
  };
}
