/**
 * test/stars.test.mjs —— 「明星仓库」那一屏的纯视图（lib/stars.js，第二十三轮，spec §8.8）。
 *
 * 这一屏的每一个数字看着都像"界面自己数一下就有"，所以 §8.8 那份算账逐条钉在这里：
 *  · 候选集按**时间窗**取（不按轮 —— 按轮就得每轮遍历全表做衰减）；
 *  · 每行读数**复用** `visibleBoardRows` 那份"取名次最好那条"（两处实现漂了，界面上那一格就是两个答案）；
 *  · `added` **只吃日榜**，不在日榜给 `null`（「今天没涨」与「这一轮它不在日榜」是两件事）；
 *  · 三档归属由**宿主**判（`group`），截断由**宿主**做，三句人话**全部现算自 domain**（用例里不许出现手抄句子）。
 * ★ 与 `descZhView` 同一条律：这里断言的是纯函数，任何一发 IO 都不该出现在这个文件被测的路径上（末条判据扫源码）。
 */
import { check, runAll, assert } from './_helpers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { starsView } from '../lib/stars.js';
import { visibleBoardRows } from '../lib/board-zh.js';
import {
  BOARDS,
  STARS_WINDOW_MS, STARS_MIN_ROUNDS, STARS_REGULAR_ROUNDS, STARS_RISING_ROUNDS, STARS_ROWS_MAX,
  STARS_NO_STORE_NOTE, STARS_ALL_STARS_NOTE, STARS_QUOTA_OFF_NOTE, STARS_QUOTA_WAITING_NOTE, STARS_MISSING_CELL,
  STARS_COL_STARS_ADDED, STARS_COL_ROUNDS_PEAK, STARS_COL_STARS,
  starsHeadline, starsThinNote, starsQuotaLine, starsViewsOf, starsSortsOf,
} from '../lib/domain.js';

const T = 1_760_000_000_000;                    // "最近一轮"的时刻（夹具用，视图只吃传进来的 roundAt）
const DAY = 24 * 3600 * 1000;
const boardsOf = (map, at = T) => Object.fromEntries(
  BOARDS.map((b) => [b, { at, ok: true, rows: map[b] ?? [] }]),
);
const row = (repo, rank, over = {}) => ({ repo, name: repo, rank, stars: 1000, added: 10, desc: 'd', lang: 'Go', ...over });
const seen = (repo, over = {}) => ({
  repo, name: repo, firstAt: T - 30 * DAY, firstBoard: 'daily', lastAt: T, lastBoard: 'daily',
  boards: ['daily'], roundsTotal: 1, bestRank: 5, ...over,
});

/* ---------------- 候选集 ---------------- */
check('候选集按时间窗取：窗口外的观测史不进、窗口内的进（判据 = lastAt >= roundAt − STARS_WINDOW_MS）', () => {
  const v = starsView({
    seenRows: [
      seen('in/window', { lastAt: T - STARS_WINDOW_MS + 1 }),
      seen('out/window', { lastAt: T - STARS_WINDOW_MS - 1 }),
    ],
    boards: boardsOf({}), roundAt: T,
  });
  assert.deepEqual(v.rows.map((r) => r.repo).sort(), ['in/window']);
});

check('窗口边界那个值算"在窗内"（>= 不是 >）：整 7 天那位不能被一次比较踢掉', () => {
  const v = starsView({ seenRows: [seen('edge/case', { lastAt: T - STARS_WINDOW_MS })], boards: boardsOf({}), roundAt: T });
  assert.equal(v.rows.length, 1);
});

check('这一轮屏上的行**无条件进候选**：seen 那一行还没写进去的新面孔必须在屏上', () => {
  const v = starsView({
    seenRows: [],                                        // 观测史空 = 本机第一次见到它
    boards: boardsOf({ daily: [row('new/face', 1, { stars: 50 })] }, 0),   // 且三榜的 at 还是 0 ⇒ 窗口算出来是负数
    roundAt: 0,
  });
  assert.deepEqual(v.rows.map((r) => r.repo), ['new/face']);
  assert.equal(v.rows[0].rounds, 0);
});

