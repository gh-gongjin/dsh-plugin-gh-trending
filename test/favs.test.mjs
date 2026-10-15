/**
 * test/favs.test.mjs —— 「收藏」那一屏的纯视图（lib/favs.js，第三十二轮，spec §8.15）。
 *
 * 这一屏最像"界面自己数一下就有"的地方只剩一处，所以判据钉在那一处（外加一条装配律）：
 *  · **快照不刷新**：`stars` / `desc` / `lang` 恒是库里那一行收藏那一刻的值，本函数一个字都不与别处的新读数合并（③）；
 *  · **零出网**：这一屏的原料只能由调用端喂进来，视图里不许出现 fetch / await / 仓储门面（末条扫源码）。
 * ★ 第三十三轮（§8.16）多出来的那条：行上 `descZh` 那一格是**喂进来**的那一份中文，视图逐字搬、
 *   不覆盖 `desc`、也不再判一遍命中（命中判据只在 `lib/board-zh.js` 的 `descZhHits` 一处）。
 * ⚠️ 第三十五轮撤掉「这一轮」那一列：视图**不再吃榜面那三行、也不吃明星那两批行**（§8.15 ⑥ 作废），
 *   有一条判据专门钉"旧的原料照喂也长不出那一格" —— 撤一列要连入参一起撤，留着入参就是死接口。
 */
import { check, runAll, assert } from './_helpers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { favView } from '../lib/favs.js';
import {
  BOARDS, BOARD_LABELS,
  FAV_SORTS, FAV_DEFAULT_SORT,
  FAV_STAMP_LABELS, FAV_COL_STARS, FAV_NOTE, FAV_EMPTY_NOTE, FAV_NO_STORE_NOTE,
  FAV_FROM_STARS, FAV_FROM_DETAIL, FAV_FROM_SEARCH, FAV_FROM_SOURCES, favFromCell, STARS_MISSING_CELL,
} from '../lib/domain.js';

const T = 1_760_000_000_000;
const DAY = 24 * 3600 * 1000;
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
  });
  assert.deepEqual(v.rows.map((r) => r.repo), ['a/new', 'c/same', 'b/old']);
});

check('同刻那一发必须按主键收尾：顺序不确定的话同一份库存会渲染出两种序（用例只喂三行两刻）', () => {
  const v = favView({
    favRows: [fav('z/last', { addedAt: T }), fav('a/first', { addedAt: T }), fav('m/mid', { addedAt: T })],
  });
  assert.deepEqual(v.rows.map((r) => r.repo), ['a/first', 'm/mid', 'z/last'],
    '三行同一时刻 ⇒ 只许按 repo 字典序，谁先谁后不能取决于 Map 的插入序');
});

check('键归一：库里存的是 `Vitejs/Vite`，视图出来的 repo 恒小写（两枚 ★ 各亮各的根源就在这格）', () => {
  const v = favView({ favRows: [fav('Vitejs/Vite')] });
  assert.equal(v.rows[0].repo, 'vitejs/vite');
});

check('脏行不进视图：repo 缺失 / 空串 / 非字符串的行被滤掉（库里一行坏的带走整屏就是事故）', () => {
  const v = favView({
    favRows: [null, { repo: '' }, { repo: '   ' }, { noRepo: 1 }, 'a-string', fav('good/one')],
  });
  assert.deepEqual(v.rows.map((r) => r.repo), ['good/one']);
  assert.equal(v.count, 1, '计数与行数是同一份出处（两处各数一遍就会在某一帧漂）');
});

check('favRows 给 Map 也吃得下（装配侧两路：store.list() 是数组，缓存一份可能是 Map）', () => {
  const v = favView({ favRows: new Map([['a/b', fav('a/b')], ['c/d', fav('c/d', { addedAt: T + 1 })]]) });
  assert.deepEqual(v.rows.map((r) => r.repo), ['c/d', 'a/b']);
});

/* ---------------- 第三十五轮：那一列撤干净 ---------------- */
check('★ 撤一列连入参一起撤：旧的三档原料照喂，行与载荷也长不出「这一轮」那一格（留入参就是死接口）', () => {
  const junkRow = { repo: 'a/b', name: 'A/B', stars: 1000, renamedFrom: 'x/y' };
  const v = favView({
    favRows: [fav('a/b')],
    boards: { daily: { rows: [junkRow] }, weekly: { rows: [] }, monthly: { rows: [] } },
    starsRows: [junkRow],
    allStarsRows: [junkRow],
  });
  assert.equal('onBoard' in v.rows[0], false, '行上那一格还在 ⇒ 宿主仍在替界面比一遍榜况（第三份榜况）');
  assert.equal('onBoard' in v.cols, false, '列名表里那一档还在 ⇒ 客户端 `cols.onBoard` 摆出来的就是撤不掉的那一列');
  assert.equal('offBoardCell' in v, false, '那句缺位成品不许再随载荷走（屏上没有用它的那一格）');
  // 扫的是代码：注释里点到那一列的名字不算留码，但标识符一处都不许剩
  const raw = readFileSync(fileURLToPath(new URL('../lib/favs.js', import.meta.url)), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['onBoard', 'ON_BOARD', 'OFF_BOARD', 'keysOf']) {
    assert.equal(code.includes(banned), false, `视图里还留着「${banned}」：那一列的判据没撤干净`);
  }
});

