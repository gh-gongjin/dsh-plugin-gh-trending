/**
 * test/gh.test.mjs —— 抓取与解析层（lib/services/gh.js）。
 * 断言的读数全部来自 2026-10-04 的 S0 探针（tmp/probe-gh*.txt）与 test/fixtures/*（源页面切片）。
 */
import { check, runAll, assert, fixture, makeFakeFetch } from './_helpers.mjs';
import {
  parseCount, sliceArticles, titleLanguage, parseArticle, parseTrendingHtml,
  trendingUrl, normalizeLanguage, fetchTrendingBoard, checkLanguageSlug,
} from '../lib/services/gh.js';

const DAILY = await fixture('gh-daily.html');
const WEEKLY = await fixture('gh-weekly.html');
const MONTHLY = await fixture('gh-monthly.html');
const RUST = await fixture('gh-lang-rust.html');
const EMPTY_BF = await fixture('gh-empty-brainfuck.html');
const UNKNOWN = await fixture('gh-unknown-lang.html');

/* ---------------- 数字与形状 ---------------- */
check('parseCount：千分位 / 空 / 无数字 / 小数读数', () => {
  assert.equal(parseCount('\n        75,859'), 75859);
  assert.equal(parseCount('344 stars today'), 344);
  assert.equal(parseCount('1,170 stars this week'), 1170);
  assert.equal(parseCount('1.5k'), null);           // 页面无此写法：读不出就说读不出，不交把 1.5k 读成 2 的假数
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('no digits'), null);
  assert.equal(parseCount(null), null);
});

check('normalizeLanguage：大小写与空白归一，脏值拒', () => {
  assert.deepEqual(normalizeLanguage(' Rust '), { ok: true, slug: 'rust' });
  assert.equal(normalizeLanguage('Jupyter Notebook').ok, false); // 空格不在白名单（真实语言名 ≠ 页面 slug）
  assert.match(normalizeLanguage('Jupyter Notebook').reason, /形状不合法/);
  assert.equal(normalizeLanguage('').ok, true);
  assert.equal(normalizeLanguage('').slug, '');
  assert.equal(normalizeLanguage('c++').ok, false);
  assert.equal(normalizeLanguage('-rust').ok, false);
  assert.equal(normalizeLanguage('a'.repeat(45)).ok, false);
  assert.equal(normalizeLanguage(42).ok, false);
  assert.deepEqual(normalizeLanguage('objective-c'), { ok: true, slug: 'objective-c' });
});

check('trendingUrl：全站 / 单语言 / since 与 slug 的白名单闸门', () => {
  assert.equal(trendingUrl({ board: 'daily' }), 'https://github.com/trending?since=daily');
  assert.equal(trendingUrl({ board: 'monthly', language: 'rust' }), 'https://github.com/trending/rust?since=monthly');
  assert.throws(() => trendingUrl({ board: 'bogus' }), /未知榜/);   // 实测 ?since=bogus 静默返回日榜 ⇒ 只能在这里挡
  assert.throws(() => trendingUrl({ board: 'daily', language: 'c++' }), /形状不合法/);
});

/* ---------------- 页面切片与标题 ---------------- */
check('sliceArticles：夹具条目数与生成时的读数一致', () => {
  assert.equal(sliceArticles(DAILY).length, 9);
  assert.equal(sliceArticles(WEEKLY).length, 10);
  assert.equal(sliceArticles(MONTHLY).length, 6);
  assert.equal(sliceArticles(RUST).length, 4);
  assert.equal(sliceArticles(EMPTY_BF).length, 0);
});

check('titleLanguage：全站页不念语言、单语言页念（实测判据）', () => {
  assert.equal(titleLanguage(DAILY), '');            // 真机标题里 "Trending  repositories"（双空格）也必须判空
  assert.equal(titleLanguage(RUST), 'rust');
  assert.equal(titleLanguage(EMPTY_BF), 'brainfuck');
  assert.equal(titleLanguage('<title>Trending C++ repositories on GitHub today</title>'), 'c++');
});

check('parseArticle：日榜第 1 条的逐字段读数', () => {
  const row = parseArticle(sliceArticles(DAILY)[0], 0);
  assert.equal(row.repo, 'tester-army/e2e');
  assert.equal(row.name, 'tester-army/e2e');     // 页面原文大小写
  assert.equal(row.repoId, 1308631234);
  assert.equal(row.stars, 2474);
  assert.equal(row.added, 344);
  assert.equal(row.forks, 96);
  assert.equal(row.lang, 'TypeScript');
  assert.equal(row.langColor, '#3178c6');
  assert.match(row.desc, /Next generation e2e testing/);
  assert.equal(row.rank, 1);
});

