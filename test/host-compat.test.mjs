/**
 * test/host-compat.test.mjs —— 挂载契约与铁律的源码级判据（口径继承 sysops / modelwatch）。
 *
 * 这一套件不发网络请求，也不碰本机 profile：
 *  · link: 挂载下宿主与插件会解析出两份模块实例 ⇒ 宿主半边零 @deepseek-ai import；
 *  · 宿主没打包机制 ⇒ 零第三方依赖，出网只用全局 fetch；
 *  · 对 github.com 全程只读 GET，从不发 cookie；
 *    ★ 第二十一轮改判（用户裁定「设置页加 GitHub 令牌抬配额」）：原口径「绝不发 authorization」放宽为
 *    「默认零凭据 ⇒ 设置页填了令牌才发，且只发这一种形状：Bearer 进请求头、只给 api.github.com、只给详情那一路」；
 *    令牌不进 URL、不回显、不进日志、不落详情行（边界由 hc-7 那三条 + hc-19 + test/repo.test.mjs 的效果侧钉）。
 *  · 变化只落面板：不碰 ctx.schedule / ctx.jobs / session；
 *  · 宿主模型句柄只许一个使用者（`hc-8` 按 index.js 的 import 边推导，见那条的注释）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { check, runAll, assert, makeFakeFacility, makeFakeCtx, makeReq, makeRes, flush } from './_helpers.mjs';
import { apply, resolveConfig, DEFAULT_CONFIG, name as PLUGIN_NAME, inject as HARD_INJECT, __peek } from '../index.js';
import { GLOBAL_KEY, ROUTE_PREFIX } from '../lib/api.js';
import { BOARDS, BOARD_LABELS, BOARD_ADDED_LABELS, CHECK_INTERVALS, CHECK_INTERVAL_LABELS,
  DETAIL_RECHECK_MS, DETAIL_STAMP_LABELS,
  EVENT_KIND_LABELS, EVENT_KINDS, DEFAULT_PREFS, TRENDING_SOURCE_NOTE, LANG_CHECK, CROSS_MIN_BOARDS,
  PROXY_MODES, TRANSLATE_CRED_FIELDS, TRANSLATE_CRED_ALL,
  // ★ 第二十一轮：凭据清单在 domain 派生成一份（含 GitHub 令牌那把）；判据扫的是派生后那份，
  //   旧的那份只列三家翻译的 ⇒ 拿它当"全部密钥"就漏扫了令牌（手抄必漏，见 hc-0）。
  PREF_CRED_FIELDS, PREF_SECRET_KEYS } from '../lib/domain.js';
import { GHT_DOMAIN } from '../lib/domain.js';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
/**
 * 扫描面 = 宿主半边真要发货的文件（package.json 的 files 覆盖 index.js / client.js / lib/**）。
 * ★ 不写死清单：上一版 HOST_FILES 是 12 个手抄的名字 —— 后来加的 `lib/desc-zh.js` 一旦漏抄，
 *   「零 @deepseek-ai」「零 ctx.llm」那几条对它等于没扫，绿的是扫描器、不是代码。
 *   改成按目录真读，并由 hc-0 钉住「扫到的必须是要发货的那几个、且每个都真读得出内容」。
 */
const HOST_FILES = (() => {
  const list = ['index.js', 'client.js'];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) list.push(rel);
    }
  };
  walk('lib');
  return list.sort();
})();

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 去注释后的源码（判据扫的是语句位，不是文档位）。 */
const codeOf = (rel) => readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/**
 * 注释就地抹成空格、不删：这样字符位移不变，命中点还能报出**原文件行号**。
 * 叙述性文字（spec 摘抄、铁律注释里的「零 ctx.llm」）只有抹掉才不会被当成违规。
 */
const maskComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/\S/g, ' '))
  .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/\S/g, ' '));

