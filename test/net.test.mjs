/**
 * test/net.test.mjs —— 传输层（lib/services/net.js）。
 *
 * 全部离线：CONNECT 的字节与响应解析吃假 socket，注册表吃假 runReg，隧道请求吃注入的 tunnelRequestFn。
 * 真网络读数不在这里（那属于「真机」用例，走 tmp/probe-proxy.mjs，2026-10-05 已量过：
 * 注册表 → 127.0.0.1:7897，隧道取回趋势页 200 / 6.50s / 16 行，api.github.com 200 / 0.39s，限额 60/59）。
 */
import { check, runAll, assert } from './_helpers.mjs';
import {
  parseProxyUrl, maskProxyUrl, envProxy, parseRegistryValues, registryProxy,
  bypassMatch, decideRoute, openTunnel, createNetTransport, tunnelRequest, createTunnelAgent,
} from '../lib/services/net.js';
import { transportHint, TRANSPORT_HINT, PROXY_ENV_ORDER } from '../lib/domain.js';

const SYS = {
  ok: true,
  enabled: true,
  server: '127.0.0.1:7897',
  override: 'localhost;127.*;<local>',
  reason: '',
};

/* ---------------- 地址解析 ---------------- */
check('parseProxyUrl：host:port / 带协议 / IPv6 / 凭据都认，端口与协议不认就点名', () => {
  assert.deepEqual(parseProxyUrl('127.0.0.1:7897'), { ok: true, host: '127.0.0.1', port: 7897, bracket: false, auth: '', url: 'http://127.0.0.1:7897' });
  assert.equal(parseProxyUrl(' http://127.0.0.1:7897 ').ok, true);
  assert.equal(parseProxyUrl('[::1]:8888').host, '::1');
  assert.equal(parseProxyUrl('[::1]:8888').bracket, true);
  assert.equal(parseProxyUrl('proxy.internal:3128').host, 'proxy.internal');
  // 凭据进 base64（Proxy-Authorization 直接用它），地址里不再带明文
  const withAuth = parseProxyUrl('http://bob:p%40ss@10.0.0.2:8080');
  assert.equal(withAuth.ok, true);
  assert.equal(Buffer.from(withAuth.auth, 'base64').toString('utf8'), 'bob:p@ss');
  assert.equal(withAuth.url, 'http://10.0.0.2:8080');
});

check('parseProxyUrl：缺端口 / socks / https / 认不出的前缀，四条报错各说各的', () => {
  for (const [raw, needle] of [
    ['', '没有给出代理地址'],
    ['127.0.0.1', '缺端口'],
    ['http://:8080', '缺主机名'],
    ['127.0.0.1:0', '端口不合法'],
    ['127.0.0.1:99999', '端口不合法'],
    ['socks5://127.0.0.1:1080', '只支持 http:// 代理'],
    ['https://127.0.0.1:8118', '只支持 http:// 代理'],
    ['ftp://127.0.0.1:21', '认不出的协议前缀'],
    ['http://:8080@x:1', '没给用户名'],
  ]) {
    const r = parseProxyUrl(raw);
    assert.equal(r.ok, false, `${raw} 应当被拒`);
    assert.match(r.reason, new RegExp(needle), `${raw} 的报错要说清「${needle}」`);
  }
});

check('maskProxyUrl：密码不出进程边界，没凭据时原样', () => {
  assert.equal(maskProxyUrl('http://bob:secret@10.0.0.2:8080'), 'http://***@10.0.0.2:8080');
  assert.equal(maskProxyUrl('127.0.0.1:7897'), '127.0.0.1:7897');
  assert.equal(maskProxyUrl(''), '');
});

