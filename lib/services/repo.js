/**
 * lib/services/repo.js —— 仓库详情：`api.github.com` 的元数据 + README（含"仓库自带中文说明"探测）+ 中文分段摘要。
 *
 * 为什么需要这一层：榜面只给一行英文描述，用户点了热榜看不出「这个项目是干什么的」（2026-10-05 用户口径）。
 * 这里只做三件诚实的事，**不发模型、不自己造译文**（现译是 `lib/services/web-translate.js` / `llm.js` 那一路，来源在字面上分开）：
 *   1. 把 GitHub 自己给的字段拼成中文**段**（是什么 / 热度与维护 / 仓库怎么介绍自己），
 *   2. 找仓库**自己写的**中文 README（默认 README 本身就是中文、根目录里有 zh 命名的那份、★ 第十五轮：或默认 README
 *      那行语言切换里写着的那一份（可以在 `docs/i18n/` 这类第二层目录）、或整篇里嵌着一段中文小节），
 *      有就节选，没有就照实说没有，
 *   3. 判出「仓库自己的描述本来就是中文」这一格（`descSelfZh`），api 层据此**不派现译**（见 domain 的 DESC_SELF_ZH_MIN_CJK）。
 *
 * ★ 出网只用注入的 fetchFn（生产传 net.fetch，测试喂假响应），且**形状不合法的名字一个字节都不发出去**
 *   —— 与 gh.js 的语言 slug 同一条律：闸门在造 URL 之前，不在错误处理里。
 * ★ 条件请求只在这一个文件里发生（与 gh.js 榜面那一路同形状但各写各的）：验证器**只进 `If-None-Match` 请求头**，
 *   与令牌那条 `Authorization` 走同一个出口；304 那一发**绝不读正文**（GitHub 给 0 字节，读了就是拿空串当新正文）。
 * ★ 限额是硬的：匿名 60 次/小时/IP（实测 x-ratelimit-limit: 60），一次点击最多 4 发。
 *   ★ 第二十一轮改判：60 不再是硬顶 —— 设置页填了 GitHub 令牌就按已认证算（官方文档口径 5000 次/小时，本机零真回包），
 *   令牌**只进 Authorization 请求头**：不进 URL、不落库、不回显、不进日志，发数一发没多。屏上那句「匿名/已认证配额」
 *   跟着 GitHub 自己回的 `x-ratelimit-limit` 走，不抄死（判据见下面 authedOf）。
 * ★ 第二十七轮（用户裁定「每次点开都问一次，没变就用本地那一份」）：**缓存语义从"按小时不问"换成"带验证器问"**。
 *   每一发详情请求带上一轮的 `If-None-Match`，GitHub 回 304 就复用库里那一段（实测省的是等待与字节：≈500ms→≈100ms、
 *   正文 5,189~35,817B→**0B**；**配额照扣 1** —— 见 domain 的 `DETAIL_RECHECK_MS` 那条，文档那句"304 不计限额"本机不成立）。
 *   窗口只剩一个 60 秒防连点常数，设置页那一行「详情缓存时长」随之撤掉。
 * ★ 第二十三轮（§8.8 步骤 3）：本文件多出**另一路** GET —— 「全站高星」的 `/search/repositories`（`searchRepositories()`）。
 *   它复用同一条私有 `get()`：域名、超时、报错口径与那条 `Authorization` 出口全部同源 ⇒ 令牌的读者仍然只有本文件
 *   （闸门 / 每轮预算 / 落库在 `lib/services/all-stars.js`，那一边连「令牌」这个字都不该认得 —— hc-21 钉着）。
 *   ★ search 与 REST core 是**两套池子**：这一发回包里的 `x-ratelimit-*` 是 search 那一份，不许与详情那一路的读数混着念。
 *
 * 探针读数（2026-10-05，tmp/probe-repo.txt / probe-repo-zh.txt / probe-zh-ratio.txt）：
 *   /repos/{o}/{n}  200 / 0.37~0.56s / 5~6.4KB / 顶层 84~86 键；404 给 {"message":"Not Found"} 118B
 *   /repos/{o}/{n}/readme 带 accept: application/vnd.github.raw → **直接给 markdown 原文**（不用 base64），3.4KB~109.7KB
 *   /repos/{o}/{n}/contents/ → 根目录列表（实测 3~65 项），zh 文件名真名：README-zh_CN.md / README-zh-Hans.md / README-zh-TW.md
 *   中文判据：去标签后首屏 600 字的中日韩**个数**（旧净化口径十个样本：英文侧全 0，中文侧 26~442）。
 *   2026-10-05 起 stripReadme 把徽章串/引用链接/链接定义行也削掉，整篇真机读数改为英文侧 0~2、中文侧 195 / 297
 *   （tmp/probe-cjk-current.mjs、tmp/probe-repo-service.mjs）；阈值 20 不动，理由与占比为什么不行见 domain 的注释。
 *   2026-10-06 第十一轮（tmp/probe-zh-scan.txt / probe-zh-scan2.txt，本机榜面 29 个仓库各 1 发 readme raw）：
 *   段级噪声侧首屏 CJK 最高 11；**命中侧零**（29 个样本里没有「默认篇外文 + 整篇嵌一段中文小节」的仓库）
 *   ⇒ `zh_section` 低命中率如实登记，界面上那句话在没有命中的仓库里永不出现；描述闸门 `descSelfZh` 的价值 likewise
 *   在**不说假话**（省下的是那一发假活），不在省额度（46 行有描述的只 1 行是中文，tmp/probe-desc-zh.txt）。
 *   2026-10-10 第二十七轮（tmp/probe-detail-304.txt，`morluto/rea` 三条路各 3 发 = 9 发，零落库）：
 *   /repos 弱标 `W/"b7196d…"`、/readme 强标 `"7509d8…"`、/contents 强标 `"e72ced…"` 三条路**都支持** If-None-Match → 304；
 *   带篡改 etag 的对照组三条全部回 200（判据有牙）；304 那一发 `x-ratelimit-remaining` 每条路各掉 1
 *   ⇒ 「304 不扣配额」这一条按文档写是错的，本机匿名实测是扣的。★ 已认证那一档本机零样本，不写进结论。
 */
import {
  GITHUB_API_BASE, REPO_TIMEOUT_MS, DETAIL_RECHECK_MS, REPO_FAIL_TTL_MS, REPO_RATE_ANON,
  RATE_LABEL_ANON, RATE_LABEL_AUTH,
  README_EXCERPT_MAX, README_HEAD_CHARS, README_ZH_MIN_CJK, README_ZH_SECTION_MIN_CJK,
  README_ZH_GATE_MIN_CJK, README_ZH_LANG_RE, README_ZH_GATE_SUFFIXES,
  DESC_SELF_ZH_MIN_CJK, README_ZH_NAME_RE, README_ZH_LINK_MAX, CJK_RE,
  README_ZH_HANS_TOKENS, README_ZH_HANT_TOKENS,
  EXCERPT_SENT_BACK_MAX, EXCERPT_SENT_END_RE,
  SEARCH_STARS_FLOOR, SEARCH_PER_PAGE, SEARCH_RATE_ANON,
  REPO_FIELD_LABELS, REPO_FLAG_LABELS, REPO_ERROR_LABELS, REPO_README_SOURCE_LABELS,
  REPO_SECTION_KEYS, REPO_SECTION_LABELS,
  summarySectionLabel,
  engineZhLabel,
} from '../domain.js';
import { DESC_ZH_LABEL, descZhFor } from '../desc-zh.js';

const UA = 'dsh-plugin-gh-trending (read-only, anonymous)';
const JSON_ACCEPT = 'application/vnd.github+json';
const RAW_ACCEPT = 'application/vnd.github.raw';

/* ------------------------------------------------------------------ *
 * 闸门与判据（纯函数，全部可单测）
 * ------------------------------------------------------------------ */

