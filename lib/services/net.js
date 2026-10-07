/**
 * lib/services/net.js —— 出网传输层：直连仍走宿主的全局 fetch，代理走插件自带的 CONNECT 隧道。
 *
 * 为什么非要自己写隧道（2026-10-05 实测）：
 *   · github.com/trending 直连 10.01s 超时（UND_ERR_CONNECT_TIMEOUT），同一台机经 127.0.0.1:7897 是 200 / 2.06s；
 *   · Node 24 的全局 fetch 只在**进程启动前**认 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`，
 *     运行中改 `process.env` 没有任何效果；`NODE_USE_ENV_PROXY` 已经设好时它又不认注册表，
 *     而插件是挂在 dsh 宿主进程里的，启动环境不由插件决定；
 *   · undici 的 `ProxyAgent` / `EnvHttpProxyAgent` 不是 Node 内建模块，import 它就等于引第三方依赖（铁律）。
 *   所以剩下唯一干净的路：自己拿 `node:net` 发 CONNECT，再把 `node:tls` 接上去，
 *   HTTP 语义仍交给内建 `node:https` —— 全链路只用 Node 内建模块。
 *
 * 代理地址的来源优先级（spec §5.2）：设置页自定义 > 环境变量 > Windows 注册表 > 没有（直连）。
 * 读注册表是**只读** `reg query`，且只在 `proxyMode=system` 且环境变量没给时才发起；结果带 TTL 缓存。
 *
 * 失败绝不静默回落直连：代理坏了就报代理坏在哪一步，回落会把「配了个不通的代理」伪装成
 * 「网络不通」，用户就没法从故障文案里分辨该改设置还是该等网络。
 */
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as https from 'node:https';
import { execFile } from 'node:child_process';
import { PROXY_ENV_ORDER, PROXY_REGISTRY_KEY, PROXY_TUNNEL_TIMEOUT_MS, PROXY_REGISTRY_TTL_MS } from '../domain.js';

/** 本层只认 http:// 代理（ CONNECT 走明文 TCP）。socks / https 代理直接点名拒绝，不假装支持。 */
const PROXY_SCHEME_RE = /^([a-z][a-z0-9]*):\/\//i;

/** 一个仓库都取不到时的错误码 → 给人看的说法（界面直接念，不再拼第二份文案）。 */
export const PROXY_ERROR = {
  bad_url: '代理地址形状不合法',
  scheme_unsupported: '只支持 http:// 代理（CONNECT 隧道），socks 与 https 代理未实现',
  unreachable: '连不上代理',
  refused: '代理拒绝了 CONNECT',
  auth: '代理要求认证，但地址里没有用户名/密码',
  timeout: '代理隧道建立超时',
  tls: '隧道已通但 TLS 握手失败',
};

/* ------------------------------------------------------------------ *
 * 地址解析
 * ------------------------------------------------------------------ */

/** host 允许 IPv4 / IPv6（带方括号）/ 名字；port 必须是数字。 */
function hostPortFrom(authority) {
  const raw = String(authority ?? '').trim();
  if (!raw) return { ok: false, reason: '代理地址为空' };
  if (raw.startsWith('[')) {
    const m = raw.match(/^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/);
    if (!m) return { ok: false, reason: `IPv6 代理要写成 [地址]:端口，收到 ${raw}` };
    return { ok: true, host: m[1], port: Number(m[2]), bracket: true };
  }
  const i = raw.lastIndexOf(':');
  if (i < 0) return { ok: false, reason: `代理地址缺端口（要 host:port），收到 ${raw}` };
  const host = raw.slice(0, i).trim();
  const port = Number(raw.slice(i + 1));
  if (!host) return { ok: false, reason: `代理地址缺主机名，收到 ${raw}` };
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: `代理端口不合法：${raw.slice(i + 1)}` };
  return { ok: true, host, port };
}

