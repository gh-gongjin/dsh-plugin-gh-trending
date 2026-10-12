/**
 * test/full-readme.test.mjs —— 详情弹框那三枚手动按钮的编排（lib/services/full-readme.js，第二十八轮 §8.11）。
 *
 * 这一套钉的是**编排与句子**，不是「GitHub 真怎么答」：`fetchFull` 是替身，交给它的整篇正文是**合成**的
 * （分块、发数、熔断这些都只吃长度与段落数，真机那一发的形状由 test/repo.test.mjs 的 7b 那一节钉）。
 * ★ 三条不许写歪的（都在源码注释里，这里逐条给判据）：
 *  · 展开那一发不带验证器 ⇒ 归 7b，本套只认 `fetchFull` 被叫了几次、拿了什么；
 *  · 分块那几发 `persist:false`、整趟只落**一行**，`src` 存整篇指纹 ⇒ 本套按真 `trans` 表数行；
 *  · 手动绕的是设置页那两个开关，**不绕就绪态与能力位** ⇒ 置灰的四种原因各说各的话。
 * ★ 表用的是 `lib/stores.js` 那颗真 `createTransStore` + 假设施：桩若自己决定绿不绿，断言就没牙了
 *   （项目记忆「断言有牙要用隔离变异并拿到失败信号」）。
 */
import { check, runAll, assert, makeFakeFacility } from './_helpers.mjs';
import { createFullReadmeService, readmeFingerprint, chunkParagraphs, manualGateOf } from '../lib/services/full-readme.js';
import { createTransStore } from '../lib/stores.js';
import { transSrcKey } from '../lib/services/llm.js';
import {
  MANUAL_ACTIONS, MANUAL_ACTION_KIND, MANUAL_ACTION_LABELS, MANUAL_KINDS, MANUAL_ACTIONS_SECTION, MANUAL_RUN_NOTE,
  MANUAL_LEG_MAX, MANUAL_CONCURRENCY, MANUAL_FULL_ZH_MAX, MANUAL_GATE_NOTES, MANUAL_ACTION_HINTS,
  manualFuseNote, manualCachedNote, manualBlockFailNote, manualBlockFailCountNote, manualSumFailNote,
  manualNoStoreNote, manualStoreFailNote, manualNotStoredNote, manualLegsNote, manualExpandedMeta,
  manualFailNote, manualSectionTitle, manualInMax, REPO_ERROR_LABELS, TRANSLATE_ENGINE_LABELS, engineZhLabel,
  TRANS_IN_MAX, LLM_IN_MAX_BY_KIND,
} from '../lib/domain.js';

const AT = 1_760_000_000_000;
const KEY = 'cathrynlavery/diagram-design';

/* ---- 替身：整篇那一发 / 当前那一路现译服务 / 真译文表 ---- */

/** `fetchFull` 替身：按 repo.js `fullReadme` 的返回形状给（chars 去标记、rawChars 原文）。 */
function mkFetchFull(over = {}) {
  const calls = [];
  const fn = async (name, opts = {}) => {
    calls.push({ name, opts });
    if (over.fail) return { ok: false, errKey: over.fail.errKey ?? 'transport', errText: over.fail.errText ?? '替身给的失败', at: AT, rate: null };
    const text = over.text ?? 'english readme';
    return { ok: true, text, chars: text.length, rawChars: over.rawChars ?? text.length * 2, at: AT, rate: { left: 58, resetAt: AT, limit: 60, authed: false } };
  };
  fn.calls = calls;
  fn.over = over;   // 用例里要改正文（比如"仓库改了一个字"）：改的是**同一个替身**，库与在途表都得是同一副
  return fn;
}

/**
 * 现译那一路的替身：记每一发的 `{repo,kind,persist}`，并按 `mode` 给成/败。
 * `mode='fail#' + n` ⇒ 第 n 块失败；`mode='sum'` ⇒ 汇总那一发（`#sum`）失败；`active/maxActive` 量并发。
 */
