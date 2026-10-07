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
 * ★ 限额是硬的：匿名 60 次/小时/IP（实测 x-ratelimit-limit: 60），一次点击最多 4 发，所以配缓存（默认 24 小时，可改）。
 *   ★ 第二十一轮改判：60 不再是硬顶 —— 设置页填了 GitHub 令牌就按已认证算（官方文档口径 5000 次/小时，本机零真回包），
 *   令牌**只进 Authorization 请求头**：不进 URL、不落库、不回显、不进日志，发数一发没多。屏上那句「匿名/已认证配额」
 *   跟着 GitHub 自己回的 `x-ratelimit-limit` 走，不抄死（判据见下面 authedOf）。
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
 */
import {
  GITHUB_API_BASE, REPO_TIMEOUT_MS, REPO_CACHE_TTL_MS, REPO_FAIL_TTL_MS, REPO_RATE_ANON,
  RATE_LABEL_ANON, RATE_LABEL_AUTH,
  README_EXCERPT_MAX, README_HEAD_CHARS, README_ZH_MIN_CJK, README_ZH_SECTION_MIN_CJK,
  README_ZH_GATE_MIN_CJK, README_ZH_LANG_RE, README_ZH_GATE_SUFFIXES,
  DESC_SELF_ZH_MIN_CJK, README_ZH_NAME_RE, README_ZH_LINK_MAX, CJK_RE,
  README_ZH_HANS_TOKENS, README_ZH_HANT_TOKENS,
  EXCERPT_SENT_BACK_MAX, EXCERPT_SENT_END_RE,
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
 */
function authedOf(limit, attached) {
  return Number.isFinite(limit) ? limit > REPO_RATE_ANON : attached === true;
}

/**
 * 一发 GET：把"抛错"统一折成 {ok:false,...}，让编排层不必到处 try（与 gh.js 同口径）。
 * ★ 第二十一轮（用户裁定「填 GitHub 令牌抬配额」）：`ghToken` 非空时多一条 `Authorization` 请求头。
 *   令牌**只进请求头**：URL 由 `GITHUB_API_BASE + path` 拼，这两处没有交汇点 ⇒ 「密钥不进 URL」那条红线原样成立；
 *   空串 / 全空格一律当"没填"，不发一条空的 `Authorization:`（GitHub 会按坏凭据拒）。
 */
async function get(fetchFn, path, { accept, timeoutMs, signal, ghToken }) {
  const token = String(ghToken ?? '').trim();
  try {
    const res = await fetchFn(`${GITHUB_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        'user-agent': UA, accept, 'accept-encoding': 'identity',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'follow',
      signal,
      // 单发预算也交给传输层（net.js 认 init.timeoutMs）：REPO_TIMEOUT_MS 若只用来拼报错句子，
      // 那条隧道还按自己的 30s 等 —— 界面已经说"超时 15s"，连接却还挂着，那是假超时。
      timeoutMs,
    });
    const text = await res.text();
    const rate = rateOf(res.headers);
    return { ok: true, status: res.status, text, rate: { ...rate, authed: authedOf(rate.limit, Boolean(token)) } };
  } catch (e) {
    const why = e?.name === 'AbortError'
      ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
      : `${e?.message ?? e}${e?.code ?? e?.cause?.code ? `（${e.code ?? e.cause.code}）` : ''}`;
    return { ok: false, status: 0, text: '', rate: { left: null, resetAt: 0, limit: null, authed: false }, reason: why, configError: e?.code === 'proxy_config' };
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

/**
 * 取一个仓库的详情（不含缓存 —— 缓存在 createRepoDetailService 那层）。
 * 请求数：元数据 1 + README 1（+ 只在默认 README 不是中文时才发 根目录列表 1 + 中文文件 1）⇒ 2~4 发。
 * ★ `zh_section` 那一档**不加发**：它吃的是 README 那一发已经回来的整篇正文（第十一条出网预算：本轮为零）。
 * ★ 第二十一轮：`ghToken` 非空时这四发各带一条 `Authorization`（发数一个字没变 ⇒ 抬的是上限，不是发数）。
 */
export async function fetchRepoDetail({
  repo, fetchFn = globalThis.fetch, timeoutMs = REPO_TIMEOUT_MS, now = () => Date.now(), logger, ghToken = '',
} = {}) {
  const norm = normalizeRepoKey(repo);
  if (!norm.ok) return { ok: false, errKey: 'bad_key', errText: norm.reason, at: now() };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs * 4);   // 最坏四发，整场给 4 倍单发预算
  // 令牌挂在 `sig` 上一起展开：四发调用点本来就 `...sig`，单点接线 ⇒ 漏接一发就是"那一发按匿名算"。
  const sig = { signal: ctrl.signal, ghToken };
  let rate = { left: null, resetAt: 0, limit: null, authed: false };
  const keep = (r) => { if (r.rate?.left !== null) rate = r.rate; return r; };

  try {
    const meta = keep(await get(fetchFn, `/repos/${norm.key}`, { accept: JSON_ACCEPT, timeoutMs, ...sig }));
    if (!meta.ok || meta.status !== 200) {
      const f = failOf(meta, `/repos/${norm.key}`);
      // ★ 失败行也要带 repo：入库行的主键就是它，缺了这一行存不进去 ——
      //   那是"失败缓存永远写不进去，用户每 5 秒重点就每 5 秒烧一发限额"的形状。
      return { ok: false, repo: norm.key, ...f, at: now(), rate };
    }
    let j;
    try { j = JSON.parse(meta.text); } catch {
      return { ok: false, repo: norm.key, errKey: 'parse', errText: '/repos 的正文不是 JSON（接口改版？）', at: now(), rate };
    }
    const fields = {
      repo: norm.key,
      name: str(j.full_name) || norm.display,
      desc: str(j.description),
      lang: str(j.language),
      stars: num(j.stargazers_count),
      forks: num(j.forks_count),
      issues: num(j.open_issues_count),
      topics: (Array.isArray(j.topics) ? j.topics : []).filter((t) => typeof t === 'string' && t).slice(0, 12),
      license: str(j.license?.spdx_id),
      pushedAt: str(j.pushed_at),
      createdAt: str(j.created_at),
      homepage: str(j.homepage),
      htmlUrl: str(j.html_url) || `https://github.com/${norm.key}`,
      archived: Boolean(j.archived),
      isFork: Boolean(j.fork),
    };

    // 默认 README（raw accept：实测直接给 markdown 原文，省一遍 base64）
    const rd = keep(await get(fetchFn, `/repos/${norm.key}/readme`, { accept: RAW_ACCEPT, timeoutMs, ...sig }));
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
      ok: true,
      at: now(),
      rate,
      ...fields,
      descSelfZh: descIsZh(fields.desc).isZh,
      readmeSource,
      readmePath,
      readmeSection,
      readmeExcerpt: ex.text,
      readmeChars: bodyChars,
      readmeCut: ex.cut,
      zhCjk,
    };
  } finally {
    clearTimeout(timer);
  }
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
    'readmeExcerpt', 'readmeChars', 'readmeCut', 'descSelfZh', 'zhCjk']) {
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
 * ★ 第十二轮：TTL 从「装配时锁死的一个数」改成 `getTtlMs()` **调用时现取现算** ——
 *   用户在设置页改档之后，`prefsView` 立刻是新值，下一发详情就该按新档判新鲜；
 *   若装配时把毫秒抄进来（`ttlMs = …`），改档要到宿主重启才认，而界面上已经显示成新档了。
 *   失败档不吃这一路：`failTtlMs` 仍是常数（5 分钟那一档按裁定不进设置页）。
 * ★ 第二十一轮：GitHub 令牌同一条律 —— `getGhToken()` 每发现取。
 *   设置页填完令牌不该等宿主重启（"保存了却没生效"正是第十二轮那笔账的形状）；
 *   反过来，清空令牌也必须下一发就回到匿名调用，否则库里已经没了、发出去还带着。
 */
export function createRepoDetailService({
  repoStore, fetchFn = globalThis.fetch, now = () => Date.now(),
  getTtlMs = () => REPO_CACHE_TTL_MS, failTtlMs = REPO_FAIL_TTL_MS, timeoutMs = REPO_TIMEOUT_MS, logger,
  getGhToken = () => '',
} = {}) {
  let lastRate = { left: null, resetAt: 0, limit: null, authed: false };
  const inflight = new Map();     // 同一个人连点两次不该发两遍

  function freshEnough(row) {
    if (!row || !row.at) return false;
    return now() - row.at < (row.ok ? getTtlMs() : failTtlMs);
  }

  async function load(key, { refresh = false } = {}) {
    const norm = normalizeRepoKey(key);
    if (!norm.ok) return repoView({ repo: String(key ?? ''), ok: false, errKey: 'bad_key', errText: norm.reason, at: now() });
    const stored = repoStore?.available ? await repoStore.get(norm.key).catch(() => null) : null;
    if (!refresh && freshEnough(stored)) {
      return repoView({ ...stored, repo: norm.key }, { cached: true, ageMs: now() - stored.at, rate: lastRate });
    }
    if (inflight.has(norm.key)) return inflight.get(norm.key);
    const p = fetchRepoDetail({ repo: norm.key, fetchFn, now, timeoutMs, logger, ghToken: getGhToken() })
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