/** owner/name 形状闸门：只认「一段 owner / 一段 name」，脏值不出网。 */
export function normalizeRepoKey(raw) {
  const s = String(raw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const m = /^([\w][\w.-]{0,99})\/([\w][\w.-]{0,139})$/.exec(s);
  if (!m) return { ok: false, key: '', reason: REPO_ERROR_LABELS.bad_key };
  return { ok: true, key: `${m[1]}/${m[2]}`, display: `${m[1]}/${m[2]}` };
}

/** 去 markdown / HTML 噪声：代码块、标签、链接（文字留下、URL 去掉）、表格分隔行。 */
export function stripReadme(md) {
  let s = String(md ?? '')
    .replace(/```[\s\S]{0,20000}?```/g, ' ')
    .replace(/~~~[\s\S]{0,20000}?~~~/g, ' ')
    // 链接定义行（`[npm-image]: https://img.shields.io/...`）整行丢掉：正文里只剩一个 id，读的人不知道那是什么
    .replace(/^[ \t]*!?\[[^\]]+\]:[ \t]+\S.*$/gm, ' ')
    .replace(/<[^>]{0,400}>/g, ' ');
  // 方括号写法一轮削不完：`[![alt][img-id]][link-id]`（徽章）、`[文字][ref-id]`（引用链接）、`[![](图)](链)`（嵌套）。
  // 徽章整串丢掉（alt 是 "CI status" 这类图标名，留着比去掉更废话），引用与图片链接只留文字。
  // ★ 反复削到不再变化（三轮封顶防死循环）：一次 replace 的全局扫描会跨过刚替进来的括号对，剩下半个 `[](...)`。
  for (let round = 0; round < 3; round++) {
    const before = s;
    s = s
      .replace(/\[!\[[^\]]*\]\[[^\]]*\]\]\[[^\]]*\]/g, ' ')
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    if (s === before) break;
  }
  return s
    .replace(/^\s*\|?[ :|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/[#>*`~\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 中日韩字符个数（汉字 + 假名）。窗口外的字不算。 */
export function cjkCount(s) {
  // 字符类只在 domain 存一份；这里用 String.match(全局正则) 不碰 lastIndex（规范里全局匹配前会归零）。
  const hits = String(s ?? '').match(CJK_RE);
  return hits ? hits.length : 0;
}

/**
 * 「这份 README 是不是中文说明」的判据（阈值与理由在 domain 的 README_ZH_MIN_CJK 注释里）。
 * ★ 第十五轮把两件事分开了：`head` 是**判据窗口**（前 600 字，只用来数 CJK），`clean` 是**去标记后的整篇**
 *   （给节选闸门 `excerptOf` 切）。旧版只交 `head` 又拿它当节选 ⇒ 1,600 字那道预算从来没生效，
 *   界面上「节选 600 / 整篇 16,433 字」断在句中，摘要那一发能读到的也只有前 600 字。
 * ★ 两条律没动：判据与展示都吃**同一份净化后的文本**（别一边看原文一边看净化版），只是窗口不同。
 */
export function readmeZhVerdict(md) {
  const clean = stripReadme(md);
  const head = clean.slice(0, README_HEAD_CHARS);
  const cjk = cjkCount(head);
  return { cjk, head, clean, isZh: cjk >= README_ZH_MIN_CJK };
}

/**
 * 多份中文篇并存时的优先档（第二十轮，用户裁定「使用 README.zh.md 这种」）：0 明写简体 / 1 只写 `zh`、`chinese` 不带变体 / 2 明写繁体。
 * ★ **只排序、不过滤**，且只看文件名的词元（目录名不参与）—— 只有繁体时那份繁体照样是 2 档里的唯一候选，仍然被挑中。
 */
export function zhVariantRank(name) {
  const base = String(name ?? '').split('/').pop();
  const toks = base.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (toks.some((t) => README_ZH_HANT_TOKENS.includes(t))) return 2;
  if (toks.some((t) => README_ZH_HANS_TOKENS.includes(t))) return 0;
  return 1;
}

/** 两路共用这同一条比较器（单点：根目录那一档与语言切换行那一档必须挑得一样），同档内仍按字面排序。 */
const byZhPreference = (a, b) => zhVariantRank(a) - zhVariantRank(b) || (a < b ? -1 : a > b ? 1 : 0);

/** 根目录列表里挑中文 README 的文件名（多个先按简繁优先档、同档内按名排序）。 */
export function pickZhReadme(names = []) {
  const hit = names
    .filter((n) => typeof n === 'string' && !n.endsWith('/') && README_ZH_NAME_RE.test(n.toLowerCase()))
    .sort(byZhPreference);
  return hit[0] ?? '';
}

/**
 * 按 markdown 与 HTML 标题把整篇 README 切成小节 `[{heading, raw}]`（第十一轮 `zh_section` 的底座）。
 * ★ **围栏代码块整块跳过**：探针第一版没跳，QwenLM/Qwen 那种「``` 里带 # 开头的行」被切成假标题，
 *   段名取到的是 `token_ids to pad_token and eos_token, …`，而且那一篇的三个"中文段"（68 / 34 / 33 字）**全在围栏里面**
 *   —— 加了状态机后整篇一段都不命中（读数 `tmp/probe-zh-scan.txt` / `probe-zh-scan2.txt`，29 个仓库 0 命中）。
 *   那要是在界面上当小标题念出来就是笑话 ⇒ 判据可以宽，**标题必须在切的时候就不认围栏里的行**。
 * ★ 开篇（第一个标题之前）也算一段，标题给空串：双语仓库的中文段常常就在最前面，切掉它就等于没探到。
 */
export function splitReadmeSections(md) {
  const lines = String(md ?? '').split('\n');
  const out = [];
  let cur = { heading: '', body: [] };
  let fence = null;   // 打开的围栏串（``` 或 ~~~），非 null 时整块不参与切分
  const push = () => {
    if (cur.body.join('\n').trim() || cur.heading) out.push({ heading: cur.heading, raw: cur.body.join('\n') });
  };
  for (const line of lines) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      if (!fence) { fence = f[1]; cur.body.push(line); continue; }
      if (line.trim().startsWith(fence)) { fence = null; cur.body.push(line); continue; }
      cur.body.push(line);
      continue;
    }
    if (fence) { cur.body.push(line); continue; }
    const m = /^\s*#{1,6}\s+(.+?)\s*#*$/.exec(line) || /^\s*<h[1-6][^>]*>([\s\S]+?)<\/h[1-6]>\s*$/i.exec(line);
    if (m) {
      push();
      cur = { heading: String(m[1] ?? m[2] ?? '').replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').trim(), body: [] };
      continue;
    }
    cur.body.push(line);
  }
  push();
  if (!out.length) out.push({ heading: '', raw: String(md ?? '') });
  return out;
}

/**
 * 「整篇里那一段是中文小节」的判据：按文档顺序取**第一段** CJK 达标的（阈值与读数见 domain）。
 * ★ 与 `readmeZhVerdict` 同一条第十五轮分家：`head` 只喂判据（该小节去标记后的前 600 字），
 *   `clean` 是那一小节去标记后的**整段**，界面拿它当节选 —— 节选仍只在**命中的那一段**里切，不许跨到下一段
 *   （跨段的话屏上的节选与判据看到的首屏就不是同一段了，那条判据在下面）。
 */
export function pickZhSection(md) {
  for (const s of splitReadmeSections(md)) {
    const clean = stripReadme(s.raw);
    const head = clean.slice(0, README_HEAD_CHARS);
    const cjk = cjkCount(head);
    if (cjk >= README_ZH_SECTION_MIN_CJK) return { heading: s.heading, head, clean, cjk };
  }
  return null;
}

/**
 * 「仓库自己写的描述本身就是中文」的源侧判据（阈值与读数见 domain 的 DESC_SELF_ZH_MIN_CJK）。
 * ★ 这一条是**闸门**不是文案：命中就压根不派现译 —— 派出去的是一句中文，回来的还是同一句中文，
 *   界面上却挂着「中文描述（免费接口 · 某时刻）」，那是句假话。
 */
export function descIsZh(desc) {
  const cjk = cjkCount(String(desc ?? ''));
  return { cjk, isZh: cjk >= DESC_SELF_ZH_MIN_CJK };
}

/**
 * 「屏上要给的这段节选里已经有中文了」的源侧判据（第十九轮，用户改判「这两种也算有中文」）。
 * 命中就**压根不派摘要那一发**（api 层的闸门），段名跟着说实话（`repoSections`）。两条来路：
 *   ① **混排**（`via='cjk'`）：节选里 CJK 个数 ≥ `README_ZH_GATE_MIN_CJK` —— 中英混排的篇整篇够不上档名那一条 20，
 *      但它确实有中文：派出去的是这段、回来的还是这段里的中文字，落款却念「节译」，那是句假话
 *      （真机 `thedotmack/claude-mem` 节选 9 字，`tmp/probe-excerpt-zh-ratio.txt`）。
 *   ② **仓库自己声明了中文版**（`via='lang'`）：节选里出现「中文」这两个字（语言切换行）——
 *      这条罩的是边界②：中文篇在子目录，根目录名和那行路径都没认出来、或认出来那一发 404 了，
 *      手上只剩这一行字样可凭（切换行常只有两三个字，够不着 ① 的 8；ant-design 英文篇整篇就 2 个 CJK）。
 * ★ 吃**节选**不吃档名那一条律：`README_ZH_MIN_CJK=20` 决定的是「默认 README 本身就是中文」这句档名敢不敢说，
 *   拿 8 去改它会把只有一行切换标签的英文篇改名成中文 ⇒ 档名说谎。两条律问的不是同一件事，阈值就该分开。
 * ★ 「日本語」不算中文：CJK 计数含假名，纯日文篇的切换行只有 3 个字，够不着 8，也不含「中文」⇒ 照旧派摘要
 *   （真机 `m-abozaid/esp32-c3-adblock`，挡了它就是少做用户在用的那一屏）。
 * ★ 零额外请求：吃的还是那一发默认 README 已经拿回来的字。
 */
export function readmeZhOnScreen(excerpt = '') {
  const s = String(excerpt ?? '');
  const cjk = cjkCount(s);
  if (cjk >= README_ZH_GATE_MIN_CJK) return { hit: true, via: 'cjk', cjk };
  if (README_ZH_LANG_RE.test(s)) return { hit: true, via: 'lang', cjk };
  return { hit: false, via: '', cjk };
}

/**
 * 节选：切到 `max`，再往回退到窗口内**最后一个句子收尾**（真机那屏断在 "Install Ask your a" ⇒ 硬切在句中）。
 * 回退最多 `EXCERPT_SENT_BACK_MAX` 字，窗口里一个句末都没有就宁可硬切（少切不如切在对的地方，但整段没了更糟）。
 * ★ 硬切与回切之后都要退掉半个代理对：末尾落在代理对里会渲染成乱码方块。
 */
export function excerptOf(text, max = README_EXCERPT_MAX) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, cut: false };
  let cut = s.slice(0, max);
  const from = Math.max(0, cut.length - EXCERPT_SENT_BACK_MAX);
  let end = -1;
  for (const m of cut.slice(from).matchAll(EXCERPT_SENT_END_RE)) end = from + m.index + m[0].length;
  if (end > 0) cut = cut.slice(0, end);
  const code = cut.charCodeAt(cut.length - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), cut: true };
}

