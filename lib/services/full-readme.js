/**
 * 详情弹框那三枚手动按钮的编排（第二十八轮，spec §8.11）。
 *
 * 这个文件只做四件事：**取整篇 → 判能不能点 → 分块跑完 → 按「主键 + 指纹」落一行**。
 * 句子与数字全在 `lib/domain.js`（客户端不数发数、不拼句、不判档，这里也不另写一份），
 * 令牌与本文件的 `fetchFull` 无关 —— 那一发由 `lib/services/repo.js` 的闭包造好递进来（hc-21：认得 `ghToken` 键名的文件恰好三处）。
 *
 * ★ 三条容易写歪的：
 *  · 展开那一发**不带验证器**：带着 `etagReadme` 去问就是大概率换回 304，而 304 的正文是 0 字节 ⇒ 屏上展不开。
 *  · 分块发**不进 `trans` 表**（`persist:false`）：一块的译文不是最终答案，写进去就是拿 27 行挤掉榜面那两路的复用行
 *    （`TRANS_MAX` 只有 200 行）。整趟只落**一行**，`src` 存的是整篇指纹。
 *  · 手动绕的是设置页那两个开关，**不绕就绪态**：缺凭据 / 宿主没给模型 / 这一档没这能力 ⇒ 照样挡，而且三种原因三句话。
 */
import { createHash } from 'node:crypto';
import {
  MANUAL_ACTIONS, MANUAL_ACTION_KIND, MANUAL_ACTION_LABELS, MANUAL_GATE_NOTES, MANUAL_ACTION_HINTS,
  MANUAL_KINDS, MANUAL_ACTIONS_SECTION, MANUAL_RUN_NOTE,
  MANUAL_CONCURRENCY, MANUAL_LEG_MAX, MANUAL_FULL_ZH_MAX,
  manualInMax, manualLegsNote, manualFuseNote, manualCachedNote, manualBlockFailNote,
  manualBlockFailCountNote, manualSumFailNote, manualNoStoreNote, manualStoreFailNote,
  manualNotStoredNote, manualExpandedMeta, manualFailNote, manualSectionTitle,
  TRANSLATE_ENGINE_LABELS, engineZhLabel,
} from '../domain.js';
import { normalizeRepoKey } from './repo.js';
import { transSrcKey } from './llm.js';

/** 中文那两档（默认篇整篇就是中文 / 已抓到仓库另写的那份中文篇）⇒ 手动那两枚置灰；`zh_section` 不算 —— 整篇仍是英文。 */
const ZH_DOC_SOURCES = ['zh_default', 'zh_file'];

/**
 * 那一趟没跑成的返回形状：句子只有 `manualFailNote` 一份（客户端念 `notes` 就够，不许自己拼「这一趟没跑成：」+ 认不出的 errKey）。
 * `legs` 默认零发 —— 闸门挡掉 / 名字坏了 / action 越界的那些压根没出发。
 */
const failOf = (action, { errKey, errText, legs = { gh: 0, out: 0 }, fused = false }) => ({
  ok: false, action, errKey, errText, legs, fused, notes: [manualFailNote(errKey, errText)],
});

/**
 * 整篇指纹（spec §8.11 第 ④ 条）：`sha256(折叠空白后的整篇) 前 16 位十六进制 + ':' + 字数`。
 * ★ 喂 `transSrcKey` 而不是原文：那正是两路服务比对 `src` 用的同一个函数（命中判据的一半，两侧必须同一口径）。
 * ★ 存指纹不存整篇：判据「主键 + `src` 逐字相同」一个字不改，只是比对的从 48K 字变成 25 字符。
 */
export function readmeFingerprint(text) {
  const norm = transSrcKey(text);
  const hash = createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16);
  return `${hash}:${norm.length}`;
}

/** 硬切点：预算内**最靠后**的句子结束符（中英两种都认）；离句末太远（不到预算六成）就直接切在预算处 —— 否则一块只剩三个字符，发数会炸。 */
function sentenceCut(s, max) {
  const window = s.slice(0, max);
  let best = -1;
  for (const ch of '.!?。！？') {
    const i = window.lastIndexOf(ch);
    if (i > best) best = i;
  }
  return best >= max * 0.6 ? best + 1 : max;
}

