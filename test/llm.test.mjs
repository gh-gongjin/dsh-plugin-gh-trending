/**
 * test/llm.test.mjs —— 现译服务（lib/services/llm.js）：闸门顺序、入参自证、帧读法、复用判据、失败口径。
 *
 * ★ 这一套件的假句柄**帧形状逐字照抄真宿主**（`tmp/probe-llm3.lib.mjs` 的读法）：
 *   `block-start / reasoning-delta / block-end / text-delta / usage / finish`，取值 `c.type ?? c.kind`，
 *   文字在 `c.text ?? c.delta.text`。★ 最要紧的一条：**错误不抛异常，坐在 finish 帧里**
 *   （`{type:'finish', kind:'error', failure:{code,message}}`）⇒ 只用 try/catch 判成败会把失败那发报成成功
 *   （探针 v1 的病历：五发"成功"里三发其实是 provider 报错）。
 *
 * ★ 每个用例都断言**假句柄真收到的那一份 opts**，不 assertion 我们以为传出去的东西
 *   （探针 v2 的病历：读数里的 `reasoningEffort` 是从标签抄的，压根没进 opts）。
 */
import { check, runAll, assert, makeFakeFacility } from './_helpers.mjs';
import { createLlmTranslator, transSrcKey } from '../lib/services/llm.js';
import { createTransStore } from '../lib/stores.js';
import {
  LLM_KINDS, LLM_MAX_TOKENS, LLM_IN_MAX, LLM_OUT_MAX, LLM_PROMPTS, LLM_ERROR_LABELS,
  LLM_ERROR_KEYS, LLM_REASONING_EFFORT, DEFAULT_PREFS,
} from '../lib/domain.js';
import { DESC_ZH_ROWS } from '../lib/desc-zh.js';

const DESC_SRC = 'Next generation frontend tooling. It\'s fast!';
const REPO = 'Vitejs/Vite';

/** 帧工厂：形状与真宿主一致（type 写法），要别的形状用例自己改。 */
const text = (t) => ({ type: 'text-delta', text: t });
const done = (reason = { kind: 'stop' }) => ({ type: 'finish', reason });

/**
 * 假句柄：记下**真收到的 opts**，按脚本回帧。
 * `frames(opts)` 给函数时可按入参造帧（超时那一发要看 signal）。
 */
function mkHandle(frames = () => [text('下一代前端构建工具。'), done()], { throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    stream(opts) {
      calls.push(opts);
      if (throwOn) {
        return (async function* () { throw Object.assign(new Error(throwOn.message), { name: throwOn.name ?? 'Error' }); })();
      }
      const list = typeof frames === 'function' ? frames(opts) : frames;
      return (async function* () { for (const f of list) yield f; })();
    },
  };
}