/* ---------------- 来源：环境变量与注册表 ---------------- */
check('envProxy：按 domain 的优先序取，空串与纯空格算没设', () => {
  assert.deepEqual(Object.keys(envProxy({ HTTP_PROXY: 'http://a:1' })), ['name', 'url']);
  assert.equal(envProxy({ HTTPS_PROXY: 'http://h:1', ALL_PROXY: 'http://a:1', HTTP_PROXY: 'http://e:1' }).name, 'HTTPS_PROXY');
  assert.equal(envProxy({ all_proxy: 'http://a:1', HTTP_PROXY: 'http://e:1' }).name, 'all_proxy');
  assert.equal(envProxy({ HTTPS_PROXY: '  ', HTTP_PROXY: 'http://e:1' }).url, 'http://e:1');
  assert.equal(envProxy({}), null);
  assert.equal(envProxy(), null);
  // 优先序本身在 domain.js（一份真相），这里断言它没被谁偷偷改过顺序
  assert.deepEqual(PROXY_ENV_ORDER, ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']);
});

check('parseRegistryValues：只认那三行，0x1/1 都算开，缺行算没设', () => {
  const real = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    ProxyEnable    REG_DWORD    0x1',
    '    ProxyServer    REG_SZ    127.0.0.1:7897',
    '    ProxyOverride    REG_SZ    localhost;127.*;<local>',
    '',
  ].join('\r\n');
  assert.deepEqual(parseRegistryValues(real), { proxyEnable: true, proxyServer: '127.0.0.1:7897', proxyOverride: 'localhost;127.*;<local>' });
  assert.equal(parseRegistryValues('    ProxyEnable    REG_DWORD    0x0').proxyEnable, false);
  assert.equal(parseRegistryValues('    ProxyEnable    REG_DWORD    1').proxyEnable, true);
  assert.equal(parseRegistryValues('    ProxyEnable    REG_DWORD    0').proxyEnable, false);
  assert.deepEqual(parseRegistryValues(' nonsense \n not-a-value-line'), { proxyEnable: null, proxyServer: '', proxyOverride: '' });
});

check('registryProxy：非 Windows 不 spawn；reg 抛错说「读不到」；ProxyEnable 关着说人话', async () => {
  let calls = 0;
  const off = await registryProxy({ platform: 'linux', runReg: () => { calls += 1; return Promise.resolve({ code: 0, stdout: '' }); } });
  assert.equal(off.enabled, false);
  assert.equal(calls, 0, '非 Windows 一次都不该 spawn reg');

  const on = await registryProxy({ platform: 'win32', runReg: () => Promise.resolve({ code: 0, stdout: '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7897' }) });
  assert.deepEqual([on.ok, on.enabled, on.server], [true, true, '127.0.0.1:7897']);

  const disabled = await registryProxy({ platform: 'win32', runReg: () => Promise.resolve({ code: 0, stdout: '    ProxyEnable    REG_DWORD    0x0' }) });
  assert.equal(disabled.enabled, false);
  assert.match(disabled.reason, /是关的/);

  const broken = await registryProxy({ platform: 'win32', runReg: () => Promise.reject(new Error('reg 命令不可用')) });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /读注册表失败/);

  const noKey = await registryProxy({ platform: 'win32', runReg: () => Promise.resolve({ code: 1, stdout: 'ERROR: 系统找不到指定的注册表项或值。' }) });
  assert.equal(noKey.ok, false, '连 ProxyEnable 都没读到就是读失败，不能假装「没配代理」');
});

check('bypassMatch：localhost / 127.* / *.内网 命中，公网目标与 <local> 哨兵不误伤', () => {
  const o = SYS.override;
  assert.equal(bypassMatch('localhost', o), true);
  assert.equal(bypassMatch('127.0.0.1', o), true);
  assert.equal(bypassMatch('github.com', o), false);
  assert.equal(bypassMatch('api.github.com', 'internal.corp;*.corp.example'), false);
  assert.equal(bypassMatch('a.corp.example', 'internal.corp;*.corp.example'), true);
  assert.equal(bypassMatch('192.168.1.9', '192.168.*'), true);
  assert.equal(bypassMatch('192168109.x', '192.168.*'), false, '前缀匹配要按点分段，别把 192168* 也算内网');
  assert.equal(bypassMatch('x', ''), false);
});