/**
 * 解析用户/环境/注册表给的代理串。支持 `127.0.0.1:7897`、`http://127.0.0.1:7897`、
 * `http://user:pass@host:port`（凭据只用于 Proxy-Authorization，**出界面必打码**）。
 * @returns {{ok:true, host, port, auth, url} | {ok:false, reason}}
 */
export function parseProxyUrl(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: false, reason: '没有给出代理地址' };
  const schemeM = input.match(PROXY_SCHEME_RE);
  if (schemeM) {
    const scheme = schemeM[1].toLowerCase();
    if (scheme !== 'http') {
      const known = ['https', 'socks5', 'socks5d', 'socks4', 'socks4a'].includes(scheme);
      return {
        ok: false,
        reason: known
          ? `${PROXY_ERROR.scheme_unsupported}（收到 ${scheme}://）`
          : `${PROXY_ERROR.bad_url}：认不出的协议前缀 ${scheme}://（只支持 http://，或干脆只写 host:port）`,
      };
    }
  }
  const withoutScheme = input.replace(/^[a-z]+:\/\//i, '');
  const at = withoutScheme.lastIndexOf('@');
  const authority = at >= 0 ? withoutScheme.slice(at + 1) : withoutScheme;
  const userinfo = at >= 0 ? withoutScheme.slice(0, at) : '';
  const cut = authority.search(/[/]/);
  const bare = cut >= 0 ? authority.slice(0, cut) : authority;
  const hp = hostPortFrom(bare);
  if (!hp.ok) return hp;
  let auth = '';
  if (userinfo) {
    const [u, p] = userinfo.split(':');
    if (!u) return { ok: false, reason: '代理地址给了密码却没给用户名' };
    auth = Buffer.from(`${decodeURIComponent(u)}:${decodeURIComponent(p ?? '')}`, 'utf8').toString('base64');
  }
  return {
    ok: true,
    host: hp.host,
    port: hp.port,
    bracket: hp.bracket === true,
    auth,
    url: `http://${hp.bracket ? `[${hp.host}]` : hp.host}:${hp.port}`,
  };
}

/** 打码后的地址，给界面与日志用 —— 绝不把密码带出进程边界。 */
export function maskProxyUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const at = s.lastIndexOf('@');
  if (at < 0) return s;
  const scheme = (s.match(/^[a-z]+:\/\//i) || [''])[0];
  return `${scheme}***@${s.slice(at + 1)}`;
}

/* ------------------------------------------------------------------ *
 * 来源：环境变量 / 注册表
 * ------------------------------------------------------------------ */

/** 环境变量优先序来自 domain.js（一份真相）；空串与纯空格算没设。 */
export function envProxy(env = {}) {
  for (const name of PROXY_ENV_ORDER) {
    const v = env?.[name];
    if (typeof v === 'string' && v.trim()) return { name, url: v.trim() };
  }
  return null;
}

/**
 * 解析 `reg query` 的文本输出。只认三行：ProxyEnable / ProxyServer / ProxyOverride。
 * 形状：`    ProxyServer    REG_SZ    127.0.0.1:7897`
 * 缺行 = 该值没设（不是错误）；ProxyEnable 认 0x1 与 1 两种写法。
 */
export function parseRegistryValues(stdout) {
  const out = { proxyEnable: null, proxyServer: '', proxyOverride: '' };
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s+([A-Za-z][A-Za-z0-9]*)\s+REG_[A-Z_]+\s+(.*)$/);
    if (!m) continue;
    const [, name, valueRaw] = m;
    const value = valueRaw.trim();
    if (name === 'ProxyEnable') {
      const n = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value);
      out.proxyEnable = Number.isFinite(n) ? n !== 0 : null;
    } else if (name === 'ProxyServer') out.proxyServer = value;
    else if (name === 'ProxyOverride') out.proxyOverride = value;
  }
  return out;
}

/**
 * 注册表里的系统代理（Windows）。
 * 一次 `reg query` 把那一键的全部值打出来（不用 /v 逐值查：那是三次 spawn，而值不存在时 reg 会当成错误退出）。
 * 非 Windows / reg 不可用 / 超时都算「没读到」，不算故障 —— 这一路读不到就继续按「没有代理」处理，
 * 因为读不到不等于网络坏，把它报成网络故障会把用户的注意力引向错误的一侧。
 */
