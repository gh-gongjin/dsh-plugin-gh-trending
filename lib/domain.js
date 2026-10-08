/**
 * lib/domain.js —— 一份真相：域 schema、枚举、边界、界面文案表只在这一处定义。
 *
 * 浏览器半边不复制任何判定，只渲染 snapshot() 交出去的字段；
 * 客户端若要显示「今日新增」这类列名，也必须读这里的表而不是自己写一遍。
 *
 * 数值口径来自 2026-10-04 的 S0 探针（tmp/probe-gh.txt ~ probe-gh5.txt），
 * 每条带「实测」的常量都有对应读数；没有读数的地方写「待回看」，不许假装量过。
 */
import {
  defineDomain, domainTable, record,
  requiredString, optionalString, requiredInt, optionalInt,
  requiredNumber, optionalNumber, requiredBool, optionalBool,
  requiredEnum, optionalEnum, arrayOfItem, arrayOf,
} from './kv-schema.js';

/* ------------------------------------------------------------------ *
 * 榜与档位（spec §1）
 * ------------------------------------------------------------------ */

/** 三张榜的封闭集合。顺序 = 页签顺序。 */
export const BOARDS = ['daily', 'weekly', 'monthly'];

/** board → 趋势页的 since 参数值。★ 实测 `?since=bogus` 会静默返回日榜，白名单只能守在这里。 */
export const BOARD_SINCE = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

export const BOARD_LABELS = { daily: '日榜', weekly: '周榜', monthly: '月榜' };

/** 各榜「本轮新增星数」列名（实测页面文案：stars today / this week / this month）。 */
export const BOARD_ADDED_LABELS = { daily: '今日新增', weekly: '本周新增', monthly: '本月新增' };

/** 非官方来源注（宿主单点，界面上的来源注就是这一句，不许在客户端再写一遍）。 */
export const TRENDING_SOURCE_NOTE =
  '来源：github.com/trending 页面 HTML，非官方接口，页面改版即失效；名次与新增星数取页面原文，不做二次推算。';

/** 语言判据（实测：条目为 0 时页面仍是 200，唯一可分辨的是 <title> 念没念语言名）。 */
export const LANG_TITLE_RE = /^Trending (.+?) repositories on GitHub/;

export const LANG_CHECK = {
  boarded: '语言有效，这一档有榜',
  'valid-empty': '语言有效，但今天这一档没有上榜仓库',
  unknown: '站点不认识这个语言（页面标题没有念它）',
  'fetch-failed': '没能打开趋势页，无法判断（原因见故障说明）',
};

/* ------------------------------------------------------------------ *
 * 偏好边界（spec §5）
 * ------------------------------------------------------------------ */

/** 检查间隔档位（分钟）。实测单轮 3 次 GET ≈ 0.5~2.4s，页面每档约 0.6~0.7MB。 */
export const CHECK_INTERVALS = [60, 180, 720, 1440];
export const CHECK_INTERVAL_LABELS = { 60: '1 小时', 180: '3 小时', 720: '12 小时', 1440: '24 小时' };

/** 榜单显示条数。★ 实测榜长不固定（日 15 / 周 19 / 月 23 / python 日 13），切片超出榜长就是显示全榜。 */
export const TOP_N_MIN = 5;
export const TOP_N_MAX = 25;

/** 事件流水保留条数边界。★ stores 的钳制与界面控件必须 import 这两个常量。 */
export const KEEP_EVENTS_MIN = 50;
export const KEEP_EVENTS_MAX = 2000;
export const KEEP_EVENTS_STEP = 50;

/* ------------------------------------------------------------------ *
 * 代理（spec §5.2）—— 传输层在 lib/services/net.js，这里的表是它唯一的文案与边界来源
 * ------------------------------------------------------------------ */

/**
 * 代理模式封闭集合。
 * · system：环境变量 → Windows 注册表（出厂默认，用户机器上 ProxyEnable=1、127.0.0.1:7897 就是靠它命中）
 * · custom：只吃设置页那一行地址
 * · direct：永远直连（给「我不想让插件碰注册表」的场合）
 */
export const PROXY_MODES = ['system', 'custom', 'direct'];
export const PROXY_MODE_LABELS = { system: '跟随系统', custom: '自定义地址', direct: '直连' };
export const PROXY_MODE_HINTS = {
  system: '先看 HTTPS_PROXY / ALL_PROXY / HTTP_PROXY，再看 Windows 注册表的系统代理；都没有就直连',
  custom: '只认下面那一行地址，形如 127.0.0.1:7897 或 http://127.0.0.1:7897；只支持 http:// 代理（CONNECT 隧道）',
  direct: '不读环境变量也不读注册表，始终直连 github.com',
};
/** 地址长度上限：超长是「粘错了整段 PAC 脚本」，拒掉比截断诚实。 */
export const PROXY_URL_MAX = 200;

/** 环境变量优先序：https 目标先看 HTTPS_PROXY，再看全量 ALL_PROXY，最后才退 HTTP_PROXY（很多代理一样能接 CONNECT）。 */
export const PROXY_ENV_ORDER = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];

/** 只读查询，不写；reg query 失败/超时按「没读到」处理，不算故障。 */
export const PROXY_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 隧道建立超时（实测经 127.0.0.1:7897 取趋势页整发 2.06s，8s 足够宽）。 */
export const PROXY_TUNNEL_TIMEOUT_MS = 8000;
/** 注册表读取缓存时长：改了系统代理最多一分钟内被感知，避免每轮三发各 spawn 一次 reg。 */
export const PROXY_REGISTRY_TTL_MS = 60000;

/** 传输路径的实话（界面直读，客户端不另写一份）。 */
export const TRANSPORT_VIA_LABELS = { proxy: '代理隧道', direct: '直连', failed: '没能出网', idle: '还没出过网' };

/**
 * 路由来源（net.decideRoute 的 source 键）→ 界面话术。
 * ★ 键是协议、话是单点：客户端只念这里给的字，别在浏览器半边再翻一遍（一处翻两处漂）。
 */
export const TRANSPORT_SOURCE_LABELS = {
  custom: '设置页的自定义地址',
  env: '环境变量',
  registry: 'Windows 系统代理',
  bypass: '命中系统代理例外',
  none: '系统里没有可用代理',
  'mode:direct': '设置页选了直连',
  'registry-unreadable': '读不到系统代理',
};

/**
 * source 里只有 `env:变量名` 这一档带尾巴（排障要知道是哪个环境变量顶进来的），
 * 其余键整串就是表里的 key。查不到的键原样交回，界面不许猜一个翻译。
 */
export function transportSourceLabel(source = '') {
  const s = String(source ?? '');
  if (!s) return '';
  const whole = TRANSPORT_SOURCE_LABELS[s];
  if (whole) return whole;
  const [head, ...rest] = s.split(':');
  const tail = rest.join(':');
  const label = TRANSPORT_SOURCE_LABELS[head];
  return label && tail ? `${label} ${tail}` : s;
}

/** 故障文案的公共尾巴：坏榜要说清「你现在看的是旧数据，以及它自己会再试」。 */
export const TRANSPORT_HINT_TAIL = '榜面冻结在上次成功数据，到下次自动检查会自动重试。';

/**
 * 传输类故障的单点文案（宿主拼，界面只搬运）。
 * 吃 net.describe() 那一份实话：走了代理就说代理地址（打码后），直连就说直连，
 * 配置坏到没出网就照念原因 —— 把三种情况写成同一句「网络不通」是本插件最初那起故障的原因。
 */
export function transportHint(route = {}) {
  if (route?.via === 'failed') return `本轮没有出网：${route.reason || '代理配置不可用'}；${TRANSPORT_HINT_TAIL}`;
  const via = route?.via === 'proxy'
    ? `经代理 ${route.proxy || '（地址没解析出来）'} `
    : '直连';
  return `本轮${via}取 github.com 未通；${TRANSPORT_HINT_TAIL}`;
}

/** 没有路由信息时的回落文案（从未出过网 / 宿主拿不到传输层状态）。 */
export const TRANSPORT_HINT = transportHint({ via: 'direct' });

/* ------------------------------------------------------------------ *
 * 仓库详情（spec §10）—— 数据源 api.github.com，出网走上面那条同一的传输路径
 * 每条带「实测」的常量都对应 tmp/probe-repo.txt / probe-repo-zh.txt / probe-zh-ratio.txt 的读数。
 * ------------------------------------------------------------------ */

export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * 匿名限额：实测响应头 `x-ratelimit-limit: 60`（每小时、按 IP）。
 * ★ 第二十一轮改判：这一格**不再是"本插件的硬顶"** —— 设置页可以填 GitHub 令牌，填了就是下面那一格的上限。
 *   它现在的用途是**判据**：界面上「匿名」还是「已认证」那句话，按 GitHub 自己回的头与这一格比出来（`repo.js` 的 `rateOf`）。
 */
export const REPO_RATE_ANON = 60;

/**
 * 带个人访问令牌（PAT）的上限：官方文档口径 **5,000 次/小时**（匿名是 60）。
 * ⚠️ **本机没有 GitHub 令牌 ⇒ 零真回包**：这一格只用于设置页那句说明，
 *   屏上那行配额读数**一律吃响应头 `x-ratelimit-limit`**，不许拿这一格当读数（写了就是替 GitHub 作承诺）。
 */
export const REPO_RATE_AUTH = 5000;

/** 单发超时。实测 /repos 与 /readme 各 0.37~0.74s（隧道在内），15s 是宽口径。 */
export const REPO_TIMEOUT_MS = 15000;

