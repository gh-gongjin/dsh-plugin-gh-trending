/**
 * test/search.test.mjs —— 「检索」那一屏的编排与载荷视图（第三十六轮，spec §8.18）。
 *
 * 这一屏有三条律，每条都可能"看着对而其实没牙"，判据按那三条分：
 *  · **那一发的形状**（⑧-1）：用户输入的词**原样**交给 GitHub —— 不加 ★ 门槛、不带 `sort`/`order`，
 *    `per_page` 吃 domain 那个常数。★ 反面是"参数化时把默认那一路改漂"，那一半的夹具在 `test/repo.test.mjs`。
 *  · **闸门只有一把**（⑧-2）：并发第二问**压根没出发** ⇒ 判据数的是替身调用次数，不是返回值
 *    （数返回值的话，"发了但把结果丢了"和"没发"长得一样）。
 *  · **零入库 + 不广播 + 六句全在 domain**（⑧-3 / ⑧-8）：这一屏的载荷是一次性提问的结果，
 *    视图是纯函数、runner 的入参名单里没有任何仓储/广播的位子 —— 路由层那"八张表逐张写 0 次"归 `test/api.test.mjs`。
 * ⚠️ `empty` 与 `error` 是两件事（零行是**答案**，故障是**没答案**）：两条判据不许互为影子，
 *    所以这里既比句子也比**载荷形状**（`ok` / `errKey` / `rows` 三处都能拿到失败信号）。
 */
import { check, runAll, assert } from './_helpers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSearchRunService, searchView } from '../lib/services/search-run.js';
import { searchRepoUrl, searchRepositories, createSearchFetcher } from '../lib/services/repo.js';
import { descZhHits } from '../lib/board-zh.js';
// ★ 归一后的原文只能由库里那一份函数给出（测试里自己 `replace(/\s+/g,' ')` 就是第二份真相）。
import { transSrcKey } from '../lib/services/llm.js';
import {
  SEARCH_PER_PAGE, SEARCH_RATE_ANON, SEARCH_STARS_FLOOR, SEARCH_STATES, SEARCH_STATE_LABELS,
  SEARCH_COL_STARS, SEARCH_COL_FAV, searchStateLine, starsQuotaLine,
  STARS_MISSING_CELL, SEARCH_ROW_SHAPE, GITHUB_API_BASE,
} from '../lib/domain.js';

const NOW = () => 1_760_000_000_000;
const DAY = 24 * 3600 * 1000;

/** 回包 items 的一行（★ 键名照 GitHub 的原始字段，不是 `SEARCH_ROW_SHAPE` 那六格 —— 这一层要的是"从线上形状折过来"）。 */
const item = (full, stars, over = {}) => ({
  full_name: full, stargazers_count: stars, description: 'd', language: 'Go', ...over,
});
/**
 * 假 fetch：只登记 search 那一条路径，把 URL / 请求头逐发记下来。
 * ★ `seen` 是本套件唯一的"发没发"证据源 —— 在飞锁那条判据数它，不数返回值。
 */
function makeSearchFetch({ items = [], status = 200, text, headers = {} } = {}) {
  const seen = [];
  const fetchFn = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers ?? {}, signal: opts.signal });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (headers[String(k).toLowerCase()] ?? null) },
      text: async () => (text ?? JSON.stringify({ total_count: items.length, incomplete_results: false, items })),
      json: async () => JSON.parse(text ?? '{}'),
    };
  };
  fetchFn.seen = seen;
  return fetchFn;
}
const RATE_HEADERS = {
  'x-ratelimit-limit': String(SEARCH_RATE_ANON),
  'x-ratelimit-remaining': '9',
  'x-ratelimit-reset': String(Math.floor(NOW() / 1000) + 600),
};

