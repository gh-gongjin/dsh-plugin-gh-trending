/**
 * lib/services/gh.js —— 趋势页抓取 + 解析（宿主半边唯一**造请求**的地方）。
 *
 * 传输路径不在这一层决定：fetchFn 由 lib/services/net.js 装配（直连=宿主全局 fetch，
 * 代理=插件自带 CONNECT 隧道），这一层只管 URL、请求头、响应读法与解析。
 *
 * 铁律落点：
 *  · 全程只读 GET，不带 key、不带 cookie、不 POST；一次检查最多三张榜。
 *  · 诚实降级：坏就返回 { ok:false, reason }，绝不抛出去打断整轮，也绝不补一份假榜。
 *
 * 解析规矩来自 2026-10-04 S0 探针（tmp/probe-gh2.txt 有条目原文），三条最容易踩的：
 *  ① 条目里每条 star/fork/新增 span 都先内嵌一段约 700 字符的 `<svg><path>`，
 *     所以锚点必须「跨到 </svg> 之后取第一段文本」，定长窗口会静默取空（探针第一轮就是这么假的 0）。
 *  ② 仓库名要从 `<h2` 起找：条目**开头**那条 href 是 `/login?return_to=…` 的 star 按钮，
 *     从条目头找第一条链接会把每个仓库都解析成 "login"。
 *  ③ `?since=` 非法值不会报错，会静默返回日榜（实测逐字节等同）；语言 slug 不存在也只给 200 + 0 条，
 *     唯一可分辨的是 <title> 念没念语言名。白名单与判据都守在这一层。
 */
import { BOARDS, BOARD_SINCE, LANG_TITLE_RE } from '../domain.js';

export const TRENDING_BASE = 'https://github.com/trending';
export const PROBE_UA = 'Mozilla/5.0 (dsh-plugin-gh-trending; personal monitor)';
export const DEFAULT_TIMEOUT_MS = 30000;

/** 语言 slug：只许小写字母数字与连字符，长度封顶；脏值一律拒（不拼进 URL）。 */
const LANG_SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

export function normalizeLanguage(raw) {
  if (typeof raw !== 'string') return { ok: false, slug: '', reason: '语言过滤值不是字符串' };
  const slug = raw.trim().toLowerCase();
  if (!slug) return { ok: true, slug: '' };
  if (!LANG_SLUG_RE.test(slug)) {
    return { ok: false, slug: '', reason: `语言 slug 形状不合法（只许小写字母/数字/连字符/下划线，2~40 字符）：${raw}` };
  }
  return { ok: true, slug };
}

/** 造榜的 URL。since 必须过 BOARD_SINCE 白名单，非法档直接抛（调用方是宿主自己，不该出现）。 */
export function trendingUrl({ board = 'daily', language = '' } = {}) {
  const since = BOARD_SINCE[board];
  if (!since) throw new Error(`未知榜：${board}`);
  const lang = normalizeLanguage(language);
  if (!lang.ok) throw new Error(lang.reason);
  const path = lang.slug ? `${TRENDING_BASE}/${lang.slug}` : TRENDING_BASE;
  return `${path}?since=${since}`;
}

