/**
 * test/check.test.mjs —— 检查引擎（lib/check.js）：单榜判定纯函数 + 一轮编排。
 *
 * 编排用例吃**真仓储 + 假 storageDomain 设施**（stores 那层的 schema 与串行队列一起过），
 * 出网一律注入假 fetch/假 fetchBoardFn ⇒ 本文件跑起来零请求（用户铁律：只读 GET，测试不许碰网）。
 * 断言的榜面读数来自 test/fixtures/*（2026-10-04 S0 实测切片）。
 */
import { check, runAll, assert, makeFakeFacility, fixture, makeFakeFetch, flush } from './_helpers.mjs';
import { diffBoard, crossBoards, crossEvents, createCheckService } from '../lib/check.js';
import { createStateStore, createEventStore, createSeenStore, createPrefsStore } from '../lib/stores.js';
import { BOARDS, DEFAULT_PREFS, BACKOFF_MAX_ROUNDS, BACKOFF_MAX_MS, FETCH_ATTEMPTS } from '../lib/domain.js';
import { fetchTrendingBoard } from '../lib/services/gh.js';
import { createNetTransport } from '../lib/services/net.js';

/* ---------------- 素材 ---------------- */
const crow = (repo, over = {}) => ({ rank: 0, repo, name: repo, stars: 1000, added: 50, ...over });
const prev = (repo, rank, repoId = 0) => ({ repo, name: repo, repoId: repoId || undefined, rank });
const ok = (rows, etag = 'W/"1"') => ({ ok: true, rows, pageCount: rows.length, titleLang: '', etag });
const noBoard = (reason) => ({ ok: false, reason });
const seenOf = (repos) => new Map(repos.map((r) => [r, { repo: r }]));

/* ---------------- A. diffBoard（纯函数） ---------------- */
check('diffBoard：首轮没有上轮 ⇒ 不产任何积压 diff，只标 fresh', () => {
  const rows = [crow('a/1'), crow('a/2')];
  const res = diffBoard({ board: 'daily', rows, prevRows: [], seen: seenOf([]), at: 1000 });
  assert.deepEqual(res.events, []);
  assert.deepEqual(res.rows.map((r) => r.rank), [1, 2]);      // 名次按本轮顺序重发，不吃传进来的 rank
  assert.ok(res.rows.every((r) => r.fresh === true));
});

check('diffBoard：名次连续、rank 由本轮位置决定（页面少给一条也不会错位）', () => {
  const res = diffBoard({ board: 'daily', rows: [crow('a/1', { rank: 7 }), crow('a/2', { rank: 99 })], prevRows: [], seen: null, at: 1 });
  assert.deepEqual(res.rows.map((r) => r.rank), [1, 2]);
});

check('diffBoard：进/出榜各自一条，方向与文案说清', () => {
  const res = diffBoard({
    board: 'daily',
    rows: [crow('a/keep'), crow('n/new')],
    prevRows: [prev('a/keep', 1), prev('g/gone', 2)],
    seen: seenOf(['a/keep', 'n/new']),
    at: 1000,
  });
  const kinds = res.events.map((e) => `${e.kind}:${e.repo}`).sort();
  assert.deepEqual(kinds, ['board_enter:n/new', 'board_exit:g/gone']);
  assert.equal(res.events.find((e) => e.kind === 'board_enter').detail, '第 2 名');
  assert.equal(res.events.find((e) => e.kind === 'board_exit').detail, '原第 2 名');
});

check('diffBoard：delta = 旧名次 − 新名次（正=上升），阈值以下当噪声', () => {
  const up = diffBoard({
    board: 'daily',
    rows: [crow('a/up'), crow('b/2'), crow('c/3'), crow('d/4'), crow('e/5')],
    prevRows: [prev('e/5', 1), prev('a/up', 5), prev('b/2', 2), prev('c/3', 3), prev('d/4', 4)],
    seen: seenOf(['a/up', 'e/5', 'b/2', 'c/3', 'd/4']),
    at: 1,
  });
  assert.equal(up.rows.find((r) => r.repo === 'a/up').delta, 4);   // 5 → 1
  assert.equal(up.rows.find((r) => r.repo === 'e/5').delta, -4);   // 1 → 5
  const moves = up.events.filter((e) => e.kind === 'board_move');
  assert.deepEqual(moves.map((e) => e.repo).sort(), ['a/up', 'e/5']);
  assert.equal(moves.find((e) => e.repo === 'a/up').detail, '↑ 4 位');
  assert.equal(moves.find((e) => e.repo === 'e/5').detail, '↓ 4 位');

  // 相邻换位（挪 1 位）：行上的 delta 照给（界面「较上轮」要用），但三榜一律不记流水
  const swap = (board) => diffBoard({
    board,
    rows: [crow('y/1'), crow('x/2')],
    prevRows: [prev('x/2', 1), prev('y/1', 2)],
    seen: seenOf(['x/2', 'y/1']),
    at: 1,
  });
  const quiet = swap('daily');
  assert.equal(quiet.rows.find((r) => r.repo === 'y/1').delta, 1);
  assert.equal(quiet.rows.find((r) => r.repo === 'x/2').delta, -1);
  assert.equal(quiet.events.length, 0, '日榜阈值 3：挪 1 位是噪声');

  // 挪 2 位：月榜（阈值 2）算信号，日/周榜（阈值 3）不算 —— 月榜只有 23 行且极粘
  const two = (board) => diffBoard({
    board,
    rows: [crow('z/1'), crow('y/2'), crow('x/3')],
    prevRows: [prev('x/3', 1), prev('y/2', 2), prev('z/1', 3)],
    seen: seenOf(['x/3', 'y/2', 'z/1']),
    at: 1,
  });
  assert.equal(two('monthly').events.filter((e) => e.kind === 'board_move').length, 2, '月榜挪 2 位该记');
  assert.equal(two('daily').events.filter((e) => e.kind === 'board_move').length, 0);
  assert.equal(two('weekly').events.filter((e) => e.kind === 'board_move').length, 0);
});