/** 成功回包折形（★ 形状逐格对齐 `searchRepositories()`，视图判态吃的就是这几格）。 */
const okResult = (rows, over = {}) => ({
  ok: true, at: NOW(), rate: { left: 9, limit: SEARCH_RATE_ANON, resetAt: NOW() + 10 * 60_000, authed: false }, rows, ...over,
});
const badResult = (over = {}) => ({
  ok: false, at: NOW(), rate: {}, errKey: 'fail_5xx', errText: 'GitHub 回了 500：boom', transport: false, ...over,
});
const vrow = (repo, over = {}) => ({
  rank: 1, repo, name: repo, desc: 'English only', lang: 'Go', stars: 12, ...over,
});
/** 视图的六格键表（从 domain 的 shape 派生，视图另加的两格单独点名 ⇒ 用例里不手抄七个名字）。 */
const VIEW_ROW_KEYS = [...Object.keys(SEARCH_ROW_SHAPE), 'descZh', 'favSaved'].sort();

/* ---------------- ⑧-1 手动那一路：那一发的 URL 逐条点名 ---------------- */

check('★ searchRepoUrl({query})：无 sort、无 order、无 stars: 门槛，q 就是那个词本身，per_page 吃常数', () => {
  const url = searchRepoUrl({ query: 'rust http client' });
  assert.ok(url.startsWith('/search/repositories?'), `路径形状变了：${url}`);
  const qs = new URL(`${GITHUB_API_BASE}${url}`).searchParams;
  assert.equal(qs.get('q'), 'rust http client', '解码回来必须是那个词本身：加门槛、改排序都在这里漂');
  assert.equal(qs.get('per_page'), String(SEARCH_PER_PAGE), '每页行数不吃调用端给的数（屏上那句 note 念的就是这个常数）');
  assert.equal(qs.get('page'), '1');
  // ★ 三条"不该有"的：手动那一路没有 sort / order（回的是相关度），也没有 stars 门槛。
  assert.equal(qs.get('sort'), null, `手动那一发带了 sort=${qs.get('sort')} ⇒ 屏上那句"按相关度排"成了假话`);
  assert.equal(qs.get('order'), null, `手动那一发带了 order=${qs.get('order')} ⇒ 同上`);
  assert.ok(!qs.get('q').includes('stars:'), `q 里被塞了门槛：${qs.get('q')} ⇒ 用户搜的小众仓库会被这道★线整批滤掉`);
  assert.ok(!/^[a-z][a-z0-9+.-]*:\/\//i.test(url), 'URL 里带 scheme ⇒ 域名不只 domain 那一份（hc-7 扫这一格）');
});

check('★ 词原样交出：用户自己写的门槛与比较符照原样编码，插件不替他改写查询', async () => {
  // 用户输入 `stars:>100` 是**他的**门槛，不是插件加的 ⇒ 逐字交出且必须编码（未编码的 > GitHub 给 422）。
  const f = makeSearchFetch({ items: [item('a/b', 5)] });
  await searchRepositories({ query: '  stars:>100 lang:rust  ', fetchFn: f, now: NOW });
  const qs = new URL(f.seen[0].url).searchParams;
  assert.equal(qs.get('q'), 'stars:>100 lang:rust', '首尾空白照 trim（那是路由口径），但词本身一个字都不加工');
  assert.ok(f.seen[0].url.includes('%3E'), '比较符没编码就发出去 ⇒ GitHub 422，屏上念"那一发没成"而用户以为是搜不到');
  // 中文 / # / & 三类都会撞查询串分隔符：解码回来必须逐字相等
  for (const word of ['中文 项目', 'c#', 'golang&rust', 'a+b']) {
    const g = makeSearchFetch({ items: [] });
    await searchRepositories({ query: word, fetchFn: g, now: NOW });
    assert.equal(new URL(g.seen[0].url).searchParams.get('q'), word, `${word} 编码一圈回来变了形状`);
  }
});

check('那一发只许一发：URL 由 searchRepoUrl 现拼，本层不补发也不翻页', async () => {
  const f = makeSearchFetch({ items: Array.from({ length: 3 }, (_, i) => item(`a/r${i}`, i + 1)), headers: RATE_HEADERS });
  const d = await searchRepositories({ query: 'rust', fetchFn: f, now: NOW });
  assert.equal(f.seen.length, 1, '本层补了第二发 ⇒ 手动那一屏的"一次点击最多一发"由这里破');
  assert.equal(d.rows.length, 3);
  assert.deepEqual(d.rows.map((r) => r.rank), [1, 2, 3], '位次是回包原样顺序的 index+1，不重编号');
  assert.equal(d.rate.authed, false, `search 的匿名档没按 SEARCH_RATE_ANON(${SEARCH_RATE_ANON}) 判 ⇒ 拿 core 的 60 当这一池子的底`);
  assert.equal(new URL(f.seen[0].url).pathname, '/search/repositories');
});

check('★ 同一颗闭包两个入口：无参调用仍是全站高星那一串（明星那一路零改动），带词才是手动那一串', async () => {
  const f = makeSearchFetch({ items: [item('a/b', 1)], headers: RATE_HEADERS });
  const fetcher = createSearchFetcher({ fetchFn: f, now: NOW, getGhToken: () => '' });
  await fetcher();
  await fetcher('vite');
  assert.equal(f.seen.length, 2);
  const def = new URL(f.seen[0].url).searchParams;
  assert.equal(def.get('q'), `stars:>=${SEARCH_STARS_FLOOR}`, '无参那一发被本轮参数化改漂 ⇒ 「全站高星」那一档问的是别的东西');
  assert.equal(def.get('sort'), 'stars');
  const man = new URL(f.seen[1].url).searchParams;
  assert.equal(man.get('q'), 'vite');
  assert.equal(man.get('sort'), null);
});

check('令牌只进请求头：手动那一发同样不带 authorization（没令牌时），递了才进头而 URL 一个字不沾', async () => {
  const TOKEN = 'ghp_SECRET_for_test_only';
  const anon = makeSearchFetch({ items: [] });
  await searchRepositories({ query: 'x', fetchFn: anon, now: NOW });
  assert.equal(Object.keys(anon.seen[0].headers).some((k) => String(k).toLowerCase() === 'authorization'), false,
    '没令牌也发 authorization ⇒ 空头会被 GitHub 当成坏凭据');
  const authed = makeSearchFetch({ items: [], headers: { 'x-ratelimit-limit': '30' } });
  await searchRepositories({ query: 'x', fetchFn: authed, now: NOW, ghToken: TOKEN });
  const hdr = authed.seen[0].headers;
  const key = Object.keys(hdr).find((k) => String(k).toLowerCase() === 'authorization');
  assert.equal(hdr[key], `Bearer ${TOKEN}`, '令牌的接线形状变了（Bearer 前缀 / 头名）⇒ 配额档位认不出来');
  assert.equal(/ghp_|Bearer/.test(authed.seen[0].url), false, '令牌进了 URL ⇒ 留在代理与访问日志里');
  assert.equal(authed.seen[0].signal instanceof AbortSignal, true, '没接 AbortController ⇒ 超时那一发还挂着而闸门已把它算成发过');
});

/* ---------------- ⑧-2 在飞锁有牙 ---------------- */

check('★ 并发第二问压根没出发：数替身调用次数（返回值相同也不认），回执 busy=true', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const svc = createSearchRunService({
    fetchBatch: async (q) => { calls.push(q); await gate; return okResult([vrow('a/one')]); },
    now: NOW,
  });
  const p1 = svc.ask('one');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(svc.isBusy(), true, '第一发在飞而 isBusy() 说没在飞 ⇒ 闸门与状态两处各记一本账');
  const p2 = svc.ask('two');
  // ★ 这里必须限时：闸一拆，第二问就不「当场回 busy」而是挂在那条没释放的 gate 上 ⇒ 用例跟着挂住、
  //   进程静默退出、电池拿不到红（第三十六轮证伪第 3 发首跑正是这个形状，判据要自己会响）。
  let b;
  try {
    b = await Promise.race([p2, new Promise((_, rej) => {
      setTimeout(() => rej(new Error('第二问没有当场返回：它在等第一发 ⇒ 在飞锁被拆掉了（连点两下会出发两发，配额照烧）')), 200);
    })]);
  } catch (e) {
    release();
    await p1;
    assert.fail(String(e?.message ?? e));
  }
  assert.equal(b.busy, true, '第二问没被闸住（busy=false）⇒ 界面那会儿看到的是两次提问');
  assert.equal(b.result, null, 'busy 那一支还带回包 ⇒ 闸门口径变成了"发完再丢掉"');
  assert.equal(calls.length, 1, `替身被打过 ${calls.length} 次 ⇒ "在飞锁"退化成"结果丢弃器"，配额照样两次烧`);
  assert.deepEqual(calls, ['one']);
  release();
  const a = await p1;
  assert.equal(a.busy, false);
  assert.equal(a.result.ok, true);
});