check('候选去重：同一仓库在 seen 与三榜都出现 ⇒ 只有一行（不是两行）', () => {
  const v = starsView({ seenRows: [seen('a/b')], boards: boardsOf({ daily: [row('a/b', 3)] }), roundAt: T });
  assert.equal(v.rows.length, 1);
});

/* ---------------- 读数取法 ---------------- */
check('★ 每行读数复用 visibleBoardRows：同仓库三榜都有且数字不同时，取名次最好那条（两处实现漂 = 界面上两个答案）', () => {
  const boards = boardsOf({
    daily: [row('x/y', 9, { stars: 111, desc: '日榜那句', lang: 'Rust' })],
    weekly: [row('x/y', 2, { stars: 222, desc: '周榜那句', lang: 'C' })],      // 名次最好
    monthly: [row('x/y', 1, { stars: 333, desc: '月榜那句', lang: 'Go' })],     // 名次最好 = 1
  });
  const v = starsView({ seenRows: [seen('x/y')], boards, roundAt: T });
  const best = visibleBoardRows(boards).find((r) => r.repo === 'x/y');
  assert.equal(v.rows.length, 1);
  assert.deepEqual(
    { stars: v.rows[0].stars, desc: v.rows[0].desc, lang: v.rows[0].lang },
    { stars: best.stars, desc: best.desc, lang: best.lang },
    '视图给出的读数与 visibleBoardRows 出品逐字相同（它没赢就是这里漂了）',
  );
});

check('回落行（这一轮不在任何榜）的读数给 null/空串，不硬造：本地就没有这一格', () => {
  const v = starsView({ seenRows: [seen('gone/away', { stars: undefined })], boards: boardsOf({}), roundAt: T });
  const [r] = v.rows;
  assert.equal(r.stars, null);
  assert.equal(r.desc, '');
  assert.equal(r.lang, '');
  assert.equal(r.name, 'gone/away', '显示名退回观测史里最后一次看到的那一份');
});

/* ---------------- added：只吃日榜 ---------------- */
check('★ added 只吃日榜：在周/月而不在日的行给 null（另一个周期的"新增"不许混进同一列）', () => {
  const v = starsView({
    seenRows: [seen('w/only'), seen('d/only')],
    boards: boardsOf({ weekly: [row('w/only', 1, { added: 800 })], daily: [row('d/only', 1, { added: 7 })] }),
    roundAt: T,
  });
  const by = Object.fromEntries(v.rows.map((r) => [r.repo, r]));
  assert.equal(by['w/only'].added, null, '周榜那条的 800 是**本周**新增，不是今日新增');
  assert.equal(by['d/only'].added, 7);
});

check('「今天没涨」（0）与「这一轮它不在日榜」（null）是两件事：0 不许被写成 null，null 不许被写成 0', () => {
  const v = starsView({
    seenRows: [seen('flat/today'), seen('not/on/daily')],
    boards: boardsOf({ daily: [row('flat/today', 1, { added: 0 })], monthly: [row('not/on/daily', 1)] }),
    roundAt: T,
  });
  const by = Object.fromEntries(v.rows.map((r) => [r.repo, r]));
  assert.equal(by['flat/today'].added, 0);
  assert.equal(by['not/on/daily'].added, null);
});

/* ---------------- 三档归属 ---------------- */
check('常客档：roundsTotal >= STARS_REGULAR_ROUNDS 且这一轮在榜', () => {
  const v = starsView({
    seenRows: [seen('a/b', { roundsTotal: STARS_REGULAR_ROUNDS })],
    boards: boardsOf({ daily: [row('a/b', 1)] }), roundAt: T,
  });
  assert.equal(v.rows[0].group, 'regular');
});