/* ---------------- 来源仲裁 ---------------- */
check('decideRoute：自定义 > 环境变量 > 注册表 > 直连，四种来源各有各的记法', () => {
  const env = { HTTPS_PROXY: 'http://env-proxy:8888' };
  const custom = decideRoute({ prefs: { proxyMode: 'custom', proxyUrl: '10.9.9.9:3128' }, env, sys: SYS, targetHost: 'github.com' });
  assert.deepEqual([custom.via, custom.source, custom.proxy.host], ['proxy', 'custom', '10.9.9.9']);

  const auto = decideRoute({ prefs: { proxyMode: 'system' }, env, sys: SYS, targetHost: 'github.com' });
  assert.deepEqual([auto.via, auto.source, auto.proxy.host], ['proxy', 'env:HTTPS_PROXY', 'env-proxy']);

  const reg = decideRoute({ prefs: { proxyMode: 'system' }, env: {}, sys: SYS, targetHost: 'github.com' });
  assert.deepEqual([reg.via, reg.source, reg.proxy.port], ['proxy', 'registry', 7897]);

  const direct = decideRoute({ prefs: { proxyMode: 'direct' }, env, sys: SYS, targetHost: 'github.com' });
  assert.deepEqual([direct.via, direct.source], ['direct', 'mode:direct']);

  const none = decideRoute({ prefs: {}, env: {}, sys: { ok: true, enabled: false, server: '', override: '', reason: '' }, targetHost: 'github.com' });
  assert.deepEqual([none.via, none.source], ['direct', 'none']);
});

check('decideRoute：坏地址说清坏在哪、例外命中转直连、注册表读不到仍按直连但留原因', () => {
  const bad = decideRoute({ prefs: { proxyMode: 'custom', proxyUrl: 'not-an-address' }, env: {}, sys: null, targetHost: 'github.com' });
  assert.equal(bad.via, 'failed');
  assert.match(bad.reason, /自定义代理地址不可用/);

  const badEnv = decideRoute({ prefs: { proxyMode: 'system' }, env: { HTTPS_PROXY: 'socks5://1.2.3.4:1080' }, sys: SYS, targetHost: 'github.com' });
  assert.equal(badEnv.via, 'failed');
  assert.match(badEnv.reason, /HTTPS_PROXY/);
  assert.match(badEnv.reason, /只支持 http/);

  const bypassed = decideRoute({ prefs: { proxyMode: 'system' }, env: {}, sys: SYS, targetHost: 'localhost' });
  assert.deepEqual([bypassed.via, bypassed.source], ['direct', 'bypass']);

  const unreadable = decideRoute({ prefs: { proxyMode: 'system' }, env: {}, sys: { ok: false, enabled: false, server: '', override: '', reason: '读注册表失败（x）' }, targetHost: 'github.com' });
  assert.equal(unreadable.via, 'direct', '读不到注册表不是故障，直连继续试');
  assert.match(unreadable.reason, /读注册表失败/);

  const unset = decideRoute({ prefs: { proxyMode: 'system' }, env: {}, sys: { ok: true, enabled: false, server: '', override: '', reason: '系统「使用代理服务器」是关的' }, targetHost: 'github.com' });
  assert.match(unset.reason, /是关的/);
});

/* ---------------- CONNECT 隧道：字节与响应 ---------------- */
function fakeSocket() {
  const listeners = new Map();
  const sock = {
    written: [],
    unshifted: [],
    destroyed: false,
    connectError: null,
    on(ev, fn) { listeners.set(ev, (listeners.get(ev) ?? []).concat(fn)); },
    once(ev, fn) { sock.on(ev, fn); },
    removeListener(ev, fn) { listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn)); },
    emit(ev, ...args) { for (const fn of (listeners.get(ev) ?? []).slice()) fn(...args); },
    write(b) { sock.written.push(String(b)); },
    unshift(b) { sock.unshifted.push(b); },
    destroy() { sock.destroyed = true; },
    setNoDelay() {},
  };
  return sock;
}

