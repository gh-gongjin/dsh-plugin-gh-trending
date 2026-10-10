/**
 * test/repo.test.mjs —— 仓库详情层（lib/services/repo.js）：闸门、中文判据、请求编排、缓存门面 + 全站高星那一发。
 *
 * ★ 夹具口径：接口正文逐字节来自真 api.github.com（test/make-repo-fixtures.mjs 抓的，见 repo-api.json 的
 *   capturedAt / route），只有两处真接口没法按需触发的分支是合成的，且都在夹具文件里登记了来处：
 *   「有元数据但 README 404」用真 404 正文拼，「限额用尽」用 403 + remaining:0 拼。
 *   第十一轮另有一份**整份合成**的 `repo-zh-section.json`（`zh_section` 命中侧）：本机榜面 29 个仓库实测零命中，
 *   没有实抓可得 ⇒ provenance / shapeSources / readings 三项都写在该文件里，用例不许把它当实测（详见下面第 3 步的注释）。
 *   用例不许手搓"我觉得 GitHub 会这么答"的对象（项目记忆「跨边界 payload 两头都要断言」）。
 *   ★ 第二十三轮再起一份 `repo-search.json`（`test/make-search-fixture.mjs` **整段真抓**一发 200）：这一档只吃四个字段，
 *   所以前 `fullItems` 条逐字节全留（真 item 实测八十多个键 ⇒ 给「多余字段不进载荷」那条判据当真靶子），其余裁到那四键；
 *   裁剪口径写在夹具里，用例只拿裁过的行钉顺序与位次（判据见下面第 7 步）。
 *   ⚠️ 那一发实测回来的 `x-ratelimit-limit` 是 **10** 而不是 core 的 60 ⇒ search 与 REST core 两套池子，
 *   「匿名 / 已认证」那句话各按各的匿名读数判（domain 的 `SEARCH_RATE_ANON`）。
 * ★ 假 fetch 按**整路径**精确匹配：URL 拼错（少个斜杠、没编码、打到 github.com）会直接报「没登记」，
 *   而不是被前缀匹配蒙过去 —— 那正是"离线全绿、真机 404"的形状。
 */
import { check, runAll, assert, fixture, makeFakeFacility } from './_helpers.mjs';
import {
  normalizeRepoKey, stripReadme, cjkCount, readmeZhVerdict, pickZhReadme, excerptOf,
  pickZhReadmeLink, zhReadmeRelPath, zhVariantRank,
  splitReadmeSections, pickZhSection, descIsZh, readmeZhOnScreen,
  repoFacts, repoSections, readmeMeta, fetchRepoDetail, repoCacheRow, repoView,
  createRepoDetailService, applyZh,
  searchRepoUrl, searchRepositories, createSearchFetcher,
} from '../lib/services/repo.js';
import { createRepoCacheStore } from '../lib/stores.js';
import { DESC_ZH_ROWS, DESC_ZH_LABEL } from '../lib/desc-zh.js';
import {
  GITHUB_API_BASE, REPO_RATE_ANON, REPO_RATE_AUTH, REPO_CACHE_TTL_MS, REPO_FAIL_TTL_MS, REPO_TIMEOUT_MS,
  REPO_CACHE_HOURS, REPO_CACHE_DEFAULT_HOURS, repoCacheTtlMs,
  RATE_LABEL_ANON, RATE_LABEL_AUTH,
  README_HEAD_CHARS, README_ZH_MIN_CJK, README_ZH_SECTION_MIN_CJK, DESC_SELF_ZH_MIN_CJK,
  README_EXCERPT_MAX, EXCERPT_SENT_BACK_MAX, README_ZH_LINK_MAX,
  REPO_ERROR_LABELS, REPO_FLAG_LABELS, REPO_FIELD_LABELS, REPO_README_SOURCE_LABELS,
  REPO_SECTION_KEYS, REPO_SECTION_LABELS, REPO_BLOCK_KINDS,
  README_ZH_GATE_MIN_CJK, README_ZH_GATE_SUFFIXES,
  README_ZH_HANS_TOKENS, README_ZH_HANT_TOKENS,
  SEARCH_STARS_FLOOR, SEARCH_PER_PAGE, SEARCH_RATE_ANON, SEARCH_ROW_SHAPE,
  llmZhLabel, engineZhLabel,
} from '../lib/domain.js';

const doc = JSON.parse(await fixture('repo-api.json'));
const F = new Map(doc.responses.map((r) => [r.path, r]));
/** 取夹具：path 必须拼得出来，拼不出来是用例写错了（不静默给 undefined）。 */
function src(path) {
  const r = F.get(path);
  if (!r) throw new Error(`夹具里没有这条路径：${path}`);
  return r;
}
/**
 * 第十一轮 `zh_section` 的夹具（**合成**，provenance 与每块的形状出处写在该文件的 `_note` / `shapeSources` 里）。
 * ★ 为什么必须合成：2026-10-06 扫本机三榜真出现过的 29 个仓库，「默认篇外文 + 整篇嵌一段中文小节」命中 **0 个**
 *   （tmp/probe-zh-scan.txt / probe-zh-scan2.txt）。没有实抓可得 ⇒ 用例钉的是**判据与编排的形状**，
 *   不是"GitHub 真的这么答"；`readings` 那一组数是**真实现**在这篇正文上算出来的（tmp/make-zh-fixture.mjs），
 *   下面所有断言都吃那组数，不手抄。
 */
const zhDoc = JSON.parse(await fixture('repo-zh-section.json'));
const ZH = new Map(zhDoc.responses.map((r) => [r.path, r]));
const ZK = zhDoc.repo;
const zhSrc = (path) => {
  const r = ZH.get(path);
  if (!r) throw new Error(`zh_section 夹具里没有这条路径：${path}`);
  return r;
};
const ZH_MD = zhSrc(`/repos/${ZK}/readme`).text;
const RD = zhDoc.readings;
const WEEKLY = 'ruanyf/weekly';
/**
 * 第二十三轮「全站高星」那一发的夹具（**整段真抓**：`test/make-search-fixture.mjs` 一发 200 打回来的，2026-10-09）。
 * ★ 裁剪口径写在夹具里（`response.fullItems` / `readKeys` / `fullLength` vs `keptLength`）：
 *   前 `fullItems` 条**逐字节全留**（一条 item 实测 82 个键 ⇒「多余字段不进载荷」那条判据有真字段可扫），
 *   其余只留被读的四个键 ⇒ 拿裁过的行钉的是**顺序与位次**，不是"GitHub 给了这么多字段"。
 * ★ 抓取路线（direct / proxy）今天通的是哪条就记哪条，用例**不钉**：这一份钉的是回包形状，路线证据归 test/net.test.mjs。
 */
const sDoc = JSON.parse(await fixture('repo-search.json'));
const SITEMS = JSON.parse(sDoc.text).items;
const SEARCH_PATHNAME = new URL(`https://api.github.com${searchRepoUrl()}`).pathname;
/** 夹具那一发的完整响应（over 里的同键覆盖：改正文 / 改限额头都从这里走）。 */
const searchEntry = (over = {}) => ({
  path: SEARCH_PATHNAME, status: sDoc.response.status, text: sDoc.text,
  headers: { ...sDoc.response.headers }, ...over,
});
/** 现造 items 正文（**合成**档用它，合成理由写在用例里）。 */
const searchBody = (items) => JSON.stringify({ total_count: items.length, incomplete_results: false, items });
const ANT = 'ant-design/ant-design';
const VITE = 'vitejs/vite';

const rateHead = (left, reset = 1791175333) => ({
  'x-ratelimit-limit': '60', 'x-ratelimit-remaining': String(left), 'x-ratelimit-reset': String(reset),
});

/**
 * 按整路径匹配的假 fetch。entries: [{path, status?, text?, headers?, throw?, code?}]
 * throw 项也占一个路径位，这样"该发几发"的断言仍然按路径数得清。
 */
function makeApiFetch(entries) {
  const map = new Map(entries.map((e) => [e.path, e]));
  const seen = [];
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(String(url));
    const path = u.pathname;
    seen.push({ url: String(url), host: u.host, path, method: opts.method ?? 'GET', headers: opts.headers ?? {}, signal: opts.signal, timeoutMs: opts.timeoutMs });
    const e = map.get(path);
    if (!e) throw new Error(`假 fetch 没登记这个路径：${u.host}${path}`);
    if (e.throw) throw Object.assign(new Error(e.throw), { code: e.code });
    const status = e.status ?? 200;
    const lower = {};
    for (const [k, v] of Object.entries(e.headers ?? {})) lower[String(k).toLowerCase()] = String(v);
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (k) => (lower[String(k).toLowerCase()] ?? null) },
      async text() { return e.text ?? ''; },
      async json() { return JSON.parse(e.text ?? 'null'); },
    };
  };
  fetchFn.seen = seen;
  return fetchFn;
}

/** 一套完整的三档真夹具（zh_default / zh_file / en_default），用例按 repo 挑；over 里的同路径项覆盖夹具。 */
function fullTable(over = []) {
  return makeApiFetch([
    src(`/repos/${WEEKLY}`), src(`/repos/${WEEKLY}/readme`),
    src(`/repos/${ANT}`), src(`/repos/${ANT}/readme`), src(`/repos/${ANT}/contents/`), src(`/repos/${ANT}/contents/README-zh_CN.md`),
    src(`/repos/${VITE}`), src(`/repos/${VITE}/readme`), src(`/repos/${VITE}/contents/`),
    src('/repos/this-org/no-such-repo-xyz'),
    ...over,
  ]);
}

const NOW = () => 1_700_000_000_000;

/** zh_section 那一套（**合成**夹具，见文件头）：meta / readme / contents 三路径，根目录没有独立中文篇。 */
function zhFixtureFetch(over = []) {
  return makeApiFetch([zhSrc(`/repos/${ZK}`), zhSrc(`/repos/${ZK}/readme`), zhSrc(`/repos/${ZK}/contents/`), ...over]);
}

/* ------------------------------------------------------------------ *
 * 1. 出网前的闸门
 * ------------------------------------------------------------------ */
check('normalizeRepoKey：owner/name 收得下，首尾斜杠与空格剥干净，大小写原样保留', () => {
  for (const [raw, want] of [['owner/repo', 'owner/repo'], ['  Vuejs/Vite ', 'Vuejs/Vite'], ['/owner/repo/', 'owner/repo']]) {
    const n = normalizeRepoKey(raw);
    assert.equal(n.ok, true, raw);
    assert.equal(n.key, want);
  }
});

check('normalizeRepoKey：不像 owner/name 的一律拒（斜杠数、空白、查询串、非 ASCII 都不放行）', () => {
  for (const raw of ['', '   ', 'owner', 'owner/repo/extra', 'owner/repo?x=1', 'owner/repo#f', 'a/b c', '中文/仓库', 'owner/', '/repo', 'a/.hidden', './x']) {
    const n = normalizeRepoKey(raw);
    assert.equal(n.ok, false, `该拒的放行了：${JSON.stringify(raw)}`);
    assert.equal(n.reason, REPO_ERROR_LABELS.bad_key);
  }
});

