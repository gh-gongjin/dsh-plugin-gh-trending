/**
 * lib/check.js —— 一轮检查的编排：读旧档 → 三张榜各自拉 → 各自判定 → 落流水与快照 → 推帧。
 *
 * 四条铁律在这一层的落点：
 *  · **三榜各挂各的闸**：日榜坏了不许在周榜页冒横幅；坏在哪一榜就只冻结哪一榜的行（spec §1）。
 *  · 首轮与坏转好那一轮都不产积压 diff —— 拿不到公允的上轮就不记账（spec §3）。
 *  · 304 只证明「整页字节未变」，因此只推 lastFetchAt，不改 rows、不产事件、不动 bodyChangedAt（spec §1）。
 *  · 定时器：宿主 ctx.timer.interval 返回 **disposer 函数**，不是 handle；忙时回 rejected promise，
 *    绝不同步 throw（modelwatch 那次 CHECK_BUSY 把宿主打崩的根因）。
 */
import { fetchTrendingBoard, checkLanguageSlug } from './services/gh.js';
import {
  BOARDS, BOARD_LABELS, MOVE_THRESHOLD, CROSS_MIN_BOARDS, BACKOFF_MAX_ROUNDS,
  BACKOFF_MAX_MS, FETCH_ATTEMPTS, FETCH_RETRY_DELAY_MS, DEFAULT_PREFS,
} from './domain.js';

/**
 * 单榜的纯判定：本轮 rows vs 上轮 prevRows（PREV_ROW_SHAPE 数组）。
 * 返回带 delta / renamedFrom / fresh 的行 + 事件清单。不碰库、不碰网，方便断言。
 *
 * `alreadyAnnounced` 是本轮里已经播过 first_on_board 的仓库集合：同一轮三张榜都会见到新仓库，
 * 但这个信息对用户只值一条流水（spec §3）。
 */
export function diffBoard({ board, rows, prevRows, seen, at, alreadyAnnounced = null }) {
  const prevList = Array.isArray(prevRows) ? prevRows : [];
  const hasPrev = prevList.length > 0;
  const prevRank = new Map(prevList.map((r) => [r.repo, r.rank]));
  const prevId = new Map(prevList.filter((r) => r.repoId).map((r) => [r.repoId, r]));
  const threshold = MOVE_THRESHOLD[board] ?? 3;

  const nextRows = rows.map((row, i) => {
    const out = { ...row, rank: i + 1 };
    const oldRank = prevRank.get(row.repo);
    if (oldRank !== undefined && oldRank !== out.rank) out.delta = oldRank - out.rank;

    // 改名：新 key、但 repoId 在上轮出现过 ⇒ 不是「新进」，是同一个仓库改了名
    const byId = row.repoId ? prevId.get(row.repoId) : undefined;
    if (oldRank === undefined && byId) {
      out.renamedFrom = byId.name ?? '';
      out.delta = (byId.rank ?? out.rank) - out.rank;
    }
    if (seen && !seen.has(row.repo)) out.fresh = true;
    return out;
  });

  const nextRepos = new Set(nextRows.map((r) => r.repo));
  const entered = hasPrev ? nextRows.filter((r) => !prevRank.has(r.repo) && !r.renamedFrom) : [];
  // 改名的旧 key 不算掉榜：它只是换了名字，报一条 board_exit 是假账（流水里看像"仓库没了"）
  const renamedIds = new Set(nextRows.filter((r) => r.renamedFrom && r.repoId).map((r) => r.repoId));
  const exited = hasPrev ? prevList.filter((r) => !nextRepos.has(r.repo) && !(r.repoId && renamedIds.has(r.repoId))) : [];
  const moved = hasPrev
    ? nextRows.filter((r) => !r.renamedFrom && prevRank.has(r.repo) && Math.abs(r.delta ?? 0) >= threshold)
    : [];

  const events = [];
  for (const r of nextRows.filter((x) => x.renamedFrom)) {
    events.push({ kind: 'renamed', board, repo: r.repo, name: r.name, detail: `${r.renamedFrom} → ${r.name}` });
  }
  for (const r of entered) {
    const announceFresh = r.fresh === true && !(alreadyAnnounced && alreadyAnnounced.has(r.repo));
    if (announceFresh) {
      alreadyAnnounced?.add(r.repo);
      events.push({ kind: 'first_on_board', board, repo: r.repo, name: r.name, detail: `本机首次上榜：${BOARD_LABELS[board]}第 ${r.rank} 名` });
    }
    events.push({ kind: 'board_enter', board, repo: r.repo, name: r.name, detail: `第 ${r.rank} 名` });
  }
  for (const r of exited) {
    events.push({ kind: 'board_exit', board, repo: r.repo, name: r.name ?? '', detail: `原第 ${r.rank} 名` });
  }
  for (const r of moved) {
    events.push({ kind: 'board_move', board, repo: r.repo, name: r.name, detail: `${r.delta > 0 ? '↑' : '↓'} ${Math.abs(r.delta)} 位` });
  }
  return { rows: nextRows, events };
}

