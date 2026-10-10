/**
 * test/all-stars.test.mjs —— 「全站高星」的闸门 + 每轮预算 + 坏轮冻结落库（lib/services/all-stars.js，第二十三轮 §8.8 步骤 4）。
 *
 * 这个文件要钉住的五件事，前四条逐条对应被测文件头部那四条口径，第五条是 10-09 就地改判补的第二个入口：
 *  1. **闸门顺序**（`off` 排在 `no_store` 之前）单独钉一条 —— 它和 `board-zh` 那条「`no_store` 排在 `off` 前」**故意相反**，
 *     两处各钉一次才看得出相反是有意的、不是抄漏（只测"会挡"不够，得测"按什么顺序挡"）。
 *  2. **`SEARCH_MAX_PER_ROUND` 的唯一实现处**：用例里的次数从 domain 派生（`for (i < SEARCH_MAX_PER_ROUND)`），
 *     手抄一个 `1` 进去，将来预算改成 2 时这条会假绿。
 *  3. **落库那一段必须吃真 `createSearchStore` + 真 `makeFakeFacility`**：假仓储不查 schema，测的就不是"这一轮到底存下了什么"。
 *     ★ 桩的形状逐格对齐真服务（本项目那条老律在这一档的落点）：`okRes()` / `badRes()` 抄自
 *       `lib/services/repo.js` 的 `searchRepositories()` 真实返回值 —— 成功 `{ok,at,rate:{left,limit,resetAt,authed},rows}`、
 *       失败 `{ok:false,errKey,errText,transport,at,rate}`，一格不多、一格不少。
 *  4. **令牌不在这一层**（hc-21 的效果侧）：`fetchBatch` 是**无参**函数、runner 调它时**实参为零**，
 *     再把本文件的源码扫一遍"认不认得那几个词"。★ 扫的是**去注释后的语句位**（与 `host-compat` 的 `codeOf` 同一条判据）：
 *       注释里提它是叙述，语句位出现才是出口。
 *  5. ★ **两个入口共用同一个预算实现处**（10-09 用户改判「开启的时候默认拉取一次」）：`runOnEnable()` 那条路
 *     闸一道不少、去重仍数得住，且**只有它**允许 `round.at` 记发起时刻 —— 那条例外要在判据里露头，
 *     否则"把点「开」当成一次新轮次"这件事只剩注释在说。
 *
 * 夹具口径：`SEARCH_ROW` 逐字抄自 `test/fixtures/repo-search.json`（真 `/search/repositories` 回包第 4 条，`rank` 就是它的位次）——
 * 用例不许手搓"我觉得 GitHub 会这么答"的对象（项目记忆「跨边界 payload 两头都要断言」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { check, runAll, assert, makeFakeFacility } from './_helpers.mjs';
import { createAllStarsRunner } from '../lib/services/all-stars.js';
import { createSearchStore } from '../lib/stores.js';
import { SEARCH_MAX_PER_ROUND, REPO_ERROR_LABELS } from '../lib/domain.js';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));

/* ---------------- 逐格对齐真服务的桩 ---------------- */

/** 一行高星：抄自真夹具第 4 条，字段就是 `SEARCH_ROW_SHAPE` 那六格。 */
const SEARCH_ROW = Object.freeze({
  rank: 4,
  repo: 'freecodecamp/freecodecamp',
  name: 'freeCodeCamp/freeCodeCamp',
  desc: "freeCodeCamp.org's open-source codebase and curriculum. Learn math, programming, and computer science for free.",
  lang: 'TypeScript',
  stars: 456734,
});

/** search 自己那一份读数（真回包匿名 `limit=10`，与 REST core 的 60 是两套池子 —— 见 domain 的 `SEARCH_RATE_ANON`）。 */
const rate = (over = {}) => ({ left: 9, limit: 10, resetAt: 1791518294000, authed: false, ...over });

/** 成功轮：`searchRepositories()` 的返回形状，一字不差。 */
const okRes = (rows = [SEARCH_ROW], over = {}) => ({ ok: true, at: 12345, rate: rate(), rows, ...over });

/**
 * 失败轮：同上。★ 里面那几格都是**活靶子**，各自被一条断言钉着：
 *  · `at: 99999` —— rowOf 不许取（否则「上次取回」会说假话）；
 *  · `rate` 四格**故意与成功轮那一份全都不一样**（left 0 / limit 30 / resetAt 未来 / authed true）——
 *    两批读数相同的话，「失败轮覆盖额度」这一族变异就一个信号都拿不到（本轮实测踩过：全相同 ⇒ 变异等价、假绿）。
 */
const badRes = (over = {}) => ({
  ok: false, errKey: 'rate_limited', errText: '限额用尽（403，重置于 2026/10/9 04:38:14）', transport: false,
  at: 99999, rate: { left: 0, limit: 30, resetAt: 1999000000000, authed: true }, ...over,
});

