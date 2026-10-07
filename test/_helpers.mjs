/**
 * test/_helpers.mjs —— 零框架跑测器（口径继承 sysops / modelwatch）：
 *   node test/<x>.test.mjs 直跑；用例名含「真机」时 SKIP_LOCAL=1 跳过并打印 SKIP。
 * 断言一律 node:assert/strict；每个套件收尾前自己扫一遍用例名重号。
 */
import assert from 'node:assert/strict';

const cases = [];
export function check(name, fn) { cases.push({ name, fn }); }

export async function runAll(suiteLabel) {
  const skipLocal = process.env.SKIP_LOCAL === '1';
  let pass = 0; let skip = 0; const fails = [];
  const names = new Set();
  for (const c of cases) {
    if (names.has(c.name)) throw new Error(`用例名重号：${c.name}`);
    names.add(c.name);
  }
  for (const c of cases) {
    if (skipLocal && c.name.includes('真机')) { skip += 1; console.log(`SKIP ${c.name}`); continue; }
    const t0 = Date.now();
    try {
      await c.fn();
      pass += 1;
      console.log(`ok   ${c.name} (${Date.now() - t0}ms)`);
    } catch (e) {
      fails.push({ name: c.name, e });
      console.log(`FAIL ${c.name}\n  ${e?.message ?? e}`);
    }
  }
  console.log(`\n[${suiteLabel}] pass ${pass} / fail ${fails.length} / skip ${skip}`);
  if (fails.length) process.exitCode = 1;
}

export { assert };

/** 读夹具文本（UTF-8）。 */
export async function fixture(name) {
  const fs = await import('node:fs');
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return fs.readFileSync(url, 'utf8');
}

/**
 * 假 storageDomain 设施：open 计数 + already-open 语义（域名排他，同 sysops 血案口径）。
 * handle.table(name) → { get, put, delete, entries, clear }
 */
export function makeFakeFacility() {
  const openDomains = new Map();
  const calls = { open: 0, close: 0 };
  return {
    calls,
    async open(domain) {
      calls.open += 1;
      if (openDomains.has(domain.name)) throw new Error(`already-open: ${domain.name}`);
      const tables = new Map();
      const state = { closed: false };
      const handle = {
        table(name) {
          if (state.closed) throw new Error('CLOSED');
          if (!tables.has(name)) {
            const rows = new Map();
            tables.set(name, {
              get: (k) => (rows.has(k) ? rows.get(k) : undefined),
              put: async (k, v) => { rows.set(k, v); },
              delete: async (k) => { rows.delete(k); },
              // ★ 真实宿主这里返回 lazy iterator；故意也返回迭代器，逼调用方写 [...t.entries()]
              entries: () => rows.entries(),
              keys: () => rows.keys(),
              _rows: rows,
            });
          }
          return tables.get(name);
        },
        async close() { state.closed = true; openDomains.delete(domain.name); calls.close += 1; },
      };
      openDomains.set(domain.name, handle);
      return handle;
    },
    /** 测试专用：直接看某表当前行数（不参与插件逻辑）。 */
    rowCount(domainName, table) {
      const h = openDomains.get(domainName);
      if (!h) return -1;
      return h.table(table)._rows.size;
    },
    /**
     * 测试专用：往已打开的域里塞一行**未经 schema 校验**的原始数据。
     * 用途是模拟"上一版插件写的行 / 手工改过的库"——这类脏行只有绕开 put 才进得去，
     * 而读路径（clampPrefs / snapshotOf）必须扛住它。
     */
    seed(domainName, table, key, value) {
      const h = openDomains.get(domainName);
      if (!h) throw new Error(`域未打开，塞不进行：${domainName}`);
      h.table(table)._rows.set(key, value);
    },
  };
}

/**
 * 假 HTTP：按 URL 前缀路由到预置响应；记录请求（url + headers）。
 * 响应支持 { text, status, headers:{etag,...} } 或函数 (url, opts) => 同形。
 * 304 语义按真实宿主用得上的方式给：routes 里带 `etag` 且请求 If-None-Match 相同 ⇒ 自动 304。
 */