/* ---------------- `descZh` 那一格：本机已有的那一份中文（第三十三轮 §8.16 ②） ---------------- */
check('★ `descZh` 那一格是调用端喂进来的那一份、逐字搬：而 `desc` 恒不被中文覆盖（§8.16 ② 那条"快照在载荷上肉眼可验"）', () => {
  const hit = { zh: 'SENTINEL-中文', via: 'live', label: 'SENTINEL-落款', note: 'SENTINEL-说明', src: 'an original line' };
  const v = favView({
    favRows: [fav('a/b', { desc: 'an original line' }), fav('c/d', { desc: 'another line' })],
    descHits: { 'a/b': hit },
  });
  const [ab, cd] = v.rows;
  assert.deepEqual(ab.descZh, hit, '五个键一个都不许改、也不许现拼：label / note 是悬停那两行的唯一出处');
  assert.equal(ab.desc, 'an original line', '★ 中文一覆盖原文，"这一屏不刷新"就只剩注释能证明了；悬停那句也就再看不见原文');
  assert.strictEqual(cd.descZh, null, '没喂的那一行给 null（不是 undefined）：载荷的键不许随数据变');
  assert.equal(Object.keys(ab).length, 10, '载荷那一行恒十格（第三十五轮撤掉「这一轮」之后），库里那一行仍是八格（§4 那张表没改口）');
  // 键集合与"喂没喂"无关：装配侧少喂一格，客户端看见的形状就变了（那是第二类假绿）
  assert.deepEqual(Object.keys(cd).sort(), Object.keys(ab).sort(), '同一帧里两行的键必须同形');
});

check('★ 比键用的是同一把归一：库里那行写 `A/B`、hits 的键是宿主归一后的小写 ⇒ 照样命中（视图再归一一遍就是第二把尺）', () => {
  const v = favView({
    favRows: [fav('A/B')],
    descHits: { 'a/b': { zh: '那一份中文', via: 'builtin', label: 'l', note: 'n', src: 's' } },
  });
  assert.equal(v.rows[0].repo, 'a/b', '前提：视图那一格恒小写');
  assert.equal(v.rows[0].descZh.zh, '那一份中文');
  const miss = favView({ favRows: [fav('a/b')], descHits: { 'A/B': { zh: '没归一的键' } } });
  assert.equal(miss.rows[0].descZh, null, 'hits 的键没归一时不命中 ⇒ 这一格不替装配侧兜第二遍归一（那是 `descZhHits` 的活，那里恒给小写键）');
});

check('脏 hits 不给半个对象：`descHits` 缺位 / 空 map / 那一格是假值 ⇒ 一律 null（界面分得开"没中文"与"一只有字的空泡"）', () => {
  const one = (descHits) => favView({ favRows: [fav('a/b')], descHits }).rows[0].descZh;
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
  const v = favView({ favRows: [fav('a/b', { from: BOARD_LABELS.weekly })] });
  assert.equal(v.rows[0].fromCell, favFromCell(BOARD_LABELS.weekly));
  assert.equal(v.rows[0].fromCell, `来自 ${BOARD_LABELS.weekly}`);
  assert.equal(v.rows[0].from, BOARD_LABELS.weekly, '同时保留那一个词：出处那格仍是原料，整句是成品，两格各管一件事');
});

check('出处为空 ⇒ fromCell 给空串（界面整枚不摆，不自造「来自 —」这种缺位符）', () => {
  for (const from of ['', '   ', undefined, null]) {
    assert.equal(favFromCell(from), '', `${JSON.stringify(from)} 那一档不该拼出句子`);
  }
  const v = favView({ favRows: [fav('a/b', { from: undefined })] });
  assert.equal(v.rows[0].fromCell, '');
  assert.equal(v.rows[0].from, '', '缺位给空串而不是 "undefined" —— 客户端搬进 tag 就是屏上一个词');
});

check('六档出处都能拼成句（前三档由 BOARDS + BOARD_LABELS 派生，后三档是明星、详情与检索）', () => {
  assert.deepEqual(FAV_FROM_SOURCES, [...BOARDS.map((b) => BOARD_LABELS[b]), FAV_FROM_STARS, FAV_FROM_DETAIL, FAV_FROM_SEARCH]);
  for (const one of FAV_FROM_SOURCES) assert.equal(favFromCell(one), `来自 ${one}`);
});