function mkT({ prefs = {}, handle = mkHandle(), store = null, now = () => 1_760_000_000_000, timeoutMs, loggerWarn,
  // ★ 夹具给的是**非默认值**：真宿主的默认档长这样（tmp/probe-llm3.json 的 probed 那一格），
  //   留空的话「provider 到底传没传」在夹具上看不出来。要测缺档自己传 picker。
  model = { provider: 'deepseek-account', model: 'deepseek-flash' }, picker = null } = {}) {
  const facility = makeFakeFacility();
  const warns = loggerWarn ?? [];
  const transStore = store === null ? createTransStore({ getFacility: () => facility, logger: { warn: (m) => warns.push(String(m)) } }) : store;
  const prefsView = { ...DEFAULT_PREFS, llmDesc: false, llmReadme: false, ...prefs };
  const ctx = {
    inject: (deps, cb) => {
      const s = {};
      if (deps.includes('llm')) s.llm = handle;
      if (deps.includes('agentDefaultModel') && picker !== false) s.agentDefaultModel = picker ?? { currentSelection: () => model };
      cb(s);
    },
  };
  const t = createLlmTranslator({
    ctx, getPrefs: () => prefsView, transStore,
    logger: { warn: (m) => warns.push(String(m)) }, now, ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { t, handle, prefsView, facility, transStore, warns, ctx };
}

/* ------------------------------------------------------------------ *
 * 1. 闸门：四道各说各的话，且全部发生在出网之前
 * ------------------------------------------------------------------ */
check('闸门顺序：未知路数 / 没原文 / 开关关 / 宿主没句柄 —— 四档各有各的话，且句柄一次都没被碰', async () => {
  // 三道闸门全在开关之前，所以这一格两个开关都关着测（开着的话前两道一漏就真发出去了）
  const { t, handle } = mkT({ prefs: {} });
  assert.equal((await t.translate({ repo: REPO, kind: 'commit', text: 'x' })).errKey, 'error');
  assert.equal(handle.calls.length, 0, '未知路数不该发出去');

  const blank = await t.translate({ repo: REPO, kind: 'desc', text: '   \n  ' });
  assert.equal(blank.ok, false);
  assert.equal(blank.errKey, '', '压根没原文不是失败，界面不给话（errKey 空 ⇒ note 也空）');
  assert.equal(blank.note, '');

  const off = await t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(off.errKey, 'off');
  assert.equal(off.note, LLM_ERROR_LABELS.off, '失败必须把界面那句话一起带回来，否则屏上既没译文也没解释');
  assert.equal(off.errText, '', '闸门这一档没有 finish 帧 ⇒ 回执必须留空：界面那句「回执：…」只许念宿主真给过的原文，拿 note 顶上去就是自己造回执');
  assert.equal(handle.calls.length, 0, '三道闸门任何一道都没资格碰句柄');

  const noHandle = mkT({ prefs: { llmDesc: true }, handle: null });
  const un = await noHandle.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(un.errKey, 'unavailable');
  assert.equal(un.note, LLM_ERROR_LABELS.unavailable);
  assert.equal(un.errText, '', '同上：没发出去就没有回执');
  assert.equal(noHandle.handle, null);
  assert.equal(noHandle.warns.length, 1, '注入了却没有 stream 时必须 warn 一次（这是"模型不可用"的现场，不是静默降级）');
});

check('★两档显式全关（不是出厂态：描述那档出厂是开的）⇒ spy 句柄零调用，一次都不发', async () => {
  const { t, handle } = mkT({ prefs: { llmDesc: false, llmReadme: false } });
  for (const kind of LLM_KINDS) {
    for (let i = 0; i < 3; i += 1) {
      const r = await t.translate({ repo: `${REPO}${i}`, kind, text: DESC_SRC });
      assert.equal(r.errKey, 'off');
    }
  }
  assert.equal(handle.calls.length, 0, `开关关着却发了 ${handle.calls.length} 发（铁律：句柄不开口）`);
  assert.equal(t.peek('calls'), 0);
  // 证伪这一条：开着就必须发得出（否则上面那个 0 是"压根没接线"的假绿）
  const on = mkT({ prefs: { llmDesc: true } });
  assert.equal((await on.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC })).ok, true);
  assert.equal(on.handle.calls.length, 1, '开关开着却一发都没发 ⇒ 上面那个零调用没有证伪力');
});

/* ------------------------------------------------------------------ *
 * 2. 入参自证：假句柄真收到的那一份
 * ------------------------------------------------------------------ */
check('发出去的那一发：关思考 / temperature 0 / 两档各自 maxTokens / 原文截断，全部从 opts 上读回来', async () => {
  const desc = mkT({ prefs: { llmDesc: true } });
  await desc.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  const o = desc.handle.calls[0];
  assert.equal(o.reasoningEffort, LLM_REASONING_EFFORT, '实测只有这一个槽位能关掉思考（顶层 thinking/reasoning 适配器不认）');
  assert.equal(o.temperature, 0);
  assert.equal(o.maxTokens, LLM_MAX_TOKENS.desc);
  assert.equal(o.system, LLM_PROMPTS.desc);
  assert.equal(o.messages.length, 1);
  assert.deepEqual(Object.keys(o.messages[0]), ['role', 'content']);
  assert.deepEqual(o.messages[0].content[0], { type: 'text', text: DESC_SRC });
  assert.equal(typeof o.signal?.aborted, 'boolean', '必须带 AbortSignal 出去，否则超时那一发收不回来');
  // ★ 10-06 改判：这一条原来钉的是「不点名 provider：用宿主默认那一个」，而真机读数把这句打死了 ——
  //   `llm.stream()` 不解析默认档，provider 缺省时 finish 帧给的是 `NO_ADAPTER no adapter registered for provider "undefined"`。
  //   默认档的权威来源是宿主的 agentDefaultModel 服务，所以我们**现取它**再填进 opts（不在插件里另立一份模型选择）。
  assert.equal(o.provider, 'deepseek-account', 'provider 必须是从宿主那一档现取的');
  assert.equal(o.model, 'deepseek-flash', 'model 同上：给不到就压根不发（见「没设默认模型」那一条）');

  const rd = mkT({ prefs: { llmReadme: true } });
  await rd.t.translate({ repo: REPO, kind: 'readme', text: 'x'.repeat(LLM_IN_MAX + 500) });
  const r = rd.handle.calls[0];
  assert.equal(r.maxTokens, LLM_MAX_TOKENS.readme);
  assert.equal(r.messages[0].content[0].text.length, LLM_IN_MAX, '超长原文要在发出去之前截断');
  assert.equal(r.system, LLM_PROMPTS.readme);

  // 自证那一格：留的是**实际交给 stream() 的**，不是事后造的标签
  assert.equal(desc.t.peek('lastOpts').reasoningEffort, 'off');
  assert.equal(desc.t.peek('lastOpts').messages[0].content[0].text, DESC_SRC);
});