/**
 * 假 fetchBatch：记录每一次调用收到的**实参**（hc-21 的效果侧要的就是这个数），可延迟以造并发窗口。
 * `throwWith` 那一档测的是"这一发抛了"—— 编排层必须把它折成失败轮，而不是把 reject 递给调用方。
 */
function fakeFetch(res = okRes(), { delayMs = 0, throwWith = null } = {}) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (throwWith) throw new Error(throwWith);
    return res;
  };
  return { fn, calls };
}

/** 真仓储 + 真设施：落库那一段不许用假仓储替（假的一格不查 schema）。 */
function realStore() {
  const facility = makeFakeFacility();
  return { facility, store: createSearchStore({ getFacility: () => facility, logger: { warn: () => {} } }) };
}

/** 没有设施的仓储：测 `no_store` 那道闸要用真仓储的 `available` 判据，不是自己编一个 false。 */
function deadStore() {
  return createSearchStore({ getFacility: () => null, logger: { warn: () => {} } });
}

/** 装一个 runner：`store` 不给就用真设施，`prefs` 不给就按 `enabled` 那一格给。 */
function mkRunner({ store, fetchBatch, enabled = true, prefs, now = () => 7777 } = {}) {
  const logs = [];
  const ff = fetchBatch ?? fakeFetch();
  const runner = createAllStarsRunner({
    searchStore: store ?? realStore().store,
    fetchBatch: ff.fn ?? ff,
    getPrefs: prefs ?? (() => ({ allStarsEnabled: enabled })),
    logger: { warn: (m) => logs.push(String(m)) },
    now,
  });
  return { runner, logs, ff };
}

/* ---------------- 1. 闸门：顺序、一发不派、返回形状 ---------------- */

check('闸门顺序：没开排在存储可用性之前 —— 关着 + 无设施时念的是 off（与 board-zh 故意相反，两边各钉一次）', async () => {
  const { runner, ff } = mkRunner({ enabled: false, store: deadStore() });
  const r = await runner.run(1000);
  assert.equal(r.skipped, 'off', '这一档没开时连"存不存得下"都不该讨论：先问用户开没开（这一档是出厂关的）');
  assert.equal(ff.calls.length, 0, 'off 那一档一发都不派');
  const second = mkRunner({ store: deadStore() });
  assert.equal((await second.runner.run(1000)).skipped, 'no_store', '开着 + 无设施才轮到 no_store ⇒ 两条闸的相对次序就这两行说了算');
});

check('四道闸各返回一次且一发不派，skipped 的返回形状恒为 {skipped,sent:0,ok:0,failed:0,stored:false}', async () => {
  const a = mkRunner({ enabled: false });
  const b = mkRunner({ store: deadStore() });
  const c = mkRunner();
  const d = mkRunner();
  await d.runner.run(1000);                                // 先把这一轮的预算花掉
  const got = [await a.runner.run(1000), await b.runner.run(1000), await c.runner.run(0), await d.runner.run(1000)];
  assert.deepEqual(got.map((r) => r.skipped), ['off', 'no_store', 'no_round', 'round_already_sent'],
    `四道闸的理由一个都不许多也不少，收到的是 ${JSON.stringify(got.map((r) => r.skipped))}`);
  for (const r of got) {
    assert.deepEqual({ sent: r.sent, ok: r.ok, failed: r.failed, stored: r.stored },
      { sent: 0, ok: 0, failed: 0, stored: false }, `${r.skipped} 必须四格全零 —— 有值就是这一发真出去了`);
  }
  for (const { ff } of [a, b, c, d]) {
    assert.ok(ff.calls.length <= SEARCH_MAX_PER_ROUND, '闸住的这些轮里出网数不许超过预算（d 那一发是放行，不是闸住）');
  }
  assert.equal(a.ff.calls.length + b.ff.calls.length + c.ff.calls.length, 0, 'off / no_store / no_round 三道闸各自一发不派');
});

check('no_round：轮次时刻认不出来就不发（0 / NaN / 字符串 / 负数 / Infinity 五路），并 warn 一句说清是没拿到轮次', async () => {
  const { runner, ff, logs } = mkRunner();
  for (const bad of [0, NaN, '1000', undefined, -5, Infinity]) {
    const r = await runner.run(bad);
    assert.equal(r.skipped, 'no_round', `${String(bad)} 认不出轮次 ⇒ 不发（把"认不出"当"新的一轮"= 每次触发都发一发）`);
  }
  assert.equal(ff.calls.length, 0, '这一档的预算只按轮次数，摸不到轮次就一发不派');
  assert.ok(logs.some((l) => /轮次/.test(l)), `没拿到轮次必须留一句实话，日志里是：${logs.join(' | ')}`);
});