check('★ 锁真的会放：第一发结算后第三问照样出发（两问连续 ⇒ 都发，这里不自建一小时计数账本）', async () => {
  const calls = [];
  const svc = createSearchRunService({
    fetchBatch: async (q) => { calls.push(q); return okResult([vrow('a/one')]); },
    now: NOW,
  });
  const a = await svc.ask('one');
  assert.equal(svc.isBusy(), false, '结算完还在忙 ⇒ 面板永远按不动第二问');
  const b = await svc.ask('two');
  assert.equal(calls.length, 2, `连着两问替身只被打 ${calls.length} 次 ⇒ 本轮自己记了一本小时账（额度要吃回包，§8.18 ⑦）`);
  assert.equal(a.busy, false);
  assert.equal(b.busy, false);
  assert.equal(b.result.ok, true);
});

check('空词不发那一发：ask 收到空白直接给空结果（400 是路由层的事，这里再兜一道）', async () => {
  const calls = [];
  const svc = createSearchRunService({ fetchBatch: async (q) => { calls.push(q); return okResult([]); }, now: NOW });
  for (const bad of ['', '   ', null, undefined]) {
    const r = await svc.ask(bad);
    assert.equal(r.busy, false);
    assert.equal(r.result, null);
  }
  assert.equal(calls.length, 0, '空词也被发出去 ⇒ GitHub 回一句它不懂的错，界面上是假故障');
});