/* ---------------- 读数与缺位 ---------------- */
check('读数缺位给 null 不是 0：`0` 是"那一刻真的是 0 星"，null 是"那一刻没有这一格"（界面念 —）', () => {
  const v = favView({ favRows: [fav('a/b', { stars: undefined }), fav('c/d', { stars: 0 })] });
  const byRepo = Object.fromEntries(v.rows.map((r) => [r.repo, r]));
  assert.equal(byRepo['a/b'].stars, null);
  assert.equal(byRepo['c/d'].stars, 0, '0 不许被读成 null（客户端会把"真的 0 星"念成 —）');
});

check('addedAt 非法归 0（排在最下但不丢行）；星数带小数按截断收（库存的是那一刻的读数，不是算出来的）', () => {
  const v = favView({ favRows: [fav('bad/at', { addedAt: 'x' }), fav('ok/at', { addedAt: T })] });
  assert.deepEqual(v.rows.map((r) => r.repo), ['ok/at', 'bad/at']);
  assert.equal(v.rows[0].addedAt, T);
  assert.equal(favView({ favRows: [fav('a/b', { stars: 1234.9 })] }).rows[0].stars, 1234);
});

check('name 缺位回落主键（那一行在屏上不能没有名字），desc / lang 缺位给空串（缺位符由视图给，客户端不自己写 —）', () => {
  const v = favView({ favRows: [{ repo: 'A/B', addedAt: T, from: FAV_FROM_DETAIL }] });
  assert.equal(v.rows[0].name, 'a/b');
  assert.equal(v.rows[0].desc, '');
  assert.equal(v.rows[0].lang, '');
  assert.equal(v.rows[0].from, FAV_FROM_DETAIL);
});

/* ---------------- 名单 / 句子 / 存储位 ---------------- */
check('★ 三档排序名单与列名、三句话全部逐字吃 domain：用例里不出现任何手抄中文', () => {
  const v = favView({ favRows: [] });
  assert.deepEqual(v.sortIds, FAV_SORTS);
  assert.deepEqual(v.sorts.map((o) => o.id), FAV_SORTS);
  assert.deepEqual(v.sorts.map((o) => o.id), ['added', 'stars', 'name']);
  assert.equal(v.defaultSort, FAV_DEFAULT_SORT);
  assert.deepEqual(v.cols, { stars: FAV_COL_STARS, ...FAV_STAMP_LABELS });
  assert.equal(v.note, FAV_NOTE);
  assert.equal(v.emptyNote, FAV_EMPTY_NOTE);
  assert.equal(v.noStoreNote, FAV_NO_STORE_NOTE);
  assert.equal(v.missingCell, STARS_MISSING_CELL, '缺位符与明星那一屏同一个出处（两处各写一份必漂）');
});

check('★ available 那一位只看传进来的存储位：没说 = false（"存得下"是好话，说它要拿出依据）', () => {
  for (const bad of [undefined, null, false, 'true', 1]) {
    assert.equal(favView({ favRows: [fav('a/b')], storageAvailable: bad }).available, false,
      `${JSON.stringify(bad)} 不能当"存得下"—— 那一屏会在存储坏了时念空态那句假话`);
  }
  assert.equal(favView({ favRows: [fav('a/b')] }).available, false,
    '整个参数不传也落 false：给了 `= true` 的默认值就是替调用端撒这句谎');
  assert.equal(favView({ favRows: [], storageAvailable: true }).available, true);
});

check('★ available=false 与"一行都没收藏"是两件事：行照给、那两句各自独立在载荷里（界面才分得开）', () => {
  const broken = favView({ favRows: [fav('a/b')], storageAvailable: false });
  assert.equal(broken.available, false);
  assert.equal(broken.rows.length, 1, '视图不替界面清空：读不到那张表是装配侧的事，这里喂进来什么就摆什么');
  assert.notEqual(broken.noStoreNote, broken.emptyNote, '两句必须不同 —— 混成一句就是"存储坏了"被念成"你还没收藏"');
});

check('视图不吃时钟：那一列的相对时间不在这里算（客户端算「3 天前」，词只出 domain 那一格）', () => {
  const v = favView({ favRows: [fav('a/b', { addedAt: 123 })] });
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
  const v = favView({ favRows: [fav('a/b', { from: '不在名单里的出处' })] });
  assert.equal(v.rows[0].from, '不在名单里的出处', '视图不重复那道闸：库里存不进 = 界面上不会出现这行');
  assert.equal(v.rows[0].fromCell, `来自 ${'不在名单里的出处'}`);
});

await runAll('favs');