function withTunnel(extra = {}) {
  const sock = fakeSocket();
  const connects = [];
  const fakeNet = { connect: (port, host) => { connects.push([port, host]); return sock; } };
  const promise = openTunnel({
    proxy: extra.proxy ?? { host: '127.0.0.1', port: 7897, auth: extra.auth ?? '' },
    targetHost: extra.targetHost ?? 'github.com',
    targetPort: extra.targetPort ?? 443,
    timeoutMs: extra.timeoutMs ?? 2000,
    fakeNet,
  }).then((s) => ({ sock, connects, s }), (e) => ({ sock, connects, e }));
  return { sock, connects, promise, emit: (text) => sock.emit('data', Buffer.from(text, 'latin1')) };
}

check('openTunnel：CONNECT 请求行的字节逐个定死（代理靠这三行放行）', async () => {
  const t = withTunnel();
  assert.deepEqual(t.connects, [[7897, '127.0.0.1']], '先连代理的地址端口，不是目标的');
  const head = t.sock.written.join('');
  assert.equal(head, 'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nUser-Agent: dsh-plugin-gh-trending\r\n\r\n');
  assert.ok(head.endsWith('\r\n\r\n'));
  t.emit('HTTP/1.1 200 Connection established\r\n\r\n');
  assert.ok((await t.promise).s);
});

check('openTunnel：带凭据才发 Proxy-Authorization，值就是 parseProxyUrl 的 base64', async () => {
  const auth = Buffer.from('bob:p@ss', 'utf8').toString('base64');
  const t = withTunnel({ proxy: { host: '10.0.0.2', port: 8080, auth } });
  t.emit('HTTP/1.1 200 OK\r\n\r\n');
  const res = await t.promise;
  assert.match(res.sock.written.join(''), new RegExp(`Proxy-Authorization: Basic ${auth}`));
});

check('openTunnel：200 之后同包带来的 TLS 字节 unshift 回读队列，一个都不丢', async () => {
  const t = withTunnel();
  t.emit('HTTP/1.1 200 Connection established\r\n\r\n\x16\x03\x01\x00\x05hello');
  const res = await t.promise;
  assert.equal(res.s, res.sock);
  assert.equal(res.sock.unshifted.length, 1, '剩下的字节要退回读队列，否则 tls.connect 看不到 ServerHello 开头');
  assert.equal(res.sock.unshifted[0].toString('latin1'), '\x16\x03\x01\x00\x05hello');
});