check('transSrcKey：折叠空白 + 去首尾，喂进去的和存下来的同一口径', () => {
  assert.equal(transSrcKey('  a\n\t b  '), 'a b');
  assert.equal(transSrcKey(undefined), '');
  assert.equal(transSrcKey(123), '123', '非字符串也走同一个函数（界面传来的可能是别的形状，不在两处各写一份清洗）');
});

/* ------------------------------------------------------------------ *
 * 3. 帧的读法：成败看帧，不看有没有 throw
 * ------------------------------------------------------------------ */
check('in-band 错误：finish 帧里坐着的 failure 不抛异常，但必须判成失败并给那一句', async () => {
  for (const shape of [
    { type: 'finish', kind: 'error', failure: { code: 'provider_error', message: 'quota exceeded' } },
    { type: 'finish', reason: { kind: 'error' }, failure: { code: 'x', message: 'y' } },
    { type: 'finish', value: { failure: { code: 'z', message: 'boom' } } },
  ]) {
    const h = mkHandle([{ type: 'block-start' }, shape]);
    const { t } = mkT({ prefs: { llmDesc: true }, handle: h });
    const r = await t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
    assert.equal(r.ok, false, `这一种 in-band 形状被判成了成功：${JSON.stringify(shape)}`);
    assert.equal(r.errKey, 'error');
    assert.equal(r.note, LLM_ERROR_LABELS.error);
    assert.ok(r.errText, '回执原文必须带回来：那句 note 说的是「finish 帧里给的回执」，界面拿不到它就是念了一句没有内容的话');
    assert.equal(h.calls.length, 1);
  }
});

check('真抛异常的两种：AbortError ⇒ 超时那一句，其它 ⇒ 答错了那一句', async () => {
  const abort = mkT({ prefs: { llmDesc: true }, handle: mkHandle(null, { throwOn: { name: 'AbortError', message: 'aborted' } }) });
  const a = await abort.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(a.errKey, 'timeout');
  assert.equal(a.note, LLM_ERROR_LABELS.timeout);

  const boom = mkT({ prefs: { llmDesc: true }, handle: mkHandle(null, { throwOn: { message: 'stream broke' } }) });
  const b = await boom.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(b.errKey, 'error');
  assert.match(b.errText, /stream broke/);
});