export async function registryProxy({
  platform = process.platform, key = PROXY_REGISTRY_KEY,
  runReg = defaultRunReg, timeoutMs = 2000,
} = {}) {
  if (platform !== 'win32') return { ok: true, enabled: false, server: '', override: '', reason: '' };
  let read;
  try {
    read = await runReg(key, timeoutMs);
  } catch (e) {
    return { ok: false, enabled: false, server: '', override: '', reason: `读注册表失败（${e?.message ?? e}）` };
  }
  const values = parseRegistryValues(read?.stdout ?? '');
  if (values.proxyEnable === null) {
    return { ok: false, enabled: false, server: '', override: '', reason: `reg query 没给出 ProxyEnable（退出码 ${read?.code ?? '?'}）` };
  }
  return {
    ok: true,
    enabled: values.proxyEnable === true,
    server: values.proxyServer ?? '',
    override: values.proxyOverride ?? '',
    reason: values.proxyEnable === false ? '系统「使用代理服务器」是关的' : '',
  };
}

function defaultRunReg(key, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('reg', ['query', key], { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') return reject(new Error('reg 命令不可用'));
        if (err?.killed || err?.code === 'ETIMEDOUT') return reject(new Error(`reg query 超时（${timeoutMs}ms）`));
        resolve({ code: err ? Number(err.code ?? 1) : 0, stdout: stdout || String(stderr || '') });
      });
  });
}

/**
 * 代理例外列表（ProxyOverride）匹配：`localhost`、`127.*`、`*.example.com`、精确主机名。
 * 只做「这个目标要不要绕开代理」的判断，不猜 CIDR —— 我们的出网目标只有三个公网域，
 * 例外命中不了；写宽了反而会把「该走代理的」悄悄放直连，那正是本次故障的形状。
 */
export function bypassMatch(host, override) {
  const h = String(host ?? '').toLowerCase();
  if (!h) return false;
  return String(override ?? '').split(';').map((s) => s.trim().toLowerCase()).filter(Boolean).some((rule) => {
    if (rule === '<-loopback>' || rule.startsWith('<')) return false;
    if (rule.startsWith('*.')) return h.endsWith(rule.slice(1)) || h === rule.slice(2);
    if (rule.endsWith('.*')) {
      const prefix = rule.slice(0, -2);
      return h === prefix || h.startsWith(`${prefix}.`);
    }
    return h === rule;
  });
}

/* ------------------------------------------------------------------ *
 * 来源仲裁
 * ------------------------------------------------------------------ */

/**
 * 决定这一发请求走哪里。纯函数（不碰注册表），方便把四种组合都断言一遍：
 * @param prefs  至少含 proxyMode / proxyUrl
 * @param env    process.env 形状
 * @param sys    registryProxy() 的结果
 */
export function decideRoute({ prefs = {}, env = {}, sys = null, targetHost = '' }) {
  const mode = prefs.proxyMode === 'custom' || prefs.proxyMode === 'direct' || prefs.proxyMode === 'system'
    ? prefs.proxyMode : 'system';
  if (mode === 'direct') return { via: 'direct', source: 'mode:direct', proxy: null, reason: '' };
  if (mode === 'custom') {
    const p = parseProxyUrl(prefs.proxyUrl);
    if (!p.ok) return { via: 'failed', source: 'custom', proxy: null, reason: `自定义代理地址不可用：${p.reason}` };
    return { via: 'proxy', source: 'custom', proxy: p, reason: '' };
  }
  const e = envProxy(env);
  if (e) {
    const p = parseProxyUrl(e.url);
    if (!p.ok) return { via: 'failed', source: `env:${e.name}`, proxy: null, reason: `环境变量 ${e.name} 里的代理地址不可用：${p.reason}` };
    return { via: 'proxy', source: `env:${e.name}`, proxy: p, reason: '' };
  }
  if (sys && sys.ok === false) return { via: 'direct', source: 'registry-unreadable', proxy: null, reason: sys.reason };
  if (sys?.enabled && sys.server) {
    if (bypassMatch(targetHost, sys.override)) {
      return { via: 'direct', source: 'bypass', proxy: null, reason: '目标命中系统代理例外，直连' };
    }
    const p = parseProxyUrl(sys.server);
    if (!p.ok) return { via: 'failed', source: 'registry', proxy: null, reason: `系统代理地址不可用：${p.reason}` };
    return { via: 'proxy', source: 'registry', proxy: p, reason: '' };
  }
  return { via: 'direct', source: 'none', proxy: null, reason: sys?.reason ?? '没配系统代理，直连' };
}