check('新星档：roundsTotal <= STARS_RISING_ROUNDS 且这一轮在榜（含 roundsTotal=0 的首见行）', () => {
  const v = starsView({
    seenRows: [seen('a/b', { roundsTotal: STARS_RISING_ROUNDS }), seen('c/d', { roundsTotal: 0 })],
    boards: boardsOf({ daily: [row('a/b', 1), row('c/d', 2)] }), roundAt: T,
  });
  const by = Object.fromEntries(v.rows.map((r) => [r.repo, r]));
  assert.equal(by['a/b'].group, 'rising');
  assert.equal(by['c/d'].group, 'rising', '观测史上第一次见到的行归新星，不另开一档');
});

check('回落档：窗口内上过、但这一轮不在任何一张榜 ⇒ cooling（哪怕它轮数够常客 —— 掉榜这件事信息量更大）', () => {
  const v = starsView({
    seenRows: [seen('old/boy', { roundsTotal: 9 }), seen('new/gone', { roundsTotal: 1 })],
    boards: boardsOf({}), roundAt: T,
  });
  assert.deepEqual(v.rows.map((r) => r.group), ['cooling', 'cooling']);
});

check('档位归属只给一个值（三档不必互斥，但每行一个 group；「全部」兜住归属意外）', () => {
  const v = starsView({ seenRows: [seen('a/b', { roundsTotal: 4 })], boards: boardsOf({ daily: [row('a/b', 1)] }), roundAt: T });
  assert.ok(STARS_COL_ROUNDS_PEAK && ['regular', 'rising', 'cooling'].includes(v.rows[0].group));
});

/* ---------------- 截断在宿主 ---------------- */
check('★ 截断在宿主做：超过 STARS_ROWS_MAX 时先按累计轮数、同轮按星数截，界面拿到的就是截好的', () => {
  const deep = Array.from({ length: STARS_ROWS_MAX + 5 }, (_, i) => seen(`d/e${String(i).padStart(3, '0')}`, { roundsTotal: 4 }));
  const shallow = [seen('z/late', { roundsTotal: 1 })];
  const v = starsView({ seenRows: [...deep, ...shallow], boards: boardsOf({}), roundAt: T });
  assert.equal(v.rows.length, STARS_ROWS_MAX, '载荷里的行数不能超过那一格');
  assert.ok(v.rows.every((r) => r.rounds === 4), '被截掉的必须是轮数最浅的那批（浅的那批进不来）');
  assert.equal(v.rows.find((r) => r.repo === 'z/late'), undefined);
});

check('载荷恒按星数降序预先排好（界面分段器改了只在已到手的那批里重排，不发请求）', () => {
  const v = starsView({
    seenRows: [seen('a/a'), seen('b/b'), seen('c/c')],
    boards: boardsOf({ daily: [row('a/a', 1, { stars: 100 }), row('b/b', 2, { stars: 900 }), row('c/c', 3, { stars: 500 })] }),
    roundAt: T,
  });
  assert.deepEqual(v.rows.map((r) => r.stars), [900, 500, 100]);
});

check('null 星数排在有数的那批之后（回落行不占首屏）', () => {
  const v = starsView({ seenRows: [seen('gone/one'), seen('on/board')], boards: boardsOf({ daily: [row('on/board', 1, { stars: 1 })] }), roundAt: T });
  assert.deepEqual(v.rows.map((r) => r.repo), ['on/board', 'gone/one']);
});

/* ---------------- 宿主拼好的那几句 ---------------- */
check('★ 三句人话全部现算自 domain：用例里不出现任何手抄中文句子', () => {
  const v = starsView({ seenRows: [seen('a/b')], boards: boardsOf({ daily: [row('a/b', 1)] }), roundAt: T });
  assert.equal(v.headline, starsHeadline({ windowMs: STARS_WINDOW_MS, count: 1 }));
  assert.equal(v.allStars.note, STARS_ALL_STARS_NOTE);
  assert.equal(v.allStars.statLine, STARS_QUOTA_OFF_NOTE);
  assert.equal(v.starsAddedLabel, STARS_COL_STARS_ADDED);
  assert.equal(v.roundsPeakLabel, STARS_COL_ROUNDS_PEAK);
  assert.equal(v.starsLabel, STARS_COL_STARS);
  assert.equal(v.missingCell, STARS_MISSING_CELL);
  assert.deepEqual(v.sorts, starsSortsOf());
});

