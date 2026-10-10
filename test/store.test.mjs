/**
 * test/store.test.mjs —— 仓储层（lib/stores.js + lib/domain.js 的 schema + kv-records-base 的域登记表）。
 *
 * 全部吃 test/_helpers.mjs 的假 storageDomain 设施：**entries() 返回 lazy iterator**（真实宿主同款），
 * 所以这里能钉住「忘了写 [...] 就当场失败」这一类坑，而不是靠人肉 review。
 * 断言的每条"血案口径"都对应 sysops / modelwatch 已踩过的坑，注释里点名。
 */
import { check, runAll, assert, makeFakeFacility } from './_helpers.mjs';
import {
  createStateStore, createEventStore, createSeenStore, createPrefsStore, createRepoCacheStore, createTransStore, createSearchStore, RECORDS_ERROR,
} from '../lib/stores.js';
import { BOARDS, DEFAULT_PREFS, GHT_DOMAIN, REPO_CACHE_MAX, REPO_ERROR_LABELS, TRANS_MAX, LLM_KINDS, PREF_CRED_FIELDS, SEARCH_ROW_SHAPE } from '../lib/domain.js';

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
  };
}

/** 每发一跳 1s 的时钟：events 的顺序断言要靠它（默认时钟恒等，专门测同毫秒发号）。 */
function advancing(start = 1000) {
  let at = start;
  return () => { at += 1000; return at; };
}

/* ---------------- 域与登记表 ---------------- */
check('域声明：gh_trending 名字与七表都过宿主正则，version 停在 1', () => {
  assert.equal(GHT_DOMAIN.name, 'gh_trending');   // 带连字符的插件名不能当域名（宿主 ^[a-z][a-z0-9_]*$）
  assert.deepEqual(Object.keys(GHT_DOMAIN.tables).sort(), ['events', 'prefs', 'repo', 'search', 'seen', 'state', 'trans']);
  // ★ 抬版本 = 本机那份 gh_trending.json 整个打不开：整档布局按 stored !== descriptor.version 直接抛
  //   version-mismatch（dsh-storage-json/lib/index.js:102），compatibleVersions 只对 per-record 布局生效。
  //   加一张表不需要抬版本 —— 文件里没有这张表就是空表起步（同文件 :111）。
  //   10-06 加 `trans`（译文表）时按这条律走过；10-08 加 `search`（全站高星那一批）时同一条律原样走。
  assert.equal(GHT_DOMAIN.version, 1, '要抬版本请先给出"老库怎么迁移"的证据，否则就是拿用户的榜史换版本号');
});

check('七表同域：同一设施只 open 一次（重复 open = already-open 血案）', async () => {
  const s = mk();
  await s.state.write('daily', stateRow('daily'));
  await s.events.append({ kind: 'baseline', detail: 'x' });
  await s.seen.touch({ repo: 'a/b', name: 'A/B', repoId: 1, board: 'daily', at: 1000 });
  await s.prefs.patch({ topN: 9 });
  await s.repo.put(repoRow());
  await s.trans.put(transRow());
  assert.equal(s.facility.calls.open, 1, '六张表各自 open 就会撞 already-open');
  assert.equal(s.facility.rowCount('gh_trending', 'state'), 1);
  assert.equal(s.facility.rowCount('gh_trending', 'prefs'), 1);
  assert.equal(s.facility.rowCount('gh_trending', 'repo'), 1);
  assert.equal(s.facility.rowCount('gh_trending', 'trans'), 1);
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
  await s.repo.close();
  await s.prefs.close();
  await s.events.close();
  await s.seen.close();
  await s.trans.close();
  assert.equal(s.facility.calls.close, 1, '六个持有者全放手 ⇒ 恰好真关一次');
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

check('repo：行数超过上限按最老的裁（点过的仓库不能无限堆在 KV 域里）', async () => {
  const facility = makeFakeFacility();
  const repo = createRepoCacheStore({ getFacility: () => facility, maxRows: 3, logger: { warn: () => {} } });
  for (let i = 0; i < 5; i += 1) await repo.put(repoRow({ repo: `o/r${i}`, at: 1000 + i }));
  const listed = await repo.list();
  assert.deepEqual(listed.map((x) => x.key), ['o/r4', 'o/r3', 'o/r2']);
  assert.equal(listed[0].ok, true);
  assert.equal(await repo.get('o/r0'), null, '最老的那行该被裁掉');
  assert.equal(facility.rowCount('gh_trending', 'repo'), 3);
  assert.equal(REPO_CACHE_MAX > 3, true, '出厂上限是宽松档，用例才敢用小值注入');
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
  assert.deepEqual(LLM_KINDS, ['desc', 'readme'], '枚举加了新档就要连这条一起看：闸门只认这一份');
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

check('★ prefs：详情缓存档（第十二轮）撤销后，老库里多出来的那一格既不读出来也写不进去（撤档要撤干净）', async () => {
  // 用户裁定「撤掉这一行，改成固定 60 秒防连点」⇒ 界面上没有那一档，库里就不该再有它的读数（第二份真相）。
  // ★ 方向性取证在 `tmp/probe-schema-drop.mjs`（真 schema + 真仓储读路径，10-10 留档）：
  //   未声明的多余键被 record() **静默丢掉**、不报错 ⇒ 老库那一行照常 parse 得过，撤格方向安全。
  const s = mk();
  const p = await s.prefs.read();
  assert.equal('repoCacheHours' in p, false, 'clampPrefs 还在补这一格 ⇒ 载荷里躺着一个界面上没有的档位');
  assert.equal('repoCacheHours' in DEFAULT_PREFS, false, '出厂偏好里还留着它 ⇒ 撤档只撤了界面，链没拆完');

  // 写路径：patch 的回显吃的是 merged（对**任何**未知键都原样带回，这是既有语义），
  //   真正入库的那一份过 schema ⇒ 那一格落不进库，下一次 read 就没有它。★ 断的是"存不下来"，不是"不回显"。
  await s.prefs.patch({ repoCacheHours: 6 });
  const afterPatch = await s.prefs.read();
  assert.equal('repoCacheHours' in afterPatch, false, '老键又能被写进库 ⇒ 界面没有它的去处，库里却攒了一份读不出来的历史');

  // 读路径：老库存里真躺着那一格（第十~二十六轮的用户库就是这么一份）⇒ parse 得过，读出来没有它
  const legacyRow = { ...DEFAULT_PREFS, repoCacheHours: 6, zzUnknownKey: '留给下一版的垃圾' };
  assert.doesNotThrow(() => GHT_DOMAIN.tables.prefs.valueSchema.parse(legacyRow),
    '老库里多出来的一格挡在 open 里 ⇒ 三榜全红「存储不可用」（第十三轮那把尺子量的是同一个方向）');
  s.facility.seed('gh_trending', 'prefs', 'prefs', GHT_DOMAIN.tables.prefs.valueSchema.parse(legacyRow));
  const back = await s.prefs.read();
  assert.equal('repoCacheHours' in back, false, '未声明的旧键渗进了运行时 ⇒ 客户端会读到一个界面上摆不出来的档位');
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

await runAll('store');