/* ------------------------------------------------------------------ *
 * CONNECT 隧道
 * ------------------------------------------------------------------ */

const TUNNEL_MAX_BYTES = 16 * 1024;

/**
 * 向代理发 CONNECT，拿到一条已建立的空 socket。
 * 单测吃 fakeNet 注入：只验字节与响应解析，不碰真网络（真网络读数见 tmp/probe-proxy.mjs）。
 */
export function openTunnel({
  proxy, targetHost, targetPort = 443, timeoutMs = PROXY_TUNNEL_TIMEOUT_MS,
  fakeNet = null,
} = {}) {
  const netMod = fakeNet ?? net;
  return new Promise((resolve, reject) => {
    if (!proxy || !proxy.host) { reject(new Error(`${PROXY_ERROR.bad_url}（内部：没解析出代理地址）`)); return; }
    const socket = netMod.connect(proxy.port, proxy.host);
    if (!socket || typeof socket.on !== 'function') { reject(new Error(`${PROXY_ERROR.unreachable}（代理实现没给回 socket）`)); return; }
    socket.setNoDelay?.(true);

    const head = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      'User-Agent: dsh-plugin-gh-trending',
      ...(proxy.auth ? [`Proxy-Authorization: Basic ${proxy.auth}`] : []),
      '', '',
    ].join('\r\n');

    let buf = '';
    let done = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
      fn(arg);
    };
    const fail = (message, code) => {
      const e = new Error(message);
      e.code = code;
      e.proxy = { host: proxy.host, port: proxy.port };
      socket.destroy();
      finish(reject, e);
    };
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.length > TUNNEL_MAX_BYTES) { fail(`${PROXY_ERROR.refused}：隧道响应超过 ${TUNNEL_MAX_BYTES} 字节`, 'proxy_bad_gateway'); return; }
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const firstLine = buf.indexOf('\r\n');
      const statusLine = firstLine >= 0 && firstLine < sep ? buf.slice(0, firstLine) : buf.slice(0, sep);
      const rest = Buffer.from(buf.slice(sep + 4), 'latin1');
      const code = Number((statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1]);
      if (code === 200) {
        // 200 之后同一包里可能已经带进 TLS 字节；退回读队列，交给下一步 tls.connect
        if (rest.length) socket.unshift(rest);
        finish(resolve, socket);
        return;
      }
      const reasonText = statusLine.split(/\s+/).slice(2).join(' ');
      if (code === 407) {
        fail(`${PROXY_ERROR.auth}${reasonText ? `（${reasonText}）` : ''}`, 'proxy_auth');
        return;
      }
      fail(`${PROXY_ERROR.refused} ${Number.isFinite(code) ? code : '（响应无法解析）'}${reasonText ? ` ${reasonText}` : ''}`, 'proxy_refused');
    };
    const onErr = (e) => {
      const code = e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND' || e?.code === 'EHOSTUNREACH' ? 'proxy_unreachable' : (e?.code ?? 'proxy_error');
      fail(`${PROXY_ERROR.unreachable} ${proxy.host}:${proxy.port}（${e?.message ?? e}）`, code);
    };
    const onClose = () => fail(`${PROXY_ERROR.refused}：代理在回 CONNECT 响应前就关掉了连接`, 'proxy_closed');

    timer = setTimeout(() => fail(`${PROXY_ERROR.timeout}（${Math.round(timeoutMs / 1000)}s 内代理没回 CONNECT 响应）`, 'proxy_timeout'), timeoutMs);
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
    socket.write(head);
  });
}

