/**
 * test/favs.test.mjs —— 「收藏」那一屏的纯视图（lib/favs.js，第三十二轮，spec §8.15）。
 *
 * 这一屏最像"界面自己数一下就有"的地方只有两处，所以判据全钉在那两处（外加一条装配律）：
 *  · **「这一轮」那一格**：命中判据 = 收藏键与**屏上那些行**比一次，优先级 日 > 周 > 月 > 明星、**单值**（§8.15 ⑥）；
 *    比键前把榜行的 `renamedFrom` 一起铺进去 —— 改名后不归一会把"明明在榜"念成「未上榜」，误念比缺念更糟；
 *  · **快照不刷新**：`stars` / `desc` / `lang` 恒是库里那一行收藏那一刻的值，本函数一个字都不与榜上的新读数合并（③）；
 *  · **零出网**：这一屏的原料只能由调用端喂进来，视图里不许出现 fetch / await / 仓储门面（末条扫源码）。
 * ★ 第三十三轮（§8.16）多出来的那条：行上第 11 格 `descZh` 是**喂进来**的那一份中文，视图逐字搬、
 *   不覆盖 `desc`、也不再判一遍命中（命中判据只在 `lib/board-zh.js` 的 `descZhHits` 一处）。
 * ⚠️ 这一格**不写回库里那一行**：`onBoard` 每帧现算；写回去就是第三份星数之外的第三份榜况（有一条判据专门钉它）。
 */
import { check, runAll, assert } from './_helpers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { favView } from '../lib/favs.js';
import {
  BOARDS, BOARD_LABELS,
  FAV_SORTS, FAV_DEFAULT_SORT, FAV_ON_BOARD_LABELS, FAV_ON_BOARD_PRIORITY, FAV_OFF_BOARD_CELL,
  FAV_STAMP_LABELS, FAV_COL_STARS, FAV_COL_ON_BOARD, FAV_NOTE, FAV_EMPTY_NOTE, FAV_NO_STORE_NOTE,
  FAV_FROM_STARS, FAV_FROM_DETAIL, FAV_FROM_SOURCES, favFromCell, STARS_MISSING_CELL,
} from '../lib/domain.js';

const T = 1_760_000_000_000;
const DAY = 24 * 3600 * 1000;
/** 三榜夹具：只填说到的那几张，其余给空行（视图读的是 `boards[b].rows` 那一批"屏上看得见的行"）。 */
const boardsOf = (map = {}) => Object.fromEntries(BOARDS.map((b) => [b, { rows: map[b] ?? [] }]));
const boardRow = (repo, over = {}) => ({ repo, name: over.name || repo, stars: 1000, ...over });
/** 收藏表里那一行（`favStore.list()` 的返回形状：八格按 `favRecord` 那套名字）。 */
const fav = (repo, over = {}) => ({
  repo, name: over.name || repo, desc: 'd', lang: 'Go', langColor: '#00add8',
  stars: 1000, addedAt: T, from: BOARD_LABELS.daily, ...over,
});

/* ---------------- 行与序 ---------------- */
check('★ 行序恒由宿主给那一种：addedAt 倒序（新收的在最上），同刻按主键字典序收尾', () => {
  const v = favView({
    favRows: [
      fav('b/old', { addedAt: T - 10 * DAY }),
      fav('a/new', { addedAt: T }),
      fav('c/same', { addedAt: T - DAY }),
    ],
    boards: boardsOf(),
  });
  assert.deepEqual(v.rows.map((r) => r.repo), ['a/new', 'c/same', 'b/old']);
});

check('同刻那一发必须按主键收尾：顺序不确定的话同一份库存会渲染出两种序（用例只喂三行两刻）', () => {
  const v = favView({
    favRows: [fav('z/last', { addedAt: T }), fav('a/first', { addedAt: T }), fav('m/mid', { addedAt: T })],
    boards: boardsOf(),
  });
  assert.deepEqual(v.rows.map((r) => r.repo), ['a/first', 'm/mid', 'z/last'],
    '三行同一时刻 ⇒ 只许按 repo 字典序，谁先谁后不能取决于 Map 的插入序');
});

