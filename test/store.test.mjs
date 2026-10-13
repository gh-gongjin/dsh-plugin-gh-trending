/**
 * test/store.test.mjs —— 仓储层（lib/stores.js + lib/domain.js 的 schema + kv-records-base 的域登记表）。
 *
 * 全部吃 test/_helpers.mjs 的假 storageDomain 设施：**entries() 返回 lazy iterator**（真实宿主同款），
 * 所以这里能钉住「忘了写 [...] 就当场失败」这一类坑，而不是靠人肉 review。
 * 断言的每条"血案口径"都对应 sysops / modelwatch 已踩过的坑，注释里点名。
 */
import { check, runAll, assert, makeFakeFacility } from './_helpers.mjs';
import {
  createStateStore, createEventStore, createSeenStore, createPrefsStore, createRepoCacheStore, createTransStore, createSearchStore, createFavStore, RECORDS_ERROR,
} from '../lib/stores.js';
import { BOARDS, BOARD_LABELS, DEFAULT_PREFS, GHT_DOMAIN, REPO_CACHE_MAX, REPO_ERROR_LABELS, TRANS_MAX, LLM_KINDS, PREF_CRED_FIELDS, SEARCH_ROW_SHAPE,
  // ★ 第三十二轮：收藏那一格的出处是**封闭五档**（前三档由 `BOARD_LABELS` 派生）—— 用例里也不手抄那五个词。
  FAV_FROM_STARS, FAV_FROM_DETAIL, FAV_FROM_SOURCES, FAV_ACTIONS,
} from '../lib/domain.js';

/* ---------------- 造合法行的最小素材 ---------------- */
const boardRow = (over = {}) => ({
  rank: 1, repo: 'tester-army/e2e', name: 'tester-army/E2E',
  stars: 2474, added: 344, forks: 96, lang: 'TypeScript', desc: 'e2e testing', ...over,
});
const stateRow = (board = 'daily', over = {}) => ({
  board, at: 1000, ok: true, error: '', etag: 'W/"abc"',
  bodyChangedAt: 1000, lastFetchAt: 1000, failStreak: 0,
  rows: [boardRow()], prevRows: [{ repo: 'tester-army/e2e', name: 'tester-army/E2E', repoId: 1308631234, rank: 1 }],
  ...over,
});
/** 详情缓存行：字段取自真接口读数（test/fixtures/repo-api.json），形状与 repoCacheRow 出品一致。 */
const repoRow = (over = {}) => ({
  repo: 'tester-army/e2e', name: 'tester-army/E2E', at: 1000, ok: true,
  desc: 'e2e testing', lang: 'TypeScript', stars: 2474, forks: 96, issues: 12,
  topics: ['e2e', 'testing'], license: 'MIT', pushedAt: '2026-10-05T03:46:58Z',
  homepage: 'https://example.com', htmlUrl: 'https://github.com/tester-army/e2e',
  archived: false, isFork: false, readmeSource: 'zh_default', readmePath: 'README',
  readmeExcerpt: '一套企业级 UI 设计语言', readmeChars: 2000, readmeCut: false, zhCjk: 26,
  ...over,
});

/** 译文行：`src` 是折叠过空白的原文（复用判据的一半），`repo` 是小写主键（与详情缓存同一条律）。 */
const transRow = (over = {}) => ({
  repo: 'tester-army/e2e', kind: 'desc', src: 'e2e testing', zh: '端到端测试', at: 1000, chars: 5, ...over,
});

/**
 * 全站高星一行：**逐字抄自真回包夹具** `test/fixtures/repo-search.json` 的第 4 条（`rank` 就是它在 `items` 里的位次）。
 * ★ `name` 留 GitHub 原样的大小写、`repo` 一律小写 —— 这一对差值就是主键律的活靶子，换成全小写的仓库名这行就白抄了。
 */
const searchRow = (over = {}) => ({
  rank: 4, repo: 'freecodecamp/freecodecamp', name: 'freeCodeCamp/freeCodeCamp',
  desc: "freeCodeCamp.org's open-source codebase and curriculum. Learn math, programming, and computer science for free.",
  lang: 'TypeScript', stars: 456734, ...over,
});
/** 一批发出去的 search 行（列名沿用 domain 的 `SEARCH_ROW_SHAPE`，用例里不重抄字段清单）。 */
const searchBatch = (over = {}) => ({
  at: 1000, lastFetchAt: 1000, ok: true, error: '', transport: false,
  rows: [searchRow()], rateLeft: 9, rateLimit: 10, rateResetAt: 4000, rateAuthed: false, ...over,
});

/**
 * 收藏一行（`fav` 表，第三十二轮 §8.15 ④）：八格里只有 `repo` / `addedAt` / `from` 是必填，
 * 其余五格是「那一刻」的快照，宿主从本地表派生得到就有、派生不到就整格不进库（不是存空串）。
 */
const favSeed = (over = {}) => ({
  repo: 'tester-army/e2e', name: 'tester-army/E2E', desc: 'e2e testing',
  lang: 'TypeScript', langColor: '#3178c6', stars: 2474,
  addedAt: 1000, from: BOARD_LABELS.daily, ...over,
});

function mk({ now = () => 1000 } = {}) {
  const facility = makeFakeFacility();
  const logs = { warn: [] };
  const logger = { warn: (m) => logs.warn.push(String(m)) };
  const opts = { getFacility: () => facility, logger };
  return {
    facility, logs, opts,
    state: createStateStore(opts),
    events: createEventStore({ ...opts, now }),
    seen: createSeenStore(opts),
    prefs: createPrefsStore(opts),
    repo: createRepoCacheStore(opts),
    trans: createTransStore(opts),
    search: createSearchStore(opts),
    fav: createFavStore({ ...opts, now }),
  };
}

/** 每发一跳 1s 的时钟：events 的顺序断言要靠它（默认时钟恒等，专门测同毫秒发号）。 */
function advancing(start = 1000) {
  let at = start;
  return () => { at += 1000; return at; };
}

/* ---------------- 域与登记表 ---------------- */
check('域声明：gh_trending 名字与八表都过宿主正则，version 停在 1', () => {
  assert.equal(GHT_DOMAIN.name, 'gh_trending');   // 带连字符的插件名不能当域名（宿主 ^[a-z][a-z0-9_]*$）
  assert.deepEqual(Object.keys(GHT_DOMAIN.tables).sort(), ['events', 'fav', 'prefs', 'repo', 'search', 'seen', 'state', 'trans']);
  // ★ 抬版本 = 本机那份 gh_trending.json 整个打不开：整档布局按 stored !== descriptor.version 直接抛
  //   version-mismatch（dsh-storage-json/lib/index.js:102），compatibleVersions 只对 per-record 布局生效。
  //   加一张表不需要抬版本 —— 文件里没有这张表就是空表起步（同文件 :111）。
  //   10-06 加 `trans`（译文表）时按这条律走过；10-08 加 `search`（全站高星那一批）时同一条律原样走；
  //   10-13 加 `fav`（收藏，第三十二轮 §8.15 ④）还是同一条 —— 这条断言钉的就是"第四次于加表时没顺手抬版本"。
  assert.equal(GHT_DOMAIN.version, 1, '要抬版本请先给出"老库怎么迁移"的证据，否则就是拿用户的榜史换版本号');
});

check('八表同域：同一设施只 open 一次（重复 open = already-open 血案）', async () => {
  const s = mk();
  await s.state.write('daily', stateRow('daily'));
  await s.events.append({ kind: 'baseline', detail: 'x' });
  await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'daily', at: 1000 });
  await s.prefs.patch({ topN: 9 });
  await s.repo.put(repoRow());
  await s.trans.put(transRow());
  await s.fav.add(favSeed());
  assert.equal(s.facility.calls.open, 1, '七张表各自 open 就会撞 already-open');
  assert.equal(s.facility.rowCount('gh_trending', 'state'), 1);
  assert.equal(s.facility.rowCount('gh_trending', 'prefs'), 1);
  assert.equal(s.facility.rowCount('gh_trending', 'repo'), 1);
  assert.equal(s.facility.rowCount('gh_trending', 'trans'), 1);
  assert.equal(s.facility.rowCount('gh_trending', 'fav'), 1, '第八张表落在同一个域里，不是另开一档');
});

