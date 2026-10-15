/**
 * lib/services/search-run.js —— 「检索」那一屏的编排（第三十六轮，spec §8.18）。
 *
 * 这个文件只做三件事：**判能不能发 → 发那一发 → 把回包折成一次性载荷**。
 *
 * ★ 三条律，改这个文件就是改这三条：
 *  1. **零入库**：八张表一张都不碰（不 `put`、不 `get`、不裁行）⇒ "切页签就没了"是结构事实，不是注释里的一句话。
 *     判据：新套件数替身存储的写次数为 **0**。
 *  2. **闸门只有一把：一发在飞**（§8.18 ⑦）。⚠️ 它挡的是**并发**，不挡"一小时内点第十一次" —— 后者由 GitHub 回包说，
 *     ★ 这里**不自建一小时计数账本**（`x-ratelimit-*` 恒吃回包，自记一本就是第二份真相，同第二十一轮那条 `5000` 的账）。
 *     ⚠️ 也**不复用** `SEARCH_MAX_PER_ROUND`：那一格管的是检查轮那一路（`all-stars.js`），拿过来管手动这一路，
 *     设置页那句「每轮最多一发」就变成假话（§8.18 ⑦ 第三条取证）。
 *  3. **不广播**：这一趟的结果只回给提问的那一块面板，不 `broadcast('update')` —— 载荷是"这一次提问"，
 *     推给别的面板等于塞一份不属于它们的载荷（§8.18 ④，与 `POST /api/fav` 相反的读法：那一屏是本机库存，必须追帧）。
 *
 * ★ 令牌的形状（hc-21）：`fetchBatch` 是装配层用 `createSearchFetcher()` 绑好的那颗**吃 query 的闭包**，
 *   令牌已经在它里面 ⇒ 本文件从头到尾不出现 `ghToken` 这个键名，出网口仍只有 `lib/services/repo.js` 那条私有 `get()`。
 * ★ 中文那一格（§8.18 ⑤）：命中表 `descHits` 由调用端喂进来（判据单点在 `lib/board-zh.js`），
 *   ★ 这一路的行**不进补译集合、不派现译** —— 本文件连现译服务都不接。
 */
import {
  SEARCH_STATES, SEARCH_STATE_LABELS, searchStateLine,
  SEARCH_COL_STARS, SEARCH_COL_FAV, STARS_MISSING_CELL,
  starsQuotaLine,
} from '../domain.js';

const keyOf = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 一次性载荷的视图（★ 纯函数：不发请求、不读库、不写库，`fetch` 与存储一概不接）。
 *
 * @param result   `fetchBatch(query)` 的回包折成 `{ ok, at, rate, rows }` 或 `{ ok:false, errKey, errText, at, rate }`
 * @param query    这一问的词（已 trim 的非空串，闸门在路由层）
 * @param descHits 本机已有的那一份译文命中表（`descZhHits` 的 `hits`），★ 没命中就念原文，不给缺位符
 * @param favRows  收藏表本帧的行 —— ☆ 那一枚的点亮态只看"这一行收过没有"，不复制收藏那一屏的任何读数
 * @param asking   那一发还在飞（这一问没问出去，屏上摆那句"正在问"）
 */
