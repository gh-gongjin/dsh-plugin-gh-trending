/**
 * test/make-repo-fixtures.mjs —— 从真接口切出 lib/services/repo.js 吃得到的最小夹具（口径同 make-fixtures.mjs）。
 *
 * 为什么单独一个生成器：详情层的全部判断（中文判据 / 2~4 发编排 / 限额头 / 404 正文）都只能对着**真字节**钉，
 * 手搓的假 JSON 会跟着写用例的人一起想当然（项目记忆「跨边界 payload 两头都要断言」）。
 *
 * 出网走插件自己的隧道（lib/services/net.js），一次跑满 10 发（实测限额 60/小时，跑得起）。
 * README 只留**逐字节前缀**（真接口整篇 3.4KB~109KB，判据只看去标签后首屏 600 字），
 * 截断位置、真实长度、是否截断都记在夹具里，不留"看着像全文"的误会。
 *
 * 用法：node test/make-repo-fixtures.mjs            （已有夹具就不动，直接退出）
 *       node test/make-repo-fixtures.mjs --force    （重抓并覆盖）
 * 不做 --check：比对要再打九发真接口，而详情层判据对"榜面今天换了哪几个仓库"不敏感，
 * 夹具的时效由 capturedAt 说明，界面上要的是形状而不是今天的内容。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNetTransport } from '../lib/services/net.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures', 'repo-api.json');
const RAW = 'application/vnd.github.raw';
const JSON_ACCEPT = 'application/vnd.github+json';
/** README 正文留多少前缀（判据窗口是去标签后 600 字，2000 原字足够富余）。 */
const README_KEEP = 2000;

/** 十发覆盖 repo.js 的全部分支：中文默认篇 / 英文篇+zh 文件 / 英文篇且没有 zh / 404。 */
const CAPTURES = [
  { path: '/repos/ruanyf/weekly', accept: JSON_ACCEPT, why: '默认 README 整站中文（zh_default 档）' },
  { path: '/repos/ruanyf/weekly/readme', accept: RAW, why: 'zh_default 的正文（截前缀）', readme: true },
  { path: '/repos/ant-design/ant-design', accept: JSON_ACCEPT, why: '默认 README 英文、根目录另有中文篇（zh_file 档）' },
  { path: '/repos/ant-design/ant-design/readme', accept: RAW, why: 'zh_file 档的默认篇（触发根目录列表）', readme: true },
  { path: '/repos/ant-design/ant-design/contents/', accept: JSON_ACCEPT, why: '根目录列表（pickZhReadme 的真名输入）' },
  { path: '/repos/ant-design/ant-design/contents/README-zh_CN.md', accept: RAW, why: '中文篇正文（截前缀）', readme: true },
  { path: '/repos/vitejs/vite', accept: JSON_ACCEPT, why: '默认 README 英文且根目录没有中文篇（en_default 档）' },
  { path: '/repos/vitejs/vite/readme', accept: RAW, why: '英文篇，且根目录没有 zh README（en_default 档）', readme: true },
  { path: '/repos/vitejs/vite/contents/', accept: JSON_ACCEPT, why: '只有 README.md 的根目录列表' },
  { path: '/repos/this-org/no-such-repo-xyz', accept: JSON_ACCEPT, why: '真 404 正文（not_found 档，也用来合成"没有 README"）' },
];

const net = createNetTransport({ getPrefs: () => ({ proxyMode: 'system', proxyUrl: '' }), env: process.env });

async function capture(spec) {
  const url = `https://api.github.com${spec.path}`;
  const t0 = Date.now();
  const res = await net.fetch(url, {
    method: 'GET',
    headers: { 'user-agent': 'dsh-plugin-gh-trending (read-only probe)', accept: spec.accept, 'accept-encoding': 'identity' },
    timeoutMs: 20000,
  });
  const text = await res.text();
  const head = (k) => { const v = res.headers?.get?.(k); return v === null || v === undefined ? '' : String(v); };
  const full = text.length;
  const kept = spec.readme ? text.slice(0, README_KEEP) : text;
  return {
    path: spec.path,
    accept: spec.accept,
    why: spec.why,
    status: res.status,
    headers: {
      'content-type': head('content-type'),
      'x-ratelimit-limit': head('x-ratelimit-limit'),
      'x-ratelimit-remaining': head('x-ratelimit-remaining'),
      'x-ratelimit-reset': head('x-ratelimit-reset'),
    },
    fullLength: full,
    keptLength: kept.length,
    truncated: kept.length < full,
    secs: (Date.now() - t0) / 1000,
    text: kept,
  };
}

const mode = process.argv[2] ?? '';
if (existsSync(OUT) && mode !== '--force') {
  console.log(`夹具已存在（默认不覆盖）：${OUT}`);
  console.log('要重抓就 `node test/make-repo-fixtures.mjs --force`；repo.test.mjs 只吃现有夹具。');
  process.exit(0);
}

const responses = [];
for (const spec of CAPTURES) {
  try {
    const r = await capture(spec);
    responses.push(r);
    console.log(`${r.status} ${r.secs.toFixed(2)}s ${String(r.fullLength).padStart(6)}B→${r.keptLength}${r.truncated ? '（截）' : ''} 限额 ${r.headers['x-ratelimit-remaining']}/${r.headers['x-ratelimit-limit']} ${r.path}`);
  } catch (e) {
    console.log(`ERR ${spec.path} ← ${e?.code ?? ''} ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
if (process.exitCode) {
  console.log('\n有抓取失败，夹具不写盘（半套夹具比没有夹具更误导）。');
  process.exit(1);
}

const doc = {
  _note: 'lib/services/repo.js 的接口夹具。逐字节取自 api.github.com 真响应；README 只留前缀（截断见 truncated/keptLength/fullLength）。生成：node test/make-repo-fixtures.mjs --force。',
  capturedAt: Date.now(),
  // 出网路线由 net.describe() 当场记（代理地址已打码），不写死句子
  route: net.describe(),
  synthesized: {
    readme_404: '「有元数据但没有 README」这一档没有现成真仓库，用本文件的 no-such-repo-xyz 真 404 正文拼出来（用例里标了出处）。',
    rate_limited: '限额用尽档用 403 + x-ratelimit-remaining:0 合成，真接口没法按需触发。',
  },
  responses,
};
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`\n已写 ${OUT}（${responses.length} 发，最后一发剩 ${responses[responses.length - 1].headers['x-ratelimit-remaining']}）`);