/**
 * 默认 README 正文里那条**语言切换行**指向的中文 README 相对路径（真机：alibaba/open-code-review 的根目录压根没有
 * 中文 README，那份在 `docs/i18n/README.zh-CN.md`，而首屏第 38 行就写着 `English | <a href="docs/i18n/README.zh-CN.md">简体中文</a>`）。
 * ★ 两种写法都认：markdown 的 `[文字](路径)` 与 HTML 的 `href="路径"` —— 真机那一行用的是后一种，只写前一种等于没做。
 * ★ 吃 **raw 原文**不吃 `stripReadme`：净化口径是"链接留文字不留 URL"（首屏装正文不装标记那条律），URL 正好被削掉了。
 */
export function pickZhReadmeLink(md) {
  const s = String(md ?? '');
  const paths = new Set();
  for (const re of [/\[[^\]]*\]\(\s*<?([^<>()\s]+)>?/g, /href\s*=\s*["']([^"']+)["']/gi]) {
    for (const m of s.matchAll(re)) paths.add(m[1]);
  }
  const ok = [...paths].map(zhReadmeRelPath).filter(Boolean).sort(byZhPreference);
  return ok[0] ?? '';
}

/**
 * 一条链接目标 → 合法就给出**仓库根相对的原始路径**（不合法给空串）。
 * ★ 这里不编码：出网那一发在调用点逐段 `encodeURIComponent`（编码只在那一处，界面上 `readmePath` 念的也是这一份原始路径）。
 */
export function zhReadmeRelPath(target) {
  const raw = String(target ?? '').trim();
  if (!raw || raw.length > README_ZH_LINK_MAX) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('#') || raw.includes('\\')) return '';
  const rel = raw.replace(/^(?:\.\/)+/, '');
  if (!/\.md$/i.test(rel)) return '';
  const segs = rel.split('/');
  if (segs.some((x) => !x || x === '.' || x === '..')) return '';
  if (!README_ZH_NAME_RE.test(segs[segs.length - 1])) return '';
  return rel;
}

const fmtInt = (n) => (Number.isFinite(n) ? Math.trunc(n).toLocaleString('en-US') : '');
const fmtDay = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '');
/** 只认数字：null / '' / 'abc' 一律折成"没这个字段"（Number(null) 是 0，那会把"不知道"写成"0 星"）。 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
const str = (v) => (typeof v === 'string' ? v : '');

/* ------------------------------------------------------------------ *
 * 中文段表（宿主分好段、拼好整句，客户端只按 kind 摆字）
 * ------------------------------------------------------------------ */

/** 元数据 → 一行行「列名 · 值」（值缺位就不给这一条，界面不防 undefined）。 */
export function repoFacts(fields = {}) {
  const L = REPO_FIELD_LABELS;
  const out = [];
  const push = (key, value) => { if (value) out.push({ key, label: L[key], value: String(value) }); };
  push('language', fields.lang);
  push('stars', fmtInt(fields.stars));
  push('forks', fmtInt(fields.forks));
  push('issues', fmtInt(fields.issues));
  push('license', fields.license && fields.license !== 'NOASSERTION' ? fields.license : '');
  push('topics', Array.isArray(fields.topics) && fields.topics.length ? fields.topics.join('、') : '');
  push('pushedAt', fmtDay(fields.pushedAt));
  push('createdAt', fmtDay(fields.createdAt));
  push('homepage', fields.homepage);
  return out;
}

/**
 * 详情弹框那四张段（第十一轮「结构化摘要」：宿主分好段、拼好整句，客户端只按 `kind` 摆）。
 * ★ 段对象只有 `{key,label,blocks,facts}` 四格：第十一轮那一份 `source`（每段一句来源落款）
 *   在第十二轮被用户判成废话整格撤掉 ⇒ 界面上不许再有第五句解释。该说的事实在别处：
 *   「不是现译」标签在 `what` 段的整句里、原文那一句另起一行、配额那一行走 `rateText`。
 * ★ 段与段**不重复字段**：数字全在 `heat`，`what` 只说是什么。同屏养两份影子是用户撤掉「总览最近变化小结」
 *   与页签条滚动条时立过的那条律（`client.test.mjs` 有一条判据钉「同一个数在同一屏只出现一次」）。
 * ★ 没内容的段整段不进数组（不写「未知」占位）；但描述那一句例外 —— 「仓库没有写描述。」是句实话，得说。
 * ★ 段里的块只有四种 `kind`（`p` 正文 / `sub` 小字说明 / `num` 数字与回执 / `excerpt` 节选框），
 *   形状由 domain 的 `REPO_BLOCK_KINDS` 钉着；客户端不许自己判"这一段该显示成什么"。
 *
 * `zh` 吃的是 `applyZh` 那份载荷形状：`{ builtin, descModel, descNote, descErr, summary, summaryNote, summaryErr }`。
 * 描述那一句有**五**种来源，字面必须分得开（这是本轮最容易说假话的一格）：
 *   ① 仓库自己写的就是中文 ⇒ 直说"没有调用翻译接口"（api 那边已经把它挡在派活之外）；
 *   ② 内置离线表命中 ⇒ 标 `DESC_ZH_LABEL` 且写明"不是现译"；
 *   ③ 现译给了译文 ⇒ 落款跟**那一行自己的**引擎与时刻（`engineZhLabel`）；
 *   ④ 什么都没给 ⇒ 「原文，未翻译」；⑤ 压根没描述 ⇒ 「仓库没有写描述。」
 *   原文在 ②③ 底下另起一行照给 —— 译文不替换仓库自己写的那句话，读的人有权核对。
 */
