/**
 * lib/services/all-stars.js —— 「全站高星」那一发的**闸门 + 每轮预算 + 落库**（第二十三轮 §8.8 步骤 4）。
 *
 * 这个文件里没有一个字节碰令牌、也没有一个字节碰 URL：那一发长什么样、打到哪儿、带不带凭据，全在
 * `lib/services/repo.js` 的 `searchRepositories()` / `createSearchFetcher()` 里（§6「令牌只有一条出网路」要**字面**成立，
 * 编排换文件不换出口 —— 这里收到的 `fetchBatch` 是一颗**无参函数**，键名 `ghToken` 在本文件都不许出现，hc-21 按键名扫文件）。
 *
 * 四条口径：
 *  1. **闸门顺序一条不许调换**：`off` → `no_store` → `no_round` → `round_already_sent` → 发。
 *     ★ `no_round` 排在预算之前，是因为预算本身就挂在轮次上：认不出轮次就没有"这一轮第几发"可数（放它过去等于每次触发都当新轮发一发）。
 *     ★ 与 `board-zh` 那条「`no_store` 在 `off` 前」**故意相反**：这一档**没开**时根本不该讨论"存不存得下"，
 *       先问用户开没开；而补译那一档是**默认开着**的功能，库坏了必须说清"不是没开，是存不下"。
 *       两处顺序相反是**语义相反**，不是抄漏 ⇒ 判据各钉一遍顺序（`test/all-stars.test.mjs` 两条各钉一次）。
 *     ★ 10-09 第二道裁定又加了**第五道闸 `fresh`**，但它**只挂在 `runOnEnable` 那一趟**（检查轮那一路不判它）⇒ 上面那条闸序
 *       对 `run` 一字未动，`fresh` 是开启那一趟专属的第四条约束，见口径 5。
 *  2. **每轮预算的唯一实现处**就是这里那个 `round`（`SEARCH_MAX_PER_ROUND` 从 domain 来，界面上那句 note 念的也是它）：
 *     ★ 计数在**第一个 await 之前**落定 —— 记在 await 之后的话，同一轮的第二次触发会一起穿过去，
 *       一轮 1 发就变成两轮 2 发（§0 那条「预算只有挂在轮次上才数得住」）。
 *  3. **坏轮冻结**：失败只把 `ok/error/transport/lastFetchAt` 写进行里，`at` 与 `rows` 停在上一批
 *     （与三榜同一条读法）⇒ 屏上那一档照旧有东西看，而"最后一次成功取回"不会被失败轮改成今天。
 *     ★ 额度那四格**只在成功轮更新**：`starsQuotaLine` 那句是「上次取回 … · search 额度剩 …」，
 *       拿失败轮的空头把上一批的真读数冲掉，等于让一句话里两个数来自两次不同的请求。
 *  4. **不重试、不补发、不因连续失败另抬闸门**（每轮 1 发本身就是节流）⇒ 这里没有失败冷却表（与 board-zh 另一处故意不同）。
 *  5. ★ **两个入口、同一个预算实现处**（10-09 用户改判「开启的时候默认拉取一次」）：`run(roundAt)` 挂在检查轮之后，
 *     `runOnEnable()` 挂在「关 → 开」那一趟 —— 后者只是把**发起时刻**当成它自己那一轮的轮次身份，闸门一条没少、预算一格没多。
 *     去重的主闸在调用端（api 门面认出的是库里 `false → true` 那一次转换），这里的 `off` 闸是防接线错的第二眼。
 *     ★ 同一天第二条裁定「开启的时候，如果上次间隔时间范围内已经拉取过就不要拉取了」给 `runOnEnable` 又挂一道**专属闸 `fresh`**：
 *       窗口 = **`prefs.intervalMin`**（设置页那一格检查间隔，出厂 60 分 ⇒ 档位就是 60/180/720/1440，界面上看得见的那个数字，
 *       不另造一个"重开冷却"常数 —— 同一件事两处口径迟早对不上）；判据 = **`prev.ok === true` 且 `now() - prev.at < intervalMin×60000`**。
 *     ⚠️ 吃 `at`（最后一次**成功**取回）而不是 `lastFetchAt`（最后一次发起，含坏轮）—— 按用户裁定：**上一发坏了就该让用户重试**，
 *       拿 `lastFetchAt` 判会把"403 / 超时"圆成"最近拉过"，用户关掉再打开只看到屏上那句旧故障，等于多点一下没反应。
 *     ⚠️ 也**不许**挪进 `run`：检查轮那一路每轮一发是节律本身，套上这闸会把 60 分档的机器变成"一轮里如果 5 分钟前刚成功过就不取"⇒ 榜面那一屏的数据凭空变旧。
 *     ★ 这一闸挡下的那一趟返回 `skipped:'fresh'`（第六档，`sent` 仍是 0）⇒ 调用端那句 `shot.sent > 0` 自然不追帧：库里那批一个字没变，
 *       而 prefs 那一格已经跟着**同一次回执**上了屏（开关位是回执带的，不需要第二帧）。
 *
 * 失败行的 `error` 存的是**原样回执**（「限额用尽（403，重置于 …）」），故意不过 `REPO_ERROR_LABELS`：
 * 那一张表的 `rate_limited` 一格写死了「60 次/小时/机器」，念到 search 这一档就是假话（两套池子，真读数见 `SEARCH_RATE_ANON`）。
 */