check('偏好视图给 undefined 或那一格不是严格 true 都算没开（开关语义是二值的，"看着像开"不开）', async () => {
  const { runner, ff } = mkRunner({ prefs: () => undefined });
  assert.equal((await runner.run(1000)).skipped, 'off', 'getPrefs 返回 undefined ⇒ 走 off，不许崩');
  for (const notOn of ['true', 1, {}, null]) {
    const r2 = mkRunner({ prefs: () => ({ allStarsEnabled: notOn }) });
    assert.equal((await r2.runner.run(1000)).skipped, 'off', `${JSON.stringify(notOn)} 不算开`);
    assert.equal(r2.ff.calls.length, 0);
  }
  assert.equal(ff.calls.length, 0);
});

/* ---------------- 2. 每轮预算：SEARCH_MAX_PER_ROUND 的唯一实现处 ---------------- */

check('每轮预算按 SEARCH_MAX_PER_ROUND 数得住：放行次数从 domain 派生，第 N+1 发被 round_already_sent 挡', async () => {
  const { runner, ff } = mkRunner();
  for (let i = 0; i < SEARCH_MAX_PER_ROUND; i += 1) {
    const r = await runner.run(1000);
    assert.equal(r.skipped, '', `第 ${i + 1} 发在预算（${SEARCH_MAX_PER_ROUND}）内就该放行`);
  }
  assert.equal(ff.calls.length, SEARCH_MAX_PER_ROUND, '放行几发就该有几发出网');
  assert.equal((await runner.run(1000)).skipped, 'round_already_sent', '同一轮的下一发必须挡在门外');
  assert.equal(ff.calls.length, SEARCH_MAX_PER_ROUND, '挡住的那一发没出网');
});

check('闸门在第一个 await 之前判完：同一轮连触两次（第一次还在途）第二次当场报 round_already_sent', async () => {
  const { runner, ff } = mkRunner({ fetchBatch: fakeFetch(okRes(), { delayMs: 30 }) });
  const first = runner.run(1000);            // 不 await：这一发还在途
  const second = await runner.run(1000);     // 同一轮的第二次触发
  assert.equal(second.skipped, 'round_already_sent',
    '计数若记在 await 之后，两次触发会一起穿过去 ⇒ 一轮 1 发变成两轮 2 发');
  assert.equal(ff.calls.length, 1, '在途那一发已经占住了预算');
  assert.equal(runner.peek('round').sent, SEARCH_MAX_PER_ROUND);
  await first;
});

check('换轮（roundAt 变了）就重新有预算；round.at 存的是轮次时刻而不是本地时钟', async () => {
  const { runner, ff } = mkRunner();
  await runner.run(1000);
  assert.equal((await runner.run(1000)).skipped, 'round_already_sent');
  assert.equal((await runner.run(2000)).skipped, '', '新轮次 ⇒ 预算重置（这一档的节流单位是轮，不是墙钟）');
  assert.equal(ff.calls.length, SEARCH_MAX_PER_ROUND + 1);
  assert.equal(runner.peek('round').at, 2000, 'now() 给的是 7777，round.at 却是轮次 2000 ⇒ 记的不是本地时钟');
});

check('新实例 = 进程重启语义：预算只在进程内存里，同一轮时刻可以再发一发', async () => {
  const { store } = realStore();
  const r1 = mkRunner({ store });
  await r1.runner.run(1000);
  assert.equal((await r1.runner.run(1000)).skipped, 'round_already_sent');
  const r2 = mkRunner({ store });
  assert.equal((await r2.runner.run(1000)).skipped, '',
    '轮次计数不落库（与 board-zh 的失败冷却表同一条理由：这件事不值得活过重启，也不值得为它加一张表）');
  assert.equal(r2.ff.calls.length, 1);
});

check('不重试、不补发、连续失败也不另抬闸门：两轮都坏 ⇒ 两轮都真发（这里没有失败冷却表）', async () => {
  const { store } = realStore();
  const { runner, ff } = mkRunner({ store, fetchBatch: fakeFetch(badRes()) });
  assert.equal((await runner.run(1000)).skipped, '', '第一轮坏也照发');
  assert.equal((await runner.run(2000)).skipped, '', '第二轮不因上一轮坏了而被抬出的闸挡住（每轮 1 发本身就是节流）');
  assert.equal(ff.calls.length, 2);
  const p = runner.peek();
  assert.equal(p.failed, 2);
  assert.ok(!('cooling' in p), `这一档不该有冷却表，peek 却露出了它：${JSON.stringify(p)}`);
});

/* ---------------- 2b. 开启即拉（10-09 用户改判）：第二个入口，同一个预算实现处 ---------------- */

