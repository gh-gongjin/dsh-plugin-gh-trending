/**
 * test/board-zh.test.mjs —— 榜面描述列的中文视图与补译批次（lib/board-zh.js）。
 *
 * 第二十二轮改判的对象是**触发面**（第八轮那句「点开详情时只译当前这条」→「一轮检查后也给榜面补一批」），
 * 三条用户裁定的口径在这里逐条钉住：
 *  · **每轮检查后补** ⇒ 批次只认装配层喂进来的那一轮（本套件测 `run()` 自身，接线在 test/api.test.mjs）；
 *  · **每轮 12 发 · 并发 2** ⇒ `batchMax` 截断 + 在途上限；
 *  · **复用「描述现译」这一档** ⇒ 闸门问的是 `enabled('desc')`，没有第二个开关。
 * ★ 假 transStore / 假 translator 的形状逐格对齐真服务（`entries()` 回整行、`translate()` 回那八个键）：
 *   桩少一格，测的就是桩不是闸门（第十五轮那条教训）。
 */
import { check, runAll, assert } from './_helpers.mjs';
import {
  descZhView, visibleBoardRows, allVisibleRows, boardDescHeadText, boardDescZhHead,
  createBoardZhRunner, BOARD_DESC_ZH_VIAS,
} from '../lib/board-zh.js';
import { descZhFor, DESC_ZH_ROWS, DESC_ZH_LABEL, DESC_ZH_NOTE } from '../lib/desc-zh.js';
import { transSrcKey } from '../lib/services/llm.js';
import {
  BOARDS, DESC_ZH_LIVE_NOTE, DESC_ZH_BLOCKED_NOTE, BOARD_ZH_BATCH_MAX, BOARD_ZH_CONCURRENCY,
  BOARD_ZH_FAIL_COOLDOWN_MS, engineZhLabel, DESC_SELF_ZH_MIN_CJK,
} from '../lib/domain.js';

const B0 = DESC_ZH_ROWS[0];                    // [主键, 原文, 译文]
const crow = (repo, rank, desc) => ({ rank, repo, name: repo, desc });
const boardsOf = (map) => Object.fromEntries(BOARDS.map((b) => [b, { rows: map[b] ?? [] }]));

/** 假 transStore：`entries()` 回真行形状；`available` 可关（无存储那一档要测的就是它）。 */
function fakeTransStore(rows, { available = true, fail = null } = {}) {
  const calls = { entries: 0 };
  return {
    calls,
    available,
    async entries() {
      calls.entries += 1;
      if (fail) throw new Error(fail);
      return rows;
    },
  };
}

/** 假现译服务：默认全部成功，记录每一发与同时在途峰值。 */
function fakeTranslator({ ok = true, note = '', delayMs = 0, enabled = () => true, ready = true, zh = () => '补出来的中文' } = {}) {
  const jobs = [];
  let inFlight = 0;
  let peak = 0;
  return {
    jobs,
    get peak() { return peak; },
    ready: () => ready,
    kinds: () => ['desc', 'readme'],
    enabled,
    async translate(arg) {
      jobs.push(arg);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      inFlight -= 1;
      return ok
        ? { ok: true, zh: zh(arg), cached: false, at: 8888, label: engineZhLabel('host_llm', 8888), stored: true, note: '', errKey: '', errText: '', engine: 'host_llm' }
        : { ok: false, zh: '', cached: false, at: 0, label: '', stored: false, note, errKey: 'error', errText: 'provider_error', engine: '' };
    },
  };
}

/* ---------------- 视图：屏上行 → 这一列的中文 ---------------- */