import { SEARCH_MAX_PER_ROUND } from '../domain.js';

/** 落库那一行的组装（★ 成功与失败两条路都走这一个函数：各拼一份的话，改天加的字段只会有一条有）。 */
function rowOf(res, prev, { startedAt }) {
  const ok = res?.ok === true;
  const rate = ok ? (res.rate ?? {}) : {};
  return {
    at: ok ? res.at : (prev?.at ?? 0),
    lastFetchAt: startedAt,
    ok,
    error: ok ? '' : String(res?.errText || res?.errKey || '未给出原因'),
    transport: ok ? false : res?.transport === true,
    rows: ok ? (Array.isArray(res.rows) ? res.rows : []) : (Array.isArray(prev?.rows) ? prev.rows : []),
    rateLeft: ok ? (rate.left ?? null) : (prev?.rateLeft ?? null),
    rateLimit: ok ? (rate.limit ?? null) : (prev?.rateLimit ?? null),
    rateResetAt: ok ? (rate.resetAt ?? 0) : (prev?.rateResetAt ?? 0),
    rateAuthed: ok ? rate.authed === true : prev?.rateAuthed === true,
  };
}

/**
 * @param searchStore  `read()` → 上一批（没有给 null）/ `write(row)` → 覆盖那一行
 * @param fetchBatch   一颗**无参**函数：`createSearchFetcher()` 绑好的那一发（令牌已经在它里面，本文件不参与）
 * @param getPrefs     同步偏好视图（与两路现译同一个来源，装配层给 `() => prefsView`）
 */