check('★超时那一发：定时器真的响了（不是我们把异常圆成超时）', async () => {
  // 句柄肯配合 signal：等过超时点后自己看 aborted ⇒ 抛 AbortError。
  // 这条钉的是"那个 setTimeout 回调被真调了一次"（交出去的回调不许只登记不响）。
  const handle = {
    calls: [],
    stream(opts) {
      handle.calls.push(opts);
      return (async function* () {
        await new Promise((r) => setTimeout(r, 60));
        if (opts.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
        yield text('太晚了，不算');
      })();
    },
  };
  const { t } = mkT({ prefs: { llmDesc: true }, handle, timeoutMs: 20, now: () => Date.now() });
  const r = await t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(r.errKey, 'timeout', `20ms 超时没拦住这一发（拿到的是 ${JSON.stringify(r)}）`);
  assert.equal(handle.calls.length, 1);
  assert.ok(t.peek('lastMs') >= 20, `lastMs=${t.peek('lastMs')} 说明定时器压根没响，那句"超时"是白给的`);
});

check('译文质量三道闸门：空 / 没汉字 / 超长 ⇒ 全部原文照给，且各说各的', async () => {
  const cases = [
    [[text('   '), done()], 'empty'],
    [[text('Next generation frontend tooling.'), done()], 'empty'],   // 回吐英文 ⇒ 宁可显示原文，也不给一句顶着中文标签的英文
    [[text('字'.repeat(LLM_OUT_MAX + 1)), done()], 'too_long'],
  ];
  for (const [frames, want] of cases) {
    const { t } = mkT({ prefs: { llmDesc: true }, handle: mkHandle(frames) });
    const r = await t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
    assert.equal(r.errKey, want, `帧脚本 ${JSON.stringify(frames)} 应判 ${want}，实际 ${r.errKey}`);
    assert.equal(r.ok, false);
    assert.equal(r.note, LLM_ERROR_LABELS[want]);
    assert.ok(LLM_ERROR_KEYS.includes(want));
  }
  // 边界：正好 LLM_OUT_MAX 收下，多一个字拒收
  const edge = mkT({ prefs: { llmDesc: true }, handle: mkHandle([text('字'.repeat(LLM_OUT_MAX)), done()]) });
  assert.equal((await edge.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC })).ok, true);
});

check('分片累加：text-delta 拆成几段拼成一句，delta.text 写法也认；reasoning 只计数不上屏', async () => {
  const frames = [
    { type: 'block-start' },
    { type: 'reasoning-delta', text: '先想一下这句话怎么说' },
    { type: 'block-end' },
    { type: 'text-delta', delta: { text: '下一代前端' } },
    { type: 'text-delta', text: '构建工具。' },
    { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } },
    done(),
  ];
  const { t } = mkT({ prefs: { llmDesc: true }, handle: mkHandle(frames) });
  const r = await t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(r.zh, '下一代前端构建工具。');
  assert.equal(t.peek('lastReasoningChars'), 10, '思考字符要数得出来：实测关思考后这一格必须是 0');
  assert.deepEqual(t.peek('lastFrames'), { 'block-start': 1, 'reasoning-delta': 1, 'block-end': 1, 'text-delta': 2, usage: 1, finish: 1 });
  assert.deepEqual(t.peek('lastUsage'), { inputTokens: 40, outputTokens: 12 });
});

/* ------------------------------------------------------------------ *
 * 4. 复用判据：主键 + 原文逐字
 * ------------------------------------------------------------------ */
check('逐字复用：空白折叠后相同 ⇒ 不再发；原文改一个字 ⇒ 重译（仓库改了描述不许顶着旧译文）', async () => {
  const facility = makeFakeFacility();
  const store = createTransStore({ getFacility: () => facility });
  const first = mkT({ prefs: { llmDesc: true }, store });
  const a = await first.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(a.ok, true);
  assert.equal(a.cached, false);
  assert.equal(a.stored, true);
  assert.equal(first.handle.calls.length, 1);

  const second = mkT({ prefs: { llmDesc: true }, store });
  const b = await second.t.translate({ repo: REPO, kind: 'desc', text: `  ${DESC_SRC.replace('.', '.\n ')}  ` });
  assert.equal(b.cached, true, '同样的原文换了换行/空格必须复用（两侧共用 transSrcKey 这一个口径）');
  assert.equal(b.zh, a.zh);
  assert.equal(second.handle.calls.length, 0, `复用没生效，又发了一发`);
  assert.match(b.label, /^模型现译 · \d\d-\d\d \d\d:\d\d$/, '标签带的是**当初那次翻译**的时刻，复用不能谎报成刚译的');

  const changed = mkT({ prefs: { llmDesc: true }, store });
  const c = await changed.t.translate({ repo: REPO, kind: 'desc', text: `${DESC_SRC} (new)` });
  assert.equal(c.cached, false, '原文改过一个字就要重译');
  assert.equal(changed.handle.calls.length, 1);

  // 大小写：主键统一小写，两种写法命中同一行（与详情缓存同一条律）；同一行只留最新那次翻译
  const other = mkT({ prefs: { llmDesc: true }, store });
  const d = await other.t.translate({ repo: 'vitejs/vite', kind: 'desc', text: DESC_SRC });
  assert.equal(d.cached, false, '库里那一行的原文已经带上 (new) 了 ⇒ 逐字判据必须当没命中');
  assert.equal(other.handle.calls.length, 1);
});