check('runOnEnable：闸门一条没少 —— 关着仍是 off、无设施仍是 no_store，且顺序与 run 同一份（不是第二套闸）', async () => {
  const a = mkRunner({ enabled: false });
  assert.equal((await a.runner.runOnEnable()).skipped, 'off', '这一档没开时那一趟照样不发（调用端的转换判据不是唯一防线）');
  assert.equal(a.ff.calls.length, 0);
  const b = mkRunner({ store: deadStore() });
  assert.equal((await b.runner.runOnEnable()).skipped, 'no_store');
  assert.equal(b.ff.calls.length, 0, '存不下的那一趟不许出网（取回来了落不进库，等于白烧一发）');
});

check('runOnEnable：当场派一发并落库，round.at 记的是发起时刻（口径 3 那句"记轮次不是本地时钟"的唯一例外，只开在这一趟）', async () => {
  const { store } = realStore();
  const { runner, ff } = mkRunner({ store });
  const r = await runner.runOnEnable();
  assert.equal(r.skipped, '', '点「开」的那一趟不该被 no_round 挡（它没有检查事件，但有自己的发起时刻）');
  assert.equal(r.sent, 1);
  assert.equal(ff.calls.length, 1);
  assert.equal((await store.read()).ok, true, '那一发要真落进库里，界面下一帧才有东西看');
  assert.deepEqual(runner.peek('round'), { at: 7777, sent: SEARCH_MAX_PER_ROUND },
    'mkRunner 的 now() 恒给 7777 ⇒ round.at 是发起时刻；换成检查轮那一路记的就是轮次时刻');
});

check('runOnEnable 的去重：同一时刻连触两次 ⇒ 第二次被 round_already_sent 挡（连点不叠发，预算仍是那个唯一实现处）', async () => {
  const { runner, ff } = mkRunner();
  await runner.runOnEnable();
  assert.equal((await runner.runOnEnable()).skipped, 'round_already_sent');
  assert.equal(ff.calls.length, SEARCH_MAX_PER_ROUND, '挡住的那一发没出网');
});

check('两个入口互不侵占预算：检查轮那一发占不掉「开」这一趟，反之亦然（点完开还得等下一轮才动 = 用户以为按钮坏了）', async () => {
  const { runner, ff } = mkRunner();
  await runner.run(1000);
  assert.equal((await runner.run(1000)).skipped, 'round_already_sent', '前提：同一轮内那一发确实被占住了');
  assert.equal((await runner.runOnEnable()).skipped, '', '开启那一趟有自己的轮次身份 ⇒ 不吃上一轮那只预算');
  assert.equal(ff.calls.length, SEARCH_MAX_PER_ROUND + 1);
  const b = mkRunner();
  await b.runner.runOnEnable();
  assert.equal((await b.runner.run(1000)).skipped, '', '反过来也一样：开过那一趟不该把检查轮那一发提前花掉');
  assert.equal(b.ff.calls.length, SEARCH_MAX_PER_ROUND + 1);
});

/* ---------------- 2c. 开启那一趟的新鲜度闸（10-09 第二条裁定「上次间隔时间范围内已经拉取过就不要拉取」） ---------------- */

const T0 = 1_700_000_000_000;   // 真实量级的 epoch（§9.2 那条"停摆三十天"的病历：小数字会把差值折成 0，判据就没牙）
const MIN = 60_000;
/** 生效偏好的视图：`intervalMin` 是窗口唯一的来源（出厂 60），用例里只许改这一格。 */
const prefsOf = (over = {}) => () => ({ allStarsEnabled: true, intervalMin: 60, ...over });
/** 先在库里落一批"成功取回于 ageMs 之前"的行（用同一个 runner 跑一轮检查，比手搓一行更贴近真实写路径）。 */
async function seedSuccess(store, { ageMs, at = () => T0 }) {
  const { runner } = mkRunner({ store, now: at, fetchBatch: fakeFetch(okRes([SEARCH_ROW], { at: T0 - ageMs })) });
  await runner.run(T0 - ageMs);
  const row = await store.read();
  assert.equal(row.ok, true, '前提：这一批是真落进库里的一条成功轮（前提不成立后面的判据就是空跑）');
  return row;
}

check('fresh：间隔之内刚成功取回过 ⇒ 「开」那一趟一发不派（skipped 恒带那五格），库里那批一个字没变', async () => {
  const { store } = realStore();
  const before = await seedSuccess(store, { ageMs: 5 * MIN });
  const { runner, ff } = mkRunner({ store, now: () => T0, prefs: prefsOf() });
  const r = await runner.runOnEnable();
  assert.equal(r.skipped, 'fresh', '5 分钟前才取回过（窗口 60 分）⇒ 这一趟不该再烧一发');
  assert.equal(r.sent, 0);
  assert.deepEqual(Object.keys(r).sort(), ['failed', 'ok', 'sent', 'skipped', 'stored'],
    '第六档 skipped 也不许打乱那个返回体键表（少一格就是让调用端去猜"没这格是不是 0"）');
  assert.equal(ff.calls.length, 0, '挡住的那一发不许出网');
  const after = await store.read();
  assert.deepEqual(after, before, '库里那一批原样留着（挡下的一趟既不写库也不推进 lastFetchAt）');
});