check('闸门在造 URL 之前：形状不合的仓库名一个字节都不出网', async () => {
  const f = makeApiFetch([]);
  const r = await fetchRepoDetail({ repo: 'oops/../etc/passwd', fetchFn: f, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.errKey, 'bad_key');
  assert.equal(f.seen.length, 0, '坏名字不许打到接口上（404 也照样花限额）');
});

/* ------------------------------------------------------------------ *
 * 2. 中文判据（全部对着真夹具读数）
 * ------------------------------------------------------------------ */
check('stripReadme：代码块、HTML 标签、表格分隔都去掉，链接留文字不留 URL', () => {
  const md = ['<p align="center">', '# 标题', '```js', 'const x = 中文中文中文;', '```', '[项目主页](https://example.com)', '| --- | --- |', '- 要点 `code` 一'].join('\n');
  const s = stripReadme(md);
  assert.ok(!s.includes('```'), '代码块没去掉');
  assert.ok(!s.includes('<p'), 'HTML 没去掉');
  assert.ok(!s.includes('https://example.com'), '链接 URL 没去掉');
  assert.ok(s.includes('项目主页'), '链接文字该留着');
  assert.ok(!s.includes('const x'), '代码块内容不该混进正文');
  assert.ok(s.includes('要点'), '正文该留下');
  assert.ok(!/[#>*`|]/.test(s), `标记符没清干净：${s}`);
});

check('stripReadme：徽章串、引用式链接、嵌套图片链、链接定义行都不留方括号（真 README 首屏的形状）', () => {
  // 这四例逐字取自 test/fixtures/repo-api.json 里 ant-design/ant-design 的 README 首屏
  const md = [
    '[![CI status][github-action-image]][github-action-url] [![NPM version][npm-image]][npm-url]',
    '[![Follow Twitter][twitter-image]][twitter-url]',
    '[更新日志](./CHANGELOG.zh-CN.md) · [报告问题][github-issues-url] · 中文',
    '[![](https://opencollective.com/tiers/sponsors/badge.svg?label=Sponsors&color=brightgreen)](https://opencollective.com/contribute/sponsors-218)',
    '[npm-image]: https://img.shields.io/npm/v/antd.svg?style=flat-square',
  ].join('\n\n');
  const s = stripReadme(md);
  assert.ok(!/[[\]]/.test(s), `方括号没削干净：${s}`);
  assert.ok(!s.includes('img.shields.io'), '链接定义行的 URL 漏进正文');
  assert.ok(!s.includes('badge.svg'), '徽章图片的 URL 漏进正文');
  assert.ok(!s.includes('opencollective'), '嵌套图片链的外层链接没吃掉');
  assert.ok(s.includes('更新日志'), '中文链接文字该留着');
  assert.ok(s.includes('报告问题'), '引用式链接的文字该留着');
  assert.ok(s.includes('中文'), '正文该留下');
});

check('CJK 判据钉住真夹具三档：周刊 297 / antd 默认篇 2 / antd 中文篇 30', () => {
  const weekly = readmeZhVerdict(src(`/repos/${WEEKLY}/readme`).text);
  const antEn = readmeZhVerdict(src(`/repos/${ANT}/readme`).text);
  const antZh = readmeZhVerdict(src(`/repos/${ANT}/contents/README-zh_CN.md`).text);
  assert.equal(weekly.isZh, true);
  assert.ok(weekly.cjk > 200, `周刊首屏中文个数读数漂了：${weekly.cjk}`);
  // 默认篇那 2 个来自语言切换行「English · 中文」，不是正文 —— 阈值 20 把它稳稳挡在外面
  assert.equal(antEn.cjk, 2);
  assert.equal(antEn.isZh, false);
  // 读数口径：2026-10-05 起 stripReadme 会把徽章串/引用链接/链接定义行整块削掉，首屏窗口装的是正文。
  // 这里的 30 是**夹具前缀**（该文件只存了前 2,000 字，见 keptLength/truncated）的读数 —— 那 2,000 字里正文之外
  // 全是徽章与赞助者表格，削完只剩 77 字。整篇的真机读数是 195（tmp/probe-repo-service.mjs，2026-10-05：
  // 「Ant Design 一套企业级…✨ 特性 🌈 提炼自企业级中后台产品的交互语言和视觉风格…」）。两个口径都远超阈值 20，
  // 这一档钉的是"中文篇判得出来"，不是"整篇有多少中文"。
  assert.equal(antZh.isZh, true, '中文篇判不到（30≥20），这一档要是翻掉就是阈值改了没同步');
  assert.equal(antZh.cjk, 30);
});

check('阈值边界：19 个中文不算、20 个算，且 20 只在 domain 写了一次', () => {
  const zh19 = readmeZhVerdict('一'.repeat(README_ZH_MIN_CJK - 1) + 'x'.repeat(400));
  const zh20 = readmeZhVerdict('一'.repeat(README_ZH_MIN_CJK) + 'x'.repeat(400));
  assert.equal(README_ZH_MIN_CJK, 20);
  assert.equal(zh19.isZh, false);
  assert.equal(zh20.isZh, true);
  assert.equal(cjkCount('中文 ことば カタカナ english'), 2 + 3 + 4, '汉字、平假名、片假名都要数');
  assert.equal(cjkCount('áé漢'), 1);
});

check('取样只吃去标签后首屏：窗口外的中文不作数', () => {
  const head = 'x'.repeat(README_HEAD_CHARS);
  const v = readmeZhVerdict(`${head}\n\n${'中'.repeat(60)}`);
  assert.equal(v.isZh, false, '600 字窗口之后的中文把英文篇判成中文了');
  assert.equal(v.head.length, README_HEAD_CHARS);
  assert.equal(v.cjk, 0);
});

check('pickZhReadme：真清单里挑中文篇；README.md 与目录项、日文篇都不许命中', () => {
  const antFiles = JSON.parse(src(`/repos/${ANT}/contents/`).text).filter((f) => f?.type === 'file').map((f) => f.name);
  assert.equal(pickZhReadme(antFiles), 'README-zh_CN.md');
  const viteFiles = JSON.parse(src(`/repos/${VITE}/contents/`).text).filter((f) => f?.type === 'file').map((f) => f.name);
  assert.equal(pickZhReadme(viteFiles), '', '只有 README.md 的仓库不该被硬塞一份中文篇');
  // 多个中文篇：先按简繁优先档，同档内按名排序（真名取自 tmp/probe-repo-zh.txt 对 system-design-primer 的读数）
  assert.equal(pickZhReadme(['README-ja.md', 'README-zh-Hans.md', 'README-zh-TW.md', 'README.md']), 'README-zh-Hans.md');
  assert.equal(pickZhReadme(['docs/', 'README.zh-CN.md']), 'README.zh-CN.md', '目录项（带斜杠）不能当候选');
  assert.equal(pickZhReadme(['readme-chinese.md', null, 3]), 'readme-chinese.md', '非字符串项要能扛住');
});

/**
 * ★ 第二十轮（用户裁定「使用 README.zh.md 这种」）：这一档**必须钉在两条路上各自的现场**上，
 *   只钉 `zhVariantRank` 这一个纯函数是假绿 —— 两路原本各写各的 `.sort()`，把比较器只接到一路另一路照旧挑繁体。
 */
check('zhVariantRank：三档封闭（明写简体 0／不带变体 1／明写繁体 2），两份词元名单不许有交集', () => {
  assert.equal(zhVariantRank('README.zh-CN.md'), 0);
  assert.equal(zhVariantRank('README-zh_Hans.md'), 0, '下划线分隔没切成词元');
  assert.equal(zhVariantRank('README.cn.md'), 0);
  assert.equal(zhVariantRank('README.zh.md'), 1);
  assert.equal(zhVariantRank('README.chinese.md'), 1);
  assert.equal(zhVariantRank('README.zh-tw.md'), 2);
  assert.equal(zhVariantRank('README.zh-Hant.md'), 2);
  assert.equal(zhVariantRank('README-tw.md'), 2);
  // 目录名不参与：`docs/tw/README.zh.md` 是"不带变体"那份，不许因为路径里有个 tw 就降成繁体
  assert.equal(zhVariantRank('docs/tw/README.zh.md'), 1, '目录名里的词元被算进去了');
  // 子串不算命中：拼错的形状不许冒充简体（认的是词元，不是 `cn` 这两个字母出现在名字里）
  assert.equal(zhVariantRank('README.zh-cnother.md'), 1, '整串子串匹配把不该算简体的也算成简体');
  // 两份名单不许有交集：有交集时"两份都算繁体又都算简体"，排序结果跟着名单先后摆（两处真相）
  assert.deepEqual(README_ZH_HANS_TOKENS.filter((t) => README_ZH_HANT_TOKENS.includes(t)), [], '简繁词元名单撞车');
  // 两档同时出现在一个名字里 ⇒ 保守认繁体（别把繁体篇当简体篇端出去）
  assert.equal(zhVariantRank('README.zh-hant-cn.md'), 2);
});

check('两路挑篇共用同一条优先档：榜单上同时有 README.zh.md 与 README.zh-tw.md 时挑简体那份', () => {
  // 形状出处：tmp/probe-zh-link-shape.txt 第 8~9、40 行（thedotmack/claude-mem，2026-10-07）。
  // ★ 旧写法是 `.sort()` 取第一个，而 `'-'`(0x2d) 排在 `'.'`(0x2e) 前面 ⇒ 繁体那份被挑中。
  const names = ['README.zh-tw.md', 'README.zh.md'];
  assert.equal(pickZhReadme(names), 'README.zh.md', '根目录那一档还在按字面排序');
  const md = '<a href="docs/i18n/README.zh-tw.md">繁體中文</a> | <a href="docs/i18n/README.zh.md">中文</a>';
  assert.equal(pickZhReadmeLink(md), 'docs/i18n/README.zh.md', '语言切换行那一档还在按字面排序');
  // ★ 只排序、不过滤：只有繁体时那份繁体照旧被挑中（过滤掉它 = 撤掉用户在用的那一屏）
  assert.equal(pickZhReadme(['README.zh-tw.md', 'README.md']), 'README.zh-tw.md');
  assert.equal(pickZhReadmeLink('[x](docs/i18n/README.zh-tw.md)'), 'docs/i18n/README.zh-tw.md');
  // 同档内仍按字面（稳定比聪明重要那条没改判）⇒ 输入序故意给成字面序的反面
  assert.equal(pickZhReadme(['README.zh-TW.md', 'README.zh-Hant.md']), 'README.zh-Hant.md', '同档内没按字面排序');
});

check('pickZhReadmeLink：第二路吃语言切换行 —— markdown 与 href 两种写法都认，多条命中先按简繁档再按名', () => {
  // 形状（alibaba/open-code-review，2026-10-07）：根目录没有中文篇，那份在 docs/i18n/ 下面，
  // 首屏那行语言切换用的是 HTML 写法 ⇒ 只写 markdown 那一条正则等于没做。
  const real = '# Open Code Review\n\n[English](README.md) | <a href="docs/i18n/README.zh-CN.md">简体中文</a>\n';
  assert.equal(pickZhReadmeLink(real), 'docs/i18n/README.zh-CN.md');
  assert.equal(pickZhReadmeLink('[简体中文](docs/README_zh.md)'), 'docs/README_zh.md', 'markdown 写法没认出来');
  assert.equal(pickZhReadmeLink('[x](<docs/README.zh-CN.md>)'), 'docs/README.zh-CN.md', '尖括号包起来的目标也要认');
  // 两条候选分属繁体与简体 ⇒ 简体那份赢（这条与上面那条同一条律，摆在第二路的现场钉第二次）
  assert.equal(pickZhReadmeLink('[b](docs/README.zh-TW.md)\n[a](i18n/README.zh-CN.md)'), 'i18n/README.zh-CN.md');
  // 吃 raw 原文不吃 stripReadme：净化口径是「链接留文字不留 URL」，只喂 clean 的话目标早被削掉了
  assert.equal(pickZhReadmeLink(stripReadme(real)), '', '第二路是从 raw 里抽的 —— 喂净化版就抽不到');
});

check('第二路的闸门在造 URL 之前：绝对 URL / 站内绝对 / 片段 / 反斜杠 / 非 .md / 穿越 / 超长一律不放行', () => {
  // ★ 这一格吃的是**远程仓库自己写的正文**（不可信输入），它要进 `api.github.com/repos/<key>/contents/<这条>`；
  //   闸门放在解析这一步，不放错误处理里（与 normalizeRepoKey 同一条律）。
  for (const bad of [
    'https://evil.example/docs/README.zh-CN.md',
    'http://127.0.0.1:1/README.zh-CN.md',
    '//example.com/README.zh-CN.md',
    // ★ 这一条是**只由 scheme 那一支挡住的**（没有 `//` ⇒ 不会被"空段"顺手挡掉）：撤掉 scheme 检查就漏出去
    'mailto:docs/README.zh-CN.md',
    'http:docs/README.zh-CN.md',
    '/docs/README.zh-CN.md',
    '#README.zh-CN.md',
    'docs\\README.zh-CN.md',
    '../elsewhere/README.zh-CN.md',
    'docs/../elsewhere/README.zh-CN.md',
    'docs/./README.zh-CN.md',
    'docs//README.zh-CN.md',
    'docs/README.zh-CN.txt',
    'docs/中文.md',
    'docs/README',
    'x'.repeat(README_ZH_LINK_MAX) + '/README.zh-CN.md',
    '', '   ', null, undefined, 3,
  ]) {
    assert.equal(zhReadmeRelPath(bad), '', `闸门放过了这一条：${String(bad)}`);
    const inMd = typeof bad === 'string' && bad.trim() && !bad.includes(' ') ? `[x](${bad})` : null;
    if (inMd) assert.equal(pickZhReadmeLink(inMd), '', `整篇里只写这一条链接时它被采信了：${bad}`);
  }
  // 放行侧：`./` 前缀是相对路径的普通写法，吃掉前缀后原样交回；★ 这里**不编码**（编码只在出网那一发逐段做）
  assert.equal(zhReadmeRelPath('./docs/README.zh-CN.md'), 'docs/README.zh-CN.md');
  assert.equal(zhReadmeRelPath('i18n/README-zh_CN.md'), 'i18n/README-zh_CN.md');
  assert.equal(zhReadmeRelPath('README.ZH-CN.MD'), 'README.ZH-CN.MD', '名字表大小写不敏感，但路径要原样交回（不改大小写，也不提前编码）');
});

/* ------------------------------------------------------------------ *
 * 2b. 中文小节切分与描述自带中文（第十一轮 A）
 * ------------------------------------------------------------------ */
check('splitReadmeSections：围栏代码块里的 # 行不算语义标题（榜单上真出过的形状）', () => {
  const secs = splitReadmeSections(ZH_MD);
  assert.deepEqual(secs.map((s) => s.heading), RD.sectionHeadings, `切出来的标题表与夹具读数不一致：\n${JSON.stringify(secs.map((s) => s.heading))}`);
  assert.equal(secs.length, RD.sectionsTotal);
  assert.ok(!secs.some((s) => /这一行在围栏|token_ids|pad_token/.test(s.heading)), '围栏里的 # 行被当成了小标题，界面上会把代码注释念成段名');
  assert.ok(!secs.some((s) => /locale|不该进判据/.test(s.heading)));
  // 开篇（第一个标题之前）也成一段，标题空串：双语仓库的中文段常常就在最前面
  const opening = splitReadmeSections('先说一句总评。\n\n# 标题\n\n正文\n');
  assert.deepEqual(opening.map((s) => s.heading), ['', '标题']);
  // HTML 标题同样算切点（真 README 里徽章那几行就是 <p>/<h1> 混着写）
  assert.deepEqual(splitReadmeSections('<h2>Installation</h2>\n跑 npm i\n').map((s) => s.heading), ['Installation']);
  // ~~~ 围栏与 ``` 一视同仁：围栏里那几行留在**开篇段**的正文里（不另起一段），
  //   判据吃的是 stripReadme 之后的文本 ⇒ 代码块整块削掉，那一段的 CJK 是 0，够不着阈值。
  const fenced = `~~~\n# ${'中'.repeat(README_ZH_MIN_CJK + 10)}\n~~~\n\n## 真标题\n`;
  assert.deepEqual(splitReadmeSections(fenced).map((s) => s.heading), ['', '真标题']);
  assert.equal(cjkCount(stripReadme(splitReadmeSections(fenced)[0].raw)), 0, '围栏里的中文进了判据 ⇒ 代码注释会被当成"仓库自己写的中文小节"');
  assert.equal(pickZhSection(fenced), null);
});

check('pickZhSection：按文档顺序取第一段达标的，判据与展示吃同一份文本', () => {
  const sec = pickZhSection(ZH_MD);
  assert.equal(sec.heading, RD.zhSectionHeading, '第一段中文小节应该是「中文说明」，不是排在它后面那段');
  assert.equal(sec.cjk, RD.zhSectionCjk);
  assert.match(sec.head, /这个仓库把中文介绍直接嵌在默认的 README/);
  assert.ok(!/这一段也是中文/.test(sec.head), '节选跨到了第二段，判据看到的首屏和屏上就不是同一段了');
  assert.ok(!/这一行在围栏代码块里/.test(sec.head), '围栏里的中文进了节选（stripReadme 本该削掉代码块）');
  assert.ok(sec.head.length <= README_HEAD_CHARS);
});

check('pickZhSection 噪声侧：语言切换行、赞助者名单、日文假名少的徽章都不算一段中文', () => {
  assert.equal(README_ZH_SECTION_MIN_CJK, README_ZH_MIN_CJK, '本轮不另立新数：两段判据同一条，读的人不需要记两套');
  // ① 合成篇自己的首屏只有语言切换行那 4 个字（夹具读数），整篇里另有 85 字的中文段 ⇒ 证明"首屏不算中文"和"整篇有中文"可以同时成立
  assert.equal(RD.readmeHeadCjk, 4);
  assert.equal(RD.readmeHeadIsZh, false);
  // ② 真夹具：ant-design 的默认篇前缀（真接口逐字节）里没有一段中文
  assert.equal(pickZhSection(src(`/repos/${ANT}/readme`).text), null, '英文篇被判出了中文小节 ⇒ 阈值或切分器松了');
  assert.equal(pickZhSection(src(`/repos/${VITE}/readme`).text), null);
  // ③ 只有两个中文链接文字的一篇：4 个字，够不着 20（这一条是本轮的反向判据，专门防止"见中文就命中"）
  const oneLine = '# Demo\n\n[文档](https://example.com) | [中文](README-zh.md)\n\n' + 'English prose. '.repeat(30);
  assert.equal(cjkCount(stripReadme(oneLine)), 4);
  assert.equal(pickZhSection(oneLine), null);
  // ④ 边界：19 个不算（整段不命中，返回 null）、20 个算（与整篇那一档同一条边界，两侧各留一次）
  assert.equal(pickZhSection(`## 小节\n\n${'一'.repeat(README_ZH_MIN_CJK - 1)} tail`), null);
  assert.equal(pickZhSection(`## 小节\n\n${'一'.repeat(README_ZH_MIN_CJK)} tail`).heading, '小节');
});

check('descIsZh：仓库自己写的描述是不是中文（阈值 8，两侧余量各 7 / 48）', () => {
  assert.equal(DESC_SELF_ZH_MIN_CJK, 8);
  assert.equal(descIsZh('一'.repeat(7)).isZh, false);
  assert.equal(descIsZh('一'.repeat(8)).isZh, true);
  assert.equal(descIsZh('Next gen frontend tooling.').isZh, false, '英文描述被判成中文 ⇒ 那一发真该派的现译被闸门挡了');
  assert.equal(descIsZh('').isZh, false, '空描述不是中文（它走"没有描述"那一路）');
  // 真读数：内置表里那些中文描述（本机榜面上唯一一条自带中文的那行就是这一类，56 字）
  const [, , zhDesc] = DESC_ZH_ROWS[0];
  assert.equal(descIsZh(zhDesc).isZh, true, `内置表那句中文判不出来（CJK=${descIsZh(zhDesc).cjk}）`);
});

check('readmeZhOnScreen：摘要闸门的两条来路，两侧各用一条本机真读数钉边界（第十九轮）', () => {
  assert.equal(README_ZH_GATE_MIN_CJK, 8, '闸门阈值与描述那一档同一条律（8），只在 domain 写一次');
  assert.ok(README_ZH_GATE_MIN_CJK < README_ZH_MIN_CJK, '闸门必须**低于**档名那条 20：否则这一条永远接不住混排篇（第十九轮改判的就是这个差）');
  // ① 混排：真机 thedotmack/claude-mem 那行语言切换的 CJK 个数就是 9（`tmp/probe-excerpt-zh-ratio.txt`）
  const mem = 'English | 中文 | 繁體中文 | 日本語 — a Claude Code productivity plugin.';
  assert.equal(cjkCount(mem), 9, '夹具与真读数对不上 ⇒ 下面那条断言测的是我编的形状');
  assert.deepEqual(readmeZhOnScreen(mem), { hit: true, via: 'cjk', cjk: 9 });
  // ② 只剩切换行的字样：真机 ant-design 英文篇整篇 2 个 CJK，够不着 8，但仓库自己写了「中文」
  assert.deepEqual(readmeZhOnScreen('English | 中文 — a vue ui library.'), { hit: true, via: 'lang', cjk: 2 });
  // ③ 阈值上边界：8 个算（下边界 7 个不算那条拆到下面那圈，理由写在那儿）
  assert.equal(readmeZhOnScreen('x'.repeat(20) + '一'.repeat(8)).hit, true, '8 个还不挡 ⇒ 混排那一路没接住');
  // ★ 反向（不许顺手挡）拆到下面那条独立的 check 里：同一 check 里 `lang` 那条断言会先炸，
  //   "误挡日文"这个现场就永远轮不到报红（第十九轮电池第 ③ 条就是这么漏的）。
  // 繁体写法那一行也认（真机形状 `[繁體中文](docs/i18n/README.zh-tw.md)`）
  assert.equal(readmeZhOnScreen('繁體中文').hit, true);
  // 段名那半句：两档各有自己的字面，都不许写成「所以没译」（开关关着时同样不译，那句会把没开说成不该开）
  assert.deepEqual(README_ZH_GATE_SUFFIXES, { cjk: '（节选里已有中文）', lang: '（这行写着有中文版）' });
  for (const v of Object.values(README_ZH_GATE_SUFFIXES)) assert.doesNotMatch(v, /没译|不译|无需/);
});

/**
 * ★ 这一条单独成一个 check：上面那条里 `lang` 的断言排在前面，阈值一降低它就先炸，
 *   "误挡"这个现场永远轮不到报红（第十九轮电池第 ③ 条第一次跑就是这样漏的）。
 *   反向判据要挂在它自己的现场上 ⇒ 拆出来，一条也不许合回去。
 */
check('readmeZhOnScreen 的反面：闸门不许顺手把该译的那几类挡掉（第十九轮，误挡=少做用户在用的那一屏）', () => {
  // ① 日文篇：真机 m-abozaid/esp32-c3-adblock 的 3 个 CJK 全是「日本語」⇒ 那是日文不是中文
  const ja = 'English | 日本語 — this project is not translated into Chinese.';
  assert.equal(cjkCount(ja), 3, '夹具读数要跟真机对上（日本語 = 3 个）');
  assert.deepEqual(readmeZhOnScreen(ja), { hit: false, via: '', cjk: 3 }, '把日文篇当中文挡掉 = 删了用户在用的那一屏');
  // ② 纯英文与空串
  assert.equal(readmeZhOnScreen('Next generation frontend tooling. Drop-in replacement.').hit, false);
  assert.equal(readmeZhOnScreen('').hit, false, '空节选不是"有中文"（它由 `readmeExcerpt` 那一格挡派活）');
  assert.equal(readmeZhOnScreen(undefined).hit, false);
  // ③ 只认"语言的写法"，不认国名：「中國」是市场与地名，不是"本仓库有中文版"的声明
  assert.equal(readmeZhOnScreen('A toolkit for the 中国 market.').hit, false, '把国名当语言声明 ⇒ 误挡');
  assert.equal(readmeZhOnScreen('A toolkit for the 中國 market.').hit, false, '同上，繁体写法也不当声明');
  // ④ 英文 "Chinese" 故意**不**认：正文里 Chinese tea / Chinese New Year 一大把
  assert.equal(readmeZhOnScreen('A Chinese tea house dashboard.').hit, false, '把英文里的 Chinese 当中文 ⇒ 误挡');
  // ⑤ 阈值下边界：7 个不算（8 个算那条在上面那圈钉）
  assert.equal(readmeZhOnScreen('x'.repeat(20) + '一'.repeat(7)).hit, false, '7 个就被挡 ⇒ 阈值降到了噪声那一侧');
});

check('excerptOf：没超原样给，超了按字符切并说 cut；末尾落在代理对里退一格', () => {
  const short = excerptOf('短的', 10);
  assert.deepEqual(short, { text: '短的', cut: false });
  const long = excerptOf('啊'.repeat(README_EXCERPT_MAX + 5), README_EXCERPT_MAX);
  assert.equal(long.cut, true);
  assert.equal(long.text.length, README_EXCERPT_MAX);
  const pair = 'a'.repeat(README_EXCERPT_MAX - 1) + '😀b';
  const cut = excerptOf(pair, README_EXCERPT_MAX);
  assert.equal(cut.text.length, README_EXCERPT_MAX - 1, '切半个 emoji 会渲染成乱码方块');
  assert.ok(!cut.text.endsWith('\ud83d'));
});

check('第十五轮分家：判据窗口 600 只用来数 CJK，节选吃去标记后的整篇（旧版拿窗口当节选，1,600 的预算从没生效）', () => {
  // 合成一篇：首屏 600 字全是英文，中文在窗口之外 —— 旧口径下"节选"就停在这 600 字，
  // 于是界面那句「节选 600 / 整篇 N 字」断在句中，摘要那一发能读到的也只有前 600 字。
  const md = '# Title\n\n' + 'English prose here for the demo. '.repeat(60)
    + '\n\n## 中文说明\n\n这一句是嵌在英文篇里的中文小节，位置在 600 字窗口之外，判据不许看见它。\n';
  const v = readmeZhVerdict(md);
  assert.equal(v.head.length, README_HEAD_CHARS, '判据窗口仍是 600（分家分的是节选，不是把阈值搬到整篇）');
  assert.equal(v.cjk, 0, '窗口外的中文把英文篇判成中文了 ⇒ 分家没生效');
  assert.equal(v.isZh, false);
  assert.ok(v.clean.length > README_HEAD_CHARS * 2, `clean 该是整篇去标记文本，实得 ${v.clean.length}`);
  const ex = excerptOf(v.clean);
  assert.equal(ex.cut, true);
  assert.ok(ex.text.length > README_HEAD_CHARS, `节选仍被压在 ${README_HEAD_CHARS} 以内 ⇒ 交出去的还是窗口`);
  assert.ok(ex.text.length <= README_EXCERPT_MAX, `节选超了入库预算：${ex.text.length}`);
  // 预算与窗口必须是两个数：相等的话这一整条分家在断言上就是空的
  assert.ok(README_EXCERPT_MAX > README_HEAD_CHARS, '两格常量撞了 ⇒ 上面那几条 > 全在自证');
});

check('节选在句子边界收口：回退到窗口内最后一个句末；中西文断句形状不同，中文那句没有空格', () => {
  // ① 英文：真机那一屏（earthtoojake/text-to-cad，10-07）断在 "Install Ask your a" ⇒ 窗口末尾正卡在句中
  const en = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} does some useful work here.`).join(' ');
  const e = excerptOf(en);
  assert.equal(e.cut, true);
  assert.match(e.text, /[.!?]$/, `英文篇没在句末收口，尾巴是：${JSON.stringify(e.text.slice(-24))}`);
  assert.ok(e.text.length > README_EXCERPT_MAX - EXCERPT_SENT_BACK_MAX, `回退吃掉了超过 200 字的预算：${e.text.length}`);
  // ② 中文：「。」后面直接跟汉字，没有空格 —— 这一支漏了的话，中文 README 永远走硬切
  const zh = Array.from({ length: 200 }, (_, i) => `这是第${i}个句子，它说明一件事。下一句紧接着就开始。`).join('');
  const z = excerptOf(zh);
  assert.equal(z.cut, true);
  assert.match(z.text, /[。！？；]$/, `中文篇没在句末收口，尾巴是：${JSON.stringify(z.text.slice(-24))}`);
  assert.ok(z.text.length > README_EXCERPT_MAX - EXCERPT_SENT_BACK_MAX, `中文篇的回退超出预算：${z.text.length}`);
  // ③ 缩写不算句末：`e.g.` / `i.e.` / `v1.12.12` 都不许被当成句子收尾（退到那儿节选会莫名其妙短一截）
  const ab = excerptOf('Tooling v1.12.12 works e.g. on linux i.e. everywhere good '.repeat(60));
  assert.equal(ab.cut, true);
  assert.ok(ab.text.length > README_EXCERPT_MAX - EXCERPT_SENT_BACK_MAX,
    `退到缩写处了（实得 ${ab.text.length}）⇒ 句末形状里"后面那个字符"那一格松了`);
  // ④ 窗口里一个句末都没有 ⇒ 宁可硬切，也不能整段没了
  const hard = excerptOf('a'.repeat(4000));
  assert.equal(hard.text.length, README_EXCERPT_MAX);
  assert.equal(hard.cut, true);
  // ⑤ 硬切之后仍要退掉半个代理对：切在 emoji 的代理对中间会渲染成乱码方块
  const emoji = excerptOf('x'.repeat(1398) + ' end.' + '😀'.repeat(200));
  assert.equal(emoji.text.length, README_EXCERPT_MAX - 1, `半个代理对没退掉（实得 ${emoji.text.length}）`);
  assert.ok(!/[\ud800-\udbff]$/.test(emoji.text), '末尾留了半个代理对');
});

/* ------------------------------------------------------------------ *
 * 3. 中文段表（宿主分段、拼整句，客户端只按 kind 摆字）
 * ------------------------------------------------------------------ */
check('repoFacts：缺位字段不给条目，星标带千分位，NOASSERTION 不上屏', () => {
  const facts = repoFacts({ lang: 'C', stars: 251118, forks: 66775, issues: 3, license: 'NOASSERTION', pushedAt: '2026-10-04T20:46:02Z', topics: [] });
  assert.deepEqual(facts.map((f) => f.key), ['language', 'stars', 'forks', 'issues', 'pushedAt']);
  assert.equal(facts.find((f) => f.key === 'stars').value, '251,118');
  assert.equal(facts.find((f) => f.key === 'language').label, REPO_FIELD_LABELS.language);
  const empty = repoFacts({});
  assert.deepEqual(empty, [], '一个字段都没有时不该给出「主语言 · 」这种半截条');
});

/** 段表取样：一行常见的详情行（英文描述 + 英文 README），用例只在上面覆盖自己那一格。 */
const secRow = (over = {}) => ({
  repo: 'vitejs/vite', desc: 'Next generation frontend tooling.',
  lang: 'TypeScript', license: 'MIT', stars: 83143, forks: 8824, issues: 773,
  topics: ['build-tool', 'dev-server'], pushedAt: '2026-10-05T00:59:06Z', createdAt: '2020-04-21T05:03:57Z',
  readmeSource: 'en_default', readmePath: 'README', readmeExcerpt: 'Next generation frontend tooling. Drop-in replacement.',
  readmeChars: 4235, zhCjk: 0, ...over,
});
const secOf = (secs, key) => secs.find((s) => s.key === key);
const secTexts = (secs, key) => (secOf(secs, key)?.blocks ?? []).map((b) => b.text).join('\n');
const allText = (secs) => JSON.stringify(secs);

check('repoSections：段序只认 REPO_SECTION_KEYS，块 kind 只出 REPO_BLOCK_KINDS 那四档', () => {
  const secs = repoSections(secRow(), { summary: { text: '一段中文摘要。', label: engineZhLabel('keyless', 1) } });
  assert.deepEqual(secs.map((s) => s.key), ['what', 'heat', 'self', 'summary']);
  assert.deepEqual(REPO_SECTION_KEYS, ['what', 'heat', 'self', 'summary'], '段序表本身：客户端与用例都从这里取，别在第三处再写一遍');
  for (const s of secs) {
    assert.ok(REPO_SECTION_KEYS.includes(s.key), `拼出了没登记的段键 ${s.key} ⇒ 它会整段消失`);
    // ★ 第十七轮：summary 那一段的段名按档位分三档（中文摘要 / 中文节译 / 中文现译），
    //   所以这一格钉的是**domain 那三个词之内**，不钉其中某一个（钉死某一个 = 档位一变就假红）。
    const names = s.key === 'summary'
      ? [REPO_SECTION_LABELS.summary, REPO_SECTION_LABELS.summaryTranslate, REPO_SECTION_LABELS.summaryAny]
      : [REPO_SECTION_LABELS[s.key]];
    assert.ok(names.some((n) => s.label.startsWith(n)), `${s.key} 段的段名不是 domain 那几句：${s.label}`);
    // ★ 第十二轮（用户裁定「四段来源落款全撤」）：段对象**只有**这四格。多一格 `source` 就是废话回来了，
    //   少一格则是段表坏了 —— 所以这里钉整张键表，不钉那四句字面（字面已经不在树上，钉字面等于钉空气）。
    assert.deepEqual(Object.keys(s).sort(), ['blocks', 'facts', 'key', 'label'], `${s.key} 段的格子不是这四格`);
    for (const b of s.blocks) assert.ok(REPO_BLOCK_KINDS.includes(b.kind), `${s.key} 段里有没登记的块 kind：${b.kind}`);
  }
});

check('repoSections：只用字段里有的信息拼句子，空字段不写出「用  写的项目」', () => {
  const what = secTexts(repoSections(secRow()), 'what');
  assert.match(what, /这是一个用 TypeScript 写、MIT 许可证的项目/);
  assert.match(what, /主题 build-tool \/ dev-server/);
  assert.doesNotMatch(what, /用  写/, '空语言被拼进了句子');
  // 什么都没有的一行：只剩「没有描述」那一句实话（它不许整段消失，否则界面上像漏了字）
  const bare = repoSections({});
  assert.deepEqual(bare.map((s) => s.key), ['what'], '没数据就不摆那一整段：缺语言、缺星标时不许写「未知」占位');
  assert.equal(secTexts(bare, 'what'), '仓库没有写描述。');
  assert.doesNotMatch(allText(bare), /星|主题|推送|节选/);
});

check('repoSections：数字只在 heat 段出现一次（what 段不许再念一遍星标）', () => {
  const secs = repoSections(secRow());
  assert.doesNotMatch(secTexts(secs, 'what'), /83,143|8,824|773/, '热度数字并进了「是什么」那段 ⇒ 同屏两份影子');
  const heat = secOf(secs, 'heat').facts.map((f) => `${f.label}=${f.value}`);
  assert.deepEqual(heat, [
    `${REPO_FIELD_LABELS.stars}=83,143`,
    `${REPO_FIELD_LABELS.forks}=8,824`,
    `${REPO_FIELD_LABELS.issues}=773`,
    `${REPO_FIELD_LABELS.pushedAt}=2026-10-05`,
    `${REPO_FIELD_LABELS.createdAt}=2020-04-21`,
  ]);
  // 语言与许可证归 what（那是"是什么"），homepage 归底栏那个链接，都不进 facts ⇒ 一个数一个归属
  assert.ok(!secOf(secs, 'heat').facts.some((f) => ['language', 'license', 'homepage', 'topics'].includes(f.key)));
  // 只有归档标志、一个数字都没有 ⇒ heat 段仍然摆（标志是那句话的全部信息）
  const onlyFlag = repoSections(secRow({ stars: undefined, forks: undefined, issues: undefined, pushedAt: '', createdAt: '', archived: true }));
  assert.deepEqual(secOf(onlyFlag, 'heat').blocks, [{ kind: 'sub', text: REPO_FLAG_LABELS.archived }]);
  assert.equal(secOf(onlyFlag, 'heat').facts.length, 0);
});

check('repoSections：描述那一句有五种来源，字面必须分得开（本轮最容易说假话的一格）', () => {
  const at = Date.UTC(2026, 9, 6, 1, 20);
  const zh = (over = {}) => repoSections(secRow(over));
  // ① 仓库自己写的就是中文 ⇒ 明说没调用翻译接口
  const self = secTexts(zh({ desc: '下一代前端构建工具，开箱即用。', descSelfZh: true }), 'what');
  assert.match(self, /仓库自己写的描述（这句本身就是中文，没有调用翻译接口）：下一代前端构建工具，开箱即用。/);
  assert.doesNotMatch(self, /免费接口|模型现译|内置离线预译/, '自带中文的那一句不许挂任何译文落款');
  // ② 内置离线表命中（多一句，原文照给）
  const [bRepo, bSrc, bZh] = DESC_ZH_ROWS[0];
  const builtinLines = secTexts(repoSections(secRow({ repo: bRepo, desc: bSrc })), 'what');
  assert.ok(builtinLines.includes(`中文描述（${DESC_ZH_LABEL}，不是现译）：${bZh}`), `表命中那句没拼出来：\n${builtinLines}`);
  assert.ok(builtinLines.includes(`仓库自己写的描述（原文）：${bSrc}`), '译文是加出来的，不是把原文换掉的');
  // ③ 现译给了译文 ⇒ 落款跟着**这一行自己的**引擎与时刻
  const t = secTexts(repoSections(secRow(), { descModel: { zh: '下一代工具。', at, engine: 'baidu', label: engineZhLabel('baidu', at) } }), 'what');
  assert.equal(t.split('\n')[0], `中文描述（百度 · 10-06 09:20）：下一代工具。`);
  assert.ok(t.includes('仓库自己写的描述（原文）：Next generation frontend tooling.'));
  assert.doesNotMatch(t, /未翻译|内置离线预译/);
  // ④ 什么都没给 ⑤ 压根没描述
  assert.match(secTexts(repoSections(secRow({ repo: 'no/such-repo' })), 'what'), /仓库自己写的描述（原文，未翻译）：/);
  // ⑤ 压根没描述：那句实话必须在，且不许再拼「原文：」那半截
  const noDesc = secTexts(repoSections(secRow({ desc: '' })), 'what');
  assert.ok(noDesc.startsWith('仓库没有写描述。'), noDesc);
  assert.doesNotMatch(noDesc, /原文|未翻译/);
  // B 优先：表命中时模型那句不许抢（那一发压根不该派）
  const both = secTexts(repoSections(secRow({ repo: bRepo, desc: bSrc }), { descModel: { zh: '模型想抢这句', at, engine: 'baidu', label: engineZhLabel('baidu', at) } }), 'what');
  assert.ok(both.startsWith(`中文描述（${DESC_ZH_LABEL}，不是现译）：${bZh}`));
  assert.doesNotMatch(both, /模型想抢这句/);
  // 坏时刻：只丢时刻，不丢译文，也不写出 NaN
  const noWhen = secTexts(repoSections(secRow(), { descModel: { zh: '一句中文', at: '昨天', engine: 'baidu', label: engineZhLabel('baidu', '昨天') } }), 'what');
  assert.match(noWhen, /中文描述（百度）：一句中文/);
  assert.doesNotMatch(noWhen, /NaN/);
  // 现译失败：note 与回执各一块，回执带「回执：」前缀（这两句从前是客户端拼的，第十一轮搬到宿主）
  const failed = repoSections(secRow(), { descNote: '这一档没配凭据，原文照给', descErr: 'no creds' });
  assert.deepEqual(secOf(failed, 'what').blocks.slice(-2), [
    { kind: 'sub', text: '这一档没配凭据，原文照给' },
    { kind: 'num', text: '回执：no creds' },
  ]);
});

check('repoSections：self 段名按 README 五档各点一档，zh_section 把小节名并进段名（第十二轮撤了段里那句说明）', () => {
  const secs = (over) => repoSections(secRow(over));
  const label = (over) => secOf(secs(over), 'self')?.label ?? '';
  const L = (src) => `${REPO_SECTION_LABELS.self} · ${REPO_README_SOURCE_LABELS[src]}`;
  assert.equal(label({ readmeSource: 'zh_default' }), L('zh_default'));
  // zh_file 那档：文件名不在段名里念第二遍，它已经在落款那句的 `· README-zh_CN.md` 里
  assert.equal(label({ readmeSource: 'zh_file', readmePath: 'README-zh_CN.md' }), L('zh_file'));
  assert.equal(label({ readmeSource: 'zh_section', readmeSection: '中文说明', readmeExcerpt: '这段是仓库自己写的中文说明。', zhCjk: 85 }),
    `${L('zh_section')}（小节「中文说明」）`, 'zh_section 那档的小节名并进段名（段里那句说明撤了，这是它唯一的去处）');
  // 开篇那段中文（第一个标题之前）没有小节名 ⇒ 那半括号整个不说，不许留「小节「」」
  assert.equal(label({ readmeSource: 'zh_section', readmeSection: '', readmeExcerpt: '这段是仓库自己写的中文说明。' }), L('zh_section'));
  assert.doesNotMatch(label({ readmeSource: 'zh_section' }), /小节「」/);
  assert.equal(label({ readmeSource: 'en_default', zhCjk: 0 }), L('en_default'));
  // ★ 第十九轮：摘要闸门命中时，档名后面跟半句实话（这些篇屏上就摆着中文，档名干念「默认 README 是英文」会被问回来）
  assert.equal(label({ readmeSource: 'en_default', readmeExcerpt: 'English | 中文 | 繁體中文 | 日本語 — a plugin.' }),
    `${L('en_default')}${README_ZH_GATE_SUFFIXES.cjk}`, '混排命中却没补那半句（真机 claude-mem 的形状，9 个 CJK）');
  assert.equal(label({ readmeSource: 'en_default', readmeExcerpt: 'English | 中文 — a vue ui library.' }),
    `${L('en_default')}${README_ZH_GATE_SUFFIXES.lang}`, '只剩切换行字样时补的是那一句，两档字面不许混用');
  // 闸门只吃 `en_default`：另外四档的段名一个字都不许多（`zh_*` 三档的中文由档名自己说，`none` 没正文）
  for (const src of ['zh_default', 'zh_file', 'zh_section']) {
    assert.doesNotMatch(label({ readmeSource: src, readmeSection: '中文说明', readmeExcerpt: '这段是仓库自己写的中文说明。' }),
      /节选里已有中文|这行写着有中文版/, `${src} 那档不该被补上第十九轮那半句`);
  }
  assert.equal(label({ readmeSource: 'none', readmeExcerpt: '', readmeChars: 0 }), L('none'));
  // 段里没有那句五档说明句了：块只有节选 + 落款（`sub` 只在"有档但没正文可看"时出现）
  assert.deepEqual(secOf(secs({ readmeSource: 'en_default' }), 'self').blocks.map((b) => b.kind), ['excerpt', 'num']);
  assert.deepEqual(secOf(secs({ readmeSource: 'en_default', readmeExcerpt: '' }), 'self').blocks.map((b) => b.kind), ['sub'],
    '有 README 却没节选 ⇒ 那一句实话还得说（它不是来源落款）');
  // `none` 档：段名已经把话说完，段里不补一句「没有可显示的正文」（同屏两句同义 = 用户撤聚合条时立的那条律）
  assert.deepEqual(secOf(secs({ readmeSource: 'none', readmeExcerpt: '', readmeChars: 0 }), 'self').blocks, []);
  // 没登记过的来源 ⇒ 整段不摆（不编一句「没有说明」）
  assert.equal(secOf(secs({ readmeSource: '从没有这一档' }), 'self'), undefined);
  // 节选用 excerpt 块，落款用 num 块：客户端从前自己拼过一次，把整篇长度当成了屏上字数
  const self = secOf(secs({ readmeSource: 'en_default' }), 'self');
  // 「屏上给了多少 / 整篇多少」两个口径都在，但压成一行短字面（第十二轮「这里说明是 README 就可以了」）
  assert.equal(self.blocks[1].text, `节选 ${self.blocks[0].text.length} / 整篇 4,235 字 · 已去标记 · README`);
  assert.equal(self.blocks[0].text.length, 54, '取样行的节选长度：改了 secRow 就同步这一格，别把 54 当成屏上字数写死');
});

check('repoSections：summary 段成功只给正文与段名落款，失败给 note 与回执两行', () => {
  const ok = secOf(repoSections(secRow(), { summary: { text: '这是一个前端构建工具。', label: engineZhLabel('keyless', 1) } }), 'summary');
  assert.equal(ok.blocks.length, 1);
  assert.equal(ok.blocks[0].kind, 'p');
  // ★ 第十七轮（用户改判第十五轮③）：段名跟着那一路走 —— 只有宿主模型那档给的是**摘要**，
  //   免费/百度/腾讯/阿里给的是节选的**节译**。「是谁译的、什么时候」仍由段名说（第十二轮撤了段里那句来源落款）。
  assert.match(ok.label, /中文节译 · 免费接口 · /);
  const hosted = secOf(repoSections(secRow(), { summary: { text: '这是一个前端构建工具。', engine: 'host_llm', label: llmZhLabel(1) } }), 'summary');
  assert.match(hosted.label, /中文摘要 · 模型现译 · /, '宿主模型那一档才配叫摘要');
  assert.equal('source' in ok, false, '摘要段不许再有 source 格（那句「由免费翻译接口从上面那段英文节选整理」已随落款一起撤）');
  const noZh = secOf(repoSections(secRow(), { summaryNote: '宿主没给模型服务，没有调用模型', summaryErr: 'no provider' }), 'summary');
  // ★ 失败行里没有 `engine`（译文行才署谁译的），切不出摘要/节译两档 ⇒ 用两边都罩得住的「中文现译」，不挂可能假的名字。
  assert.equal(noZh.label, '中文现译 · 没取到');
  assert.deepEqual(noZh.blocks, [
    { kind: 'sub', text: '宿主没给模型服务，没有调用模型' },
    { kind: 'num', text: '回执：no provider' },
  ]);
  // 摘要开关关着（两格都空）⇒ 整段不摆，不给一句「没取到」的假故障
  assert.equal(secOf(repoSections(secRow()), 'summary'), undefined);
});

check('repoSections：同一条失败句同屏只念一次 —— 摘要段那块跟着描述段去重（第十六轮）', () => {
  // 现场：两路现译同一个档（`pickTranslator` 只选一个服务），它挂掉时 descNote/summaryNote 与两格回执逐字相同。
  const note = '宿主没给模型服务（或还没就绪），没有调用模型';
  const err = 'NO_ADAPTER: no provider';
  const both = repoSections(secRow(), { descNote: note, descErr: err, summaryNote: note, summaryErr: err });
  assert.deepEqual(secOf(both, 'what').blocks.slice(-2), [
    { kind: 'sub', text: note },
    { kind: 'num', text: `回执：${err}` },
  ], '描述段那一屏是该说一次的（它是这两路共同的原因所在）');
  const sum = secOf(both, 'summary');
  assert.equal(sum.label, '中文现译 · 没取到', '段仍摆、段名仍说没取到 —— 撤的是重复那句，不是这一路的结论');
  assert.deepEqual(sum.blocks, [], '同字面的 note 与回执不许在摘要段再说第二遍');
  // 只在字面相同时去重：两路原因不同（描述成了、摘要太长）⇒ 各说各的，谁也不许顶掉谁
  const diff = secOf(repoSections(secRow(), { descNote: note, descErr: err, summaryNote: '', summaryErr: '1,842 字' }), 'summary');
  assert.deepEqual(diff.blocks, [{ kind: 'num', text: '回执：1,842 字' }]);
  // 只重一句：note 相同而回执不同 ⇒ note 撤、回执留（去重按格判，不是一格重就把整段撤掉）
  const half = secOf(repoSections(secRow(), { descNote: note, descErr: err, summaryNote: note, summaryErr: 'HTTP 503' }), 'summary');
  assert.deepEqual(half.blocks, [{ kind: 'num', text: '回执：HTTP 503' }]);
  // 描述那一路压根没派活（屏上没有那句）⇒ 摘要段的话一句都不能少
  const solo = secOf(repoSections(secRow(), { summaryNote: note, summaryErr: err }), 'summary');
  assert.deepEqual(solo.blocks, [
    { kind: 'sub', text: note },
    { kind: 'num', text: `回执：${err}` },
  ]);
});

check('repoSections：现译落款先吃那一行自带的 label，label 缺位才现算（旧行不许刷成新档的口吻）', () => {
  const at = Date.UTC(2026, 9, 6, 1, 20);
  // ★ 上一轮这条判据挂在 repoNarrative 上；第十一轮整段叙述撤了，落款同一件事搬进 what 段，字面一个字没改。
  const hosted = secTexts(repoSections(secRow(), { descModel: { zh: '下一代工具。', at, engine: 'host_llm', label: llmZhLabel(at) } }), 'what');
  assert.equal(hosted.split('\n')[0], `中文描述（${llmZhLabel(at)}）：下一代工具。`);
  assert.ok(hosted.includes('仓库自己写的描述（原文）：Next generation frontend tooling.'), '译文是加出来的，原文不许被换掉');
  assert.doesNotMatch(hosted, /未翻译|内置离线预译/, '给了译文还留着「未翻译」，一屏两句互相打脸');
  // label 缺位（库里旧行 / 调用方没算落款）⇒ 由 engine + 时刻现算，不许留空括号
  const bare = secTexts(repoSections(secRow(), { descModel: { zh: '一句中文', at, engine: 'keyless' } }), 'what');
  assert.equal(bare.split('\n')[0], `中文描述（${engineZhLabel('keyless', at)}）：一句中文`);
  assert.doesNotMatch(bare, /（）|（ ·|（NaN/);
});

check('applyZh：把两路结果并进载荷并重拼段表，B 命中时不抢口径，坏载荷也不炸', () => {
  const [bRepo, bSrc, bZh] = DESC_ZH_ROWS[0];
  const at = Date.UTC(2026, 9, 6, 1, 20);
  // ★ 夹具 = llm.js / web-translate.js 真的返回那副形状（含 `engine`）：少给一格，applyZh 就会拿 undefined 落档，
  //   而用例只看 label 的话，"换档之后落款跟不跟"这条判据压根没挂上。
  const okRow = (zh) => ({ ok: true, zh, cached: false, at, label: llmZhLabel(at), stored: true, note: '', errKey: '', errText: '', engine: 'host_llm' });

  // ★ 夹具用**真的 repoView()** 造：上一版这里手搓 `{ok,repo,desc,narrative}`，正好缺了 lang/stars 那些原始格子，
  //   于是重拼段表拿到的是空话头「仓库没有写描述。」而用例照样绿 —— 真机读数（10-06）才把它抓出来。
  const row = { ok: true, repo: 'o/r', desc: 'Next gen tooling.', lang: 'Rust', license: 'MIT', stars: 1234, forks: 56, issues: 7, topics: ['kit', 'web'], pushedAt: '2026-10-04T00:00:00Z', createdAt: '2026-06-01T00:00:00Z' };
  const view = repoView(row);
  const miss = applyZh(view, { descModel: okRow('下一代。') });
  assert.equal(miss.zh.builtin, '');
  assert.deepEqual(miss.zh.descModel, { zh: '下一代。', label: llmZhLabel(at), cached: false, at, engine: 'host_llm' });
  assert.equal(miss.zh.descNote, '', '成功那一路不该带失败句');
  const whatText = secTexts(miss.sections, 'what');
  assert.notEqual(whatText, secTexts(view.sections, 'what'), 'B 没命中而现译给了译文 ⇒ 描述那一句要换口径');
  assert.match(whatText, /这是一个用 Rust 写、MIT 许可证的项目/, '重拼不许把语言/许可证那些格子丢掉');
  assert.match(whatText, /中文描述（模型现译 · 10-06 09:20）：下一代。/);
  assert.ok(!/未翻译/.test(whatText));
  assert.match(secOf(miss.sections, 'heat').facts.map((f) => f.value).join(','), /1,234/, 'heat 段的数字是从 sectionFields 重算的，不是把 view 里那两份标签值塞回去');
  assert.equal('sectionFields' in miss, false, 'sectionFields 是宿主自己重拼用的那一格，用完就删，不许漏进载荷');

  // ★ 第九轮：落款跟着**这一行的引擎**走，不是跟着当前设置走。
  //   换档之后库里旧译文照用（省一次出网），但「免费接口译的」不许署成「模型现译」。
  const byKeyless = applyZh(view, { descModel: { ...okRow('下一代。'), label: engineZhLabel('keyless', at), engine: 'keyless' } });
  assert.equal(byKeyless.zh.descModel.engine, 'keyless');
  assert.match(secTexts(byKeyless.sections, 'what'), /中文描述（免费接口 · 10-06 09:20）：下一代。/, '段里那句来源必须点名免费接口，不许顶一句「模型现译」');
  const sumKeyless = applyZh(view, { summary: { ...okRow('一段摘要。'), label: engineZhLabel('keyless', at), engine: 'keyless' } });
  assert.equal('note' in sumKeyless.zh.summary, false, '摘要载荷不再有那句说明（第十二轮随段里的来源落款一起撤）');
  assert.equal(sumKeyless.zh.summary.label, engineZhLabel('keyless', at), '「是谁译的」跟着这一行走，段名念的就是它');
  assert.match(secOf(sumKeyless.sections, 'summary').label, /中文节译 · 免费接口 · /, '免费接口那一档给的是节译，不许署成「中文摘要」，也不许顶一句「模型现译」');
  const sumHosted = applyZh(view, { summary: { ...okRow('一段摘要。'), label: llmZhLabel(at), engine: 'host_llm' } });
  assert.match(secOf(sumHosted.sections, 'summary').label, /中文摘要 · 模型现译 · /, '宿主模型那一档仍是摘要（第十七轮只把措辞分档，没动这一档）');

  const hit = applyZh(repoView({ ...row, repo: bRepo, desc: bSrc }), { descModel: okRow('模型想抢这句') });
  assert.equal(hit.zh.builtin, bZh, 'builtin 那一格给的是内置表那句（界面据此判"这一行有 B"）');
  assert.match(secTexts(hit.sections, 'what'), new RegExp(`中文描述（${DESC_ZH_LABEL}，不是现译）：`), 'B 命中时段里用的是表那句');
  assert.doesNotMatch(secTexts(hit.sections, 'what'), /模型想抢这句/, '两个来源在同一屏打架');

  const failed = applyZh(view, { descModel: { ok: false, note: '模型这一发超时了，原文照给', errText: 'aborted after 8000ms' } });
  assert.equal(failed.zh.descModel, null);
  assert.equal(failed.zh.descNote, '模型这一发超时了，原文照给');
  assert.equal(failed.zh.descErr, 'aborted after 8000ms', '那句 note 承诺了「回执」，回执原文就得在载荷里，不然界面只能念一句空话');
  assert.deepEqual(secOf(failed.sections, 'what').blocks.slice(-2), [
    { kind: 'sub', text: '模型这一发超时了，原文照给' },
    { kind: 'num', text: '回执：aborted after 8000ms' },
  ], '失败那两行由宿主段表给出：客户端从前自己拼过一次前缀');

  const noReceipt = applyZh(view, { descModel: { ok: false, note: '这个开关没开，没有调用模型', errText: '' } });
  assert.equal(noReceipt.zh.descErr, '', '闸门这一档没发出去 ⇒ 回执格必须是空，段里那一块整个不出现');
  assert.equal(secOf(noReceipt.sections, 'what').blocks.some((b) => /回执/.test(b.text)), false);

  const sum = applyZh(view, { summary: okRow('一段摘要。') });
  assert.deepEqual(sum.zh.summary, { text: '一段摘要。', label: llmZhLabel(at), cached: false, at, engine: 'host_llm' });
  assert.equal(sum.zh.descModel, null, '只给摘要时描述那一格必须是 null，不是缺键');
  assert.equal(sum.zh.summaryErr, '', '成功那一路同样不该带回执');

  const sumFailed = applyZh(view, { summary: { ok: false, note: '宿主没给模型服务（或还没就绪），没有调用模型', errText: 'no provider' } });
  assert.equal(sumFailed.zh.summary, null);
  assert.equal(sumFailed.zh.summaryNote, '宿主没给模型服务（或还没就绪），没有调用模型');
  assert.equal(sumFailed.zh.summaryErr, 'no provider');
  assert.equal(secOf(sumFailed.sections, 'summary').label, '中文现译 · 没取到');

  // 坏载荷：ok:false / undefined / 没 zhModel 一律给全空 zh（客户端不必防"键在不在"）
  for (const v of [undefined, null, {}, { ok: false, repo: 'oops' }]) {
    const z = applyZh(v, {}).zh;
    assert.deepEqual(Object.keys(z).sort(), ['builtin', 'descErr', 'descModel', 'descNote', 'summary', 'summaryErr', 'summaryNote']);
    assert.equal(z.builtin, '', 'ok 不为 true 时不许给"命中"这种假信号');
    assert.equal(z.descModel, null);
  }
  assert.equal(applyZh({ ok: false, repo: 'o/r', desc: DESC_ZH_ROWS[0][1] }, {}).zh.builtin, '', '详情都没取到，_builtin_ 也不能报命中');
});

check('readmeMeta 落款：屏上多少 / 整篇多少 / 哪个文件，压成一行短字面（第十二轮「少一点废话」）', () => {
  // ★ 真机第一版的缺陷就是这个：客户端自己拼「节选 4,235 字」，那个数是**整篇原文**，
  //   屏上显示的却是**去标记后的首屏**（≤600）。夹具里两个数恰好相等（195 / 195），离线全绿。
  //   ⇒ 两个数**都还得在**（第十二轮压的是解释，不是数据：少了整篇那个数就说不清差在哪）。
  const head = '中'.repeat(README_HEAD_CHARS);
  assert.equal(
    readmeMeta({ readmeSource: 'en_default', readmeExcerpt: head, readmeChars: 4235, readmePath: 'README' }),
    `节选 ${README_HEAD_CHARS} / 整篇 4,235 字 · 已去标记 · README`,
  );
  assert.equal(
    readmeMeta({ readmeSource: 'zh_file', readmeExcerpt: '甲'.repeat(200), readmeChars: 4235, readmePath: 'README_zh.md' }),
    '节选 200 / 整篇 4,235 字 · 已去标记 · README_zh.md',
  );
  // 两个数相等时不再报整篇：那已经是整篇了，再说"整篇"就是把同一个数念两遍
  assert.equal(
    readmeMeta({ readmeSource: 'zh_default', readmeExcerpt: 'a'.repeat(195), readmeChars: 195, readmePath: 'README' }),
    '节选 195 字（整篇就这么多） · 已去标记 · README',
  );
  assert.equal(readmeMeta({ readmeSource: 'none', readmeChars: 0 }), '');
  assert.equal(readmeMeta({ readmeSource: 'en_default', readmeExcerpt: '', readmeChars: 88 }), '');
  assert.equal(readmeMeta({}), '');
  // 没有整篇长度可读时不许编一个数（undefined 会变成 NaN 或空，两句都不能出现在界面上）
  assert.equal(
    readmeMeta({ readmeSource: 'en_default', readmeExcerpt: 'abcd', readmePath: 'README' }),
    '节选 4 字 · 已去标记 · README',
  );
  // 没有文件名 ⇒ 那一段整个不出现（不留一个光秃秃的「· 」）
  assert.equal(readmeMeta({ readmeSource: 'en_default', readmeExcerpt: 'abcd', readmeChars: 9 }), '节选 4 / 整篇 9 字 · 已去标记');
});

/* ------------------------------------------------------------------ *
 * 4. 请求编排（真夹具）
 * ------------------------------------------------------------------ */
check('默认 README 本身就是中文 ⇒ 两发封顶，不去翻根目录', async () => {
  const f = fullTable();
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW });
  assert.equal(d.ok, true);
  assert.equal(d.readmeSource, 'zh_default');
  assert.deepEqual(f.seen.map((s) => s.path), [`/repos/${WEEKLY}`, `/repos/${WEEKLY}/readme`]);
  assert.equal(d.lang, '', '真接口的 ruanyf/weekly language 是 null（夹具原样），不是某个语言名');
  assert.equal(d.license, '');
  assert.equal(d.stars, 105170);
  assert.match(d.desc, /科技爱好者周刊/);
  assert.ok(d.zhCjk >= README_ZH_MIN_CJK);
});

check('默认篇是英文 ⇒ 才去列根目录，命中中文篇共四发，节选换成中文篇', async () => {
  const f = fullTable();
  const d = await fetchRepoDetail({ repo: ANT, fetchFn: f, now: NOW });
  assert.equal(d.readmeSource, 'zh_file');
  assert.equal(d.readmePath, 'README-zh_CN.md');
  assert.deepEqual(f.seen.map((s) => s.path), [
    `/repos/${ANT}`, `/repos/${ANT}/readme`, `/repos/${ANT}/contents/`, `/repos/${ANT}/contents/README-zh_CN.md`,
  ]);
  assert.match(d.readmeExcerpt, /企业级/);
  // 夹具只存 README 前缀（README_KEEP=2000），所以这里的读数是"喂进去的那篇的字节数"
  assert.equal(d.readmeChars, src(`/repos/${ANT}/contents/README-zh_CN.md`).keptLength);
  assert.equal(d.readmeChars, 2000);
});

check('readmeChars 跟着节选所在那一篇走，不是默认篇（合成两篇不同长度，专测归属）', async () => {
  const zhBody = '中'.repeat(1500);
  const enBody = 'English '.repeat(75);           // 600 字
  const f = makeApiFetch([
    src(`/repos/${ANT}`),
    { path: `/repos/${ANT}/readme`, text: enBody, headers: rateHead(40) },
    src(`/repos/${ANT}/contents/`),
    { path: `/repos/${ANT}/contents/README-zh_CN.md`, text: zhBody, headers: rateHead(38) },
  ]);
  const d = await fetchRepoDetail({ repo: ANT, fetchFn: f, now: NOW });
  assert.equal(d.readmeSource, 'zh_file');
  assert.equal(d.readmeChars, zhBody.length, `节选是中文篇，长度却记了英文篇：${d.readmeChars}`);
  const g = makeApiFetch([
    src(`/repos/${ANT}`),
    { path: `/repos/${ANT}/readme`, text: enBody, headers: rateHead(40) },
    src(`/repos/${VITE}/contents/`),             // 根目录没有中文篇
  ]);
  const e = await fetchRepoDetail({ repo: ANT, fetchFn: g, now: NOW });
  assert.equal(e.readmeSource, 'en_default');
  assert.equal(e.readmeChars, enBody.length);
});

check('根目录没有中文篇 ⇒ en_default，三发封顶（第四发是白花限额）', async () => {
  const f = fullTable();
  const d = await fetchRepoDetail({ repo: VITE, fetchFn: f, now: NOW });
  assert.equal(d.readmeSource, 'en_default');
  assert.equal(d.zhCjk, 0);
  assert.equal(f.seen.length, 3);
  assert.deepEqual(f.seen.map((s) => s.path).slice(-1), [`/repos/${VITE}/contents/`]);
});

check('第十五轮分家在载荷上兑现：长英文篇的节选真的到 1,600（旧口径恒 600，摘要那一发也只读到 600）', async () => {
  const enBody = '# Title\n\n' + Array.from({ length: 120 }, (_, i) => `Feature number ${i} of this project works offline too.`).join(' ');
  const f = makeApiFetch([
    src(`/repos/${VITE}`),
    { path: `/repos/${VITE}/readme`, text: enBody, headers: rateHead(41) },
    src(`/repos/${VITE}/contents/`),
  ]);
  const d = await fetchRepoDetail({ repo: VITE, fetchFn: f, now: NOW });
  assert.equal(d.readmeSource, 'en_default');
  assert.equal(d.zhCjk, 0, '判据挪到整篇上了 ⇒ 首屏 600 那档阈值不再是同一条');
  assert.equal(d.readmeCut, true);
  assert.ok(d.readmeExcerpt.length > README_HEAD_CHARS, `入库节选还是 600 ⇒ 交出去的是判据窗口，不是整篇：${d.readmeExcerpt.length}`);
  assert.ok(d.readmeExcerpt.length <= README_EXCERPT_MAX, `超了入库预算：${d.readmeExcerpt.length}`);
  assert.match(d.readmeExcerpt, /[.!?]$/, '屏上那一段断在句中（真机 10-07 那一屏的形状）');
  assert.equal(repoCacheRow(d).readmeExcerpt, d.readmeExcerpt, '入库行没原样带这一整段（schema 的 maxLength 就是 README_EXCERPT_MAX）');
  const meta = readmeMeta({ readmeSource: 'en_default', readmeExcerpt: d.readmeExcerpt, readmeChars: d.readmeChars, readmePath: 'README' });
  assert.ok(meta.startsWith(`节选 ${d.readmeExcerpt.length.toLocaleString('en-US')}`), `落款念的节选字数不是屏上那一段：${meta}`);
});

check('第十五轮第二路：根目录那一层没有中文篇、但语言切换行写着路径 ⇒ 只在命中时补一发（共四发封顶）', async () => {
  // 真机形状（alibaba/open-code-review）：中文 README 在 `docs/i18n/README.zh-CN.md`，根目录那一层压根没有它。
  // contents 列表吃的是 vitejs/vite 的**真清单**（只有 README.md），这样"根目录没命中"这一头是实测而不是我说的。
  const enBody = '# Title\n\n' + 'English prose here for the demo. '.repeat(20)
    + '\n\n[English](README.md) | <a href="docs/i18n/README.zh-CN.md">简体中文</a>\n';
  const zhBody = '# 中文说明\n\n' + '这是仓库自己写的中文 README，它不在根目录，而在 docs/i18n 下面。'.repeat(6);
  const f = makeApiFetch([
    src(`/repos/${VITE}`),
    { path: `/repos/${VITE}/readme`, text: enBody, headers: rateHead(40) },
    src(`/repos/${VITE}/contents/`),
    { path: `/repos/${VITE}/contents/docs/i18n/README.zh-CN.md`, text: zhBody, headers: rateHead(39) },
  ]);
  const d = await fetchRepoDetail({ repo: VITE, fetchFn: f, now: NOW });
  assert.equal(d.readmeSource, 'zh_file', `第二路没走通（实得 ${d.readmeSource}）`);
  assert.equal(d.readmePath, 'docs/i18n/README.zh-CN.md', '落款上的文件名要指到真取到的那一篇，不是硬写的 README');
  assert.deepEqual(f.seen.map((s) => s.path), [
    `/repos/${VITE}`, `/repos/${VITE}/readme`, `/repos/${VITE}/contents/`, `/repos/${VITE}/contents/docs/i18n/README.zh-CN.md`,
  ], '第二路多发或少发都算违约：列表照发，命中才补正文那一发');
  assert.equal(f.seen.length, 4, '一次详情点击 4 发封顶（匿名限额 60/小时，多一发就是榜面变慢）');
  assert.ok(f.seen.every((s) => s.host === 'api.github.com' && s.method === 'GET'), '出网域名或方法跑偏了');
  assert.match(d.readmeExcerpt, /仓库自己写的中文/);
  assert.equal(d.readmeChars, zhBody.length, '「整篇 N 字」指的得是节选所在那一篇');
  assert.ok(d.zhCjk >= README_ZH_MIN_CJK);
});

check('第二路那一发 404（语言切换行指着早被挪走或删除的文件）⇒ 回落 en_default，详情不炸', async () => {
  // 合成档：真接口没法按需触发"链接写着但文件不在"这一态（README 与文件之间没有一致性保证）。
  const enBody = '# Title\n\n' + 'English prose here for the demo. '.repeat(20)
    + '\n\n[简体中文](docs/i18n/README.zh-CN.md)\n';
  const f = makeApiFetch([
    src(`/repos/${VITE}`),
    { path: `/repos/${VITE}/readme`, text: enBody, headers: rateHead(40) },
    src(`/repos/${VITE}/contents/`),
    { path: `/repos/${VITE}/contents/docs/i18n/README.zh-CN.md`, status: 404, text: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/contents#get-a-repository-readme"}' },
  ]);
  const d = await fetchRepoDetail({ repo: VITE, fetchFn: f, now: NOW });
  assert.equal(d.ok, true, '那一发 404 把整次点击判成失败了');
  assert.equal(d.readmeSource, 'en_default');
  assert.equal(d.readmePath, 'README', '没取到的那一篇不许写在落款上');
  assert.equal(f.seen.length, 4, `404 之后不该再试别的路径：${f.seen.map((s) => s.path).join(' ')}`);
  assert.ok(d.readmeExcerpt.length > 0, '回落那一档屏上还是要有默认篇的节选');
});

check('默认篇外文 + 整篇嵌一段中文小节 ⇒ zh_section，仍三发封顶（本轮那条"零额外请求"的判据）', async () => {
  const f = zhFixtureFetch();
  const d = await fetchRepoDetail({ repo: ZK, fetchFn: f, now: NOW });
  assert.equal(d.ok, true);
  assert.equal(d.readmeSource, 'zh_section', `合成夹具的中文小节本该命中，实得 ${d.readmeSource}`);
  assert.equal(d.readmeSection, RD.zhSectionHeading);
  assert.equal(d.zhCjk, RD.zhSectionCjk, '段级 CJK 与夹具读数不一致 ⇒ 阈值吃的不是同一个数');
  assert.equal(d.readmePath, 'README', '小节出自默认篇，落款上的文件名不能写成一篇根本没存在过的中文 README');
  // ★ 三发 = meta + readme + contents（zh_file 那一档排在前面，列表照发）；小节这一档**没有第四发**。
  assert.equal(f.seen.length, 3, `多出来的那一发就是把"零额外请求"违约了：${f.seen.map((s) => s.path).join(' ')}`);
  assert.deepEqual(f.seen.map((s) => s.path), [`/repos/${ZK}`, `/repos/${ZK}/readme`, `/repos/${ZK}/contents/`]);
  // 节选是那段中文，不是外文首屏：首屏 4 个汉字（RD.readmeHeadCjk）连闸门都过不去
  assert.equal(RD.readmeHeadIsZh, false, '夹具首屏本该不是中文，否则这一判测的是 zh_default');
  assert.match(d.readmeExcerpt, /[一-鿿]/);
  assert.equal(d.readmeChars, ZH_MD.length, '「原文整篇 N 字」指的还是默认 README 那一篇');
  assert.equal(d.descSelfZh, false);
});

check('descSelfZh：仓库自己写的描述是中文 ⇒ 入库行带 true，且这一档不靠翻译接口（零出网差别，纯判据）', async () => {
  // 真接口里"描述本身就是中文"的行在本机榜面只有 1 个（tmp/probe-desc-zh.txt）⇒ 这里把真夹具那行的 description 换成中文，
  // ★ 只换**接口正文里那一格**（走真 JSON.parse 路径），不手搓 detail 对象。
  const zhDesc = JSON.parse(JSON.stringify(src(`/repos/${WEEKLY}`)));
  zhDesc.text = JSON.stringify({ ...JSON.parse(zhDesc.text), description: '每周更新的技术文章与开源项目推荐，纯人工整理。' });
  const f = fullTable([zhDesc]);
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW });
  assert.equal(d.descSelfZh, true, '56 个汉字的描述判不出自带中文 ⇒ 那一发现译是白派的假活');
  assert.equal(repoCacheRow(d).descSelfZh, true, '这一格不落库，下次读缓存就得重算一遍');
  const en = await fetchRepoDetail({ repo: VITE, fetchFn: fullTable(), now: NOW });
  assert.equal(en.descSelfZh, false, '英文描述被判成自带中文 ⇒ 该派的现译被闸门挡了');
});

check('每发只 GET api.github.com，accept 按用途分，且带 accept-encoding: identity', async () => {
  const f = fullTable();
  await fetchRepoDetail({ repo: ANT, fetchFn: f, now: NOW });
  for (const s of f.seen) {
    assert.equal(s.method, 'GET', `${s.path} 不是 GET`);
    assert.equal(s.host, 'api.github.com');
    assert.equal(s.url.startsWith(`${GITHUB_API_BASE}/`), true, `打到别处去了：${s.url}`);
    assert.equal(s.headers['accept-encoding'], 'identity', `${s.path} 没要原文`);
    assert.ok(typeof s.headers.accept === 'string' && s.headers.accept.startsWith('application/vnd.github'), `${s.path} 的 accept ${s.headers.accept}`);
    if (s.path.endsWith('/readme') || s.path.includes('/contents/README')) assert.equal(s.headers.accept, 'application/vnd.github.raw', `${s.path} 该要 raw 正文`);
    assert.equal(s.signal?.aborted, false);
    assert.equal(s.timeoutMs, REPO_TIMEOUT_MS, '单发预算没交给传输层，REPO_TIMEOUT_MS 就成了假数字');
  }
});

check('README 404 不算失败：元数据照样给，来源记 none（404 正文是真接口那份）', async () => {
  const f = makeApiFetch([
    src(`/repos/${WEEKLY}`),
    { path: `/repos/${WEEKLY}/readme`, status: 404, text: src('/repos/this-org/no-such-repo-xyz').text, headers: rateHead(39) },
  ]);
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW });
  assert.equal(d.ok, true);
  assert.equal(d.readmeSource, 'none');
  assert.equal(d.readmeExcerpt, '');
  assert.equal(d.readmeChars, 0);
  assert.equal(f.seen.length, 2, 'README 都没有，不该再去列根目录');
});

check('元数据 404 ⇒ not_found，且不再发后面几发', async () => {
  const f = makeApiFetch([src('/repos/this-org/no-such-repo-xyz')]);
  const d = await fetchRepoDetail({ repo: 'this-org/no-such-repo-xyz', fetchFn: f, now: NOW });
  assert.equal(d.ok, false);
  assert.equal(d.errKey, 'not_found');
  assert.equal(d.transport, false, '404 不是路不通');
  assert.equal(f.seen.length, 1);
  assert.match(d.errText, /返回 404/);
});

check('403 + remaining:0 ⇒ rate_limited，并把重置时刻说成可读时间（合成响应，夹具已登记来处）', async () => {
  const f = makeApiFetch([{ path: '/repos/x/y', status: 403, text: '{"message":"API rate limit exceeded"}', headers: { ...rateHead(0, 1791180000) } }]);
  const d = await fetchRepoDetail({ repo: 'x/y', fetchFn: f, now: NOW });
  assert.equal(d.errKey, 'rate_limited');
  assert.equal(d.transport, false);
  assert.match(d.errText, /限额用尽/);
  assert.equal(d.rate.left, 0);
  assert.equal(d.rate.resetAt, 1791180000 * 1000);
});

check('403 但额度还剩 ⇒ 不念"你没额度了"（黑名单/权限问题不能伪装成限额）', async () => {
  const f = makeApiFetch([{ path: '/repos/x/y', status: 403, text: '{"message":"Forbidden"}', headers: rateHead(41) }]);
  const d = await fetchRepoDetail({ repo: 'x/y', fetchFn: f, now: NOW });
  assert.equal(d.errKey, 'transport');
  assert.match(d.errText, /返回 403/);
});

check('传输抛错分两档：连不上记 transport，代理配置坏记 config 且不谎报"没连上"', async () => {
  const a = makeApiFetch([{ path: '/repos/x/y', throw: 'socket hang up', code: 'ECONNRESET' }]);
  const da = await fetchRepoDetail({ repo: 'x/y', fetchFn: a, now: NOW });
  assert.equal(da.errKey, 'transport');
  assert.equal(da.transport, true);

  const b = makeApiFetch([{ path: '/repos/x/y', throw: '代理端口不合法', code: 'proxy_config' }]);
  const db = await fetchRepoDetail({ repo: 'x/y', fetchFn: b, now: NOW });
  assert.equal(db.errKey, 'config');
  assert.equal(db.transport, false, '坏配置这一发根本没出发，不能算"路不通"');
});

check('正文不是 JSON ⇒ parse 档（接口改版要单独说）', async () => {
  const f = makeApiFetch([{ path: '/repos/x/y', status: 200, text: '<html>rate limited page</html>', headers: rateHead(30) }]);
  const d = await fetchRepoDetail({ repo: 'x/y', fetchFn: f, now: NOW });
  assert.equal(d.errKey, 'parse');
  assert.equal(f.seen.length, 1);
});

check('限额头读进 rate：真夹具读数照原样给，没有头时 left 保持 null（不谎报还剩 60）', async () => {
  const f = fullTable();
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW });
  const last = src(`/repos/${WEEKLY}/readme`).headers['x-ratelimit-remaining'];
  assert.equal(d.rate.left, Number(last));
  assert.ok(d.rate.resetAt > 0);

  const g = makeApiFetch([{ path: '/repos/x/y', status: 200, text: JSON.stringify({ full_name: 'x/y' }) }]);
  const d2 = await fetchRepoDetail({ repo: 'x/y', fetchFn: g, now: NOW });
  assert.equal(d2.ok, true);
  assert.equal(d2.rate.left, null);
  assert.equal(d2.rate.resetAt, 0);
});

check('GitHub 把计数写成 null 时不炸整行：那一格当"没有这个字段"', async () => {
  const meta = { ...JSON.parse(src(`/repos/${WEEKLY}`).text) };
  meta.stargazers_count = null;
  meta.forks_count = 'abc';
  meta.language = null;
  const f = makeApiFetch([
    { path: `/repos/${WEEKLY}`, text: JSON.stringify(meta), headers: src(`/repos/${WEEKLY}`).headers },
    src(`/repos/${WEEKLY}/readme`),
  ]);
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW });
  assert.equal(d.ok, true);
  assert.equal(d.stars, undefined);
  assert.equal(d.forks, undefined);
  assert.equal(d.lang, '');
  assert.equal(repoCacheRow(d).stars, undefined, 'NaN 进库会让整行 INVALID');
});

/* ------------------------------------------------------------------ *
 * 5. 出边界的两份形状
 * ------------------------------------------------------------------ */
check('repoCacheRow 只落 schema 字段：rate / cached / sections / sectionFields 一个字都不进库', async () => {
  const f = fullTable();
  const svc = createRepoDetailService({ repoStore: null, fetchFn: f, now: NOW });
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW });
  const view = repoView(d, { cached: false, rate: d.rate });
  const row = repoCacheRow(view);
  // ★ 钉的是「视图上有、入库行里必须没有」：只断 undefined 的话，一个**从来不存在**的键也能蒙过去（假绿）。
  for (const k of ['sections', 'sectionFields', 'rate', 'cached', 'cacheAgeMs', 'error']) {
    assert.ok(k in view, `夹具走的是真 repoView，视图上却没有 ${k} ⇒ 这一判压根没挂上`);
    assert.equal(row[k], undefined, `视图字段漏进了入库行：${k}`);
  }
  assert.equal(row.repo, WEEKLY);
  assert.equal(row.ok, true);

  const facility = makeFakeFacility();
  const store = createRepoCacheStore({ getFacility: () => facility, logger: { warn: () => {} } });
  const put = await store.put(row);
  assert.equal(put.dropped, 0);
  assert.equal(facility.rowCount('gh_trending', 'repo'), 1);
  const back = await store.get(WEEKLY);
  assert.equal(back.repo, WEEKLY.toLowerCase(), '入库键统一小写，取回还是同一行');
  assert.equal(back.readmeSource, 'zh_default');
  assert.equal(typeof svc.load, 'function');

  // ★ 第十一轮新增的两格必须真能存下来：schema 不认会把整行判 INVALID（静默丢缓存 ⇒ 每次点击都出网）。
  const zhRow = repoCacheRow(await fetchRepoDetail({ repo: ZK, fetchFn: zhFixtureFetch(), now: NOW }));
  assert.equal(zhRow.readmeSource, 'zh_section');
  assert.equal(zhRow.readmeSection, RD.zhSectionHeading);
  assert.equal(zhRow.descSelfZh, false, '没命中时那一格也得写死 false，别靠"缺位"让下次读不出闸门');
  const putZh = await store.put(zhRow);
  assert.equal(putZh.dropped, 0, `新字段没进 schema ⇒ 整行被拒：${JSON.stringify(putZh)}`);
  const backZh = await store.get(ZK);
  assert.equal(backZh.readmeSection, RD.zhSectionHeading, '存进去又读不出来等于没存');
  assert.equal(backZh.descSelfZh, false);
  assert.equal(backZh.version ?? 1, 1, '仓储版本行仍是 1：加两格字段不该抬版本（抬了旧库读不出）');
});

check('失败行只带 errKey/errText 两样，且 errKey 必须在封闭集合里（否则整行 INVALID）', async () => {
  const f = makeApiFetch([src('/repos/this-org/no-such-repo-xyz')]);
  const d = await fetchRepoDetail({ repo: 'this-org/no-such-repo-xyz', fetchFn: f, now: NOW });
  const row = repoCacheRow(d);
  assert.deepEqual(Object.keys(row).sort(), ['at', 'errKey', 'errText', 'ok', 'repo']);
  assert.ok(Object.keys(REPO_ERROR_LABELS).includes(row.errKey));

  const facility = makeFakeFacility();
  const store = createRepoCacheStore({ getFacility: () => facility, logger: { warn: () => {} } });
  await store.put(row);
  assert.equal((await store.get('this-org/no-such-repo-xyz')).errKey, 'not_found');
  // 没登记的 errKey 必须被 schema 拦下，而不是默默存进去让下次读炸
  await assert.rejects(() => store.put({ ...row, errKey: '从没有的档' }));
});

check('缓存命中与刚取回两条路的载荷逐键同形（改字段只能改一处）', async () => {
  const f = fullTable();
  const facility = makeFakeFacility();
  const store = createRepoCacheStore({ getFacility: () => facility, logger: { warn: () => {} } });
  let clock = NOW();
  const svc = createRepoDetailService({ repoStore: store, fetchFn: f, now: () => clock });
  const fresh = await svc.load(ANT);
  const cached = await svc.load(ANT);
  assert.deepEqual(Object.keys(cached).sort(), Object.keys(fresh).sort());
  assert.equal(fresh.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(cached.cacheAgeMs, 0);
  assert.equal(cached.readmeSource, fresh.readmeSource);
  assert.equal(cached.readmeExcerpt, fresh.readmeExcerpt);
  assert.equal(f.seen.length, 4, '第二次点击又打了一遍接口');
  // ★ 中文段表逐字同形：两条路各自拼一份的话，改天加一段只有一条有 —— 那是"第二次点击才看得见"的事故形状。
  assert.equal(JSON.stringify(cached.sections), JSON.stringify(fresh.sections), '两条路拼出来的段表不一样');
  // ★ 服务这一层**留着** sectionFields（api 的 attachZh 靠它重拼，用完才从载荷删掉）：
  //   两条路少一条有，缓存命中那次点"换引擎重译"就会拼出「仓库没有写描述。」那种空话头。
  assert.ok(fresh.sectionFields && cached.sectionFields, '两条路都得留下重拼用的原始格子');
  assert.equal(JSON.stringify(cached.sectionFields), JSON.stringify(fresh.sectionFields));
});

check('视图：认识的 errKey 翻成人话，不认识的原样交回；ok:false 一段都不摆', () => {
  const known = repoView({ repo: 'x/y', ok: false, errKey: 'not_found', errText: 'raw', at: 1 });
  assert.equal(known.error, REPO_ERROR_LABELS.not_found);
  assert.deepEqual(known.sections, [], '取失败的行没有正文也没有元数据，摆一段空壳就是把"没取到"说成"没有内容"');
  assert.equal(known.sectionFields, null);
  assert.equal(known.zhCjk, 0);
  const unknown = repoView({ repo: 'x/y', ok: false, errKey: '没登记过的档', at: 1 });
  assert.equal(unknown.error, '没登记过的档', '界面不许猜翻译，原样交回');
  assert.equal(unknown.rate.limit, REPO_RATE_ANON);
  assert.equal(unknown.rate.left, null);
});

check('视图的标签全部来自 domain 一张表（客户端不自己写中文）', async () => {
  const f = fullTable();
  const d = await fetchRepoDetail({ repo: ANT, fetchFn: f, now: NOW });
  const v = repoView({ ...d, archived: true, isFork: true }, { rate: d.rate });
  const self = secOf(v.sections, 'self');
  const heat = secOf(v.sections, 'heat');
  assert.equal(self.label, `${REPO_SECTION_LABELS.self} · ${REPO_README_SOURCE_LABELS.zh_file}`);
  assert.deepEqual(heat.blocks, [
    { kind: 'sub', text: REPO_FLAG_LABELS.archived },
    { kind: 'sub', text: REPO_FLAG_LABELS.fork },
  ], '归档/复刻那两句话从前是 v.flags，第十一轮搬进 heat 段的块里');
  // 段名与列名全部取自 domain 的表：客户端那半边一个字都不该自己写
  assert.deepEqual(heat.facts.slice(0, 2).map((x) => x.label), [REPO_FIELD_LABELS.stars, REPO_FIELD_LABELS.forks]);
  for (const s of v.sections) assert.ok(s.label.startsWith(REPO_SECTION_LABELS[s.key]), `${s.key} 的段名不是 domain 那句`);
});

/* ------------------------------------------------------------------ *
 * 6. 缓存门面（TTL / 去重 / 降级）
 * ------------------------------------------------------------------ */
async function mkService({ rows = [], clock = { at: NOW() }, storeOpts = {}, getTtlMs } = {}) {
  const facility = makeFakeFacility();
  const store = createRepoCacheStore({ getFacility: () => facility, logger: { warn: () => {} }, ...storeOpts });
  await store.get('open/first');                    // 先把域打开，seed 才塞得进（假设施按真宿主口径要求域已 open）
  for (const r of rows) facility.seed('gh_trending', 'repo', String(r.repo).toLowerCase(), r);
  const f = fullTable();
  // 不给 getTtlMs 时走 domain 的默认档（24 小时）：用例不许在第三处再写一个毫秒数
  const svc = createRepoDetailService({ repoStore: store, fetchFn: f, now: () => clock.at, ...(getTtlMs ? { getTtlMs } : {}) });
  return { svc, f, store, facility, clock };
}

check('库里躺着今天那一行 ⇒ 第一次点击也不出网，中文段表仍由入库字段拼出来', async () => {
  const seeded = repoCacheRow(await fetchRepoDetail({ repo: ANT, fetchFn: fullTable(), now: () => NOW() - 60_000 }));
  const { svc, f } = await mkService({ rows: [seeded] });
  const v = await svc.load(ANT);
  assert.equal(v.cached, true);
  assert.equal(f.seen.length, 0, '缓存里就有今天的行，还打接口是白花限额');
  assert.equal(v.readmeSource, 'zh_file');
  assert.match(secTexts(v.sections, 'what'), /React/, '入库行拼不出描述那句 ⇒ 存的时候漏了字段');
  assert.ok(secOf(v.sections, 'self').blocks.some((b) => b.kind === 'excerpt'), '入库行拼不出 README 节选块 ⇒ 存的字段不够界面用');
  assert.equal(secOf(v.sections, 'self').label, `${REPO_SECTION_LABELS.self} · ${REPO_README_SOURCE_LABELS.zh_file}`);
  assert.ok(secOf(v.sections, 'heat').facts.some((x) => x.key === 'stars'), '入库行拼不出元数据条，说明存的字段不够界面用');
});

check('出厂 24 小时内的第二次点击不发网络；过了 24 小时才重取', async () => {
  const { svc, f, clock } = await mkService();
  await svc.load(ANT);
  assert.equal(f.seen.length, 4);
  clock.at += REPO_CACHE_TTL_MS - 1000;
  const hit = await svc.load(ANT);
  assert.equal(hit.cached, true);
  assert.equal(f.seen.length, 4, '没到 TTL 就重取，限额是硬的');
  clock.at += 2000;
  await svc.load(ANT);
  assert.equal(f.seen.length, 8, '过了 TTL 该重取');
});

check('TTL 调用时现取现算：设置页改档，下一发详情就按新档判新鲜（不在装配时锁死）', async () => {
  let hours = REPO_CACHE_DEFAULT_HOURS;
  const { svc, f, clock } = await mkService({ getTtlMs: () => repoCacheTtlMs(hours) });
  await svc.load(ANT);
  assert.equal(f.seen.length, 4);
  // 出厂 24 小时：过了 7 小时仍是缓存
  clock.at += 7 * 60 * 60 * 1000;
  assert.equal((await svc.load(ANT)).cached, true, '24 小时档下 7 小时不该重取');
  assert.equal(f.seen.length, 4);
  // ★ 用户把档位改成 6 小时 —— 已经躺了 7 小时的那一行当场过期，下一发就该重取。
  //   装配时把毫秒抄进服务的话，这一发照样给缓存，而设置页上已经写着「6 小时」（两份真相）。
  hours = 6;
  assert.equal((await svc.load(ANT)).cached, false, '改档之后还按旧档给缓存 ⇒ TTL 被锁在装配时了');
  assert.equal(f.seen.length, 8);
  // 档位 → 毫秒只有一个算法：界面上的档位名与真跑的 TTL 不许各算各的
  assert.deepEqual(REPO_CACHE_HOURS.map(repoCacheTtlMs), [6, 12, 24, 72].map((h) => h * 60 * 60 * 1000));
  assert.equal(repoCacheTtlMs(undefined), REPO_CACHE_TTL_MS, '没选档 = 出厂档，不是 0（0 = 每次点击都出网）');
  assert.equal(repoCacheTtlMs(0), REPO_CACHE_TTL_MS, '档位外的值退回出厂档，不许把缓存整个关掉');
  assert.equal(repoCacheTtlMs('6'), 6 * 60 * 60 * 1000, '查询串里来的字符串要吃下（同 clampPrefs 的 Number 口径）');
  assert.equal(REPO_CACHE_TTL_MS, 24 * 60 * 60 * 1000, '默认那一档：第十二轮从 12 小时改判为 24 小时');
});

check('失败行只钉 5 分钟：改名后重点，过窗就给新答案', async () => {
  const { svc, f, clock } = await mkService();
  const missing = 'this-org/no-such-repo-xyz';
  const first = await svc.load(missing);
  assert.equal(first.ok, false);
  assert.equal(f.seen.length, 1);
  clock.at += REPO_FAIL_TTL_MS - 1;
  assert.equal((await svc.load(missing)).cached, true);
  assert.equal(f.seen.length, 1);
  clock.at += 2;
  const again = await svc.load(missing);
  assert.equal(again.cached, false);
  assert.equal(f.seen.length, 2, '失败行按成功行的那一档钉住（最长 3 天），用户改完名也看不到新答案');
});

check('refresh=true 越过缓存重取，并把新行覆盖回库', async () => {
  const { svc, f, facility } = await mkService();
  await svc.load(WEEKLY);
  const n0 = f.seen.length;
  const r = await svc.load(WEEKLY, { refresh: true });
  assert.equal(r.cached, false);
  assert.equal(f.seen.length, n0 + 2);
  assert.equal(facility.rowCount('gh_trending', 'repo'), 1, '重取该覆盖同一行，不是多塞一行');
});

check('同一个人连点两次只发一遍（in-flight 去重按仓库键）', async () => {
  const { svc, f } = await mkService();
  const [a, b] = await Promise.all([svc.load(ANT), svc.load(ANT)]);
  assert.equal(f.seen.length, 4);
  assert.equal(a.readmeSource, 'zh_file');
  assert.equal(b.readmeSource, 'zh_file');
  const c = await svc.load(VITE);
  assert.equal(c.readmeSource, 'en_default', '去重表按仓库键分，别把 vite 的答案给了 antd');
});

check('没有存储时详情照样给，只是每次都得发（能力位不谎报，功能不假装在）', async () => {
  const f = fullTable();
  const store = createRepoCacheStore({ getFacility: () => undefined, logger: { warn: () => {} } });
  assert.equal(store.available, false);
  const svc = createRepoDetailService({ repoStore: store, fetchFn: f, now: NOW });
  const a = await svc.load(ANT);
  const b = await svc.load(ANT);
  assert.equal(a.ok, true);
  assert.equal(a.cached, false);
  assert.equal(b.cached, false);
  assert.equal(f.seen.length, 8);
});

check('仓储读炸了当"没缓存"处理，不把一次点击整个判失败', async () => {
  const f = fullTable();
  const store = { available: true, get: async () => { throw new Error('域坏了'); }, put: async (row) => ({ key: row.repo, dropped: 0 }) };
  const svc = createRepoDetailService({ repoStore: store, fetchFn: f, now: NOW });
  const v = await svc.load(ANT);
  assert.equal(v.ok, true);
  assert.equal(v.cached, false);
  assert.equal(f.seen.length, 4);
});

check('限额读数：没碰过 API 是 null，碰过之后跟着最近一发（界面才能如实说剩多少）', async () => {
  const { svc, f } = await mkService();
  assert.deepEqual(svc.rate(), { limit: REPO_RATE_ANON, left: null, resetAt: 0, label: RATE_LABEL_ANON });
  await svc.load(WEEKLY);
  const left = Number(src(`/repos/${WEEKLY}/readme`).headers['x-ratelimit-remaining']);
  assert.equal(svc.rate().left, left);
  assert.equal(svc.rate().resetAt, Number(src(`/repos/${WEEKLY}/readme`).headers['x-ratelimit-reset']) * 1000);
  assert.equal(f.seen.length, 2);
});

/* ------------------------------------------------------------------ *
 * 第二十一轮：GitHub 令牌（只进请求头）与「上限跟着响应头」
 *
 * ★ 形状出处：`x-ratelimit-limit: 5000` 那一发是**合成**的 —— 本机没有 GitHub 账号也没有令牌，
 *   2026-10-07 实测抓下来的夹具每一发都写着 60（tmp/probe-repo.txt）。所以这几条钉的是
 *   「读 GitHub 回的那一格、而不是抄死 60」这条判据的形状，不是"GitHub 真的这么答"。
 *   5000 这个数从 domain 的 `REPO_RATE_AUTH` 来（官方文档口径），用例里不出现第二个字面量。
 * ------------------------------------------------------------------ */

/** 把某几条路径的限额头换成「已认证」那一形状（★ 合成，见上面注释块）。 */
function authOver(paths, left = 4987) {
  return paths.map((p) => ({
    ...src(p),
    headers: { 'x-ratelimit-limit': String(REPO_RATE_AUTH), 'x-ratelimit-remaining': String(left), 'x-ratelimit-reset': '1791175333' },
  }));
}

const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH';

check('默认零凭据：不填令牌时详情的每一发都**没有** authorization（这一轮抬的是上限，不是把凭据撒出去）', async () => {
  const f = fullTable();
  const d = await fetchRepoDetail({ repo: ANT, fetchFn: f, now: NOW });
  assert.equal(d.ok, true);
  assert.equal(f.seen.length, 4, '详情编排还是 ≤4 发：填不填令牌都不许多出一发');
  for (const one of f.seen) {
    assert.equal(Object.keys(one.headers).map((k) => String(k).toLowerCase()).includes('authorization'), false,
      `${one.path} 在没填令牌时带了 authorization`);
  }
});

check('填了令牌 ⇒ 四发各带一条 Bearer，令牌**只**在请求头里：URL 一个字节不变、域也不变', async () => {
  const f = fullTable();
  const d = await fetchRepoDetail({ repo: ANT, fetchFn: f, now: NOW, ghToken: TOKEN });
  assert.equal(d.ok, true);
  assert.equal(f.seen.length, 4);
  const anon = fullTable();
  await fetchRepoDetail({ repo: ANT, fetchFn: anon, now: NOW });
  for (const [i, one] of f.seen.entries()) {
    assert.equal(one.headers.authorization, `Bearer ${TOKEN}`, `${one.path} 没带上令牌`);
    assert.equal(one.url.includes(TOKEN), false, `令牌进了 URL（${one.url}）⇒ 会留在代理与访问日志里`);
    assert.equal(one.path, anon.seen[i].path, '带令牌不该改变路径拼法');
    assert.equal(one.host, new URL(GITHUB_API_BASE).host, `${one.host} 不是 api.github.com ⇒ 令牌发给了别的域`);
  }
});

check('令牌格只有空格 = 等于没填：不发 `Bearer `（空头），也不改动任何一发', async () => {
  const f = fullTable();
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW, ghToken: '   ' });
  assert.equal(d.ok, true);
  assert.equal(f.seen.length, 2);
  for (const one of f.seen) {
    assert.equal('authorization' in one.headers, false, '发了空头：GitHub 按匿名算，但那不是"没填"该有的形状');
  }
  assert.equal(repoView(d, { rate: d.rate }).rate.label, RATE_LABEL_ANON);
});

check('上限吃 GitHub 自己回的那一格：回 5000 ⇒ 读数与屏上那句一起换档（不再抄死 60）', async () => {
  const paths = [`/repos/${WEEKLY}`, `/repos/${WEEKLY}/readme`];
  const f = fullTable(authOver(paths));
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW, ghToken: TOKEN });
  assert.equal(d.rate.limit, REPO_RATE_AUTH);
  assert.equal(d.rate.authed, true);
  const v = repoView(d, { rate: d.rate });
  assert.equal(v.rate.limit, REPO_RATE_AUTH);
  assert.equal(v.rate.label, RATE_LABEL_AUTH, '上限都到 5000 了还念「匿名配额」就是假读数');
});

check('填了令牌但 GitHub 仍按匿名回 60 ⇒ 那句照旧念「匿名配额」（撤销/拼错的令牌不许报成"生效了"）', async () => {
  const f = fullTable();   // 夹具那三档头全是 limit:60（真抓）
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW, ghToken: TOKEN });
  assert.equal(d.rate.limit, REPO_RATE_ANON);
  assert.equal(d.rate.authed, false, '头里写着 60，就不是已认证 —— 判据以 GitHub 那一格为准');
  assert.equal(repoView(d, { rate: d.rate }).rate.label, RATE_LABEL_ANON);
  assert.equal(d.ok, true, '被当匿名不算失败：照样给详情，只是额度那一屏说实话');
});

check('代理把 x-ratelimit-limit 吞了 ⇒ 上限退回保守的出厂那一格，绝不梦见 5000', async () => {
  const paths = [`/repos/${WEEKLY}`, `/repos/${WEEKLY}/readme`];
  const f = fullTable(paths.map((p) => ({
    ...src(p),
    headers: { 'x-ratelimit-remaining': '57', 'x-ratelimit-reset': '1791175333' },   // 没有 limit 这一格
  })));
  const d = await fetchRepoDetail({ repo: WEEKLY, fetchFn: f, now: NOW, ghToken: TOKEN });
  assert.equal(d.rate.limit, null, '读不到就是读不到，不许造一个数');
  assert.equal(d.rate.authed, true, '退回判据：这一发确实带了令牌');
  const v = repoView(d, { rate: d.rate });
  assert.equal(v.rate.limit, REPO_RATE_ANON, '宁可梦见 60，不可梦见 5000');
  assert.equal(v.rate.label, RATE_LABEL_AUTH);
});

check('限额读数（门面）：带令牌那一发之后，rate() 里的 limit 与 label 跟着换档', async () => {
  const paths = [`/repos/${WEEKLY}`, `/repos/${WEEKLY}/readme`];
  const facility = makeFakeFacility();
  const store = createRepoCacheStore({ getFacility: () => facility, logger: { warn: () => {} } });
  await store.get('open/first');
  const svc = createRepoDetailService({ repoStore: store, fetchFn: fullTable(authOver(paths)), now: NOW, getGhToken: () => TOKEN });
  assert.deepEqual(svc.rate(), { limit: REPO_RATE_ANON, left: null, resetAt: 0, label: RATE_LABEL_ANON });
  await svc.load(WEEKLY);
  assert.deepEqual(svc.rate(), { limit: REPO_RATE_AUTH, left: 4987, resetAt: 1791175333 * 1000, label: RATE_LABEL_AUTH });
});

check('令牌现取现算：改偏好不用重启宿主，清空之后**下一发**就不带了', async () => {
  let token = '';
  const f = fullTable();
  const facility = makeFakeFacility();
  const store = createRepoCacheStore({ getFacility: () => facility, logger: { warn: () => {} } });
  await store.get('open/first');
  const svc = createRepoDetailService({ repoStore: store, fetchFn: f, now: NOW, getGhToken: () => token });
  await svc.load(VITE);
  assert.equal(f.seen.every((o) => !('authorization' in o.headers)), true, '出厂那一发带了令牌');
  const n1 = f.seen.length;
  token = TOKEN;
  await svc.load(WEEKLY);
  const withToken = f.seen.slice(n1);
  assert.ok(withToken.length >= 2, '这一档没真的出网，等于没验');
  assert.equal(withToken.every((o) => o.headers.authorization === `Bearer ${TOKEN}`), true, '填上令牌后那几发没带');
  const n2 = f.seen.length;
  token = '';
  await svc.load(ANT);
  assert.equal(f.seen.slice(n2).every((o) => !('authorization' in o.headers)), true,
    '清空偏好后还继续带旧令牌 ⇒ 界面已经显示空了，出网那一份却没变（和"发出去过就别留草稿"同一类假活）');
});

check('坏名字在门面层就出视图：不查库、不出网、也不摆半张段表', async () => {
  const { svc, f, store } = await mkService();
  const spy = store.get;
  let reads = 0;
  store.get = (...a) => { reads += 1; return spy(...a); };
  const v = await svc.load('just-a-name');
  assert.equal(v.ok, false);
  assert.equal(v.errKey, 'bad_key');
  assert.equal(v.error, REPO_ERROR_LABELS.bad_key);
  assert.deepEqual(v.sections, [], '名字都不合法还拼出一段中文，那就是插件自己编的话');
  assert.equal(reads, 0);
  assert.equal(f.seen.length, 0);
});

check('库里躺着外部改过的脏行（手改 json / 换机搬库）：详情不炸，也不写出半截条或 [object Object]', async () => {
  const dirty = {
    repo: ANT.toLowerCase(), at: NOW(), ok: true,
    stars: 'abc', forks: null, lang: 42, topics: 'not-an-array', license: { spdx: 'MIT' },
    pushedAt: 12345, homepage: {}, readmeSource: 'zh_file', readmePath: 'README-zh_CN.md',
    readmeExcerpt: '一套企业级 UI 设计语言', readmeChars: '很多', zhCjk: -1,
  };
  const { svc, f } = await mkService({ rows: [dirty] });   // seed 是绕开 schema 塞进去的（模拟外部改库）
  const v = await svc.load(ANT);
  assert.equal(v.cached, true);
  assert.equal(f.seen.length, 0, '库里就有今天的行，脏成什么样都不该再烧一发限额');
  const text = allText(v.sections);
  assert.doesNotMatch(text, /用 42 写|\[object Object\]|累计  星/, `脏字段糊进了中文段：${text}`);
  // 脏得连一个可信字段都不剩 ⇒ 只剩「仓库没有写描述。」那句实话，别的段整段不摆
  assert.deepEqual(v.sections.map((s) => s.key), ['what', 'self']);
  assert.equal(secOf(v.sections, 'heat'), undefined, '数字全是脏的还摆 heat，界面上就是一张空表');
  assert.equal(secTexts(v.sections, 'what'), '仓库没有写描述。');
  assert.ok(v.sections.every((s) => s.blocks.every((b) => typeof b.text === 'string' && b.text)), `段里有非字符串：${text}`);
  assert.equal(v.readmeChars, 0, '非数字长度折成"没有这个读数"，不是 NaN 上屏');
  assert.equal(v.zhCjk, 0, '负数读数不能当真的报给界面');
  assert.equal(secOf(v.sections, 'self').label, `${REPO_SECTION_LABELS.self} · ${REPO_README_SOURCE_LABELS.zh_file}`, '脏字段之后段名仍要点出这一档（那句说明撤了，档名就是它唯一的去处）');
});

/* ------------------------------------------------------------------ *
 * 7. 「全站高星」那一发（第二十三轮 §8.8 步骤 3：URL 形状 + 回包映射 + 限额三格）
 *
 * ★ 这一路是本轮允许清单里**新增**的一发出网 ⇒ 判据对着**真回包**钉（`test/make-search-fixture.mjs` 一次真抓）。
 * ★ 闸门（开关 / 存储 / 每轮预算）不在这层：那三条在 `all-stars.js`（步骤 4），本层只回答"GitHub 怎么答"。
 * ★ 合成档只有两类，各在用例里标了出处：① 已认证那一份限额头（本机没有令牌）；② 缺字段 / null 描述那种坏行
 *   （真回包 30 条全都规整 ⇒ 只能现造，钉的是映射形状，不是"GitHub 真的这么答"）。
 * ------------------------------------------------------------------ */

check('searchRepoUrl：门槛数只从 domain 常数来（零入参），q 里的 >= 编码成 %3E%3D，域名一个字都不带', () => {
  const url = searchRepoUrl();
  assert.equal(searchRepoUrl.length, 0,
    'searchRepoUrl 接了入参 ⇒ 真跑的那个门槛数可以和设置页念的那一句分叉（§8.8「不念就等于偷偷定了一道门槛」）');
  assert.ok(url.startsWith('/search/repositories?'), `路径形状变了：${url}`);
  assert.ok(!/^[a-z][a-z0-9+.-]*:\/\//i.test(url), '路径里带 scheme ⇒ 域名就不只在 domain 那一份了（hc-7 扫的就是这一格）');
  assert.ok(url.includes('%3E%3D'), '>= 没被编码：手拼字符串时 > 原样转发，search 对此给 422 ⇒ 屏上是"这一档永远空白"而 note 还在说 100,000');
  assert.ok(!url.includes('>'), `URL 里还剩裸 >：${url}`);
  const qs = new URL(`https://api.github.com${url}`).searchParams;
  assert.equal(qs.get('q'), `stars:>=${SEARCH_STARS_FLOOR}`, '解码回来必须是那个常数：编码这一层不许改变查询本身');
  assert.equal(qs.get('sort'), 'stars');
  assert.equal(qs.get('order'), 'desc');
  assert.equal(qs.get('per_page'), String(SEARCH_PER_PAGE));
  assert.equal(qs.get('page'), '1', '每轮只一发 ⇒ 翻页不在这轮的能力边界里（§8.8 常数表）');
  assert.equal(url, searchRepoUrl(), '同一份常数两次拼出不同的串 ⇒ 界面那句 note 追不上真实查询');
  assert.ok(!/token/i.test(url), '令牌出现在 URL 拼接里（会留在代理与访问日志）');
});

check('真回包跑通：一发 200 ⇒ 30 行、位次 1..30 原样、repo 折小写而 name 保留 GitHub 的写法', async () => {
  const f = makeApiFetch([searchEntry()]);
  const d = await searchRepositories({ fetchFn: f, now: NOW });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.at, NOW());
  assert.equal(d.rows.length, sDoc.response.originalItems, '行数与真回包的 items 数不一致 ⇒ 有行被静默吃掉');
  assert.deepEqual(d.rows.map((r) => r.rank), SITEMS.map((_, i) => i + 1), '位次必须是回包的原样顺序');
  for (const [i, r] of d.rows.entries()) {
    assert.equal(r.name, SITEMS[i].full_name, '显示名必须是 GitHub 的写法');
    assert.equal(r.repo, SITEMS[i].full_name.toLowerCase(), '主键小写：与三榜那一路同一个主键口径，否则同一仓库在两处对不上');
    assert.ok(Number.isFinite(r.stars) && r.stars >= 0, `${r.repo} 的星数不是有限非负数`);
    assert.equal(r.desc, typeof SITEMS[i].description === 'string' ? SITEMS[i].description : '');
    assert.equal(r.lang, typeof SITEMS[i].language === 'string' ? SITEMS[i].language : '');
  }
  // 非空转：真回包里有 freeCodeCamp/freeCodeCamp、996icu/996.ICU 这种大小写与点号 ⇒ 上面那两条不是白跑
  assert.ok(d.rows.some((r) => r.name !== r.repo), '夹具里没有大小写混合的名字 ⇒ 小写主键那条断言是空转');
  assert.ok(d.rows.some((r) => r.lang === ''), '夹具里没有 language 为 null 的仓库 ⇒ null 折空串那条断言是空转');
  assert.equal(f.seen.length, 1, '本层只许一发（每轮预算在 runner 数，但这一层也不许自己补发）');
  const one = f.seen[0];
  assert.equal(one.method, 'GET');
  assert.equal(one.host, 'api.github.com');
  assert.ok(one.signal, '没接 AbortController ⇒ 撞超时的那一发还挂着，而预算已经把它算成"发过了"');
  assert.equal(one.timeoutMs, REPO_TIMEOUT_MS, '单发预算没交给传输层 = 假超时（界面上说 15s，连接还按 30s 等）');
});

check('载荷只带 SEARCH_ROW_SHAPE 那六格：真 item 一条八十多个键，owner / score / html_url 一个字都不进', async () => {
  const want = Object.keys(SEARCH_ROW_SHAPE).sort();   // 键表从 domain 派生 ⇒ 用例里不手抄六个名字
  const d = await searchRepositories({ fetchFn: makeApiFetch([searchEntry()]), now: NOW });
  assert.ok(sDoc.response.firstItemKeys > want.length + 20,
    `夹具里"全字段"那条只有 ${sDoc.response.firstItemKeys} 个键 ⇒ 这一扫没东西可漏，是空转`);
  for (const r of d.rows.slice(0, sDoc.response.fullItems)) {
    assert.deepEqual(Object.keys(r).sort(), want, `${r.repo} 的键表与 schema 对不上（多带的就是第二份真相）`);
  }
  for (const banned of ['owner', 'score', 'html_url', 'url', 'fork', 'topics']) {
    assert.equal(banned in d.rows[0], false, `${banned} 跟着进了载荷`);
  }
});

check('限额三格与「匿名还是已认证」：判据吃 search 自己那一份匿名读数（真回包 10），套 core 的 60 会把生效念成没生效', async () => {
  const H = sDoc.response.headers;
  const anon = await searchRepositories({ fetchFn: makeApiFetch([searchEntry()]), now: NOW });
  assert.equal(anon.rate.limit, Number(H['x-ratelimit-limit']), 'limit 必须吃响应头，不抄死');
  assert.equal(anon.rate.left, Number(H['x-ratelimit-remaining']));
  assert.equal(anon.rate.resetAt, Number(H['x-ratelimit-reset']) * 1000, 'reset 是 epoch 秒 ⇒ 毫秒换算在本层做完（界面不换算日期）');
  assert.equal(anon.rate.authed, false);
  // ★ 这一位是本轮真读数逼出来的改判：search 的匿名池**实测就比 core 的匿名池小**（10 < 60），
  //   拿 `REPO_RATE_ANON` 判 ⇒ 带令牌的 search 那一发（已认证 30）会被念成「匿名」。
  assert.ok(anon.rate.limit < REPO_RATE_ANON, `夹具那一份的 limit 已经不小于 core 的匿名档（${anon.rate.limit}）⇒ 这条改判的前提没了，domain 的 SEARCH_RATE_ANON 注释要重写`);
  assert.equal(anon.rate.limit, SEARCH_RATE_ANON, '实测匿名档与判据用的那个数必须同源（哪天 GitHub 改了池子，这一条要红给你看）');
  /** 已认证那一档：本机没有令牌 ⇒ **合成**（形状按官方口径的"比匿名那一档高"，数值不进代码，只进这一发假头）。 */
  const authHead = { ...H, 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '29' };
  const withTok = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ headers: authHead })]), now: NOW, ghToken: TOKEN });
  assert.equal(withTok.rate.authed, true, '带了令牌 + GitHub 报 30 ⇒ 已认证（按 60 判就把它念成没生效）');
  const headerWins = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ headers: authHead })]), now: NOW });
  assert.equal(headerWins.rate.authed, true, '头在的时候以 GitHub 报的那一格为准（第二十一轮那条律，两个池子同一条）');
  /** 代理吞头那一档：三格全缺位时退回"这一发带没带令牌"。 */
  const bare = { 'content-type': H['content-type'] };
  const bareAnon = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ headers: bare })]), now: NOW });
  assert.deepEqual(bareAnon.rate, { left: null, resetAt: 0, limit: null, authed: false }, '没读到头却报"剩 0"就是假读数');
  const bareTok = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ headers: bare })]), now: NOW, ghToken: TOKEN });
  assert.equal(bareTok.rate.authed, true, '头不在才退回"带没带令牌"');
});