check('visibleBoardRows 只给批次（同仓库三榜取名次最好那条），allVisibleRows 给视图（每一行都在场）', () => {
  const boards = boardsOf({
    daily: [crow('s/same', 5, 'Same line'), crow('d/only', 1, 'Daily only')],
    weekly: [crow('s/same', 2, 'Same line')],
    monthly: [crow('s/same', 9, 'Same line')],
  });
  const once = visibleBoardRows(boards);
  assert.deepEqual(once.map((r) => r.repo).sort(), ['d/only', 's/same'], '三榜五个行去重成两个仓库');
  assert.equal(once.find((r) => r.repo === 's/same').rank, 2, '留的是名次最好的那条（rank 2）；批次排序在 descZhView 里做，这里不重排');
  assert.equal(once.length, 2, '一仓库三发就是白烧两发');
  assert.equal(allVisibleRows(boards).length, 4, '视图吃的是原样四行 —— 按名次去重会把"另一张榜上逐字对得上的那一行"丢掉');
  assert.deepEqual(visibleBoardRows(boardsOf({})), [], '三榜都空给空数组，不给 undefined');
});

check('descZhView：内置表优先压过库里的现译行（第八轮那句「B 优先」原样成立）', () => {
  const [repo, src, zh] = B0;
  const rows = [crow(repo, 1, src)];
  const stored = [{ repo, kind: 'desc', src: transSrcKey(src), zh: '模型重译的那一句', at: 7, engine: 'keyless' }];
  const v = descZhView(rows, stored);
  assert.equal(v.hits[repo].zh, zh, 'B 有这句 ⇒ 库里的行不作数');
  assert.equal(v.hits[repo].via, 'builtin');
  assert.deepEqual(v.todo, [], 'B 命中的仓库不许进批次：那是一次纯烧额度');
  assert.equal(v.missing, 0);
});

check('descZhView：库里逐字命中才给现译；原文变了旧译文当场作废并重新排队', () => {
  const repo = 'm/one';
  const src = 'An english description of the repo';
  const stored = [{ repo, kind: 'desc', src: transSrcKey(src), zh: '上一句的中文', at: 8888, engine: 'baidu' }];
  const hit = descZhView([crow(repo, 1, src)], stored).hits[repo];
  assert.deepEqual(hit, { zh: '上一句的中文', via: 'live', label: engineZhLabel('baidu', 8888), note: DESC_ZH_LIVE_NOTE, src: transSrcKey(src) },
    '落款的档名与时刻读的是**库里那一行**：把「这一帧选的是宿主模型档」写成落款是指鹿为马（第九轮那条律）');
  const changed = descZhView([crow(repo, 1, `${src}, reworded by the repo later`)], stored);
  assert.equal(changed.hits[repo], undefined, '原文变了 ⇒ 旧译文不许接着挂');
  assert.deepEqual(changed.todo.map((t) => t.repo), [repo], '变了的那一句要重排，下一轮补');
  assert.equal(changed.missing, 1);
});

check('descZhView：空白描述 / 仓库自己写的中文都不算欠账也不排队；缺的那几行按名次排队并截到上限', () => {
  const zhDesc = '这是一个中文描述项目'.repeat(3).slice(0, DESC_SELF_ZH_MIN_CJK + 4);
  const v = descZhView([
    crow('e/blank', 1, ''),
    crow('e/blank2', 2, '   '),
    crow('e/selfzh', 3, zhDesc),
    crow('e/r9', 9, 'Ninth line'),
    crow('e/r2', 2, 'Second line'),
  ], [], { batchMax: 1 });
  assert.equal(v.missing, 2, '只有那两句英文算"该有中文却缺着"；自写中文那句本来就在屏上');
  assert.deepEqual(v.todo.map((t) => t.repo), ['e/r2'], '按名次升序排队（先补屏上靠上的），截到 batchMax=1');
  const big = descZhView([crow('e/r9', 9, 'Ninth'), crow('e/r2', 2, 'Second')], []);
  assert.deepEqual(big.todo.map((t) => t.repo), ['e/r2', 'e/r9']);
});

check('descZhView：同一仓库在两榜上 desc 不同 ⇒ 谁逐字对上算谁，命中过的不再排队', () => {
  const [repo, src, zh] = B0;
  const v = descZhView(allVisibleRows(boardsOf({
    weekly: [crow(repo, 1, `${src}, reworded by the repo later`)],
    monthly: [crow(repo, 3, src)],
  })), []);
  assert.equal(v.hits[repo].zh, zh, '周榜那句旧原文先把仓库判成欠着的话，月榜逐字对上的那一句就没机会了（第十一轮判据的现场）');
  assert.deepEqual(v.todo, [], '已经上屏中文的仓库不再排第二发');
  assert.equal(v.missing, 0);
});