/** 隧道之上接 TLS，得到一个可用于 https 请求的 TLS socket。 */
async function tlsOverTunnel({ proxy, targetHost, targetPort = 443, timeoutMs, fakeNet, fakeTls = null }) {
  const socket = await openTunnel({ proxy, targetHost, targetPort, timeoutMs, fakeNet });
  const tlsMod = fakeTls ?? tls;
  return new Promise((resolve, reject) => {
    const secure = tlsMod.connect({
      socket,
      servername: targetHost,
      ALPNProtocols: ['http/1.1'],
      timeout: timeoutMs,
    });
    const fail = (e) => {
      const err = e instanceof Error ? e : new Error(String(e));
      err.code = err.code || 'proxy_tls';
      err.message = `${PROXY_ERROR.tls}：${err.message}`;
      try { socket.destroy(); } catch { /* 已经在坏了 */ }
      reject(err);
    };
    secure.once('error', fail);
    secure.once('secureConnect', () => {
      secure.removeListener('error', fail);
      resolve(secure);
    });
  });
}

/** 把隧道封成 https.Agent：Node 负责 HTTP 语义，这里只管「这条连接从哪来」。 */
export function createTunnelAgent(connectOpts = {}) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const host = options.host || options.hostname || options.servername;
    const port = Number(options.port) || 443;
    tlsOverTunnel({ ...connectOpts, targetHost: host, targetPort: port })
      .then((socket) => callback(null, socket), (e) => callback(e));
  };
  return agent;
}