check('parseArticle：无描述行给出空串而不是 null / 缺字段', () => {
  const chunks = sliceArticles(DAILY);
  const row = parseArticle(chunks[8], 8);       // 实测第 9 条 pingdotgg/t3code 整条无 <p>
  assert.equal(row.repo, 'pingdotgg/t3code');
  assert.equal(row.desc, '');
  assert.equal(row.stars, 24939);
  assert.equal(row.added, 492);
});

check('parseArticle：从 h2 取链接，不被开头的 /login?return_to 骗到', () => {
  const chunk = sliceArticles(DAILY)[0];
  assert.match(chunk, /href="\/login\?return_to=/);           // 条目第一条链接确实是 login
  assert.equal(parseArticle(chunk, 0).repo, 'tester-army/e2e');  // 若从条目头找链接会得到 "login"
});

/* ---------------- 整页解析 ---------------- */
check('parseTrendingHtml：四份真实切片全部整页解析成功、名次连续', () => {
  for (const [html, lang, n] of [[DAILY, '', 9], [WEEKLY, '', 10], [MONTHLY, '', 6], [RUST, 'rust', 4]]) {
    const res = parseTrendingHtml(html, { language: lang });
    assert.equal(res.ok, true, `${lang} 解析失败：${res.reason}`);
    assert.equal(res.rows.length, n);
    assert.equal(res.pageCount, n);
    res.rows.forEach((r, i) => assert.equal(r.rank, i + 1));
    assert.ok(res.rows.every((r) => r.stars > 0 && r.added > 0));
  }
});

check('parseTrendingHtml：跨榜同现的真实素材（pbakaus/impeccable 同日同周在榜）', () => {
  const d = parseTrendingHtml(DAILY, {}).rows.map((r) => r.repo);
  const w = parseTrendingHtml(WEEKLY, {}).rows.map((r) => r.repo);
  assert.ok(d.includes('pbakaus/impeccable') && w.includes('pbakaus/impeccable'));
  assert.ok(d.includes('panniantong/agent-reach') && w.includes('panniantong/agent-reach'));
});

check('parseTrendingHtml：合法空榜 vs 不认的语言 slug（唯一判据是标题）', () => {
  const empty = parseTrendingHtml(EMPTY_BF, { language: 'brainfuck' });
  assert.equal(empty.ok, true);
  assert.equal(empty.emptyBoard, true);
  assert.equal(empty.rows.length, 0);

  const unknown = parseTrendingHtml(UNKNOWN, { language: 'jolang' });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.unknownLanguage, true);
  assert.equal(unknown.emptyBoard, undefined);

  // 同一份 0 条目页面，不带语言时就是故障（结构改版/被拦），不能当空榜
  const site = parseTrendingHtml(UNKNOWN, { language: '' });
  assert.equal(site.ok, false);
  assert.match(site.reason, /一条榜单条目都没有/);
});