check('descZhView：失败冷却只挡排队、不改读数，过了冷却自动放回', () => {
  const repo = 'f/one';
  const desc = 'A line that failed last round';
  const src = transSrcKey(desc);
  const failed = new Map([[`${repo}|${src}`, 1000]]);
  const at = 1000 + BOARD_ZH_FAIL_COOLDOWN_MS - 1;
  const cooling = descZhView([crow(repo, 1, desc)], [], { nowMs: at, failed });
  assert.equal(cooling.missing, 1, '冷却中仍然要说"这一行欠着一句中文"（liveNote 那句实话靠它）');
  assert.deepEqual(cooling.todo, [], '但这一轮不再发');
  const later = descZhView([crow(repo, 1, desc)], [], { nowMs: at + 2, failed });
  assert.deepEqual(later.todo.map((t) => t.repo), [repo], '过了冷却自动再试，不用用户手动');
  const other = descZhView([crow(repo, 1, `${desc} changed`)], [], { nowMs: at, failed });
  assert.deepEqual(other.todo.map((t) => t.repo), [repo], '换了原文就是新的一发，冷却不该连坐');
});

/* ---------------- 卡头那一句 ---------------- */

check('boardDescHeadText：两路各有句子、混排并报、都没命中给空串；内置那一句逐字沿用旧文案', () => {
  assert.equal(boardDescHeadText({ builtin: 3, live: 0 }), `描述中译为${DESC_ZH_LABEL}`, '老用户看到的这一句不许因为本轮改判而变一个字');
  assert.equal(boardDescHeadText({ builtin: 0, live: 3 }), '描述中文为现译 3 条');
  assert.equal(boardDescHeadText({ builtin: 2, live: 5 }), '描述中文：内置预译 2 条 · 现译 5 条');
  assert.equal(boardDescHeadText({}), '');
  assert.equal(boardDescHeadText({ builtin: 0, live: 0 }), '');
});

check('boardDescZhHead：条数只算这一张榜、且只算原文逐字对上的那一行', () => {
  const [repo, src, zh] = B0;
  const hits = descZhView(allVisibleRows(boardsOf({
    daily: [crow(repo, 1, src), crow('x/1', 2, 'Another english line')],
    weekly: [crow(repo, 1, `${src}, reworded later`)],
  })), [{ repo: 'x/1', kind: 'desc', src: 'Another english line', zh: '另一句的中文', at: 5, engine: 'keyless' }]).hits;
  assert.equal(hits[repo].via, 'builtin');
  assert.equal(boardDescZhHead(boardsOf({ daily: [crow(repo, 1, src), crow('x/1', 2, 'Another english line')] }).daily.rows, hits),
    '描述中文：内置预译 1 条 · 现译 1 条');
  assert.equal(boardDescZhHead(boardsOf({ weekly: [crow(repo, 1, `${src}, reworded later`)] }).weekly.rows, hits), '',
    '命中记在仓库上，功劳只记在原文对得上的那一张榜 —— 周榜念"内置预译 1 条"就是屏上对不上的话');
  assert.equal(boardDescZhHead(boardsOf({ monthly: [] }).monthly.rows, hits), '');
});

check('BOARD_DESC_ZH_VIAS：两种来源的名单是 domain 那一格，界面与用例都念它（别处再写一遍字面量就是第二真相）', () => {
  assert.deepEqual(BOARD_DESC_ZH_VIAS, ['builtin', 'live']);
});

/* ---------------- 批次：闸门、并发、上限、单闸 ---------------- */