check('★ 窗口就是 prefs.intervalMin 那一格，不是第二个常数：同一份库（61 分钟前）在 60 档发、在 1440 档不发', async () => {
  // ★ 两档各用一份**独立**的库：第一档那一跑会真落库，共用一份的话第二档读到的就是刚写进去的那一行（61 分钟那条前提当场失效）。
  const a = realStore();
  await seedSuccess(a.store, { ageMs: 61 * MIN });
  const ra = mkRunner({ store: a.store, now: () => T0, prefs: prefsOf({ intervalMin: 60 }) });
  assert.equal((await ra.runner.runOnEnable()).skipped, '', '61 分钟 > 60 分钟的窗口 ⇒ 过期了就照发');
  assert.equal(ra.ff.calls.length, 1);
  const b = realStore();
  await seedSuccess(b.store, { ageMs: 61 * MIN });
  const rb = mkRunner({ store: b.store, now: () => T0, prefs: prefsOf({ intervalMin: 1440 }) });
  assert.equal((await rb.runner.runOnEnable()).skipped, 'fresh', '同一份库、窗口换成 24 小时 ⇒ 挡住（窗口跟着设置页那一格走，界面上看得见）');
  assert.equal(rb.ff.calls.length, 0);
});

check('★ 上一发是坏的 ⇒ 照发：判据吃 at（最后一次成功），不吃 lastFetchAt（最后一次发起，含坏轮）', async () => {
  const { store } = realStore();
  await seedSuccess(store, { ageMs: 3 * MIN });                       // 库里先有一次成功：at = T0-3min
  const bad = mkRunner({ store, now: () => T0, prefs: prefsOf(), fetchBatch: fakeFetch(badRes()) });
  await bad.runner.run(T0);                                            // 紧接着的一轮检查坏了 ⇒ lastFetchAt=T0、ok=false、at 停在 T0-3min
  const row = await store.read();
  assert.equal(row.ok, false, '前提：坏轮把 lastFetchAt 推成了此刻（fresh 若吃这一格就会把用户挡在门外）');
  assert.equal(row.at, T0 - 3 * MIN, '前提：坏轮不改 at（坏轮冻结那条律）');
  const again = mkRunner({ store, now: () => T0, prefs: prefsOf() });
  assert.equal((await again.runner.runOnEnable()).skipped, '', '坏掉的那一批不该被念成"最近拉过" ⇒ 用户点开就要能重试');
  assert.equal(again.ff.calls.length, 1);
});

check('★ 窗口量的是 at 而不是 lastFetchAt：ok 为真、两格分开的库里行 ⇒ 两个方向都按 at 那一格判', async () => {
  // ★ 上一例挡不住"改成吃 lastFetchAt"那一种变异：坏轮同时把 `ok` 写成 false，`ok === true` 那一格先把闸关掉了，
  //   字段选谁在那条用例里根本不可见（真判据是 ok，字段这一半要单独钉）。这里直接写两格分开的库里行 ——
  //   正常一轮里这两格只差一个请求耗时，所以**只有把差值摆出来**才照得出源码读的是哪一格：
  //   源码换成吃 lastFetchAt 时，下面两档会同时反向（第一档从"照发"变成"挡住"、第二档从"挡住"变成"照发"）。
  const dirty = (over) => ({
    at: 0, lastFetchAt: 0, ok: true, error: '', transport: false, rows: [SEARCH_ROW],
    rateLeft: 9, rateLimit: 10, rateResetAt: 0, rateAuthed: false, ...over,
  });
  const a = realStore();
  await a.store.write(dirty({ at: T0 - 70 * MIN, lastFetchAt: T0 - 1 * MIN }));
  const ra = mkRunner({ store: a.store, now: () => T0, prefs: prefsOf() });
  assert.equal((await ra.runner.runOnEnable()).skipped, '',
    'at（最后一次成功取回）已经出了 60 分窗口 ⇒ 该发；拿发起时刻判会把"一小时前一发取回的那一批"念成"刚刚拉过"');
  assert.equal(ra.ff.calls.length, 1);
  const b = realStore();
  await b.store.write(dirty({ at: T0 - 1 * MIN, lastFetchAt: T0 - 70 * MIN }));
  const rb = mkRunner({ store: b.store, now: () => T0, prefs: prefsOf() });
  assert.equal((await rb.runner.runOnEnable()).skipped, 'fresh',
    'at 在窗口内 ⇒ 该挡；拿发起时刻判会多发一发（反向那一半：省额度这一头也由同一格说了算）');
  assert.equal(rb.ff.calls.length, 0);
});