/** 从每榜状态行里取某一侧的行数组（rows=本轮，prevRows=上轮）。 */
function rowsSide(state, side) {
  const rows = state?.[side];
  return Array.isArray(rows) ? rows : [];
}

/** repo → { name, boards:Set, bestRank } 的在榜分布表。 */
function presence(states, side) {
  const out = new Map();
  for (const board of BOARDS) {
    for (const row of rowsSide(states?.[board], side)) {
      if (!row?.repo) continue;
      let cur = out.get(row.repo);
      if (!cur) { cur = { name: row.name ?? '', boards: new Set(), bestRank: Infinity }; out.set(row.repo, cur); }
      cur.boards.add(board);
      if (row.rank < cur.bestRank) { cur.bestRank = row.rank; cur.name = row.name ?? cur.name; }
    }
  }
  return out;
}

/**
 * 跨榜同现（纯函数，spec §2 的核心洞察：三榜同一次检查拿到，零额外请求就能交叉）。
 * 吃每榜的状态行 `{ daily:{rows,prevRows}, weekly:{..}, monthly:{..} }`：
 *  · rising = 本轮同时在 ≥CROSS_MIN_BOARDS 张榜上；
 *  · cooling = 上轮同时 ≥2 张、本轮只剩 1 张（日榜掉出去了，周/月还在）。
 */
export function crossBoards(states) {
  const cur = presence(states, 'rows');
  const before = presence(states, 'prevRows');
  const rising = [];
  for (const [repo, c] of cur) {
    if (c.boards.size < CROSS_MIN_BOARDS) continue;
    rising.push({ repo, name: c.name, boards: BOARDS.filter((b) => c.boards.has(b)), span: c.boards.size, bestRank: c.bestRank });
  }
  rising.sort((a, b) => b.span - a.span || a.bestRank - b.bestRank);

  const cooling = [];
  for (const [repo, b] of before) {
    if (b.boards.size < CROSS_MIN_BOARDS) continue;
    const c = cur.get(repo);
    if (!c || c.boards.size > 1) continue;
    cooling.push({ repo, name: c.name, boards: BOARDS.filter((x) => c.boards.has(x)), span: c.boards.size, bestRank: c.bestRank, lostBoards: BOARDS.filter((x) => b.boards.has(x) && !c.boards.has(x)) });
  }
  cooling.sort((a, b) => a.bestRank - b.bestRank || a.repo.localeCompare(b.repo));
  return { rising, cooling };
}

/**
 * 跨榜状态翻转（只在这一对变化上记账，避免「持续升温」每轮刷一条）：
 *  · 上轮 <2 张 → 本轮 ≥2 张 = rising_cross
 *  · 上轮 ≥2 张 → 本轮 <2 张 = cooling_cross（三榜全掉光也记这一条，明细里说清）
 * 首轮由调用方挡掉（runOnce 里没有 prevRows 就不调这里）—— 跟 diffBoard 一个口径。
 */
export function crossEvents(states) {
  const cur = presence(states, 'rows');
  const before = presence(states, 'prevRows');
  const events = [];
  const joined = new Set([...cur.keys(), ...before.keys()]);
  for (const repo of joined) {
    const n = cur.get(repo)?.boards.size ?? 0;
    const p = before.get(repo)?.boards.size ?? 0;
    if (p < CROSS_MIN_BOARDS && n >= CROSS_MIN_BOARDS) {
      const c = cur.get(repo);
      events.push({ kind: 'rising_cross', repo, name: c.name, detail: `同时登上 ${BOARDS.filter((b) => c.boards.has(b)).map((b) => BOARD_LABELS[b]).join('、')}` });
    } else if (p >= CROSS_MIN_BOARDS && n < CROSS_MIN_BOARDS) {
      const b = before.get(repo);
      const c = cur.get(repo);
      events.push({
        kind: 'cooling_cross', repo, name: c?.name ?? b.name,
        detail: n === 0 ? `三张榜全部掉出（曾在 ${b.boards.size} 张榜上）` : `只剩 ${BOARDS.filter((x) => c.boards.has(x)).map((x) => BOARD_LABELS[x]).join('、')}`,
      });
    }
  }
  return events;
}

