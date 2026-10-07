/**
 * test/desc-zh.test.mjs —— 内置离线预译描述表（lib/desc-zh.js，2026-10-05 裁定的 B）。
 *
 * 这一套不发请求、不碰本机：表是随插件发货的死数据，判据全部离线可复跑。
 * ★ 用例钉的是「译文与解析器同口径」这类前提，不是钉表里某一句翻得好不好 ——
 *   译文质量靠人工过目，前提一旦漂了（清洗变了、原文抄错一格）必须当场挂。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, runAll, assert, fixture } from './_helpers.mjs';
import {
  DESC_ZH_ROWS, DESC_ZH_AT, DESC_ZH_ORIGIN, DESC_ZH_LABEL, DESC_ZH_NOTE,
  DESC_ZH_COUNT, descZhFor, descZhHits, descZhNorm,
} from '../lib/desc-zh.js';
import { parseTrendingHtml } from '../lib/services/gh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_SRC = readFileSync(path.join(HERE, '..', 'lib', 'desc-zh.js'), 'utf8');
const CJK_RE = /[㐀-鿿]/;

check('dz-1 表体形状：主键小写、原文非空、译文是中文且不等于原文、主键不重号', () => {
  assert.ok(DESC_ZH_ROWS.length >= 60, `表缩到 ${DESC_ZH_ROWS.length} 条？整理时的读数是 73`);
  const seen = new Set();
  for (const [repo, src, zh] of DESC_ZH_ROWS) {
    assert.match(repo, /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/, `主键不是小写 owner/name：${repo}`);
    assert.ok(!seen.has(repo), `主键重号：${repo}`);
    seen.add(repo);
    assert.ok(typeof src === 'string' && src.trim() !== '', `${repo} 的原文是空的`);
    assert.ok(CJK_RE.test(zh), `${repo} 的译文里没有汉字`);
    assert.notEqual(zh, src, `${repo} 的译文与原文一模一样，那不是翻译`);
    assert.ok(!CJK_RE.test(src), `${repo} 的原文自带中文，不该进表：${src.slice(0, 40)}`);
  }
  assert.equal(DESC_ZH_COUNT, DESC_ZH_ROWS.length, '条数读数与表体不一致');
});

check('dz-2 命中判据是「主键 + 原文逐字相同」：仓库改了原文就退回原文显示，不许拿旧译文指鹿为马', () => {
  const [repo, src, zh] = DESC_ZH_ROWS[0];
  assert.equal(descZhFor(repo, src), zh, '原文一字不差却查不到');
  assert.equal(descZhFor(repo.toUpperCase(), src), zh, '主键大小写该不敏感（榜面存的就是小写主键）');
  assert.equal(descZhFor(repo, src.replace(/\s+/, '  ')), zh, '空白只该按归一后比对（换行/缩进不算改了原文）');
  assert.equal(descZhFor(repo, src + '（GitHub 上补了一句）'), '', '原文变了还给译文 = 拿过期翻译冒充现译');
  assert.equal(descZhFor(repo, src.slice(0, src.length - 1)), '', '原文少一个字符也算变了');
  assert.equal(descZhFor('no/such-repo', src), '', '表外的仓库凭空冒出一句中文');
  assert.equal(descZhFor(repo, ''), '', '空描述该没译文');
  assert.equal(descZhFor(undefined, undefined), '', '脏输入不许抛，也不许给译文');
});

check('dz-3 ★表与解析器同口径：四份夹具页面上「表里有此仓库」的每一行都必须命中', async () => {
  // 这条钉的是前提：表里的原文是 parseTrendingHtml → textOf 清洗后的产物。
  // 哪天清洗规则变了（比如多去了一个空格），这里就查不到 —— 而不是界面上悄悄少一句中文。
  let checked = 0; let missed = [];
  for (const name of ['gh-daily.html', 'gh-weekly.html', 'gh-monthly.html', 'gh-lang-rust.html']) {
    const res = parseTrendingHtml(await fixture(name), { language: name.includes('rust') ? 'rust' : '' });
    assert.equal(res.ok, true, `${name} 解析失败：${res.reason}`);
    for (const r of res.rows) {
      if (!r.desc) continue;
      if (!DESC_ZH_ROWS.some(([repo]) => repo === r.repo)) continue; // 表外仓库：本来就不该有译文
      checked += 1;
      if (!descZhFor(r.repo, r.desc)) missed.push(`${r.repo} :: ${r.desc.slice(0, 60)}`);
    }
  }
  assert.ok(checked >= 15, `夹具里能对上榜面的行只有 ${checked} 条，这条判据等于没扫到现场`);
  assert.deepEqual(missed, [], `清洗口径漂了，这些行的原文与表里记的不是同一串：\n  ${missed.join('\n  ')}`);
});

check('dz-4 仓库自己就写中文的那三条不进表：那不是翻译', () => {
  const inTable = new Set(DESC_ZH_ROWS.map(([repo]) => repo));
  for (const repo of ['harry0703/moneyprinterturbo', 't8y2/dbx', 'zerx-lab/fluxdown']) {
    assert.equal(inTable.has(repo), false, `${repo} 的描述本来就带中文，进表就是多此一举`);
  }
});

check('dz-5 日期与来源只有一份：三句界面文案都由 DESC_ZH_AT / DESC_ZH_ORIGIN 拼出来', () => {
  assert.equal(DESC_ZH_AT, '2026-10-06');
  assert.match(DESC_ZH_LABEL, new RegExp(DESC_ZH_AT));
  assert.match(DESC_ZH_NOTE, new RegExp(DESC_ZH_AT));
  assert.ok(DESC_ZH_NOTE.includes(DESC_ZH_ORIGIN), '整句里没带来源名');
  assert.match(DESC_ZH_NOTE, /不是现译/, '★ 用户裁定：别让人误以为是现译 —— 这句是这条功能的存在理由');
});

check('dz-6 这份文件是死的：零 import、零 fetch、零宿主句柄 —— 离线口径由源码钉住', () => {
  const code = ROOT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((code.match(/^\s*import\s/gm) || []).length, 0, '预译表不许 import 任何东西（带进来的都是活口）');
  for (const forbidden of ['fetch(', 'require(', 'ctx.', 'readFileSync']) {
    assert.equal(code.includes(forbidden), false, `离线表里出现了 ${forbidden}`);
  }
});

check('dz-7 descZhHits 只收命中的行，键就是小写主键（客户端拿它直接取值，不再判一遍）', () => {
  const [repo, src, zh] = DESC_ZH_ROWS[0];
  const hits = descZhHits([
    { repo, desc: src },
    { repo: 'other/one', desc: src },
    { repo: 'no/such', desc: 'whatever' },
    { repo, desc: '原文改过了' },
    null,
    { repo: undefined, desc: undefined },
  ]);
  assert.deepEqual(Object.keys(hits), [repo]);
  assert.equal(hits[repo], zh);
  assert.deepEqual(descZhHits(), {}, '没有行就给空对象，别甩 undefined 让界面去猜');
  assert.equal(descZhNorm('  a \n b  '), 'a b', '归一只该动空白');
});

await runAll('desc-zh');