export function makeFakeFetch(routes) {
  const seen = [];
  const fetchFn = async (url, opts = {}) => {
    seen.push({ url, headers: opts.headers || {} });
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) throw new Error(`假 fetch 没登记这个 URL：${url}`);
    let r = routes[key];
    if (typeof r === 'function') r = await r(url, opts);
    const status = r.status ?? 200;
    const etag = r.headers?.etag ?? '';
    const inm = (opts.headers || {})['If-None-Match'];
    if (etag && inm && inm === etag) {
      return {
        ok: false, status: 304,
        headers: { get: (k) => (String(k).toLowerCase() === 'etag' ? etag : null) },
        text: async () => { throw new Error('304 不该读正文'); },
        json: async () => { throw new Error('304 不该读正文'); },
      };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (String(k).toLowerCase() === 'etag' ? etag : (r.headers?.[String(k).toLowerCase()] ?? null)) },
      text: async () => r.text ?? '',
      json: async () => r.json,
    };
  };
  fetchFn.seen = seen;
  return fetchFn;
}

/** 假 res：捕获 writeHead/end/write，供 api 层断言状态码与 body。 */
export function makeRes() {
  const res = {
    head: null, body: '', statusCode: 0, ended: false, writes: [],
    writeHead(status, headers) { this.statusCode = status; this.head = headers; },
    end(chunk) { this.body += chunk ?? ''; this.ended = true; },
    write(chunk) { if (this.ended) throw new Error('write after end'); this.writes.push(String(chunk)); return true; },
    on() {},
    json() { try { return JSON.parse(this.body); } catch { return null; } },
  };
  return res;
}

/** 假 req：GET/POST + 流式 body（宿主只传 (req,res)，body 必须自己拼 —— 这条必须测到）。 */
export function makeReq({ method = 'GET', url = '/', body, socket = { remoteAddress: '127.0.0.1' }, headers = {} } = {}) {
  const listeners = {};
  const req = {
    method, url, socket, headers,
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    destroy() {},
    _emit() {
      if (body !== undefined) {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        for (const fn of listeners.data || []) fn(Buffer.from(text));
      }
      for (const fn of listeners.end || []) fn();
    },
  };
  // 同步触发一轮：真实宿主是微任务之后，但 handler 是先注册监听再 await，顺序一致
  setTimeout(() => req._emit(), 0);
  return req;
}

/** 假 ctx：只装本插件用得上的门面（inject 立刻执行、effect 收撤销器、slots 记账）。 */
export function makeFakeCtx({ facility, timerInterval, webServer } = {}) {
  const logs = { warn: [], info: [], error: [] };
  const logger = {
    warn: (m) => logs.warn.push(String(m)),
    info: (m) => logs.info.push(String(m)),
    error: (m) => logs.error.push(String(m)),
  };
  const effects = [];
  const injected = [];
  const handlers = new Map();
  const slots = { registered: [], injectCalls: [] };
  const ctx = {
    logger,
    inject(keys, cb) {
      injected.push(keys.join(','));
      const payload = { logger, effect: (fn, name) => { effects.push({ fn, name }); }, };
      if (keys.includes('storageDomain')) payload.storageDomain = facility;
      if (keys.includes('timer')) payload.timer = timerInterval ? { interval: timerInterval } : undefined;
      if (keys.includes('webServer')) { payload.webServer = webServer; }
      cb(payload);
      return Promise.resolve();
    },
    effect(fn, name) { effects.push({ fn, name }); },
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); },
    emit(ev, arg) { for (const fn of handlers.get(ev) || []) fn(arg); },
    slots: {
      inject(name, fn) { slots.injectCalls.push(name); const disposer = fn(); if (typeof disposer === 'function') effects.push({ fn: disposer, name: `slot:${name}` }); },
      register(spec, component) { slots.registered.push({ spec, component }); return () => { slots.registered.pop(); }; },
    },
    _internals: { logs, effects, injected, slots, handlers },
  };
  return ctx;
}

/** 跑掉微任务队列（SSE/假 fetch 之后断言用）。 */
export async function flush(ms = 5) {
  await new Promise((r) => setTimeout(r, ms));
}