check('hc-0 扫描面自己先要「有东西可扫」：清单来自目录真读，且每个都真读得出内容', () => {
  for (const must of ['index.js', 'client.js', 'lib/api.js', 'lib/domain.js', 'lib/desc-zh.js']) {
    assert.ok(HOST_FILES.includes(must), `扫描面里没有 ${must} —— 目录真读漏了它，还是它压根不存在？`);
  }
  for (const f of HOST_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} 在清单里但磁盘上没有`);
    assert.ok(readSrc(f).length > 200, `${f} 短得可疑（${readSrc(f).length} 字），判据等于扫了个空`);
  }
});

check('hc-1 宿主半边零 @deepseek-ai import（link: 挂载会解析出第二份实例）', () => {
  const importRe = /^[ \t]*(?:import|export)[^\n]*?from\s+['"]@deepseek-ai/m;
  const reqRe = /^[ \t]*require\(\s*['"]@deepseek-ai/m;
  for (const f of HOST_FILES) {
    const src = codeOf(f);
    assert.ok(!importRe.test(src) && !reqRe.test(src), `${f} 里出现了对 @deepseek-ai/* 的 import/require`);
  }
});

check('hc-2 宿主半边 import 只允许相对路径与 node: 内置（零第三方依赖）', () => {
  const re = /from\s+['"]([^'"]+)['"]/g;
  for (const f of HOST_FILES) {
    let m;
    while ((m = re.exec(codeOf(f)))) {
      const spec = m[1];
      assert.ok(spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:'),
        `${f} 引了第三方：${spec}`);
    }
  }
});

check('hc-3 package.json：没有 dependencies / peerDependencies，导出与 bundle 声明齐', () => {
  const pkg = JSON.parse(readSrc('package.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.devDependencies, undefined, '骨架阶段不引任何 dev 依赖（跑测只用 node 内置）');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'].default, './client.js');
  assert.equal(pkg.dsh.bundle.patch, 'cordis.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
});

check('hc-4 cordis.yml 的 id/name 与插件导出名一致', () => {
  const yml = readSrc('cordis.yml');
  assert.match(yml, new RegExp(`id: ${PLUGIN_NAME}\\b`));
  assert.match(yml, /name: dsh-plugin-gh-trending/);
});

check('hc-5 双侧约定的三个字符串逐字一致（前缀 / 全局键 / 域名）', () => {
  const client = readSrc('client.js');
  assert.equal(ROUTE_PREFIX, '/gh-trending');
  assert.ok(client.includes(`'${GLOBAL_KEY}'`), `client 里没有 ${GLOBAL_KEY}`);
  assert.ok(client.includes("'__GH_TRENDING__'"), 'client 的全局键必须是字面量（载荷没到时也要认得）');
  assert.ok(client.includes("'/gh-trending/api'"), 'client 的 API_BASE 回落与 ROUTE_PREFIX/api 同值');
  assert.equal(GHT_DOMAIN.name, 'gh_trending');
  assert.match(GHT_DOMAIN.name, /^[a-z][a-z0-9_]*$/, '域名必须过宿主的 ^[a-z][a-z0-9_]*$（连字符当场被拒）');
});

check('hc-6 零硬 inject：export const inject = []（缺任一服务都不许卡死加载）', () => {
  assert.deepEqual(Array.from(HARD_INJECT), []);
});

/* ★ 10-06 第九轮改判：出网名单从「手抄两个文件名」改成派生 —— 凡是调 fetchFn 的服务文件都算一路。
 *   手抄的下场和手抄扫描面一样（见 hc-0）：加了 `lib/services/web-translate.js` 那一天，
 *   这条铁律对新增的那一路等于零覆盖，而套件照样全绿。
 *   `lib/services/net.js` 是传输层本身（直连 / 代理 / CONNECT 隧道归 test/net.test.mjs 钉），这里只钉"构造请求的那几路"。 */
const OUTBOUND = HOST_FILES.filter((f) => f.startsWith('lib/services/') && f !== 'lib/services/net.js' && /\bfetchFn\s*\(/.test(codeOf(f)));
/** 按它从 domain 拿的那一份端点常量分家：对 GitHub 的那几路零凭据，翻译那一路只许带签名（hc-19 钉密钥）。 */
const githubBound = () => OUTBOUND.filter((f) => /GITHUB_API_BASE|TRENDING_BASE\b|\bTRENDING_URL\b/.test(codeOf(f)));
const translateBound = () => OUTBOUND.filter((f) => /TRANSLATE_ENDPOINTS\b/.test(codeOf(f)));

check('hc-7 只读 GET 铁律：每一路只发 GET、地址只从 domain 拿；★ 第二十一轮改判后凭据头按域分家（GitHub 那一路只许一条 authorization，翻译那一路照旧零凭据头）', () => {
  assert.ok(OUTBOUND.length >= 3, `出网名单只派生出 ${OUTBOUND.length} 个（${OUTBOUND.join(', ')}）—— gh / 详情 / 翻译那一路都该在名单里，漏一个就是这条铁律没扫到它`);
  for (const f of OUTBOUND) {
    const src = codeOf(f);
    assert.match(src, /method: 'GET'/, `${f} 出网必须显式写 GET`);
    assert.ok(!/method: '(POST|PUT|DELETE|PATCH)'/.test(src), `${f} 不许有任何写方法`);
    for (const banned of ['cookie', 'client_secret', 'access_token']) {
      assert.ok(!new RegExp(`['"\\[\\s]${banned}`, 'i').test(src), `${f} 里出现了 ${banned}（本插件只读，不接任何写侧凭据）`);
    }
    // ★ 第二十一轮（用户裁定「设置页加 GitHub 令牌」）：§0 那条「GitHub 那一域仍是零凭据」改判为
    //   「默认零凭据；填了才带，且只进请求头」。authorization 因此只在对 GitHub 的那一路**可能**出现，
    //   出现几处、什么形状、会不会进 URL，由下面那三条钉死；其余文件（含翻译那一路）照旧全禁 ——
    //   翻译那三家的凭据按各自文档进签名（query/body），从来不进请求头，这里放开了就是撒令牌。
    if (!githubBound().includes(f)) {
      for (const banned of ['authorization', 'token']) {
        assert.ok(!new RegExp(`['"\\[\\s]${banned}`, 'i').test(src), `${f} 里出现了 ${banned}（这一路不吃凭据头）`);
      }
    }
    assert.ok(!/\bzip\b|git clone|codeload/.test(src), '不下载 zip、不 clone');
    assert.ok(!/child_process|spawn\w*\(|execSync|execFile/.test(src), '不起子进程');
    // 地址只有一份：出网的那几路自己不许写带 scheme 的地址（domain 里那一份才是唯一来处）
    assert.ok(!/fetchFn\(\s*['"`]https?:/.test(src), `${f} 里出现了绕过 domain 的硬写地址`);
    assert.match(src, /from '\.\.\/domain\.js'/, `${f} 的端点要从 domain 拿`);
  }
  // 派生本身要自证：两家各至少一路，且没有第三家（第三家就是没登记过的出网面）
  assert.ok(githubBound().length >= 2, `对 GitHub 那几路只认出 ${githubBound().length} 个文件`);
  assert.equal(translateBound().length, 1, `翻译出网面应当只有一份文件，实际 ${translateBound().join(', ') || '一个都没有'}`);
  assert.equal(OUTBOUND.length, githubBound().length + translateBound().length,
    `有出网文件既不对 GitHub 也不对翻译：${OUTBOUND.filter((f) => !githubBound().includes(f) && !translateBound().includes(f)).join(', ')}`);
  // 详情层拼 URL 只在这一处，且报错文案里提主机名不算出网地址
  const repo = codeOf('lib/services/repo.js');
  assert.match(repo, /import \{[\s\S]*?GITHUB_API_BASE[\s\S]*?\} from '\.\.\/domain\.js'/);
  assert.ok(!/https:\/\/api\.github\.com/.test(repo), '带 scheme 的接口地址只留在 domain 一份');

  // ★★★ 第二十一轮的改判边界：带凭据头的文件**只许 repo.js 一个**，且只许一条。
  const authFiles = OUTBOUND.filter((f) => /['"\[\s]authorization\s*:/.test(codeOf(f)));
  assert.deepEqual(authFiles, ['lib/services/repo.js'],
    `凭据头出现在 ${authFiles.join(', ') || '一个都没有'}：对 GitHub 的那几路（gh.js 榜面）不该带，多一个文件就是多一个撒令牌的出口；\n` +
    '一个都没有则是那一轮的功能没落地');
  assert.equal((repo.match(/['"\[\s]authorization\s*:/g) || []).length, 1,
    'repo.js 里出现第二条 authorization ⇒ 有一处不在"填了才带"那个条件展开里（可能无条件发，也可能发到别的域）');
  // 唯一那一条挂在 headers 里，不在 URL 上：把 URL 拼接那一句单独拎出来看。
  const urlArgs = repo.match(/fetchFn\(\s*[^,]+/g) || [];
  assert.ok(urlArgs.length >= 1, '没扫到 fetchFn 的第一个实参（拼 URL 那一句换形状了，这条判据等于空转）');
  for (const u of urlArgs) {
    assert.ok(!/token/i.test(u), `URL 拼接里出现了 token（${u.trim()}）⇒ 令牌会留在代理与访问日志里`);
  }
  // 对 GitHub 的另一路（榜面抓取）必须连"令牌"这个字都不认得：它没有 ghToken 入参，也就没有漏接一说。
  const gh = codeOf('lib/services/gh.js');
  assert.ok(!/ghToken/.test(gh), 'gh.js 认得 ghToken ⇒ 榜面那一路也开始带凭据，而 §0 的账只登记了详情那一路');
});

/* ------------------------------------------------------------------ *
 * 零模型句柄判据（spec §0 铁律的效果侧）
 * ------------------------------------------------------------------ */

/** 获取宿主模型服务句柄的形状。顺序 = 报错顺序：同一条线上取更具体的那条原因。 */
const LLM_SHAPES = [
  { why: '字面取宿主模型属性', re: /\bctx\s*(?:\?\.|\.)\s*llm\b/g },
  { why: '服务解析调用点名了 llm（inject / require 的名单里有 \'llm\'）', re: /\b(?:inject|require|resolve|use|get)\s*\([^)]*['"`]llm['"`]/g },
  { why: '从注入回来的服务对象上取了 llm（变量名不限）', re: /\b[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*llm\b/g },
  { why: '从注入回来的服务对象上解构出 llm', re: /\{[^{}]*\bllm\b[^{}]*\}\s*=/g },
  { why: '代码里出现了服务名字面量 llm（名单绕道变量也照样是点名）', re: /['"`]llm['"`]/g },
];

/** 扫出一段源码里所有「拿到宿主模型句柄」的写法，返回 [{ line, text, why }]。 */
function findLlmHandles(src) {
  const code = maskComments(src);
  const lines = src.split('\n');
  const byLine = new Map();
  for (const { why, re } of LLM_SHAPES) {
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split('\n').length;
      if (!byLine.has(line)) {
        byLine.set(line, { line, why, text: (lines[line - 1] || '').trim().slice(0, 120) });
      }
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** 判据自证用的坏形状：每一类都必须是真写法，不许拿 ctx.llm 那种一撞就死的凑数。 */
const LLM_BAD_SHAPES = [
  { name: '字面取属性', src: 'const chat = ctx.llm;' },
  { name: 'inject 名单点名', src: "ctx.inject(['llm'], (s) => { h = s.llm ?? null; });" },
  { name: 'inject 名单混在别的服务里', src: "ctx.inject(['storageDomain', 'llm'], (svc) => { svc.register(); });" },
  { name: 'require 解析', src: "const { llm } = ctx.require('llm');" },
  { name: '注入对象上取属性（变量名不是 s）', src: 'ctx.inject(["llm"], (t) => { h = t.llm; });' },
  { name: '名单绕道变量', src: "const deps = [`llm`];\nctx.inject(deps, (s) => {});" },
  { name: '可选链与方括号', src: 'h = ctx?.["llm"];' },
];

/** 合法写法必须一条不抓：注释里写满了「零 ctx.llm」「不注入 llm」，代码只碰 storageDomain / timer。 */
const LLM_LEGIT_SRC = `
/** 铁律（spec §0）：宿主半边零 ctx.llm，本插件刻意**不**注入 llm。 */
export function apply(ctx) {
  // 不碰 ctx.llm / ctx.schedule / ctx.jobs，变化只落面板
  let facility = null;
  ctx.inject(['storageDomain'], (s) => { facility = s.storageDomain ?? null; });
  ctx.inject(['timer'], (t) => { intervalFn = t.timer.interval; });
  const getLlmFreeStore = () => facility;
  return getLlmFreeStore;
}
`;

/* ★ 教训（2026-10-05 真机探针）：旧判据只 includes('ctx.llm') 匹字面文本，于是
 *   ctx.inject(['llm'], (s) => { llmHandle = s.llm }) 把句柄经 getLlm 传进 lib/api.js
 *   真的调通了宿主模型（拿到 5 发完整读数），而这台判据全程绿灯。钉文本不钉效果就是假绿。
 *
 * ★ 10-06 第八轮改判：「零句柄」收成「句柄只许出现在唯一使用者那一个文件里」。
 *   白名单**从 index.js 的真实 import 边推导**（装配层把 ctx 交给了哪个模块，哪个模块就是使用者），
 *   不手抄文件名 —— 手抄的下场和手抄扫描面一样（见 hc-0）：挪个目录、换个导出名，判据就悄悄扫空气。 */
function handleHolder() {
  const re = /import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g;
  const hits = [...codeOf('index.js').matchAll(re)].filter((m) => /\bcreateLlmTranslator\b/.test(m[1]));
  assert.equal(hits.length, 1, `index.js 里 import createLlmTranslator 的边应当只有一条，实际 ${hits.length} 条`);
  return hits[0][2].replace(/^\.\//, '');
}

check('hc-8 ★模型句柄只许有一个使用者：全仓扫下来只有派生出的那一个文件拿得到句柄，其余文件连 schedule / jobs / session 都不碰', () => {
  const holder = handleHolder();
  assert.ok(HOST_FILES.includes(holder), `白名单文件 ${holder} 不在扫描面里 —— 目录真读没覆盖它，等于给它开了张不查的通行证`);
  const holders = HOST_FILES.filter((f) => findLlmHandles(readSrc(f)).length > 0);
  assert.deepEqual(holders, [holder],
    '这些文件拿到了宿主模型句柄（spec §0 第八轮：使用者只许一个）：\n'
    + holders.filter((f) => f !== holder)
      .map((f) => findLlmHandles(readSrc(f)).map((h) => `  ${f} 第 ${h.line} 行「${h.why}」⇒ ${h.text}`).join('\n')).join('\n'));
  // 白名单不是空转：它必须真的在拿句柄，否则"唯一使用者"是给空气立的牌坊
  const own = findLlmHandles(readSrc(holder));
  assert.ok(own.length >= 2, `${holder} 应当既有 inject 点名、又有从注入对象上取值，这里只扫到 ${own.length} 处`);
  // 除它以外，载荷与 deps 的键名也不许叫 llm：`snap.llm` / `deps.llm` 撞的是同一条正则，
  // 而这两处的语义是「本插件自己的现译服务」，改名成 translator 才是它本来的样子。
  for (const f of HOST_FILES.filter((x) => x !== holder)) {
    assert.ok(!/\bdeps\.llm\b|\bsnap\.llm\b|\.llm\?/.test(codeOf(f)), `${f} 的语句位出现了 .llm 取值的形状（除使用者外的文件一律不许）`);
  }

  // 判据自证：这三类形状只要有一类扫漏，改强就等于没改
  assert.ok(LLM_BAD_SHAPES.length >= 3, `坏形状样本只剩 ${LLM_BAD_SHAPES.length} 类，证伪不了三种形状`);
  for (const bad of LLM_BAD_SHAPES) {
    assert.ok(findLlmHandles(bad.src).length > 0, `判据扫漏了这一形状：${bad.src}（${bad.name}）`);
  }
  assert.deepEqual(findLlmHandles(LLM_LEGIT_SRC), [],
    '判据误伤了合法写法：真注入（storageDomain / timer）与注释里的叙述性文字都不算违规');
  // 证伪第 4 条：把句柄原样转发给别的文件（这一轮真差点踩回去的形状），必须立刻红
  assert.ok(findLlmHandles("export function mk(svc) { return { getLlm: () => svc.llm }; }").length > 0,
    '判据扫漏了「把句柄挂在返回值上转发」这一形状');

  for (const f of ['index.js', 'lib/check.js', 'lib/api.js', 'lib/stores.js']) {
    const src = codeOf(f);
    for (const banned of ['ctx.llm', 'llm(', 'schedule', 'ctx.jobs', 'notify', 'sessionLog']) {
      assert.ok(!src.includes(banned), `${f} 里出现了 ${banned}（裁定 ③④：变化只落面板；现译只走唯一使用者，装配层不许自己伸手）`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 裸宿主装配
 * ------------------------------------------------------------------ */
function makeCtx({ services = {} } = {}) {
  const calls = { inject: [], register: [], pushes: [], warns: [], effects: [], on: {} };
  const ctx = {
    logger: { warn: (m) => calls.warns.push(String(m)), info: () => {}, error: () => {} },
    inject(deps, cb) { calls.inject.push({ deps, cb }); },
    on(name, fn) { calls.on[name] = fn; },
    effect(fn, label) { calls.effects.push(label); try { fn(); } catch { /* 装配判据不追清理细节 */ } return () => {}; },
    services,
  };
  ctx.fireInject = (svcs) => {
    for (const { deps, cb } of calls.inject) {
      if (deps.every((d) => d in svcs)) cb(Object.fromEntries(deps.map((d) => [d, svcs[d]])));
    }
  };
  return { ctx, calls };
}

check('hc-9 裸宿主（一个服务都没有）：apply 不抛，撤销器可反复调用', () => {
  const { ctx, calls } = makeCtx();
  const teardown = apply(ctx, {});
  assert.equal(typeof teardown, 'function');
  teardown();
  teardown();
  assert.ok(calls.effects.includes('gh-trending:lifecycle'), '生命周期撤销器要挂在 ctx.effect 上');
});

check('hc-10 全服务落地：路由注册在 /gh-trending 前缀，且是 kind:prefix', () => {
  const { ctx, calls } = makeCtx();
  const teardown = apply(ctx, {});
  const registered = [];
  const facility = { async open() { throw new Error('本用例不给域'); } };
  ctx.fireInject({
    storageDomain: facility,
    timer: { interval: (fn, ms) => ({ fn, ms, unref() {} }) },
    webServer: { register: (spec) => { registered.push(spec); return () => {}; } },
  });
  assert.equal(registered.length, 1, '只登记一个前缀路由，其余路径全在表内分派');
  assert.equal(registered[0].path, ROUTE_PREFIX);
  assert.equal(registered[0].kind, 'prefix');
  assert.equal(typeof registered[0].handler, 'function');
  void calls;
  teardown();
});

/** index-inject 载荷的键全集（客户端读到的每一项都得有人给）。 */
const PAYLOAD_KEYS = ['panelId', 'label', 'panelOrder', 'routePrefix', 'api', 'capabilities', 'capabilityRows',
  'boards', 'boardLabels', 'boardAddedLabels', 'sourceNote', 'langCheck', 'crossMin',
  'intervals', 'intervalLabels', 'detailStampLabels', 'proxyModes', 'proxyModeLabels', 'proxyModeHints', 'proxyUrlMax',
  'topNRange', 'keepEventsRange', 'eventKindLabels', 'defaults', 'builtAt'];

check('hc-11 入口载荷：webServer 到位才推，字段一个不少', () => {
  const { ctx, calls } = makeCtx();
  const teardown = apply(ctx, {});
  const table = [];
  calls.on['webserver/index-inject'](table);
  assert.equal(table.length, 0, '没 webServer 就不推入口载荷（点开空白页比看不到入口更糟）');

  ctx.fireInject({ webServer: { register: () => () => {} } });
  const table2 = [];
  calls.on['webserver/index-inject'](table2);
  assert.equal(table2.length, 1);
  assert.equal(table2[0].kind, 'global');
  assert.equal(table2[0].name, GLOBAL_KEY);
  const v = table2[0].value;
  for (const k of PAYLOAD_KEYS) assert.ok(k in v, `index-inject 载荷缺 ${k}`);
  assert.equal(v.api, '/gh-trending/api');
  assert.equal(v.routePrefix, ROUTE_PREFIX);
  assert.equal(v.panelOrder, 16, '排在股票(10) / 运维(12) / 模型监控(14) 下方');
  assert.deepEqual(v.boards, BOARDS);
  assert.deepEqual(v.boardLabels, BOARD_LABELS);
  assert.deepEqual(v.boardAddedLabels, BOARD_ADDED_LABELS);
  assert.deepEqual(v.eventKindLabels, EVENT_KIND_LABELS);
  assert.deepEqual(Object.keys(v.eventKindLabels).sort(), [...EVENT_KINDS].sort(), '事件枚举与片名表必须同集合');
  assert.deepEqual(v.intervals, CHECK_INTERVALS);
  // ★ 第二十七轮：这里原来是第十二轮那两格（档位名单 + 档位话术表），随那一档整链撤掉 ——
  //   详情改条件请求以后没有任何"时长"可选，载荷里再给一份档位就是界面上摆不出来的第二份真相。
  assert.deepEqual(v.detailStampLabels, DETAIL_STAMP_LABELS, '那句落款的两个词只在 domain 一份，装配处只递名字');
  assert.deepEqual(Object.keys(v.detailStampLabels).sort(), ['body', 'revalidated'], '载荷的形状漂了：客户端读的是这两格');
  assert.equal('cacheHours' in v, false, '载荷还在推档位名单 ⇒ 撤档只撤了界面，链没拆完');
  assert.equal('repoCacheHours' in v.defaults, false, '出厂偏好里还留着那一格');
  assert.deepEqual(v.proxyModes, PROXY_MODES);
  assert.deepEqual(Object.keys(v.proxyModeLabels).sort(), [...PROXY_MODES].sort(), '三档的话术表与档位集合必须同集合');
  assert.deepEqual(Object.keys(v.proxyModeHints).sort(), [...PROXY_MODES].sort());
  assert.equal(v.sourceNote, TRENDING_SOURCE_NOTE);
  assert.deepEqual(v.langCheck, LANG_CHECK);
  assert.equal(v.crossMin, CROSS_MIN_BOARDS);
  assert.deepEqual(v.defaults, DEFAULT_PREFS);
  assert.equal(typeof v.builtAt, 'number');
  teardown();
});

check('hc-12 载荷与客户端读的那一侧逐键对齐（客户端读不到的键才是真事故）', () => {
  const client = codeOf('client.js');
  const read = new Set([...client.matchAll(/cfg\(\)\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  assert.ok(read.size >= 12, `没扫出客户端的 cfg() 读取点（${read.size}）`);
  // 键全集现从 index.js 的那一份推送里取，不再手抄一遍：
  // 手抄的清单会自己漂（加了三键忘了改这里，用例照样绿，真机却是一片「配置未就位」）
  const { ctx, calls } = makeCtx();
  const teardown = apply(ctx, {});
  ctx.fireInject({ webServer: { register: () => () => {} } });
  const table = [];
  calls.on['webserver/index-inject'](table);
  const pushed = Object.keys(table[0]?.value ?? {});
  teardown();
  assert.deepEqual(pushed.slice().sort(), PAYLOAD_KEYS.slice().sort(),
    '载荷键全集变了：index.js 的推送与本清单必须一起改');
  for (const k of read) assert.ok(pushed.includes(k), `client 读了 ${k}，但 index.js 没推这个键`);
  // 客户端不许读宿主半边没有的东西，也不许读 config（profile 的 config 在浏览器侧根本不存在）
  assert.ok(!/\bctx\.config\b/.test(client), '浏览器半边没有 ctx.config');
});

check('hc-13 resolveConfig：脏档位回落默认，数值钳边界，脏 slug 不进运行时', () => {
  const c1 = resolveConfig({ intervalMin: 7, topN: 999, keepEvents: -1 });
  assert.equal(c1.intervalMin, DEFAULT_CONFIG.intervalMin);
  assert.equal(c1.topN, 25);
  assert.equal(c1.keepEvents, 50);
  const c2 = resolveConfig({ label: 42, panelId: '', panelOrder: 'x', language: 'c++' });
  assert.equal(c2.label, DEFAULT_CONFIG.label);
  assert.equal(c2.panelId, DEFAULT_CONFIG.panelId);
  assert.equal(c2.panelOrder, DEFAULT_CONFIG.panelOrder);
  assert.equal(c2.language, '', '形状不合法的语言 ⇒ 全站，脏值绝不拼进 URL');
  const c3 = resolveConfig(null);
  assert.equal(c3.language, DEFAULT_CONFIG.language);
  assert.ok(CHECK_INTERVALS.includes(c3.intervalMin), '出厂 intervalMin 必须是可选档位之一');
  assert.equal(DEFAULT_CONFIG.intervalMin, DEFAULT_PREFS.intervalMin, 'DEFAULT_CONFIG 与 DEFAULT_PREFS 同源（两处默认会漂）');
  assert.equal(DEFAULT_CONFIG.topN, DEFAULT_PREFS.topN);
  assert.equal(DEFAULT_CONFIG.keepEvents, DEFAULT_PREFS.keepEvents);
  assert.equal(resolveConfig({ intervalMin: 720 }).intervalMin, 720);
  assert.equal(resolveConfig({ language: 'Rust' }).language, 'rust', '大小写归一是刻意的');
});

check('hc-14 timer 就绪后重挂节拍：能力位与后端不自相矛盾', () => {
  const { ctx } = makeCtx();
  const teardown = apply(ctx, {});
  assert.equal(__peek('timerBackend'), 'setInterval', '宿主定时器还没注入 ⇒ 先用 setInterval 起节拍（不是「没定时器」）');
  ctx.fireInject({ timer: { interval: (fn, ms) => ({ fn, ms, unref() {} }) } });
  assert.equal(__peek('timerBackend'), 'ctx.timer');
  teardown();
});

check('hc-15 节拍换算：cadenceMs 跟着偏好走，退避指数由坏轮决定', () => {
  const { ctx, calls } = makeCtx();
  const teardown = apply(ctx, { intervalMin: 720 });
  assert.equal(__peek('cadenceMs'), 720 * 60000);
  assert.equal(__peek('backoffExponent'), 0, '一轮都没坏过就是 0（退避不是常态）');
  ctx.fireInject({});
  const table = [];
  calls.on['webserver/index-inject'](table);
  assert.equal(table.length, 0);
  teardown();
});

check('hc-16 存储域 open 失败：能力位说真话，路由照登记（榜面照看，只是留不下史）', async () => {
  const { ctx, calls } = makeCtx();
  const teardown = apply(ctx, {});
  ctx.fireInject({
    storageDomain: { async open() { throw new Error('already-open: gh_trending'); } },
    webServer: { register: () => () => {} },
  });
  await new Promise((r) => setTimeout(r, 10));
  const table = [];
  calls.on['webserver/index-inject'](table);
  assert.equal(table.length, 1, '存储坏了也要推入口载荷（空白页比降级更难诊断）');
  assert.equal(table[0].value.capabilities.storageDomain, false, 'open 失败 ⇒ 能力位必须落 false（诚实降级）');
  const row = table[0].value.capabilityRows.find((r) => r.key === 'storageDomain');
  assert.equal(row.ok, false);
  assert.match(row.detail, /存储域 open 失败|不可用|ctx\.storageDomain/, '降级行要说清坏在哪，界面照原文显示');
  assert.ok(calls.warns.some((w) => w.includes('存储域不可用')), '降级要有一条 warn');
  teardown();
});

check('hc-17 真机：profile 的 link: 挂载与端口以本机 dsh 为准，本用例只声明口径不碰本机', () => {
  // 挂载 / 重启是用户确认后的动作（spec §9）；SKIP_LOCAL=1 时整条跳过。
  assert.ok(true);
});

check('hc-18 保存偏好后必须真推一帧 update：开关不许停在旧值（走查抓到的那条，本用例在假 ctx 上跑）', async () => {
  const facility = makeFakeFacility();
  const registered = [];
  const ctx = makeFakeCtx({
    facility,
    timerInterval: () => ({ fn: () => {}, unref() {} }),
    webServer: { register: (spec) => { registered.push(spec); return () => {}; } },
  });
  const teardown = apply(ctx, {});
  await flush(10);
  // 路由登记挂在 ctx.effect 上（假 ctx 只收不跑），这里由"宿主"真的跑一次那一节 ——
  // 不然本用例测的是"没登记路由"的插件，与真机不对齐。
  const routeEff = ctx._internals.effects.find((e) => e.name === 'gh-trending:route');
  assert.ok(routeEff, '路由注册必须挂在 ctx.effect 上（reload 才摘得干净）');
  routeEff.fn();
  assert.equal(registered.length, 1, '路由没登记就谈不上推帧');
  const h = registered[0].handler;

  // 先挂一条长连接：这一路没在跑表（假 timer 不真的排程），所以帧只会是"偏好改动"推出来的
  const sse = makeRes();
  await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` }), sse);
  await flush(20);
  assert.match(sse.writes.join(''), /event: snapshot\ndata: /, '首帧该是 snapshot');
  const first = JSON.parse(sse.writes.join('').split('event: snapshot\ndata: ')[1].split('\n\n')[0]);
  const rowsOf = (t) => t.switchRows.map((r) => [r.key, r.on]);
  // ★ 第十五轮曾裁「出厂档（免费接口）不摆摘要那一行」；**第十七轮用户改判放回** ⇒ 五档两行都在这份真装配里。
  //   这一帧吃的是 index.js 那一份真 webTranslator，所以它是"真服务在真装配下报了什么"的凭据。
  assert.deepEqual(rowsOf(first.translator), [['llmDesc', true], ['llmReadme', false]],
    '出厂态：描述档是开的（用户裁定），摘要档是关的（出厂关）但**这一行得摆出来**（第十七轮放回）');

  const before = sse.writes.length;
  const post = makeRes();
  await h(makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/prefs`, body: { llmDesc: false } }), post);
  await flush(30);
  assert.equal(post.statusCode, 200, JSON.stringify(post.json()));
  const pushed = sse.writes.slice(before).join('');
  assert.match(pushed, /event: update\ndata: /,
    'POST /prefs 之后没推帧 ⇒ 界面只有本地并进去的 prefs，`translator` 两档会一直停在旧值（第八轮真机走查抓到「点了『开』高亮还在『关』」）');
  const frame = JSON.parse(pushed.split('event: update\ndata: ')[1].split('\n\n')[0]);
  assert.equal(frame.prefs.llmDesc, false, '帧里带的是库里的新偏好');
  assert.deepEqual(rowsOf(frame.translator), [['llmDesc', false], ['llmReadme', false]], '跟着偏好算的那两行必须一起翻（客户端只念 translator，不自己判）');
  assert.deepEqual(Object.keys(frame).sort(), Object.keys(first).sort(), 'update 帧与 snapshot 帧同形：客户端不许凭空补字段');

  // 非现译键也走同一条路（检查间隔那类改动同样有"跟着算的键"：cadence）
  const b2 = sse.writes.length;
  const post2 = makeRes();
  await h(makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/prefs`, body: { topN: 9 } }), post2);
  await flush(30);
  const f2 = JSON.parse(sse.writes.slice(b2).join('').split('event: update\ndata: ')[1].split('\n\n')[0]);
  assert.equal(f2.prefs.topN, 9);
  assert.deepEqual(rowsOf(f2.translator), [['llmDesc', false], ['llmReadme', false]], '上一行的读数得留着：推的是整份快照，不是这一次改的那一格');

  // 保存失败那一趟不许推帧：库里没变，推一帧只会把别的页面刷成"看起来成功了"
  const b3 = sse.writes.length;
  const bad = makeRes();
  await h(makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/prefs`, body: { llmDesc: 'yes' } }), bad);
  await flush(30);
  assert.equal(bad.statusCode, 400, '非严格布尔该拒');
  assert.equal(sse.writes.slice(b3).join('').includes('event: update'), false, '400 那一趟不推帧');

  teardown();
  await flush(5);
});

/* ★ 10-06 第九轮新增、第十轮扩到三家、第二十一轮再扩到四把：可填凭据之后「零凭据」那条铁律怎么继续成立（spec §0 / §8.4）。
 *   钉的是**效果**：把三家翻译的凭据 + GitHub 令牌一次 POST 进去，然后逐档切换、扫每一条对外出口的整串 JSON ——
 *   四把密钥一个字节都不许出现，而标识符（AppID / SecretId / AccessKeyId）必须在出口里看得见，
 *   GitHub 那一格则必须报 `has: true`（同一条非空转律：没有它，"扫不到令牌"就只是"根本没存"造成的假绿）。
 *   每档还要 `credFields[].has === true`（这一位是"密钥真进了库"的凭据；少了它，"扫不到"就是假绿）。 */
check('hc-19 ★密钥边界：四把密钥（三家翻译 + 第二十一轮那把 GitHub 令牌）都不出现在任何一条对外出口（快照 / 长连接帧 / GET prefs / POST 回执），也不出现在日志里', async () => {
  const facility = makeFakeFacility();
  const registered = [];
  const ctx = makeFakeCtx({
    facility,
    timerInterval: () => ({ fn: () => {}, unref() {} }),
    webServer: { register: (spec) => { registered.push(spec); return () => {}; } },
  });
  const teardown = apply(ctx, {});
  await flush(10);
  const routeEff = ctx._internals.effects.find((e) => e.name === 'gh-trending:route');
  routeEff.fn();
  const h = registered[0].handler;

  // 凭据格一次给全（键名从 domain 那张表派生 ⇒ 新增那一家/那一把会自动进这一扫，不会漏抄）
  // ★ 第二十一轮：`PREF_CRED_FIELDS` 里除了三家翻译的六格，还有 GitHub 那一把令牌。
  const CRED = Object.fromEntries(PREF_CRED_FIELDS.map((f) => [f.key, `${f.secret ? 'sekret' : 'publicid'}-${f.key}-no-leave`]));
  const exits = [];
  for (const engine of Object.keys(TRANSLATE_CRED_FIELDS)) {
    const post = makeRes();
    await h(makeReq({ method: 'POST', url: `${ROUTE_PREFIX}/api/prefs`, body: { translateEngine: engine, ...CRED } }), post);
    assert.equal(post.statusCode, 200, `${engine}: ${JSON.stringify(post.json())}`);
    exits.push([`${engine} / POST /api/prefs 回执`, JSON.stringify(post.json() ?? {})]);

    const snap = makeRes();
    await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/snapshot` }), snap);
    const body = snap.json() ?? {};
    exits.push([`${engine} / GET /api/snapshot`, JSON.stringify(body)]);

    const prefs = makeRes();
    await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/prefs` }), prefs);
    exits.push([`${engine} / GET /api/prefs`, JSON.stringify(prefs.json() ?? {})]);

    const sse = makeRes();
    await h(makeReq({ method: 'GET', url: `${ROUTE_PREFIX}/api/stream` }), sse);
    await flush(20);
    exits.push([`${engine} / 长连接 snapshot 帧`, sse.writes.join('')]);

    // —— 非空转：这一档的视图在位、两格都真从库里读到了值、标识符确实回显了
    const tr = body?.data?.translator;
    assert.ok(tr, `${engine}: 快照里没有 translator 那一格（拿到的是 ${JSON.stringify(Object.keys(body?.data ?? body))}）`);
    assert.equal(tr.engine, engine);
    assert.equal(tr.credFields.length, TRANSLATE_CRED_FIELDS[engine].length, `${engine}: 视图给的凭据格与 domain 那张表不一致`);
    for (const f of tr.credFields) {
      assert.equal(f.has, true, `${engine}/${f.key}：密钥没落库 ⇒ 下面那几扫是白扫`);
      assert.equal('value' in f, false, `${engine}/${f.key}：视图里出现了 value 位 ⇒ 库里那一格会被回显`);
    }
    for (const f of TRANSLATE_CRED_FIELDS[engine].filter((x) => !x.secret)) {
      assert.equal(JSON.stringify(prefs.json() ?? {}).includes(CRED[f.key]), true, `${engine}/${f.key}：标识符不回显 ⇒ 这一路压根没读到库`);
    }
    // ★ 第二十一轮：GitHub 那一把不跟着翻译档走，但它同样在这一发里被 POST 过 ——
    //   这一位是"令牌真进了库"的凭据：少了它，下面扫不到令牌本体就只是"根本没存"造成的假绿。
    const gh = body?.data?.github;
    assert.ok(gh, `${engine}: 快照里没有 github 那一格`);
    assert.equal(gh.credFields.find((f) => f.key === 'ghToken')?.has, true, `${engine}: 令牌落了库却报"没存" ⇒ 这一扫是空转`);
    assert.equal('value' in gh.credFields[0], false, `${engine}: github 视图里有 value 位 ⇒ 令牌会被回显`);
  }
  const secrets = PREF_CRED_FIELDS.filter((f) => f.secret).map((f) => CRED[f.key]);
  assert.deepEqual(PREF_CRED_FIELDS.filter((f) => f.secret).map((f) => f.key), PREF_SECRET_KEYS,
    '回显闸门吃的清单与字段表对不上 ⇒ 有一把密钥没被这一扫覆盖');
  for (const [name, text] of exits) {
    for (const s of secrets) assert.ok(!text.includes(s), `${name} 里漏出了密钥本体`);
  }
  for (const s of secrets) {
    assert.equal(ctx._internals.logs.warn.some((w) => w.includes(s)), false, '日志里漏出了密钥');
    assert.equal(ctx._internals.logs.error?.some?.((w) => w.includes(s)), false, '错误日志里漏出了密钥');
  }
  teardown();
  await flush(5);
});

check('hc-20 详情窗口的接线（第二十七轮）：装配处不再交 TTL 注入点，60 秒那一格与那句落款的词各只有一份出处', () => {
  const idx = codeOf('index.js');
  assert.doesNotMatch(idx, /getTtlMs|repoCacheTtlMs/,
    'index.js 还在按偏好现取一个 TTL ⇒ 档位已经撤了，这个注入点没有喂主，留着是第二份真相');
  assert.doesNotMatch(idx, /\bttlMs\s*:/,
    '装配处出现 ttlMs: = 把毫秒锁在装配时（第十二轮批评过的那个形状，撤档之后更不该留）');
  // 界面那句落款的两个词只在 domain 一份，装配处只递名字；抄进 index 或 client 就是第二个出处。
  assert.match(idx, /detailStampLabels:\s*DETAIL_STAMP_LABELS/, '载荷没把那一格递出去 ⇒ 客户端读不到词，那句落款会整句消失');
  assert.doesNotMatch(idx, /正文取回于|刚核对过/, 'index.js 抄了那两个词');
  assert.doesNotMatch(codeOf('client.js'), /正文取回于|刚核对过/, 'client.js 自己写了那两个词 ⇒ 同一句话有了第二处');
  // ★ 撤档要撤干净：整条链（domain 定义 / stores 钳制 / api 校验 / index 载荷 / 界面那一行）在**代码位**一处都不认得这个键。
  //   注释位留着那笔账的去处（10-07 的血案写在 schema 那一段），所以扫的是 codeOf。
  const leftover = HOST_FILES.filter((f) => /repoCacheHours|REPO_CACHE_HOURS|repoCacheTtlMs/.test(codeOf(f)));
  assert.deepEqual(leftover, [], `还有文件在代码位认得那个撤掉的键：${leftover.join(', ')}`);
  // 窗口那一格：判据吃 domain 的常数，不在 repo.js 里另写一个毫秒数
  const rp = codeOf('lib/services/repo.js');
  assert.match(rp, /now\(\) - base < DETAIL_RECHECK_MS/, '窗口判据不吃那个常数 ⇒ 60 秒可以在两处各写一个数');
  assert.doesNotMatch(rp, /60 \* 1000|60_000|60000/, 'repo.js 自己写了一个 60 秒的毫秒数（量级写歪本地看不出来）');
  assert.match(rp, /const prev = !refresh && stored\?\.ok === true \? stored : null;/,
    '强制刷新那一发必须一个字都不喂 prev：带着旧验证器去问就是"看着像刷新、其实换回 304 的老正文"');
  assert.equal(DETAIL_RECHECK_MS, 60 * 1000, '常数本身钉住：写成 60 分或 60 毫秒都不会在本地露出来');
});

check('hc-21 GitHub 令牌的接线（第二十一轮）：装配处现取现算，令牌的读者只有详情那一路，界面不抄那两个词', () => {
  const idx = codeOf('index.js');
  assert.match(idx, /getGhToken:\s*\(\)\s*=>\s*getPrefs\(\)\.ghToken/,
    'index.js 没把令牌接成按偏好现取现算 ⇒ 用户在设置页填了令牌，真跑的那一发仍是装配时空的那一份（"保存了却没生效"正是 hc-20 撤掉的那条 TTL 链的形状）');
  assert.doesNotMatch(idx, /const\s+\w*token\w*\s*=/i, '装配处把令牌存成变量 ⇒ 它在装配层多活了一份，改档与清空都追不上');
  // 令牌的键名在宿主半边只许这三处出现：domain（登记）、repo.js（唯一读者）、index.js（把那把现取现算地递过去）。
  // ★ 写路径/回显闸门/界面都**不点名**它（吃的是 PREF_CRED_FIELDS 那份派生表）⇒ 点名处多一处，就是多一个能把令牌递错的出口。
  const readers = HOST_FILES.filter((f) => /\bghToken\b/.test(codeOf(f)));
  assert.deepEqual(readers, ['index.js', 'lib/domain.js', 'lib/services/repo.js'],
    `认得 ghToken 这个键名的文件是 ${readers.join(', ')}：多一处就是多一个出口，少一处则是这一轮没接完`);
  // 「匿名配额 / 已认证配额」那两个字由 domain 给、repo.js 按响应头选，界面只念 —— 抄一份就是第二个真相。
  assert.ok(!/匿名配额|已认证配额/.test(codeOf('client.js')),
    'client.js 自己写了那两个字 ⇒ 宿主报错读数时界面会把它圆成"看着对"的那一句');
});

await runAll('host-compat');