check('脏时刻不算新鲜：库里的 at 在未来（时钟回拨 / 脏行）⇒ 照发，不拿它当"刚取过"', async () => {
  const { store } = realStore();
  await store.write({ at: T0 + 10 * MIN, lastFetchAt: T0, ok: true, error: '', transport: false, rows: [SEARCH_ROW], rateLeft: 9, rateLimit: 10, rateResetAt: 0, rateAuthed: false });
  const { runner, ff } = mkRunner({ store, now: () => T0, prefs: prefsOf() });
  assert.equal((await runner.runOnEnable()).skipped, '', '认不出一个合理的窗口就不挡 —— 开启即拉那条裁定优先');
  assert.equal(ff.calls.length, 1);
});

check('判不出窗口（生效偏好里缺 intervalMin）⇒ 照发，与上一条同一个方向：宁可多发一发也不让屏空着', async () => {
  const { store } = realStore();
  await seedSuccess(store, { ageMs: 1 * MIN });
  const { runner, ff } = mkRunner({ store, now: () => T0, prefs: () => ({ allStarsEnabled: true }) });
  assert.equal((await runner.runOnEnable()).skipped, '');
  assert.equal(ff.calls.length, 1);
});

check('★ fresh 只挂在「关 → 开」那一趟：检查轮那一路照旧每轮一发（挪进去就把 60 分档的机器取回的数据凭空变旧一小时）', async () => {
  const { store } = realStore();
  await seedSuccess(store, { ageMs: 1 * MIN });
  const { runner, ff } = mkRunner({ store, now: () => T0, prefs: prefsOf() });
  assert.equal((await runner.run(T0)).skipped, '', '同一份库、同一个 runner，走 run(轮次) 这一路不受 fresh 影响');
  assert.equal(ff.calls.length, 1);
});

check('关着那一趟不碰库：fresh 那道闸排在 off / no_store 之后（没开的档不该去读它的存储）', async () => {
  const { store } = realStore();
  let reads = 0;
  const spy = { available: true, read: () => { reads += 1; return store.read(); }, write: (r) => store.write(r) };
  const off = mkRunner({ store: spy, prefs: () => ({ allStarsEnabled: false, intervalMin: 60 }) });
  assert.equal((await off.runner.runOnEnable()).skipped, 'off');
  assert.equal(reads, 0, 'off 那一趟一次库都不该读（口径 1 那条"先问用户开没开"在这里的可见后果）');
  const dead = mkRunner({ store: { available: false, read: () => { reads += 1; return null; }, write: async () => {} }, prefs: prefsOf() });
  assert.equal((await dead.runner.runOnEnable()).skipped, 'no_store');
  assert.equal(reads, 0, '存不下的那一趟也不读');
});

/* ---------------- 3. 落库：成功、坏轮冻结、额度四格 ---------------- */
check('成功一轮（真 createSearchStore + 真设施端到端）：落库行逐格对，rows 就是这一批，额度四格是 search 那一份', async () => {
  const { facility, store } = realStore();
  const rows = [SEARCH_ROW, { ...SEARCH_ROW, rank: 5, repo: 'vuejs/vue', name: 'vuejs/vue', stars: 212597 }];
  const { runner, ff } = mkRunner({ store, fetchBatch: fakeFetch(okRes(rows)) });
  const r = await runner.run(1000);
  assert.equal(r.skipped, '');
  assert.equal(r.stored, true, '落库成功要如实说 stored:true');
  assert.equal(r.rows, 2);
  assert.equal(r.sent, 1);
  const row = await store.read();
  assert.equal(row.at, 12345, 'at 取成功那一发的取回时刻');
  assert.equal(row.lastFetchAt, 7777, 'lastFetchAt 是 runner 的 now()（发起时刻），与 at 分家');
  assert.equal(row.ok, true);
  assert.equal('error' in row, false,
    '空串被 optionalString 折成 undefined ⇒ 库里不留空壳字段（state 表同一条读法，装配层读的时候补回空串）');
  assert.equal(row.transport, false);
  assert.deepEqual(row.rows[0], SEARCH_ROW, '六格原样入库，一格都没丢');
  assert.equal(row.rateLeft, 9);
  assert.equal(row.rateLimit, 10, 'limit 吃的是 search 那一发的响应头读数（不是 core 的 60）');
  assert.equal(row.rateResetAt, 1791518294000);
  assert.equal(row.rateAuthed, false);
  assert.equal(facility.rowCount('gh_trending', 'search'), 1, '这张表恒一行');
  assert.equal(ff.calls[0].length, 0, '顺带钉一次：这一发是无参调用');
});