check('证据深度够 ⇒ thin:false + thinNote 空串（键恒在，客户端不猜）', () => {
  const v = starsView({ seenRows: [seen('a/b', { roundsTotal: STARS_MIN_ROUNDS })], boards: boardsOf({ daily: [row('a/b', 1)] }), roundAt: T });
  assert.equal(v.roundsAvailable, STARS_MIN_ROUNDS);
  assert.equal(v.thin, false);
  assert.equal(v.thinNote, '');
});

check('薄快照 ⇒ thin:true + 那句原料现算的话（那一列整列置灰的理由要说在屏上）', () => {
  const v = starsView({ seenRows: [seen('a/b', { roundsTotal: 2 })], boards: boardsOf({ daily: [row('a/b', 1)] }), roundAt: T });
  assert.equal(v.roundsAvailable, 2, 'roundsAvailable = 盘上的证据深度 = max(roundsTotal)，不是"跑过几轮检查"');
  assert.equal(v.thin, true);
  assert.equal(v.thinNote, starsThinNote({ roundsAvailable: 2, minRounds: STARS_MIN_ROUNDS }));
});

check('roundsAvailable 取候选里最深那位：回落行（本轮不在榜）也参与证据深度读数', () => {
  const v = starsView({
    seenRows: [seen('deep/history', { roundsTotal: 8 }), seen('a/b', { roundsTotal: 1 })],
    boards: boardsOf({ daily: [row('a/b', 1)] }), roundAt: T,
  });
  assert.equal(v.roundsAvailable, 8);
  assert.equal(v.thin, false);
});

/* ---------------- 能力边界①：无存储 ---------------- */
check('★ 无存储：rows 给空数组、headline 换成「本地存储不可用」那一句（不是空表那句「还没跑过第一轮检查」）', () => {
  const v = starsView({ seenRows: [], boards: boardsOf({}), roundAt: T, storageAvailable: false });
  assert.deepEqual(v.rows, []);
  assert.equal(v.headline, STARS_NO_STORE_NOTE);
  assert.equal(v.thin, false, '没有行可置灰时不该再叠一句"轮数不够"（真因是存储不可用，那句已经写在 headline 里）');
  assert.equal(v.allStars.statLine, STARS_QUOTA_OFF_NOTE);
  assert.deepEqual(v.views, starsViewsOf(false), '分段器那份照常给（形状不随数据变）');
});

/* ---------------- 全站高星那一档 ---------------- */
check('分段器 disabled 跟着 prefs.allStarsEnabled，★ 而载荷里不重复给一位同样的布尔（一个值不许有两处出口）', () => {
  const off = starsView({ seenRows: [], boards: boardsOf({}), roundAt: T, prefs: { allStarsEnabled: false } });
  const on = starsView({ seenRows: [], boards: boardsOf({}), roundAt: T, prefs: { allStarsEnabled: true } });
  assert.equal(off.views.at(-1).disabled, true);
  assert.equal(on.views.at(-1).disabled, false);
  assert.equal(JSON.stringify(off.views) === JSON.stringify(on.views), false);
  assert.equal('allStarsEnabled' in on.allStars, false, 'starsView.allStars 里不许再搬一份开关');
  assert.equal('allStarsEnabled' in on, false);
});