check('diffBoard：改名认得出来（同 repoId 换 key）——不是掉榜+新进两条假账', () => {
  const res = diffBoard({
    board: 'daily',
    rows: [crow('new/name', { repoId: 42 })],
    prevRows: [prev('old/name', 3, 42)],
    seen: seenOf([]),
    at: 1000,
  });
  const row = res.rows[0];
  assert.equal(row.renamedFrom, 'old/name');
  assert.equal(row.delta, 2);                       // 原第 3 → 现第 1
  assert.equal(row.fresh, true);                    // 这台机器第一次见这个 key（观测史口径，不影响事件）
  const kinds = res.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['renamed'], '改名只记一条：不产 board_exit/board_enter/first_on_board');
  assert.equal(res.events[0].detail, 'old/name → new/name');
});

check('diffBoard：同一轮三张榜都见新仓库 ⇒ first_on_board 只播一次', () => {
  const announced = new Set();
  const rows = [crow('n/new')];
  const prevRows = [prev('o/old', 1)];
  const d = diffBoard({ board: 'daily', rows, prevRows, seen: seenOf([]), at: 1, alreadyAnnounced: announced });
  const w = diffBoard({ board: 'weekly', rows, prevRows, seen: seenOf([]), at: 1, alreadyAnnounced: announced });
  assert.equal(d.events.filter((e) => e.kind === 'first_on_board').length, 1);
  assert.equal(w.events.filter((e) => e.kind === 'first_on_board').length, 0, '周榜不再重复播「首次上榜」');
  assert.equal(w.events.filter((e) => e.kind === 'board_enter').length, 1, '但进榜本身照记');
  assert.ok(announced.has('n/new'));
});

check('diffBoard：seen 缺位（无存储）时不标 fresh，也不崩', () => {
  const res = diffBoard({ board: 'daily', rows: [crow('a/1')], prevRows: [], seen: null, at: 1 });
  assert.equal(res.rows[0].fresh, undefined);
});

/* ---------------- B. 跨榜同现 ---------------- */
const rr = (repo, rank) => ({ ...crow(repo), rank });
const st = (board, rows, prevRows) => ({ [board]: { rows, prevRows: prevRows ?? [] } });
const mergeStates = (...objs) => Object.assign({ daily: { rows: [], prevRows: [] }, weekly: { rows: [], prevRows: [] }, monthly: { rows: [], prevRows: [] } }, ...objs);
/** 三榜齐全的状态表（crossBoards 直接吃这种形状 = state 表 readAll 的同形）。 */
const fullStates = (spec) => ({
  daily: { rows: [], prevRows: [], ...spec.daily },
  weekly: { rows: [], prevRows: [], ...spec.weekly },
  monthly: { rows: [], prevRows: [], ...spec.monthly },
});

check('crossBoards：本轮同时在 ≥2 张榜 = 持续升温，3 张全中排在前面', () => {
  const res = crossBoards(fullStates({
    daily: { rows: [rr('t/three', 5), rr('p/pair', 2)] },
    weekly: { rows: [rr('t/three', 4), rr('p/pair', 9)] },
    monthly: { rows: [rr('t/three', 7)] },
  }));
  assert.deepEqual(res.rising.map((r) => r.repo), ['t/three', 'p/pair'], '跨度大的在前');
  assert.equal(res.rising[0].span, 3);
  assert.deepEqual(res.rising[0].boards, ['daily', 'weekly', 'monthly']);
  assert.equal(res.rising[0].bestRank, 4, 'bestRank 取跨榜最好名次（日 5 / 周 4 / 月 7 ⇒ 4）');
  assert.deepEqual(res.rising[1].boards, ['daily', 'weekly']);
  assert.equal(res.rising[1].span, 2);
  assert.deepEqual(res.cooling, []);
});

check('crossBoards：上轮 2 张、本轮只剩 1 张 = 热度收敛，并说清掉的是哪张', () => {
  const res = crossBoards(fullStates({
    daily: { prevRows: [rr('f/fade', 8)] },
    weekly: { rows: [rr('f/fade', 6)], prevRows: [rr('f/fade', 6)] },
    monthly: { rows: [], prevRows: [] },
  }));
  assert.deepEqual(res.rising, [], '本轮只剩 1 张 ⇒ 不是"持续升温"');
  assert.equal(res.cooling.length, 1);
  assert.deepEqual(res.cooling[0].boards, ['weekly']);
  assert.deepEqual(res.cooling[0].lostBoards, ['daily']);
  assert.equal(res.cooling[0].bestRank, 6);
});

check('crossBoards：只上一张榜的不算同现', () => {
  const res = crossBoards(mergeStates(st('daily', [{ ...crow('s/single'), rank: 1 }], [])));
  assert.deepEqual(res.rising, []);
  assert.deepEqual(res.cooling, []);
});