export function repoSections(s = {}, zh = {}) {
  const by = {};
  const builtin = zh.builtin ?? descZhFor(s.repo, s.desc);
  const what = [];
  if (s.descSelfZh === true) {
    what.push({ kind: 'p', text: `仓库自己写的描述（这句本身就是中文，没有调用翻译接口）：${s.desc}` });
  } else if (!s.desc) {
    what.push({ kind: 'p', text: '仓库没有写描述。' });
  } else if (builtin) {
    what.push({ kind: 'p', text: `中文描述（${DESC_ZH_LABEL}，不是现译）：${builtin}` });
    what.push({ kind: 'p', text: `仓库自己写的描述（原文）：${s.desc}` });
  } else if (zh.descModel?.zh) {
    what.push({ kind: 'p', text: `中文描述（${zh.descModel.label || engineZhLabel(zh.descModel.engine, zh.descModel.at)}）：${zh.descModel.zh}` });
    what.push({ kind: 'p', text: `仓库自己写的描述（原文）：${s.desc}` });
  } else {
    what.push({ kind: 'p', text: `仓库自己写的描述（原文，未翻译）：${s.desc}` });
  }
  const bits = [];
  if (s.lang) bits.push(`用 ${s.lang} 写`);
  if (s.license && s.license !== 'NOASSERTION') bits.push(`${s.license} 许可证`);
  else if (s.license === 'NOASSERTION') bits.push('许可证 GitHub 没认出来');
  // 只说字段里有的：拼出「这是一个用  写的项目」比少说一半更糟。
  if (bits.length) what.push({ kind: 'p', text: `这是一个${bits.join('、')}的项目。` });
  if (Array.isArray(s.topics) && s.topics.length) {
    what.push({ kind: 'p', text: `主题 ${s.topics.slice(0, 6).join(' / ')}` });
  }
  if (zh.descNote) what.push({ kind: 'sub', text: zh.descNote });
  if (zh.descErr) what.push({ kind: 'num', text: `回执：${zh.descErr}` });
  by.what = { key: 'what', label: REPO_SECTION_LABELS.what, blocks: what, facts: [] };

  const heatFacts = repoFacts(s).filter((f) => ['stars', 'forks', 'issues', 'pushedAt', 'createdAt'].includes(f.key));
  const heat = [
    s.archived ? REPO_FLAG_LABELS.archived : '',
    s.isFork ? REPO_FLAG_LABELS.fork : '',
  ].filter(Boolean).map((text) => ({ kind: 'sub', text }));
  if (heatFacts.length || heat.length) {
    by.heat = { key: 'heat', label: REPO_SECTION_LABELS.heat, blocks: heat, facts: heatFacts };
  }

  const src = s.readmeSource;
  if (src && REPO_README_SOURCE_LABELS[src]) {
    const self = [];
    const excerpt = str(s.readmeExcerpt);
    if (excerpt) self.push({ kind: 'excerpt', text: excerpt });
    // `none` 那一档段名已经把话说完（「… · 这个仓库没有 README」），不再补一句「没有可显示的正文」——
    // 同屏两句同义是用户撤掉聚合条时立过的那条律。
    else if (src !== 'none') self.push({ kind: 'sub', text: '这一份没有可显示的正文。' });
    const meta = readmeMeta({ ...s, readmeExcerpt: excerpt });
    if (meta) self.push({ kind: 'num', text: meta });
    // ★ 第十九轮：闸门命中时段名跟着说实话（判据与这段用的是同一个 `readmeZhOnScreen`、同一份节选，不会分叉）。
    //   不改 `readmeSource` 那五档本身：档名「默认 README 是英文」对这些篇仍然成立，撒谎的是"整篇没中文"那种说法。
    const gate = src === 'en_default' ? readmeZhOnScreen(excerpt) : { hit: false, via: '' };
    by.self = {
      key: 'self',
      label: `${REPO_SECTION_LABELS.self} · ${REPO_README_SOURCE_LABELS[src]}`
        + (src === 'zh_section' && s.readmeSection ? `（小节「${s.readmeSection}」）` : '')
        + (gate.hit ? (README_ZH_GATE_SUFFIXES[gate.via] ?? '') : ''),
      blocks: self, facts: [],
    };
  }

  if (zh.summary?.text) {
    by.summary = {
      key: 'summary',
      // ★ 第十七轮（用户改判第十五轮③，把翻译四档的 `readme` 那一发放回来）：段名跟着那一路走 ——
      //   只有宿主模型那档给的是**摘要**，免费/百度/腾讯/阿里给的是节选的**节译**（逐字译，不是整理）。
      label: `${summarySectionLabel(zh.summary.engine)} · ${zh.summary.label || '现译时刻未给出'}`,
      blocks: [{ kind: 'p', text: zh.summary.text }], facts: [],
    };
  } else if (zh.summaryNote || zh.summaryErr) {
    const blocks = [];
    // ★ 第十六轮（用户裁定「按你推荐的来」）：同一条失败句同屏只念一次。
    //   描述与摘要走的是**同一个**当前档（`pickTranslator` 只选一个服务），它挂掉时两处逐字相同 ——
    //   那句话讲的是那一档的事实（没就绪 / 连不上 / 回了错误），不是这一路各自的事实 ⇒ 描述段已经念过的，这里不念第二遍。
    //   去重只按**已在屏上的字面**判：两路原因不同（描述译成了、摘要 `too_long`）时照旧各说各的。
    //   两块都被去掉时段仍摆 —— 段名「中文现译 · 没取到」本身是新信息，不是重复。
    //   ★ 失败档段名用 `summaryAny`：失败行里没有 `engine`（译文行才署谁译的），切不出摘要/节译两档，
    //     就用一个两边都罩得住的词，不替那一档挂个可能假的名字。
    const said = new Set([zh.descNote, zh.descErr].filter(Boolean));
    if (zh.summaryNote && !said.has(zh.summaryNote)) blocks.push({ kind: 'sub', text: zh.summaryNote });
    if (zh.summaryErr && !said.has(zh.summaryErr)) blocks.push({ kind: 'num', text: `回执：${zh.summaryErr}` });
    by.summary = { key: 'summary', label: `${REPO_SECTION_LABELS.summaryAny} · 没取到`, blocks, facts: [] };
  }
  // ★ 段序只认 domain 的 REPO_SECTION_KEYS：这里不排、客户端也不排。没登记的段拼不出来（拼错键名会整段消失，用例钉得住）。
  return REPO_SECTION_KEYS.map((k) => by[k]).filter(Boolean);
}

/**
 * 把模型现译的两路结果并进详情载荷，并**重拼一遍段表**。★ 必须由宿主并（同 `repoSections` 那条律）：
 * 客户端只摆字，不自己拼「中文描述（…）：」这种带来源标签的整句。
 * ★ B 优先在这里落地：表命中时 `zh.descModel` 直接给空，模型那一发压根不该发（调用方也照这条判）。
 * ★ 重拼吃的是 `sectionFields`（repoView 留下的那一份原始格子），不是 view 本身：view 里没有 lang / stars
 *   这些格子（它们只以段的标签值对出现），拿 view 直接重拼就得到「这是一个 GitHub 仓库。」这种空话头
 *   —— 10-06 真机读数抓到过。拼完把这格删掉，载荷里不给客户端留第二份真相。
 */
export function applyZh(view, { descModel = null, summary = null } = {}) {
  const { sectionFields, ...rest } = view ?? {};
  const out = {
    ...rest,
    zh: {
      builtin: rest.ok === true ? descZhFor(rest.repo, rest.desc) : '',
      // ★ `descModel` 这个键名是第八轮留下的（那时只有宿主模型一档），第九轮起四档共用它：
      //   键名不改（载荷键表由 hc-12 与客户端逐键对齐钉着，改名零收益），但里面这一路是谁译的看 `engine`。
      descModel: descModel && descModel.ok
        ? { zh: descModel.zh, label: descModel.label, cached: descModel.cached === true, at: descModel.at, engine: descModel.engine ?? 'host_llm' }
        : null,
      descNote: descModel && !descModel.ok ? (descModel.note || '') : '',
      // ★ 那句 note 写的是「宿主在 finish 帧里给的回执」⇒ 回执本体必须一起给，
      //   否则界面念了一句「模型答错了（有回执）」而屏上一个回执都没有，用户与我都分不清是配额、鉴权还是没配模型（真机走查抓到过）。
      descErr: descModel && !descModel.ok ? (descModel.errText || '') : '',
      summary: summary && summary.ok
        ? { text: summary.zh, label: summary.label, cached: summary.cached === true, at: summary.at, engine: summary.engine ?? 'host_llm' }
        : null,
      summaryNote: summary && !summary.ok ? (summary.note || '') : '',
      summaryErr: summary && !summary.ok ? (summary.errText || '') : '',
    },
  };
  if (out.ok === true) {
    out.sections = repoSections(sectionFields ?? {}, out.zh);
  }
  return out;
}

/** README 那一行的落款。★ 这句必须由宿主拼：真机第一版让客户端自己拼「节选 N 字」，
 *  拿的是**整篇原文**长度（实测 tester-army/e2e 的 4,235）而屏上给的是**去标记后的首屏**（≤600 字）——
 *  两个不同口径的数并成一句，夹具（readmeChars:195 / 节选也 195）恰好看不出来。
 *  ★ 第十二轮（用户裁定「这里说明是 README 就可以了，少一点废话」）整句压成一行短字面：
 *  `节选 600 / 整篇 4,802 字 · 已去标记 · README.md`。两个数都留着 —— 差在哪要靠数说，不靠解释，
 *  「只取首屏」那半句由 `节选 N / 整篇 M` 那道斜杠自己交代。
 */
