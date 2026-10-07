/**
 * test/make-fixtures.mjs —— 从 S0 探针留下的原始页面（tmp/gh-*.html，单页 0.6~0.7MB）
 * 切出解析器真正吃得动的最小夹具：`<title>` + 页头若干条 `<article class="Box-row">` 原文片段。
 *
 * 为什么可以切：lib/services/gh.js 的 parseTrendingHtml 只读这两样（titleLang 与 sliceArticles），
 * 页面余下部分是 CSS/JS/导航，对解析零贡献。留下的条目**逐字节原样**，
 * 所以夹具钉得住真实读数（2026-10-04 整榜 15/19/23 条、rust 周榜 17 条、千分位、内嵌 svg、无描述行）。
 * 整榜条数只在这里与 HTML 注释里记档：截的是页头前缀，行序与名次不受影响。
 *
 * 用法：node test/make-fixtures.mjs        （缺源文件就报错退出，不静默造空夹具）
 *       node test/make-fixtures.mjs --check（只比对现有夹具与源是否一致）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, '..', 'tmp');
const OUT = join(HERE, 'fixtures');

const SOURCES = [
  // take 的口径：夹具只留页头若干条（省仓库体积），但必须覆盖到「无描述行」那一条
  // 实测位置：daily 第 9 条（index 8）、weekly 第 10 条（index 9）⇒ 这两档的 take 不许低于 9/10。
  { src: 'gh-daily.html', out: 'gh-daily.html', language: '', take: 9 },
  { src: 'gh-weekly.html', out: 'gh-weekly.html', language: '', take: 10 },
  { src: 'gh-monthly.html', out: 'gh-monthly.html', language: '', take: 6 },
  { src: 'gh-lang-rust.html', out: 'gh-lang-rust.html', language: 'rust', take: 4 },
];

/** 两条 0 条目页：标题原文抄自 tmp/probe-gh5.txt（2026-10-04 读数），正文按最小结构合成。 */
const SYNTH = [
  { out: 'gh-empty-brainfuck.html', title: 'Trending Brainfuck repositories on GitHub today · GitHub', note: '合法语言、这一档今天没有上榜仓库（实测 boxRows=0）' },
  { out: 'gh-unknown-lang.html', title: 'Trending repositories on GitHub today · GitHub', note: '站点不认识这个 slug（实测标题不念语言名，仍是 200 + 0 条）' },
];

function titleOf(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  return m ? m[1].trim() : '';
}

/** 按 sliceArticles 同款锚点切条目：`<article ... class="Box-row" ...>` 到最近的 `</article>`。 */
function articlesOf(html) {
  const chunks = [];
  const re = /<article\b[^>]*class="Box-row"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const end = html.indexOf('</article>', m.index);
    if (end < 0) break;
    chunks.push(html.slice(m.index, end + '</article>'.length));
    re.lastIndex = end;
  }
  return chunks;
}

function assemble({ title, articles, note }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><!-- ${note} --><title>${title}</title></head>`
    + `<body class="logged-out env-production"><main><div class="explore-pipelines-container">\n`
    + articles.join('\n')
    + `\n</div></main></body></html>\n`;
}

/** 取页头 take 条（名次就是页内顺序，切前缀不改变已有行的名次）；无描述行不许被切掉。 */
function pick(articles, take, name) {
  const head = articles.slice(0, take);
  const noDesc = articles.findIndex((a) => !/<p\b[^>]*class="[^"]*col-9[^"]*"/.test(a));
  if (noDesc >= take) {
    throw new Error(`${name}：无描述行在第 ${noDesc + 1} 条，take=${take} 会把它切掉（实测它存在，解析器必须吃过）`);
  }
  return head;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!checkOnly) mkdirSync(OUT, { recursive: true });
  const lines = [];
  for (const s of SOURCES) {
    const srcPath = join(SRC, s.src);
    if (!existsSync(srcPath)) {
      console.error(`缺少源页面：${srcPath}\n（S0 探针的原始 HTML 是夹具的唯一来源，不许手抄）`);
      process.exitCode = 1;
      continue;
    }
    const html = readFileSync(srcPath, 'utf8');
    const all = articlesOf(html);
    if (all.length < 5) {
      console.error(`${s.src} 里只切出 ${all.length} 条条目，源不完整`);
      process.exitCode = 1;
      continue;
    }
    const articles = pick(all, s.take, s.src);
    const title = titleOf(html);
    const out = assemble({ title, articles, note: `夹具：源 ${s.src}（2026-10-04 S0 实测整榜 ${all.length} 条）的前 ${s.take} 条原文，条目内字节未改` });
    const outPath = join(OUT, s.out);
    const noDesc = articles.filter((a) => !/<p\b[^>]*class="[^"]*col-9[^"]*"/.test(a)).length;
    lines.push(`${s.out}: 留 ${articles.length}/${all.length} 条 · ${out.length} B · 无描述行 ${noDesc} 条 · title="${title}"`);
    if (checkOnly) {
      if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== out) {
        console.error(`${s.out} 与源页面不一致，重跑 node test/make-fixtures.mjs`);
        process.exitCode = 1;
      }
      continue;
    }
    writeFileSync(outPath, out, 'utf8');
  }
  for (const s of SYNTH) {
    const out = assemble({ title: s.title, articles: [], note: `合成夹具（0 条目页）：${s.note}；标题原文抄自 tmp/probe-gh5.txt` });
    lines.push(`${s.out}: 0 条 · ${out.length} B · ${s.note}`);
    if (!checkOnly) writeFileSync(join(OUT, s.out), out, 'utf8');
  }
  console.log(lines.join('\n'));
}

main();