check('开着时那句额度**全吃落库那一发的读数**（x-ratelimit-* 三格 + 上次取回时刻），一个数都不自己承诺', () => {
  const batch = {
    at: T, ok: true, rows: [{ rank: 1, repo: 'a/b', name: 'A/B', desc: 'd', lang: 'Go', stars: 120000 }],
    rateLeft: 8, rateLimit: 10, rateResetAt: T + 60000, rateAuthed: true,
  };
  const v = starsView({ seenRows: [], boards: boardsOf({}), roundAt: T, prefs: { allStarsEnabled: true }, search: batch });
  assert.equal(v.allStars.statLine, starsQuotaLine({ at: T, left: 8, limit: 10, resetAt: T + 60000, authed: true }));
  assert.equal(v.allStars.rows.length, 1);
});

check('坏轮冻结：search 那一行 ok=false 但 rows 停在上一批 ⇒ 那一档照常念上一批', () => {
  const v = starsView({
    seenRows: [], boards: boardsOf({}), roundAt: T, prefs: { allStarsEnabled: true },
    search: { at: T - DAY, ok: false, error: '连不上', transport: true, rows: [{ rank: 1, repo: 'old/batch', name: 'Old/Batch', stars: 100001 }] },
  });
  assert.deepEqual(v.allStars.rows.map((r) => r.repo), ['old/batch']);
});

check('故障那三格与三榜同形状（hasData / ok / error / transport）：界面只念那一份原样回执，不自己判坏在哪一轮', () => {
  const bad = starsView({
    seenRows: [], boards: boardsOf({}), roundAt: T, prefs: { allStarsEnabled: true },
    search: { at: T - DAY, lastFetchAt: T, ok: false, error: '限额用尽（403，重置于 2026/10/9 04:38:14）', transport: false, rows: [] },
  });
  assert.equal(bad.allStars.hasData, true, '落过库（哪怕这一轮坏了）');
  assert.equal(bad.allStars.ok, false);
  assert.equal(bad.allStars.error, '限额用尽（403，重置于 2026/10/9 04:38:14）', '原样回执，一字不改（与 all-stars 落库那一份同源）');
  assert.equal(bad.allStars.transport, false);
  assert.equal(bad.allStars.statLine, starsQuotaLine({ at: T - DAY }), '额度那句仍念上一次**成功**的读数，不被坏轮冲掉');

  const good = starsView({
    seenRows: [], boards: boardsOf({}), roundAt: T, prefs: { allStarsEnabled: true },
    search: { at: T, ok: true, error: '', transport: false, rows: [{ rank: 1, repo: 'a/b', name: 'A/B', stars: 120000 }] },
  });
  assert.equal(good.allStars.error, '', '成功轮不许留上一轮的故障句');
  assert.equal(good.allStars.transport, false);
  assert.equal(good.allStars.ok, true);

  const none = starsView({ seenRows: [], boards: boardsOf({}), roundAt: T, prefs: { allStarsEnabled: true } });
  assert.equal(none.allStars.hasData, false, '「从没落库」与「落过但坏了」是两件事，靠 hasData 分');
  assert.equal(none.allStars.ok, false);
  assert.equal(none.allStars.error, '', '没落过库就没有故障可念（不许凭空给一句"坏了"）');
  assert.equal(none.allStars.statLine, STARS_QUOTA_WAITING_NOTE, '开着但从没取回过 ⇒ 念那句"开启当口立刻发一发"，不是空串');
});