check('crossEvents：只在跨度翻转那一轮记账（持续升温不每轮刷一遍）', () => {
  const joined = mergeStates(
    st('daily', [{ ...crow('t/three'), rank: 1 }], []),
    st('weekly', [{ ...crow('t/three'), rank: 2 }], []),
  );
  const first = crossEvents(joined);
  assert.deepEqual(first.map((e) => e.kind), ['rising_cross']);
  assert.match(first[0].detail, /日榜、周榜/);

  const same = mergeStates(
    st('daily', [{ ...crow('t/three'), rank: 1 }], [{ ...crow('t/three'), rank: 1 }]),
    st('weekly', [{ ...crow('t/three'), rank: 2 }], [{ ...crow('t/three'), rank: 2 }]),
  );
  assert.deepEqual(crossEvents(same), [], '上轮就 ≥2、本轮还 ≥2 ⇒ 不是变化，不记');

  const fell = mergeStates(
    st('daily', [], [{ ...crow('t/three'), rank: 1 }]),
    st('weekly', [{ ...crow('t/three'), rank: 2 }], [{ ...crow('t/three'), rank: 2 }]),
  );
  const cooled = crossEvents(fell);
  assert.deepEqual(cooled.map((e) => e.kind), ['cooling_cross']);
  assert.match(cooled[0].detail, /只剩 周榜/);

  const gone = mergeStates(
    st('weekly', [], [{ ...crow('t/three'), rank: 2 }]),
    st('daily', [], [{ ...crow('t/three'), rank: 1 }]),
  );
  assert.match(crossEvents(gone)[0].detail, /三张榜全部掉出/);
});

/* ---------------- C. runOnce 编排 ---------------- */
function mkRun({ byBoard, prefs = {}, facility, timer = true, attempts } = {}) {
  const fac = facility ?? makeFakeFacility();
  const logs = { warn: [] };
  const logger = { warn: (m) => logs.warn.push(String(m)) };
  const opts = { getFacility: () => fac, logger };
  const stores = {
    facility: fac, logs,
    state: createStateStore(opts),
    events: createEventStore(opts),
    seen: createSeenStore(opts),
    prefs: createPrefsStore(opts),
  };
  const prefsView = { ...DEFAULT_PREFS, ...prefs };
  let clock = 1000;
  const arms = [];
  const stops = { n: 0 };
  const frames = [];
  const calls = [];
  const sleeps = [];
  const svc = createCheckService({
    getPrefs: () => prefsView,
    stateStore: stores.state,
    eventStore: stores.events,
    seenStore: stores.seen,
    logger,
    now: () => (clock += 1000),
    // 宿主 ctx.timer.interval 返回的是 **disposer 函数**：这里照它记账，停/挂分两笔，断言才分得清
    getIntervalFn: timer ? () => (fn, ms) => {
      arms.push({ fn, ms });
      let done = false;
      return () => { if (!done) { done = true; stops.n += 1; } };
    } : undefined,
    fetchBoardFn: async (arg) => {
      calls.push(arg);
      const r = byBoard[arg.board];
      return typeof r === 'function' ? await r(arg) : r;
    },
    // 补发次数由用例给；sleep 换成记账桩 ⇒ 用例不真等 1 秒，但能断言"补发之间确实隔了一次退避"
    fetchAttempts: attempts,
    retryDelayMs: 7,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    onEvent: (f) => frames.push(f),
  });
  return { ...stores, svc, prefsView, arms, stops, frames, calls, sleeps, clock: () => clock };
}

check('编排：首轮三榜各落一行 state + 一条 baseline，不产榜面 diff', async () => {
  const h = mkRun({ byBoard: { daily: ok([crow('a/1'), crow('a/2')]), weekly: ok([crow('b/1')]), monthly: ok([crow('c/1')]) } });
  const res = await h.svc.run({ trigger: 'startup' });
  assert.equal(res.anyOk, true);
  assert.deepEqual(Object.keys(res.states), BOARDS);
  assert.equal(res.produced.daily.enter, 0);
  const all = await h.state.readAll();
  assert.equal(all.daily.rows.length, 2);
  assert.equal(all.daily.baseline, false, '本轮已建档：baseline 标记只用于"这一行从未成功过"');
  assert.equal(all.daily.ok, true);
  assert.equal(all.daily.at, res.at);
  const evs = await h.events.list(100);
  assert.deepEqual(evs.map((e) => e.kind).sort(), ['baseline', 'baseline', 'baseline']);
  assert.equal(h.facility.rowCount('gh_trending', 'seen'), 4);
});

check('编排：第二轮同素材不产任何榜面事件，prevRows 停在上一轮而不是自我清空', async () => {
  const h = mkRun({ byBoard: { daily: ok([crow('a/1'), crow('a/2')]), weekly: ok([]), monthly: ok([]) } });
  await h.svc.run();
  await h.svc.run();
  const res = await h.svc.run();
  assert.deepEqual(res.produced.daily, { enter: 0, exit: 0, move: 0, fresh: 0, renamed: 0, error: 0, recover: 0 });
  const all = await h.state.readAll();
  assert.deepEqual(all.daily.prevRows.map((r) => r.repo), ['a/1', 'a/2'], 'prevRows 是写盘时留下的上轮存档');
  assert.deepEqual(all.daily.rows.map((r) => r.repo), ['a/1', 'a/2']);
  const evs = await h.events.list(100);
  assert.equal(evs.filter((e) => e.kind === 'baseline').length, 3, '三榜各一条 baseline，不随轮数增长');
});