check('坏轮冻结：上一批的 rows 与 at 原样留着，只改写 ok / error / transport / lastFetchAt 四格', async () => {
  const { store } = realStore();
  await mkRunner({ store }).runner.run(1000);
  const before = await store.read();

  const { runner, logs } = mkRunner({ store, fetchBatch: fakeFetch(badRes()) });
  const r = await runner.run(2000);
  assert.equal(r.skipped, '', '失败轮仍算"发过了"：这一发真出过网，预算就该扣');
  assert.equal(r.ok, 0);
  assert.equal(r.failed, 1);
  assert.equal(r.stored, true, '失败也要落库 —— 界面那句"上一批照旧 + 这一轮坏了"读的就是这一行');

  const after = await store.read();
  assert.equal(after.at, before.at, 'at 停在上一次成功的时刻：失败轮不许把它推成今天（那句「上次取回」会说假话）');
  assert.equal(after.at, 12345, '桩里那个 at: 99999 不许被取用');
  assert.equal(after.lastFetchAt, 7777, 'lastFetchAt 是这一轮发起的时刻');
  assert.equal(after.ok, false);
  assert.equal(after.transport, false);
  assert.deepEqual(after.rows, before.rows, 'rows 是上一批那一份，一个字没动');
  assert.equal(after.rateLeft, 9, '额度四格只在成功轮更新：拿失败轮的空头冲掉上一批真读数 = 一句话里两个数来自两次不同的请求');
  assert.equal(after.rateLimit, 10);
  assert.equal(after.rateResetAt, 1791518294000);
  assert.equal(after.rateAuthed, false);
  assert.ok(logs.some((l) => /上一批 1 行照旧留着/.test(l)), `坏轮要留一句实话：${logs.join(' | ')}`);
});

check('失败原因存的是原样回执，故意不过 REPO_ERROR_LABELS（那张表的 rate_limited 写死「60 次/小时」，在 search 这一档是假话）', async () => {
  const { store } = realStore();
  const r = mkRunner({ store, fetchBatch: fakeFetch(badRes()) });
  await r.runner.run(1000);
  const row = await store.read();
  assert.equal(row.error, '限额用尽（403，重置于 2026/10/9 04:38:14）', '原样回执，一字不改');
  assert.ok(!row.error.includes('60 次/小时'), '不许套上 core 那一份额度说辞');
  assert.ok(!row.error.includes(REPO_ERROR_LABELS.rate_limited),
    '套上 REPO_ERROR_LABELS 就是把两套池子念成一套（真读数 search 匿名 limit=10，见 SEARCH_RATE_ANON）');
  assert.equal(row.ok, false);
  assert.equal(row.at, 0, '没有上一批时 at 落到 0（requiredNumber 认 0 = 从未成功）');
  assert.equal('rateLeft' in row, false, '失败轮的 null 不许进库（optionalNumber 把 null 折成 undefined，record 省键）');
  assert.equal('rateLimit' in row, false);
  assert.equal(row.rateResetAt, 0, 'optionalNumber 缺省给 0 的那一路：失败轮没有上一批，读数就是 0 = 没有读数');
  assert.equal(row.rateAuthed, false);
});

check('停在上一批的不止 left：已认证那一份四格（authed:true）坏了轮也得原样留着 —— 一格都不许被空头覆盖', async () => {
  // ★ 这一份成功桩是**合成**的（本机没有 GitHub 令牌 ⇒ search 已认证那一档零真回包，见 domain 的 SEARCH_RATE_ANON 末尾那条）。
  //   合成只合在"额度四格的取值"上，形状仍是 `searchRepositories()` 那五个键；用例不许把它当实测抄录。
  const { store } = realStore();
  const authedRes = okRes([SEARCH_ROW], { rate: { left: 28, limit: 30, resetAt: 1999000000000, authed: true } });
  await mkRunner({ store, fetchBatch: fakeFetch(authedRes) }).runner.run(1000);
  const before = await store.read();
  assert.equal(before.rateAuthed, true, '先把"这一批是已认证取回的"落到库里');

  await mkRunner({ store, fetchBatch: fakeFetch(badRes()) }).runner.run(2000);
  const after = await store.read();
  assert.equal(after.rateAuthed, true, 'authed 被失败轮的空头冲掉 ⇒ 屏上那句「已认证配额」会从真话翻成假话');
  assert.equal(after.rateLeft, 28);
  assert.equal(after.rateLimit, 30);
  assert.equal(after.rateResetAt, 1999000000000);
});

check('fetchBatch 抛错折成失败轮（transport:true），run() 本身不 reject', async () => {
  const { store } = realStore();
  const { runner, logs } = mkRunner({ store, fetchBatch: fakeFetch(okRes(), { throwWith: 'socket hang up' }) });
  const r = await runner.run(1000);
  assert.equal(r.skipped, '');
  assert.equal(r.failed, 1);
  const row = await store.read();
  assert.equal(row.ok, false);
  assert.equal(row.transport, true, '抛错按传输类记：界面那句「直连未通」认的就是这一格');
  assert.match(row.error, /socket hang up/);
  assert.ok(logs.some((l) => /没取回/.test(l)));
});