check('坏行丢掉但位次不重编：缺 full_name / 缺 stargazers_count 的行不进载荷，留下的行拿自己原来的位次（合成档）', async () => {
  const items = [SITEMS[0], { full_name: 'ghost/no-stars' }, SITEMS[1], { stargazers_count: 999999 }, SITEMS[2]];
  const logs = [];
  const d = await searchRepositories({
    fetchFn: makeApiFetch([searchEntry({ text: searchBody(items) })]), now: NOW,
    logger: { warn: (m) => logs.push(String(m)) },
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.rows.map((r) => r.rank), [1, 3, 5], '重编号 = 把"GitHub 给的顺序"改成"我数出来的顺序"（那一列的列名就叫 #）');
  assert.equal(d.rows.length, 3);
  assert.equal(logs.length, 1, '静默少两行与"GitHub 就给了这些"在屏上长得一样，日志里必须分得开');
  assert.match(logs[0], /5 条里有 2 条/);
});

check('stargazers_count: 0 不是缺位（照样进这一批），null 描述 / null 语言折成空串（schema 的 optionalString 不收 null，合成档）', async () => {
  const items = [{ full_name: 'Zero/Starred', stargazers_count: 0, description: null, language: null }];
  const d = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ text: searchBody(items) })]), now: NOW });
  assert.equal(d.rows.length, 1, '0 星是**读数**不是缺位：拿 `!stars` 判缺就把"真的 0"演成"坏行"');
  assert.deepEqual(d.rows[0], { rank: 1, repo: 'zero/starred', name: 'Zero/Starred', desc: '', lang: '', stars: 0 });
  assert.notEqual(d.rows[0].desc, null, 'null 进了 optionalString 的位置（schema 当场抛，整域读不出来）');
});