check('那一发抛错不 rethrow：折成失败形状、锁释放、日志里留一句', async () => {
  const warns = [];
  const svc = createSearchRunService({
    fetchBatch: async () => { throw new Error('socket hang up'); },
    logger: { warn: (m) => warns.push(String(m)) },
    now: NOW,
  });
  const r = await svc.ask('boom');
  assert.equal(r.busy, false);
  assert.equal(r.result.ok, false, '抛错被原样抛穿 ⇒ 路由那一发变 5xx，而屏上该念的是 GitHub 的答案（§8.18 ③）');
  assert.equal(r.result.errKey, 'transport');
  assert.equal(r.result.transport, true);
  assert.equal(svc.isBusy(), false, '抛错那一路没解闸 ⇒ 一次断网把这一屏永久锁死');
  assert.ok(warns.length >= 1, '抛错不留日志 ⇒ 真机排查只能靠用户复述');
  const second = await svc.ask('again');
  assert.equal(second.result.ok, false, '闸解开后仍要真问第二发（这里断言"能再问"而不是"结果对"）');
});

check('★ runner 的入参名单里没有仓储/广播（零入库是结构事实，不是注释）', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/services/search-run.js', import.meta.url)), 'utf8');
  const at = src.indexOf('export function createSearchRunService');
  assert.ok(at >= 0, '读不到工厂签名 ⇒ 下面那条键表是在空气上绿灯');
  const open = src.indexOf('({', at);
  const close = src.indexOf('} = {})', at);
  assert.ok(open > at && close > open, '签名形状不是 `({ … } = {})` ⇒ 键表会少报，判据红在切错而不是代码错');
  const keys = src.slice(open + 2, close).split(',').map((p) => p.split('=')[0].trim()).filter(Boolean);
  assert.deepEqual(keys.sort(), ['fetchBatch', 'logger', 'now'],
    `编排层的入参变成了 ${keys.join(', ')} ⇒ 多一格就是往"零入库/不广播"那一裁定里开一个口子`);
});

/* ---------------- ⑧-3 视图是纯的：不发、不读库、不写库 ---------------- */