function mkTr({ kinds = [...MANUAL_KINDS], ready = true, enabled = true, failBlock = 0, failSum = false, zh = '译好的中文', zhOf = null } = {}) {
  const jobs = [];
  let active = 0; let maxActive = 0;
  return {
    jobs,
    peek: () => ({ active, maxActive }),
    kinds: () => kinds,
    ready: () => ready,
    enabled: (kind) => (typeof enabled === 'function' ? enabled(kind) : enabled && kinds.includes(kind)),
    async translate(arg) {
      jobs.push(arg);
      active += 1; if (active > maxActive) maxActive = active;
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      const seq = Number(String(arg.repo).split('#')[1]);
      const isSum = String(arg.repo).endsWith('#sum');
      if ((failBlock && seq === failBlock) || (isSum && failSum)) {
        return { ok: false, zh: '', cached: false, at: 0, label: '', stored: false, note: '厂商回 403', errKey: 'http', errText: 'HTTP 403 限额', engine: '' };
      }
      const given = isSum ? '汇总过的那一篇' : (zhOf ? zhOf(arg.text) : `${zh}${seq}`);
      return {
        ok: true, zh: given, cached: false, at: AT,
        label: engineZhLabel('keyless', AT), stored: true, note: '', errKey: '', errText: '', engine: 'keyless',
      };
    },
  };
}

/** 真译文表（假设施）：行数与行内容都从这里读，不许替身自己决定绿不绿。 */
function mkStore() {
  const facility = makeFakeFacility();
  const transStore = createTransStore({ getFacility: () => facility, logger: { warn: () => {} } });
  return { transStore, facility };
}

/** 五段 × ~699 字的整篇：宿主档 1,800 字一块 ⇒ 恰好切成 3 块（块边界由 chunkParagraphs 自己算，不在这里写死）。 */
const P5 = Array.from({ length: 5 }, (_, i) => `p${i} ${'word '.repeat(139).trim()}`).join('\n\n');
/**
 * 五段 × 4,000 字的整篇：**摘要**那一趟用它 —— 它的块长是 9,000（`LLM_IN_MAX_BY_KIND.readmeFullSum`，
 * 因为汇总那一发喂的是各块短述拼起来的长文），拿 P5 那份 3,495 字去只切得出 1 块，钉不到"多块 + 末尾一发"的形状。
 */
const P_LONG = Array.from({ length: 5 }, (_, i) => `${'e'.repeat(3995)}${i}`).join('\n\n');

function mk({ text = P5, engine = 'host_llm', trOpts = {}, fetchOver = {}, withStore = true, logger } = {}) {
  const fetchFull = mkFetchFull({ text, ...fetchOver });
  const tr = mkTr(trOpts);
  const box = withStore ? mkStore() : { transStore: null, facility: null };
  const svc = createFullReadmeService({
    fetchFull, getTranslator: () => tr, getEngine: () => engine,
    transStore: box.transStore ?? undefined, logger: logger ?? { warn: () => {} }, now: () => AT,
  });
  return { svc, tr, fetchFull, ...box };
}

const runOf = (o, action, over = {}) => o.svc.run({ name: KEY, action, readmeSource: over.readmeSource ?? 'en_default', path: over.path ?? '', ...over });

/* ------------------------------------------------------------------ *
 * 1. 纯函数：指纹 / 切块 / 置灰
 * ------------------------------------------------------------------ */
check('readmeFingerprint：折叠空白后取 sha256 前 16 位，再接冒号与字数 ⇒ 空白写法不同、改一个字，两样都判得开', () => {
  const a = readmeFingerprint('hello   world');
  assert.match(a, /^[0-9a-f]{16}:\d+$/, `指纹形状不对：${a}`);
  assert.equal(a, readmeFingerprint('hello world'), '空白折叠是同一条律（两路服务比 src 用的就是它）');
  assert.notEqual(a, readmeFingerprint('hello world!'), '仓库改了正文必须换指纹 ⇒ 旧译文自动作废');
  assert.equal(a.split(':')[1], String(transSrcKey('hello   world').length), '字数那一截吃的是**折过以后**的长度，不是原始入参长度');
  assert.ok(a.length <= 25, `整篇 48K 字压成指纹才有意义：${a.length}`);
});