check('正文不是 JSON / 没有 items 数组 ⇒ parse 档，且这一层不给 rows（坏轮冻结由 runner 落）', async () => {
  const cases = [
    ['正文不是 JSON', '<html>rate limited page</html>'],
    ['没有 items 这一格', JSON.stringify({ total_count: 129 })],
    ['items 不是数组', JSON.stringify({ items: { 0: {} } })],
    ['items 是 null', JSON.stringify({ items: null })],
  ];
  for (const [why, text] of cases) {
    const d = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ text })]), now: NOW });
    assert.equal(d.ok, false, `${why} 竟然当成成功`);
    assert.equal(d.errKey, 'parse', why);
    assert.equal(d.transport, false, `${why}：接口改版不是连不上`);
    assert.equal('rows' in d, false, `${why}：失败行不许带 rows，否则下一层会把上一批覆盖成空`);
    assert.equal(d.at, NOW());
  }
});

check('非 200 与传输失败走 failOf 那四档，回执是原样句子（不套 REPO_ERROR_LABELS：那一格的 rate_limited 写死了「60 次/小时」）', async () => {
  const limited = await searchRepositories({
    fetchFn: makeApiFetch([searchEntry({ status: 403, text: '{"message":"API rate limit exceeded"}', headers: { ...sDoc.response.headers, 'x-ratelimit-remaining': '0' } })]),
    now: NOW,
  });
  assert.equal(limited.errKey, 'rate_limited');
  assert.match(limited.errText, /限额用尽（403/, '回执本体要在（屏上那句落款靠它）');
  assert.ok(!/60 次|每小时/.test(limited.errText), '错误句子被 REPO_ERROR_LABELS 圆成「60 次/小时/机器」⇒ 在 search 这一档是假话（两套池子）');
  assert.equal(limited.transport, false);
  const forbidden = await searchRepositories({
    fetchFn: makeApiFetch([searchEntry({ status: 403, text: '{"message":"Forbidden"}' })]), now: NOW,
  });
  assert.equal(forbidden.errKey, 'transport', '403 但额度没报 0 ⇒ 不许念成"你没额度了"（权限/黑名单是另一件事）');
  const server = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ status: 500, text: 'boom' })]), now: NOW });
  assert.equal(server.errKey, 'transport');
  assert.match(server.errText, /返回 500/);
  const down = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ throw: 'socket hang up', code: 'ECONNRESET', status: undefined, text: undefined })]), now: NOW });
  assert.equal(down.errKey, 'transport');
  assert.equal(down.transport, true, '连不上要标 transport：界面那句「直连未通」吃这一格');
  const cfg = await searchRepositories({ fetchFn: makeApiFetch([searchEntry({ throw: '代理端口不合法', code: 'proxy_config' })]), now: NOW });
  assert.equal(cfg.errKey, 'config', '代理配置坏到没出发，这一发根本没碰 GitHub');
  assert.equal(cfg.transport, false);
});