/** ★ 这一条钉的是本轮修掉的实质缺陷：对比基线取错了列（prevRows = 上轮的上轮，首轮恒为 []），
 *  轻则每轮跟隔两轮比，重则基线永远是空表 ⇒ 榜面流水整条哑掉。 */
check('编排：对比基线 = 上一轮成功的 rows（不是 prevRows，也不是坏轮冻结的旧档）', async () => {
  const rounds = [
    [crow('a/A'), crow('b/B')],
    [crow('b/B'), crow('c/C')],
    [crow('b/B'), crow('c/C')],
  ];
  let n = 0;
  const h = mkRun({
    byBoard: {
      daily: () => ok(rounds[Math.min(n, rounds.length - 1)]),
      weekly: ok([]),
      monthly: ok([]),
    },
  });
  await h.svc.run(); n += 1;                     // 首轮：建档，不 diff
  const r2 = await h.svc.run(); n += 1;          // A 掉榜、C 进榜
  assert.equal(r2.produced.daily.enter, 1);
  assert.equal(r2.produced.daily.exit, 1);
  const r3 = await h.svc.run();                  // 与上轮一模一样 ⇒ 什么都不该记
  assert.deepEqual(r3.produced.daily, { enter: 0, exit: 0, move: 0, fresh: 0, renamed: 0, error: 0, recover: 0 });
  const evs = await h.events.list(100);
  assert.equal(evs.filter((e) => e.kind === 'board_enter').length, 1, 'C 进榜只该记一次（拿隔两轮的档当基线会把它再记一遍）');
  assert.equal(evs.filter((e) => e.kind === 'board_exit').length, 1);
});

check('编排：跨榜同现在翻转那一轮落一条 rising_cross，第二轮不重复刷', async () => {
  let onWeekly = false;
  const shared = crow('t/three');
  const h = mkRun({
    byBoard: {
      daily: ok([shared]),
      weekly: () => ok(onWeekly ? [shared] : []),
      monthly: ok([]),
    },
  });
  const r1 = await h.svc.run();
  assert.equal(r1.producedCross.rising, 0, '首轮没有可信上轮 ⇒ 不补产跨榜账');
  onWeekly = true;
  const r2 = await h.svc.run();
  assert.equal(r2.producedCross.rising, 1);
  const evs = await h.events.list(100);
  assert.equal(evs.filter((e) => e.kind === 'rising_cross').length, 1);
  assert.equal(evs.find((e) => e.kind === 'rising_cross').repo, 't/three');
  const r3 = await h.svc.run();
  assert.equal(r3.producedCross.rising, 0, '上轮就 ≥2 张：不是变化，不该每轮刷一遍「持续升温」');
});