check('chunkParagraphs：只在段落边界累加，单段超预算才切在句末；块拼回不含丢字', () => {
  const paras = ['一'.repeat(100), '二'.repeat(100), '三'.repeat(100)];
  assert.deepEqual(chunkParagraphs(paras.join('\n\n'), 300), [`${'一'.repeat(100)}\n\n${'二'.repeat(100)}`, '三'.repeat(100)],
    '累加到装不下才断块，断在段落边界');
  // 单段超限：切在预算内最靠后的句末（中英两种都认），而不是硬截半个词
  const long = 'Abc def. '.repeat(40).trim();     // 360 字，一句 9 字
  const out = chunkParagraphs(long, 100);
  assert.ok(out.length >= 3, `单段 360 字按 100 预算该切至少 3 块，拿到 ${out.length}`);
  assert.ok(out.every((b) => b.length <= 100), '任何一块都不许超预算（超了就是喂进去被服务那侧 slice 掉，句子会缺半截）');
  assert.ok(out.every((b) => /[.!?。！？]$/.test(b) || b.length >= 60), '切点要么落在句末，要么是"离句末太远就直接切"那一档');
  assert.equal(out.join('').replace(/\s+/g, ''), long.replace(/\s+/g, ''), '分块不许丢字：拼回来与原文逐字同');
  // 预算坏了不给块（宁可让上面那句「切不出块」判失败，也不自己兜一个默认块长 = 第二份真相）
  assert.deepEqual(chunkParagraphs('x', 0), []);
  assert.deepEqual(chunkParagraphs('x', NaN), []);
  assert.deepEqual(chunkParagraphs('', 100), []);
});

check('置灰口径 manualGateOf：四种不能点各说各的话，能点时那句说的是这一趟做什么', () => {
  const tr = mkTr();
  const g = (kind, view, t = tr) => manualGateOf(t, kind, view);
  assert.deepEqual(g('readmeFullZh', { readmeSource: '' }), { can: false, gate: 'no_readme', note: MANUAL_GATE_NOTES.no_readme });
  assert.equal(g('readmeFullZh', { readmeSource: 'none' }).gate, 'no_readme', 'GitHub 回 404 那种"确实没有这一篇"也算没原文，不是"取失败"');
  // 中文那两档置灰；`zh_section` 不置灰 —— 整篇仍是英文，那一段只是嵌进来的一小节
  assert.equal(g('readmeFullZh', { readmeSource: 'zh_default' }).gate, 'already_zh');
  assert.equal(g('readmeFullSum', { readmeSource: 'zh_file' }).gate, 'already_zh');
  assert.equal(g('readmeFullZh', { readmeSource: 'zh_section' }).can, true, 'zh_section 那一篇整篇仍是英文 ⇒ 展得开也译得动');
  // 展开没有 kind：它只吃"有没有原文"，不看能力位、不看就绪态
  assert.deepEqual(g('', { readmeSource: 'en_default' }, null), { can: true, gate: '', note: MANUAL_ACTION_HINTS.expand });
  assert.equal(g('', { readmeSource: 'none' }, null).gate, 'no_readme', '没有原文时展开也按不动，且那句不是"引擎没就绪"');
  // 能力位挡摘要（免费档那一路），就绪态挡两路 —— 三句话互不通用
  const free = mkTr({ kinds: ['desc', 'readme', 'readmeFullZh'] });
  assert.equal(g('readmeFullSum', { readmeSource: 'en_default' }, free).gate, 'no_sum_capability');
  assert.equal(g('readmeFullZh', { readmeSource: 'en_default' }, free).can, true);
  assert.equal(g('readmeFullZh', { readmeSource: 'en_default' }, mkTr({ ready: false })).gate, 'not_ready');
  assert.equal(g('readmeFullZh', { readmeSource: 'en_default' }, mkTr({ enabled: () => false })).gate, 'not_ready');
  assert.equal(g('readmeFullZh', { readmeSource: 'en_default' }, null).gate, 'not_ready', '压根选不出引擎 ⇒ 说发不出去，不是崩');
});

/* ------------------------------------------------------------------ *
 * 2. 闸门与失败形状：一句成品话，零发
 * ------------------------------------------------------------------ */
check('action 越界与坏名字：零出网、零发，且那句是 domain 拼好的成品（客户端不许自己拼「这一趟没跑成：」+ 认不出的键）', async () => {
  const o = mk();
  const bad = await runOf(o, 'translate-all');
  assert.equal(bad.ok, false);
  assert.equal(bad.errKey, 'bad_action');
  assert.deepEqual(bad.notes, [manualFailNote('bad_action', bad.errText)], 'notes 就是那一句成品，句子只有一份');
  assert.deepEqual(bad.legs, { gh: 0, out: 0 }, '没出发的那一趟不许报发数');
  assert.equal(bad.fused, false);
  const noKey = await o.svc.run({ name: 'only-owner', action: 'expand' });
  assert.equal(noKey.errKey, 'bad_key');
  assert.equal(noKey.notes[0], manualFailNote('bad_key', noKey.errText));
  assert.deepEqual(Object.keys(REPO_ERROR_LABELS).filter((k) => ['bad_action', 'bad_key'].includes(k)).sort(), ['bad_action', 'bad_key'],
    '两档都在名单里 ⇒ manualFailNote 永远念得出人话（认不出键名时才原样交回）');
  assert.equal(o.fetchFull.calls.length, 0, '闸门挡掉的那些一发都不许出发');
  assert.equal(o.tr.jobs.length, 0);
});