check('openTunnel：407/502/关闭/连不上/超时 五样各给一句话，且都 destroy', async () => {
  const one = async (response, extra) => {
    const t = withTunnel(extra);
    if (response) t.emit(response);
    return t.promise;
  };
  const auth = await one('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  assert.equal(auth.e.code, 'proxy_auth');
  assert.match(auth.e.message, /代理要求认证/);
  assert.equal(auth.sock.destroyed, true);

  const bad = await one('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  assert.equal(bad.e.code, 'proxy_refused');
  assert.match(bad.e.message, /代理拒绝了 CONNECT 502/);

  const weird = await one('not-a-status-line\r\n\r\n');
  assert.equal(weird.e.code, 'proxy_refused');
  assert.match(weird.e.message, /响应无法解析/, '状态行读不出数字也要如实说，别当成功放行');

  const closed = fakeSocket();
  const closedP = openTunnel({
    proxy: { host: '127.0.0.1', port: 7897, auth: '' }, targetHost: 'github.com', targetPort: 443, timeoutMs: 2000,
    fakeNet: { connect: () => closed },
  }).catch((e) => e);
  closed.emit('close');
  const closedE = await closedP;
  assert.equal(closedE.code, 'proxy_closed');
  assert.match(closedE.message, /关掉/);

  const refused = fakeSocket();
  const refusedP = openTunnel({
    proxy: { host: '127.0.0.1', port: 7897, auth: '' }, targetHost: 'github.com', targetPort: 443, timeoutMs: 2000,
    fakeNet: { connect: () => refused },
  }).catch((e) => e);
  refused.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7897'), { code: 'ECONNREFUSED' }));
  const refusedE = await refusedP;
  assert.equal(refusedE.code, 'proxy_unreachable');
  assert.match(refusedE.message, /连不上代理 127\.0\.0\.1:7897/);

  const slow = withTunnel({ timeoutMs: 30 });
  const got = await slow.promise;
  slow.emit('HTTP/1.1 200 OK\r\n\r\n');   // 迟到的 200：监听器已摘，救不回这条连接
  assert.equal(got.e.code, 'proxy_timeout');
  assert.match(got.e.message, /隧道建立超时/);
});

check('openTunnel：代理地址缺失 / 没给回 socket / 响应没完就没头都当场拒', async () => {
  await assert.rejects(() => openTunnel({ proxy: null, targetHost: 'github.com' }), /代理地址形状不合法/);
  const noSock = await openTunnel({
    proxy: { host: '127.0.0.1', port: 1 }, targetHost: 'github.com',
    fakeNet: { connect: () => null },
  }).catch((e) => e);
  assert.match(noSock.message, /没给回 socket/);
  const huge = withTunnel({ timeoutMs: 5000 });
  huge.emit('x'.repeat(20000));
  const got = await huge.promise;
  assert.equal(got.e.code, 'proxy_bad_gateway', '代理回了一坨没完没了的东西：拒，别等超时');
});

/* ---------------- 隧道请求（不碰真网络） ---------------- */
/** 假 node:https：按顺序吐出 responses（用尽后重复最后一个），记录每次的 request options。 */
function fakeHttpsMod(responses) {
  const optsSeen = [];
  let i = 0;
  return {
    optsSeen,
    request(o) {
      optsSeen.push(o);
      const spec = responses[Math.min(i, responses.length - 1)];
      i += 1;
      const handlers = {};
      const res = { statusCode: spec.statusCode, headers: spec.headers ?? {}, on: (ev, fn) => { handlers[ev] = fn; } };
      return {
        on: (ev, fn) => { if (ev === 'response') handlers.response = fn; },
        end: () => {
          setTimeout(() => {
            handlers.response?.(res);
            setTimeout(() => { handlers.data?.(Buffer.from(spec.body ?? '', 'utf8')); handlers.end?.(); }, 0);
          }, 0);
        },
        destroy: () => {},
      };
    },
  };
}

check('tunnelRequest：只放 https 目标，重定向跟着 Location 走且带 identity 编码', async () => {
  const mod = fakeHttpsMod([
    { statusCode: 301, headers: { location: '/trending' }, body: 'moved' },
    { statusCode: 200, headers: { etag: 'W/"x"' }, body: '<html>body</html>' },
  ]);
  const res = await tunnelRequest('https://github.com/trending?since=daily', {
    httpsMod: mod, agentFactory: () => ({}), timeoutMs: 2000,
  });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.deepEqual(mod.optsSeen.map((o) => `https://${o.hostname}${o.path}`),
    ['https://github.com/trending?since=daily', 'https://github.com/trending'], '相对 Location 要按当前地址展开');
  assert.equal(mod.optsSeen[0].headers['accept-encoding'], 'identity', '不显式要原文，gzip 字节会直接进 HTML 解析器');
  assert.equal(mod.optsSeen[0].servername, 'github.com', 'SNI 必须是目标主机，不是代理主机');
  assert.equal(await res.text(), '<html>body</html>');
  assert.equal(res.headers.get('Etag'), 'W/"x"', '头名大小写不敏感（fetch 语义）');
  assert.equal(res.redirected, true);

  await assert.rejects(() => tunnelRequest('http://github.com/trending', { agentFactory: () => ({}) }), /只支持 https 目标/);
});

check('tunnelRequest：跟满 maxRedirects 就把最后一个 3xx 交回去，不无限跟也不编「重定向过多」', async () => {
  const mod = fakeHttpsMod([{ statusCode: 302, headers: { location: '/again' }, body: 'again' }]);
  const res = await tunnelRequest('https://github.com/trending', {
    httpsMod: mod, agentFactory: () => ({}), maxRedirects: 2, timeoutMs: 2000,
  });
  assert.equal(res.status, 302);
  assert.equal(res.ok, false, '3xx 不是成功：gh.js 会按「趋势页返回 302」如实报故障');
  assert.equal(res.redirected, true);
  assert.equal(mod.optsSeen.length, 3, '发了 1 + 2 跳就该停');
});

check('createTunnelAgent：createConnection 交出去的就是隧道 socket，CONNECT 打目标主机:443、TLS 认 SNI', async () => {
  let netSock = null;
  const fakeNet = {
    connect: (port, host) => {
      netSock = fakeSocket();
      netSock.addr = [port, host];
      return netSock;
    },
  };
  const tlsCalls = [];
  const fakeTls = {
    connect: (o) => {
      tlsCalls.push(o);
      const s = fakeSocket();
      setImmediate(() => s.emit('secureConnect'));
      return s;
    },
  };
  const agent = createTunnelAgent({
    proxy: { host: '127.0.0.1', port: 7897, auth: '' },
    fakeNet, fakeTls, timeoutMs: 2000,
  });
  const socket = await new Promise((resolve, reject) => {
    agent.createConnection({ host: 'github.com', port: 443 }, (e, s) => (e ? reject(e) : resolve(s)));
    setImmediate(() => netSock.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n', 'latin1')));
  });
  assert.deepEqual(netSock.addr, [7897, '127.0.0.1'], 'TCP 连的是代理');
  assert.match(netSock.written.join(''), /CONNECT github\.com:443 HTTP\/1\.1/);
  assert.equal(tlsCalls[0].socket, netSock, 'TLS 接在同一条已放行的 socket 上');
  assert.equal(tlsCalls[0].servername, 'github.com');
  assert.deepEqual(tlsCalls[0].ALPNProtocols, ['http/1.1']);
  assert.equal(socket.destroyed, false);

  // 代理直接拒绝时，错误从 createConnection 的 callback 出，不 throw 到调用栈上
  const dead = createTunnelAgent({
    proxy: { host: '127.0.0.1', port: 7897, auth: '' },
    fakeNet: { connect: () => { const s = fakeSocket(); setTimeout(() => s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), 0); return s; } },
    fakeTls,
    timeoutMs: 2000,
  });
  const err = await new Promise((resolve) => dead.createConnection({ host: 'github.com', port: 443 }, (e) => resolve(e)));
  assert.match(err.message, /连不上代理/);
});

/* ---------------- 传输层门面 ---------------- */
function transportFixture(over = {}) {
  const calls = { fetch: [], tunnel: [], registry: 0 };
  const net = createNetTransport({
    getPrefs: over.prefs ?? (() => ({ proxyMode: 'system', proxyUrl: '' })),
    env: over.env ?? {},
    platform: over.platform ?? 'win32',
    registryRead: async () => { calls.registry += 1; return SYS; },
    fetchFn: async (url, init) => { calls.fetch.push([url, init]); return { status: 200, ok: true, headers: { get: () => null }, text: async () => 'DIRECT' }; },
    tunnelRequestFn: async (url, opt) => {
      calls.tunnel.push([url, opt]);
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => 'TUNNEL' };
    },
    logger: over.logger,
  });
  return { net, calls };
}

check('createNetTransport：system 命中注册表就走隧道，直连那条路一个字节都不发', async () => {
  const { net, calls } = transportFixture();
  const res = await net.fetch('https://github.com/trending?since=daily', { headers: { 'User-Agent': 'x' } });
  assert.equal(await res.text(), 'TUNNEL');
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.tunnel.length, 1);
  assert.equal(calls.tunnel[0][1].connect.proxy.url, 'http://127.0.0.1:7897');
  assert.equal(calls.tunnel[0][1].headers['User-Agent'], 'x', '调用方的头要原样带进隧道请求');
  assert.deepEqual([net.describe().via, net.describe().source, net.describe().proxy], ['proxy', 'registry', 'http://127.0.0.1:7897']);
});