check('★宿主的默认模型那一档：没给/给空/读它抛 ⇒ 各说各的话，且句柄一次都没被碰；库里已有译文时不取这一档', async () => {
  // 这一条是 10-06 真机读数带回来的：provider 缺省 ⇒ finish 帧 `NO_ADAPTER no adapter registered for provider "undefined"`，
  // 而离线夹具那边「不点名 provider」的旧断言恰好把它盖成了绿的。默认档只能现取，取不到就不发。
  const noService = mkT({ prefs: { llmDesc: true }, picker: false });
  const un = await noService.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(un.errKey, 'unavailable', '老宿主没有 agentDefaultModel 这个服务 ⇒ 说的是"没给模型服务"那一句');
  assert.equal(un.note, LLM_ERROR_LABELS.unavailable);
  assert.equal(noService.handle.calls.length, 0, '取不到默认档却把裸 opts 发出去了');

  const emptySel = mkT({ prefs: { llmDesc: true }, picker: { currentSelection: () => ({ provider: '', model: '' }) } });
  const nm = await emptySel.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(nm.errKey, 'no_model');
  assert.equal(nm.note, LLM_ERROR_LABELS.no_model, '这句得跟"没给模型服务"区分开：一个是要用户去宿主设置里选模型，一个是宿主没接');
  assert.equal(emptySel.handle.calls.length, 0);

  const boomSel = mkT({ prefs: { llmDesc: true }, picker: { currentSelection: () => { throw new Error('config 读不动'); } } });
  const thrown = await boomSel.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(thrown.errKey, 'no_model', '读那一档抛了也不能把整条详情打挂，按没设默认档给话');
  assert.ok(boomSel.warns.some((w) => w.includes('config 读不动')), '抛了要留一条 warn，不许静默降级');
  assert.equal(boomSel.handle.calls.length, 0);

  // 库里已命中 ⇒ 这一档压根不该被读（复用不花宿主的模型）
  const facility = makeFakeFacility();
  const store = createTransStore({ getFacility: () => facility });
  const seed = mkT({ prefs: { llmDesc: true }, store });
  await seed.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  let picked = 0;
  const reuse = mkT({ prefs: { llmDesc: true }, store, picker: { currentSelection: () => { picked += 1; return { provider: '', model: '' }; } } });
  const hit = await reuse.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(hit.ok, true, '库里那句必须照常上屏，不该因为"没设默认模型"被挡');
  assert.equal(hit.cached, true);
  assert.equal(picked, 0, '命中复用却去读了默认档 ⇒ 取它的位置放错了（应在缓存判定之后）');
});

check('两档各存一行：desc 与 readme 不许互相盖（同一仓库、不同用途）', async () => {
  const facility = makeFakeFacility();
  const store = createTransStore({ getFacility: () => facility });
  const first = mkT({ prefs: { llmDesc: true, llmReadme: true }, store, handle: mkHandle([text('一句描述'), done()]) });
  await first.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  const second = mkT({ prefs: { llmDesc: true, llmReadme: true }, store, handle: mkHandle([text('一段摘要'), done()]) });
  await second.t.translate({ repo: REPO, kind: 'readme', text: DESC_SRC });
  assert.equal(facility.rowCount('gh_trending', 'trans'), 2);
  assert.equal((await store.get('desc', 'vitejs/vite')).zh, '一句描述');
  assert.equal((await store.get('readme', 'vitejs/vite')).zh, '一段摘要');
});

check('force（重新取一次）绕开逐字复用：照样发，且新译文盖掉老的', async () => {
  const store = createTransStore({ getFacility: () => makeFakeFacility() });
  const t1 = mkT({ prefs: { llmDesc: true }, store, handle: mkHandle([text('第一次的译文'), done()]) });
  await t1.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  const t2 = mkT({ prefs: { llmDesc: true }, store, handle: mkHandle([text('第二次的译文'), done()]) });
  const r = await t2.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC, force: true });
  assert.equal(t2.handle.calls.length, 1, '用户点「重新取一次」就是要新答案，译文缓存得一起绕开');
  assert.equal(r.cached, false);
  assert.equal(r.zh, '第二次的译文');
  assert.equal((await store.get('desc', 'vitejs/vite')).zh, '第二次的译文');
});