check('README 里那一发本身失败：把它的 errKey 原样交回，账上记 1 发 GitHub、0 发翻译', async () => {
  const o = mk({ fetchOver: { fail: { errKey: 'not_found', errText: '/repos/x/readme 返回 404' } } });
  const r = await runOf(o, 'translate');
  assert.equal(r.ok, false);
  assert.equal(r.errKey, 'not_found');
  assert.deepEqual(r.legs, { gh: 1, out: 0 }, '那一发真出过网：账要记它，但翻译那几发压根没开始');
  assert.equal(r.notes[0], manualFailNote('not_found', '/repos/x/readme 返回 404'));
  assert.equal(o.tr.jobs.length, 0);
});

/* ------------------------------------------------------------------ *
 * 3. 展开：两块覆盖是给客户端对齐用的，不是让它自己判
 * ------------------------------------------------------------------ */
check('展开全文：一发 GitHub、零发翻译，回执直接把那**两块**要换成什么给全（客户端按 kind 覆盖，不自己判这一段该显示什么）', async () => {
  const o = mk({ text: '整篇的正文', fetchOver: { rawChars: 48549 } });
  const r = await runOf(o, 'expand');
  assert.equal(r.ok, true);
  assert.equal(o.fetchFull.calls.length, 1);
  assert.deepEqual(o.fetchFull.calls[0], { name: KEY.toLowerCase(), opts: { path: '' } }, '展开只把仓库与屏上那一篇的 path 交给那一发');
  assert.equal(o.tr.jobs.length, 0, '展开不派翻译：它只把原文搬上屏');
  assert.deepEqual(r.blocks, [{ kind: 'excerpt', text: '整篇的正文' }, { kind: 'num', text: manualExpandedMeta(48549) }],
    '两块的 kind 就是 repo.js 段表里那两种：对不上就覆盖不到，屏上会同时出现节选与整篇');
  assert.equal(r.meta, manualExpandedMeta(48549), '那句元数据吃**原文**长度（rawChars）：屏上「整篇 48,549 字」与展开后那句得是同一个数');
  assert.deepEqual(r.legs, { gh: 1, out: 0 });
  assert.deepEqual(r.notes, [], '展开成功没话可说：不许凑一句"这一趟跑了 N 发"');
  assert.equal((await o.transStore.list()).length, 0, '展开不落任何一行译文');
});

/* ------------------------------------------------------------------ *
 * 4. 译整篇：分块、并发、落一行、那句出网账
 * ------------------------------------------------------------------ */
check('译整篇：按段落切成 3 块、并发 2 跑完、每一发都 persist:false，整趟只落**一行**且 src 是整篇指纹', async () => {
  const o = mk();
  const r = await runOf(o, 'translate');
  assert.equal(r.ok, true, JSON.stringify(r.notes));
  assert.equal(o.tr.jobs.length, 3, `宿主档 1,800 字一块 ⇒ 那 5 段该切 3 块，实际 ${o.tr.jobs.length} 发`);
  assert.deepEqual(o.tr.jobs.map((j) => j.kind), ['readmeFullZh', 'readmeFullZh', 'readmeFullZh']);
  assert.deepEqual(o.tr.jobs.map((j) => j.persist), [false, false, false],
    '分块那一发写进表就是拿 27 行挤掉榜面那两路的复用行（TRANS_MAX 只有 200）');
  assert.equal(o.tr.peek().maxActive, MANUAL_CONCURRENCY, `同时在途该是 ${MANUAL_CONCURRENCY} 发：串行太慢，全并发会引限流`);
  assert.equal(r.zh, `译好的中文1\n\n译好的中文2\n\n译好的中文3`, '按**原序**拼回：并发跑完不许把块顺序交回成完成顺序');
  assert.deepEqual(r.legs, { gh: 1, out: 3 });
  assert.equal(r.blocks, 3);
  assert.deepEqual(r.notes, [manualLegsNote({ ghLegs: 1, outLegs: 3, who: TRANSLATE_ENGINE_LABELS.host_llm, fused: false })], '那句出网账只有 domain 那一份');
  // 库里那一行：主键 kind:小写仓库，src 是整篇指纹，engine 是**跑的时候那一档**
  const rows = await o.transStore.list();
  assert.equal(rows.length, 1, '整趟只落一行');
  const row = await o.transStore.get('readmeFullZh', KEY.toLowerCase());
  assert.equal(row.src, readmeFingerprint(P5), 'src 存指纹不存整篇：命中判据「主键 + src 逐字相同」一个字没改');
  assert.equal(row.engine, 'host_llm');
  assert.equal(row.at, AT);
  assert.equal(r.label, engineZhLabel('host_llm', AT), '段名那截落款由服务端拼好，客户端不拼');
  assert.equal(r.stored, true);
});