check('close：最后一个持有者放手才真关域（不许顺手关掉别人的域）', async () => {
  const s = mk();
  await s.state.write('daily', stateRow('daily'));
  await s.prefs.patch({ topN: 9 });
  await s.state.close();
  assert.equal(s.facility.calls.close, 0, 'prefs 还持有 gh_trending，state 单方面不许把域关掉');
  await s.prefs.read();                            // 另一个仓储照常用
  await s.repo.put(repoRow());                      // 详情缓存也是持有者
  await s.trans.put(transRow());                    // 译文表同样是
  await s.fav.add(favSeed());                       // ★ 收藏表同样是（第三十二轮：第八个持有者）
  await s.repo.close();
  await s.prefs.close();
  await s.events.close();
  await s.seen.close();
  await s.trans.close();
  await s.fav.close();
  assert.equal(s.facility.calls.close, 1, '七个持有者全放手 ⇒ 恰好真关一次');
});

check('close：仓储终态 ≠ 域关闭，关闭后写入报 CLOSED', async () => {
  const facility = makeFakeFacility();
  const state = createStateStore({ getFacility: () => facility });
  await state.write('daily', stateRow('daily'));
  await state.close();
  assert.equal(state.available, false);
  await assert.rejects(() => state.write('daily', stateRow('weekly', { board: 'weekly' })),
    (e) => e.code === RECORDS_ERROR.CLOSED);
  await assert.rejects(() => state.readAll(), (e) => e.code === RECORDS_ERROR.CLOSED);
});