check('createNetTransport：direct 与「没配代理」都退回宿主全局 fetch，describe 说清是哪一种', async () => {
  const d = transportFixture({ prefs: () => ({ proxyMode: 'direct' }) });
  assert.equal(await (await d.net.fetch('https://github.com/trending')).text(), 'DIRECT');
  assert.deepEqual([d.net.describe().via, d.net.describe().source], ['direct', 'mode:direct']);
  assert.equal(d.calls.registry, 0, '直连模式不该去读系统代理');

  const none = createNetTransport({
    getPrefs: () => ({ proxyMode: 'system' }),
    platform: 'win32',
    registryRead: async () => ({ ok: true, enabled: false, server: '', override: '', reason: '系统「使用代理服务器」是关的' }),
    fetchFn: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => 'DIRECT' }),
    tunnelRequestFn: async () => { throw new Error('不该走隧道'); },
  });
  assert.equal(await (await none.fetch('https://github.com/trending')).text(), 'DIRECT');
  assert.deepEqual([none.describe().via, none.describe().source], ['direct', 'none']);
  assert.match(none.describe().reason, /是关的/,);
});

check('createNetTransport：custom 地址坏了就抛 proxy_config，绝不静默回落直连', async () => {
  const { net, calls } = transportFixture({ prefs: () => ({ proxyMode: 'custom', proxyUrl: '127.0.0.1' }) });
  const e = await net.fetch('https://github.com/trending').catch((x) => x);
  assert.equal(e?.code, 'proxy_config');
  assert.match(e.message, /缺端口/);
  assert.equal(calls.fetch.length, 0, '回落到直连会把「配了个坏代理」伪装成「网络不通」');
  assert.equal(net.describe().via, 'failed');
  assert.match(net.describe().reason, /自定义代理地址不可用/);
});