/**
 * 段落边界分块（spec §8.11 第 ⑦ 条）：累加到 ≤ `inMax`，只在**单段超限**时才硬切。
 * ★ 上限由调用方按当前那一档给（`manualInMax`）：免费四档 3,500 字、宿主档 1,800 字 ⇒ 同一篇的块数与发数都不一样。
 * @returns 非空字符串数组，拼回时按原序、块间空行
 */
export function chunkParagraphs(text, inMax) {
  if (!Number.isFinite(inMax) || inMax <= 0) return [];
  const paras = String(text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const para of paras) {
    if (para.length > inMax) {
      flush();
      let rest = para;
      while (rest.length > inMax) {
        const cut = sentenceCut(rest, inMax);
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (!rest) continue;
      buf = rest;
      continue;
    }
    const next = buf ? `${buf}\n\n${para}` : para;
    if (next.length > inMax) { flush(); buf = para; } else buf = next;
  }
  flush();
  return out.filter(Boolean);
}

/**
 * 这一枚按钮现在**能不能点**，不能点时那一句是什么。
 * ★★ 载荷装配与真点下去时（`run`）**共用这一个函数**：两份判据迟早漂移，界面上"能点"而按下去报错就是那类事故。
 * @param tr   当前那一路的现译服务（`pickTranslator` 给的，可能没有）
 * @param kind `readmeFullZh` / `readmeFullSum`（`expand` 传空串：它不派翻译，只吃有没有原文）
 * @param view 详情载荷（读 `readmeSource`）
 */
export function manualGateOf(tr, kind, view = {}) {
  const action = kind === 'readmeFullZh' ? 'translate' : kind === 'readmeFullSum' ? 'summarize' : 'expand';
  const src = String(view?.readmeSource ?? '');
  const off = (gate) => ({ can: false, gate, note: MANUAL_GATE_NOTES[gate] });
  if (!src || src === 'none') return off('no_readme');
  if (kind && ZH_DOC_SOURCES.includes(src)) return off('already_zh');
  if (!kind) return { can: true, gate: '', note: MANUAL_ACTION_HINTS.expand };
  // ★ 「选不出引擎」排在能力位**之前**：`tr` 为空时 `kinds()` 拿不到任何一路，先问能力就会把「压根没装配现译」
  //   念成「这一档只会翻译，不会摘要」—— 那是两句不同的话，用户按后一句去换档，而现场缺的是另一样东西。
  if (!tr) return off('not_ready');
  const served = Array.isArray(tr.kinds?.()) ? tr.kinds() : [];
  if (!served.includes(kind)) return off('no_sum_capability');
  const ready = tr.ready?.() !== false && tr.enabled?.(kind) !== false;
  if (!ready) return off('not_ready');
  return { can: true, gate: '', note: MANUAL_ACTION_HINTS[action] };
}

/**
 * @param fetchFull  `(name, {path}) => {ok, text, chars, rawChars, ...}` —— 装配层从 `repoService.fullReadme` 绑好的那一发（令牌在它里面）
 * @param getTranslator 当前那一路的现译服务（与榜面补译同一个人给的）
 * @param getEngine  当前档位名（算块长上限与那句"谁花的钱"；装配层用 `translateEngineOf(prefs)` 给）
 * @param transStore 整趟结果那**一行**的家（`kind:小写仓库`，`src` 存指纹）
 */
export function createFullReadmeService({
  fetchFull, getTranslator, getEngine = () => 'keyless', transStore, logger, now = () => Date.now(),
} = {}) {
  /** 同一枚按钮的连点不发两遍（进程内在途表，与榜面补译、详情 `load` 同一条律；不落库 —— 它活不过重启，也不该活过）。 */
  const inflight = new Map();

  async function readRow(kind, key) {
    if (!transStore?.available || !kind) return null;
    const row = await transStore.get(kind, key).catch((e) => {
      logger?.warn?.(`[gh-trending] 读整篇那一路的译文行失败（${e?.message ?? e}），这一屏按「还没有那一段」给`);
      return null;
    });
    if (!row || row.kind !== kind || !row.zh) return null;
    return {
      zh: row.zh, at: row.at, chars: Number(row.chars) || row.zh.length,
      engine: row.engine ?? '', label: engineZhLabel(row.engine ?? 'host_llm', row.at),
      src: row.src ?? '',
    };
  }

  /**
   * 并发 `MANUAL_CONCURRENCY` 跑完所有块（★ `persist:false`：一块的译文不进表）。
   * 熔断按**已发的翻译发**计（GitHub 那一发不算进来），摘要那一趟要给末尾的汇总留一发 ⇒ 预算先减 1。
   */
  async function runBlocks({ tr, kind, blocks, key, budget }) {
    const parts = new Array(blocks.length).fill(null);
    const failed = [];
    let next = 0;
    let sent = 0;
    let fused = false;
    const worker = async () => {
      for (;;) {
        if (sent >= budget) { fused = true; return; }
        const i = next;
        next += 1;
        if (i >= blocks.length) return;
        sent += 1;
        const r = await tr.translate({ repo: `${key}#${i + 1}`, kind, text: blocks[i], persist: false }).catch((e) => {
          logger?.warn?.(`[gh-trending] 第 ${i + 1} 块抛错（${e?.message ?? e}），这一块留原文占位`);
          return { ok: false, errText: String(e?.message ?? e) };
        });
        if (r.ok) parts[i] = r.zh;
        else {
          parts[i] = blocks[i];
          failed.push({ idx: i + 1, chars: blocks[i].length, errText: r.errText || r.note || '' });
        }
      }
    };
    const lanes = Math.max(1, Math.min(MANUAL_CONCURRENCY, blocks.length));
    await Promise.all(Array.from({ length: lanes }, worker));
    return { parts, failed, sent, fused };
  }

  /** 按序拼回：失败那块**原位留原文** + 一句「第 k 块没译出来」；熔断之后没跑的块不进这一段（那句由熔断的话来说）。 */
  function joinBlocks(blocks, parts, failed, fused) {
    const failedSet = new Set(failed.map((f) => f.idx));
    // 没跑的块总是**一段连续尾巴**（工人在同一个游标上取号），所以第一个空格之后就是断点。
    const stopAt = fused ? parts.findIndex((p) => p == null) : -1;
    const segs = [];
    for (let i = 0; i < blocks.length; i++) {
      if (parts[i] == null) continue;
      if (stopAt >= 0 && i >= stopAt) continue;
      segs.push(failedSet.has(i + 1)
        ? `${parts[i]}\n（${manualBlockFailNote(i + 1, blocks[i].length)}）`
        : parts[i]);
    }
    return segs.join('\n\n');
  }

  /**
   * 跑一趟。`{name, path, action, readmeSource}` 由装配层从详情载荷给（客户端不发裸串：这一趟要花钱）。
   * 返回形状（全给到界面能直接念的程度）：
   * `{ok, action, legs:{gh,out}, notes[], cached?, zh?, expanded?, stored?, at?, label?, engine?, gate?, errKey?, errText?}`
   */
  async function run({ name, path = '', action = '', readmeSource = '' } = {}) {
    if (!MANUAL_ACTIONS.includes(action)) {
      return failOf(action, { errKey: 'bad_action', errText: `只认 ${MANUAL_ACTIONS.join(' | ')}，收到 ${JSON.stringify(action)}` });
    }
    const norm = normalizeRepoKey(name);
    if (!norm.ok) return failOf(action, { errKey: 'bad_key', errText: norm.reason });
    const view = { readmeSource };
    const kind = MANUAL_ACTION_KIND[action];
    const tr = kind ? (getTranslator?.() ?? null) : null;
    const gate = manualGateOf(tr, kind, view);
    if (!gate.can) return { ok: false, action, gate: gate.gate, note: gate.note, notes: [gate.note], legs: { gh: 0, out: 0 } };

    const flightKey = `${action}:${norm.key}`;
    if (inflight.has(flightKey)) return inflight.get(flightKey);
    const p = runOnce({ name: norm.key, path, action, kind, tr }).finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, p);
    return p;
  }

  async function runOnce({ name, path, action, kind, tr }) {
    const full = await fetchFull(name, { path });
    if (!full?.ok) return failOf(action, { errKey: full?.errKey || 'transport', errText: full?.errText || '', legs: { gh: 1, out: 0 } });
    if (action === 'expand') {
      const meta = manualExpandedMeta(full.rawChars);
      return {
        ok: true, action: 'expand', text: full.text, chars: full.chars, rawChars: full.rawChars, meta,
        // ★ 展开换掉的是那**两块**（节选框 + 那句元数据），换什么字由这里给：客户端按 `kind` 对齐覆盖，不自己判"这一段该显示什么"。
        blocks: [{ kind: 'excerpt', text: full.text }, { kind: 'num', text: meta }],
        legs: { gh: 1, out: 0 }, notes: [],
      };
    }

    const engine = getEngine();
    const who = TRANSLATE_ENGINE_LABELS[engine] || engine;
    const fp = readmeFingerprint(full.text);
    const key = name.toLowerCase();
    const old = await readRow(kind, key);
    // ★ 命中判据与两路服务逐字同一条：**主键 + `src` 相同**才复用，比的是整篇指纹而不是时刻。
    if (old && old.src === fp) {
      return {
        ok: true, action, kind, zh: old.zh, at: old.at, label: old.label, engine: old.engine,
        cached: true, stored: true, legs: { gh: 1, out: 0 }, notes: [manualCachedNote()],
      };
    }

    const inMax = manualInMax(engine, kind);
    const blocks = chunkParagraphs(full.text, inMax);
    if (!blocks.length) {
      return failOf(action, { errKey: 'parse', errText: '整篇去掉标记以后切不出块', legs: { gh: 1, out: 0 } });
    }
    // 摘要那一趟末尾还要发一发汇总：预算先扣掉它，否则第 40 发永远轮不到汇总，屏上就只有 N 段短述没有那一篇摘要。
    const budget = kind === 'readmeFullSum' ? MANUAL_LEG_MAX - 1 : MANUAL_LEG_MAX;
    const done = await runBlocks({ tr, kind, blocks, key, budget });
    let zh = joinBlocks(blocks, done.parts, done.failed, done.fused);
    let out = done.sent;
    const notes = [];
    let fused = done.fused;
    let sumFailed = false;

    if (kind === 'readmeFullSum') {
      const briefs = done.parts.filter((p) => typeof p === 'string' && p).join('\n\n');
      // ★ 那一发的位子是在预算里**先扣出来的**（上面 `MANUAL_LEG_MAX - 1`）⇒ 块最多跑 39 发，汇总这一发恒轮得到，
      //   总发数也恒不越上限。原来那句 `if (room)` 挡的是"压根没轮到"那一档：按扣过位的预算算它跑不到，
      //   留着它反而让「汇总没成」与「没轮到」在屏上共享同一句熔断话 —— 撤掉死分支，两句话各自归位。
      out += 1;
      const sum = await tr.translate({ repo: `${key}#sum`, kind, text: briefs, persist: false })
        .catch((e) => { logger?.warn?.(`[gh-trending] 汇总那一发抛错（${e?.message ?? e}）`); return null; });
      if (sum?.ok) zh = sum.zh;
      else sumFailed = true;    // 发出去了但没成 ⇒ 屏上是各块短述拼的那一份，那句实话由 `manualSumFailNote` 来说
    }
    if (!zh) {
      return failOf(action, { errKey: 'empty', errText: '一个块都没跑出来', legs: { gh: 1, out }, fused });
    }

    const at = now();
    notes.push(manualLegsNote({ ghLegs: 1, outLegs: out, who, fused }));
    if (fused) notes.push(manualFuseNote(done.sent));
    if (sumFailed) notes.push(manualSumFailNote());
    if (done.failed.length) notes.push(manualBlockFailCountNote(done.failed.length));

    let stored = false;
    if (zh.length > MANUAL_FULL_ZH_MAX) {
      notes.push(manualNotStoredNote(zh.length));
    } else if (!transStore?.available) {
      notes.push(manualNoStoreNote());
    } else {
      stored = await transStore.put({ repo: key, kind, src: fp, zh, at, chars: zh.length, engine })
        .then(() => true)
        .catch((e) => {
          logger?.warn?.(`[gh-trending] 整篇那一行写库失败（${e?.message ?? e}），这一次看完就丢`);
          notes.push(manualStoreFailNote());
          return false;
        });
    }

    return {
      ok: true, action, kind, zh, at, label: engineZhLabel(engine, at), engine,
      cached: false, stored, blocks: blocks.length, failed: done.failed.length,
      legs: { gh: 1, out }, fused, notes,
    };
  }

  /** 库里那两行（键就是 `kind`，一个 kind 一行）：没有那一行就是 `null` ⇒ 载荷里那一段整段不摆。 */
  async function readRows({ repo } = {}) {
    // ★ 小写在**这里**钉死，不吃表内部那一次归一：`runOnce` 落库前就是自己 `toLowerCase()` 的（上面那颗 `key`），
    //   读的这一路跟着同一个形状走 ⇒ 换一颗不做归一的替身表，读回来的还是同一行（键形状有两处出处就是两份真相）。
    const norm = normalizeRepoKey(repo);
    const key = (norm.key || String(repo ?? '').trim()).toLowerCase();
    const paired = await Promise.all(MANUAL_KINDS.map((kind) => readRow(kind, key)));
    return Object.fromEntries(MANUAL_KINDS.map((kind, i) => [kind, paired[i]]));
  }

  /**
   * 三枚按钮的形状（载荷里给，客户端不重算、不排名单、不自造缺位符）。
   * ★ 顺序吃 `MANUAL_ACTIONS` 那一份封闭名单；`note` 能点时是"这一趟要做什么"，置灰时是"为什么按不动"，
   *   两种句子都在 domain 单点，客户端只念。`kind` 一起给：客户端拿它把回执对上载荷里那一段，不猜映射。
   */
  function actionsOf(tr, view) {
    return MANUAL_ACTIONS.map((action) => {
      const kind = MANUAL_ACTION_KIND[action];
      const g = manualGateOf(tr, kind, view);
      return { action, kind, label: MANUAL_ACTION_LABELS[action], can: g.can, gate: g.gate, note: g.note };
    });
  }

  /**
   * 详情载荷（和 `POST /api/repo/readme` 的回执）里那一份「手动这一屏」：按钮挂哪一段、正在跑那句、三枚按钮、那两段。
   * ★ 段名那句在这里拼定（含落款那一截）⇒ 客户端拿到什么摆什么：不排段序、不拼落款、不判哪一档做得了摘要。
   * ★ `receipt` 只影响一件事：**没落库**的那一份（超入库上限 / 本机没表 / 写失败）只能从回执顶上屏；
   *   落进库的那一行 `readRows` 本来就读得到，两处都读到的是同一份字（库里那一行优先 —— 它才是带主键的那一条）。
   */
  async function payload({ view = {}, receipt = null } = {}) {
    const tr = getTranslator?.() ?? null;
    const rows = await readRows({ repo: view.repo });
    const sections = MANUAL_ACTIONS
      .map((action) => MANUAL_ACTION_KIND[action])
      .filter(Boolean)
      .map((kind) => {
        const row = rows[kind];
        if (row?.zh) return { kind, label: manualSectionTitle(kind, row.label), zh: row.zh };
        if (receipt?.ok === true && receipt.kind === kind && receipt.zh) {
          return { kind, label: manualSectionTitle(kind, receipt.label), zh: receipt.zh };
        }
        return null;
      })
      .filter(Boolean);
    return { section: MANUAL_ACTIONS_SECTION, runNote: MANUAL_RUN_NOTE, actions: actionsOf(tr, view), sections };
  }

  return { run, readRows, actionsOf, payload };
}