check('无设施：available=false，prefs 读回落默认而不是崩，写报 UNAVAILABLE', async () => {
  const prefs = createPrefsStore({ getFacility: () => undefined });
  const state = createStateStore({ getFacility: () => null });
  assert.equal(prefs.available, false);
  assert.deepEqual(await prefs.read(), DEFAULT_PREFS);
  await assert.rejects(() => prefs.patch({ topN: 9 }), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => state.readAll(), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
});

check('prefs 读：宽容档给默认值，strict 档把「域不可用」如实抛（能力位不许被谎报）', async () => {
  const openFails = createPrefsStore({
    getFacility: () => ({ async open() { throw new Error('already-open: gh_trending'); } }),
  });
  assert.deepEqual(await openFails.read(), DEFAULT_PREFS, '界面那一路还是要拿到可用偏好（快照不能因为存储坏了就 500）');
  await assert.rejects(() => openFails.read({ strict: true }), (e) => e.code === RECORDS_ERROR.UNAVAILABLE,
    '装配那一路必须知道是域打不开 —— 宽容读会把它伪装成"还没写过偏好"，能力位就谎报在位');
});

/* ---------------- state ---------------- */
check('state：按榜分行读写，round-trip 保真', async () => {
  const s = mk();
  const saved = await s.state.write('daily', stateRow('daily'));
  assert.equal(saved.board, 'daily');
  const back = await s.state.read('daily');
  assert.equal(back.rows.length, 1);
  assert.equal(back.rows[0].repo, 'tester-army/e2e');
  assert.equal(back.rows[0].stars, 2474);
  assert.equal(back.rows[0].added, 344);
  assert.equal(back.prevRows[0].rank, 1);
  assert.equal(s.facility.rowCount('gh_trending', 'state'), 1);
});

check('state：readAll 三榜齐给，缺的榜是 null（界面不必防 undefined）', async () => {
  const s = mk();
  await s.state.write('monthly', stateRow('monthly'));
  const all = await s.state.readAll();
  assert.deepEqual(Object.keys(all), BOARDS);
  assert.equal(all.daily, null);
  assert.equal(all.weekly, null);
  assert.equal(all.monthly.ok, true);
});

check('state：越界榜 id 挡在门外（不静默写出第四行）', async () => {
  const s = mk();
  await assert.rejects(() => s.state.read('bogus'), (e) => e.code === RECORDS_ERROR.INVALID);
  await assert.rejects(() => s.state.write('bogus', stateRow('daily')),
    (e) => e.code === RECORDS_ERROR.INVALID);
  // key 与 value.board 的一致性不在这里判：写侧只有 write(board, …) 一个入口，越界榜名已在门口挡住；
  // 而"字段漂移"是读侧的事（库里躺着上一版写的行），那条由「脏行挡在 put 之前」与脏 prefs 用例覆盖。
  // 这一发全程没碰库：越界榜名挡在门口，连域都不必打开（rowCount 此刻是 -1 = 域没开）
  assert.equal(s.facility.calls.open, 0);
});

check('state：脏行挡在 put 之前，库里一条都不多（半条脏记录比少一条更糟）', async () => {
  const s = mk();
  await s.state.write('daily', stateRow('daily'));
  await assert.rejects(() => s.state.write('weekly', stateRow('weekly', { rows: [{ rank: 2, repo: 'a/b' }] })),
    (e) => e.code === RECORDS_ERROR.INVALID);          // 缺 stars/added
  await assert.rejects(() => s.state.write('weekly', stateRow('weekly', { ok: 'yes' })),
    (e) => e.code === RECORDS_ERROR.INVALID);          // 闸门必须是布尔
  assert.equal(s.facility.rowCount('gh_trending', 'state'), 1);
});

check('state：schema 丢弃未声明字段（存档要确定性，不静默接受漂移）', async () => {
  const s = mk();
  await s.state.write('daily', { ...stateRow('daily'), whyHot: 'LLM 编的' });
  const back = await s.state.read('daily');
  assert.equal('whyHot' in back, false);
  assert.equal('whyHot' in back.rows[0], false);
});

check('state：空榜是合法状态（rows 长度 0），304 冻结口径靠字段分开记', async () => {
  const s = mk();
  const saved = await s.state.write('weekly', stateRow('weekly', {
    rows: [], prevRows: [], bodyChangedAt: 900, lastFetchAt: 1200, etag: 'W/"e"',
  }));
  assert.equal(saved.rows.length, 0);
  const back = await s.state.read('weekly');
  assert.equal(back.bodyChangedAt, 900);   // 「正文最后一次真变」
  assert.equal(back.lastFetchAt, 1200);    // 「最后一次拿到响应（含 304）」—— 两件事必须分开存
});

/* ---------------- prefs ---------------- */
check('prefs：库里没写过就是出厂值', async () => {
  const s = mk();
  assert.deepEqual(await s.prefs.read(), DEFAULT_PREFS);
  // 出厂值本身是裁定（10-06：描述那一档默认开、摘要默认关），改动这一行等于改用户的模型额度去向
  assert.equal(DEFAULT_PREFS.llmDesc, true);
  assert.equal(DEFAULT_PREFS.llmReadme, false);
});

check('prefs：现译两开关只认严格布尔 —— false 落得了库，脏值一律折成"关"', async () => {
  const s = mk();
  await s.prefs.patch({ llmDesc: false });
  assert.equal((await s.prefs.read()).llmDesc, false, 'false 必须存得下来：被默认值 true 吃掉就等于关不掉');
  await s.prefs.patch({ llmDesc: true, llmReadme: true });
  assert.equal((await s.prefs.read()).llmReadme, true);
  // 库里躺着 'yes' / 1 这类"看着像开"的值 ⇒ 折成关：宁可少花一次额度，也不替用户猜"他大概想开"
  s.facility.seed('gh_trending', 'prefs', 'prefs', { llmDesc: 'yes', llmReadme: 1 });
  const back = await s.prefs.read();
  assert.equal(back.llmDesc, false);
  assert.equal(back.llmReadme, false);
});

check('prefs：patch 是读-并-写整行，只发一半抹不掉其余键', async () => {
  const s = mk();
  await s.prefs.patch({ intervalMin: 720, language: 'rust' });
  const half = await s.prefs.patch({ topN: 20 });
  assert.equal(half.intervalMin, 720);
  assert.equal(half.language, 'rust');
  assert.equal(half.topN, 20);
  assert.equal(half.keepEvents, DEFAULT_PREFS.keepEvents);
  assert.deepEqual(await s.prefs.read(), half);   // 回给调用方的形状与 GET prefs 一致
});

check('prefs：保存「全站」（language 空串）必须落得进去 —— 那就是出厂默认', async () => {
  const s = mk();
  const saved = await s.prefs.patch({ language: 'rust' });
  assert.equal(saved.language, 'rust');
  const cleared = await s.prefs.patch({ language: '' });   // schema 把 '' 归一成"无此键"，但对外必须还是 ''
  assert.equal(cleared.language, '');
  assert.equal((await s.prefs.read()).language, '');
  assert.equal(s.facility.rowCount('gh_trending', 'prefs'), 1);
});

check('prefs：越界钳回区间、非法档位回落、非法 slug 回落全站并留 warn', async () => {
  const s = mk();
  assert.equal((await s.prefs.patch({ intervalMin: 7, topN: 999, keepEvents: -5 })).intervalMin, DEFAULT_PREFS.intervalMin);
  let p = await s.prefs.patch({ topN: 999 });
  assert.equal(p.topN, 25);
  p = await s.prefs.patch({ topN: 1 });
  assert.equal(p.topN, 5);
  p = await s.prefs.patch({ keepEvents: 9999 });
  assert.equal(p.keepEvents, 2000);
  p = await s.prefs.patch({ intervalMin: 45 });
  assert.equal(p.intervalMin, DEFAULT_PREFS.intervalMin);                       // 不在档位表里 ⇒ 回落默认，不自造一档
  p = await s.prefs.patch({ language: 'Rust' });
  assert.equal(p.language, 'rust');                        // 大小写归一后入库
  p = await s.prefs.patch({ language: 'c++' });
  assert.equal(p.language, '');
  assert.ok(s.logs.warn.some((m) => m.includes('语言 slug 形状不合法')), '回落必须留痕');
});

check('prefs：库里躺着脏行（换版本/手工改库）时读出来仍然是可用的偏好', async () => {
  const s = mk();
  await s.prefs.read();                                    // 先把域打开
  s.facility.seed('gh_trending', 'prefs', 'prefs', { intervalMin: 45, topN: 'abc', keepEvents: 7, language: 'c++' });
  const dirty = await s.prefs.read();
  assert.equal(dirty.intervalMin, DEFAULT_PREFS.intervalMin); // 不在档位表 ⇒ 回落
  assert.equal(dirty.topN, DEFAULT_PREFS.topN);               // 'abc' ⇒ 回落，不把 NaN 交给界面
  assert.equal(dirty.keepEvents, 50);                         // 低于下限 ⇒ 钳到下限
  assert.equal(dirty.language, '');                           // 非法 slug ⇒ 全站
  assert.ok(dirty !== DEFAULT_PREFS, '读出来的是新对象，不能是 DEFAULT_PREFS 本身');
});

check('prefs：代理模式只认封闭集合，地址能解析就原样留（含凭据），坏地址清空并留 warn', async () => {
  const s = mk();
  let p = await s.prefs.patch({ proxyMode: 'custom', proxyUrl: 'http://bob:pw@10.0.0.2:8080' });
  assert.equal(p.proxyMode, 'custom');
  assert.equal(p.proxyUrl, 'http://bob:pw@10.0.0.2:8080', '读回来必须原样：归一成 http://10.0.0.2:8080 等于改写了用户存的凭据');
  p = await s.prefs.patch({ proxyMode: 'vpn' });
  assert.equal(p.proxyMode, DEFAULT_PREFS.proxyMode, '模式越界 ⇒ 回落默认，不把脏枚举交给界面');
  p = await s.prefs.patch({ proxyUrl: '127.0.0.1' });                    // 缺端口
  assert.equal(p.proxyUrl, '');
  assert.ok(s.logs.warn.some((m) => m.includes('代理地址不可用')), '回落必须留痕');
  p = await s.prefs.patch({ proxyUrl: '   ' });
  assert.equal(p.proxyUrl, '');

  // 读路径同一条规则：库里躺着外部改过的脏行（换机、手改 json）也不能把坏地址交给运行期
  s.facility.seed('gh_trending', 'prefs', 'prefs', {
    ...DEFAULT_PREFS, proxyMode: 'ftp', proxyUrl: 'socks5://1.2.3.4:1080',
  });
  const dirty = await s.prefs.read();
  assert.equal(dirty.proxyMode, DEFAULT_PREFS.proxyMode);
  assert.equal(dirty.proxyUrl, '');
});

check('prefs：现译引擎旧值先搬家再判脏，凭据那些格只钳长度不归一化内容（清单从 domain 派生）', async () => {
  const s = mk();
  await s.prefs.read();                                    // 先把域打开（seed 要往已开的域里塞）
  // ① 第九轮库里存的是 `official`：读出来必须落在百度那一档（换档名就静默回出厂档 = 把"没填凭据"那句真话换成"一切正常"）
  s.facility.seed('gh_trending', 'prefs', 'prefs', { ...DEFAULT_PREFS, translateEngine: 'official' });
  assert.equal((await s.prefs.read()).translateEngine, 'baidu');
  // ② 写路径同样搬家：界面哪天发来旧值，库里躺着的也得是新档名
  assert.equal((await s.prefs.patch({ translateEngine: 'official' })).translateEngine, 'baidu');
  // ③ 认不出的档名回落出厂档（这一格决定往哪个域名出网，不许把脏值带进运行时）
  assert.equal((await s.prefs.patch({ translateEngine: 'deepl' })).translateEngine, DEFAULT_PREFS.translateEngine);
  // ④ 凭据格（第二十一轮起含 GitHub 令牌那一格，清单取自 PREF_CRED_FIELDS 那份派生表）：
  //    只 trim + 钳长度，内容原样（改写用户填的串等于换成另一个值 —— 同代理地址那条律）
  const long = 'x'.repeat(Math.max(...PREF_CRED_FIELDS.map((f) => f.maxLength)) + 60);
  const p = await s.prefs.patch(Object.fromEntries(PREF_CRED_FIELDS.map((f) => [f.key, ` ${long} `])));
  for (const f of PREF_CRED_FIELDS) {
    assert.equal(p[f.key].length, f.maxLength, `${f.key} 没钳到上限`);
    assert.equal(p[f.key], 'x'.repeat(f.maxLength), `${f.key} 被归一化改写了`);
  }
  assert.equal((await s.prefs.patch({ baiduKey: 123 })).baiduKey, '', '非字符串（手改库）⇒ 落空，不把数字带进签名');
  // ⑤ 读路径也吃同一条规则：库里躺着外部改过的脏行也不能把脏档名交给运行期
  s.facility.seed('gh_trending', 'prefs', 'prefs', { ...DEFAULT_PREFS, translateEngine: 'nope', tencentSecretId: 7 });
  const dirty = await s.prefs.read();
  assert.equal(dirty.translateEngine, DEFAULT_PREFS.translateEngine);
  assert.equal(dirty.tencentSecretId, '');
  // ⑥ ★ 第二十一轮：GitHub 那一把走的是同一条钳制，且**空格等于没填**（repo.js 那条 trim 与这里同源，
  //    库里留一串空格的话，界面上"已保存"而那一发仍按匿名算 —— 两份真相）。
  assert.equal(DEFAULT_PREFS.ghToken, '', '出厂必须是空串：这一格是可选键，出厂就带着它，老库读出来才有默认');
  assert.equal((await s.prefs.patch({ ghToken: '    ' })).ghToken, '');
  // 旧库那一行压根没有这一格 ⇒ 读出来补 ''，不是 undefined（undefined 会被 repo.js 当成脏值，也会被闸门当成"填过"）
  const legacyRow = { ...DEFAULT_PREFS };
  delete legacyRow.ghToken;
  s.facility.seed('gh_trending', 'prefs', 'prefs', legacyRow);
  assert.equal((await s.prefs.read()).ghToken, '', '缺这格的旧库读出来必须是空串（undefined 会同时骗过界面与请求头两处）');
});

check('trans：旧档名 official 那一行仍然读得出来（换档名不等于把用户库里的译文全废）', async () => {
  const s = mk();
  await s.trans.put({ repo: 'a/b', kind: 'desc', src: 'hello', zh: '你好', at: 1000, engine: 'official' });
  const row = await s.trans.get('desc', 'a/b');
  assert.equal(row.engine, 'official', '落库时被改写了 ⇒ 落款会说谎（它不是这一档译的）');
  assert.equal(row.zh, '你好');
  await assert.rejects(() => s.trans.put({ repo: 'c/d', kind: 'desc', src: 'hi', zh: '嗨', at: 1000, engine: 'deepl' }),
    (e) => e.code === RECORDS_ERROR.INVALID, '认不出的引擎名不该过 schema');
});

/* ---------------- events ---------------- */
check('events：同毫秒 append 也必须各发一个 id（宿主发号，前端不许自带）', async () => {
  const s = mk();
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push((await s.events.append({ kind: 'board_enter', board: 'daily', repo: `a/${i}` })).id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, ['e-1000-0', 'e-1000-1', 'e-1000-2']);
  assert.equal(s.facility.rowCount('gh_trending', 'events'), 3);
});

check('events：不属于任何一张榜的事件（跨榜/源故障）必须落得进去', async () => {
  const s = mk();
  const cross = await s.events.append({ kind: 'rising_cross', repo: 'pbakaus/impeccable', detail: '同时上榜 2 张' });
  assert.equal(cross.board, undefined);                    // optionalEnum 不吃空串：'' 必须转成"没有这个键"
  const err = await s.events.append({ kind: 'source_error', detail: '趋势页返回 500' });
  assert.equal(err.kind, 'source_error');
  assert.equal(s.facility.rowCount('gh_trending', 'events'), 2);
});

check('events：非法 kind 直接拒（枚举脏值会被界面直接渲染出来）', async () => {
  const s = mk();
  await assert.rejects(() => s.events.append({ kind: 'whatever' }), (e) => e.code === RECORDS_ERROR.INVALID);
  await assert.rejects(() => s.events.append({ kind: 'board_enter', board: 'yearly' }),
    (e) => e.code === RECORDS_ERROR.INVALID);
  assert.equal(s.facility.rowCount('gh_trending', 'events'), 0);
});

check('events：list 倒序（新→旧）、board 过滤、limit 钳在 [1,500]', async () => {
  const s = mk({ now: advancing() });
  await s.events.append({ kind: 'board_enter', board: 'daily', repo: 'a/1' });
  await s.events.append({ kind: 'board_move', board: 'weekly', repo: 'b/2' });
  await s.events.append({ kind: 'board_exit', board: 'daily', repo: 'c/3' });
  const all = await s.events.list(100);
  assert.deepEqual(all.map((e) => e.repo), ['c/3', 'b/2', 'a/1']);
  assert.deepEqual((await s.events.list(100, 'daily')).map((e) => e.repo), ['c/3', 'a/1']);
  assert.equal((await s.events.list(2)).length, 2);
  assert.equal((await s.events.list(0)).length, 3);        // 非法 limit 回落默认 100（不返回空表冒充"没有事件"）
  assert.equal((await s.events.list('abc')).length, 3);
  assert.equal((await s.events.list(9999)).length, 3);     // 上限 500 钳制（库里只有 3 条，这里只验不炸）
  assert.deepEqual((await s.events.list(100, 'bogus')).length, 3, '非法 board 当"不过滤"，不静默返回空');
});

check('events：trim 只裁最老的，返回裁掉数', async () => {
  const s = mk({ now: advancing() });
  for (let i = 0; i < 5; i += 1) await s.events.append({ kind: 'board_enter', board: 'daily', repo: `a/${i}` });
  assert.equal(await s.events.trim(2), 3);
  assert.deepEqual((await s.events.list(10)).map((e) => e.repo), ['a/4', 'a/3']);
  assert.equal(await s.events.trim(2), 0);
  assert.equal(await s.events.trim(0), 0);                 // 非法 keep 不动库（宁可不裁，也不把流水清空）
  assert.equal(await s.events.trim('abc'), 0);
  assert.equal((await s.events.list(10)).length, 2);
});

/* ---------------- seen ---------------- */
check('seen：首见 fresh=true 并钉住 firstAt/firstBoard；再见只动 last*', async () => {
  const s = mk();
  const first = await s.seen.touch({ repo: 'tester-army/e2e', name: 'tester-army/E2E', repoId: 1308631234, board: 'daily', at: 1000 });
  assert.equal(first.fresh, true);
  assert.deepEqual([first.seen.firstAt, first.seen.firstBoard, first.seen.lastAt, first.seen.lastBoard], [1000, 'daily', 1000, 'daily']);
  assert.deepEqual(first.seen.boards, ['daily']);

  const again = await s.seen.touch({ repo: 'tester-army/e2e', name: 'tester-army/E2E', repoId: 1308631234, board: 'daily', at: 2000 });
  assert.equal(again.fresh, false);
  assert.deepEqual([again.seen.firstAt, again.seen.firstBoard, again.seen.lastAt], [1000, 'daily', 2000]);
  assert.deepEqual(again.seen.boards, ['daily']);           // 重复上榜不重复记账

  const weekly = await s.seen.touch({ repo: 'tester-army/e2e', name: 'tester-army/E2E', repoId: 1308631234, board: 'weekly', at: 3000 });
  assert.deepEqual(weekly.seen.boards, ['daily', 'weekly']);
  assert.equal(weekly.seen.lastBoard, 'weekly');
  assert.equal(s.facility.rowCount('gh_trending', 'seen'), 1);
});

check('seen：key 是小写 repo，改名（同 repoId 换 key）在新 key 上算首见', async () => {
  const s = mk();
  await s.seen.touch({ repo: 'old/name', name: 'Old/Name', repoId: 42, board: 'daily', at: 1000 });
  const renamed = await s.seen.touch({ repo: 'new/name', name: 'New/Name', repoId: 42, board: 'daily', at: 2000 });
  assert.equal(renamed.fresh, true, 'seen 只答"这台机器见过这个 key 没有"；改名判定不吃这里（靠 repoId 对 prevRows）');
  assert.equal(s.facility.rowCount('gh_trending', 'seen'), 2);
  const all = await s.seen.readAll();
  assert.deepEqual([...all.keys()], ['old/name', 'new/name']);
});

check('seen：非法 board 进不了观测史（boards 是枚举数组）', async () => {
  const s = mk();
  await assert.rejects(() => s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'yearly', at: 1000 }),
    (e) => e.code === RECORDS_ERROR.INVALID);
  assert.equal(s.facility.rowCount('gh_trending', 'seen'), 0);
});