/** 去标签 + 实体归一 + 折空白（S0 探针同款，夹具断言直接吃它）。 */
function textOf(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x?[0-9a-fA-F]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 「75,859」/「1,170 stars today」→ 整数。取第一段数字串，不匹配单位词（i18n 防御，实测本页恒英文）。
 * 数字后紧跟 k/m/b 这类缩写量级时**返回 null**：本页从不这么写，真出现就是改版，
 * 宁可让上层按丢行率报「锚点疑似改版」，也不要交一个把 1.5k 读成 2 的假数。
 */
export function parseCount(text) {
  const s = String(text ?? '').replace(/,/g, '');
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  if (/[kKmMbB]/.test(s[m.index + m[0].length] ?? '')) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** `<div class="a">…</div>` 里按锚点切出条目：只认 `<article class="Box-row">` 到最近的 `</article>`。 */
export function sliceArticles(html) {
  const chunks = [];
  const re = /<article\b[^>]*class="Box-row"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const end = html.indexOf('</article>', m.index);
    if (end < 0) break;
    chunks.push(html.slice(m.index, end));
    re.lastIndex = end;
  }
  return chunks;
}

export function titleLanguage(html) {
  const title = ((html || '').match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? '';
  const m = textOf(title).match(LANG_TITLE_RE);
  if (!m) return '';
  return m[1].trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * 一条 article → 行。取不到 repo / 累计 star / 新增星数就返回 null（整条丢弃，
 * 由调用方按「成功行数 < 门槛」判故障 —— 半条脏记录比少一条更糟）。
 * @param index 榜内序号（名次 = index+1）
 */
export function parseArticle(chunk, index) {
  const h2 = chunk.match(/<h2\b[\s\S]*/);
  const repoLink = h2 && h2[0].match(/href="(\/[^"?]+)"[^>]*class="[^"]*\bLink\b/);
  if (!repoLink) return null;
  const repo = repoLink[1].slice(1);
  if (!/^[^/]+\/[^/]+$/.test(repo)) return null;

  // 「跨 </svg> 取文本」：`[\s\S]*?<\/svg>` 先跳过内嵌图标，再截到闭标签 —— 与 S0 候选解析器逐字同形
  const starsM = chunk.match(/href="\/[^"]+\/stargazers"[\s\S]*?<\/svg>([\s\S]*?)<\/a>/);
  const forksM = chunk.match(/href="\/[^"]+\/forks"[\s\S]*?<\/svg>([\s\S]*?)<\/a>/);
  const addedM = chunk.match(/class="[^"]*float-sm-right[^"]*"[\s\S]*?<\/svg>([\s\S]*?)<\/span>/);
  const stars = parseCount(starsM ? starsM[1] : null);
  const added = parseCount(addedM ? addedM[1] : null);
  if (stars === null || added === null) return null;

  const idM = chunk.match(/&quot;record_id&quot;:(\d+)/);
  const descM = chunk.match(/<p\b[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const langM = chunk.match(/itemprop="programmingLanguage">([^<]*)<\/span>/);
  const colorM = chunk.match(/repo-language-color"\s+style="background-color:\s*([^"]+)"/);

  const row = {
    rank: index + 1,
    repo: repo.toLowerCase(),
    name: repo,
    stars,
    added,
    desc: descM ? textOf(descM[1]) : '',
    lang: langM ? langM[1].trim() : '',
    langColor: colorM ? colorM[1].trim() : '',
    repoId: idM ? Number(idM[1]) : undefined,
    forks: parseCount(forksM ? forksM[1] : null) ?? undefined,
  };
  return row;
}

/**
 * 解析趋势页。返回：
 *  { ok:true, rows, pageCount, titleLang }
 *  { ok:false, reason }
 * 全站榜 0 行 = 结构变了或被挡了 ⇒ 故障；带语言的请求交给 check.js 按 titleLang 三分（有榜/空榜/不认）。
 */
export function parseTrendingHtml(html, { language = '' } = {}) {
  if (typeof html !== 'string' || !html) return { ok: false, reason: '趋势页正文为空' };
  if (!/<article\b[^>]*class="Box-row"/.test(html)) {
    const titleLang = titleLanguage(html);
    if (language && titleLang === language) {
      // 语言有效、这一档今天没榜：合法的空榜，不是故障
      return { ok: true, rows: [], pageCount: 0, titleLang, emptyBoard: true };
    }
    if (language && !titleLang) {
      return { ok: true, rows: [], pageCount: 0, titleLang: '', unknownLanguage: true };
    }
    return { ok: false, reason: '页面里一条榜单条目都没有（结构可能已改版，或被网关/登录页拦截）' };
  }
  const chunks = sliceArticles(html);
  const rows = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const row = parseArticle(chunks[i], rows.length);
    if (row) rows.push(row);
  }
  // 丢行率过高 = 改版的前兆，别装作只是少了两条
  if (chunks.length >= 3 && rows.length < chunks.length * 0.6) {
    return { ok: false, reason: `条目 ${chunks.length} 条里只解析出 ${rows.length} 条（字段锚点疑似改版）` };
  }
  if (!rows.length) return { ok: false, reason: '解析不出任何一行榜单条目（字段锚点疑似改版）' };
  return { ok: true, rows, pageCount: chunks.length, titleLang: titleLanguage(html) };
}

/**
 * 抓一张榜。fetchFn / now 注入是为了测试不碰网。
 * 条件请求：带上 etag 拿到 304 就回 notModified（实测 GitHub 给弱 ETag，If-None-Match 有效，0 字节）。
 */
export async function fetchTrendingBoard({
  board = 'daily', language = '', etag = '', timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn = globalThis.fetch, url,
} = {}) {
  let target;
  try {
    target = url ?? trendingUrl({ board, language });
  } catch (e) {
    return { ok: false, reason: `请求造不出来：${e?.message ?? e}` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { 'User-Agent': PROBE_UA };
  if (etag) headers['If-None-Match'] = etag;
  try {
    const res = await fetchFn(target, { method: 'GET', headers, redirect: 'follow', signal: ctrl.signal });
    if (res.status === 304) {
      return { ok: true, notModified: true, etag, rows: null, pageCount: 0, titleLang: '' };
    }
    if (!res.ok) {
      const retry = res.headers?.get?.('retry-after');
      return { ok: false, reason: `趋势页返回 ${res.status}${retry ? `（${retry}s 后再试）` : ''}` };
    }
    const html = await res.text();
    const parsed = parseTrendingHtml(html, { language });
    if (!parsed.ok) return parsed;
    const nextEtag = res.headers?.get?.('etag') ?? '';
    return { ...parsed, etag: nextEtag || etag, fetchedAt: Date.now() };
  } catch (e) {
    const why = e?.name === 'AbortError'
      ? `趋势页请求超时（${Math.round(timeoutMs / 1000)}s）`
      : `趋势页请求失败：${e?.message ?? e}${e?.code ?? e?.cause?.code ? `（${e.code ?? e.cause.code}）` : ''}`;
    // ★ 代理地址写错（proxy_config）不算传输类：同一份配置再打三次还是同一句报错，
    //   补发只是把三发变九发。它照样是这一榜的故障，只是不享受重试。
    const configError = e?.code === 'proxy_config';
    return { ok: false, reason: why, transportError: !configError, configError };
  } finally {
    clearTimeout(timer);
  }
}

/** 设置页保存语言时的就地验证：拿一张周榜页判 titleLang（一次 GET，不缓存、不写库）。 */
export async function checkLanguageSlug({ language, fetchFn = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const norm = normalizeLanguage(language);
  if (!norm.ok) return { status: 'unknown', slug: '', reason: norm.reason };
  if (!norm.slug) return { status: 'boarded', slug: '' };
  const res = await fetchTrendingBoard({ board: 'weekly', language: norm.slug, fetchFn, timeoutMs });
  if (!res.ok) return { status: 'fetch-failed', slug: norm.slug, reason: res.reason };
  if (res.unknownLanguage) return { status: 'unknown', slug: norm.slug };
  return { status: res.emptyBoard ? 'valid-empty' : 'boarded', slug: norm.slug, pageCount: res.pageCount };
}

export { BOARDS };