check('searchView 函数体里没有出网与仓储的形状（fetch/await/Store/hub/Date.now 一概不许出现）', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/services/search-run.js', import.meta.url)), 'utf8');
  // ★ 先按**带注释的原文件**切出函数体（切到下一个导出为止），再抠注释：反过来切就会卡在注释里的 `*/` 上，
  //   而"抠没抠注释"决定 `fetch` 这类词是被扫到还是被放过 —— 这一条钉的是判据自己不许扫空气。
  const at = src.indexOf('export function searchView');
  const next = src.indexOf('export function createSearchRunService', at + 1);
  assert.ok(at >= 0 && next > at, '读不到 searchView 的函数体 ⇒ 下面那几条扫描是在空气上绿灯');
  const body = src.slice(at, next).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(body.includes('return {') && body.includes('stateLabels'),
    `切出来的那段不像完整函数体（${body.length} 字）⇒ 边界切错了，扫描等于没扫`);
  for (const banned of [/fetch/, /await/, /\bStore\b/, /hub/, /Date\.now/, /Math\.random/]) {
    assert.equal(banned.test(body), false, `视图里出现「${banned}」⇒ 纯函数不再纯，同一份入参两帧能给出不同载荷`);
  }
});

check('载荷行只带六格 + descZh + favSaved：GitHub 的其余字段一个字不进（多余键就是第二份真相）', () => {
  const v = searchView({
    result: okResult([vrow('a/one', { extra: 'x', owner: { login: 'a' }, score: 1234 })]),
  });
  assert.deepEqual(Object.keys(v.rows[0]).sort(), VIEW_ROW_KEYS, `行键表变了：${Object.keys(v.rows[0]).join(', ')}`);
  assert.equal('extra' in v.rows[0], false);
  assert.equal('score' in v.rows[0], false);
});

check('★ 视图逐格折形：repo 折小写而 name 保留 GitHub 写法、rank 非数落 0、缺 desc/lang 给空串', () => {
  const v = searchView({
    result: okResult([{ rank: undefined, repo: 'Vitejs/Vite', name: 'Vitejs/Vite', desc: undefined, lang: undefined, stars: 10 }]),
  });
  const r = v.rows[0];
  assert.equal(r.repo, 'vitejs/vite');
  assert.equal(r.name, 'Vitejs/Vite', '显示名被折成小写 ⇒ 屏上与 GitHub 上看到的不是同一个写法');
  assert.equal(r.rank, 0);
  assert.equal(r.desc, '');
  assert.equal(r.lang, '');
});

check('★ 星数缺位不演成 0：非有限数落 null 而缺位符由 domain 给（那一格画 0 就是"这个仓库没有星"）', () => {
  const v = searchView({
    result: okResult([vrow('a/one', { stars: '1234' }), vrow('a/two', { stars: NaN }), vrow('a/three', { stars: undefined })]),
  });
  assert.equal(v.rows[0].stars, 1234, '字符串星数不折成数 ⇒ 排序与比较在界面侧失灵');
  assert.equal(v.rows[1].stars, null, 'NaN 进了载荷 ⇒ JSON 里变成 null 但屏上曾经画过它');
  assert.equal(v.rows[2].stars, null);
  assert.equal(v.missingCell, STARS_MISSING_CELL, '缺位符由宿主给，客户端不自造（§8 一份真相）');
});

/* ---------------- ⑧-8 六态各一句，句子来自 domain ---------------- */

check('★ 六态各一句且句子逐字等于 domain 的那一份（客户端与视图都不许自己圆）', () => {
  const cases = [
    ['idle', undefined, 0, ''],
    ['asking', undefined, 0, ''],
    ['ok', okResult([vrow('a/one'), vrow('a/two')]), 2, ''],
    ['empty', okResult([]), 0, ''],
    ['limited', badResult({ errKey: 'rate_limited', errText: '限额用尽（403，重置于 2026/10/14 12:00:00）' }), 0, '限额用尽（403，重置于 2026/10/14 12:00:00）'],
    ['error', badResult(), 0, 'GitHub 回了 500：boom'],
  ];
  const notes = [];
  for (const [state, result, count, reason] of cases) {
    const v = searchView({ result, query: 'rust http', descHits: null, favRows: null, asking: state === 'asking' });
    assert.equal(v.state, state, `${state} 那一形被判成了 ${v.state}`);
    assert.equal(v.stateLabel, SEARCH_STATE_LABELS[state]);
    const want = searchStateLine({ state, query: 'rust http', count, reason });
    assert.equal(v.stateNote, want, `${state} 那一句与 domain 那份不等 ⇒ 视图自己圆了一句`);
    notes.push(v.stateNote);
  }
  assert.equal(new Set(notes).size, 6, '六句里有两句一字不差 ⇒ 六态在屏上长得一样，用户分不出空结果与故障');
  // ★ 六枚短名单原样带上（客户端按 state 取字，不抄第二份名单）
  assert.deepEqual(searchView({}).stateLabels, SEARCH_STATE_LABELS);
  assert.deepEqual(searchView({}).stateLabels, Object.fromEntries(SEARCH_STATES.map((s) => [s, SEARCH_STATE_LABELS[s]])));
});