/* ---------------- repo（详情缓存） ---------------- */
check('repo：入库键统一小写，取回还是同一行；空键挡在队列之前', async () => {
  const s = mk();
  await s.repo.put(repoRow({ repo: 'Tester-Army/E2E' }));
  assert.equal(s.facility.rowCount('gh_trending', 'repo'), 1);
  const back = await s.repo.get('tester-army/e2e');
  assert.equal(back.repo, 'tester-army/e2e');
  assert.equal(back.stars, 2474);
  assert.equal((await s.repo.get('Tester-Army/E2E')).readmeSource, 'zh_default', '大小写两种写法要命中同一行');
  assert.equal(await s.repo.get('没点过的/仓库'), null, '没缓存是给 null，不是给 undefined（界面不必防两种空）');
  await assert.rejects(() => s.repo.get('   '), (e) => e.code === RECORDS_ERROR.INVALID);
  await assert.rejects(() => s.repo.put({ ...repoRow(), repo: '' }), (e) => e.code === RECORDS_ERROR.INVALID);
});

check('repo：schema 挡脏行 —— errKey / readmeSource 只认封闭集合，未声明字段丢弃', async () => {
  const s = mk();
  await assert.rejects(() => s.repo.put(repoRow({ errKey: '加载失败' })), (e) => e.code === RECORDS_ERROR.INVALID);
  await assert.rejects(() => s.repo.put(repoRow({ readmeSource: 'auto-translated' })), (e) => e.code === RECORDS_ERROR.INVALID);
  assert.ok(Object.keys(REPO_ERROR_LABELS).includes('rate_limited'));
  await s.repo.put(repoRow({ ...repoRow(), 顺手加的字段: 'x', readmeExcerpt: 'x'.repeat(10) }));
  const back = await s.repo.get('tester-army/e2e');
  assert.equal(back['顺手加的字段'], undefined, '未声明字段必须存不进来');
  assert.equal(s.facility.rowCount('gh_trending', 'repo'), 1);
  // 超长节选不截断而是拒收：截断会把"整篇 1,600 字"谎报成读数
  await assert.rejects(() => s.repo.put(repoRow({ readmeExcerpt: 'x'.repeat(2000) })),
    (e) => e.code === RECORDS_ERROR.INVALID);
});