/**
 * 详情缓存 TTL 的可调档位（第十二轮用户裁定「进设置页，默认 24 小时」）。
 * ★ 封闭集合：设置页只有这一排分段器，`clampPrefs` 只认这几个值 —— 放一个自由整数进去，
 *   「一次点击最多 4 发、60 次/小时的顶撑不起随手刷」这条预算口径就变成随手可改的东西了。
 */
export const REPO_CACHE_HOURS = [6, 12, 24, 72];
export const REPO_CACHE_HOUR_LABELS = { 6: '6 小时', 12: '12 小时', 24: '24 小时', 72: '3 天' };
export const REPO_CACHE_DEFAULT_HOURS = 24;

/** 档位 → 毫秒。不在档位里的值退回出厂档：两处（这里与 `clampPrefs`）算不出第二个答案。 */
export function repoCacheTtlMs(hours) {
  const h = Number(hours);
  return (REPO_CACHE_HOURS.includes(h) ? h : REPO_CACHE_DEFAULT_HOURS) * 60 * 60 * 1000;
}

/**
 * 详情缓存 TTL 的出厂值：**24 小时**（第十二轮改判，此前 12 小时）。
 * 理由：详情回答的是「这个项目是干什么的」，那句话变得比榜慢；星数榜面自己每轮在动，不靠这里刷新。
 * 一次点击最多 4 发（元数据 + 默认 README + 根目录列表 + 中文 README），60 次/小时的顶撑不起随手刷。
 * ★ 这只是**默认档**；真跑的 TTL 由 `index.js` 按当时的 `prefs.repoCacheHours` 现取现算，
 *   所以改档下一发就生效，不用等装配（装配时锁死 = 改档要到下一次重启才认）。
 */
export const REPO_CACHE_TTL_MS = repoCacheTtlMs(REPO_CACHE_DEFAULT_HOURS);

/**
 * 失败行的重试间隔：5 分钟。★ 这一档**不进设置页**（第十二轮）：
 * 404 / 限额用尽这类结果在成功档里不会变，但也不该像成功行那样钉最长那档（3 天）——
 * 用户改名后回来重点，5 分钟后就该给他新答案。
 */
export const REPO_FAIL_TTL_MS = 5 * 60 * 1000;

/** 缓存行数上限：超出按最近使用裁（点过的仓库无限堆在 KV 域里不是设计意图）。 */
export const REPO_CACHE_MAX = 120;

/**
 * README 节选入库上限（实测整篇最大 109,682 字节，全文进 KV 既放不下也没人读）。
 * ★ 第十五轮起这一格**才真的生效**：之前 `body` 拿的是下面那个 600 字判据窗口，
 *   600 的串再过这道 1,600 的闸门等于没切 ⇒ 界面上「节选 600 / 整篇 16,433 字」那个 600 一直是判据窗口，不是节选规格。
 */
export const README_EXCERPT_MAX = 1600;

/** 中文判据的取样窗口：去标签后的前 600 字。★ 只喂判据（数 CJK 个数），不再当节选（见上面那条第十五轮）。 */
export const README_HEAD_CHARS = 600;

/**
 * 节选裁断时**最多往回退多少字**去找句末标点：退过了这个数就宁可硬切。
 * 真机那一屏（earthtoojake/text-to-cad，10-07）断在 "Install Ask your a" ⇒ 窗口末尾正好卡在句中；
 * 回退 200 字内几乎总能撞上一个句子收尾（README 的句子普遍 40~120 字），再远就开始整段没了。
 */
export const EXCERPT_SENT_BACK_MAX = 200;

/**
 * 句末形状：终止符 + 后面跟着**一个新句子的开头**（大写字母 / 中日韩字 / 闭引号闭括号）或到串尾。
 * ★ 为什么要"后面那个字符"：只认 `[.!?]` 会把 `e.g.` / `i.e.` / `v1.12.12` 当成句子收尾，
 *   于是往回退到一个缩写处，切出来的节选莫名其妙短一截。
 * ★ `stripReadme` 把所有空白并成一个空格 ⇒ 这里只认单个空格 `[ ]`，不认换行（节选串里根本没有换行）。
 * ★ 分两支是因为中西文断句的**形状不同**：西文句子之间必有空格（`. Install`），
 *   中文句子之间没有（`。这是下一句`）—— 若把中日韩字塞进 `[ ]+` 那一支，中文篇的回退永远命中不了，
 *   「句子边界收口」这一条对中文 README 就成了假绿（这正是第十五轮要钉死的那一档）。
 */