check('落库失败不影响这一轮的返回（stored:false + warn 一句），出网数照实报', async () => {
  const broken = { available: true, read: () => Promise.resolve(null), write: () => Promise.reject(new Error('KV 写不进')) };
  const logs = [];
  const runner = createAllStarsRunner({
    searchStore: broken,
    fetchBatch: fakeFetch().fn,
    getPrefs: () => ({ allStarsEnabled: true }),
    logger: { warn: (m) => logs.push(String(m)) },
    now: () => 7777,
  });
  const r = await runner.run(1000);
  assert.equal(r.skipped, '', '落库坏了不是"没发"：这一发真出过网，返回里必须说 sent:1');
  assert.equal(r.sent, 1);
  assert.equal(r.stored, false, '存不下要如实说 false（能力位那句「留不下来」认的就是这一格）');
  assert.ok(logs.some((l) => /落库失败/.test(l)), `落库失败要留话：${logs.join(' | ')}`);
});

check('read() 抛错当"没有上一批"（prev=null）：不挡住这一批入库，也不把 run() 拖成 reject', async () => {
  let writes = 0;
  const store = {
    available: true,
    read: () => Promise.reject(new Error('读不动')),
    write: (row) => { writes += 1; assert.ok(Array.isArray(row.rows)); return Promise.resolve(row); },
  };
  const runner = createAllStarsRunner({
    searchStore: store, fetchBatch: fakeFetch().fn,
    getPrefs: () => ({ allStarsEnabled: true }), logger: { warn: () => {} }, now: () => 1,
  });
  const r = await runner.run(1000);
  assert.equal(r.skipped, '');
  assert.equal(writes, 1, '读不出上一批 ≠ 这一批不该写：成功轮的 rows 是本批自己，不靠上一批');
});

check('成功轮但 rows 不是数组 ⇒ 落空数组（脏回包不进 schema，也不许把上一批带回来冒充这一批）', async () => {
  const { store } = realStore();
  await mkRunner({ store, fetchBatch: fakeFetch(okRes(undefined, { rows: undefined })) }).runner.run(1000);
  const row = await store.read();
  assert.deepEqual(row.rows, [], 'rows 缺失 ⇒ 空数组：arrayOf 认空数组，认不了 undefined');
  assert.equal(row.ok, true, '这一轮确实取回并落库了，只是那一批是空的');
});

/* ---------------- 4. 令牌不在这一层（hc-21 的效果侧） ---------------- */

check('runner 调 fetchBatch 时实参为零个：这一层递不出令牌，也拿不到令牌', async () => {
  const { store } = realStore();
  const { runner, ff } = mkRunner({ store });
  await runner.run(1000);
  assert.equal(ff.calls.length, 1);
  assert.equal(ff.calls[0].length, 0,
    'fetchBatch 是无参函数（令牌已在 createSearchFetcher 里绑好）⇒ 本文件没有把凭据递出去的语句位');
});

check('本文件源码（去注释后的语句位）不认得 ghToken / 不拼 URL / 不出网：令牌的读者仍只有 repo.js 一处', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/services/all-stars.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['ghToken', 'fetchFn(', 'https://', 'search/repositories', 'api.github.com', 'Authorization']) {
    assert.ok(!src.includes(banned), `all-stars.js 的语句位出现「${banned}」⇒ 出网出口多了一处（hc-21 / hc-7 那条律）`);
  }
});

/* ---------------- 5. stats / peek / dispose ---------------- */

check('stats 记 rounds/sent/ok/failed/skipped/last，peek 单键与整份一致；dispose 把轮次计数归零', async () => {
  const { store } = realStore();
  const { runner } = mkRunner({ store });
  await runner.run(1000);
  await runner.run(1000);   // round_already_sent
  await runner.run(0);      // no_round
  const s = runner.peek();
  assert.equal(s.rounds, 1, 'rounds 只数真发过的轮');
  assert.equal(s.sent, 1);
  assert.equal(s.ok, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.skipped, 2, '两次闸住各记一次');
  assert.deepEqual(s.last, { at: 1000, sent: 1, ok: 1, failed: 0, rows: 1, stored: true });
  assert.deepEqual(s.round, { at: 1000, sent: SEARCH_MAX_PER_ROUND });
  assert.equal(runner.peek('skipped'), 2, '单键取数与整份一致');
  assert.equal(runner.peek('round').at, 1000, "peek('round') 给的是轮次计数这一格，不是 stats 里的");

  runner.dispose();
  assert.deepEqual(runner.peek('round'), { at: 0, sent: 0 }, 'dispose 后旧轮次计数不许追上来（装配层换实例 = 新进程语义）');
});

await runAll('all-stars');