check('createNetTransport：注册表读一次缓存 60s，改偏好 invalidate 后立刻重读', async () => {
  const { net, calls } = transportFixture();
  await net.fetch('https://github.com/trending');
  await net.fetch('https://github.com/trending');
  await net.fetch('https://github.com/trending');
  assert.equal(calls.registry, 1, '一轮三发不该 spawn 三次 reg');
  net.invalidate();
  await net.fetch('https://github.com/trending');
  assert.equal(calls.registry, 2);
});

check('createNetTransport：隧道抛上来的错原样出边界，故障文案点名代理地址', async () => {
  const broken = createNetTransport({
    getPrefs: () => ({ proxyMode: 'system' }),
    platform: 'win32',
    registryRead: async () => SYS,
    tunnelRequestFn: async () => { throw Object.assign(new Error('连不上代理 127.0.0.1:7897（connection refused）'), { code: 'proxy_unreachable' }); },
  });
  const e = await broken.fetch('https://github.com/trending').catch((x) => x);
  assert.match(e.message, /连不上代理 127\.0\.0\.1:7897/, '错误要原样出边界，gh.js 才有得可念');
  assert.deepEqual([broken.describe().via, broken.describe().proxy], ['proxy', 'http://127.0.0.1:7897']);
  assert.match(transportHint(broken.describe()), /本轮经代理 http:\/\/127\.0\.0\.1:7897 取 github\.com 未通/);
  assert.match(transportHint({ via: 'failed', reason: '自定义代理地址不可用：缺端口' }), /本轮没有出网：自定义代理地址不可用：缺端口/);
  assert.equal(transportHint({}), TRANSPORT_HINT, '没有路由信息时回落「直连未通」那句，不编造代理地址');
});

await runAll('net');