export const EXCERPT_SENT_END_RE = /(?:[.!?](?=[ ]+(?:[A-Z"'(（）)\]]|[぀-ヿ㐀-䶿一-鿿])|[ ]*$)|[。！？；](?=[぀-ヿ㐀-䶿一-鿿「『【（“”]|[ ]*$))/g;

/**
 * 语言切换链接里那条中文 README 的**相对路径**长度闸门（真机形状：`docs/i18n/README.zh-CN.md`）。
 * ★ 这个串是从 GitHub 正文里抽出来的（远程不可信输入），要进 URL ⇒ 闸门在造 URL 之前，不在错误处理里
 *   （与 `normalizeRepoKey` 同一条律）：绝对 URL、站内绝对路径、`..`、反斜杠、超长的一律不要。
 */
export const README_ZH_LINK_MAX = 200;

/**
 * 判「这份 README 是不是中文说明」的阈值：去标签后首屏的中日韩字符**个数** ≥ 20。
 * ★ 为什么不是占比：实测整篇 CJK 占比区分不了中英文（ant-design 英文篇 2.4% vs 中文篇 2.5%，
 *   markdown 里全是标签、链接和英文术语）—— 旧口径整批读数见 tmp/probe-zh-ratio.txt（2026-10-05 上午）。
 * ★ 当前净化口径（stripReadme 连徽章串/引用链接/链接定义行一起削，首屏装的是正文不是标记）的**整篇真机读数**
 *   由 tmp/probe-cjk-current.mjs 与 tmp/probe-repo-service.mjs 给出（2026-10-05）：
 *   英文侧 linux / qdrant / n8n / vite 全 0，ant-design 英文篇 2（语言切换行「English · 中文」，不是正文），
 *   中文侧 ant-design 的 README-zh_CN.md = 195、ruanyf/weekly = 297。
 *   （test/repo.test.mjs 钉的那三档 297 / 2 / 30 是**夹具前缀**读数 —— 夹具只存每篇前 2,000 字，两边都写在该用例的注释里。）
 *   两侧余量对阈值 20 都够（误判比漏判糟：那会给一段英文挂上「自带中文说明」的标签）。
 */
export const README_ZH_MIN_CJK = 20;

/**
 * 「默认 README 里的一段中文小节」的阈值：同样吃**个数**，与整篇那一档共用 20。
 * ★ 噪声侧读数 `tmp/probe-zh-scan.txt` / `tmp/probe-zh-scan2.txt`（2026-10-06 15:0x，本机三榜真出现过的 78 个仓库里抽 29 个，各 1 发 readme raw）：
 *   首屏 CJK 最高 11，段级噪声源与整篇那一档同（语言切换行「English · 中文」、赞助者表、徽章 alt 文字，每处 1~7 个字）⇒ 20 挡得住。
 * ★ **命中侧当下是零**：29 个样本里没有「默认篇是外文、整篇却嵌着一段中文小节」的仓库。
 *   原先 12:5x 那次量到 QwenLM/Qwen 有三个中文段（68 / 34 / 33），那是**朴素切分器的产物**：
 *   那些中文全在围栏代码块里，加了 fence 状态机 + 判据吃 `stripReadme`（它本来就削代码块）之后一段都不命中。
 *   ⇒ 这一档是给"确实嵌了中文小节的仓库"准备的，不是给当下的榜面省额度；界面上那句「没找到单独的中文 README，但……」在没命中的仓库里永不出现。
 *   用例的命中侧夹具因此是**合成**的（形状照真 README，来处写在该夹具的 `_note` 里，不冒充实测）。
 * ★ 这一档吃的是**已经拿在手里的那一发整篇正文**（默认 README 那一发本来就取回来了，旧口径只看首屏 600 字）
 *   ⇒ 零额外请求，请求数仍是 2~4 发（§10 限额那条律不动）。
 */
export const README_ZH_SECTION_MIN_CJK = README_ZH_MIN_CJK;

/**
 * 摘要那一发的**闸门**阈值（第十九轮，用户改判「这两种也算有中文」）：屏上那段节选里 CJK **个数** ≥ 8 ⇒ 不算"纯英文篇"，不派。
 * ★ 这条**不是档名律**，别拿它改 `readmeZhVerdict`：上面那条 20 决定的是「默认 README 本身就是中文」这句话敢不敢说，
 *   降到 8 会把只有一行语言切换标签的英文篇改名成中文 ⇒ 档案名说谎（真机 claude-mem 的 9 个字就是「中文 · 繁體中文 · 日本語」）。
 *   闸门问的是另一件事：**要派出去的那段原文里已经有中文吗** —— 有就是白花一发，还会把仓库自己写的字挂上「模型节译」的落款。
 * ★ 8 沿用 `DESC_SELF_ZH_MIN_CJK` 的先例（同一条"已经够一短句了"的判断），两例真读数钉两端（`tmp/probe-excerpt-zh-ratio.txt`，
 *   2026-10-07 第十八轮，只读出库行的 CJK 个数）：`thedotmack/claude-mem` 节选 9 个 ⇒ 挡；
 *   `m-abozaid/esp32-c3-adblock` 节选 3 个（全是「日本語」三个字）⇒ **不挡**，那是日文篇，译成中文是真需求。
 * ★ 挡错的方向是"少做一次摘要"，放错的方向是"把中文说成转述 + 白花一发" ⇒ 阈值贴着噪声那一侧放低。
 */
export const README_ZH_GATE_MIN_CJK = 8;

/**
 * 「这行是中文语言切换」的字样：节选里出现「中文」⇒ 仓库自己声明了有中文版（真机形状：
 * `English | <a href="docs/i18n/README.zh-CN.md">简体中文</a>`、`[中文](docs/i18n/README.zh.md)`）。
 * ★ 为什么要单独一条、不靠上面的计数：切换行常常只有两三个字（ant-design 英文篇整篇就 2 个 CJK），够不着 8；
 *   而**边界②**（中文篇在子目录、根目录名和这行路径都没认出来 / 那一发 404 了）手上只剩这一行 ⇒ 只有字样可用。
 * ★ 两边都收窄过：英文 `Chinese` 不认（正文里 "Chinese tea" / "Chinese New Year" 一大把，认了误挡一批真该译的仓库）；
 *   国名「中国 / 中國」也不认（那是市场与地名，不是"本仓库有中文版"的声明）⇒ 只认「中文」这两个字（「繁體中文」含它，命中）。
 */
export const README_ZH_LANG_RE = /中文/;

/**
 * 上面那条闸门命中时，`self` 段段名后面跟的那半句（按 `via` 取，只说**关于这份 README 的事实**，不解释策略）：
 * ★ 为什么非改不可：`en_default` 的档名是「默认 README 是英文」，而闸门命中的那些篇屏上就摆着中文
 *   （混排的那几个字、或那行「中文 · English」）⇒ 用户接着问的必然是"既然有中文为什么还说是英文"。
 *   同一条律在 `zh_section` 那儿已经用过一次（段名并上小节名，第十二轮撤了段内说明之后只剩这一处）。
 * ★ 不许写「所以没译」：开关关着的时候同样不译，那句会把"用户没开"说成"判出来不该译"。
 */
export const README_ZH_GATE_SUFFIXES = {
  cjk: '（节选里已有中文）',
  lang: '（这行写着有中文版）',
};

/**
 * 「仓库自己的描述本身就是中文」的阈值：描述中文字符个数 ≥ 8 ⇒ 认为那是仓库自己写的中文，不再派现译。
 * ★ 读数（本机榜面那三榜 46 行有描述的，零出网）：英文侧最高 0~1 个汉字，唯一那行中文描述 56 个
 *   ⇒ 8 落在两侧中间。为什么值得做**不是省额度**（46 行里只有 1 行）而是**正确性**：
 *   闸门加之前，`attachZh` 只排掉「内置表命中」和「空描述」，仓库自己写的中文描述会被发给翻译接口，
 *   回来的是**同一句中文**，界面上挂的落款却是「中文描述（免费接口 · 某时刻）」—— 那是句假话。
 * ★ 描述短（GitHub 限 200 字上下），所以不吃首屏窗口，整条描述就是判据的取样面。
 */
export const DESC_SELF_ZH_MIN_CJK = 8;

/** 中日韩字符（汉字 + 假名）。只用来数个数，不做分词。 */
export const CJK_RE = /[㐀-䶿一-鿿぀-ヿ]/g;

/**
 * 仓库自带中文 README 的文件名形状（实测在野的真名：`README-zh_CN.md`、`README-zh-Hans.md`、`README-zh-TW.md`）。
 * ★ 候选不是一张固定路径表去逐个试（上一版按四个猜测路径发四发，四发全 404，404 照样扣限额）：
 *   改成拿一次根目录列表，用这个形状在真名里挑。`README.md` 必须不命中。
 */
export const README_ZH_NAME_RE = /^readme[-_.]*(zh|cn|tw|hans|hant|chn|chinese)/i;

/**
 * 多份中文篇并存时**挑哪一份**的词元名单（第二十轮，用户裁定「使用 README.zh.md 这种」）：按文件名的词元比，不按整串子串
 * （`README.zh-CN.md` 切出 `['readme','zh','cn','md']`；拿子串比会把 `README.zh-cnother.md` 这种拼错的形状也算成简体）。
 * ★ 为什么非改不可：两路挑篇原本都是 `.sort()` 取第一个，而 `'-'`(0x2d) 排在 `'.'`(0x2e) 前面 ⇒
 *   真机 `thedotmack/claude-mem` 那行语言切换同时写着 `docs/i18n/README.zh.md` 与 `docs/i18n/README.zh-tw.md`，
 *   字面排序把**繁体**那份挑中了（读数 `tmp/probe-zh-link-shape.txt` 第 8~9 行与第 40 行）。
 * ★ **只排序、不过滤**：一个仓库只有繁体篇时，那份繁体照旧被挑中 —— 把它过滤掉等于撤掉你在用的那一屏
 *   （同第十七轮那条「不许对任何一档说做不到」）。
 * ★ 同档内仍按字面排序 ⇒「稳定比聪明重要」那条没改判，这一档只是把"哪个语言变体优先"从字面顺序里挪出来。
 * ★ 两份名单同时命中时按**繁体**算（宁可认保守的那一份，也别把繁体篇当简体篇端给你）。
 */
export const README_ZH_HANS_TOKENS = ['hans', 'cn', 'chn'];
export const README_ZH_HANT_TOKENS = ['hant', 'tw', 'hk'];

/**
 * README 来源五档（快照与详情载荷的 `readmeSource` 封闭集合）。
 * ★ `zh_section`（第十一轮）= 默认 README 整篇里有一段中文小节：它**不发第二发**，吃的是默认 README 那一发已经拿回来的正文；
 *   优先级排在 `zh_file` 之后（那份是独立完整文档，通常比内嵌小节写得全），在 `en_default` 之前。
 */
export const REPO_README_SOURCES = ['zh_default', 'zh_file', 'zh_section', 'en_default', 'none'];
export const REPO_README_SOURCE_LABELS = {
  zh_default: '仓库的默认 README 本身就是中文',
  zh_file: '仓库另有一份中文 README',
  zh_section: '默认 README 里有一段中文说明',
  en_default: '默认 README 是英文',
  none: '这个仓库没有 README',
};

/**
 * 详情弹框那几张段的段名（第十一轮「结构化摘要」：宿主分好段，客户端只按段摆）。
 * ★ 顺序就是这里数组的顺序，客户端不排表；段与段**不互相重复字段**（`what` 说是什么，数字全在 `heat`），
 *   同屏养两份影子是用户撤掉「总览最近变化小结」与页签条滚动条时立过的那条律。
 */
export const REPO_SECTION_KEYS = ['what', 'heat', 'self', 'summary'];
export const REPO_SECTION_LABELS = {
  what: '这个项目是做什么的',
  heat: '热度与维护状态',
  self: '仓库自己怎么介绍它',
  summary: '中文摘要',
  // ★ 第十七轮（用户改判第十五轮③「非 host_llm 档不派摘要」）：翻译那四档重新派 `readme` 那一发。
  //   那一发**本来就出得来中文**（第十五轮以"逐字译不是摘要"为由整发撤掉，撤的是用户已经在用的一屏），
  //   保留的只有"说实话"那一半 —— 段名按当前那一路分档：只有宿主模型给的是**摘要**，四档翻译路给的是节选的**节译**。
  summaryTranslate: '中文节译',
  // 失败那一档拿不到 `engine`（失败行不带引擎名），段名用一个两边都罩得住的词。
  summaryAny: '中文现译',
};
// ★ 第十二轮（用户裁定「四段来源落款全撤」）：原来每段那一句 `source`（"这一段读的是 api.github.com 的
//   description / language / license / topics 字段"之类四句）整表删除 ⇒ 段对象不再有 `source` 这一格，
//   客户端不再有那一行渲染。来源这件事该说的两处仍然说：「不是现译」标签与原文那一句、配额那一行。

/** 段里那几种块的字面形状（封闭集合，客户端只认这四档，别的一律不摆）。 */
export const REPO_BLOCK_KINDS = ['p', 'sub', 'num', 'excerpt'];

/** 详情里那一排元数据的中文列名（客户端只念这些字，不自己写）。 */
export const REPO_FIELD_LABELS = {
  language: '主语言', stars: '累计星标', forks: '复刻', issues: '未关闭 issue',
  topics: '主题标签', license: '许可证', pushedAt: '最近推送', createdAt: '建档', homepage: '主页',
};

/** 仓库标志位 → 中文（归档要说清"只读"，否则用户以为还能等到更新）。 */
export const REPO_FLAG_LABELS = {
  archived: '已归档：仓库是只读的，不会再有提交',
  fork: '这是一个复刻（fork），描述与星标可能记在原仓库上',
};

/** 详情取不到东西时的几句话（各说各的原因，不许并成一句「加载失败」）。 */
export const REPO_ERROR_LABELS = {
  bad_key: '这个名字不像 owner/name，没有出网',
  not_found: 'GitHub 说这个仓库不存在（404）——可能已改名、转私有或被删',
  rate_limited: 'GitHub 的匿名限额（60 次/小时/机器）已用尽，等窗口重置后再看',
  transport: '没能连上 api.github.com，走的路线见「运行环境 · 传输路径」',
  config: '代理配置坏到根本没出发，这一发没碰 GitHub（设置页的出网方式那一行）',
  parse: 'GitHub 答了，但正文读不出预期的字段（接口改版）',
};

/* ------------------------------------------------------------------ *
 * 模型现译（代号 C）—— spec §0 第八轮把「零 ctx.llm」改判为「默认零调用」：
 * 句柄只允许出现在 lib/services/llm.js 一个文件里。
 * ★ 第二十二轮改判触发面：原来「只在用户点开详情那一刻才可能发」，现在**一轮检查后也会给榜面补一批**（上限见上面 BOARD_ZH_*）。
 *   改判的是"什么时候发"，没改判"默认零调用"——开关关着 / 引擎没就绪 ⇒ 两边都零发。
 * 花的是宿主模型额度，**不吃**上面那 60 次/小时的 GitHub 限额。
 * ------------------------------------------------------------------ */

/** 现译的两路，各自一个开关（`prefs.llmDesc` / `prefs.llmReadme`）：描述出厂开、摘要出厂关。 */
export const LLM_KINDS = ['desc', 'readme'];
export const LLM_KIND_LABELS = { desc: '仓库描述', readme: 'README 节选' };

/**
 * 设置页那两行开关（数组顺序 = 行序，客户端不排表）。
 * ★ 第十五轮：某一行**摆不摆**由当前那一路服务的 `kinds()` 决定，不在客户端另判一遍引擎 ——
 *   免费 / 百度 / 腾讯 / 阿里四档只有翻译能力，「摘要现译」摆出来就是个点了没用的控件（用户撤聚合条与页签滚动条时立过的那条律）。
 */
export const LLM_SWITCHES = [
  { key: 'llmDesc', kind: 'desc', row: '描述现译' },
  { key: 'llmReadme', kind: 'readme', row: '摘要现译' },
];

/** 单发超时。实测关思考后单发 902ms（`tmp/probe-llm-off.json`），15s 与详情同宽口径。 */
export const LLM_TIMEOUT_MS = 15000;

/** 输出上限：一句描述、一段摘要，超过就当没读出来（模型把提示词回吐成长文时不吃这个闸门就上屏了）。 */
export const LLM_OUT_MAX = 600;

/** 各路的 `maxTokens` 上限（实测关思考后一句描述 12 token；给到 220 / 420 是"整段摘要也够"的宽口径）。 */
export const LLM_MAX_TOKENS = { desc: 220, readme: 420 };

/**
 * 喂进去的正文字数上限。★ 第十五轮起这句才是真话：README 节选入库真的到 1,600 字了
 *   （之前 `body` 只有 600 字的判据窗口，这道 1,800 的闸门跟本吃不到）。留 200 字余量给描述那一路以外的兜底。
 */
export const LLM_IN_MAX = 1800;

/** 关思考的写法：实测只有这一个入口生效（顶层 `thinking` / `reasoning` 适配器不认）。 */
export const LLM_REASONING_EFFORT = 'off';

/** 译文入库行数上限：超出按 `at` 裁最老（和详情缓存同一条律，无限堆在 KV 域里不是设计意图）。 */
export const TRANS_MAX = 200;

/* ------------------------------------------------------------------ *
 * 榜面描述列的补译批次（第二十二轮，用户裁定「按 C 来：榜面也接现译」）
 * 这一节改判的是第八轮那句「点开详情时只译当前这条」⇒ 触发面从「一次点击」扩到「一轮检查」。
 * 三条口径由用户在 2026-10-08 逐条选定：**每轮检查后补** / **每轮 12 发 · 并发 2** / **复用「描述现译」这一档**（不新增开关）。
 * 读路径（GET snapshot）恒零发：界面永远不因为翻译而变慢，配额只在轮次上花。
 * ------------------------------------------------------------------ */

/** 每轮最多补几行。★ 三榜屏上是 3×topN=45 行，内置表今天命中约 33 ⇒ 12 恰好一次补满当天榜面，之后每轮只补新上榜的零星几行。 */
export const BOARD_ZH_BATCH_MAX = 12;

/** 同时在途几发。宿主模型档单发实测 902ms（`tmp/probe-llm-off.json`），两发足够把 12 行在两三轮内跑完；
 *  对免费接口那档，2 并发也不至于像一次性 12 发那样把限流引出来（本机真读数：`wt-27` 的 HTTP 429）。 */
export const BOARD_ZH_CONCURRENCY = 2;

/** 同一行（主键 + 原文）失败后多久内不再试。一轮 60 分钟，30 分钟冷却 ⇒ 坏引擎不会每轮把 12 发额度全烧在同一批死行上。 */
export const BOARD_ZH_FAIL_COOLDOWN_MS = 30 * 60 * 1000;

/** `descZh.hits` 值里「这句中文是哪来的」的封闭集合。★ 一列里混两种来源，来源必须跟着值走，不能只写在卡头。 */
export const DESC_ZH_VIAS = ['builtin', 'live'];
export const DESC_ZH_VIA_LABELS = { builtin: '内置预译', live: '现译' };

/** 现译那一行的悬停说明（与 B 的 `DESC_ZH_NOTE` 分列 —— 两条律各说各的来源，不许并成一句）。 */
export const DESC_ZH_LIVE_NOTE = '这句是每轮检查后给榜面补的现译，按「仓库 + 原文逐字」存在本机；仓库改了描述会重译。';

/**
 * 现译这一路当下发不出去时，榜面那一句实话。★ 不带条数（数字要有拼装函数，而这一句说的是"为什么这一列只有预译"，
 * 与条数无关）；也不说「所以不译」—— 开关关着时走另一条：`llmDesc` 那一行自己在设置页摆着，榜面不唠叨。
 */
export const DESC_ZH_BLOCKED_NOTE = '榜面这一列只显内置预译：现译这一路这会儿发不出去（原因见设置页「现译引擎」那一行），下一轮检查会自动再试。';

/** 现译这一路的失败口径（各说各的，不许并成一句「翻译失败」）。 */
export const LLM_ERROR_KEYS = ['off', 'unavailable', 'no_model', 'timeout', 'error', 'empty', 'too_long', 'store'];
export const LLM_ERROR_LABELS = {
  off: '这个开关没开，没有调用模型',
  unavailable: '宿主没给模型服务（或还没就绪），没有调用模型',
  no_model: '宿主没设默认模型（在宿主设置里给 Agent 选一个），没有调用模型',
  timeout: '模型这一发超时了，原文照给',
  error: '模型答错了（宿主在 finish 帧里给的回执），原文照给',
  empty: '模型答了，但读不出一句中文，原文照给',
  too_long: '模型答得太长，不像一句译文，原文照给',
  store: '译文没存下来（本地存储不可用），这次显示完就丢，下次点开会重译一遍',
};

/** 提示词也是文案：只许在这里写一份（改了要连 `test/llm.test.mjs` 钉的那句一起看）。 */
export const LLM_PROMPTS = {
  desc: '把下面这段 GitHub 仓库英文描述翻译成一句简体中文。只给译文，不要解释、不要引号、不要复述原文。',
  readme: '把下面这段 GitHub 仓库 README 的英文节选整理成一段简体中文摘要（不超过 200 字）。只给摘要正文，不要标题、不要列表符号、不要评价。',
};

/** 设置页那两句说明（开关花的是谁的额度，这里必须说白，别让界面含糊）。
 *  ★ 第九轮被 `TRANSLATE_ENGINE_NOTE` 取代（三档引擎各花谁的钱），第十轮又换成 `TRANSLATE_ENGINE_HINTS`（五档一档一句）
 *  + `TRANSLATE_COMMON_NOTE`（什么时候发、发几次、存哪里 —— 选中哪一档都在）；两个旧常量都删除，不留别名。 */
export const LLM_SWITCH_LABELS = {
  // ★ 措辞不再点名「宿主模型」：这一档管"要不要现译"，**用谁来译**是下面「现译引擎」那一行说的。
  llmDesc: '未命中的仓库描述现译成中文',
  llmReadme: 'README 英文节选另给一段中文摘要',
};
/** ★ 第十七轮：翻译那四档（免费 / 百度 / 腾讯 / 阿里）派 `readme` 那一发时，出去的是**逐字翻译**不是摘要 ⇒ 那一行的说明句换成这句。 */
export const LLM_README_LABEL_TRANSLATE = 'README 英文节选译成中文（这一档只做翻译，这一段是节译不是摘要）';

/**
 * 「这一段到底是什么」的**唯一**措辞处：只有 `host_llm` 给的是摘要，四档翻译路给的是节选的节译。
 * 段名（`repo.js`）与设置页那一行的说明句（`api.js`）都从这里取，别在两处各写一遍"摘要"。
 * ★ 第十七轮（用户改判第十五轮③）—— 第十五轮以"这不是摘要"为由把翻译四档的那一发整个撤了，
 *   本轮把那一发放回来，只保留措辞跟着档位走。
 */
export const isSummaryEngine = (engine) => engine === 'host_llm';
export const summarySectionLabel = (engine) =>
  (isSummaryEngine(engine) ? REPO_SECTION_LABELS.summary : REPO_SECTION_LABELS.summaryTranslate);
export const switchRowLabel = (key, engine) =>
  (key === 'llmReadme' && !isSummaryEngine(engine) ? LLM_README_LABEL_TRANSLATE : (LLM_SWITCH_LABELS[key] || ''));

/**
 * 落款里那一段"这一行是谁译的"（`engineZhLabel` 念它）。
 * `official` = 第九轮只有百度那一档时库里存的行，继续认（旧行不改写，见 `TRANS_ROW_ENGINES`）。
 * ★ 第十二轮（用户裁定「四段来源落款全撤」）：这里原本还有 `ENGINE_SUMMARY_WHO` 与 `summaryNote(engine)`
 *   （「由免费翻译接口从上面那段英文节选整理，不是仓库自己写的中文」）—— 那一句只喂给段里的 `source`，
 *   `source` 一撤它就没人念了，连同 `LLM_SUMMARY_NOTE` 一起删干净（「是谁译的、什么时候」由段名里的
 *   `engineZhLabel` 说：「中文摘要 · 模型现译 · 10-07 12:34」）。
 */
export const ENGINE_LABEL_ZH = {
  keyless: '免费接口', baidu: '百度', tencent: '腾讯', aliyun: '阿里', host_llm: '模型现译', official: '官方接口',
};

/** 宿主没给模型服务时设置页那一句：开关照摆（那是库里的事实），但要说清点了也不会有译文。 */
export const LLM_NOT_READY_HINT = '这台宿主没给模型服务，开关改动仍会存下，但现译不会发生（详情按未翻译给）。';

/* ------------------------------------------------------------------ *
 * 现译引擎（spec §0 第九轮改判「句柄只许一个使用者」+ 第十轮改判「只读 GET」；§8.4）
 * 用户裁定（2026-10-06 第十轮原文）：「腾讯，阿里都接上，切换官方接口时，下面显示去哪个网址注册key」
 *   + AskUserQuestion 两条：「**改判铁律，两家都接**」（翻译域允许厂商标识符进查询串，密钥本体仍只进摘要）
 *                              「**分段器并排五档**」（选中哪家就在下面显示那家的凭据字段 + 注册地址）。
 * ------------------------------------------------------------------ */

/**
 * 五档引擎；数组顺序就是设置页那五个按钮的顺序。默认 `keyless`。
 *  · `keyless` —— Google 网页版翻译（免密钥、单发 GET）。这台机器的实测读数（2026-10-06，tmp/p-g1.json 起）：
 *    经 127.0.0.1:7897 五发全 200、0.40~1.07s/发、`sl=auto` 判种正确；**不经代理直连 12s 超时**
 *    ⇒ 这一路必须走上面那条同一的传输路径（代理没开就是 `transport` 档，不假装成功）。
 *    ★ 它是网页接口不是官方授权接口：ToS 不覆盖程序化调用，对方随时可能改形状 —— 所以错误档里 `bad_json` 单列一档。
 *  · `baidu` —— 百度翻译开放平台通用文本翻译：GET，签名 `MD5(appid + q + salt + 密钥)`（`node:crypto` 自带）。
 *    实测直连可达、不吃代理（未注册时回 `52003 UNAUTHORIZED USER`，见第九轮 tmp 读数）。
 *  · `tencent` —— 腾讯云机器翻译 `TextTranslate`（Version `2018-03-21`、Region `ap-guangzhou`）：
 *    **第十轮改判**的产物 —— 官方签名方法 v1 把参数放在查询串里，GET 发得出去（`tmp/p-tmt-sdk.py` 那轮探针：
 *    这一形状一路走到 `AuthFailure.SecretIdNotFound`，对照组 `Action=FooBarzz` 报 `InvalidAction` ⇒ 不是假绿）。
 *    签名 `Base64(HMAC-SHA1(SecretKey, METHOD + host + path + "?" + 字典序原值 k=v))`，逐字取自官方 Node SDK
 *    （`tmp/p-tc-client.ts:464-481`）；密钥只进这个摘要，`SecretId` 才上查询串。
 *  · `aliyun` —— 阿里云机器翻译通用版 `TranslateGeneral`（Version `2018-10-12`）：RPC V2 签名，
 *    `StringToSign = GET&%2F&percentEncode(规范化查询串)`、`Signature = Base64(HMAC-SHA1(AccessKeySecret + "&", …))`
 *    （官方《V2版本RPC风格请求体&签名机制》help.aliyun.com/document_detail/171299.html）。
 *    实测无凭据 GET 回 HTTP 404 + `{"Code":"InvalidAccessKeyId.NotFound",…,"product":"alimt"}`（`tmp/p-ali-sign.txt`）
 *    ⇒ 形状被受理，但**两家云都是先查密钥 ID 后验签名**，所以签名对不对这件事本机无凭据测不出来（spec §9.4 未验证清单）。
 *  · `host_llm` —— 第八轮那条宿主模型现译，原样留着，只是不再是默认。
 */
export const TRANSLATE_ENGINES = ['keyless', 'baidu', 'tencent', 'aliyun', 'host_llm'];
/** ★ 按钮上的字要短（五档并排在同一个分段器里）：谁译的、要注册什么、离不离得开代理，由下面 `TRANSLATE_ENGINE_HINTS` 那句说。 */
export const TRANSLATE_ENGINE_LABELS = {
  keyless: '免费接口',
  baidu: '百度',
  tencent: '腾讯',
  aliyun: '阿里',
  host_llm: '宿主模型',
};
export const DEFAULT_TRANSLATE_ENGINE = 'keyless';
/**
 * 旧值 → 新值。第九轮那一档叫 `official`（当时只有百度一家），第十轮按厂商拆开命名。
 * ★ 迁移点只有一处（`stores.js` 的 `clampPrefs`）：库里旧值在读的那一刻换成 `baidu`，
 *   否则用户重启一次就静默回到出厂档，等于把「官方接口没填凭据」那句真话换成「一切正常」。
 */
export const LEGACY_TRANSLATE_ENGINES = { official: 'baidu' };
/**
 * `trans` 表那一格里允许出现的引擎名 = 现行五档 + 历史上真写进去过的旧档名。
 * ★ 旧行**不改写**（改一次等于把用户库里的落款换掉）：第九轮那批 `engine:'official'` 的行继续读得出来，
 *   只是新写入的行一律用五档里的名字。少了这一格，schema 会把整行判脏 ⇒ 换档之后旧译文全灭。
 */
export const TRANS_ROW_ENGINES = [...TRANSLATE_ENGINES, ...Object.keys(LEGACY_TRANSLATE_ENGINES)];

/** 各家端点。★ 出网域名白名单由这些派生（`TRANSLATE_HOSTS`），判据不许手抄清单。 */
export const KEYLESS_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
export const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
export const TENCENT_ENDPOINT = 'https://tmt.tencentcloudapi.com/';
export const ALIYUN_ENDPOINT = 'https://mt.aliyuncs.com/';
/** ★ 腾讯 v1 的待签串里 `host + path` 要逐字出现 ⇒ 端点的 path 段就是它，别在签名处再拼一遍斜杠。 */
export const TRANSLATE_ENDPOINTS = {
  keyless: KEYLESS_ENDPOINT, baidu: BAIDU_ENDPOINT, tencent: TENCENT_ENDPOINT, aliyun: ALIYUN_ENDPOINT, host_llm: '',
};
export const TRANSLATE_HOSTS = Object.values(TRANSLATE_ENDPOINTS).filter(Boolean).map((u) => new URL(u).hostname);
/** Region 写死不摆设置页：这一档只服务"英文仓库译成中文"，多一格用户要多懂一个概念，且只有广州这一档实测过。 */
export const TENCENT_REGION = 'ap-guangzhou';
export const TENCENT_VERSION = '2018-03-21';
export const ALIYUN_VERSION = '2018-10-12';

/** 单发超时与两端的长度闸门。实测 4,129 字一发全通（tmp/p-long-out.json），入库的 README 节选本就 1,600 字封顶。 */
export const TRANS_TIMEOUT_MS = 15000;
export const TRANS_IN_MAX = 3500;
/** 译文长度闸门：机器翻译会把整段英文节译成上千字，比模型那档（600）宽，但仍要挡住"回吐整页"。 */
export const TRANS_OUT_MAX = 1200;

/**
 * 各家的凭据形状。★ 密钥只进摘要与本机的存储文件，快照与日志一律不回显；标识符（AppID / SecretId / AccessKeyId）
 * 才上查询串 —— 这一条是第十轮改判后的边界。
 * ★ 第二十一轮再改判一次：下面那张 `GH_TOKEN_FIELD` 是**GitHub 域的凭据**，
 *   它只进 `Authorization` 请求头、**永远不进查询串也不进 URL**（第十轮那次改判的边界到这里为止）。
 */
export const BAIDU_APPID_MAX = 32;
export const BAIDU_KEY_MAX = 64;
export const CRED_ID_MAX = 64;
export const CRED_SECRET_MAX = 64;
/** 设置页按选中的那一档渲染这几格（`secret:true` 的那一格吃 `type=password` 且留空 = 不改动）。 */
export const TRANSLATE_CRED_FIELDS = {
  baidu: [
    { key: 'baiduAppid', label: 'AppID', secret: false, maxLength: BAIDU_APPID_MAX },
    { key: 'baiduKey', label: '密钥', secret: true, maxLength: BAIDU_KEY_MAX },
  ],
  tencent: [
    { key: 'tencentSecretId', label: 'SecretId', secret: false, maxLength: CRED_ID_MAX },
    { key: 'tencentSecretKey', label: 'SecretKey', secret: true, maxLength: CRED_SECRET_MAX },
  ],
  aliyun: [
    { key: 'aliyunAccessKeyId', label: 'AccessKeyId', secret: false, maxLength: CRED_ID_MAX },
    { key: 'aliyunAccessKeySecret', label: 'AccessKeySecret', secret: true, maxLength: CRED_SECRET_MAX },
  ],
};
/** ★ 平铺一份：prefs 的 schema、`publicPrefs` 摘密钥、`hc-19` 扫的密钥清单全部从这一行派生，不许手抄。 */
export const TRANSLATE_CRED_ALL = Object.values(TRANSLATE_CRED_FIELDS).flat();
export const TRANSLATE_SECRET_KEYS = TRANSLATE_CRED_ALL.filter((f) => f.secret).map((f) => f.key);
export const credFieldsOf = (engine) => TRANSLATE_CRED_FIELDS[engine] ?? [];

/**
 * ★ 第二十一轮（用户裁定「填 GitHub 令牌把配额抬到 5000/h」）：GitHub 那一域的凭据格。
 * 长度上限 256：classic PAT 40 字、fine-grained `github_pat_…` 约 93 字，256 是"装得下又不许当正文塞"的宽口径。
 * ★ 这一格与三家云密钥**共用同一套出口闸门**（`PREF_CRED_FIELDS` 派生 schema / clampPrefs / publicPrefs / POST 白名单 / hc-19），
 *   手抄必漏 —— 第十轮那条「清单从字段表派生，不许在测试里数个数」的律在这儿同样成立。
 */
export const GH_TOKEN_MAX = 256;
export const GH_TOKEN_FIELD = { key: 'ghToken', label: 'GitHub 令牌', secret: true, maxLength: GH_TOKEN_MAX };
/** GitHub 那一域要吃的那几格（就一格）。★ 视图层从这一行派生，不许在 `api.js` 里手抄键名/长度/是否密钥。 */
export const GH_CRED_FIELDS = [GH_TOKEN_FIELD];

/** prefs 里所有凭据格（三把云密钥 + 标识符 + GitHub 令牌）：唯一一份清单，五处出口全部从这一行派生。 */
export const PREF_CRED_FIELDS = [...TRANSLATE_CRED_ALL, GH_TOKEN_FIELD];
/** 其中**永不回显**的那几格：`publicPrefs` 摘的就是这一份。 */
export const PREF_SECRET_KEYS = PREF_CRED_FIELDS.filter((f) => f.secret).map((f) => f.key);

/**
 * 令牌那一行的落款：★ 边界必须说在填之前，且**不许含糊成"填了就快"**。
 * 「只需读公共内容、不用勾任何权限」是 PAT 的形状（公开数据走认证配额，与 scope 无关），
 * 但 ⚠️ 这一条本机没有令牌可验 ⇒ 界面只说"读公共内容不需要额外权限"这种可核对的形状，不承诺额度数字以外的东西。
 */
export const GH_TOKEN_NOTE = '这一格只发给 api.github.com，而且只进请求头：不进 URL、不回显在界面上、不进日志、不进快照，存在本机存储文件里（和上面那三把云密钥同一处）。'
  + 'GitHub 的匿名配额是 60 次/小时（按这台机器的 IP），带令牌是 5000 次/小时（官方文档口径）。';
/** 令牌创建页：classic PAT 那一页勾"无 scope"就能读公共内容；fine-grained 那一页也行。 */
export const GH_TOKEN_REGISTER = {
  quota: '令牌只需要读公开内容，额度以 GitHub 官网为准（本机没有 GitHub 账号可验，这一句不替 GitHub 作承诺）。',
  links: [{ label: 'GitHub → Settings → Developer settings → Personal access tokens', url: 'https://github.com/settings/tokens' }],
};
/** 配额那一行前面那两个字的来源：界面无需知道 60 这个数，也不许自己写「匿名」。 */
export const RATE_LABEL_ANON = '匿名配额';
export const RATE_LABEL_AUTH = '已认证配额';

/** 免费/官方这几路的失败口径（各说各的，与模型那八档并列但不混成一句「翻译失败」）。 */
export const TRANS_ERROR_KEYS = ['off', 'no_credential', 'transport', 'http', 'bad_json', 'empty', 'too_long', 'store', 'error'];
export const TRANS_ERROR_LABELS = {
  off: '这个开关没开，没有调用翻译接口',
  no_credential: '这一档的凭据没填全（设置页选中它，下面就是要填的那两格），没有发出请求',
  transport: '没能连上翻译接口（免费接口那一路要经代理，代理没开或不通就是这句），原文照给',
  http: '翻译接口回了错误状态，原文照给',
  bad_json: '翻译接口的回包读不出结构（接口形状变了），原文照给',
  empty: '翻译接口答了，但读不出一句中文，原文照给',
  too_long: '翻译接口回得太长，不像一句译文，原文照给',
  store: '译文没存下来（本地存储不可用），这次显示完就丢，下次点开会重译一遍',
  error: '现译这一路没被派活（内部：路数不认），原文照给',
};

/** 设置页那句共用的话（选中哪一档都在）：什么时候发、发几次、存哪里。 */
export const TRANSLATE_COMMON_NOTE = '现译发生在两处：点开仓库详情那一刻译当前这一条；每轮检查后给榜面上内置表没命中的那几行补一批（一轮最多 12 发、同时在途 2 发）。内置表命中的行不重发。'
  + '译文一律按「仓库 + 原文逐字」存本机，原文改过才重译。';

/** 设置页那一行下面跟着**当前选中档**说的话：这一档是什么、离不离得开代理。★ 一句一档，不摆三档各自的可用性。 */
export const TRANSLATE_ENGINE_HINTS = {
  keyless: '「免费接口」是 Google 的网页版翻译：免注册免密钥，但它不是官方授权接口（对方随时可能改形状），且这台机器直连不通、必须经代理。',
  baidu: '「百度」是百度翻译开放平台的通用文本翻译：注册拿 AppID 与密钥，签名是 MD5；境内直连可达、不吃代理。',
  tencent: '「腾讯」是腾讯云机器翻译 TextTranslate（版本 2018-03-21，地域广州）：要开通服务并新建 API 密钥，签名是 HmacSHA1；境内直连可达。',
  aliyun: '「阿里」是阿里云机器翻译通用版 TranslateGeneral（版本 2018-10-12）：要开通服务并创建 AccessKey，签名是 HMAC-SHA1；境内直连可达。',
  host_llm: '「宿主模型」花的是宿主的模型额度：不注册、不吃第三方额度，也不吃 GitHub 匿名配额。',
};

/**
 * 「去哪注册拿 key」：选中那一家才摆出来。
 * ★ 这里**不念具体额度数字**（`tmp/round10-sources.md` §5）：三家官网这一轮都没给可复核的读数
 *   —— 百度两轮抓取只拿到导航骨架，阿里调用指南通篇没有免费额度表述，腾讯只说额度以「资源包」形式发放。
 *   第三方转述的数字会变、也查不到出处，写进界面就等于替厂商作了承诺 ⇒ 一律指向官网计费页。
 */
export const TRANSLATE_REGISTER = {
  baidu: {
    quota: '免费额度与价格以开放平台官网为准（这一轮没能复核到官网的具体数字）。',
    links: [{ label: '注册并拿 AppID 与密钥', url: 'https://fanyi-api.baidu.com/' }],
  },
  tencent: {
    quota: '额度以「资源包」形式发放，官方快速入门写明 2026 年 10 月之后不再发放新的资源包；以官网计费页为准。',
    links: [
      { label: '开通机器翻译', url: 'https://console.cloud.tencent.com/tmt' },
      { label: 'API 密钥管理（SecretId / SecretKey）', url: 'https://console.cloud.tencent.com/cam/capi' },
    ],
  },
  aliyun: {
    quota: '官网调用指南未写免费额度，只要求使用前了解收费方式与价格；以官网计费页为准。',
    links: [
      { label: '开通机器翻译', url: 'https://mt.console.aliyun.com/' },
      { label: 'AccessKey 管理', url: 'https://ram.console.aliyun.com/manage/ak' },
    ],
  },
};

/** 密钥已存时设置页那一句：输入框留空 = 不改动（快照里永远不回显密钥，界面无从"填回原值"）。
 *  ★ 这句要装进 160px 的输入框里（真机截图量过：再长就被裁掉半句），"怎么删"由旁边那颗「清除」按钮说，不写在这里。 */
export const SECRET_SAVED_HINT = '库里已存（留空不改动）';

/** 凭据那几行的落款：第十轮把出网红线从"只有 GET 且零凭据"改判成"翻译域允许标识符进查询串"，边界必须说在填之前。 */
export const TRANSLATE_CRED_NOTE = '这两格只发给上面选中那一家的翻译接口：不发给 GitHub，不进日志；密钥不回显在界面上，只存在本机存储文件里。';

/**
 * 落款：`免费接口 · 10-06 12:30`。★ 跟着**记录自己那一行**的引擎走 ——
 * 换了引擎，库里旧译文仍署它当初的来源，不冒充新引擎（也就不用为"换档要不要重译"再造一份状态）。
 * 缺 `engine` 的老行 = 第八轮只有宿主模型那一段时期存的，按 `host_llm` 落款。
 */
export function engineZhLabel(engine, at) {
  const prefix = ENGINE_LABEL_ZH[engine] || '模型现译';
  const d = new Date(Number(at));
  if (!Number.isFinite(Number(at)) || Number.isNaN(d.getTime())) return prefix;
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix} · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 标签时刻：`模型现译 · 10-06 09:20`。★ 与 B 的「内置离线预译 · 日期」是两个来源，字面不许混。
 *  ★ 第九轮起这是 `engineZhLabel('host_llm', at)` 的别名（同一份时刻格式，别在两边各写一遍）。 */
export function llmZhLabel(at) {
  return engineZhLabel('host_llm', at);
}


/**
 * 出厂偏好。★ intervalMin 必须是 CHECK_INTERVALS 里的成员，repoCacheHours 必须是 REPO_CACHE_HOURS 里的成员。
 * 1 小时：用户口径「点开面板想知道现在谁在上面」，热榜一天内会重排；单轮三发 ≈ 0.5~2.4s，一小时一轮不算失礼。
 * 24 小时是下限体面，1 小时是上限体面。
 * proxyMode=system：这台机器上 github.com 直连超时、注册表里却写着 127.0.0.1:7897 ——
 * 出厂就该按系统代理走，而不是等用户去设置页里发现这个开关。
 */
export const DEFAULT_PREFS = {
  intervalMin: 60,
  // ★ 第十二轮（用户裁定「进设置页，默认 24 小时」）：详情缓存 TTL 出厂 24 小时，档位封闭在 `REPO_CACHE_HOURS`。
  //   与 `intervalMin` 同形状：这里是出厂值，`clampPrefs` 认名单，越界一律退回这一格。
  repoCacheHours: REPO_CACHE_DEFAULT_HOURS,
  topN: 15,
  keepEvents: 300,
  language: '',
  proxyMode: 'system',
  proxyUrl: '',
  // ★ 模型现译两个开关（10-06 用户裁定）：**描述那一档默认开**（「点开详情就能看到中文」是这一路的来意），
  //   README 摘要另给一个开关且默认关（默认那一屏已经有英文节选，再叠一段转述就多了）。
  //   开关位就摆在那一屏，不想花模型额度的用户关掉即可 —— 关着时详情载荷与改判前逐字相同（见 §0 第八轮）。
  llmDesc: true,
  llmReadme: false,
  // ★ 第九轮默认落在「免费接口」：不花宿主模型额度、不要求注册（用户裁定 10-06）。
  //   官方那几路出厂没凭据 ⇒ 选了它也只是拿一句 `no_credential`，不会偷偷发一发（见 web-translate.js）。
  translateEngine: DEFAULT_TRANSLATE_ENGINE,
  // 各家凭据那几格：出厂全空。★ 键名与长度上限全部从 `PREF_CRED_FIELDS` 派生，不在此手抄。
  //   第二十一轮起这一份含 GitHub 令牌（`ghToken`）：出厂空串 ⇒ 默认仍然匿名调用，行为与旧版逐字节一致。
  ...Object.fromEntries(PREF_CRED_FIELDS.map((f) => [f.key, ''])),
};

/** 连续故障退避：第 N 次连坏把节拍翻倍，封顶 BACKOFF_MAX_ROUNDS 轮（spec §5）。 */
export const BACKOFF_MAX_ROUNDS = 4;

/**
 * 退避的绝对封顶（毫秒）。★ 只有翻倍值落进 [base, 本值] 才生效：节拍永远不低于用户选的档位，
 * 也永远不许因为连坏被推到一天后（真机读数：启动瞬间一次网络抖动 + 用户连点三次立即检查
 * ⇒ 2^3 翻倍把下次自动检查推到 24 小时后，面板整整一天是空的）。
 */
export const BACKOFF_MAX_MS = 4 * 3600 * 1000;

/**
 * 单榜出网尝试次数（1 = 不补发）与补发间隔。
 * ★ 只补**传输类**失败（连不上 / 连接超时）：解析失败与 HTTP 4xx/5xx 补发是同一份答案，
 *   只是把三发变成九发，白占对端配额。代理地址写错这类**配置**失败同样不补发 —— 三次都是同一句报错。
 */
export const FETCH_ATTEMPTS = 3;
export const FETCH_RETRY_DELAY_MS = 1000;

/* ------------------------------------------------------------------ *
 * 变化判定（spec §3，宿主单点）
 * ------------------------------------------------------------------ */

/**
 * 进/出榜之外，位次挪动达到这个数才记 board_move（以下视为噪声）。
 * ★ 月榜只有 23 行且极粘，挪 2 位已是信号；这组阈值待真机跑 3~5 天后回看一次再定稿。
 */
export const MOVE_THRESHOLD = { daily: 3, weekly: 3, monthly: 2 };

/** 跨榜同现：同时出现在 ≥2 张榜上算「持续升温」，3 张全中是强信号。 */
export const CROSS_MIN_BOARDS = 2;

/** 快照里带的流水条数（面板首屏够用；更多走 GET /api/events?limit=）。 */
export const EVENTS_IN_SNAPSHOT = 100;

export const EVENT_KINDS = [
  'board_enter', 'board_exit', 'board_move',
  'first_on_board', 'renamed',
  'rising_cross', 'cooling_cross',
  'source_error', 'source_recover', 'baseline',
];
export const EVENT_KIND_LABELS = {
  board_enter: '进榜',
  board_exit: '掉榜',
  board_move: '位次变化',
  first_on_board: '首次上榜',
  renamed: '仓库改名',
  rising_cross: '跨榜升温',
  cooling_cross: '热度收敛',
  source_error: '数据源故障',
  source_recover: '数据源恢复',
  baseline: '首次建档',
};

/* ------------------------------------------------------------------ *
 * 行形状
 * ------------------------------------------------------------------ */

/**
 * 榜单一行。字段全部来自页面原文（S0 逐字段核过的 4 份榜：日 15 + 周 19 + 月 23 + rust 17 = 74 行，0 缺字段）：
 *  - repo 是小写 `owner/name`，作为跨表主键；name 是页面显示的原始大小写形式。
 *  - repoId 来自条目内 `data-hydro-click` 的 record_id（实测每行都在）——改名时靠它认出同一个仓库。
 *  - desc 可能为空字符串（实测 `pingdotgg/t3code` 整条 article 无 <p>）。
 *  - lang/langColor 来自 `itemprop="programmingLanguage"` 与 `repo-language-color` 的 style；
 *    色值用页面给的，插件里不许另写一份语言色表（否则又违反一份真相）。
 *  - stars / forks / added 是解析过千分位的整数；added 的周期含义由所在榜决定。
 */
export const BOARD_ROW_SHAPE = {
  rank: requiredInt('名次'),
  repo: requiredString('仓库主键 owner/name(小写)'),
  name: requiredString('显示名 owner/name'),
  repoId: optionalInt('仓库数字 id'),
  desc: optionalString('描述（可为空）'),
  lang: optionalString('语言名（可为空）'),
  langColor: optionalString('语言色值（页面原样）'),
  stars: requiredNumber('累计 star'),
  forks: optionalNumber('累计 fork'),
  added: requiredNumber('本轮周期新增 star'),
  delta: optionalInt('较上轮位次变化（正=上升）'),
  renamedFrom: optionalString('改名前的显示名（同 repoId 认出）'),
  fresh: optionalBool('本机第一次见到这个仓库'),
};

/** 上一榜的精简存档：算 delta、认改名、判进出都只吃这四列。 */
export const PREV_ROW_SHAPE = {
  repo: requiredString('仓库主键'),
  name: optionalString('显示名'),
  repoId: optionalInt('仓库数字 id'),
  rank: requiredInt('名次'),
};

/** 观测史一行（seen 表）：回答「这仓库什么时候头一回上榜、现在还在哪几张榜上」。 */
const seenRecord = record({
  repo: requiredString('仓库主键'),
  name: requiredString('最近一次看到的显示名'),
  repoId: optionalInt('最近一次看到的仓库数字 id'),
  firstAt: requiredNumber('首次上榜时刻'),
  firstBoard: requiredEnum('首次上榜的榜', BOARDS),
  lastAt: requiredNumber('最近一次在榜时刻'),
  lastBoard: requiredEnum('最近一次在榜的榜', BOARDS),
  boards: arrayOfItem('累计出现过的榜', requiredString('榜 id')),
}, 'seen 记录');

/**
 * state 表按榜分行（key = board），不是 modelwatch 那种把三源摊成 8 个可选键：
 * 每加一张榜只是多一个 key，坏轮冻结的口径也只用一句话说得清（spec §4）。
 */
const stateRecord = record({
  board: requiredEnum('榜', BOARDS),
  at: requiredNumber('本轮成功解析时间(0=从未成功)'),
  ok: requiredBool('源闸门'),
  error: optionalString('故障原因'),
  etag: optionalString('页面弱验证器（实测支持 If-None-Match → 304）'),
  /** 304 只证明「整页字节未变」，不等于「新增星数未变」；这里记的是最后一次拿到 200 正文的时刻。 */
  bodyChangedAt: requiredNumber('最后一次拿到 200 正文的时刻'),
  lastFetchAt: requiredNumber('最后一次发起请求的时刻（含 304）'),
  failStreak: requiredInt('连续故障轮数（退避用）'),
  /** 本轮失败是不是传输类（连不上 / 连接超时）——界面据此决定要不要提「直连未通」那句。 */
  transport: optionalBool('本轮失败是否传输类（连不上/超时）'),
  rows: arrayOf('本轮榜', BOARD_ROW_SHAPE),
  prevRows: arrayOf('上轮榜', PREV_ROW_SHAPE),
  baseline: optionalBool('首轮建档标记'),
}, 'state 记录');

const eventRecord = record({
  id: requiredString('事件 id'),
  at: requiredNumber('发生时间'),
  kind: requiredEnum('事件种类', EVENT_KINDS),
  board: optionalEnum('所属榜', BOARDS),
  repo: optionalString('仓库主键'),
  name: optionalString('显示名'),
  detail: optionalString('补充说明'),
}, '事件记录');

const prefsRecord = record({
  intervalMin: requiredInt('检查间隔(分)'),
  // ★ 与 intervalMin **同一条 clamp 律、但不是同一种 schema 形状**：这里必须是 `optionalInt`。
  //   宿主 storageDomain 只在 `open()` 读存量时跑 schema，一条坏行拖死**整个域**（全线「存储不可用」）——
  //   而第十二轮之前的库存里压根没有这一格，`requiredInt` 会把用户已经攒下的榜史与偏好一起挡在门外
  //   （10-07 真机事故：desktop 三榜全红「故障 · 存储不可用」，读数见 spec §9.3）。
  //   缺这一格由 `clampPrefs` 补回出厂 24 小时，所以 optional 不丢语义。
  repoCacheHours: optionalInt('详情缓存时长(小时)'),
  topN: requiredInt('榜单条数'),
  keepEvents: requiredInt('流水保留条数'),
  // ★ 空串=全站，绝不能写成 requiredString：requiredString 把空串当"没填"直接拒，
  //   那会让**出厂默认值本身存不进去**（保存全站过滤 = 必失败）。缺省与空串在这里同义，
  //   所以落库时丢掉这个键、读时由 DEFAULT_PREFS 补回 '' 是无损的。
  language: optionalString('语言过滤 slug（缺省/空串=全站）'),
  // 代理同语言：缺省与"跟随系统"同义，读时由 DEFAULT_PREFS 补回，所以这里用 optionalEnum/optionalString。
  proxyMode: optionalEnum('代理模式', PROXY_MODES),
  proxyUrl: optionalString('自定义代理地址（仅 proxyMode=custom 时用）', { maxLength: PROXY_URL_MAX }),
  // ★ 这两格是**真二值**，不是三态：`optionalBool` 只丢 `undefined/null`，`false` 照样落库（走查后存储里就是 `"llmReadme":false`）。
  //   所以描述那一档出厂 `true` 也不会被读回成 `false` —— 别把这条写成"false 丢掉、由默认值补回"，那正好是反的。
  llmDesc: optionalBool('未命中的仓库描述是否现译成中文（出厂开，10-06 用户裁定）'),
  llmReadme: optionalBool('README 节选是否另给一段中文摘要（出厂关，与上面那个各开各的）'),
  // ★ 第九轮（用户裁定「两条都做，设置页选」）：这一行决定**用谁来译**，上面两行决定**译不译**。
  //   第十轮起它是五档；库里第九轮那一份 `official` 由 `clampPrefs` 在读的那一刻换成 `baidu`（schema 只认新档名）。
  translateEngine: optionalEnum('现译引擎', TRANSLATE_ENGINES),
  // ★ 各家凭据那几格：schema 从 `PREF_CRED_FIELDS` **派生**（第十轮起三家六格，第二十一轮起再加 GitHub 令牌，手抄必漏）。
  //   `secret:true` 的那几格只落本机存储文件与那一家的签名计算 / GitHub 那一发的请求头，快照 / 日志 / 事件里一律不回显（`hc-19` 钉这条）。
  //   ★ 全部走 `optionalString`：追加**必填**键会让上一版写下的那一行在 `open()` 读存量时当场抛 ⇒ 整域「存储不可用」（第十三轮的事故原样）。
  ...Object.fromEntries(PREF_CRED_FIELDS.map((f) => [
    f.key,
    optionalString(`${f.label}（${f.secret ? '密钥：不回显，留空表示不改动' : '只进' + f.label + '那一家的查询参数'}）`,
      { maxLength: f.maxLength }),
  ])),
}, '偏好记录');

/**
 * 现译的译文行（key = `kind:owner/name`，小写主键）。★ 三档引擎**共用这一张表**，谁译的记在行里。
 * ★ 命中判据与 B 同一条律：**主键 + 原文逐字相同**才复用 —— 仓库改了描述或 README，旧译文必须静默作废重译，
 *   绝不拿上一版译文指鹿为马。所以 `src` 存的是**喂进去的那一份原文**，不是键。
 * ★ 换引擎**不**作废旧行（第九轮我的口径，写在 spec §8.4）：旧译文照用，但落款跟着行里的 `engine` 走，
 *   不会把「免费接口译的」署成「官方接口译的」。省一次出网，也比"换档就整库重译"少烧一份额度。
 * ★ 平铺不嵌套、存字段不存整句（同 repoCacheRecord 那条律）：标签时刻由 domain 的 `engineZhLabel` 现算。
 */
const transRecord = record({
  repo: requiredString('owner/name（小写主键）'),
  kind: requiredEnum('现译哪一路（desc / readme）', LLM_KINDS),
  src: requiredString('喂给译者的原文（逐字，命中判据的一半）'),
  zh: requiredString('译者给的中文'),
  at: requiredNumber('这一行译出来的时刻'),
  chars: optionalNumber('译文长度（对账用）'),
  // ★ 第九轮加的一格，且是 **optional**：库里 10-06 那批行没有它，`requiredEnum` 会让整张表读不出来
  //   （抬 version 更是把用户的榜史与偏好整个打不开 —— 同上面那条 version 律）。缺档按 `host_llm` 落款。
  // ★ 名单吃 `TRANS_ROW_ENGINES`（现行五档 + 历史档名）：只认现行五档会把第九轮那批 `official` 行判脏 ⇒ 换档即全库重译。
  engine: optionalEnum('这一行是谁译的（缺档 = 第八轮只有宿主模型那一段时期存的）', TRANS_ROW_ENGINES),
}, '现译译文记录');

/**
 * 仓库详情缓存行（key = 小写 owner/name）。
 * ★ 平铺不嵌套：kv-schema 的 record 不支持嵌套 record，硬塞一个 meta 对象只会得到"校验没管到的第二份真相"。
 * ★ 存字段不存整句：中文叙述由 repo.js 现拼（改了文案不必等缓存过期）。
 * ★ 失败也留一行（ok=false + errKey）：限额用尽 / 404 时界面要说"上次试过、什么时候再试"，而不是当没发生过。
 */
const repoCacheRecord = record({
  repo: requiredString('owner/name（小写主键）'),
  name: optionalString('GitHub 给的显示名（原始大小写）'),
  at: requiredNumber('这行详情的取回时刻（限额/失败轮也推）'),
  ok: requiredBool('闸门：false = 这行只是失败留档'),
  errKey: optionalEnum('失败种类', Object.keys(REPO_ERROR_LABELS)),
  errText: optionalString('失败原因原文'),
  desc: optionalString('仓库自己写的描述（原文，不翻译）'),
  lang: optionalString('主语言'),
  stars: optionalNumber('累计星标'),
  forks: optionalNumber('复刻数'),
  issues: optionalNumber('未关闭 issue 数'),
  topics: arrayOfItem('主题标签', requiredString('标签名')),
  license: optionalString('许可证 SPDX'),
  pushedAt: optionalString('最近推送（ISO 字符串，原样）'),
  createdAt: optionalString('建档（ISO 字符串，原样）'),
  homepage: optionalString('主页'),
  htmlUrl: optionalString('仓库页 URL'),
  archived: optionalBool('已归档'),
  isFork: optionalBool('是复刻'),
  readmeSource: optionalEnum('README 来源档', REPO_README_SOURCES),
  readmePath: optionalString('实际取到的 README 文件名'),
  readmeExcerpt: optionalString('去标签后的首屏节选', { maxLength: README_EXCERPT_MAX }),
  readmeChars: optionalNumber('README 原文字节数（实测最大 109,682）'),
  readmeCut: optionalBool('节选是否被裁过'),
  // ★ 第十一轮加的两格，全是 **optional**：库里 10-06 那批行没有它们，`required*` 会让整张表读不出来
  //   （抬 version 更是把榜史与偏好整个打不开 —— 同下面那条 version 律）。缺格按「没探到中文小节 / 描述不是中文」落。
  readmeSection: optionalString('中文小节的小节标题（只在 readmeSource=zh_section 时有值）', { maxLength: 120 }),
  descSelfZh: optionalBool('仓库自己写的描述本身就是中文（⇒ 不派现译，见 DESC_SELF_ZH_MIN_CJK）'),
  zhCjk: optionalInt('判据读数：节选窗口里的中日韩字符个数'),
}, '仓库详情缓存记录');

/**
 * 域名字必须匹配 ^[a-z][a-z0-9_]*$（host-capabilities §三）；带连字符的插件名不能直接当域名。
 * 六表同域的理由：state / prefs / seen / repo / trans 都允许覆盖，events 只追加+裁老，
 * 「能否覆盖」这一分类上它们互不冲突（同域不违背 stock 的拆域判据）。
 *
 * ★ version 保持 1：加一张表**不是**抬版本的时机。整档布局（本机就是 ~/.dsh/storages/gh_trending.json）
 *   在 dsh-storage-json 的 parse() 里按 `stored !== descriptor.version` 直接抛 version-mismatch
 *   （lib/index.js:102，实测口径），`compatibleVersions` 只对 per-record 布局生效 ——
 *   抬到 2 会让用户已经攒下的榜史与偏好**整个打不开**，而库里少一张表本来就是空表起步（同文件 :111）。
 *   （10-06 加 `trans` 这一张时按这条律走过：version 原样 1。）
 */
export const GHT_DOMAIN = defineDomain({
  name: 'gh_trending',
  version: 1,
  tables: {
    state: domainTable(stateRecord),
    events: domainTable(eventRecord),
    prefs: domainTable(prefsRecord),
    seen: domainTable(seenRecord),
    repo: domainTable(repoCacheRecord),
    trans: domainTable(transRecord),
  },
});