/** 最小 Response 形状：gh.js 只用 status / ok / headers.get / text，多一个字段都不给。 */
function netResponse({ url, status, headers, body, redirects }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers ?? {})) lower[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    redirected: redirects > 0,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

function onceData(req, { timeoutMs, signal, reject, resolve, bodyOf }) {
  if (signal) {
    if (signal.aborted) { req.destroy(new Error('Aborted')); return; }
    signal.addEventListener?.('abort', () => req.destroy(new Error('Aborted')), { once: true });
  }
  const timer = timeoutMs ? setTimeout(() => {
    req.destroy(Object.assign(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`), { code: 'ETIMEDOUT' }));
  }, timeoutMs) : null;
  req.on('response', (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      if (timer) clearTimeout(timer);
      resolve(bodyOf(res, Buffer.concat(chunks).toString('utf8')));
    });
    res.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
  });
  req.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
}

/**
 * 经隧道发一次 GET（含 3xx 跟进）。`httpsMod` / `agentFactory` 是测试注入口（不碰真网络），
 * 生产走 node:https + createTunnelAgent。
 */
export async function tunnelRequest(url, {
  headers = {}, timeoutMs = 30000, signal = null, maxRedirects = 5,
  connect = {}, httpsMod = https, agentFactory = createTunnelAgent,
} = {}) {
  const agent = agentFactory(connect);
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const u = new URL(current);
    if (u.protocol !== 'https:') {
      const e = new Error(`隧道只支持 https 目标，收到 ${u.protocol}//${u.host}`);
      e.code = 'proxy_target_scheme';
      throw e;
    }
    const res = await new Promise((resolve, reject) => {
      const req = httpsMod.request({
        agent,
        hostname: u.hostname,
        port: 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        // accept-encoding 必须是 identity：node:https 不会自动解压，而全局 fetch 会 ——
        // 不显式要原文的话，gzip 字节会直接进 HTML 解析器，读出「一条榜单条目都没有」。
        headers: { Host: u.hostname, 'accept-encoding': 'identity', ...headers },
        servername: u.hostname,
      }, () => {});
      onceData(req, {
        timeoutMs,
        signal,
        reject,
        resolve,
        bodyOf: (r, body) => ({ status: r.statusCode ?? 0, headers: r.headers ?? {}, body, location: r.headers?.location ?? '' }),
      });
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location && hop < maxRedirects) {
      current = new URL(res.location, current).toString();
      continue;
    }
    // 跟满 maxRedirects 还没落地的，就把最后一个 3xx 原样交回去（与 fetch 同形）：
    // 让调用方看见 302 比编一个「重定向过多」的假错误更诚实。
    return netResponse({ url: current, status: res.status, headers: res.headers, body: res.body, redirects: hop });
  }
}

/* ------------------------------------------------------------------ *
 * 传输层门面
 * ------------------------------------------------------------------ */

/**
 * @param getPrefs  读当前偏好（proxyMode / proxyUrl）
 * @param fetchFn   直连用的 fetch，默认宿主全局 fetch
 */
export function createNetTransport({
  getPrefs = () => ({}),
  env = process.env,
  platform = process.platform,
  fetchFn = globalThis.fetch,
  runReg,
  registryRead = registryProxy,
  registryTtlMs = PROXY_REGISTRY_TTL_MS,
  timeoutMs = 30000,
  tunnelRequestFn = tunnelRequest,
  logger,
} = {}) {
  let sysCache = null;         // { at, value }
  let last = null;             // 最近一次仲裁结果，界面念「这一发走了哪条路」
  let pending = null;

  function sysFresh(nowMs) {
    return sysCache && nowMs - sysCache.at < registryTtlMs ? sysCache.value : null;
  }

  async function ensureSys(now) {
    const cached = sysFresh(now());
    if (cached) return cached;
    if (!pending) {
      pending = Promise.resolve()
        .then(() => registryRead({ platform, runReg }))
        .then((value) => { sysCache = { at: now(), value }; return value; })
        .catch((e) => {
          const value = { ok: false, enabled: false, server: '', override: '', reason: `读系统代理失败：${e?.message ?? e}` };
          sysCache = { at: now(), value };
          return value;
        })
        .finally(() => { pending = null; });
    }
    return pending;
  }

  /** 每次出网前仲裁一次；结果留在 last 里供界面与能力表读。 */
  async function routeFor(targetHost) {
    const prefs = getPrefs() ?? {};
    const sys = prefs.proxyMode === 'custom' || prefs.proxyMode === 'direct' ? null : await ensureSys(Date.now);
    const route = decideRoute({ prefs, env, sys, targetHost });
    last = { ...route, at: Date.now(), targetHost };
    if (route.via === 'failed') logger?.warn?.(`[gh-trending] ${route.reason}`);
    return route;
  }

  /** 与全局 fetch 同形（gh.js 那边只认这一套字段）。 */
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const route = await routeFor(u.hostname);
    if (route.via === 'proxy') {
      return tunnelRequestFn(url, {
        headers: { ...(init.headers ?? {}) },
        timeoutMs: init.timeoutMs ?? timeoutMs,
        signal: init.signal ?? null,
        connect: { proxy: route.proxy, timeoutMs: PROXY_TUNNEL_TIMEOUT_MS },
      });
    }
    if (route.via === 'failed') {
      const e = new Error(route.reason);
      e.code = 'proxy_config';
      throw e;
    }
    return fetchFn(url, init);
  }

  return {
    fetch,
    /** 界面/日志用的实话：走了哪条路、代理地址（打码）、为什么。 */
    describe() {
      if (!last) return { via: 'idle', source: '', proxy: '', reason: '' };
      return {
        via: last.via,
        source: last.source,
        proxy: last.proxy ? maskProxyUrl(last.proxy.url) : '',
        reason: last.reason ?? '',
        targetHost: last.targetHost ?? '',
        at: last.at ?? 0,
      };
    },
    /** 偏好改动后作废注册表缓存，下一发立刻按新地址仲裁。 */
    invalidate() { sysCache = null; },
    get lastRoute() { return last ? { ...last } : null; },
  };
}