check('编排：单榜故障只冻那一榜，坏在哪一榜就只在那一榜挂闸', async () => {
  let daily = ok([crow('a/1'), crow('a/2')]);
  const h = mkRun({ byBoard: { daily: () => daily, weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  await h.svc.run();
  daily = noBoard('趋势页返回 500');
  const res = await h.svc.run();
  assert.equal(res.boardsOk.daily, false);
  assert.equal(res.boardsOk.weekly, true);
  assert.equal(res.anyOk, true, '两榜还在好 ⇒ 不算全坏，不退避');
  assert.equal(h.svc.backoffExponent, 0);
  const all = await h.state.readAll();
  assert.equal(all.daily.ok, false);
  assert.equal(all.daily.error, '趋势页返回 500');
  assert.deepEqual(all.daily.rows.map((r) => r.repo), ['a/1', 'a/2'], '坏轮冻结：榜面停在最后一次成功轮');
  assert.equal(all.daily.failStreak, 1);
  assert.equal(all.weekly.failStreak, 0);
  assert.equal((await h.events.list(100)).filter((e) => e.kind === 'source_error').length, 1);
});

check('编排：source_error 只在好坏转换那一轮记一次（连续坏不刷屏）', async () => {
  const h = mkRun({ byBoard: { daily: noBoard('趋势页请求超时（30s）'), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  await h.svc.run();   // 首轮：daily 从没成功过 → prev=null → 记一条
  await h.svc.run();
  await h.svc.run();
  const errs = (await h.events.list(100)).filter((e) => e.kind === 'source_error');
  assert.equal(errs.length, 1);
  const all = await h.state.readAll();
  assert.equal(all.daily.failStreak, 3);
});

check('编排：坏转好那一轮记 source_recover，且不补产积压 diff', async () => {
  let daily = noBoard('趋势页返回 503');
  const h = mkRun({ byBoard: { daily: () => daily, weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  await h.svc.run();
  await h.svc.run();
  daily = ok([crow('z/brand-new')]);   // 坏期间榜面真的换了人
  const res = await h.svc.run();
  const evs = await h.events.list(100);
  assert.equal(evs.filter((e) => e.kind === 'source_recover').length, 1);
  assert.equal(res.produced.daily.recover, 1);
  assert.equal(res.produced.daily.enter, 0, '恢复轮拿不到公允的上轮（rows 是坏轮冻结的旧档）⇒ 不记进榜');
  const all = await h.state.readAll();
  assert.equal(all.daily.failStreak, 0);
  assert.equal(all.daily.ok, true);
});

check('编排：304 只推 lastFetchAt，不动榜面、不产事件、不改 bodyChangedAt', async () => {
  const rows = [crow('a/1'), crow('a/2')];
  let daily = ok(rows, 'W/"e1"');
  const h = mkRun({ byBoard: { daily: () => daily, weekly: ok([crow('w/1')], 'W/"e2"'), monthly: ok([crow('m/1')], 'W/"e3"') } });
  const r1 = await h.svc.run();
  const before = await h.state.read('daily');
  assert.equal(before.etag, 'W/"e1"');
  // 第二轮：日榜回 304（页面字节没变）
  daily = { ok: true, notModified: true, etag: 'W/"e1"', rows: null, pageCount: 0, titleLang: '' };
  const r2 = await h.svc.run({ trigger: 'timer' });
  const after = await h.state.read('daily');
  assert.equal(h.calls[3].etag, 'W/"e1"', '条件请求必须把上轮 etag 带回去');
  assert.equal(h.calls[3].board, 'daily');
  assert.equal(after.bodyChangedAt, before.bodyChangedAt, '字节没变 ≠ 新增星数没变，所以「最后一次正文真变」必须原地不动');
  assert.equal(after.lastFetchAt, r2.at);
  assert.notEqual(after.lastFetchAt, r1.at);
  assert.deepEqual(after.rows.map((r) => r.repo), ['a/1', 'a/2']);
  assert.equal(after.etag, 'W/"e1"');
  assert.equal(after.ok, true);
  const evs = await h.events.list(100);
  assert.deepEqual(evs.map((e) => e.kind).sort(), ['baseline', 'baseline', 'baseline'], '304 一轮不产任何新流水');
});

check('编排：304 也是「源恢复」的证据（坏期间页面没变 = 请求又打得通了）', async () => {
  let daily = ok([crow('a/1')], 'W/"e1"');
  const h = mkRun({ byBoard: { daily: () => daily, weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  await h.svc.run();
  daily = noBoard('趋势页返回 429（60s 后再试）');
  await h.svc.run();
  daily = { ok: true, notModified: true, etag: 'W/"e1"', rows: null, pageCount: 0, titleLang: '' };
  const res = await h.svc.run();
  assert.equal(res.boardsOk.daily, true);
  const all = await h.state.readAll();
  assert.equal(all.daily.failStreak, 0);
  assert.equal(all.daily.error, undefined, 'schema 把空串归一成"没有这个键"：读侧不许留 error:"" 这种空壳');
  assert.equal((await h.events.list(100)).filter((e) => e.kind === 'source_recover').length, 1);
});

check('编排：语言 slug 站点不认 ⇒ 记成配置问题而不是源坏了，且清掉 etag', async () => {
  let daily = ok([crow('a/1')], 'W/"e1"');
  const h = mkRun({
    prefs: { language: 'jolang' },
    byBoard: { daily: () => daily, weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) },
  });
  await h.svc.run();
  assert.equal((await h.state.read('daily')).etag, 'W/"e1"');
  daily = { ok: true, rows: [], pageCount: 0, titleLang: '', unknownLanguage: true };
  const res = await h.svc.run();
  const all = await h.state.readAll();
  assert.equal(all.daily.ok, false);
  assert.match(all.daily.error, /站点不认识这个 slug/);
  assert.equal(all.daily.etag, undefined, '不许再拿旧 etag 去撞 304（空串经 schema 归一 = 没有这个键）');
  assert.deepEqual(all.daily.rows.map((r) => r.repo), ['a/1'], '同样冻结上一轮榜面：面板照常显示旧榜，闸上写清为什么不认这个语言');
  assert.equal(res.boardsOk.weekly, true);
  assert.equal((await h.events.list(100)).filter((e) => e.kind === 'source_error').length, 1);
  await h.svc.run();
  assert.equal((await h.events.list(100)).filter((e) => e.kind === 'source_error').length, 1, '同一句不认理由不重复刷流水');
});

check('编排：合法空榜（语言有效但这一档没榜）是 ok=true + rows=[]，不算故障', async () => {
  const h = mkRun({
    prefs: { language: 'brainfuck' },
    byBoard: {
      daily: { ok: true, rows: [], pageCount: 0, titleLang: 'brainfuck', emptyBoard: true, etag: 'W/"b"' },
      weekly: ok([crow('w/1')]),
      monthly: ok([crow('m/1')]),
    },
  });
  const r1 = await h.svc.run();
  const all = await h.state.read('daily');
  assert.equal(all.ok, true);
  assert.equal(all.rows.length, 0);
  assert.equal(all.error, undefined);
  assert.equal(r1.produced.daily.error, 0);
});

check('编排：三榜全坏才退避，节拍按 2 的幂翻倍并封顶；任何一榜成功就归零', async () => {
  const bad = noBoard('趋势页请求失败：boom');
  let daily = bad;
  const h = mkRun({ byBoard: { daily: () => daily, weekly: bad, monthly: bad } });
  const base = DEFAULT_PREFS.intervalMin * 60000;
  assert.equal(h.arms.length, 0);
  h.svc.setCadence(DEFAULT_PREFS.intervalMin);
  assert.equal(h.arms.length, 1);
  assert.equal(h.arms[0].ms, base);
  assert.equal(h.svc.backoffExponent, 0);
  for (let i = 1; i <= BACKOFF_MAX_ROUNDS + 2; i += 1) {
    await h.svc.run();
    const exp = Math.min(i, BACKOFF_MAX_ROUNDS);
    assert.equal(h.svc.backoffExponent, exp, `第 ${i} 轮连坏的指数`);
    // 翻倍值夹进 [用户节拍, BACKOFF_MAX_MS]：封顶后不再往上推
    assert.equal(h.svc.cadenceMs, Math.max(base, Math.min(base * (2 ** exp), BACKOFF_MAX_MS)));
  }
  assert.equal(h.svc.cadenceMs, BACKOFF_MAX_MS, `连坏到顶也不许超过 ${BACKOFF_MAX_MS / 3600000} 小时`);
  // 指数每变一次重挂一次节拍；封顶后不再反复摘挂（每轮都挂摘 = 定时器永远撞不准）
  assert.equal(h.arms.length, 1 + BACKOFF_MAX_ROUNDS, `重挂次数该跟着指数走，实际 ${h.arms.length}`);
  assert.equal(h.stops.n, BACKOFF_MAX_ROUNDS, '每次重挂前必须先停掉旧的（否则定时器叠加）');
  // 恢复：任何一榜成功即归零
  daily = ok([crow('a/1')]);
  await h.svc.run();
  assert.equal(h.svc.backoffExponent, 0);
  assert.equal(h.svc.cadenceMs, base);
  assert.equal(h.arms.length, 2 + BACKOFF_MAX_ROUNDS);
});

/* ---------------- 传输层补发（真机病历 2026-10-05 09:40） ---------------- */
const tBad = (reason) => ({ ok: false, reason, transportError: true });

check('编排：传输类失败单榜补发到出厂次数，理由里说共尝试几次', async () => {
  let n = 0;
  const h = mkRun({
    byBoard: {
      daily: () => { n += 1; return tBad('趋势页请求失败：fetch failed（UND_ERR_CONNECT_TIMEOUT）'); },
      weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]),
    },
  });
  await h.svc.run();
  assert.equal(h.calls.filter((c) => c.board === 'daily').length, FETCH_ATTEMPTS, '坏榜补发到次数上限');
  assert.equal(h.calls.filter((c) => c.board === 'weekly').length, 1, '好榜不陪着补发');
  assert.deepEqual(h.sleeps, Array(FETCH_ATTEMPTS - 1).fill(7), '补发之间要隔开，不许背靠背撞同一条断路子');
  const s = await h.state.read('daily');
  assert.equal(s.ok, false);
  assert.equal(s.transport, true, '传输类这一位要落库：界面才知道该不该提「直连未通」');
  assert.match(s.error, /共尝试 3 次/);
});

check('编排：非传输类失败（改版 / HTTP 状态）一次就收，绝不补发', async () => {
  const h = mkRun({
    byBoard: {
      daily: noBoard('趋势页返回 500'),
      weekly: noBoard('解析不出任何一行榜单条目（字段锚点疑似改版）'),
      monthly: ok([crow('m/1')]),
    },
  });
  await h.svc.run();
  assert.equal(h.calls.length, 3, '同一份答案打三遍只是白占对端配额');
  assert.deepEqual(h.sleeps, []);
  assert.notEqual((await h.state.read('daily')).transport, true);
});

check('编排：补发中途成功 ⇒ 榜面照常落库，理由里不留「共尝试」', async () => {
  let n = 0;
  const h = mkRun({
    byBoard: {
      daily: () => (n += 1) < 3
        ? tBad('趋势页请求失败：fetch failed（UND_ERR_CONNECT_TIMEOUT）')
        : ok([crow('a/1')]),
      weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]),
    },
  });
  const res = await h.svc.run();
  assert.equal(res.states.daily.ok, true);
  assert.deepEqual(res.states.daily.rows.map((r) => r.repo), ['a/1']);
  assert.equal(h.calls.filter((c) => c.board === 'daily').length, 3);
  assert.equal(res.produced.daily.error, 0, '补发成功的轮不该记数据源故障');
});

check('编排：fetchAttempts=1 时补发彻底关掉（排障口径：一次都不许多打）', async () => {
  const h = mkRun({
    attempts: 1,
    byBoard: { daily: tBad('趋势页请求失败：fetch failed'), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) },
  });
  await h.svc.run();
  assert.equal(h.calls.filter((c) => c.board === 'daily').length, 1);
  assert.deepEqual(h.sleeps, []);
});

check('编排：cadence 载荷给出下次自动检查时刻，停表后归零', async () => {
  const h = mkRun({ byBoard: { daily: ok([crow('a/1')]), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  assert.equal(h.svc.cadence.nextCheckAt, 0, '还没挂表就不许报一个未来时刻');
  h.svc.setCadence(DEFAULT_PREFS.intervalMin);
  const c = h.svc.cadence;
  assert.equal(c.intervalMin, DEFAULT_PREFS.intervalMin);
  assert.equal(c.effectiveMs, DEFAULT_PREFS.intervalMin * 60000);
  assert.equal(c.backoffExp, 0);
  assert.equal(c.fetchAttempts, FETCH_ATTEMPTS);
  assert.ok(c.nextCheckAt > 0, '挂上表就要能回答「下一次什么时候」');
  h.svc.dispose();
  assert.equal(h.svc.cadence.nextCheckAt, 0);
});

check('编排：忙时闸回 rejected promise（同步 throw 会把宿主打崩）', async () => {
  let release;
  const gate = new Promise((resolve) => { release = () => resolve(ok([crow('a/1')])); });
  const h = mkRun({ byBoard: { daily: () => gate, weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  const first = h.svc.run();
  await flush(5);
  assert.equal(h.svc.running, true);
  const busy = await h.svc.run().then(() => null, (e) => e);   // 必须是 rejection，不是同步 throw
  assert.equal(busy?.code, 'CHECK_BUSY');
  const all = await h.state.readAll();
  assert.equal(all.daily, null, '被闸掉的第二轮连库都没碰');
  release();
  await first;
  assert.equal(h.svc.running, false);
  const again = await h.svc.run();
  assert.equal(again.states.daily.rows.length, 1, '闸是轮级的，跑完就该放行');
});

check('编排：每轮推一帧 update，载荷带 produced 与时刻（SSE 帧由 api 层转全量快照）', async () => {
  const h = mkRun({ byBoard: { daily: ok([crow('a/1')]), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  const res = await h.svc.run({ trigger: 'manual' });
  assert.equal(h.frames.length, 1);
  assert.equal(h.frames[0].type, 'update');
  assert.equal(h.frames[0].trigger, 'manual');
  assert.equal(h.frames[0].at, res.at);
  assert.ok(h.frames[0].produced.daily);
});

check('编排：无存储时照样出一轮结果（读旧档失败 = 本轮不落库，不是崩溃）', async () => {
  const facility = makeFakeFacility();
  const h = mkRun({ byBoard: { daily: ok([crow('a/1')]), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) }, facility });
  await h.svc.run();
  // 三张表全关：模拟"域掉线"，本轮读写一律失败
  await h.state.close();
  await h.seen.close();
  await h.events.close();
  const res = await h.svc.run();
  assert.equal(res.states.daily.rows.length, 1, '内存里该有本轮榜（快照还要显示，只是落不了盘）');
  assert.equal(res.boardsOk.daily, true);
  assert.ok(h.logs.warn.some((m) => m.includes('读旧档失败')));
  assert.ok(h.logs.warn.some((m) => m.includes('事件落库失败')));
  assert.equal(h.facility.calls.close, 1, '三个持有者都放手 ⇒ 域恰好真关一次');
  assert.equal(h.facility.rowCount('gh_trending', 'events'), -1, '域已关：一条都写不进去（不静默写半份）');
});

check('编排：流水按 prefs.keepEvents 裁剪（超出的最老条目被删）', async () => {
  const h = mkRun({ prefs: { keepEvents: 50 }, byBoard: { daily: ok([crow('a/1')]), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  await h.svc.run();
  for (let i = 0; i < 80; i += 1) await h.events.append({ kind: 'board_enter', board: 'daily', repo: `s/${i}` });
  assert.equal(h.facility.rowCount('gh_trending', 'events'), 83);
  await h.svc.run();
  assert.equal(h.facility.rowCount('gh_trending', 'events'), 50);
});

check('编排：每轮三发 GET、按 prefs 带语言，不多打第四发', async () => {
  const h = mkRun({ prefs: { language: 'rust' }, byBoard: { daily: ok([crow('a/1')]), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  await h.svc.run();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map((c) => c.board), BOARDS);
  assert.ok(h.calls.every((c) => c.language === 'rust'));
  assert.ok(h.calls.every((c) => c.timeoutMs === 30000));
});

check('编排（端到端吃夹具）：注入假 fetch 走真解析器，日榜第 1 名是 tester-army/e2e', async () => {
  const daily = await fixture('gh-daily.html');
  const fetchFn = makeFakeFetch({
    'https://github.com/trending?since=daily': { text: daily, headers: { etag: 'W/"d1"' } },
    'https://github.com/trending/weekly': { text: daily, headers: { etag: 'W/"w1"' } },
  });
  const h = mkRun({ byBoard: {} });
  // 直接用真 fetchTrendingBoard 当 fetchBoardFn，确认注入链没有漏口（漏了就打真网络）
  const svc = createCheckService({
    getPrefs: () => DEFAULT_PREFS,
    stateStore: h.state, eventStore: h.events, seenStore: h.seen,
    logger: { warn: () => {} },
    getIntervalFn: () => undefined,
    fetchFn,
    // 未登记的 URL 会走「传输类失败」⇒ 命中补发路径；sleep 换成即时桩，本用例不该为退避真等两秒
    sleep: async () => {},
  });
  const res = await svc.run();
  assert.equal(res.states.daily.rows[0].repo, 'tester-army/e2e');
  assert.equal(res.states.daily.rows[0].stars, 2474);
  assert.equal(res.states.daily.rows.length, 9);
  assert.equal(res.states.daily.etag, 'W/"d1"');
  svc.dispose();
});

check('编排（传输层接线）：custom 模式没地址时三榜各一发就收，故障里点名是配置坏了', async () => {
  const h = mkRun({ byBoard: {} });
  const prefs = { ...DEFAULT_PREFS, proxyMode: 'custom', proxyUrl: '' };
  let registryReads = 0;
  // 与 index.js 同一条链：check → fetchTrendingBoard → net.fetch。注册表里明明有一个能用的代理，
  // 也不许被 custom 模式偷偷借走 —— 用户在设置页选的「自定义地址」就是模式选择本身。
  const net = createNetTransport({
    getPrefs: () => prefs,
    platform: 'win32',
    registryRead: async () => { registryReads += 1; return { ok: true, enabled: true, server: '127.0.0.1:7897', override: '', reason: '' }; },
    fetchFn: async () => { throw new Error('不该退回直连'); },
  });
  let sleeps = 0;
  const svc = createCheckService({
    getPrefs: () => prefs,
    stateStore: h.state, eventStore: h.events, seenStore: h.seen,
    logger: { warn: () => {} },
    getIntervalFn: () => undefined,
    fetchBoardFn: (a) => fetchTrendingBoard({ ...a, fetchFn: net.fetch }),
    sleep: async () => { sleeps += 1; },
  });
  const res = await svc.run();
  assert.equal(res.anyOk, false);
  assert.equal(res.states.daily.ok, false);
  assert.match(res.states.daily.error, /自定义代理地址不可用：没有给出代理地址/);
  assert.equal(res.states.daily.transport, false, '配置错不是传输类：补发只是把同一句报错打三遍');
  assert.equal(sleeps, 0);
  assert.equal(registryReads, 0, 'custom / direct 模式一次都不该读注册表');
  assert.equal(net.describe().via, 'failed');
  svc.dispose();
});

check('编排：dispose/stopTimer 认得宿主 disposer（不是 clearInterval(handle)）', async () => {
  const h = mkRun({ byBoard: { daily: ok([crow('a/1')]), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  let disposed = 0;
  const svc = createCheckService({
    getPrefs: () => DEFAULT_PREFS,
    stateStore: h.state, eventStore: h.events, seenStore: h.seen,
    logger: { warn: () => {} },
    getIntervalFn: () => (_fn, _ms) => { disposed += 1; return () => { disposed -= 1; }; },
    fetchBoardFn: async () => ok([]),
  });
  svc.setCadence(60);
  assert.equal(svc.timerBackend, 'ctx.timer');
  assert.equal(disposed, 1);
  svc.dispose();
  assert.equal(disposed, 0, 'dispose 必须调用宿主返回的 disposer，否则定时器会留着 ⇒ reload 后叠加');
  svc.setCadence(60);
  assert.equal(disposed, 1);
  svc.stopTimer();
  assert.equal(disposed, 0);
});

/** ★ 真机病历 2026-10-05（desktop profile）：挂满一个节拍后定时器响了，`Timeout.tick` 里抛
 *  `ReferenceError: run is not defined` —— 那条回调调的是裸 `run()`，而 `run` 当时只在 return 的对象字面量里当方法写，
 *  不在作用链上。异常从定时器落进 uncaughtException，把用户的宿主进程整个带走。
 *  上一批用例全走 `svc.run()`，一次都没碰过挂上去的回调 ⇒ 这条必须**把回调摘下来真的调**。 */
check('定时器响了：宿主回调跑完整一轮（推 update 帧 + 落库），不同步 throw', async () => {
  const h = mkRun({ byBoard: { daily: ok([crow('a/1')]), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  h.svc.setCadence(DEFAULT_PREFS.intervalMin);
  assert.equal(h.arms.length, 1, '节拍没挂上，下面就是在测空气');
  h.arms[0].fn();
  await new Promise((r) => setTimeout(r, 0));   // tick 里 run() 是发后即忘，微任务排空即整轮落地
  assert.deepEqual(h.logs.warn, [], `定时这一轮不该有告警：${h.logs.warn.join(' / ')}`);
  const last = h.frames[h.frames.length - 1];
  assert.equal(last?.type, 'update', '定时轮没推帧');
  assert.equal(last?.trigger, 'timer', 'trigger 该是 timer（tick 不带 opts）');
  const all = await h.state.readAll();
  assert.equal(all.daily.rows.length, 1);
  assert.equal((await h.events.list(100)).length, 3, '首轮三榜各一条 baseline');
});

/** 同一条回调的第二档：撞上正在跑的一轮时，CHECK_BUSY 必须被 tick 自己的 .catch 吃掉（只留一行告警）。 */
check('定时器响了却撞上正在跑的一轮：CHECK_BUSY 落在告警里，绝不冒成同步异常', async () => {
  const h = mkRun({ byBoard: { daily: () => new Promise(() => {}), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) } });
  h.svc.run();                                   // 故意不 await：日榜那发永远不回，这一轮卡在 running
  assert.equal(h.svc.running, true);
  h.svc.setCadence(DEFAULT_PREFS.intervalMin);
  h.arms[0].fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.logs.warn.length, 1, `该只有一行「定时检查失败」，实际 ${JSON.stringify(h.logs.warn)}`);
  assert.match(h.logs.warn[0], /定时检查失败：已有一轮检查在跑/);
});

/** ★ 真机崩的正是这一档：desktop host 0.2.0-rc.2 不给 `ctx.timer`（能力位 timer=false），
 *  check.js 落 `setInterval(tick, ms)` 兜底 ⇒ 一小时后 Timeout.tick 抛裸 `run`。
 *  上面两条摘的是 ctx.timer 那一路的回调，这一条把 setInterval 那一路的回调也真的调一次。 */
check('定时器响了（宿主没 ctx.timer ⇒ 走 setInterval 兜底那一档）：同一轮跑完，不 throw', async () => {
  const h = mkRun({
    timer: false,
    byBoard: { daily: ok([crow('a/1')]), weekly: ok([crow('w/1')]), monthly: ok([crow('m/1')]) },
  });
  const real = globalThis.setInterval;
  const armed = [];
  globalThis.setInterval = (fn, ms) => { armed.push({ fn, ms }); return { unref() {} }; };
  try {
    h.svc.setCadence(DEFAULT_PREFS.intervalMin);
  } finally {
    globalThis.setInterval = real;
  }
  assert.equal(h.svc.timerBackend, 'setInterval');
  assert.equal(armed.length, 1);
  assert.equal(armed[0].ms, DEFAULT_PREFS.intervalMin * 60000, '兜底档也该按用户节拍挂');
  armed[0].fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.logs.warn, [], `兜底定时这一轮不该有告警：${h.logs.warn.join(' / ')}`);
  assert.equal(h.frames[h.frames.length - 1]?.trigger, 'timer');
  assert.equal((await h.events.list(100)).length, 3);
});

await runAll('check');