check('repo：无设施时 available=false，读写都报 UNAVAILABLE（详情层据此走"每次都发"那条路）', async () => {
  const repo = createRepoCacheStore({ getFacility: () => undefined });
  assert.equal(repo.available, false);
  await assert.rejects(() => repo.get('a/b'), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => repo.put(repoRow()), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => repo.list(), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
});

check('repo：行数超过上限按「最后一次问过」裁（★ 第三十四轮换尺子：缺 `checkedAt` 的老行回退 `at`）', async () => {
  const facility = makeFakeFacility();
  const repo = createRepoCacheStore({ getFacility: () => facility, maxRows: 3, logger: { warn: () => {} } });
  for (let i = 0; i < 5; i += 1) await repo.put(repoRow({ repo: `o/r${i}`, at: 1000 + i }));
  const listed = await repo.list();
  assert.deepEqual(listed.map((x) => x.key), ['o/r4', 'o/r3', 'o/r2']);
  assert.equal(listed[0].ok, true);
  assert.equal(await repo.get('o/r0'), null, '最久没问的那行该被裁掉');
  assert.equal(facility.rowCount('gh_trending', 'repo'), 3);
  assert.equal(REPO_CACHE_MAX > 3, true, '出厂上限是宽松档，用例才敢用小值注入');
  // ★ 这批行一个 `checkedAt` 都没有（条件请求之前那种老行）⇒ 尺子回退 `at`，顺序不许因为缺格而变成 0 垫底。
  assert.deepEqual(listed.map((x) => x.askedAt), [1004, 1003, 1002],
    'list() 给的 `askedAt` 必须与裁行吃的是同一格（界面/排障读的是这一份，两处不同尺就是两份真相）');
});

check('★ repo 裁行吃 `checkedAt` 而不是 `at`：304 反复命中的那一行不能被删（越省额度越先没 = §8.13 那处隐患）', async () => {
  const facility = makeFakeFacility();
  const repo = createRepoCacheStore({ getFacility: () => facility, maxRows: 3, logger: { warn: () => {} } });
  // 现场：r-old 正文三天前取回（`at` 很老），但每一问都 304 ⇒ `checkedAt` 刚刚推进；r1~r3 正文新、却再没被点开过。
  await repo.put(repoRow({ repo: 'o/r1', at: 8000 }));
  await repo.put(repoRow({ repo: 'o/r2', at: 7000 }));
  await repo.put(repoRow({ repo: 'o/r3', at: 6000 }));
  await repo.put(repoRow({ repo: 'o/r-old', at: 1000, checkedAt: 9000 }));
  const listed = await repo.list();
  assert.deepEqual(listed.map((x) => x.key), ['o/r-old', 'o/r1', 'o/r2'],
    '按「最后一次问过」排：`at` 最老但刚核对过的排第一；旧尺子（只看 at）会把它裁掉、留下从没再点开的 r3');
  const kept = await repo.get('o/r-old');
  assert.equal(kept && kept.repo, 'o/r-old', '★ 刚核对过的那行必须还在（旧形状：吃 at 排序 ⇒ 这一行第一个出局）');
  assert.equal(await repo.get('o/r3'), null, '被裁的应是「最久没问」那一行，不是「正文最老」那一行');
  assert.equal(facility.rowCount('gh_trending', 'repo'), 3);
});

check('★ 那把尺不吃脏时刻：库里躺着 `checkedAt: Infinity` / `"9000"`（手改 json、换机搬库）⇒ 按「没有这一格」回退 `at`', async () => {
  const facility = makeFakeFacility();
  const repo = createRepoCacheStore({ getFacility: () => facility, maxRows: 99, logger: { warn: () => {} } });
  await repo.put(repoRow({ repo: 'o/clean', at: 5000, checkedAt: 6000 }));
  await repo.put(repoRow({ repo: 'o/plain', at: 2000 }));
  // ★ 这两行只能绕开 schema 塞（`checkedAt: optionalNumber` 在 `put` 那关就把它们挡了）：模拟外部改过的库、上一版写歪的行。
  facility.seed('gh_trending', 'repo', 'o/str', { repo: 'o/str', at: 4000, ok: true, checkedAt: '9000' });
  facility.seed('gh_trending', 'repo', 'o/inf', { repo: 'o/inf', at: 3000, ok: true, checkedAt: Infinity });
  // `Infinity` 比字符串更毒：`b - a` 一减就是 `Infinity`，那一行直接插到最前，而它其实从没被问过。
  assert.deepEqual(await repo.list().then((l) => l.map((x) => x.askedAt)), [6000, 4000, 3000, 2000],
    '脏值不许参与比较：认不出就当没有这一格（回退 `at`），否则一个坏行把整表顺序带偏、裁行跟着删错行');
  assert.deepEqual(await repo.list().then((l) => l.map((x) => x.key)), ['o/clean', 'o/str', 'o/inf', 'o/plain'],
    '排序键与上面那条同源（同一把尺）：`list()` 交出去的那一份必须是能读的数，界面/排障拿它当"最后一次问过"');
});

/* ---------------- trans（模型译文） ---------------- */
check('trans：主键是 kind:小写仓库，两档各存一行不互相盖掉', async () => {
  const s = mk();
  await s.trans.put(transRow({ repo: 'Tester-Army/E2E', kind: 'desc', zh: '端到端测试' }));
  await s.trans.put(transRow({ kind: 'readme', src: 'a readme body', zh: '一份 README 的摘要', at: 2000 }));
  assert.equal(s.facility.rowCount('gh_trending', 'trans'), 2);
  assert.equal((await s.trans.get('desc', 'tester-army/e2e')).zh, '端到端测试');
  assert.equal((await s.trans.get('readme', 'tester-army/e2e')).zh, '一份 README 的摘要');
  assert.equal(await s.trans.get('desc', 'never-clicked/repo'), null, '没译过是给 null');
});

check('trans：schema 挡脏行 —— kind 只认封闭集合，空原文/空译文都进不来', async () => {
  const s = mk();
  await assert.rejects(() => s.trans.put(transRow({ kind: 'commit-message' })), (e) => e.code === RECORDS_ERROR.INVALID);
  await assert.rejects(() => s.trans.put(transRow({ src: '' })), (e) => e.code === RECORDS_ERROR.INVALID);
  await assert.rejects(() => s.trans.put(transRow({ zh: '' })), (e) => e.code === RECORDS_ERROR.INVALID);
  await assert.rejects(() => s.trans.put(transRow({ at: '昨天' })), (e) => e.code === RECORDS_ERROR.INVALID);
  assert.equal(s.facility.rowCount('gh_trending', 'trans'), 0, '被拒的那几行一行都不许留在库里');
  assert.deepEqual(LLM_KINDS, ['desc', 'readme', 'readmeFullZh', 'readmeFullSum'], '枚举加了新档就要连这条一起看：闸门只认这一份');
  // ★ 第二十八轮：那两路整篇必须**真存得进来** —— 只把名字加进名单、闸门却把行拒掉，那一趟跑完的译文就原地丢了，
  //   而界面上一切照旧（`full-readme.js` 会把 `stored:false` 那句念出来，但没人点开那一趟就看不见）。
  await s.trans.put(transRow({ kind: 'readmeFullZh', zh: '一整篇的译文' }));
  await s.trans.put(transRow({ kind: 'readmeFullSum', zh: '一整篇的摘要' }));
  assert.equal((await s.trans.get('readmeFullZh', 'tester-army/e2e')).zh, '一整篇的译文');
  assert.equal((await s.trans.get('readmeFullSum', 'tester-army/e2e')).zh, '一整篇的摘要', '两路各占一行，主键是 kind:仓库，不许互相盖');
  assert.equal(s.facility.rowCount('gh_trending', 'trans'), 2);
  // 整篇译文那一行就是长文（`MANUAL_FULL_ZH_MAX` 在写入侧挡到 30,000 字）：这张表的 `zh` 没有第二道长度闸门
  await s.trans.put(transRow({ kind: 'readmeFullZh', zh: '字'.repeat(30000) }));
  assert.equal((await s.trans.get('readmeFullZh', 'tester-army/e2e')).zh.length, 30000,
    '存不进来长文 ⇒ 那一趟的结果被这张表悄悄裁掉，屏上那句「已存下来」就是假话');
  // 未声明字段存不进来（译文表特别要紧：多存一份"模型的自言自语"没人会去读它）
  await s.trans.put({ ...transRow(), 顺手加的字段: 'x' });
  assert.equal((await s.trans.get('desc', 'tester-army/e2e'))['顺手加的字段'], undefined);
});

check('trans：无设施时 available=false，读写都报 UNAVAILABLE（现译层据此走"只译不存"那条路）', async () => {
  const trans = createTransStore({ getFacility: () => undefined });
  assert.equal(trans.available, false);
  await assert.rejects(() => trans.get('desc', 'a/b'), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => trans.put(transRow()), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => trans.list(), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
});

check('trans：行数超过上限按最老的裁（模型译文堆到几百条也不会白烧额度，但 KV 域不是无限大的）', async () => {
  const facility = makeFakeFacility();
  const trans = createTransStore({ getFacility: () => facility, maxRows: 3, logger: { warn: () => {} } });
  for (let i = 0; i < 5; i += 1) await trans.put(transRow({ repo: `o/r${i}`, at: 1000 + i }));
  const listed = await trans.list();
  assert.deepEqual(listed.map((x) => x.key), ['desc:o/r4', 'desc:o/r3', 'desc:o/r2'],
    'list 给的是「键 + 时刻 + 字数」摘要，不给正文（一行译文可能几百字，快照不该整份搬出去）');
  assert.equal(await trans.get('desc', 'o/r0'), null, '最老那行应被裁掉');
  assert.equal(facility.rowCount('gh_trending', 'trans'), 3);
  assert.equal(TRANS_MAX > 3, true, '出厂上限是宽松档，用例才敢用小档注入');
});

/* ---------------- 全站高星那一批（第二十三轮：search 表） ---------------- */
check('search：单行覆盖写 —— 第二次写换掉整批，库里永远只有一行 batch', async () => {
  const s = mk();
  assert.equal(await s.search.read(), null, '没写过就是 null（"这一档从没取回过"与"取回过但空批"必须是两件事）');
  await s.search.write(searchBatch());
  await s.search.write(searchBatch({ at: 5000, rows: [searchRow({ repo: 'x/y', name: 'X/Y', stars: 200000 })] }));
  const row = await s.search.read();
  assert.equal(row.at, 5000);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].repo, 'x/y');
  assert.equal(s.facility.rowCount('gh_trending', 'search'), 1, '这张表只许一行（多 key 就是"哪一批作数"的第二份真相）');
});

