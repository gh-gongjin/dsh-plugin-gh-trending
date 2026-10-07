/**
 * ============================================================
 * lib/services/llm.js —— 宿主模型句柄在本插件里的**唯一**使用者
 * ============================================================
 *
 * spec §0 第八轮把「零 `ctx.llm`」改判为「**默认零调用**」：
 *   · 句柄只许出现在这一个文件（`host-compat` 的 `hc-8` 按这条判，白名单派生不手抄）；
 *   · 两档开关（`prefs.llmDesc` / `prefs.llmReadme`）：**描述出厂开、摘要出厂关**（10-06 用户裁定），
 *     且只在用户点开详情那一刻按档派活 —— 关着的那一档一次都不发（`test/llm.test.mjs` 用 spy 句柄钉这两头）；
 *   · 发出去的那一发固定 `reasoningEffort:'off'`（实测关思考的唯一入口：思考字符归零、单发 12 token / 0.9s，
 *     读数 `tmp/probe-llm-off.json`；顶层 `thinking` / `reasoning` 适配器不认）。
 *   · `provider` / `model` 现取宿主的 `agentDefaultModel` 那一档：`llm.stream()` **不解析默认档**，
 *     不给 provider 的真机读数是 finish 帧里的 `NO_ADAPTER no adapter registered for provider "undefined"`（10-06），
 *     本插件不另立一份模型选择；库里已命中时压根不取这一档（取它只在真要发一发之前）。
 *
 * 三条从探针病历里带进来的判据，改这个文件时不许退回旧形状：
 *   1. **失败不抛异常**：宿主把错误坐在 `finish` 帧里（`{kind:'error', failure:{code,message}}`）⇒ 判成败看帧，不看有没有 throw。
 *   2. **入参要自证真发出去**：`stats.lastOpts` 留的是交给 `stream()` 的那一份实际对象（标签不算数）。
 *   3. **译文不许指鹿为马**：复用判据 = 主键 + **原文逐字相同**（与 B 的 `desc-zh.js` 同一条律），仓库改了原文就重译。
 *
 * 第九轮（现译引擎可选）对本文件的影响只有一条：`trans` 那张表从"只有模型在写"变成**三档共用**，
 * 所以命中复用时落款要读行里的 `engine`（`engineZhLabel(row.engine, row.at)`），新行也一律带上
 * `engine:'host_llm'` —— 否则免费接口译的那句会在屏上署成「模型现译」，那是指鹿为马的第二种写法。
 * 谁来派活不在这个文件里判：`lib/api.js` 的 `pickTranslator` 按 `prefs.translateEngine` 选路。
 */
import {
  LLM_KINDS, LLM_TIMEOUT_MS, LLM_IN_MAX, LLM_OUT_MAX, LLM_MAX_TOKENS,
  LLM_REASONING_EFFORT, LLM_PROMPTS, LLM_ERROR_LABELS, CJK_RE, llmZhLabel, engineZhLabel,
} from '../domain.js';