check('键归一：库里存的是 `Vitejs/Vite`，视图出来的 repo 恒小写（两枚 ★ 各亮各的根源就在这格）', () => {
  const v = favView({ favRows: [fav('Vitejs/Vite')], boards: boardsOf({ daily: [boardRow('vitejs/vite')] }) });
  assert.equal(v.rows[0].repo, 'vitejs/vite');
  assert.equal(v.rows[0].onBoard, FAV_ON_BOARD_LABELS.daily, '大小写不一致时那一格会念「未上榜」—— 归一是命中判据的前提');
});

check('脏行不进视图：repo 缺失 / 空串 / 非字符串的行被滤掉（库里一行坏的带走整屏就是事故）', () => {
  const v = favView({
    favRows: [null, { repo: '' }, { repo: '   ' }, { noRepo: 1 }, 'a-string', fav('good/one')],
    boards: boardsOf(),
  });
  assert.deepEqual(v.rows.map((r) => r.repo), ['good/one']);
  assert.equal(v.count, 1, '计数与行数是同一份出处（两处各数一遍就会在某一帧漂）');
});

check('favRows 给 Map 也吃得下（装配侧两路：store.list() 是数组，缓存一份可能是 Map）', () => {
  const v = favView({ favRows: new Map([['a/b', fav('a/b')], ['c/d', fav('c/d', { addedAt: T + 1 })]]), boards: boardsOf() });
  assert.deepEqual(v.rows.map((r) => r.repo), ['c/d', 'a/b']);
});

/* ---------------- 「这一轮」那一格 ---------------- */
check('★ 命中优先级 日 > 周 > 月 > 明星，且载荷那一格是单值：同时在四屏只念第一个', () => {
  const all = [boardRow('x/y')];
  const v = favView({
    favRows: [fav('x/y')],
    boards: boardsOf({ daily: all, weekly: all, monthly: all }),
    starsRows: all,
  });
  assert.equal(v.rows[0].onBoard, FAV_ON_BOARD_LABELS.daily, '四屏都命中时念「在日榜」—— 不是拼成四个词');
  assert.equal(typeof v.rows[0].onBoard, 'string');
  assert.equal(v.rows[0].onBoard.includes(FAV_ON_BOARD_LABELS.weekly), false, '单值：不许出现「在日榜在周榜」这种拼接');
  assert.deepEqual(FAV_ON_BOARD_PRIORITY, ['daily', 'weekly', 'monthly', 'stars'], '★ 前提：优先级那份名单就是这四档');
});

check('优先级按档退：不在日榜念周榜，三榜都不在才念明星', () => {
  const row = boardRow('x/y');
  assert.equal(favView({ favRows: [fav('x/y')], boards: boardsOf({ weekly: [row] }) }).rows[0].onBoard, FAV_ON_BOARD_LABELS.weekly);
  assert.equal(favView({ favRows: [fav('x/y')], boards: boardsOf({ monthly: [row] }) }).rows[0].onBoard, FAV_ON_BOARD_LABELS.monthly);
  assert.equal(favView({ favRows: [fav('x/y')], boards: boardsOf(), starsRows: [row] }).rows[0].onBoard, FAV_ON_BOARD_LABELS.stars);
});

check('明星那一屏的两批行都算命中：本地榜史那一批 + 「全站高星」那一批（同一屏的两个来源）', () => {
  const fromSeen = favView({ favRows: [fav('a/b')], boards: boardsOf(), starsRows: [boardRow('a/b')] });
  const fromAll = favView({ favRows: [fav('c/d')], boards: boardsOf(), allStarsRows: [boardRow('c/d')] });
  assert.equal(fromSeen.rows[0].onBoard, FAV_ON_BOARD_LABELS.stars);
  assert.equal(fromAll.rows[0].onBoard, FAV_ON_BOARD_LABELS.stars, '漏掉那一批的话，用户在那一屏收的仓库会念「未上榜」');
});