check('原文指纹对上库里那一行 ⇒ 零发翻译、GitHub 那一发照扣，那句说的是「没有重跑」', async () => {
  const o = mk();
  await o.transStore.put({ repo: KEY.toLowerCase(), kind: 'readmeFullZh', src: readmeFingerprint(P5), zh: '库里已有那一篇', at: AT - 9_000, chars: 7, engine: 'baidu' });
  const r = await runOf(o, 'translate');
  assert.equal(r.ok, true);
  assert.equal(r.cached, true);
  assert.equal(r.zh, '库里已有那一篇');
  assert.equal(o.tr.jobs.length, 0, '对上指纹还重发 = 白烧额度');
  assert.deepEqual(r.legs, { gh: 1, out: 0 });
  assert.deepEqual(r.notes, [manualCachedNote()]);
  // 落款跟着**行里那一档**（百度），不是跟着当前设置：把免费接口译的那句署成模型现译就是指鹿为马
  assert.equal(r.engine, 'baidu');
  assert.equal(r.label, engineZhLabel('baidu', AT - 9_000));
  // 改一个字 ⇒ 指纹换 ⇒ 旧译文自动作废重译（不许顶着旧译文上屏）
  // ★ 第二趟复用**同一个库与同一个替身**：换新库跑第二趟测的是"库里没有那一行"，比松成"有行就命中"照样绿（证伪电池 ② 首跑就是这么全绿的）。
  o.fetchFull.over.text = `${P5} 改了`;
  const r2 = await runOf(o, 'translate');
  assert.equal(r2.cached, false, '仓库改了正文还拿旧译文上屏，屏上那句就是假话');
  assert.equal(o.tr.jobs.length, 3, '第一趟命中库里那一行（零发），这一趟对不上指纹才发满 3 发');
  assert.equal(o.fetchFull.calls.length, 2, 'GitHub 那一发每趟一发：命中与否都要先问一次正文才知道指纹对不对');
  const row2 = await o.transStore.get('readmeFullZh', KEY.toLowerCase());
  assert.equal(row2.src, readmeFingerprint(`${P5} 改了`), '库里那一行跟着换成新指纹：下次点开这一篇才对得上');
});

check('一块失败不整趟作废：那块**原位留原文**并指得回第几块，其余照拼、照样落库', async () => {
  const o = mk({ trOpts: { failBlock: 2 } });
  const r = await runOf(o, 'translate');
  assert.equal(r.ok, true);
  assert.ok(r.zh.includes(`\n（${manualBlockFailNote(2, o.tr.jobs[1].text.length)}）`), `第二块该留原文占位：${r.zh}`);
  assert.ok(r.zh.startsWith('译好的中文1'), '第一块没失败，不许被连坐');
  assert.ok(r.zh.endsWith('译好的中文3'), '第三块照拼，失败那块之后不许断');
  assert.equal(r.failed, 1);
  assert.ok(r.notes.includes(manualBlockFailCountNote(1)), '那句只报个数：具体哪一块已经写在各那一块的位置里');
  const row = await o.transStore.get('readmeFullZh', KEY.toLowerCase());
  assert.ok(row && row.zh.includes('word'), '带一块原文的整篇也落库（下次点开指纹还对得上，就不该重烧 3 发）');
});