check('search：坏轮冻结由调用方写、这里照读 —— at 停在上一批的成功时刻，rows 不清空', async () => {
  const s = mk();
  const good = searchBatch({ at: 1000 });
  await s.search.write(good);
  // 失败轮：ok=false + error + transport，at 仍是**上一次成功**的时刻，rows 是上一批那一份（spec §8.8「失败」那条）
  await s.search.write(searchBatch({ at: 1000, lastFetchAt: 9000, ok: false, error: '连不上', transport: true }));
  const row = await s.search.read();
  assert.equal(row.ok, false);
  assert.equal(row.transport, true);
  assert.equal(row.at, 1000, 'at 是"最后一次成功取回"，失败轮不许把它推成新时刻（那会让「上次取回」说假话）');
  assert.equal(row.lastFetchAt, 9000);
  assert.equal(row.rows.length, 1, '坏轮不空表：上一批照常显示，与三榜那条冻结读法一字不差');
});

check('search：schema 挡脏行（rows 里缺 stars / 额度那几格只认数字）', async () => {
  const s = mk();
  await assert.rejects(() => s.search.write(searchBatch({ rows: [{ rank: 1, repo: 'a/b', name: 'A/B' }] })),
    (e) => e.code === RECORDS_ERROR.INVALID, 'BOARD 行那样要求 stars，search 行同样得给 stars');
  await assert.rejects(() => s.search.write(searchBatch({ at: undefined })),
    (e) => e.code === RECORDS_ERROR.INVALID, 'at 是 requiredNumber');
  // 未声明字段被丢掉（不许把回包整坨塞进 KV）
  const row = await s.search.write(searchBatch({ owner: { login: 'freeCodeCamp' } }));
  assert.equal('owner' in row, false, 'schema 之外的回包字段进不了库');
  // 行形状与 domain 那张表逐字对齐：加字段只能改 domain，不能只在用例里出现
  assert.deepEqual(Object.keys(searchRow()).sort(), Object.keys(SEARCH_ROW_SHAPE).sort());
});

check('search：无设施时 available=false，读写都报 UNAVAILABLE（runner 据此走"不发"那道闸）', async () => {
  const s = createSearchStore({ getFacility: () => null });
  assert.equal(s.available, false);
  await assert.rejects(() => s.read(), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => s.write(searchBatch()), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
});

/* ---------------- 观测史那两格（第二十三轮：roundsTotal / bestRank） ---------------- */
check('seen：同一轮三榜同现只 +1（check 对三榜用的是同一个 t0，判据是 at 与 lastAt 相等）', async () => {
  const s = mk();
  const at = 5000;
  for (const [board, rank] of [['daily', 7], ['weekly', 2], ['monthly', 9]]) {
    await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board, at, rank });
  }
  const row = (await s.seen.readAll()).get('a/b');
  assert.equal(row.roundsTotal, 1, '一轮内上满三榜 = 一轮，不是三轮');
  assert.equal(row.bestRank, 2, '同轮跨榜取最小名次');
  assert.deepEqual(row.boards, ['daily', 'weekly', 'monthly']);
});

check('seen：跨轮继续 +1，bestRank 只降不升；rank 缺位或非法时两个数都不许被污染', async () => {
  const s = mk();
  await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'daily', at: 1000, rank: 5 });
  await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'daily', at: 2000, rank: 9 });
  let row = (await s.seen.readAll()).get('a/b');
  assert.equal(row.roundsTotal, 2);
  assert.equal(row.bestRank, 5, '这一轮名次更差（9），历史最好那位不能被换掉');
  // 缺 rank / 脏 rank：不加格、不改 best，但轮数照样 +1（"在榜"这件事与"第几名"是两件事）
  await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'weekly', at: 3000 });
  await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'weekly', at: 4000, rank: 0 });
  await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'weekly', at: 5000, rank: 'abc' });
  row = (await s.seen.readAll()).get('a/b');
  assert.equal(row.roundsTotal, 5);
  assert.equal(row.bestRank, 5, 'rank=0 / 非数字都不许把最好名次写成 0（那会把"不知道"演成"第一名"）');
});

check('seen：上一版写下的那一行（无这两格）第一次 touch 后从 1 起算，读侧拿 0 补默认', async () => {
  const s = mk();
  await s.seen.readAll();   // 先开域（seed 要求域已打开，同 prefs 那条旧库用例的走法）
  s.facility.seed('gh_trending', 'seen', 'a/b', {
    repo: 'a/b', name: 'A/B', repoId: 1, firstAt: 900, firstBoard: 'daily',
    lastAt: 1000, lastBoard: 'daily', boards: ['daily'],
  });
  const before = (await s.seen.readAll()).get('a/b');
  assert.equal('roundsTotal' in before, false, '读侧不造格：缺就是缺（补默认在 lib/stars.js 那一处）');
  await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'weekly', at: 2000, rank: 3 });
  const after = (await s.seen.readAll()).get('a/b');
  assert.equal(after.roundsTotal, 1, '旧行没有计数 ⇒ 从"这次算一轮"起，而不是 undefined 一路传到界面');
  assert.equal(after.bestRank, 3);
  assert.equal(after.firstAt, 900, 'firstAt 恒不动（原有那条律原样作数）');
});