export function createAllStarsRunner({
  searchStore, fetchBatch, getPrefs = () => ({}), logger, now = () => Date.now(),
} = {}) {
  /** 本轮预算（`SEARCH_MAX_PER_ROUND` 的唯一实现处）：`at` 是**轮次**的时刻，不是本地时钟。 */
  let round = { at: 0, sent: 0 };
  const stats = { rounds: 0, sent: 0, ok: 0, failed: 0, skipped: 0, last: null };

  function skipped(why, extra = {}) {
    stats.skipped += 1;
    return Promise.resolve({ skipped: why, sent: 0, ok: 0, failed: 0, stored: false, ...extra });
  }

  /**
   * 一轮检查之后调一次。返回 `{skipped?, sent, ok, failed, stored}`；`skipped` 有值 = 这一轮一发都没派。
   * ★ 闸门全部在第一个 await 之前判完（与 board-zh 同一条律：一旦先 await，同一轮的两次触发都会穿过去）。
   */
  function run(roundAt) {
    const prefs = getPrefs() ?? {};
    if (prefs.allStarsEnabled !== true) return skipped('off');
    if (searchStore?.available !== true) return skipped('no_store');
    // ★ 不收 `Number(roundAt)` 那一次强转：唯一的生产者就是检查事件里的 `at`（真数字），
    //   把 `'1000'` 这种能转的脏值放进来等于让接线处的错在预算上蒙混过关（转对了也说不清是哪一轮）。
    if (!Number.isFinite(roundAt) || roundAt <= 0) {
      // 认不出轮次就不发：这一档的预算**只按轮次数**，拿"认不出"当"新的一轮"等于给每次触发发一发。
      logger?.warn?.(`[gh-trending] 全站高星这一轮没拿到轮次时刻（收到 ${JSON.stringify(roundAt) ?? String(roundAt)}），已跳过 —— 只有检查事件带 at；保存偏好那类 update 不带，本来就不该发这一发`);
      return skipped('no_round');
    }
    const at = roundAt;
    if (round.at !== at) round = { at, sent: 0 };
    if (round.sent >= SEARCH_MAX_PER_ROUND) return skipped('round_already_sent');

    round.sent += 1;                       // ★ 在 await 之前落定，理由见文件头口径 2
    stats.rounds += 1;
    const startedAt = now();
    return (async () => {
      let res;
      try {
        res = await fetchBatch();
      } catch (e) {
        res = { ok: false, errKey: 'transport', errText: `这一发抛了：${e?.message ?? e}`, transport: true };
      }
      const prev = await Promise.resolve(searchStore.read()).catch(() => null);
      const row = rowOf(res, prev, { startedAt });
      stats.sent += 1;
      if (row.ok) stats.ok += 1; else stats.failed += 1;
      stats.last = { at, sent: 1, ok: row.ok ? 1 : 0, failed: row.ok ? 0 : 1, rows: row.rows.length, stored: false };
      if (!row.ok) logger?.warn?.(`[gh-trending] 全站高星这一轮没取回（${row.error}），上一批 ${row.rows.length} 行照旧留着`);
      try {
        await searchStore.write(row);
        stats.last.stored = true;
      } catch (e) {
        logger?.warn?.(`[gh-trending] 全站高星落库失败（${e?.message ?? e}），这一轮的读数只活在内存里到下一帧`);
      }
      return { skipped: '', sent: 1, ok: row.ok ? 1 : 0, failed: row.ok ? 0 : 1, stored: stats.last.stored, rows: row.rows.length };
    })();
  }

  return {
    run,
    /**
     * ★ 「关 → 开」那一趟（10-09 改判）：不等下一轮检查，当场发一发。
     * 它把发起时刻 `now()` 当作**这一趟自己的轮次身份**，其余一条走的就是上面那个 `run` ⇒ 四道闸一道不少。
     * ⚠️ 这是口径 3 那句「`round.at` 记的是轮次时刻而不是本地时钟」的**唯一例外**，例外只开在这一趟；
     *   真正的去重主闸在调用端（api 门面只在库里 `false` → 递来 `true` 那一趟调它），这里的 `off` 那道是防接线错。
     * ★ 10-09 第二条裁定「开启的时候，如果间隔时间范围内已经拉取过就不要拉取了」⇒ 这一趟多一道 `fresh` 闸：
     *   上一次**成功**取回（`ok === true` 且 `at` 有效）距此刻不到一份 `prefs.intervalMin` ⇒ 不重发，直接用库里那一批上屏。
     *   ⚠️ 这一道闸是这里**唯一在 `await` 之后**才判的闸门，与口径 2 那句"闸门全在第一个 await 之前判完"故意不同 ——
     *     那条律防的是**同一轮的并发穿透**（预算挂在 `round` 上，先 await 就会两发都过去），而这里要吃的原料
     *     （上一次取回的时刻）**只在库里**，没有第二个来源；穿透由调用端那道转换闸挡（第二次进来库里已经是 `true` ⇒ 根本不调这里）。
     *   ⚠️ 判据吃 `at` 而不是 `lastFetchAt`（用户裁定）：上一发是坏的（403 / 超时 / 空表）时 `at` 停在更早那次成功或 `0`
     *     ⇒ 点开照旧重试，**不许**让用户为了重试去等下一轮检查。
     */
    runOnEnable: async () => {
      const prefs = getPrefs() ?? {};
      // 关着 / 库不可用 ⇒ 不碰那次读，直接交给 run 里那两道闸（少一条读库的副作用，也让 off/no_store 的读数只有一处出处）
      if (prefs.allStarsEnabled === true && searchStore?.available === true) {
        const prev = await Promise.resolve(searchStore.read()).catch(() => null);
        const minutes = Number(prefs.intervalMin);
        const at = Number(prev?.at);
        const age = now() - at;
        // ★ `age >= 0` 不是凑数的：库里那一格来自回包时刻，时钟回拨或脏行会把它推到未来 —— 负差值恒小于任何窗口，
        //   不加这一句就把"来自未来的取回"念成"刚刚取过"，那一档从此再也发不出去（判据里有一条打在这一句上）。
        if (prev?.ok === true && Number.isFinite(at) && at > 0 && Number.isFinite(minutes) && minutes > 0
          && age >= 0 && age < minutes * 60_000) {
          logger?.warn?.(`[gh-trending] 全站高星刚在 ${Math.max(1, Math.round(age / 60_000))} 分钟前取回过（间隔 ${minutes} 分），这一次不再发`);
          return skipped('fresh');
        }
      }
      return run(now());
    },
    peek: (k) => (k ? (k === 'round' ? { ...round } : stats[k]) : { ...stats, round: { ...round } }),
    /** 没有跨轮状态要清（不重试 ⇒ 没有冷却表）；这里只把轮次计数归零，防装配层换实例后旧数追上来。 */
    dispose: () => { round = { at: 0, sent: 0 }; },
  };
}