check('熔断：块数超过预算就跑满即停，没跑的尾巴**不进段**，且那句报的是跑到的块数', async () => {
  // 每段 3,499 字（< 免费档 3,500 的预算 ⇒ 一段一块），段数给到 MANUAL_LEG_MAX + 5 ⇒ 必然撞闸
  const text = Array.from({ length: MANUAL_LEG_MAX + 5 }, (_, i) => `${'a'.repeat(3490)}${i}`).join('\n\n');
  assert.equal(manualInMax('keyless', 'readmeFullZh'), TRANS_IN_MAX, '这一条走的是免费档那一档（块长 3,500）');
  const o = mk({ text, engine: 'keyless' });
  const r = await runOf(o, 'translate');
  assert.equal(r.ok, true);
  assert.equal(r.fused, true);
  assert.equal(o.tr.jobs.length, MANUAL_LEG_MAX, `撞闸后翻译发数就是预算本身：${o.tr.jobs.length}`);
  assert.equal(r.legs.out, MANUAL_LEG_MAX);
  assert.ok(r.notes.includes(manualFuseNote(MANUAL_LEG_MAX)), '熔断那句得在，否则屏上少了三分之二篇却没人说');
  assert.ok(r.notes[0].includes('已到熔断上限'), '出网账那句也要跟着换档');
  const segs = r.zh.split('\n\n');
  assert.equal(segs.length, MANUAL_LEG_MAX, '没跑的尾巴不进段：不许出现空占位或半截句子');
  assert.equal(o.tr.jobs[o.tr.jobs.length - 1].text, text.split('\n\n')[MANUAL_LEG_MAX - 1], '跑到的最后一块正是第 40 段');
});

/* ------------------------------------------------------------------ *
 * 5. 整篇摘要：预算先给汇总留一发，汇总没成要说那句实话
 * ------------------------------------------------------------------ */
check('整篇摘要：各块短述 + 末尾那一发汇总；预算先扣 1 发，汇总那一发真发了才算进账', async () => {
  // 摘要那一趟的块长是 9,000（汇总喂的是各块短述拼起来的长文）⇒ 夹具吃 P_LONG，P5 那份只切得出 1 块
  assert.equal(manualInMax('host_llm', 'readmeFullSum'), LLM_IN_MAX_BY_KIND.readmeFullSum, '先把这一趟的块长档位钉住：它和译整篇不是同一档');
  const o = mk({ text: P_LONG });
  const r = await runOf(o, 'summarize');
  assert.equal(r.ok, true);
  assert.equal(o.tr.jobs.length, 4, '3 块短述 + 1 发汇总');
  assert.deepEqual(o.tr.jobs.slice(0, 3).map((j) => j.repo), [`${KEY}#1`, `${KEY}#2`, `${KEY}#3`], '汇总排在各块之后：它是最后一发');
  assert.deepEqual(o.tr.jobs[3].repo, `${KEY}#sum`, '汇总那一发的仓名后缀就是它的身份（在途去重与记账都靠它）');
  assert.equal(r.zh, '汇总过的那一篇', '汇总成了就用那一篇，屏上不许留各块短述拼的东西冒充汇总');
  assert.deepEqual(r.legs, { gh: 1, out: 4 });
  const row = await o.transStore.get('readmeFullSum', KEY.toLowerCase());
  assert.equal(row.zh, '汇总过的那一篇');
  assert.equal(await o.transStore.get('readmeFullZh', KEY.toLowerCase()), null, '摘要写的是**另一行**，不许盖掉译文那一行');
});

check('汇总那一发没成 ⇒ 屏上是各块短述拼的那一份，且那句「不是汇总过的」跟着上屏', async () => {
  const o = mk({ text: P_LONG, trOpts: { failSum: true } });
  const r = await runOf(o, 'summarize');
  assert.equal(r.ok, true);
  assert.ok(r.zh.startsWith('译好的中文1'), '各块短述照给：那一趟没有全失败，只是没汇总成');
  assert.ok(r.notes.includes(manualSumFailNote()), `少了那句就成了假话（屏上是一段短述、说的是摘要）：${JSON.stringify(r.notes)}`);
  assert.equal(r.legs.out, 4, '汇总那一发真出过网（失败也要记账）');
});