/** 喂进去与存下来的原文同一口径（折叠空白）：命中判据的一半，两侧必须用同一个函数。 */
export function transSrcKey(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 帧的 `type` / `kind` 两种写法宿主都见过，取值口径与探针一致（tmp/probe-llm3.lib.mjs）。 */
function frameKind(c) {
  return c?.type ?? c?.kind ?? 'unknown';
}
function frameText(c) {
  return String(c?.text ?? c?.delta?.text ?? '');
}

/**
 * @param ctx       宿主 Context（只用来 `inject(['llm'])`；句柄不外发）
 * @param getPrefs  现取现算的偏好视图（关了就一次都不发）
 * @param transStore 译文表（缺了就只译不存，每次点开重译 —— 不谎报"存下了"）
 */
export function createLlmTranslator({
  ctx, getPrefs = () => ({}), transStore, logger,
  now = () => Date.now(), timeoutMs = LLM_TIMEOUT_MS,
} = {}) {
  let handle = null;
  /** 宿主的「默认模型选择」服务（`agentDefaultModel`）：`llm.stream()` 不自带默认档，`provider` 必须由调用方给。 */
  let modelPicker = null;
  const inflight = new Map();
  /** 诊断读数（用例与真机走查都从这里取，别在界面里再造一份判定）。 */
  const stats = {
    calls: 0, cached: 0, failed: 0,
    lastOpts: null, lastFinish: null, lastUsage: null,
    lastReasoningChars: 0, lastMs: 0, lastFrames: {},
  };

  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['llm', 'agentDefaultModel'], (s) => {
      handle = s && typeof s.llm?.stream === 'function' ? s.llm : null;
      modelPicker = s && typeof s.agentDefaultModel?.currentSelection === 'function' ? s.agentDefaultModel : null;
      if (!handle) logger?.warn?.('[gh-trending] 宿主注入了 llm 但没有 stream，现译按"模型不可用"处理');
    });
  }

  const ready = () => Boolean(handle);

  /**
   * 宿主给的默认模型那一档。返回 `{provider, model}`，缺任何一样就是空串（调用方按档给话，不猜）。
   * ★ 跨边界取值一律当外部输入验：`currentSelection()` 可能抛、可能给非字符串、老宿主可能压根没这个服务。
   */
  function pickModel() {
    if (!modelPicker) return { provider: '', model: '', why: 'unavailable' };
    let sel = null;
    try { sel = modelPicker.currentSelection(); } catch (e) {
      logger?.warn?.(`[gh-trending] 读宿主默认模型失败：${e?.message ?? e}，现译按"没设默认模型"处理`);
      return { provider: '', model: '', why: 'no_model' };
    }
    const provider = typeof sel?.provider === 'string' ? sel.provider : '';
    const model = typeof sel?.model === 'string' ? sel.model : '';
    return { provider, model, why: provider ? '' : 'no_model' };
  }

  /**
   * ★ 第十五轮：这一档**两路都服务** —— `readme` 那一路吃的是摘要提示词（domain 的 `LLM_PROMPTS.readme`），
   *   与只有翻译能力的那四档（`web-translate.js` 的 `SERVED_KINDS`）正好互补。设置页那两行开关照这一格摆。
   */
  const kinds = () => [...LLM_KINDS];

  function enabled(kind) {
    const p = getPrefs() || {};
    return kind === 'readme' ? p.llmReadme === true : p.llmDesc === true;
  }

  /** 真发一发。返回 `{ok:true, zh}` 或 `{ok:false, errKey}`，**不抛**。 */
  async function call(kind, src, model) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const opts = {
      // ★ 这两格必须由我们填：宿主 llm.stream() 不解析默认档，provider 缺省就是 `NO_ADAPTER no adapter registered for provider "undefined"`
      //   （10-06 真机读数），而默认档的权威来源是宿主的 agentDefaultModel 服务，不在本插件里另立一份。
      provider: model.provider,
      model: model.model,
      system: LLM_PROMPTS[kind],
      messages: [{ role: 'user', content: [{ type: 'text', text: src.slice(0, LLM_IN_MAX) }] }],
      temperature: 0,
      maxTokens: LLM_MAX_TOKENS[kind],
      signal: ac.signal,
      reasoningEffort: LLM_REASONING_EFFORT,
    };
    stats.calls += 1;
    // ★ 自证：留的是**实际交给 stream() 的那一份**（探针 v2 的假读数就是从标签里造出来的）
    stats.lastOpts = { ...opts, messages: JSON.parse(JSON.stringify(opts.messages)), signal: 'AbortSignal' };

    const t0 = now();
    let text = '';
    let reasoningChars = 0;
    let failure = null;
    let finish = null;
    const frames = {};
    let threw = null;
    try {
      for await (const c of handle.stream(opts)) {
        const kind2 = frameKind(c);
        frames[kind2] = (frames[kind2] ?? 0) + 1;
        if (kind2 === 'text-delta') text += frameText(c);
        else if (kind2 === 'reasoning-delta') reasoningChars += frameText(c).length;
        else if (kind2 === 'usage') stats.lastUsage = safeJson(c?.usage ?? c);
        else if (kind2 === 'finish') {
          finish = safeJson(c?.reason ?? c?.finishReason ?? c?.value?.reason ?? c);
          const f = c?.failure ?? c?.value?.failure ?? (frameKind(c) === 'error' ? c : null);
          if (f) failure = f;
        }
      }
    } catch (e) {
      threw = e;
    } finally {
      clearTimeout(timer);
      stats.lastMs = now() - t0;
      stats.lastFrames = frames;
      stats.lastReasoningChars = reasoningChars;
      stats.lastFinish = finish;
    }

    if (threw) {
      const timedOut = ac.signal?.aborted === true || threw?.name === 'AbortError';
      stats.failed += 1;
      return { ok: false, errKey: timedOut ? 'timeout' : 'error', errText: String(threw?.message ?? threw).slice(0, 200) };
    }
    // in-band 错误：坐在 finish 帧里，不抛 ⇒ 只用 try/catch 判成败会把失败那发报成成功（探针 v1 的病历）
    if (failure || finish?.kind === 'error' || finish?.failure != null) {
      stats.failed += 1;
      const f = failure ?? finish?.failure ?? {};
      return { ok: false, errKey: 'error', errText: `${f.code ?? ''} ${f.message ?? ''}`.trim().slice(0, 200) };
    }
    const zh = text.trim();
    if (!zh) { stats.failed += 1; return { ok: false, errKey: 'empty' }; }
    if (zh.length > LLM_OUT_MAX) { stats.failed += 1; return { ok: false, errKey: 'too_long' }; }
    // 没汉字就当没译出来：模型回吐英文原文时，宁可显示原文，也不给一句"顶着中文标签的英文"
    if (!(zh.match(CJK_RE) || []).length) { stats.failed += 1; return { ok: false, errKey: 'empty' }; }
    return { ok: true, zh };
  }

  /** 一路现译的返回值形状：`ok:false` 且 `errKey:''` = 压根没有原文（不是失败，界面不给话）。
   *  ★ 第九轮起多带一格 `engine`（这一路永远是 `host_llm`）：三档引擎共用 `trans` 那一张表，
   *    落款与摘要说明都跟着行里的 engine 走，`applyZh` 就靠它认人。 */
  const blank = {
    ok: false, zh: '', cached: false, at: 0, label: '', stored: false, note: '', errKey: '', errText: '', engine: 'host_llm',
  };
  // 失败必须**带着那句话回来**：界面只念 `note`，漏了它就成了「详情里既没译文、也没解释」，
  // 而用户分不清是没开开关、还是宿主压根没给模型。
  const fail = (errKey = '', errText = '') => ({
    ...blank, errKey, errText, note: LLM_ERROR_LABELS[errKey] || '',
  });

  /** 完整闸门：开关 → 句柄 → 表里逐字复用 → 宿主的默认模型档 → 真发一发 → 尽力落库。 */
  async function translate({ repo, kind, text, force = false } = {}) {
    if (!LLM_KINDS.includes(kind)) return fail('error', `未知的现译路数：${kind}`);
    const src = transSrcKey(text);
    if (!src) return fail();
    if (!enabled(kind)) return fail('off');
    if (!handle) return fail('unavailable');

    const key = String(repo ?? '').trim().toLowerCase();
    if (transStore?.available && !force) {
      const row = await transStore.get(kind, key).catch(() => null);
      if (row && row.kind === kind && row.src === src && row.zh) {
        stats.cached += 1;
        // ★ 落款跟着**行里那一档引擎**走：这张表第九轮起三档共用，免费接口译的那句不许署成「模型现译」。
        return {
          ...blank, ok: true, zh: row.zh, cached: true, at: row.at, engine: row.engine ?? 'host_llm',
          label: engineZhLabel(row.engine, row.at), stored: true,
        };
      }
    }

    // ★ 默认模型档在**缓存命中之后**才要：库里已有那句就不碰宿主，也就不该因为"没设默认模型"把复用挡住。
    const model = pickModel();
    if (!model.provider) return fail(model.why === 'unavailable' ? 'unavailable' : 'no_model');

    const flightKey = `${kind}:${key}`;
    if (inflight.has(flightKey)) return inflight.get(flightKey);
    const p = (async () => {
      const r = await call(kind, src, model);
      if (!r.ok) return fail(r.errKey, r.errText);
      const at = now();
      let stored = true;
      if (transStore?.available) {
        await transStore.put({
          repo: key, kind, src, zh: r.zh, at, chars: r.zh.length, engine: 'host_llm',
        })
          .catch((e) => {
            stored = false;
            logger?.warn?.(`[gh-trending] 译文写库失败（${e?.message ?? e}），这次显示完就丢，下次点开重译`);
          });
      } else stored = false;
      return {
        ...blank, ok: true, zh: r.zh, cached: false, at, label: llmZhLabel(at),
        stored, note: stored ? '' : LLM_ERROR_LABELS.store,
      };
    })().finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, p);
    return p;
  }

  return {
    ready,
    kinds,
    enabled,
    translate,
    peek: (k) => (k ? stats[k] : { ...stats }),
    dispose: () => { inflight.clear(); handle = null; },
  };
}

function safeJson(x) {
  try { return JSON.parse(JSON.stringify(x ?? null)); } catch { return String(x ?? '').slice(0, 400); }
}