check('parseTrendingHtml：丢行率超过 40% 判故障（改版前兆）', () => {
  // 切片本身不含闭标签（make-fixtures 只切到 </article> 前），这里要补回去，否则末条会被当成截断页丢掉
  const good = sliceArticles(DAILY).slice(0, 2).map((c) => `${c}</article>`).join('\n');
  const junk = '<article class="Box-row"><p>no links here</p></article>'.repeat(4);
  const html = `<html><head><title>Trending repositories on GitHub today</title></head><body>${junk}${good}</body></html>`;
  const res = parseTrendingHtml(html, {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /只解析出 2 条/);
});

check('parseTrendingHtml：空正文与无条目页都说不清就直说', () => {
  assert.equal(parseTrendingHtml('', {}).ok, false);
  assert.match(parseTrendingHtml('', {}).reason, /正文为空/);
  const res = parseTrendingHtml('<html><head><title>Sign in</title></head><body></body></html>', {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /登录页/);
});

/* ---------------- 抓取（假 fetch，不碰网） ---------------- */
check('fetchTrendingBoard：200 带 etag ⇒ 回 etag 与行；If-None-Match 命中 ⇒ notModified', async () => {
  const fetchFn = makeFakeFetch({
    'https://github.com/trending?since=daily': { text: DAILY, headers: { etag: 'W/"abc"' } },
  });
  const first = await fetchTrendingBoard({ board: 'daily', fetchFn });
  assert.equal(first.ok, true);
  assert.equal(first.etag, 'W/"abc"');
  assert.equal(first.rows.length, 9);
  assert.equal(fetchFn.seen[0].headers['If-None-Match'], undefined);

  const second = await fetchTrendingBoard({ board: 'daily', etag: 'W/"abc"', fetchFn });
  assert.equal(second.ok, true);
  assert.equal(second.notModified, true);
  assert.equal(second.rows, null);
  assert.equal(fetchFn.seen[1].headers['If-None-Match'], 'W/"abc"');
  assert.equal(fetchFn.seen[1].headers['User-Agent'], 'Mozilla/5.0 (dsh-plugin-gh-trending; personal monitor)');
});

check('fetchTrendingBoard：非 2xx 把状态与 retry-after 说全', async () => {
  const fetchFn = makeFakeFetch({
    'https://github.com/trending?since=weekly': { status: 429, text: '', headers: { 'retry-after': '60' } },
  });
  const res = await fetchTrendingBoard({ board: 'weekly', fetchFn });
  assert.equal(res.ok, false);
  assert.match(res.reason, /429/);
  assert.match(res.reason, /60s 后再试/);
});

check('fetchTrendingBoard：传输层失败与超时都归成 ok:false，不外抛', async () => {
  const boom = makeFakeFetch({ 'https://github.com/trending?since=daily': () => { throw Object.assign(new Error('boom'), { cause: { code: 'ENOTFOUND' } }); } });
  const res = await fetchTrendingBoard({ board: 'daily', fetchFn: boom });
  assert.equal(res.ok, false);
  assert.match(res.reason, /ENOTFOUND/);

  // 假 fetch 永不返回正文，只吃 abort 信号 ⇒ 走超时分支
  const slow = await fetchTrendingBoard({
    board: 'daily',
    timeoutMs: 20,
    fetchFn: (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(slow.ok, false);
  assert.match(slow.reason, /超时/);
});

check('fetchTrendingBoard：代理配置错标 configError（不补发），连不上代理仍算传输类', async () => {
  const cfg = makeFakeFetch({ 'https://github.com/trending?since=daily': () => { throw Object.assign(new Error('自定义代理地址不可用：缺端口'), { code: 'proxy_config' }); } });
  const r = await fetchTrendingBoard({ board: 'daily', fetchFn: cfg });
  assert.equal(r.ok, false);
  assert.equal(r.configError, true);
  assert.equal(r.transportError, false, '同一份坏配置再打三次还是同一句报错，不该占重试');
  assert.match(r.reason, /缺端口/);

  const via = makeFakeFetch({ 'https://github.com/trending?since=daily': () => { throw Object.assign(new Error('连不上代理 127.0.0.1:7897'), { code: 'proxy_unreachable' }); } });
  const t = await fetchTrendingBoard({ board: 'daily', fetchFn: via });
  assert.equal(t.transportError, true, '代理抖动跟直连抖动一样，值得补发');
  assert.match(t.reason, /proxy_unreachable/);
});

check('fetchTrendingBoard：脏语言值根本不出网', async () => {
  let called = 0;
  const fetchFn = async () => { called += 1; return { ok: true, status: 200, text: async () => DAILY, headers: { get: () => null } }; };
  const res = await fetchTrendingBoard({ board: 'daily', language: 'c++', fetchFn });
  assert.equal(res.ok, false);
  assert.match(res.reason, /请求造不出来/);
  assert.equal(called, 0);
});

/* ---------------- 语言就地验证 ---------------- */
check('checkLanguageSlug：四档判定各就各位', async () => {
  const fetchFn = makeFakeFetch({
    'https://github.com/trending/rust?since=weekly': { text: RUST },
    'https://github.com/trending/brainfuck?since=weekly': { text: EMPTY_BF },
    'https://github.com/trending/jolang?since=weekly': { text: UNKNOWN },
    'https://github.com/trending/python?since=weekly': { status: 500, text: '' },
  });
  assert.equal((await checkLanguageSlug({ language: 'rust', fetchFn })).status, 'boarded');
  assert.equal((await checkLanguageSlug({ language: 'brainfuck', fetchFn })).status, 'valid-empty');
  assert.equal((await checkLanguageSlug({ language: 'jolang', fetchFn })).status, 'unknown');
  assert.equal((await checkLanguageSlug({ language: 'python', fetchFn })).status, 'fetch-failed');
  const bad = await checkLanguageSlug({ language: 'c++', fetchFn });
  assert.equal(bad.status, 'unknown');
  assert.match(bad.reason, /形状不合法/);
  assert.equal((await checkLanguageSlug({ language: '', fetchFn })).status, 'boarded'); // 全站=不筛
});

await runAll('gh');