/* ---------------- 写队列 ---------------- */
check('并发：同表多写串行落库，顺序确定且失败不堵队列', async () => {
  const s = mk();
  const results = await Promise.allSettled([
    s.state.write('daily', stateRow('daily')),
    s.state.write('weekly', stateRow('weekly')),
    s.state.write('bogus', stateRow('daily')),           // 中间夹一发脏写
    s.state.write('monthly', stateRow('monthly')),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[2].reason.code, RECORDS_ERROR.INVALID);
  const all = await s.state.readAll();
  assert.deepEqual(BOARDS.map((b) => (all[b] ? 'ok' : 'null')), ['ok', 'ok', 'ok']);
});

check('★ prefs：详情缓存那一格（第三十一轮加回）只认四档、缺格回落出厂 24，且老行缺它照样 open 得过', async () => {
  // 第十二轮定档 → 第二十七轮撤 → 第三十一轮（10-12 用户裁定）加回。这一条是**就地改判**，不是新用例：
  //   旧写法断的是"撤档要撤干净"（读出来没有它、也写不进去），现在断的是另一头——档位是活的，但**加格的方向必须宽容**。
  //   ⚠️ 血案口径原样保留（下面 707 那条同尺子的判据还在管 open）：这一格写成 `requiredInt` 的话，
  //   第十二轮之前那份库存压根没有它 ⇒ 宿主 open 当场抛、三榜全红「存储不可用」（10-07 真机事故）。
  const s = mk();
  const p = await s.prefs.read();
  assert.equal(p.repoCacheHours, DEFAULT_PREFS.repoCacheHours, '空库读回来该拿到出厂那一档，不是 undefined');
  assert.ok([6, 12, 24, 72].includes(p.repoCacheHours), '出厂值不在自己认的名单里 ⇒ clampPrefs 会把默认值判成脏');

  // 写路径：那一格要真进得了库、读得出来（界面上那排分段器点下去就是这个动作）。
  await s.prefs.patch({ repoCacheHours: 6 });
  assert.equal((await s.prefs.read()).repoCacheHours, 6, '改档落不了库 ⇒ 界面显示成 6 小时，下一问还按出厂档跑');

  // 脏值：只认封闭四档，越界一律回出厂 —— 两处（domain 的 repoCacheTtlMs 与这里的 clampPrefs）算不出第二个答案。
  for (const bad of [5, 0, 100, 'abc', null]) {
    await s.prefs.patch({ repoCacheHours: bad });
    assert.equal((await s.prefs.read()).repoCacheHours, DEFAULT_PREFS.repoCacheHours,
      `${JSON.stringify(bad)} 没被钳回出厂档 ⇒ 一个自由整数就能把「一次点击最多 4 发」的预算口径改掉`);
  }

  // 读路径：老库存里**没有**这一格（第十二轮之前那份）⇒ parse 得过、读回来是 24 而不是 undefined。
  const legacyRow = { intervalMin: 60, topN: 15, keepEvents: 300, proxyMode: 'system', zzUnknownKey: '留给下一版的垃圾' };
  assert.doesNotThrow(() => GHT_DOMAIN.tables.prefs.valueSchema.parse(legacyRow),
    '缺这一格的上一版库存挡在 open 里 ⇒ 三榜全红「存储不可用」（第十三轮那把尺子量的是同一个方向）');
  s.facility.seed('gh_trending', 'prefs', 'prefs', GHT_DOMAIN.tables.prefs.valueSchema.parse(legacyRow));
  const back = await s.prefs.read();
  assert.equal(back.repoCacheHours, DEFAULT_PREFS.repoCacheHours, '库里缺这一格却读回 undefined ⇒ TTL 那一路拿到 NaN，每次点开都出网');
  assert.equal('zzUnknownKey' in back, false);
  assert.equal(back.intervalMin, DEFAULT_PREFS.intervalMin, '丢掉多余键的同时不许把声明键也丢了');
});

check('★ schema 的 open 校验：每张表都必须吃得下"上一版库存里真实存在的那一行"（缺新增键 ≠ 坏行）', () => {
  // 为什么单独钉这一条：宿主 storageDomain **只在 open() 读存量时**跑 `valueSchema.parse`，一条坏行拖死**整个域**
  // ⇒ 界面上是三榜全红「故障 · 存储不可用」，而不是"那一格读不出来"。10-07 真机事故就是第十二轮把
  // `repoCacheHours` 按邻居 `intervalMin` 抄成了 `requiredInt` —— 邻居是首建就有的键，对老库合法，新增键不合法。
  // 假设施的 `seed` 走的是"未经校验的脏行"那条路（测读路径扛得住），**它不跑 open 校验** ⇒ 上面那条用例全绿而真宿主打不开，
  // 所以这里直接调宿主调的那同一个函数。
  const legacy = {
    prefs: {  // 第十二轮之前的真形状（键名取自本机库存，凭据一律换成占位）
      intervalMin: 60, topN: 15, keepEvents: 300, proxyMode: 'system',
      llmDesc: true, llmReadme: true, translateEngine: 'tencent',
      tencentSecretId: 'placeholder-id', tencentSecretKey: 'placeholder-secret',
    },
    repo: {  // 第十一轮之前的行：没有 readmeSection / descSelfZh / zhCjk
      repo: 'some/one', at: 1_700_000_000_000, ok: true, desc: 'x', stars: 1, readmeSource: 'en_default',
    },
    trans: {  // 第九轮之前的行：没有 engine
      repo: 'some/one', kind: 'desc', src: 'x', zh: '中文', at: 1_700_000_000_000,
    },
    // ★ 第二十三轮自查（同一把尺子的第四个样本）：`seen` 表 10-08 之前的真实行就是这个形状 ——
    //   八格齐全、没有 roundsTotal / bestRank。写成 required 会让用户攒下的**整张观测史**在 open 里挡死
    //   ⇒ 明星那一屏读不出榜史还是小事，三榜全红「存储不可用」才是后果（同 10-07 那笔账）。
    seen: {
      repo: 'some/one', name: 'Some/One', repoId: 123456,
      firstAt: 1_690_000_000_000, firstBoard: 'daily',
      lastAt: 1_700_000_000_000, lastBoard: 'weekly', boards: ['daily', 'weekly'],
    },
  };
  for (const [table, row] of Object.entries(legacy)) {
    const schema = GHT_DOMAIN.tables[table].valueSchema;
    let parsed;
    assert.doesNotThrow(() => { parsed = schema.parse(row); }, `${table} 表读不出上一版那一行 ⇒ 整域 open 失败、全线「存储不可用」`);
    assert.equal(typeof parsed, 'object');
  }
  // 缺的那几格是"读不出来时由 clamp 补默认"，不是"读的时候就得有"：parse 结果里干脆没有它
  const p = GHT_DOMAIN.tables.prefs.valueSchema.parse(legacy.prefs);
  assert.equal('repoCacheHours' in p, false, 'schema 不该凭空造出这一格（补默认是 clampPrefs 的活，两处都补就是两份真相）');
  // ★ 第二十一轮那条新增键自查（拿第十三轮的血案当尺子）：**上一版**那一行 —— 出厂值齐全、只缺 ghToken ——
  //   必须 parse 得过。把它写成 required 的话，用户还没去设置页填令牌，那一行就挡在 open 里
  //   ⇒ 三榜全红「故障 · 存储不可用」，而不是"这一格空着"。
  const prevRow = { ...DEFAULT_PREFS };
  delete prevRow.ghToken;
  assert.doesNotThrow(() => GHT_DOMAIN.tables.prefs.valueSchema.parse(prevRow),
    'ghToken 必须是 optional：缺它的是合法的上一版库存，不是坏行');
  assert.equal('ghToken' in GHT_DOMAIN.tables.prefs.valueSchema.parse(prevRow), false,
    'parse 不凭空造格（补默认只由 clampPrefs 那一处做）');
  // ★ 第二十三轮那三格同一条律自查：`allStarsEnabled`（prefs）与 `roundsTotal` / `bestRank`（seen）
  //   都必须是 optional，且 parse **不凭空造格** —— 缺它们的行是合法的上一版库存。
  //   补默认只由两处做：prefs 走 `clampPrefs`，seen 走**读取侧**（`lib/stars.js` 读成 0），schema 一律不插手。
  delete prevRow.allStarsEnabled;
  assert.doesNotThrow(() => GHT_DOMAIN.tables.prefs.valueSchema.parse(prevRow),
    'allStarsEnabled 必须是 optional：缺它的 prefs 行是第二十三轮之前写下的那一行');
  const noFlag = GHT_DOMAIN.tables.prefs.valueSchema.parse(prevRow);
  assert.equal('allStarsEnabled' in noFlag, false, 'prefs 的 parse 不造 allStarsEnabled（补默认只由 clampPrefs 那一处做）');
  const seenParsed = GHT_DOMAIN.tables.seen.valueSchema.parse(legacy.seen);
  assert.equal('roundsTotal' in seenParsed, false, 'seen 的 parse 不造 roundsTotal（缺格由读取侧读成 0）');
  assert.equal('bestRank' in seenParsed, false, 'seen 的 parse 不造 bestRank（同上）');
});

/* ---------------- fav（收藏，第三十二轮 §8.15 ④） ---------------- */
check('fav：入库键统一小写，同一仓库的两个写法是同一行（两枚 ★ 各亮各的根源就在这格）', async () => {
  const s = mk();
  await s.fav.add(favSeed({ repo: 'Tester-Army/E2E' }));
  assert.equal(s.facility.rowCount('gh_trending', 'fav'), 1, '大小写两种写法各存一行 = 收藏清单里同一个仓库两个副本');
  const back = await s.fav.get('tester-army/e2e');
  assert.equal(back.repo, 'tester-army/e2e');
  assert.equal((await s.fav.get('TESTER-army/E2E')).stars, 2474, '取回也走同一条归一');
  assert.equal(await s.fav.get('没收藏过的/仓库'), null, '没收藏过是给 null，不是给 undefined（界面不必防两种空）');
  await assert.rejects(() => s.fav.get('   '), (e) => e.code === RECORDS_ERROR.INVALID, '空键挡在队列之前');
  await assert.rejects(() => s.fav.add(favSeed({ repo: '' })), (e) => e.code === RECORDS_ERROR.INVALID);
  await assert.rejects(() => s.fav.remove('  '), (e) => e.code === RECORDS_ERROR.INVALID);
});

check('★ fav：add 幂等且沿用库里那一行的 addedAt（「收藏于 3 天前」不能被重复点那枚 ☆ 刷成「刚刚」）', async () => {
  let at = 1000;
  const facility = makeFakeFacility();
  const fav = createFavStore({ getFacility: () => facility, now: () => at });
  const first = await fav.add({ repo: 'a/b', name: 'A/B', stars: 10, from: BOARD_LABELS.daily });
  assert.equal(first.already, false);
  assert.equal(first.row.addedAt, 1000);
  at = 9000;                                     // 三天后再点一次同一枚（比如先移出又收回之外的连点）
  const again = await fav.add({ repo: 'A/B', name: 'A/B', stars: 20, from: FAV_FROM_STARS });
  assert.equal(again.already, true, '已存在那一行要如实报 already，界面上那一枚才知道自己是"重复按"');
  assert.equal(again.row.addedAt, 1000, '幂等那一支恒沿旧 addedAt：那一列说的是第一次收的那一刻');
  assert.equal(again.row.stars, 20, '余下五格快照按新值覆盖：重新看到的那个数就是新的');  assert.equal(again.row.from, FAV_FROM_STARS, '出处跟着这一次重新派生（这次是从明星那一屏收的）');
  assert.equal(facility.rowCount('gh_trending', 'fav'), 1, '两次点同一枚只有一行');
});

check('fav：remove 摘掉那一行，库里本来没有时 removed 给假（界面上那枚 ★ 与库存不一致时这一发要说得出话）', async () => {
  const s = mk();
  await s.fav.add(favSeed());
  assert.equal((await s.fav.remove('tester-army/e2e')).removed, true);
  assert.equal(s.facility.rowCount('gh_trending', 'fav'), 0);
  assert.equal(await s.fav.get('tester-army/e2e'), null);
  const twice = await s.fav.remove('tester-army/e2e');
  assert.equal(twice.removed, false, '第二次移出没有东西可摘 —— 这个位是给回执说的，不是给界面猜的');
});

check('fav：list 按 addedAt 倒序（新收的在最上），装配侧只有这一种序', async () => {
  let at = 1000;
  const facility = makeFakeFacility();
  const fav = createFavStore({ getFacility: () => facility, now: () => at });
  for (const r of ['o/first', 'o/second', 'o/third']) { at += 1000; await fav.add({ repo: r, from: BOARD_LABELS.daily }); }
  const listed = await fav.list();
  assert.deepEqual(listed.map((x) => x.repo), ['o/third', 'o/second', 'o/first']);
  assert.equal(listed[0].addedAt, 4000, '最后收的那一位在最上（时钟每跳 1000，三发落的是 2000/3000/4000）');
});

check('★ fav：不裁行、不设上限、不参与 LRU（收藏久了不许被系统悄悄删掉 —— 与 repo 那张缓存表最大的不同）', async () => {
  const facility = makeFakeFacility();
  const fav = createFavStore({ getFacility: () => facility, now: () => 1000 });
  for (let i = 0; i < REPO_CACHE_MAX + 30; i += 1) await fav.add({ repo: `o/r${i}`, addedAt: 1000 + i, from: BOARD_LABELS.weekly });
  assert.equal(facility.rowCount('gh_trending', 'fav'), REPO_CACHE_MAX + 30,
    '按 at 裁那种 LRU 摆在这里等于把用户挑过的东西删掉；这一张表恒不裁');
  assert.equal((await fav.list()).length, REPO_CACHE_MAX + 30);
  assert.equal(REPO_CACHE_MAX > 30, true, '前提：详情缓存那张表确实有上限，这条对照才不是空说');
});

check('★ fav：schema 挡脏行 —— from 只认封闭五档（缺它整行 INVALID），越界与手打的串都进不来', async () => {
  const s = mk();
  await assert.rejects(() => s.fav.add({ repo: 'a/b', addedAt: 1000 }),
    (e) => e.code === RECORDS_ERROR.INVALID, '缺出处必须存不进去，而不是界面上念一句「—」');
  await assert.rejects(() => s.fav.add(favSeed({ from: '来自日榜' })),
    (e) => e.code === RECORDS_ERROR.INVALID, '拼错的出处是自由串，不是那一档');
  await assert.rejects(() => s.fav.add(favSeed({ from: '' })), (e) => e.code === RECORDS_ERROR.INVALID);
  assert.equal(s.facility.rowCount('gh_trending', 'fav'), 0, '三发全被挡 ⇒ 库里一个字都没落');
  await s.fav.add(favSeed({ from: FAV_FROM_DETAIL }));
  assert.equal((await s.fav.get('tester-army/e2e')).from, FAV_FROM_DETAIL);
  assert.deepEqual(FAV_FROM_SOURCES.slice(0, 3), BOARDS.map((b) => BOARD_LABELS[b]),
    '★ 前提：前三档由 BOARDS + BOARD_LABELS 派生（手抄就会在加榜那天漂），后两档是明星与详情');
  assert.deepEqual(FAV_FROM_SOURCES.slice(3), [FAV_FROM_STARS, FAV_FROM_DETAIL]);
});

check('fav：快照那五格缺位照样存得进（本机一个读数都没见过它时，那一行只有 repo / addedAt / from）', async () => {
  const s = mk();
  const r = await s.fav.add({ repo: 'never/seen', addedAt: 1000, from: FAV_FROM_DETAIL });
  assert.equal(r.row.stars, undefined, '没派生到就不许硬造 0 或空串（0 冒充"那一刻真是 0 星"）');
  assert.equal('desc' in r.row, false);
  assert.equal(s.facility.rowCount('gh_trending', 'fav'), 1);
});

check('fav：无设施时 available=false，读写都报 UNAVAILABLE（那一屏据此念「存储不可用」而不是「还没有收藏」）', async () => {
  const fav = createFavStore({ getFacility: () => undefined });
  assert.equal(fav.available, false);
  await assert.rejects(() => fav.list(), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => fav.get('a/b'), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => fav.add({ repo: 'a/b', from: BOARD_LABELS.daily }), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  await assert.rejects(() => fav.remove('a/b'), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
});

check('fav：写动作那两档是封闭枚举，且 domain 里只有一份（界面与路由各自抄一遍必漂）', () => {
  assert.deepEqual(FAV_ACTIONS, ['add', 'remove']);
  assert.deepEqual(Object.keys(GHT_DOMAIN.tables).sort(), ['events', 'fav', 'prefs', 'repo', 'search', 'seen', 'state', 'trans'],
    '★ 前提：`fav` 确实进了表名单（上面那条钉八表齐，这一条钉这张新表用的是同一份出处）');
});

check('★ fav：新表没有历史行，但从本轮起它自己也进了「已有表」那一侧 —— 三格必填是当时的口径，往后加必填键就是重演 10-07', () => {
  // 10-13 落纸时 `fav` 是空表，`repo` / `addedAt` / `from` 走 required* 安全（§8.15 ④ 那条改口）。
  // 这一条把"安全"的前提钉在盘上：少了这三格 parse 就抛 ⇒ 谁将来把它们改成 optional 或再往这张表塞必填键，都会在这里被点名。
  const schema = GHT_DOMAIN.tables.fav.valueSchema;
  assert.throws(() => schema.parse({ addedAt: 1000, from: BOARD_LABELS.daily }), undefined, '缺主键必须挡（三格都是 required）');
  assert.throws(() => schema.parse({ repo: 'a/b', from: BOARD_LABELS.daily }), undefined, '缺 addedAt 必须挡');
  assert.throws(() => schema.parse({ repo: 'a/b', addedAt: 1000 }), undefined, '缺出处必须挡');
  const minimal = schema.parse({ repo: 'a/b', addedAt: 1000, from: BOARD_LABELS.daily });
  assert.deepEqual(Object.keys(minimal).sort(), ['addedAt', 'from', 'repo'], 'parse 不凭空造那五格快照');
});await runAll('store');