check('摘要的预算先给末尾那一发扣位：块数远超预算时，短述跑满 39 块 + 汇总恒轮得到 = 40 发封顶', async () => {
  // 每段 8,990 字（< 摘要档 9,000 ⇒ 一段一块），段数超预算 ⇒ 短述必然撞闸
  const text = Array.from({ length: MANUAL_LEG_MAX + 20 }, (_, i) => `${'b'.repeat(8988)}${i}`).join('\n\n');
  const o = mk({ text });
  const r = await runOf(o, 'summarize');
  assert.equal(r.ok, true);
  assert.equal(o.tr.jobs.length, MANUAL_LEG_MAX, `39 块 + 1 发汇总 = ${MANUAL_LEG_MAX}，少那一发汇总就是没留位`);
  assert.equal(o.tr.jobs[o.tr.jobs.length - 1].repo.endsWith('#sum'), true, '第 40 发是汇总：预算没扣位的话这里会是第 40 块，汇总永远轮不到');
  assert.equal(r.zh, '汇总过的那一篇');
  assert.equal(r.fused, true, '块跑满了预算就是熔断，屏上少了大半篇得有一句说明');
  assert.equal(r.legs.out, MANUAL_LEG_MAX);
  assert.ok(r.notes.includes(manualFuseNote(MANUAL_LEG_MAX - 1)), `熔断那句报的是跑到的**块**数（${MANUAL_LEG_MAX - 1}），汇总那一发另计：${JSON.stringify(r.notes)}`);
});

/* ------------------------------------------------------------------ *
 * 6. 落库那三档：太宽不存、没表不存、写坏要说
 * ------------------------------------------------------------------ */
check('整份超过入库上限 ⇒ **整份不存**（截一半的"已存"是假话），回执那句念得清字数与上限', async () => {
  // 30 段 × 1,702 字（宿主档译整篇块长 1,800 ⇒ 两段装不下 ⇒ 一段一块，恰好 30 发不撞闸）+ 替身把原文直出
  const text = Array.from({ length: 30 }, (_, i) => `${'d'.repeat(1700)}${i}`).join('\n\n');
  const o = mk({ text, trOpts: { zhOf: (t) => t } });
  const r = await runOf(o, 'translate');
  assert.equal(r.ok, true);
  assert.ok(r.zh.length > MANUAL_FULL_ZH_MAX, `夹具没造出超限的那一份：${r.zh.length}`);
  assert.equal(r.stored, false);
  assert.ok(r.notes.includes(manualNotStoredNote(r.zh.length)), `缺那句就成了「已存下来」的假话：${JSON.stringify(r.notes)}`);
  assert.equal((await o.transStore.list()).length, 0, '超限那一整份一个字都不许进库');
});

check('本机没有译文表 ⇒ 那一屏照样给，另加一句「看完就丢」', async () => {
  const noStore = mk({ withStore: false });
  const r1 = await runOf(noStore, 'translate');
  assert.equal(r1.ok, true);
  assert.equal(r1.stored, false);
  assert.ok(r1.notes.includes(manualNoStoreNote()), JSON.stringify(r1.notes));
  assert.equal(r1.zh, `译好的中文1\n\n译好的中文2\n\n译好的中文3`, '没有表不影响屏上那一份：跑出来的字照样交回去');
});

check('写库自己失败 ⇒ 另一句（与「超过入库上限」是两件事），且失败留痕在日志里', async () => {
  const warns = [];
  const o = mk({ logger: { warn: (m) => warns.push(m) } });
  // ★ 只把 put 换成 reject：表还 available（读路径照常走），挡的是写本身 ⇒ 那句必须是「库里那一行没落成」，不是「没有表」
  o.transStore.put = () => Promise.reject(new Error('假设施写不进'));
  const r = await runOf(o, 'translate');
  assert.equal(r.ok, true);
  assert.equal(r.stored, false);
  assert.ok(r.notes.includes(manualStoreFailNote()), `缺那句就成了「已存下来」的假话：${JSON.stringify(r.notes)}`);
  assert.equal(r.notes.includes(manualNoStoreNote()), false, '本机明明有表，那句就成了假话');
  assert.ok(warns.some((m) => m.includes('整篇那一行写库失败')), '失败留痕：真机排障只看得见日志');
  assert.equal((await o.transStore.list()).length, 0);
});

/* ------------------------------------------------------------------ *
 * 7. 载荷那一整格 + 连点
 * ------------------------------------------------------------------ */
check('连点同一枚按钮不发两遍：在途表按 `action:仓库` 去重，另一枚按钮与另一个仓库不受影响', async () => {
  const o = mk();
  const [a, b] = await Promise.all([runOf(o, 'translate'), runOf(o, 'translate')]);
  assert.equal(a, b, '两次点拿到的是同一趟（Promise 同一份）');
  assert.equal(o.fetchFull.calls.length, 1, '第二点不该再问一次 GitHub：那是白扣一次配额');
  assert.equal(o.tr.jobs.length, 3, '分块那 3 发也只跑一遍');
  const c = await runOf(o, 'summarize');
  assert.notEqual(c, a, '另一枚按钮是另一趟');
  assert.equal(o.fetchFull.calls.length, 2);
});