check('★ 改名归一（§8.15 ⑥ 那条已收的默认）：收藏的是旧键、榜上那行是 `renamedFrom` 旧键 ⇒ 念「在日榜」不是「未上榜」', () => {
  const v = favView({
    favRows: [fav('debpalash/voicestudio')],
    boards: boardsOf({ daily: [boardRow('rMspeteer/debpalash-VoiceStudio', { renamedFrom: 'debpalash/VoiceStudio' })] }),
  });
  assert.equal(v.rows[0].onBoard, FAV_ON_BOARD_LABELS.daily, '误念比缺念更糟：真机原型里就这一条');
});

check('未命中念那一句成品（`FAV_OFF_BOARD_CELL`），且界面上那一格是置灰档 ⇒ 视图只给句子不给位', () => {
  const v = favView({ favRows: [fav('nobody/here')], boards: boardsOf() });
  assert.equal(v.rows[0].onBoard, FAV_OFF_BOARD_CELL);
  assert.equal('onBoardGray' in v.rows[0], false, '不给第二个位：那一格灰不灰由客户端拿句子比（一处真相）');
});

check('★ 命中判据只看 `boards[b].rows` 那一批（切片后的行）：屏上看不见的那第 30 行不算"在榜"', () => {
  const v = favView({
    // 夹具把 rowsTotal 那类整表读数塞进行对象也无效：视图只认 rows 这一个口子
    favRows: [fav('off/screen')],
    boards: { daily: { rows: [boardRow('a/one')], rowsTotal: 25, allRows: [boardRow('off/screen')] }, weekly: { rows: [] }, monthly: { rows: [] } },
  });
  assert.equal(v.rows[0].onBoard, FAV_OFF_BOARD_CELL,
    '拿整表去比会把"不在屏上"念成"在榜"—— 那一列问的是"这一轮它有没有出现在你看得见的地方"');
});

check('★ onBoard 绝不写回库里那一行：视图给的是一份新对象，输入那几行原样不动（写回去就是第三份榜况）', () => {
  const input = [fav('x/y', { stars: 1000 })];
  const snapshotOfInput = JSON.stringify(input);
  const v = favView({ favRows: input, boards: boardsOf({ daily: [boardRow('x/y', { stars: 9999 })] }) });
  assert.equal(JSON.stringify(input), snapshotOfInput, '输入行被就地改了 ⇒ 装配侧下一帧读到的是视图算出来的值');
  assert.equal(v.rows[0].stars, 1000, '★ 快照不刷新：榜上那颗 9999 星一个字都不许并进这一行（§8.15 ③ 那条承重裁定）');
  assert.equal(v.rows[0].onBoard, FAV_ON_BOARD_LABELS.daily, '「这一轮」照算，但它只活在视图这一份对象上');
});

/* ---------------- 第 11 格：本机已有的那一份中文（第三十三轮 §8.16 ②） ---------------- */
check('★ 第 11 格 `descZh` 是调用端喂进来的那一份、逐字搬：而 `desc` 恒不被中文覆盖（§8.16 ② 那条"快照在载荷上肉眼可验"）', () => {
  const hit = { zh: 'SENTINEL-中文', via: 'live', label: 'SENTINEL-落款', note: 'SENTINEL-说明', src: 'an original line' };
  const v = favView({
    favRows: [fav('a/b', { desc: 'an original line' }), fav('c/d', { desc: 'another line' })],
    boards: boardsOf(),
    descHits: { 'a/b': hit },
  });
  const [ab, cd] = v.rows;
  assert.deepEqual(ab.descZh, hit, '五个键一个都不许改、也不许现拼：label / note 是悬停那两行的唯一出处');
  assert.equal(ab.desc, 'an original line', '★ 中文一覆盖原文，"这一屏不刷新"就只剩注释能证明了；悬停那句也就再看不见原文');
  assert.strictEqual(cd.descZh, null, '没喂的那一行给 null（不是 undefined）：载荷的键不许随数据变');
  assert.equal(Object.keys(ab).length, 11, '第 11 格长在**载荷**上，库里那一行仍是八格（§4 那张表没改口）');
  // 键集合与"喂没喂"无关：装配侧少喂一格，客户端看见的形状就变了（那是第二类假绿）
  assert.deepEqual(Object.keys(cd).sort(), Object.keys(ab).sort(), '同一帧里两行的键必须同形');
});