export function searchView({ result = null, query = '', descHits = null, favRows = null, asking = false } = {}) {
  const q = String(query ?? '').trim();
  const savedKeys = new Set((Array.isArray(favRows) ? favRows : [])
    .map((r) => keyOf(r?.repo))
    .filter(Boolean));
  let state;
  if (asking) state = 'asking';
  else if (!result) state = 'idle';
  else if (result.ok === true) state = (result.rows?.length ?? 0) > 0 ? 'ok' : 'empty';
  else if (result.errKey === 'rate_limited') state = 'limited';
  else state = 'error';
  if (!SEARCH_STATES.includes(state)) state = 'error';   // 认不出的态念故障，不念成功

  const rows = state === 'ok' ? (result.rows ?? []).map((r) => ({
    rank: Number(r.rank) || 0,
    repo: keyOf(r.repo),
    name: r.name ?? r.repo,
    desc: r.desc ?? '',
    // ★ 与榜面/收藏同一条律：`desc` 恒是 GitHub 那句原文，中文只多开一格，不覆盖 —— 覆盖了屏上与载荷就同名不同值。
    descZh: descHits?.[keyOf(r.repo)] || null,
    lang: r.lang ?? '',
    stars: Number.isFinite(Number(r.stars)) ? Math.trunc(Number(r.stars)) : null,
    favSaved: savedKeys.has(keyOf(r.repo)),
  })) : [];

  const rate = result?.rate ?? {};
  return {
    query: q,
    state,
    stateLabel: SEARCH_STATE_LABELS[state],
    // ★ 六句成品全在 domain（§8.18 ③），客户端一个字都不补。
    stateNote: searchStateLine({
      state,
      query: q,
      count: rows.length,
      reason: state === 'error' || state === 'limited' ? (result?.errText ?? '') : '',
    }),
    /**
     * ★ 六态短名单原样带上（六枚静态词，客户端按 `state` 取字，不自己抄第二份名单）。
     * ★ `askingNote` 是「正在问」那一句（同样静态、不含词与条数）：那一会儿 POST 还没回，屏上却必须念得出这句话，
     *   而客户端不许造文案 ⇒ 唯一的通道是**快照里预先带过去**（§8.18 ④ 落地改口：快照因此多一枚 `search` 文案格）。
     *   ⚠️ 那一格**恒零行、纯文案**，不是"把检索结果存进快照" —— 结果仍只活在那一次 POST 的回执里。
     */
    stateLabels: SEARCH_STATE_LABELS,
    askingNote: searchStateLine({ state: 'asking' }),
    rows,
    count: rows.length,
    cols: { stars: SEARCH_COL_STARS, fav: SEARCH_COL_FAV },
    missingCell: STARS_MISSING_CELL,
    // ★ 额度那三个数恒吃回包响应头（`starsQuotaLine` 与「全站高星」同一份句子，不另立）。
    statLine: result ? starsQuotaLine({
      at: result.at ?? 0, left: rate.left ?? null, limit: rate.limit ?? null,
      resetAt: rate.resetAt ?? 0, authed: rate.authed === true,
    }) : '',
    ok: result?.ok ?? null,
    errKey: result?.errKey ?? '',
    errText: result?.errText ?? '',
    transport: result?.transport ?? null,
  };
}

/**
 * 那一问的编排（★ 只管两件事：闸 + 那一发；载荷视图是纯函数 `searchView`，由调用端喂上本帧的译文命中与收藏行）。
 */
export function createSearchRunService({ fetchBatch, logger, now = () => Date.now() } = {}) {
  /** ★ 唯一的闸：同一时刻只允许一发在飞（进程内，不落库 —— 它活不过重启，也不该活过）。 */
  let flight = null;

  /**
   * @returns `{ busy, result }`：`busy=true` ⇒ 这一问**压根没出发**（前一发还在飞），路由层据此回 409；
   *   `busy=false` ⇒ `result` 就是那一发的回包折形（`repo.js` 的 `{ok, at, rate, rows}` / 失败形状）。
   * ⚠️ 这里**不判态**（`state` 由 `searchView` 判）：态要看"回包有没有行"，而视图还要吃本帧的译文与收藏行 ——
   *   两件事留在两处，闸门这一侧就只回答"发没发、答没答"。
   */
  async function ask(query) {
    const q = String(query ?? '').trim();
    if (!q) return { busy: false, result: null };
    if (flight) {
      logger?.warn?.('[gh-trending] 检索那一发还在飞，这一问没有出发（闸门只有一把：一发在飞）');
      return { busy: true, result: null };
    }
    const run = (async () => {
      try {
        return await fetchBatch(q);
      } catch (e) {
        logger?.warn?.(`[gh-trending] 检索那一发抛错（${e?.message ?? e}），屏上念故障那句`);
        return { ok: false, errKey: 'transport', errText: String(e?.message ?? e), transport: true, at: now(), rate: {} };
      }
    })();
    flight = run.finally(() => { flight = null; });
    const result = await flight;
    return { busy: false, result };
  }

  return { ask, isBusy: () => Boolean(flight) };
}