/** 用旧档兜一份完整的 state 行（schema 里 8 个必填列，prev 为 null 也不能漏）。 */
function carryState(board, prev, patch) {
  return {
    board,
    at: prev?.at ?? 0,
    ok: prev?.ok === true,
    error: prev?.error ?? '',
    etag: prev?.etag ?? '',
    bodyChangedAt: prev?.bodyChangedAt ?? 0,
    lastFetchAt: prev?.lastFetchAt ?? 0,
    failStreak: prev?.failStreak ?? 0,
    transport: prev?.transport === true,
    rows: Array.isArray(prev?.rows) ? prev.rows : [],
    prevRows: Array.isArray(prev?.prevRows) ? prev.prevRows : [],
    baseline: prev?.baseline ?? true,
    ...patch,
  };
}

export function createCheckService(deps = {}) {
  const {
    getPrefs, stateStore, eventStore, seenStore, logger,
    now = () => Date.now(),
    getIntervalFn = () => undefined,
    // ★ fetchFn 必须排在 fetchBoardFn 前面（默认值按同一层解构顺序求值），并且必须被默认实现吃掉：
    //   否则测试只注入 fetchFn 时会**静默打真网络**（宿主半边唯一出网点就在这三发 GET）。
    fetchFn = globalThis.fetch,
    fetchBoardFn = (a) => fetchTrendingBoard({ ...a, fetchFn }),
    fetchAttempts = FETCH_ATTEMPTS,
    retryDelayMs = FETCH_RETRY_DELAY_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onEvent = null,
  } = deps;

  let running = null;
  let timerHandle = null;
  let timerBackend = 'none';
  let badRounds = 0;           // 连续「三榜全坏」的轮数（退避指数）
  let appliedExp = -1;         // 当前挂上去的退避指数，-1 = 还没挂
  let appliedIntervalMin = 0;  // 当前挂上去的节拍基数
  let nextCheckAt = 0;         // 下一次定时触发的预计时刻（界面说「下次自动检查」用）

  /**
   * 单榜取数 + **只补传输类失败**。
   *
   * 为什么要补：真机读数 2026-10-05 09:40:04 三榜同时 UND_ERR_CONNECT_TIMEOUT（undici 连接 10s 超时），
   * 同一台机 09:46:46 手动一轮三榜全成功 —— 一次几秒的路子抖动，旧口径直接冻结榜面并开退避。
   * 为什么只补这一类：解析失败（改版）与 HTTP 4xx/5xx 再打三次是同一份答案，只是把三发变成九发。
   */
  async function fetchBoard({ board, language, etag, timeoutMs }) {
    const attempts = Math.max(1, Number(fetchAttempts) || 1);
    let res = null;
    let used = 0;
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await sleep(retryDelayMs);
      used = i + 1;
      res = await fetchBoardFn({ board, language, etag, timeoutMs });
      if (res?.ok === true || res?.transportError !== true) break;
    }
    if (used > 1 && res && res.ok !== true) {
      return { ...res, attempts: used, reason: `${res.reason}（共尝试 ${used} 次）` };
    }
    return res;
  }

  async function appendEvent({ kind, board = '', repo = '', name = '', detail = '' }) {
    try {
      await eventStore.append({ kind, board, repo, name, detail });
    } catch (e) {
      // 流水写不进（多半是无存储）：留痕进日志，绝不让一轮检查因此中断。
      logger?.warn?.(`[gh-trending] 事件落库失败（${kind}）：${e?.message ?? e}`);
    }
  }

  function emit(type, payload = {}) {
    try { onEvent?.({ type, ...payload }); } catch { /* 没人订阅，无需解释 */ }
  }

  /** 三榜全坏才退避；任何一榜成功就归零。翻倍值夹进 [用户节拍, BACKOFF_MAX_MS]。 */
  function backoffMs(baseMin) {
    const base = Math.max(1, baseMin) * 60000;
    const exp = Math.min(badRounds, BACKOFF_MAX_ROUNDS);
    return Math.max(base, Math.min(base * (2 ** exp), BACKOFF_MAX_MS));
  }

  async function runOnce({ trigger = 'timer' } = {}) {
    const prefs = getPrefs();
    const t0 = now();

    let states = {};
    let seen = new Map();
    let writable = true;
    try {
      states = (await stateStore.readAll()) ?? {};
      seen = (await seenStore.readAll()) ?? new Map();
    } catch (e) {
      writable = false;
      logger?.warn?.(`[gh-trending] 读旧档失败：${e?.message ?? e}`);
    }

    const results = await Promise.all(BOARDS.map((board) => fetchBoard({
      board,
      language: prefs.language,
      etag: states[board]?.etag ?? '',
      timeoutMs: deps.timeoutMs ?? 30000,
    })));

    const produced = {};
    for (const b of BOARDS) produced[b] = { enter: 0, exit: 0, move: 0, fresh: 0, renamed: 0, error: 0, recover: 0 };
    let anyOk = false;
    const nextStates = {};
    const announced = new Set(); // 本轮已播过 first_on_board 的仓库（三榜只记一次）

    for (let i = 0; i < BOARDS.length; i += 1) {
      const board = BOARDS[i];
      const res = results[i];
      const prev = states[board] ?? null;
      const wasOk = prev ? prev.ok === true : false;
      // ★ 对比基线只能是**上一轮成功的那份 rows**，不能吃 state.prevRows：
      //   写盘时 prevRows 是「上轮的上轮」，拿它当基线等于每轮都跟隔两轮比 ——
      //   更要命的是首轮成功后 prevRows 恒为 []，diffBoard 见基线空就直接不产事件，整条流水会永久哑掉。
      //   坏轮的 rows 是冻结的旧档，也不配当基线（拿它比出来的进榜是假账），所以还要 ok===true。
      const trusted = Boolean(prev) && wasOk;
      const prevRows = trusted ? (Array.isArray(prev.rows) ? prev.rows : []) : [];

      // —— 304：页面字节没变 ⇒ 榜面照旧，只推 lastFetchAt，不改 rows、不产榜面事件（spec §1）——
      // 能拿到 304 说明请求打得通、且页面仍等于上次成功那份，所以它同时是「源恢复」的证据。
      if (res.ok === true && res.notModified === true) {
        anyOk = true;
        const recovered = !wasOk;
        if (recovered) {
          await appendEvent({ kind: 'source_recover', board, detail: `${BOARD_LABELS[board]}源恢复（304：页面仍是上次那一份）` });
          produced[board].recover += 1;
        }
        nextStates[board] = carryState(board, prev, { ok: true, error: '', transport: false, lastFetchAt: t0, failStreak: recovered ? 0 : (prev?.failStreak ?? 0) });
        if (writable) {
          try { await stateStore.write(board, nextStates[board]); } catch (e) { logger?.warn?.(`[gh-trending] 落库失败(${board})：${e?.message ?? e}`); }
        }
        continue;
      }

      // —— 语言 slug 不被站点认识：配置错了，不是源坏了；但这一榜确实拿不到数据，只能冻结旧榜 ——
      if (res.ok === true && res.unknownLanguage === true) {
        const why = `语言过滤「${prefs.language}」在趋势页标题里没被念出，站点不认识这个 slug`;
        if (!prev || prev.ok !== false || prev.error !== why) {
          await appendEvent({ kind: 'source_error', board, detail: why });
          produced[board].error += 1;
        }
        nextStates[board] = carryState(board, prev, {
          ok: false, error: why, transport: false, lastFetchAt: t0, failStreak: (prev?.failStreak ?? 0) + 1, etag: '',
        });
        if (writable) {
          try { await stateStore.write(board, nextStates[board]); } catch (e) { logger?.warn?.(`[gh-trending] 落库失败(${board})：${e?.message ?? e}`); }
        }
        continue;
      }

      // —— 真故障：坏轮冻结，rows/prevRows/etag 全停在最后一次成功轮，不许逐轮自我清空 ——
      if (res.ok !== true) {
        if (!prev || wasOk) {
          await appendEvent({ kind: 'source_error', board, detail: `${BOARD_LABELS[board]}：${res.reason}` });
          produced[board].error += 1;
        }
        nextStates[board] = carryState(board, prev, {
          ok: false, error: res.reason, transport: res.transportError === true,
          lastFetchAt: t0, failStreak: (prev?.failStreak ?? 0) + 1,
        });
        if (writable) {
          try { await stateStore.write(board, nextStates[board]); } catch (e) { logger?.warn?.(`[gh-trending] 落库失败(${board})：${e?.message ?? e}`); }
        }
        continue;
      }

      anyOk = true;
      // 空榜（语言有效但这一档今天没上榜仓库）：合法状态，ok=true + rows=[]，界面显示「这一档今天没有上榜仓库」
      const firstEver = !prev;
      const { rows, events } = diffBoard({
        board, rows: res.rows ?? [], prevRows, seen, at: t0, alreadyAnnounced: announced,
      });

      if (firstEver) {
        await appendEvent({ kind: 'baseline', board, detail: `${BOARD_LABELS[board]}首次建档：本轮起开始对比` });
      } else {
        // 坏转好这一轮不补产榜面 diff（prevRows 已被上面判为不可信），但必须说「源恢复」
        for (const ev of events) {
          await appendEvent(ev);
          if (ev.kind === 'board_enter') produced[board].enter += 1;
          else if (ev.kind === 'board_exit') produced[board].exit += 1;
          else if (ev.kind === 'board_move') produced[board].move += 1;
          else if (ev.kind === 'first_on_board') produced[board].fresh += 1;
          else if (ev.kind === 'renamed') produced[board].renamed += 1;
        }
        if (!wasOk) {
          await appendEvent({ kind: 'source_recover', board, detail: `${BOARD_LABELS[board]}源恢复` });
          produced[board].recover += 1;
        }
      }

      // 观测史：每个在榜仓库记一笔（改名/新进判定已在 diffBoard 里做完，这里只更新「见过」）
      // ★ 第二十三轮起带上 `rank`：`seen` 那两格（累计轮数 / 历史最好名次）是明星那一屏的原料，
      //   而这一趟**本来就遍历过每一行** ⇒ 记在这儿是零额外成本；挪到读路径（快照每帧扫流水）就是 §0 本轮 ⑥ 那条病历。
      //   `at: t0` 三榜同一个值 —— `touch` 靠它认"同一轮只算一轮"，这里不许改成每榜现取时刻。
      if (writable && rows.length > 0) {
        for (const row of rows) {
          try { await seenStore.touch({ repo: row.repo, name: row.name, repoId: row.repoId, board, at: t0, rank: row.rank }); } catch (e) { logger?.warn?.(`[gh-trending] 观测史写入失败(${row.repo})：${e?.message ?? e}`); }
        }
      }

      nextStates[board] = carryState(board, prev, {
        at: t0,
        ok: true,
        error: '',
        transport: false,
        etag: res.etag ?? '',
        bodyChangedAt: (res.rows ?? []).length > 0 ? t0 : (prev?.bodyChangedAt ?? 0),
        lastFetchAt: t0,
        failStreak: 0,
        rows,
        prevRows: (prev?.rows ?? []).map((r) => ({ repo: r.repo, name: r.name ?? '', repoId: r.repoId, rank: r.rank })),
        baseline: false,
      });
      if (writable) {
        try { await stateStore.write(board, nextStates[board]); } catch (e) { logger?.warn?.(`[gh-trending] 落库失败(${board})：${e?.message ?? e}`); }
      }
    }

    badRounds = anyOk ? 0 : badRounds + 1;

    // 跨榜同现的变化（吃刚算好的 nextStates，零额外请求）。首轮没有 prevRows ⇒ 不补产积压（spec §3）
    const hadPrevRound = BOARDS.some((b) => (nextStates[b]?.prevRows ?? []).length > 0);
    const crossEvs = hadPrevRound ? crossEvents(nextStates) : [];
    for (const ev of crossEvs) await appendEvent(ev);
    const producedCross = {
      rising: crossEvs.filter((e) => e.kind === 'rising_cross').length,
      cooling: crossEvs.filter((e) => e.kind === 'cooling_cross').length,
    };

    if (writable) {
      try { await eventStore.trim(prefs.keepEvents); } catch (e) { logger?.warn?.(`[gh-trending] 流水裁剪失败：${e?.message ?? e}`); }
    }

    // 退避改变了有效节拍 → 重挂定时器（只在指数真的变了的时候，避免每轮都摘挂）
    const wantExp = Math.min(badRounds, BACKOFF_MAX_ROUNDS);
    if (wantExp !== appliedExp) {
      appliedExp = wantExp;
      setCadence(prefs.intervalMin);
    }

    emit('update', { trigger, produced, producedCross, at: t0 });
    return {
      at: t0, produced, producedCross, anyOk,
      boardsOk: BOARDS.reduce((acc, b) => { acc[b] = nextStates[b]?.ok === true; return acc; }, {}),
      states: nextStates,
    };
  }

  /**
   * 单闸：同一时刻只跑一轮；正在跑时再触发返回 CHECK_BUSY（rejected promise，不同步 throw）。
   *
   * ★ 为什么是闭包里的具名函数、而不是只写在 return 的对象字面量里当方法：
   *   setCadence 的定时器回调调的是裸 `run()`，对象方法不在作用链上 ⇒ 一响就
   *   `ReferenceError: run is not defined`。真机（desktop profile，2026-10-05 挂满一个节拍后）
   *   这条异常从 `Timeout.tick` 直接落进 uncaughtException，把宿主进程整个带走。
   *   用例全部走 `svc.run()`，没人碰过这条回调 —— 回归断言见 check.test.mjs「定时器响了」。
   */
  function run(opts = {}) {
    if (running) {
      return Promise.reject(Object.assign(new Error('已有一轮检查在跑，等它结束'), { code: 'CHECK_BUSY' }));
    }
    running = runOnce(opts).finally(() => { running = null; });
    return running;
  }

  function setCadence(intervalMin) {
    stopTimer();
    const base = Math.max(1, Number(intervalMin) || DEFAULT_PREFS.intervalMin);
    const ms = backoffMs(base);
    const tick = () => {
      nextCheckAt = now() + ms;   // 周期定时器自己会再响，这里只把「下一次」往前推一格
      run().catch((e) => logger?.warn?.(`[gh-trending] 定时检查失败：${e?.message ?? e}`));
    };
    const host = getIntervalFn();
    if (typeof host === 'function') {
      timerHandle = host(tick, ms);
      timerBackend = 'ctx.timer';
    } else {
      timerHandle = setInterval(tick, ms);
      if (typeof timerHandle.unref === 'function') timerHandle.unref();
      timerBackend = 'setInterval';
    }
    nextCheckAt = now() + ms;
    appliedIntervalMin = base;
    appliedExp = Math.min(badRounds, BACKOFF_MAX_ROUNDS);
  }

  function stopTimer() {
    if (timerHandle === null) return;
    try {
      // 宿主 ctx.timer.interval 返回 disposer 函数：对它调 clearInterval 是静默 no-op ⇒ 定时器叠加撞车
      if (typeof timerHandle === 'function') timerHandle();
      else clearInterval(timerHandle);
    } catch { /* 清不掉也只可能是已经清了 */ }
    timerHandle = null;
    appliedExp = -1;
    nextCheckAt = 0;
  }

  return {
    /** 单闸见上面闭包里的 `run` —— 必须是同一个函数，定时器回调与 API/启动首轮才共用一把闸。 */
    run,
    get running() { return running !== null; },
    setCadence,
    stopTimer,
    get timerBackend() { return timerBackend; },
    /** 节拍与下一次自动检查的预计时刻（界面「连续失败 N 轮 · 下次自动检查 X 后」吃这一份）。 */
    get cadence() {
      const effectiveMs = backoffMs(appliedIntervalMin || DEFAULT_PREFS.intervalMin);
      return {
        intervalMin: appliedIntervalMin,
        effectiveMs,
        backoffExp: Math.min(badRounds, BACKOFF_MAX_ROUNDS),
        nextCheckAt: timerHandle === null ? 0 : nextCheckAt,
        fetchAttempts: Math.max(1, Number(fetchAttempts) || 1),
      };
    },
    /** 诊断读数用（测试钉退避是否真的生效）。 */
    get backoffExponent() { return Math.min(badRounds, BACKOFF_MAX_ROUNDS); },
    get cadenceMs() { return backoffMs(appliedIntervalMin || DEFAULT_PREFS.intervalMin); },
    checkLanguage: (language) => checkLanguageSlug({ language, fetchFn }),
    cross: (states) => crossBoards(states),
    dispose() { stopTimer(); },
  };
}