check('★ 比键用的是同一把归一：库里那行写 `A/B`、hits 的键是宿主归一后的小写 ⇒ 照样命中（视图再归一一遍就是第二把尺）', () => {
  const v = favView({
    favRows: [fav('A/B')],
    boards: boardsOf(),
    descHits: { 'a/b': { zh: '那一份中文', via: 'builtin', label: 'l', note: 'n', src: 's' } },
  });
  assert.equal(v.rows[0].repo, 'a/b', '前提：视图那一格恒小写');
  assert.equal(v.rows[0].descZh.zh, '那一份中文');
  const miss = favView({ favRows: [fav('a/b')], boards: boardsOf(), descHits: { 'A/B': { zh: '没归一的键' } } });
  assert.equal(miss.rows[0].descZh, null, 'hits 的键没归一时不命中 ⇒ 这一格不替装配侧兜第二遍归一（那是 `descZhHits` 的活，那里恒给小写键）');
});

check('脏 hits 不给半个对象：`descHits` 缺位 / 空 map / 那一格是假值 ⇒ 一律 null（界面分得开"没中文"与"一只有字的空泡"）', () => {
  const one = (descHits) => favView({ favRows: [fav('a/b')], boards: boardsOf(), descHits }).rows[0].descZh;
  for (const bad of [undefined, null, {}, [], 'x', 0, { 'a/b': null }, { 'a/b': undefined }, { 'a/b': '' }, { 'a/b': 0 }]) {
    assert.equal(one(bad), null, `${JSON.stringify(bad)} 那一形给不出中文，也不许挂个 truthy 的空壳上去`);
  }
  // ★ 视图不重复那道命中闸（与上面「越界的 from 照样原样搬」同一条律）：`zh` 空串那种 hits 是装配侧的 bug，
  //   这里照搬 —— 界面上那一格走的是「中文 → 原文 → 缺位符」那一条链（`descCell`），空串自己会退回原文。
  assert.deepEqual(one({ 'a/b': { zh: '', via: 'live' } }), { zh: '', via: 'live' }, '视图不判档：判第二遍就是第二份命中判据');
});

check('★ 卡脚那一句本轮说得清"屏上的中文是从哪来的"（§8.16 的改口）：四件事缺一条就是假话', () => {
  // 这一条为什么要有：本轮的起因就是"卡脚说的话与屏上摆的东西对不上"。`note === FAV_NOTE` 那种断言
  // 只钉得住"整句搬运"，钉不住句子**说什么** —— 句子被改回上一轮那一版（只讲快照、不讲那一份中文从哪来）时它照样绿。
  const claims = [
    ['这一屏不刷新读数', /快照/],
    ['一发都不出网', /一发都不出网/],
    ['中文用的是本机已有的那一份', /本机已有/],
    ['用的是哪两种来源（内置预译 / 已付过额度的现译）', /内置预译[\s\S]*现译/],
    ['逐字对得上才用（原文变了就退回原文）', /逐字/],
    ['不为这一屏新派翻译（裁定 A：零新增额度）', /不为这一屏新派/],
  ];
  for (const [what, re] of claims) assert.ok(re.test(FAV_NOTE), `那句少了「${what}」这一件事 ⇒ 屏上有中文而卡脚说没有，说的与摆的互相拆台`);
});