check('批次闸门：没有那一路引擎 / 没有库 / 开关关 / 引擎没就绪 ⇒ 四种理由各返回一次，且一发不派', async () => {
  const rows = [crow('g/1', 1, 'English one')];
  const tr = fakeTranslator();
  const store = fakeTransStore([]);
  const cases = [
    [{ getTranslator: () => null }, 'no_engine'],
    [{ transStore: fakeTransStore([], { available: false }) }, 'no_store'],
    [{ getTranslator: () => fakeTranslator({ enabled: () => false }) }, 'off'],
    [{ getTranslator: () => fakeTranslator({ ready: false }) }, 'unavailable'],
  ];
  for (const [over, why] of cases) {
    const t = fakeTranslator();
    const r = createBoardZhRunner({ transStore: store, getTranslator: () => t, now: () => 1, ...over });
    const out = await r.run(rows);
    assert.equal(out.skipped, why, `${why} 那一档应当当场返回理由`);
    assert.equal(out.sent, 0);
    assert.equal(t.jobs.length, 0, `${why} 挡的必须是"压根没发"，不是"发了再报错"`);
  }
  assert.equal(tr.jobs.length, 0);
});

check('闸门顺序：库不可用排在开关之前 —— 无存储时"下一轮自动再试"是假话，那一屏另有横幅', async () => {
  const t = fakeTranslator({ enabled: () => false });
  const r = createBoardZhRunner({ transStore: fakeTransStore([], { available: false }), getTranslator: () => t });
  assert.equal((await r.run([crow('g/1', 1, 'English one')])).skipped, 'no_store');
});

check('批次：屏上全命中 ⇒ nothing，一发不派；命中判据与视图同一份（库里有的不重发）', async () => {
  const [repo, src, zh] = B0;
  const t = fakeTranslator();
  const r = createBoardZhRunner({
    transStore: fakeTransStore([{ repo: 'x/9', kind: 'desc', src: 'other', zh: '别的', at: 1, engine: 'keyless' }]),
    getTranslator: () => t,
  });
  const out = await r.run([crow(repo, 1, src)]);
  assert.equal(out.skipped, 'nothing');
  assert.equal(out.planned, 0);
  assert.equal(t.jobs.length, 0);
});

check('批次：一轮最多 batchMax 发，且同时在途不超过 concurrency（用户裁定的第二条：12 发 · 并发 2）', async () => {
  const t = fakeTranslator({ delayMs: 6 });
  const r = createBoardZhRunner({
    transStore: fakeTransStore([]), getTranslator: () => t,
    now: () => 1, batchMax: 5, concurrency: 2,
  });
  const rows = Array.from({ length: 9 }, (_x, i) => crow(`c/${i}`, i + 1, `English line ${i}`));
  const out = await r.run(rows);
  assert.equal(out.planned, 5, '屏上九行只排前五（名次升序）');
  assert.equal(out.sent, 5);
  assert.equal(out.ok, 5);
  assert.equal(t.jobs.length, 5);
  assert.ok(t.peak <= 2, `在途峰值 ${t.peak} 超了并发上限 2 ⇒ 一轮十二发会变成一次打满限流`);
  assert.equal(t.peak, 2, '并发=2 时峰值必须真到 2，否则这条判据测的是"永远是 1"');
});

check('批次出厂常数：12 发 · 并发 2 · 冷却 30 分钟（domain 那一格，改它要跟着改判据）', () => {
  assert.equal(BOARD_ZH_BATCH_MAX, 12);
  assert.equal(BOARD_ZH_CONCURRENCY, 2);
  assert.equal(BOARD_ZH_FAIL_COOLDOWN_MS, 30 * 60 * 1000);
});

check('批次单闸：一批在跑时第二次触发当场 busy，不排队也不并发第二批', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = fakeTranslator();
  t.translate = async (arg) => { await gate; return { ok: true, zh: 'x', at: 1, stored: true, note: '', errKey: '', errText: '', engine: 'host_llm', cached: false, label: '' }; };
  const r = createBoardZhRunner({ transStore: fakeTransStore([]), getTranslator: () => t, now: () => 1 });
  const first = r.run([crow('b/1', 1, 'Busy line')]);
  assert.equal(r.running, true, '第一批还在跑时 running 要说真话');
  let second;
  try {
    // ★ 这里必须限时：单闸一破，第二次触发就不"当场返回"而是挂在那条没释放的 gate 上，
    //   用例跟着一起挂住 ⇒ 进程空转退出、电池拿不到红（证伪时踩到的形状，判据要自己会响）。
    second = await Promise.race([
      r.run([crow('b/2', 1, 'Busy line two')]),
      new Promise((_x, rej) => {
        setTimeout(() => rej(new Error('第二批没有当场返回 busy ⇒ 单闸破了：它直接开跑（不排队那条律正在被烧）')), 200);
      }),
    ]);
  } finally {
    release();
  }
  assert.equal(second.skipped, 'busy', '排队等于两批吃同一份 todo 各发一遍（check 服务那句 CHECK_BUSY 是同一条教训）');
  release();
  const done = await first;
  assert.equal(done.sent, 1);
  assert.equal(r.running, false);
});