check('在途去重：同一发没回来时并发只走一次', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const handle = {
    calls: [],
    stream(opts) {
      handle.calls.push(opts);
      return (async function* () { await gate; yield text('一句描述'); yield done(); })();
    },
  };
  const { t } = mkT({ prefs: { llmDesc: true }, handle });
  const p = [t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC }), t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC })];
  release();
  const [x, y] = await Promise.all(p);
  assert.equal(handle.calls.length, 1, `在途没去重，发了 ${handle.calls.length} 发`);
  assert.equal(x.zh, y.zh);
});

/* ------------------------------------------------------------------ *
 * 5. 落库失败：诚实说"这次没存下"，但译文照给
 * ------------------------------------------------------------------ */
check('译文写不进去（存储坏了）：照样给译文，另加一句「这次显示完就丢」', async () => {
  const dead = {
    available: false,
    get: async () => { throw new Error('UNAVAILABLE'); },
    put: async () => { throw new Error('UNAVAILABLE'); },
  };
  const { t, handle } = mkT({ prefs: { llmDesc: true }, store: dead });
  const r = await t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(r.ok, true, '存不下来不是"没译出来"，那句中文该给还是要给');
  assert.equal(r.zh, '下一代前端构建工具。');
  assert.equal(r.stored, false);
  assert.equal(r.note, LLM_ERROR_LABELS.store);
  assert.equal(handle.calls.length, 1, '库读不了也不该挡出网那一发');
});

check('落库脏行（换过版本的旧表）：按未命中重译，不拿脏行当译文上屏', async () => {
  const facility = makeFakeFacility();
  const store = createTransStore({ getFacility: () => facility, logger: { warn: () => {} } });
  await store.get('desc', 'x/y');   // 先把域 open 起来：seed 是往"已打开的域"里塞脏行，模拟上一版留下的库
  facility.seed('gh_trending', 'trans', 'desc:vitejs/vite', { repo: 'vitejs/vite', kind: 'desc', src: '完全不同的原文', zh: '上一轮的旧译文', at: 1 });
  const { t, handle } = mkT({ prefs: { llmDesc: true }, store });
  const r = await t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  assert.equal(handle.calls.length, 1);
  assert.equal(r.zh, '下一代前端构建工具。');
  assert.equal(r.cached, false);
});

/* ------------------------------------------------------------------ *
 * 6. 生命周期与就绪位
 * ------------------------------------------------------------------ */
check('ready 只说"宿主给没给能 stream 的句柄"；dispose 之后立刻变 false 且不再发', async () => {
  const on = mkT({ prefs: { llmDesc: true } });
  assert.equal(on.t.ready(), true);
  await on.t.translate({ repo: REPO, kind: 'desc', text: DESC_SRC });
  on.t.dispose();
  assert.equal(on.t.ready(), false);
  const after = await on.t.translate({ repo: 'other/repo', kind: 'desc', text: DESC_SRC });
  assert.equal(after.errKey, 'unavailable');
  assert.equal(on.handle.calls.length, 1, 'dispose 之后又发了一发');

  const bogus = mkT({ prefs: { llmDesc: true }, handle: { listModels: () => [] } });
  assert.equal(bogus.t.ready(), false, '注入了 llm 但没有 stream ⇒ 按没给处理，别到真发那一发才炸');
});

check('kinds()：这一档两路都 serve ⇒ 设置页那两行开关都摆（与只有翻译能力那四档的 kinds() 相对，见 web-translate 的 wt-28）', () => {
  const on = mkT({ prefs: { llmDesc: true, llmReadme: true } });
  assert.deepEqual(on.t.kinds(), LLM_KINDS, '摘要这一路只有这一档能做（提示词是"整理成一段简体中文摘要"）');
  assert.equal(on.t.enabled('readme'), true, '声明了能力不等于自动开：开关仍照库里那份');
});

check('判据自证：DESC_ZH_ROWS 那一行永远不会被本套件当成"模型译过的"', async () => {
  // B 与 C 的主键形状相同（小写 owner/name），所以复用表里混进内置表的行是真风险
  const [key, src] = DESC_ZH_ROWS[0];
  const { t, handle } = mkT({ prefs: { llmDesc: true } });
  const r = await t.translate({ repo: key, kind: 'desc', text: src });
  assert.equal(r.ok, true);
  assert.equal(handle.calls.length, 1, '现译层不该因为"内置表里有这句"就自己决定不发 —— 那是 api 那一层的 B 优先闸门');
});

await runAll('llm');