/* ---------------- 出处那一句 ---------------- */
check('★ `fromCell` 是宿主拼好的整句：客户端把「来自」和一个榜名接起来就是第二份榜名（§8 一份真相）', () => {
  const v = favView({ favRows: [fav('a/b', { from: BOARD_LABELS.weekly })], boards: boardsOf() });
  assert.equal(v.rows[0].fromCell, favFromCell(BOARD_LABELS.weekly));
  assert.equal(v.rows[0].fromCell, `来自 ${BOARD_LABELS.weekly}`);
  assert.equal(v.rows[0].from, BOARD_LABELS.weekly, '同时保留那一个词：出处那格仍是原料，整句是成品，两格各管一件事');
});

check('出处为空 ⇒ fromCell 给空串（界面整枚不摆，不自造「来自 —」这种缺位符）', () => {
  for (const from of ['', '   ', undefined, null]) {
    assert.equal(favFromCell(from), '', `${JSON.stringify(from)} 那一档不该拼出句子`);
  }
  const v = favView({ favRows: [fav('a/b', { from: undefined })], boards: boardsOf() });
  assert.equal(v.rows[0].fromCell, '');
  assert.equal(v.rows[0].from, '', '缺位给空串而不是 "undefined" —— 客户端搬进 tag 就是屏上一个词');
});

check('五档出处都能拼成句（前三档由 BOARDS + BOARD_LABELS 派生，后两档是明星与详情）', () => {
  assert.deepEqual(FAV_FROM_SOURCES, [...BOARDS.map((b) => BOARD_LABELS[b]), FAV_FROM_STARS, FAV_FROM_DETAIL]);
  for (const one of FAV_FROM_SOURCES) assert.equal(favFromCell(one), `来自 ${one}`);
});

/* ---------------- 读数与缺位 ---------------- */
check('读数缺位给 null 不是 0：`0` 是"那一刻真的是 0 星"，null 是"那一刻没有这一格"（界面念 —）', () => {
  const v = favView({ favRows: [fav('a/b', { stars: undefined }), fav('c/d', { stars: 0 })], boards: boardsOf() });
  const byRepo = Object.fromEntries(v.rows.map((r) => [r.repo, r]));
  assert.equal(byRepo['a/b'].stars, null);
  assert.equal(byRepo['c/d'].stars, 0, '0 不许被读成 null（客户端会把"真的 0 星"念成 —）');
});

check('addedAt 非法归 0（排在最下但不丢行）；星数带小数按截断收（库存的是那一刻的读数，不是算出来的）', () => {
  const v = favView({ favRows: [fav('bad/at', { addedAt: 'x' }), fav('ok/at', { addedAt: T })], boards: boardsOf() });
  assert.deepEqual(v.rows.map((r) => r.repo), ['ok/at', 'bad/at']);
  assert.equal(v.rows[0].addedAt, T);
  assert.equal(favView({ favRows: [fav('a/b', { stars: 1234.9 })], boards: boardsOf() }).rows[0].stars, 1234);
});

check('name 缺位回落主键（那一行在屏上不能没有名字），desc / lang 缺位给空串（缺位符由视图给，客户端不自己写 —）', () => {
  const v = favView({ favRows: [{ repo: 'A/B', addedAt: T, from: FAV_FROM_DETAIL }], boards: boardsOf() });
  assert.equal(v.rows[0].name, 'a/b');
  assert.equal(v.rows[0].desc, '');
  assert.equal(v.rows[0].lang, '');
  assert.equal(v.rows[0].from, FAV_FROM_DETAIL);
});