check('载荷里那一整格：挂哪一段 / 正在跑那句 / 三枚按钮 / 那两段，四个子键一次给全，命名统一吃 kind', async () => {
  const o = mk();
  await o.transStore.put({ repo: KEY.toLowerCase(), kind: 'readmeFullSum', src: readmeFingerprint(P5), zh: '库里那一篇摘要', at: AT - 5_000, chars: 7, engine: 'host_llm' });
  const view = { repo: KEY, readmeSource: 'en_default' };
  const p = await o.svc.payload({ view });
  assert.deepEqual(Object.keys(p), ['section', 'runNote', 'actions', 'sections'], '载荷形状少一格客户端就得兜底（那是第二份真相）');
  assert.equal(p.section, MANUAL_ACTIONS_SECTION, '按钮挂哪一段由载荷说，客户端不认段键');
  assert.equal(p.runNote, MANUAL_RUN_NOTE);
  assert.deepEqual(p.actions.map((a) => a.action), MANUAL_ACTIONS, '按钮顺序吃那一份封闭名单');
  assert.deepEqual(p.actions.map((a) => a.kind), MANUAL_ACTIONS.map((x) => MANUAL_ACTION_KIND[x]), '每一枚把自己走哪一路一起给：客户端拿它对上回执，不猜映射');
  assert.deepEqual(p.actions.map((a) => a.label), MANUAL_ACTIONS.map((x) => MANUAL_ACTION_LABELS[x]));
  for (const a of p.actions) assert.equal(typeof a.can, 'boolean') && assert.ok('gate' in a && 'note' in a);
  // 那两段：库里读得到的一份上屏（段名含落款那一截），没有的那一路整段不摆
  assert.equal(p.sections.length, 1);
  assert.equal(p.sections[0].kind, 'readmeFullSum');
  assert.equal(p.sections[0].label, manualSectionTitle('readmeFullSum', engineZhLabel('host_llm', AT - 5_000)),
    '段名是「整篇中文摘要 · 手动跑的 · 模型现译 · 10-..」那一整句：拼句在宿主，客户端拿到什么摆什么');
  assert.equal(p.sections[0].zh, '库里那一篇摘要');
  // 没落库的那一份（回执）只顶替「库里没有」那一路，且按 kind 对号
  const p2 = await o.svc.payload({ view, receipt: { ok: true, kind: 'readmeFullZh', zh: '这一次刚跑的译文', label: engineZhLabel('host_llm', AT), at: AT } });
  assert.deepEqual(p2.sections.map((s) => s.kind), ['readmeFullZh', 'readmeFullSum'], '顺序吃 MANUAL_KINDS（由 MANUAL_ACTIONS 推出），不吃到达顺序');
  assert.equal(p2.sections[0].zh, '这一次刚跑的译文');
  const p3 = await o.svc.payload({ view, receipt: { ok: false, kind: 'readmeFullZh', zh: '' } });
  assert.equal(p3.sections.length, 1, '失败的回执不许被当成那一段摆上屏');
});

check('三枚按钮在宿主档全绿、在免费档那枚摘要灰：置灰那句念得出原因，且载荷与真点下去共用同一个判据', async () => {
  const free = mk({ trOpts: { kinds: ['desc', 'readme', 'readmeFullZh'] } });
  const p = await free.svc.payload({ view: { repo: KEY, readmeSource: 'en_default' } });
  assert.deepEqual(p.actions.map((a) => a.can), [true, true, false], '展开与译整篇点得动，整篇摘要灰着');
  assert.equal(p.actions[2].gate, 'no_sum_capability');
  assert.equal(p.actions[2].note, MANUAL_GATE_NOTES.no_sum_capability);
  // 同一枚按钮真点下去：闸门给同一个 gate，界面上那句"能点"与按下来的结果不许分叉
  const r = await free.svc.run({ name: KEY, action: 'summarize', readmeSource: 'en_default' });
  assert.equal(r.ok, false);
  assert.equal(r.gate, p.actions[2].gate);
  assert.deepEqual(r.notes, [p.actions[2].note]);
  assert.equal(free.fetchFull.calls.length, 0, '置灰的那一枚点下去也压根不该问 GitHub');
});

await runAll('full-readme');