check('批次失败：那一行进冷却表、当轮不再重派，其他行照发；失败数如实返回', async () => {
  const t = fakeTranslator({ ok: false, note: '配额用完了' });
  let nowMs = 1000;
  const r = createBoardZhRunner({
    transStore: fakeTransStore([]), getTranslator: () => t, now: () => nowMs, cooldownMs: 60000,
  });
  const rows = [crow('f/a', 1, 'Fail me'), crow('f/b', 2, 'Fail me too')];
  const out = await r.run(rows);
  assert.equal(out.sent, 2);
  assert.equal(out.ok, 0);
  assert.equal(out.failed, 2);
  assert.equal(t.jobs.length, 2);
  nowMs += 1000;
  const again = await r.run(rows);
  assert.equal(again.planned, 0, '两条都在冷却里 ⇒ 这一轮不发（否则每一轮都烧同一份额度）');
  assert.equal(again.skipped, 'nothing');
  nowMs += 60000;
  const after = await r.run(rows);
  assert.equal(after.sent, 2, '过了冷却自动再试');
  assert.deepEqual(r.peek().cooling, 2, '冷却表就在进程内存里，peek 给得出条数');
});

check('批次读库失败 ⇒ 这一轮不发也不崩（账本读不出来就当新行重发，烧的是整份额度换的是界面不动）', async () => {
  const t = fakeTranslator();
  const warns = [];
  const r = createBoardZhRunner({
    transStore: fakeTransStore([], { fail: 'KV 抖了一下' }),
    getTranslator: () => t,
    logger: { warn: (m) => warns.push(String(m)) },
    now: () => 1,
  });
  const out = await r.run([crow('n/1', 1, 'English line')]);
  assert.equal(out.skipped, 'read_failed');
  assert.equal(t.jobs.length, 0, '读不到库就不发：拿不到"已经译过哪些"的账，发出去就是重复烧额度');
  assert.equal(warns.length, 2, '两句都要有：先说读不出账的因，再说整轮不发的决定（只留一句的话，日志里看不出这一轮到底发没发）');
  assert.match(warns[0], /KV 抖了一下/, '降级要带上仓储给的原因，界面上静默失败查不到现场');
  assert.equal(r.peek().rounds, 0, '这一轮没算进轮次：一次都没发的轮次不该出现在"跑过几轮"的账里');
});

check('批次落库由现译服务自己做（runner 不写库）：跑完只认 translate 的回执计数', async () => {
  const put = [];
  const store = fakeTransStore([]);
  store.put = async (row) => { put.push(row); return { key: 'k', dropped: 0 }; };
  const t = fakeTranslator();
  const r = createBoardZhRunner({ transStore: store, getTranslator: () => t, now: () => 1 });
  await r.run([crow('w/1', 1, 'Write me')]);
  assert.deepEqual(put, [], 'runner 里没有第二处写库口径：落库是 translate() 契约的一部分（llm.js / web-translate.js 各自负责）');
  assert.equal(store.calls.entries, 1, '一轮只读一遍全表，不是每行一次 get');
});

check('descZhView 的落款与 DESC_ZH_BLOCKED_NOTE 都来自 domain：用例里不出现手抄的句子', () => {
  assert.equal(typeof DESC_ZH_BLOCKED_NOTE, 'string');
  assert.ok(DESC_ZH_BLOCKED_NOTE.includes('内置预译'));
  const [repo, src] = B0;
  const v = descZhView([crow(repo, 1, src)], []);
  assert.equal(v.hits[repo].note, DESC_ZH_NOTE);
  assert.equal(v.hits[repo].label, DESC_ZH_LABEL);
});

await runAll('board-zh');