check('★ empty 与 error 的载荷形状可区分：三处都能拿到失败信号，两条判据不互为影子', () => {
  const e = searchView({ result: okResult([]), query: 'zzz' });
  const f = searchView({ result: badResult({ errKey: 'fail_5xx', errText: 'GitHub 回了 500' }), query: 'zzz' });
  assert.equal(e.state, 'empty');
  assert.equal(f.state, 'error');
  assert.equal(e.ok, true, '空结果的 ok 被折成 false ⇒ "GitHub 的答案"与"没答案"在载荷上又混了');
  assert.equal(f.ok, false);
  assert.equal(e.errKey, '');
  assert.equal(f.errKey, 'fail_5xx');
  assert.notEqual(e.stateNote, f.stateNote);
  assert.deepEqual(e.rows, []);
  assert.deepEqual(f.rows, []);
  // ★ 坏结果**不**保留上一批：这一屏零入库，坏了就是空着（与榜面"坏轮冻结"反向）
  assert.equal(f.count, 0);
});

check('认不出的失败键念故障而不是念成功：state 名单外的形状一律 error（缺位不许演成 idle）', () => {
  const v = searchView({ result: badResult({ errKey: 'brand_new_key' }) });
  assert.equal(v.state, 'error');
  const w = searchView({ result: { ok: 'yes', rows: [vrow('a/one')] } });
  assert.equal(w.state, 'error', 'ok 给了字符串"yes"就判成功 ⇒ 载荷形状漂了屏上还摆结果');
  const x = searchView({ result: { ok: true } });
  assert.equal(x.state, 'empty', '成功但没有 rows 数组应念"没回仓库"，不许崩也不许念 idle');
});

check('asking 优先于回包：那一会儿屏上念"正在问"，不抢跑把上一发的结果摆出来', () => {
  const v = searchView({ result: okResult([vrow('a/one')]), query: 'one', asking: true });
  assert.equal(v.state, 'asking');
  assert.deepEqual(v.rows, [], 'asking 那一态还带行 ⇒ 在问的那一会儿屏上是旧结果');
  assert.equal(v.stateNote, searchStateLine({ state: 'asking' }));
});

check('★ 快照那一格（恒 idle、恒零行）带着 asking 那一句：客户端在飞的那一会儿不造文案也有话说', () => {
  const base = searchView({});
  assert.equal(base.state, 'idle');
  assert.deepEqual(base.rows, []);
  assert.equal(base.count, 0);
  assert.equal(base.ok, null, '没问过却回 ok=false ⇒ 首帧会被界面念成"那一发没成"');
  assert.equal(base.query, '');
  assert.equal(base.askingNote, searchStateLine({ state: 'asking' }),
    'asking 那句不在快照那一格里 ⇒ POST 还没回的时候客户端要么空白要么自己编（§8 一份真相）');
  assert.equal(/rust|个仓库/.test(base.askingNote), false, 'asking 那句含词或条数 ⇒ 快照那一格就成了"带着上一次结果"的形状');
  assert.equal(base.statLine, '', '没问过就把额度那三个数摆出来 ⇒ 屏上会出现一组没来源的数');
  // ★ 第三十六轮 ⑫ 追加改判（用户 10-14 看过屏后指着卡脚那段长说明说「这个东西删掉」）：那一格整条撤干净，
  //   载荷里连 `note` 这个键都不许留 —— 留着就是"屏上不念但面还在做"，下一轮想撤就得先找谁在读它。
  assert.equal('note' in base, false, '卡脚那句又回到载荷里 ⇒ 用户划掉的那一段复辟了');
});