check('hc-19 的效果侧扩到 search 这一发：默认零凭据；填了 ⇒ 只进请求头，URL 与域逐字节不变、令牌本体不在 URL 里', async () => {
  const noTok = makeApiFetch([searchEntry()]);
  await searchRepositories({ fetchFn: noTok, now: NOW });
  assert.equal('authorization' in noTok.seen[0].headers, false, '出厂那一发带了凭据');
  const withTok = makeApiFetch([searchEntry()]);
  await searchRepositories({ fetchFn: withTok, now: NOW, ghToken: TOKEN });
  assert.equal(withTok.seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(withTok.seen[0].url, noTok.seen[0].url, '带令牌改变了 URL ⇒ 令牌会从查询串里漏进代理与访问日志');
  assert.equal(withTok.seen[0].url.includes(TOKEN), false, '令牌出现在 URL 里');
  assert.equal(withTok.seen[0].host, 'api.github.com', '凭据发向了别的域');
  const blank = makeApiFetch([searchEntry()]);
  await searchRepositories({ fetchFn: blank, now: NOW, ghToken: '   ' });
  assert.equal('authorization' in blank.seen[0].headers, false, '发了一条空头：GitHub 按匿名算，但那不是"没填"该有的形状');
});

check('createSearchFetcher：交给 runner 的是一颗无参函数（令牌的键名不出本文件），且 getGhToken 现取现算', async () => {
  const box = { v: '' };
  const f = makeApiFetch([searchEntry()]);
  const fetchBatch = createSearchFetcher({ fetchFn: f, now: NOW, getGhToken: () => box.v });
  assert.equal(fetchBatch.length, 0,
    'runner 能传参 ⇒ 它能传进自己的令牌/别的 URL，"Authorization 只造在 repo.js"那条字面律就没了落脚点（hc-21 按键名扫文件）');
  await fetchBatch();
  assert.equal('authorization' in f.seen[0].headers, false, '偏好里没令牌时装配层把空串当成有');
  box.v = TOKEN;
  const d = await fetchBatch();
  assert.equal(d.ok, true);
  assert.equal(f.seen[1].headers.authorization, `Bearer ${TOKEN}`, '装配时抄死令牌 ⇒ 设置页填完要等宿主重启才生效（第十二轮那笔账）');
  box.v = '';
  await fetchBatch();
  assert.equal('authorization' in f.seen[2].headers, false, '清空令牌后还带着发 ⇒ 库里已经没了');
  assert.equal(f.seen.length, 3, '每一次调用恰好一发');
});

check('夹具对账（search）：真抓 200 + 限额头实测 + 裁剪口径登记在案（用例不许把裁过的行当全文）', () => {
  assert.equal(sDoc.response.status, 200, '夹具不是 200 ⇒ 这一整套映射判据钉的是抓取失败现场');
  assert.ok(Number.isFinite(sDoc.capturedAt) && sDoc.capturedAt > 0, '没有抓取时刻 ⇒ 不知道这份形状属于哪一天的接口');
  assert.equal(sDoc.request.path, searchRepoUrl(), '夹具与代码拼的那一发不是同一条 URL ⇒ 下面所有断言都在对空气');
  assert.equal(sDoc.response.headers['x-ratelimit-limit'], String(SEARCH_RATE_ANON), 'search 池的实测匿名档与判据不同源');
  assert.equal(sDoc.response.headers['x-ratelimit-remaining'], '9', '真抓那一发的剩余额度（非空转：证明这不是抄来的头）');
  assert.ok(sDoc.response.fullLength > sDoc.response.keptLength, '没裁剪却写着裁剪口径 ⇒ 夹具与生成器分叉了');
  assert.equal(SITEMS.length, sDoc.response.originalItems);
  for (let i = 0; i < sDoc.response.fullItems; i++) {
    assert.equal(Object.keys(SITEMS[i]).length, sDoc.response.firstItemKeys, `第 ${i} 条写着全字段却只有 ${Object.keys(SITEMS[i]).length} 个键`);
  }
  for (const it of SITEMS.slice(sDoc.response.fullItems)) {
    assert.ok(Object.keys(it).every((k) => sDoc.response.readKeys.includes(k)), '裁过的行里出现被读的四键之外的字段 ⇒ 裁剪口径没生效');
  }
  assert.deepEqual(sDoc.response.topLevelKeys, ['total_count', 'incomplete_results', 'items'], '顶层形状变了就先改夹具口径，别改代码去迁就');
});

/* ------------------------------------------------------------------ *
 * 8. 与真接口的对账（口径声明，不碰网络）
 * ------------------------------------------------------------------ */
check('夹具口径：真字节 + 抓取时刻 + 合成档登记在案（用例不许把合成当实测）', () => {
  assert.equal(doc.responses.length, 10);
  assert.ok(Number.isFinite(doc.capturedAt) && doc.capturedAt > 0);
  assert.equal(doc.route.via, 'proxy', '抓取走的是自带隧道；直连抓出来的读数不能拿来当隧道证据');
  assert.match(doc.synthesized.readme_404, /真 404 正文/);
  assert.match(doc.synthesized.rate_limited, /403/);
  for (const r of doc.responses) {
    assert.equal(r.status, r.path.includes('no-such-repo') ? 404 : 200, `${r.path} 抓取状态 ${r.status}`);
    assert.equal(r.headers['x-ratelimit-limit'], '60', '匿名限额实测值变了，domain 的 REPO_RATE_ANON 要跟着改');
    if (r.truncated) assert.ok(r.keptLength < r.fullLength);
  }
});

await runAll('repo');
