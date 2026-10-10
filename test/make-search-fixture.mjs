/**
 * test/make-search-fixture.mjs —— 从真接口切「全站高星」那一发的夹具（口径同 make-repo-fixtures.mjs）。
 *
 * 为什么必须真抓（第二十三轮 §8.8 步骤 3 的落地判据就是这一句）：`searchRepositories()` 的映射、位次、
 * 限额头三格全都只能对着**真字节**钉，手搓的假 JSON 会跟着写用例的人一起想当然（项目记忆「跨边界 payload 两头都要断言」）。
 * 本机此前对 `/search/repositories` 零真回包 ⇒ 抓不到就不写盘，绝不拿"我觉得 GitHub 会这么答"当夹具。
 *
 * 裁剪口径（写在夹具里，不留"看着像全文"的误会）：整段回包约 180KB，而这一档只吃四个字段。
 *   · 前 KEEP_FULL 条 item **逐字节全留** ⇒ 「回包多余字段不许跟着进载荷」那条判据有真字段可扫（一条 item 六十多个键）；
 *   · 其余只留被读的四个键 ⇒ 位次顺序、行数、真值仍在，体积降到单页量级。
 *   `total_count` / `incomplete_results` 原样保留（代码不读它们，留着是为了下一轮改版时看得见形状）。
 *
 * 用法：node test/make-search-fixture.mjs            （已有夹具就不动，直接退出）
 *       node test/make-search-fixture.mjs --force    （重抓并覆盖）
 */
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNetTransport } from '../lib/services/net.js';
import { searchRepoUrl } from '../lib/services/repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures', 'repo-search.json');
const JSON_ACCEPT = 'application/vnd.github+json';
/** 前几条留全字段（其余裁到被读的四个键）。 */
const KEEP_FULL = 3;
const READ_KEYS = ['full_name', 'description', 'language', 'stargazers_count'];

const net = createNetTransport({ getPrefs: () => ({ proxyMode: 'system', proxyUrl: '' }), env: process.env });

const mode = process.argv[2] ?? '';
if (existsSync(OUT) && mode !== '--force') {
  console.log(`夹具已存在（默认不覆盖）：${OUT}`);
  console.log('要重抓就 `node test/make-search-fixture.mjs --force`；repo.test.mjs 只吃现有夹具。');
  process.exit(0);
}

const path = searchRepoUrl();
const t0 = Date.now();
const res = await net.fetch(`https://api.github.com${path}`, {
  method: 'GET',
  headers: { 'user-agent': 'dsh-plugin-gh-trending (read-only probe)', accept: JSON_ACCEPT, 'accept-encoding': 'identity' },
  timeoutMs: 20000,
});
const text = await res.text();
const head = (k) => { const v = res.headers?.get?.(k); return v === null || v === undefined ? '' : String(v); };
console.log(`${res.status} ${((Date.now() - t0) / 1000).toFixed(2)}s ${text.length}B 限额 ${head('x-ratelimit-remaining')}/${head('x-ratelimit-limit')} ${path}`);
if (res.status !== 200) {
  console.log('\n不是 200，夹具不写盘（半套夹具比没有夹具更误导）。正文前 300 字：\n' + text.slice(0, 300));
  process.exit(1);
}
let j;
try { j = JSON.parse(text); } catch { console.log('正文不是 JSON，不写盘。'); process.exit(1); }
if (!Array.isArray(j.items) || j.items.length === 0) {
  console.log('回包没有 items 数组或为空，不写盘。');
  process.exit(1);
}

const items = j.items.map((it, i) => (i < KEEP_FULL ? it : Object.fromEntries(READ_KEYS.filter((k) => k in it).map((k) => [k, it[k]]))));
const doc = {
  _note: 'lib/services/repo.js 的 searchRepositories() 夹具。整段一次真抓（api.github.com /search/repositories 真响应），'
    + `裁剪口径：前 ${KEEP_FULL} 条 item 逐字节全留（键数见 firstItemKeys），其余只留被读的四个键 [${READ_KEYS.join(', ')}]。`
    + '截断位置与真实长度记在 fullLength / keptLength / originalItems 里，用例不许把裁过的行当全文。',
  capturedAt: Date.now(),
  route: net.describe(),
  request: { path, accept: JSON_ACCEPT, urlEncoded: path, note: 'q 里的 >= 由 URLSearchParams 编码成 %3E%3D（判据扫的就是这一格）' },
  response: {
    status: res.status,
    headers: {
      'content-type': head('content-type'),
      'x-ratelimit-limit': head('x-ratelimit-limit'),
      'x-ratelimit-remaining': head('x-ratelimit-remaining'),
      'x-ratelimit-reset': head('x-ratelimit-reset'),
    },
    fullLength: text.length,
    keptLength: JSON.stringify({ ...j, items }).length,
    originalItems: j.items.length,
    fullItems: KEEP_FULL,
    readKeys: READ_KEYS,
    firstItemKeys: Object.keys(j.items[0]).length,
    topLevelKeys: Object.keys(j),
    totalCount: j.total_count,
    incompleteResults: j.incomplete_results,
  },
  // 顶层两格原样、items 按上面的口径裁：正文形状与真接口一致，只是短。
  text: JSON.stringify({ total_count: j.total_count, incomplete_results: j.incomplete_results, items }),
};
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`已写 ${OUT}（items ${items.length} 条，其中全字段 ${KEEP_FULL} 条；一条 item 实测 ${doc.response.firstItemKeys} 个键）`);