export function readmeMeta(fields = {}) {
  const src = fields.readmeSource;
  if (!src || src === 'none') return '';
  const shown = String(fields.readmeExcerpt ?? '').length;
  if (!shown) return '';
  const total = num(fields.readmeChars);
  const size = total === undefined
    ? `节选 ${fmtInt(shown)} 字`
    : total === shown
      ? `节选 ${fmtInt(shown)} 字（整篇就这么多）`
      : `节选 ${fmtInt(shown)} / 整篇 ${fmtInt(total)} 字`;
  return [size, '已去标记', str(fields.readmePath)].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ *
 * 抓取编排
 * ------------------------------------------------------------------ */

function rateOf(headers) {
  const n = (k) => {
    const v = headers?.get?.(k);
    return v === null || v === undefined || v === '' ? null : Number(v);
  };
  const left = n('x-ratelimit-remaining');
  const reset = n('x-ratelimit-reset');
  return {
    left: Number.isFinite(left) ? left : null,
    resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0,
    // ★ 第二十一轮：上限**吃 GitHub 自己回的那一格**，不再钉死 `REPO_RATE_ANON` ——
    //   填了令牌还报 `/60` 就是假读数（而且屏上那句「匿名配额」会跟着说谎）。
    limit: Number.isFinite(n('x-ratelimit-limit')) ? n('x-ratelimit-limit') : null,
  };
}

/**
 * 「这一发算匿名还是算已认证」的判据。★ 顺序不能反：**头在的时候以 GitHub 报的那一格为准** ——
 * 令牌填了但被拒（撤销 / 拼错 / 只剩空白）时 GitHub 仍按匿名回 `limit: 60`，
 * 那句「已认证配额」就等于把"没生效"报成"生效了"（用户在用的那一屏会说假话）。
 * 头不在（老宿主 / 代理吞头 / 非 200 回包）才退回"这一发带没带令牌"。
 * ★ 第二十三轮把"匿名那一档是多少"抽成入参：search 与 REST core 是两套池子，而 search 的**已认证**上限比 core 的
 *   **匿名**上限还低（真读数 10 / 见 domain 的 `SEARCH_RATE_ANON`），拿 60 去判会把填了令牌那一发念成「匿名」——
 *   判据本身只有一条，两个池子各自带自己的匿名读数进来。
 */
function authedOf(limit, attached, anon = REPO_RATE_ANON) {
  return Number.isFinite(limit) ? limit > anon : attached === true;
}

/**
 * 一发 GET：把"抛错"统一折成 {ok:false,...}，让编排层不必到处 try（与 gh.js 同口径）。
 * ★ 第二十一轮（用户裁定「填 GitHub 令牌抬配额」）：`ghToken` 非空时多一条 `Authorization` 请求头。
 *   令牌**只进请求头**：URL 由 `GITHUB_API_BASE + path` 拼，这两处没有交汇点 ⇒ 「密钥不进 URL」那条红线原样成立；
 *   空串 / 全空格一律当"没填"，不发一条空的 `Authorization:`（GitHub 会按坏凭据拒）。
 * ★ 第二十三轮多一个 `rateAnon` 入参：同一个 `get()` 现在罩两条路（详情 / search），而两条路的**匿名那一档不是同一个数**，
 *   「匿名还是已认证」那句话要拿各自池子的读数判（默认仍是 core 那一格 ⇒ 详情那一路一个字节没改）。
 * ★ 第二十七轮多一个 `etag` 入参（条件请求）：非空时发一条 `If-None-Match`，回 304 就**不读正文**直接折成
 *   `{ notModified: true, text: '' }`。★ 这条"不读"是硬的，不是偷懒：真宿主与假 fetch 都在 304 的 `text()` 上抛
 *   （测试替身里那句「304 不该读正文」就是为此摆的），读了要么炸、要么把 0 字节当成新正文覆盖库里那一份。
 *   验证器**只进请求头**（与令牌同一条出口），且**原样转发生日** —— 弱标 `W/"…"` 去掉 `W/` 就换不回 304。
 */
async function get(fetchFn, path, { accept, timeoutMs, signal, ghToken, rateAnon = REPO_RATE_ANON, etag = '' }) {
  const token = String(ghToken ?? '').trim();
  const validator = typeof etag === 'string' ? etag.trim() : '';
  try {
    const res = await fetchFn(`${GITHUB_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        'user-agent': UA, accept, 'accept-encoding': 'identity',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(validator ? { 'if-none-match': validator } : {}),
      },
      redirect: 'follow',
      signal,
      // 单发预算也交给传输层（net.js 认 init.timeoutMs）：REPO_TIMEOUT_MS 若只用来拼报错句子，
      // 那条隧道还按自己的 30s 等 —— 界面已经说"超时 15s"，连接却还挂着，那是假超时。
      timeoutMs,
    });
    const rate = rateOf(res.headers);
    // ★ 先读头再决定要不要读正文：304 那一发没有正文可读。
    const nextEtag = res.headers?.get?.('etag') ?? '';
    const etagOut = typeof nextEtag === 'string' ? nextEtag : '';
    if (res.status === 304) {
      return {
        ok: true, status: 304, notModified: true, text: '',
        etag: validator || etagOut,   // 实测 GitHub 在 304 上把同一个 etag 再回一遍；回空时**沿用手里那把**，别让验证器丢在这一发
        rate: { ...rate, authed: authedOf(rate.limit, Boolean(token), rateAnon) },
      };
    }
    const text = await res.text();
    return {
      ok: true, status: res.status, text, etag: etagOut,
      rate: { ...rate, authed: authedOf(rate.limit, Boolean(token), rateAnon) },
    };
  } catch (e) {
    const why = e?.name === 'AbortError'
      ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
      : `${e?.message ?? e}${e?.code ?? e?.cause?.code ? `（${e.code ?? e.cause.code}）` : ''}`;
    return {
      ok: false, status: 0, text: '', etag: '',
      // ★ 失败那一发也必须回一个 `rate` 形状（本轮重写 `get()` 时差点把它丢了）：
      //   调用方的 `keep()` 按"这一发有没有读数"决定要不要覆盖手里的读数，缺这一格等于**用一次失败擦掉限额那一句**。
      rate: { left: null, resetAt: 0, limit: null, authed: false },
      reason: why, configError: e?.code === 'proxy_config',
    };
  }
}

/** 非 200 的几种情况各给一个 errKey（403/429 且额度报 0 才是限额，别把黑名单/权限问题念成"你没额度了"）。 */
function failOf(r, path) {
  if (!r.ok) {
    return r.configError
      ? { errKey: 'config', errText: `${path} 没出发：${r.reason}`, transport: false }
      : { errKey: 'transport', errText: `api.github.com ${path} 请求失败：${r.reason}`, transport: true };
  }
  if (r.status === 404) return { errKey: 'not_found', errText: `${path} 返回 404`, transport: false };
  if ((r.status === 403 || r.status === 429) && r.rate?.left === 0) {
    return {
      errKey: 'rate_limited',
      transport: false,
      errText: `限额用尽（${r.status}，重置于 ${r.rate.resetAt ? new Date(r.rate.resetAt).toLocaleString('zh-CN') : '未知时刻'}）`,
    };
  }
  return { errKey: 'transport', errText: `api.github.com ${path} 返回 ${r.status}`, transport: false };
}

/** 库里那一行能不能当"元数据那一段的可复用正文"：主键在、且这行是成功行（失败行没有正文可复用）。 */
function prevHasMeta(prev) {
  return prev?.ok === true && typeof prev.repo === 'string' && prev.repo !== '';
}

/** 库里那一行能不能当"README 那一段的可复用正文"：必须**有来源档**在（`none` 也是有效答案：仓库确实没 README）。 */
function prevHasReadme(prev) {
  return prev?.ok === true && typeof prev.readmeSource === 'string' && prev.readmeSource !== '';
}

/**
 * 元数据那一组字段：200 从回包 JSON 读，304 从库里那一行读。
 * ★ 两条路**共用这一个出形函数**（与 `repoView` 那条"两条路都走同一个函数"同一条律）：
 *   各写一遍的话，改天加一个字段只会有一条路有 —— 那是"点第二次才看得见"的那类事故。
 */
function metaFieldsOf(src, norm, fromJson) {
  const pick = (jsonKey, prevKey) => (fromJson ? src[jsonKey] : src[prevKey]);
  const rawTopics = src.topics;   // 两边同名，但下面每一格都要"从 JSON 的键 / 从库里的键"二选一
  return {
    repo: norm.key,
    name: str(pick('full_name', 'name')) || norm.display,
    desc: str(pick('description', 'desc')),
    lang: str(pick('language', 'lang')),
    stars: num(pick('stargazers_count', 'stars')),
    forks: num(pick('forks_count', 'forks')),
    issues: num(pick('open_issues_count', 'issues')),
    topics: (Array.isArray(rawTopics) ? rawTopics : []).filter((t) => typeof t === 'string' && t).slice(0, 12),
    license: fromJson ? str(src.license?.spdx_id) : str(src.license),
    pushedAt: str(pick('pushed_at', 'pushedAt')),
    createdAt: str(pick('created_at', 'createdAt')),
    homepage: str(pick('homepage', 'homepage')),
    htmlUrl: str(pick('html_url', 'htmlUrl')) || `https://github.com/${norm.key}`,
    archived: fromJson ? Boolean(src.archived) : src.archived === true,
    isFork: fromJson ? Boolean(src.fork) : src.isFork === true,
  };
}

/** README 那几格（来源档 / 文件名 / 小节 / 节选 / 字数 / 判据读数）：200 现算，304 原样搬库里那一份。 */
function readmeFieldsFromPrev(prev) {
  return {
    readmeSource: prev.readmeSource,
    readmePath: str(prev.readmePath),
    readmeSection: str(prev.readmeSection),
    readmeExcerpt: str(prev.readmeExcerpt),
    readmeChars: Math.max(0, num(prev.readmeChars) ?? 0),
    readmeCut: prev.readmeCut === true,
    zhCjk: Math.max(0, num(prev.zhCjk) ?? 0),
  };
}

/**
 * 默认 README 那一发回来之后剩下的活：判中文、必要时再找仓库另写的那一份、最后节选。
 * ★ 第二十七轮把它从 `fetchRepoDetail` 里抽出来，只为一件事：**README 304 的那一路一行都不执行它**
 *   （它的判定输入就是 README 正文，正文没变 ⇒ 结论不会变 ⇒ 那条"再找中文那份"的分支整条不发）。
 *   逻辑本身与抽出前逐字相同（第十五轮那两条路只走一条、`zh_section` 零额外请求，口径一个字没改）。
 */
async function probeReadme({ fetchFn, norm, sig, timeoutMs, rd, logger, keep }) {
  let readmeSource = 'none';
  let readmePath = '';
  let readmeSection = '';
  let body = '';
  let bodyChars = 0;   // 与 body 同源那篇的整篇长度：界面说"整篇 N 字，这里只给前 1,600 字"必须指同一篇
  let zhCjk = 0;
  if (rd.ok && rd.status === 200) {
    const v = readmeZhVerdict(rd.text);
    zhCjk = v.cjk;
    body = v.clean;
    bodyChars = rd.text.length;
    readmeSource = v.isZh ? 'zh_default' : 'en_default';
    readmePath = 'README';
    if (!v.isZh) {
      // 默认那份不是中文 ⇒ 再找仓库另写的那一份（一发列表 + 一发正文，最多两发；★ 第十五轮两条路只走一条，发数不变）
      const list = keep(await get(fetchFn, `/repos/${norm.key}/contents/`, { accept: JSON_ACCEPT, timeoutMs, ...sig }));
      let names = [];
      if (list.ok && list.status === 200) {
        try { names = JSON.parse(list.text).filter((f) => f?.type === 'file').map((f) => f.name); } catch { names = []; }
      }
      // ★ 第十五轮：根目录那一层没命中不等于仓库没写中文 README —— 真机 alibaba/open-code-review 那份在
      //   `docs/i18n/README.zh-CN.md`。第二路吃**已经在手的**默认 README：那行语言切换里就写着路径，
      //   零额外请求拿到真路径，只在命中时补一发正文（不去猜目录名，猜不完）。
      const zhPath = pickZhReadme(names) || pickZhReadmeLink(rd.text);
      if (zhPath) {
        const segs = zhPath.split('/').map((x) => encodeURIComponent(x)).join('/');
        const zf = keep(await get(fetchFn, `/repos/${norm.key}/contents/${segs}`, { accept: RAW_ACCEPT, timeoutMs, ...sig }));
        if (zf.ok && zf.status === 200) {
          const zv = readmeZhVerdict(zf.text);
          readmeSource = 'zh_file';
          readmePath = zhPath;
          body = zv.clean;
          bodyChars = zf.text.length;
          zhCjk = zv.cjk;
        }
      }
      // 两份独立文档都没命中 ⇒ 在**已经在手的**默认 README 整篇里找中文小节（第十一轮 `zh_section`）。
      // ★ 顺序在 zh_file 之后：独立那份通常写得全；★ 这一档零额外请求，旧口径只看首屏 600 字，整篇里的小节从来没被看过。
      if (readmeSource === 'en_default') {
        const sec = pickZhSection(rd.text);
        if (sec) {
          readmeSource = 'zh_section';
          readmeSection = String(sec.heading ?? '').slice(0, 120);
          body = sec.clean;
          zhCjk = sec.cjk;
          // bodyChars 不动：节选仍出自同一篇默认 README，落款那句「原文整篇 N 字」指的还是它。
        }
      }
    }
  } else if (rd.ok && rd.status !== 404) {
    const f = failOf(rd, '/readme');
    logger?.warn?.(`[gh-trending] README 取不到（${f.errText}），详情只给元数据`);
  }
  const ex = excerptOf(body);
  return {
    readmeSource, readmePath, readmeSection,
    readmeExcerpt: ex.text, readmeChars: bodyChars, readmeCut: ex.cut, zhCjk,
  };
}

/**
 * 取一个仓库的详情（不含缓存 —— 缓存在 createRepoDetailService 那层）。
 * 请求数：元数据 1 + README 1（+ 只在默认 README **变了且不是中文**时才发 根目录列表 1 + 中文文件 1）⇒ 2~4 发。
 * ★ `zh_section` 那一档**不加发**：它吃的是 README 那一发已经回来的整篇正文（第十一条出网预算：本轮为零）。
 * ★ 第二十一轮：`ghToken` 非空时这四发各带一条 `Authorization`（发数一个字没变 ⇒ 抬的是上限，不是发数）。
 * ★ 第二十七轮：多一个 `prev` 入参（库里那一行）。带着它的验证器去问，回 304 就复用库里那一段：
 *   · 两发都 304 ⇒ **2 发出网、0 字节正文**，界面那句落款变成「正文取回于 3 天前 · 刚核对过」；
 *   · README 304 ⇒ 那条"再找中文那份"的分支**整条不发**（它的判定输入就是 README 正文，正文没变 ⇒ 结论也不会变）。
 * ★★ 不变式（本轮最容易被写歪的一条）：**只有带着验证器出发的那一发才可能回 304**；
 *   回 304 而库里那一段不可用（缺 prev / 缺该段字段）时**立刻不带验证器重发一次**，
 *   绝不把 304 的空正文端给界面 —— 那是"屏上一片空白、落款却说刚核对过"的形状，比多发一发贵得多。
 */
export async function fetchRepoDetail({
  repo, fetchFn = globalThis.fetch, timeoutMs = REPO_TIMEOUT_MS, now = () => Date.now(), logger, ghToken = '',
  prev = null,
} = {}) {
  const norm = normalizeRepoKey(repo);
  if (!norm.ok) return { ok: false, errKey: 'bad_key', errText: norm.reason, at: now() };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs * 4);   // 最坏四发，整场给 4 倍单发预算
  // 令牌挂在 `sig` 上一起展开：四发调用点本来就 `...sig`，单点接线 ⇒ 漏接一发就是"那一发按匿名算"。
  const sig = { signal: ctrl.signal, ghToken };
  const askedAt = now();          // 这一问的时刻 ⇒ 落库的 `checkedAt`（304 也算问过）
  let rate = { left: null, resetAt: 0, limit: null, authed: false };
  const keep = (r) => { if (r.rate?.left !== null) rate = r.rate; return r; };

  try {
    // ---- 元数据那一发：手里有验证器就带着问 ----
    const metaEtag = prevHasMeta(prev) ? String(prev.etagMeta ?? '') : '';
    let meta = keep(await get(fetchFn, `/repos/${norm.key}`, { accept: JSON_ACCEPT, timeoutMs, ...sig, etag: metaEtag }));
    let metaReused = false;
    if (meta.status === 304) {
      if (metaEtag && prevHasMeta(prev)) metaReused = true;
      else meta = keep(await get(fetchFn, `/repos/${norm.key}`, { accept: JSON_ACCEPT, timeoutMs, ...sig }));
    }
    if (!metaReused && (!meta.ok || meta.status !== 200)) {
      const f = failOf(meta, `/repos/${norm.key}`);
      // ★ 失败行也要带 repo：入库行的主键就是它，缺了这一行存不进去 ——
      //   那是"失败缓存永远写不进去，用户每 5 秒重点就每 5 秒烧一发限额"的形状。
      return { ok: false, repo: norm.key, ...f, at: askedAt, rate };
    }
    let fields;
    if (metaReused) {
      fields = metaFieldsOf(prev, norm, false);
    } else {
      let j;
      try { j = JSON.parse(meta.text); } catch {
        return { ok: false, repo: norm.key, errKey: 'parse', errText: '/repos 的正文不是 JSON（接口改版？）', at: askedAt, rate };
      }
      fields = metaFieldsOf(j, norm, true);
    }

    // ---- 默认 README 那一发（raw accept：实测直接给 markdown 原文，省一遍 base64）----
    const rdEtag = prevHasReadme(prev) ? String(prev.etagReadme ?? '') : '';
    let rd = keep(await get(fetchFn, `/repos/${norm.key}/readme`, { accept: RAW_ACCEPT, timeoutMs, ...sig, etag: rdEtag }));
    let readmeReused = false;
    if (rd.status === 304) {
      if (rdEtag && prevHasReadme(prev)) readmeReused = true;
      else rd = keep(await get(fetchFn, `/repos/${norm.key}/readme`, { accept: RAW_ACCEPT, timeoutMs, ...sig }));
    }
    const readme = readmeReused ? readmeFieldsFromPrev(prev)
      : await probeReadme({ fetchFn, norm, sig, timeoutMs, rd, logger, keep });

    // ★ `at` 只在这一问**真拿到过正文**时推进：两发都靠 304 复用 ⇒ 沿用库里那个正文时刻，
    //   屏上那句「正文取回于 …」指的才是正文，而不是"上一次打了一发请求"（`checkedAt` 才是那一格）。
    const reusedBoth = metaReused && readmeReused;
    return {
      ok: true,
      at: reusedBoth ? (num(prev.at) ?? askedAt) : askedAt,
      checkedAt: askedAt,
      // ★ 验证器原样落库（弱标的 `W/` 前缀一个字不动）；这一发没拿到就落空串 ⇒ 下一问退化成裸发，
      //   而不是拿一个不认识的验证器去换一个必然 200 的结果。
      etagMeta: meta.etag ?? '',
      etagReadme: rd.etag ?? '',
      rate,
      ...fields,
      descSelfZh: descIsZh(fields.desc).isZh,
      ...readme,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 「全站高星」那一发（第二十三轮 §1 允许清单本轮唯一新增的一路）
 * ------------------------------------------------------------------ */

/**
 * 那一发的**路径**（不含域名：出网仍只走 `get()` 的 `GITHUB_API_BASE + path`，域名照旧只在 domain 一份）。
 * ★ 门槛数与每页行数**只从 domain 常数来，这一个函数不接任何入参**：设置页那句 note 念的正是这两个常数
 *   （§8.8「不念就等于偷偷定了一道门槛」），这里若允许调用方传别的数，note 与真实查询就会分叉。
 * ★ `>=` 交给 `URLSearchParams` 编码成 `%3E%3D`：手拼字符串时 `>` 会被网关/代理按原样转发，
 *   GitHub 的 search 对未编码的比较符给 422 —— 本地看着是"这一档永远空白"，而 note 还在说"只看 ★ 不低于 100,000"。
 */
export function searchRepoUrl() {
  const qs = new URLSearchParams({
    q: `stars:>=${SEARCH_STARS_FLOOR}`,
    sort: 'stars',
    order: 'desc',
    per_page: String(SEARCH_PER_PAGE),
    page: '1',
  });
  return `/search/repositories?${qs}`;
}

/**
 * 回包 `items[]` 的一行 → `SEARCH_ROW_SHAPE` 那六格（缺 `full_name` 或 `stargazers_count` 的行返回 null = 调用方丢掉）。
 * ★ `rank` 是**这一批里的位次**（原样顺序的 index+1），坏行被丢掉后**留下的行仍拿自己原来的位次**（不重新编号）：
 *   那一列的列名就叫 `#`，重编号会把"GitHub 给的顺序"改成"我数出来的顺序"（§0 那条「两件事不许演成一件」）。
 * ★ 多余字段一个都不带：真回包一条 item 六十多个键（owner / score / text_matches / 各种 url），
 *   跟着进库就是把这一档当成另一份 `repo` 缓存表（§4 那条「不复用 repo 表」的账会当场作废）。
 */
function searchRowOf(item, rank) {
  const full = str(item?.full_name);
  const stars = num(item?.stargazers_count);
  if (!full || stars === undefined) return null;
  return { rank, repo: full.toLowerCase(), name: full, desc: str(item.description), lang: str(item.language), stars };
}

/**
 * 发那一发 search，把回包折成 `{ok, at, rate, rows}`；失败与详情那一路**同一套 errKey**（`failOf` / `parse`），
 * 因为界面那一格念的就是 `REPO_ERROR_LABELS` 里的人话，另立一套键就会多一张对照表。
 * ★ 单发：整场预算 `SEARCH_MAX_PER_ROUND = 1`，所以 AbortController 给的是**单发**预算（详情那一路给 4 倍是因为它最多四发）。
 * ★ 这里**不管闸门、不落库**（§8.8：闸门 + 每轮预算 + 落库在 `all-stars.js`）—— 这一层只回答"GitHub 怎么答"。
 * ★ `rate.authed` 拿 **search 自己**那一份匿名读数判（真回包 10，见 domain 的 `SEARCH_RATE_ANON`），不套 core 的 60；
 *   失败行的 `errText` 是**原样回执**（「限额用尽（403，重置于 …）」），故意**不**过 `REPO_ERROR_LABELS`：
 *   那一张表的 `rate_limited` 那一格写死了「60 次/小时/机器」，念到 search 这一档就是一句假话（两套池子，§0 本轮 ⑤ 末尾）。
 */
export async function searchRepositories({
  fetchFn = globalThis.fetch, timeoutMs = REPO_TIMEOUT_MS, now = () => Date.now(), ghToken = '', logger,
} = {}) {
  const path = searchRepoUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await get(fetchFn, path, { accept: JSON_ACCEPT, timeoutMs, signal: ctrl.signal, ghToken, rateAnon: SEARCH_RATE_ANON });
    if (!r.ok || r.status !== 200) return { ok: false, ...failOf(r, path), at: now(), rate: r.rate };
    let j;
    try { j = JSON.parse(r.text); } catch {
      return { ok: false, errKey: 'parse', errText: 'search 的正文不是 JSON（接口改版？）', transport: false, at: now(), rate: r.rate };
    }
    if (!Array.isArray(j?.items)) {
      return { ok: false, errKey: 'parse', errText: 'search 回包没有 items 数组（接口改版？）', transport: false, at: now(), rate: r.rate };
    }
    const rows = [];
    let dropped = 0;
    j.items.forEach((it, i) => {
      const row = searchRowOf(it, i + 1);
      if (row) rows.push(row); else dropped += 1;
    });
    // 坏行照实说：静默少两行与"GitHub 就给了这些"在屏上长得一样，而日志里必须分得开。
    if (dropped) logger?.warn?.(`[gh-trending] search 回包 ${j.items.length} 条里有 ${dropped} 条读不出 full_name/stargazers_count，这一批按 ${rows.length} 条入库`);
    return { ok: true, at: now(), rate: r.rate, rows };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把「令牌 + 传输层」在**这里**绑成一无参的取批函数，交给 `all-stars.js` 的 runner 调。
 * ★ 为什么要这层绑定（hc-21 那条「认得令牌键名的文件只许三处」）：runner 拿到的是**一个函数**，
 *   不是那把令牌 —— 令牌的取值与去处全留在本文件那条 `get()` 里，编排换文件不换出口。
 * ★ `getGhToken` 现取现算，与 `createRepoDetailService` 同一条第十二轮律：设置页填完/清空令牌都不该等宿主重启。
 */
export function createSearchFetcher({
  fetchFn = globalThis.fetch, timeoutMs = REPO_TIMEOUT_MS, now = () => Date.now(), logger, getGhToken = () => '',
} = {}) {
  return () => searchRepositories({ fetchFn, timeoutMs, now, logger, ghToken: getGhToken() });
}

/* ------------------------------------------------------------------ *
 * 出边界的两份形状：入库行 / 给界面的视图
 * ------------------------------------------------------------------ */

/** 入库行：只挑 schema 声明的字段（rate 是"这一小时"的读数，不属于某个仓库，不落这行）。 */
export function repoCacheRow(d) {
  const row = { repo: d.repo, at: d.at ?? 0, ok: d.ok === true };
  if (!d.ok) {
    if (d.errKey) row.errKey = d.errKey;
    if (d.errText) row.errText = d.errText;
    return row;
  }
  for (const k of ['name', 'desc', 'lang', 'stars', 'forks', 'issues', 'topics', 'license', 'pushedAt',
    'createdAt', 'homepage', 'htmlUrl', 'archived', 'isFork', 'readmeSource', 'readmePath', 'readmeSection',
    'readmeExcerpt', 'readmeChars', 'readmeCut', 'descSelfZh', 'zhCjk',
    // ★ 第二十七轮那三格：`checkedAt` 是"上一次问过 GitHub"，两格 etag 是下一问的钥匙。
    //   缺格的老行读出来是 undefined ⇒ 这一问不带验证器裸发 ⇒ 下一轮自然补齐（不需要迁移）。
    'checkedAt', 'etagMeta', 'etagReadme']) {
    if (d[k] !== undefined && d[k] !== '' && d[k] !== null) row[k] = d[k];
  }
  return row;
}

/**
 * 界面载荷。★ 缓存命中与刚取回两条路**都走这一个函数**：
 * 两条路各拼一份的话，改天加了字段只会有一条有 —— 那是"真机点第二次才看得见"的那类事故。
 */
export function repoView(src, { cached = false, ageMs = 0, rate = {} } = {}) {
  // ★ 文本字段在这里统一过一次形状闸门：这一份 src 可能来自库里躺着的外部改动过的行（手改 json、换机搬库），
  //   那种行没经过 fetch 时的 str() 守卫，一个 {spdx:'MIT'} 会变成「[object Object]」糊在详情里。
  const s = {
    ...src,
    desc: str(src.desc), lang: str(src.lang), license: str(src.license),
    homepage: str(src.homepage), readmePath: str(src.readmePath), name: str(src.name),
    pushedAt: str(src.pushedAt), createdAt: str(src.createdAt),
    readmeSection: str(src.readmeSection),
  };
  // ★ 节选正文先落定，段与落款再从它算字数：界面上「节选 N 字」的 N 必须是屏上真正给了的那段，
  //   不能是入库行里可能形状不对的原始值（同上面 str() 那条律）。
  const excerpt = str(s.readmeExcerpt);
  // ★ 段表要吃的**原始格子**（数字与布尔在拼成人话那一刻就没了，`applyZh` 并完现译要靠这份重拼一遍）。
  //   这一格唯一读者是宿主自己：`applyZh` 用完就从载荷里删掉，不许变成客户端的第二份真相。
  const sectionFields = s.ok === true ? {
    repo: s.repo ?? '', desc: s.desc, lang: s.lang, license: s.license,
    stars: s.stars, forks: s.forks, issues: s.issues,
    topics: Array.isArray(s.topics) ? s.topics : [],
    pushedAt: s.pushedAt, createdAt: s.createdAt,
    archived: s.archived === true, isFork: s.isFork === true,
    readmeSource: s.readmeSource ?? '', readmePath: s.readmePath, readmeSection: s.readmeSection,
    readmeExcerpt: excerpt, readmeChars: s.readmeChars, readmeCut: s.readmeCut === true,
    zhCjk: s.zhCjk, descSelfZh: s.descSelfZh === true,
  } : null;
  return {
    repo: s.repo ?? '',
    name: s.name || s.repo || '',
    at: s.at ?? 0,
    ok: s.ok === true,
    cached,
    cacheAgeMs: ageMs,
    // ★ 第二十七轮：`revalidated` = 这行正文之后**又问过 GitHub、而正文没换**（`checkedAt > at`）。
    //   界面那句「· 刚核对过」吃的就是这一格 —— 判档在宿主，客户端只按布尔摆字（不自己比两个时刻）。
    //   ★ 条件请求之前写的老行没有 `checkedAt` ⇒ 落 false：那句落款只剩「正文取回于 …」，不假装核对过。
    checkedAt: Math.max(0, num(s.checkedAt) ?? 0),
    revalidated: s.ok === true && (num(s.checkedAt) ?? 0) > (num(s.at) ?? 0),
    errKey: s.errKey ?? '',
    // 认得的键翻成人话，认不出的原样交回（与 transportSourceLabel 同一条律：界面不许猜翻译）
    error: s.errKey ? (REPO_ERROR_LABELS[s.errKey] ?? String(s.errKey)) : '',
    errText: s.errText ?? '',
    // 详情弹框的四张段：句子、落款、元数据条全在这里拼定，客户端只按 `blocks[].kind` 摆字。
    sections: sectionFields ? repoSections(sectionFields, {}) : [],
    sectionFields,
    desc: s.desc,
    htmlUrl: s.htmlUrl ?? '',
    homepage: s.homepage,
    readmeSource: s.readmeSource ?? '',
    readmePath: s.readmePath,
    readmeExcerpt: excerpt,
    readmeChars: Math.max(0, num(s.readmeChars) ?? 0),
    readmeCut: s.readmeCut === true,
    zhCjk: Math.max(0, num(s.zhCjk) ?? 0),
    // ★ 第二十一轮：`limit` 吃响应头（没读到才退回出厂那一格，那是**保守**读数：宁可梦见 60，不可梦见 5000）；
    //   `label` 由宿主给（「匿名配额」/「已认证配额」）—— 客户端不排表也不自己写这两个字，同 `switchRows[].label` 那条律。
    rate: {
      limit: Number.isFinite(rate.limit) ? rate.limit : REPO_RATE_ANON,
      left: rate.left ?? null,
      resetAt: rate.resetAt ?? 0,
      label: rate.authed === true ? RATE_LABEL_AUTH : RATE_LABEL_ANON,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 带缓存的详情服务（api 层只认这一个门面）
 * ------------------------------------------------------------------ */

/**
 * ★ 第二十七轮：详情这一层的"多久再问一次"从**四档可调 TTL** 换成**一个 60 秒防连点窗口**（`DETAIL_RECHECK_MS`）。
 *   窗口之外每一问都带验证器（条件请求），GitHub 说没变就复用库里那一段 ⇒ 屏上那句还是「正文取回于 3 天前」，
 *   而它现在是真的（问过、没变），不再是"没问过所以不知道"。
 *   ★ 因此 `getTtlMs()` 这个注入点**删掉了**：装配时锁死一个常数正是第十二轮批评过的形状，但那一轮批评的前提是
 *   "界面上有个能改的档位"；档位撤了以后没有可现取的东西，留一个没人喂的函数入口只是第二份真相。
 *   失败档不吃这一路：`failTtlMs` 仍是 5 分钟那一档（按裁定不进设置页），失败行也**不带验证器**（库里没有正文可复用）。
 * ★ 第二十一轮：GitHub 令牌同一条律 —— `getGhToken()` 每发现取。
 *   设置页填完令牌不该等宿主重启（"保存了却没生效"正是第十二轮那笔账的形状）；
 *   反过来，清空令牌也必须下一发就回到匿名调用，否则库里已经没了、发出去还带着。
 */
export function createRepoDetailService({
  repoStore, fetchFn = globalThis.fetch, now = () => Date.now(),
  failTtlMs = REPO_FAIL_TTL_MS, timeoutMs = REPO_TIMEOUT_MS, logger,
  getGhToken = () => '',
} = {}) {
  let lastRate = { left: null, resetAt: 0, limit: null, authed: false };
  const inflight = new Map();     // 同一个人连点两次不该发两遍

  /**
   * 这一行还在窗口里吗（窗口内**一发都不问** = 防连点）。
   * ★ 成功行按 `checkedAt` 判（缺这格的老行退回 `at`：条件请求之前写的行没问过），失败行按 `at` 判 5 分钟。
   *   拿 `at` 判窗口会说假话：一次 304 复用之后 `at` 还是 3 天前 ⇒ 每点一次都重问一遍，60 秒那一档形同不存在。
   */
  function withinWindow(row) {
    if (!row || !row.at) return false;
    if (row.ok !== true) return now() - row.at < failTtlMs;
    const base = num(row.checkedAt) ?? row.at;
    return now() - base < DETAIL_RECHECK_MS;
  }

  async function load(key, { refresh = false } = {}) {
    const norm = normalizeRepoKey(key);
    if (!norm.ok) return repoView({ repo: String(key ?? ''), ok: false, errKey: 'bad_key', errText: norm.reason, at: now() });
    const stored = repoStore?.available ? await repoStore.get(norm.key).catch(() => null) : null;
    if (!refresh && withinWindow(stored)) {
      return repoView({ ...stored, repo: norm.key }, { cached: true, ageMs: now() - stored.at, rate: lastRate });
    }
    if (inflight.has(norm.key)) return inflight.get(norm.key);
    // ★ `prev` 只喂成功行，且 `refresh` 时**一个字都不喂**：底部那颗按钮的文案是「重新取一次（不走缓存）」，
    //   带着验证器去问就成了"看着像强制刷新、其实大概率换回 304 的老正文"，那句话就说谎了。
    const prev = !refresh && stored?.ok === true ? stored : null;
    const p = fetchRepoDetail({ repo: norm.key, fetchFn, now, timeoutMs, logger, ghToken: getGhToken(), prev })
      .then(async (detail) => {
        if (detail.rate && detail.rate.left !== null) lastRate = detail.rate;
        if (repoStore?.available) {
          await repoStore.put(repoCacheRow(detail)).catch((e) => {
            logger?.warn?.(`[gh-trending] 详情缓存写失败（${e?.message ?? e}），本轮结果照样给，只是下次点击会再发一遍`);
          });
        }
        return repoView(detail, { cached: false, rate: detail.rate ?? lastRate });
      })
      .finally(() => inflight.delete(norm.key));
    inflight.set(norm.key, p);
    return p;
  }

  /** 限额读数（left=null = 这个窗口还没碰过 API，不许谎报"还剩 60"）。 */
  return {
    load,
    // ★ 第二十一轮：`limit` 跟着最近那一发的响应头走（没碰过 API 时给出厂那一格 = 保守），
    //   `label` 与载荷里那一句同源 —— 两处各写一次"匿名/已认证"就是第二真相。
    rate: () => ({
      limit: Number.isFinite(lastRate.limit) ? lastRate.limit : REPO_RATE_ANON,
      left: lastRate.left,
      resetAt: lastRate.resetAt,
      label: lastRate.authed === true ? RATE_LABEL_AUTH : RATE_LABEL_ANON,
    }),
  };
}