/* ---------------- 名单 / 句子 / 存储位 ---------------- */
check('★ 三档排序名单与列名、三句话全部逐字吃 domain：用例里不出现任何手抄中文', () => {
  const v = favView({ favRows: [], boards: boardsOf() });
  assert.deepEqual(v.sortIds, FAV_SORTS);
  assert.deepEqual(v.sorts.map((o) => o.id), FAV_SORTS);
  assert.deepEqual(v.sorts.map((o) => o.id), ['added', 'stars', 'name']);
  assert.equal(v.defaultSort, FAV_DEFAULT_SORT);
  assert.deepEqual(v.cols, { stars: FAV_COL_STARS, onBoard: FAV_COL_ON_BOARD, ...FAV_STAMP_LABELS });
  assert.equal(v.note, FAV_NOTE);
  assert.equal(v.emptyNote, FAV_EMPTY_NOTE);
  assert.equal(v.noStoreNote, FAV_NO_STORE_NOTE);
  assert.equal(v.offBoardCell, FAV_OFF_BOARD_CELL);
  assert.equal(v.missingCell, STARS_MISSING_CELL, '缺位符与明星那一屏同一个出处（两处各写一份必漂）');
});

check('★ available 那一位只看传进来的存储位：没说 = false（"存得下"是好话，说它要拿出依据）', () => {
  for (const bad of [undefined, null, false, 'true', 1]) {
    assert.equal(favView({ favRows: [fav('a/b')], boards: boardsOf(), storageAvailable: bad }).available, false,
      `${JSON.stringify(bad)} 不能当"存得下"—— 那一屏会在存储坏了时念空态那句假话`);
  }
  assert.equal(favView({ favRows: [fav('a/b')], boards: boardsOf() }).available, false,
    '整个参数不传也落 false：给了 `= true` 的默认值就是替调用端撒这句谎');
  assert.equal(favView({ favRows: [], boards: boardsOf(), storageAvailable: true }).available, true);
});

check('★ available=false 与"一行都没收藏"是两件事：行照给、那两句各自独立在载荷里（界面才分得开）', () => {
  const broken = favView({ favRows: [fav('a/b')], boards: boardsOf(), storageAvailable: false });
  assert.equal(broken.available, false);
  assert.equal(broken.rows.length, 1, '视图不替界面清空：读不到那张表是装配侧的事，这里喂进来什么就摆什么');
  assert.notEqual(broken.noStoreNote, broken.emptyNote, '两句必须不同 —— 混成一句就是"存储坏了"被念成"你还没收藏"');
});

check('视图不吃时钟：那一列的相对时间不在这里算（客户端算「3 天前」，词只出 domain 那一格）', () => {
  const v = favView({ favRows: [fav('a/b', { addedAt: 123 })], boards: boardsOf() });
  assert.equal(v.rows[0].addedAt, 123, '原样给回那一刻：视图里出现"距今几天"就等于把时钟搬进宿主侧');
  assert.equal(FAV_STAMP_LABELS.saved, '已收藏', '★ 词那一格是界面拼句用的唯一出处（"3 天前"由浏览器算）');
});

/* ---------------- 纯函数律 ---------------- */
check('★ lib/favs.js 里没有任何 IO 形状：不发请求、不读库、不写库、不 await（这一屏的读路径恒零发）', () => {
  // 扫的是**代码**不是注释：本模块的注释里点名过那些仓储门面（讲清原料由谁喂），把它们算进违规就等于不写注释。
  const raw = readFileSync(fileURLToPath(new URL('../lib/favs.js', import.meta.url)), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['fetch(', 'globalThis.fetch', 'await ', 'async ', 'Date.now', 'Math.random']) {
    assert.equal(code.includes(banned), false, `纯视图里出现了「${banned}」：这一屏的原料只能由调用端喂`);
  }
  assert.equal(/\b\w*Store\b/.test(code), false, '视图不认识任何仓储门面（认了就等于它自己去读库）');
  assert.equal(code.includes('favStore'), false, '同上：连名字都不许出现');
});

check('视图不自己出网判档：入参一个都不改判，越界的 from 照样原样搬（挡脏行是 schema 的活，见 store 那条）', () => {
  const v = favView({ favRows: [fav('a/b', { from: '不在名单里的出处' })], boards: boardsOf() });
  assert.equal(v.rows[0].from, '不在名单里的出处', '视图不重复那道闸：库里存不进 = 界面上不会出现这行');
  assert.equal(v.rows[0].fromCell, `来自 ${'不在名单里的出处'}`);
});

await runAll('favs');