check('★ 那一档那两句成品自己念得出新口径（10-09 改判「开启的时候默认拉取一次」）：句子改了、判据就得红', () => {
  // 判的是**事实**而不是字面：改措辞随便，把"点开会立刻花一发"或"之后仍按检查轮节流"这两件事从句子里删掉 ⇒ 这一条红。
  // （等值断言只会跟着常量一起漂，拿不到失败信号 —— 见项目记忆「断言有牙要用隔离变异」。）
  for (const [name, s] of [['STARS_ALL_STARS_NOTE', STARS_ALL_STARS_NOTE], ['STARS_QUOTA_WAITING_NOTE', STARS_QUOTA_WAITING_NOTE]]) {
    assert.ok(s.includes('点「开」的那一刻'), `${name} 没念"点「开」的那一刻"那一发 ⇒ 用户还会以为要等下一轮检查（出厂 60 分钟）`);
    assert.ok(s.includes('每轮检查后'), `${name} 没念"每轮检查后"那一路 ⇒ 开启即拉被念成了"只发这一次"，检查轮那一路就没人说了`);
  }
  assert.ok(STARS_ALL_STARS_NOTE.includes('不补发、不重试'),
    '说明句丢了节流口径 ⇒ 屏上看不出这一档会按轮重复花配额（匿名 search 一小时才 10 发）');
  // ★ 10-09 第二条裁定「上次间隔时间范围内已经拉取过就不要拉取」也得有出口：那一趟**可能一发都不派**，
  //   说明句若只讲"点开发那一发"，用户会以为每一次开启都花配额（而屏上那一批本来就是刚取回来的）。
  assert.ok(STARS_ALL_STARS_NOTE.includes('检查间隔之内已经成功取回过时不重发'),
    '说明句没念"间隔之内不重发"这一档 ⇒ 那句出网承诺说大话（把"当场决定发不发"念成"当场必发"）');
});

check('search 从没落库 ⇒ allStars.rows 给空数组而不是 undefined（键恒在，客户端不猜）', () => {
  const v = starsView({ seenRows: [], boards: boardsOf({}), roundAt: T });
  assert.deepEqual(v.allStars.rows, []);
  assert.equal(Array.isArray(v.allStars.rows), true);
  assert.deepEqual(Object.keys(v.allStars).sort(),
    ['error', 'hasData', 'note', 'ok', 'rows', 'statLine', 'transport'],
    '那一档的键表恒在：界面说得出的一句话都必须有出口（缺出口就得让客户端自己判档）');
});

check('search 行形状只认 domain 那几格：回包多带的字段不进载荷', () => {
  const v = starsView({
    seenRows: [], boards: boardsOf({}), roundAt: T, prefs: { allStarsEnabled: true },
    search: { at: T, ok: true, rows: [{ rank: 1, repo: 'a/b', name: 'A/B', desc: 'd', lang: 'Go', stars: 5, owner: { login: 'a' }, score: 999 }] },
  });
  assert.deepEqual(Object.keys(v.allStars.rows[0]).sort(), ['desc', 'lang', 'name', 'rank', 'repo', 'stars']);
});

/* ---------------- 纯函数律 ---------------- */
check('★ lib/stars.js 里没有任何 IO 形状：不发请求、不读库、不写库、不 await（读路径恒零发）', () => {
  // 扫的是**代码**不是注释：本文件的注释里点名过那些仓储门面（讲清原料由谁喂），把它们算进违规就等于不写注释。
  const raw = readFileSync(fileURLToPath(new URL('../lib/stars.js', import.meta.url)), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['fetch(', 'globalThis.fetch', 'await ', 'async ', 'Date.now', 'Math.random']) {
    assert.equal(code.includes(banned), false, `纯视图里出现了「${banned}」：这一屏的原料只能由调用端喂`);
  }
  assert.equal(/\b\w*Store\b/.test(code), false, '视图不认识任何仓储门面（认了就等于它自己去读库）');
  assert.equal(code.includes('import'), true, '至少要 import domain 那份句子 —— 自己写中文就成第二份真相');
});

check('视图不吃 fetchedAt 之外的时钟：窗口判据只认传进来的 roundAt', () => {
  const seenOld = seen('a/b', { lastAt: 1_000 });
  // roundAt 也拨到 1_000 附近 ⇒ 相对窗口成立，与"现在几点"无关
  const v = starsView({ seenRows: [seenOld], boards: boardsOf({}, 1_000), roundAt: 1_000 + STARS_WINDOW_MS / 2 });
  assert.equal(v.rows.length, 1);
});

await runAll('stars');