check('额度那一行复用 starsQuotaLine（★ 不另立第二份句子），四个数全吃回包', () => {
  const v = searchView({ result: okResult([vrow('a/one')], { rate: { left: 3, limit: SEARCH_RATE_ANON, resetAt: NOW() + DAY, authed: false } }) });
  assert.equal(v.statLine, starsQuotaLine({
    at: NOW(), left: 3, limit: SEARCH_RATE_ANON, resetAt: NOW() + DAY, authed: false,
  }));
  const authed = searchView({ result: okResult([vrow('a/one')], { rate: { left: 27, limit: 30, resetAt: NOW() + DAY, authed: true } }) });
  assert.notEqual(authed.statLine, v.statLine, '已认证与匿名念同一句 ⇒ 用户看不出令牌生效没');
});

/* ---------------- ⑧-5 中文那一格 + ☆ 点亮态 ---------------- */

check('★ 中文那一格：命中上屏 / 没命中念原文（desc 恒是 GitHub 那句，缺位不给占位符）', () => {
  const rows = [vrow('a/hit'), vrow('a/miss', { desc: 'Plain English' })];
  // ★ 逐字比对用的是库里那一份口径（`transSrcKey`）：测试里自己 `.replace(/\s+/g,' ')` 就是第二份真相。
  const transRows = [{ kind: 'desc', repo: 'a/hit', src: transSrcKey('English only'), zh: '只有英文', engine: 'keyless', at: NOW() }];
  const { hits } = descZhHits(rows, transRows);
  const v = searchView({ result: okResult(rows), descHits: hits });
  assert.equal(v.rows[0].descZh.zh, '只有英文');
  assert.equal(v.rows[0].descZh.via, 'live', '命中那一格的形状由 descZhHits 给（视图不重造一份 {zh} ⇒ 卡头上的来源标签会丢）');
  assert.equal(v.rows[0].desc, 'English only', '中文覆盖了 desc ⇒ 屏上与载荷同名不同值');
  assert.equal(v.rows[1].descZh, null, '没命中给了空串 ⇒ 界面画一个空格子，用户以为是"翻译成了空"');
  assert.equal(v.rows[1].desc, 'Plain English', '没命中时念的还是原文（★ 不是缺位符）');
  const noFeed = searchView({ result: okResult(rows) });
  assert.equal(noFeed.rows[0].descZh, null, '没喂命中表时视图自己去查 ⇒ 零出网那一裁定破在这一格');
  // ★ 原文变一个字的旧译文不能用（宁可退回原文也不冒充）
  const stale = searchView({
    result: okResult([vrow('a/hit', { desc: 'English only!' })]),
    descHits: descZhHits([vrow('a/hit', { desc: 'English only!' })], transRows).hits,
  });
  assert.equal(stale.rows[0].descZh, null, '原文变了而译文照上屏 ⇒ 拿旧译文冒充新描述');
});

check('☆ 点亮态只看"这一行收过没有"：主键归一，且不复制收藏那一屏的任何读数', () => {
  const v = searchView({
    result: okResult([vrow('a/one'), vrow('a/two')]),
    favRows: [{ repo: 'A/One ' }, { repo: '  ' }, null],
  });
  assert.equal(v.rows[0].favSaved, true, '大小写与首尾空白没归一 ⇒ 已收藏的行画成未收藏，用户点第二下变成 remove');
  assert.equal(v.rows[1].favSaved, false);
  assert.equal('addedAt' in v.rows[0], false, '检索行跟着带上收藏那一屏的读数 ⇒ 一处两份"什么时候收的"');
  assert.equal(v.cols.stars, SEARCH_COL_STARS, '列名不吃常数 ⇒ 与明星屏那一份口径分叉');
  assert.equal(v.cols.fav, SEARCH_COL_FAV);
});

check('★ 载荷键表封闭：视图多一格就是第二个住处（六列 + 状态 + 文案 + 额度 + 失败信号）', () => {
  const v = searchView({ result: okResult([vrow('a/one')]), query: 'one' });
  assert.deepEqual(Object.keys(v).sort(), [
    'askingNote', 'cols', 'count', 'errKey', 'errText', 'missingCell', 'ok',
    'query', 'rows', 'state', 'stateLabel', 'stateLabels', 'stateNote', 'statLine', 'transport',
  ].sort(), `载荷键表变了：${Object.keys(v).sort().join(', ')}`);
});

await runAll('search');
