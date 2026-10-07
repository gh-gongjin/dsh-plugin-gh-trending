/**
 * lib/desc-zh.js —— 内置**离线**预译描述表（2026-10-05 裁定的 B）。
 *
 * 三条口径，改这个文件就是改这三条：
 *  1. **离线**：表在编译期落定，运行期零模型调用、零额外出网。★ 不许在这里加任何 fetch / ctx.llm 的口子 ——
 *     §0 第八轮改判后那句「默认零调用 + 句柄只许一个使用者」对这份文件同样生效，而且更严：它连句柄都不该见到。
 *  2. **带来源与时间戳**：译文必须能被认出来是预译（2026-10-06 整理），不是现译。界面上那句 `DESC_ZH_NOTE` 就说这件事。
 *  3. **原文变了就不译**：每条都存着整理当时的原文，命中的判据是「仓库主键 + 原文逐字相同」。
 *     仓库改了描述，表里那条就自动失效退回原文 —— 宁可少一句中文，不指鹿为马。
 *
 * 表由 `tmp/gen-desc-zh.mjs` 生成（原文取自 parseTrendingHtml 的真实解析结果，中文在
 * `tmp/desc-zh-authoring.json` 人工给出）；**别手改数据段**，要改就改生成器再复跑。
 * 覆盖 4 份页面（10-04 夹具的日/周/月/rust + 10-06 现取的日/周/月/rust）里出现过的仓库；
 * 仓库自带中文描述的（3 条：harry0703/moneyprinterturbo、t8y2/dbx、zerx-lab/fluxdown）不进表 —— 那不是翻译，原文本来就读得懂。
 */

/** 表整理的时间戳（界面上要说的那句就用它，别在别处再写一个日期）。 */
export const DESC_ZH_AT = '2026-10-06';

/** 来源说明。★ 「编译期整理、运行期不调模型」这句是给用户的定心丸，不是装饰。 */
export const DESC_ZH_ORIGIN = '插件内置离线词表';

/** 界面用的整句来源 + 时间戳标签。 */
export const DESC_ZH_NOTE = `中文为${DESC_ZH_ORIGIN}预译（${DESC_ZH_AT} 整理），不是现译；原文改过或表里没有这条，就只显示原文。`;

/** 短标签（界面上每处「这是预译」的说明都由它拼，日期只有 DESC_ZH_AT 一份）。 */
export const DESC_ZH_LABEL = `内置离线预译 · ${DESC_ZH_AT}`;

/** [主键 owner/name(小写), 整理当时的原文, 译文] —— 生成物，勿手改。 */
export const DESC_ZH_ROWS = [
  ['addyosmani/agent-skills', "Production-grade engineering skills for AI coding agents.", "给 AI 编程代理的生产级工程技能集。"],
  ['affaan-m/ecc', "The agent harness performance optimization system. Skills, instincts, memory, security, and research-first development for Claude Code, Codex, Opencode, Cursor and beyond.", "代理运行环境（harness）性能优化系统：为 Claude Code、Codex、Opencode、Cursor 等备好技能、直觉、记忆、安全与研究先行的开发流程。"],
  ['agent-substrate/substrate', "Agent Substrate: the core system", "Agent Substrate 的核心系统。"],
  ['ai-dynamo/dynamo', "A Datacenter Scale Distributed Inference Serving Framework", "数据中心规模的分布式推理服务框架。"],
  ['alibaba/open-code-review', "Secure, fast, efficient, battle-tested at Alibaba's scale. Hybrid architecture code review tool: deterministic pipelines + LLM Agent, precise line-level comments, built-in multi-language ruleset (NPE, thread-safety, XSS, SQL injection), OpenAI & Anthropic compatible.", "安全、快、省，在阿里的量级上久经考验。混合架构代码评审工具：确定性流水线 + LLM 代理，行级精确评论，内置多语言规则集（NPE、线程安全、XSS、SQL 注入），兼容 OpenAI 与 Anthropic。"],
  ['alirezarezvani/claude-skills', "380 Claude Code skills & agent skills & plugins (30+ Agents, 70+ custom commands, 380+ skills, customizable references, scripts)for Claude Code, Codex, Gemini CLI, Cursor, and 8 more coding agents — engineering, marketing, product, compliance, C-level advisory, research, business operations, commercial & finance, and your daily productivity skills.", "380 个 Claude Code 技能、代理技能与插件（30+ 代理、70+ 自定义命令、380+ 技能、可定制的引用与脚本），面向 Claude Code、Codex、Gemini CLI、Cursor 和另外 8 个编程代理，覆盖工程、营销、产品、合规、高管顾问、研究、业务运营、商务与财务，以及日常效率。"],
  ['alvr-org/alvr', "Stream VR games from your PC to your headset via Wi-Fi", "通过 Wi-Fi 把 PC 上的 VR 游戏串流到头显。"],
  ['anthropics/claude-code', "Claude Code is an agentic coding tool that lives in your terminal, understands your codebase, and helps you code faster by executing routine tasks, explaining complex code, and handling git workflows - all through natural language commands.", "Claude Code 是一款代理式编程工具，住在你的终端里，读懂你的代码库，靠自然语言命令执行日常任务、解释复杂代码、处理 git 流程，帮你写得更快手。"],
  ['anthropics/knowledge-work-plugins', "Open source repository of plugins primarily intended for knowledge workers to use in Claude Cowork", "开源插件仓库，主要给知识工作者在 Claude Cowork 里用。"],
  ['antirez/ds4', "DeepSeek 4 Flash and PRO local inference engine for Metal, CUDA and ROCm", "DeepSeek 4 Flash 与 PRO 的本地推理引擎，支持 Metal、CUDA 和 ROCm。"],
  ['ayghri/i-have-adhd', "A skill to stop your coding agent from burying the answer. ADHD-friendly output.", "一个技能，让你的编程代理别把答案埋在长篇里；输出对 ADHD 友好。"],
  ['bilawalsidhu/gods-eye-view', "A spy satellite simulator in your browser, except the data is real. Live open source spatial intelligence on a photorealistic 3D globe.", "浏览器里的间谍卫星模拟器，只不过数据是真的：在照片级写实的 3D 地球上看实时的开源空间情报。"],
  ['boykopovar/anyps5', "Tool for automatic PS5 executables porting to Linux and Windows", "自动把 PS5 可执行文件移植到 Linux 与 Windows 的工具。"],
  ['caddyserver/caddy', "Fast and extensible multi-platform HTTP/1-2-3 web server with automatic HTTPS", "快速、可扩展的多平台 HTTP/1-2-3 Web 服务器，自动配 HTTPS。"],
  ['calesthio/openmontage', "World's first open-source, agentic video production system. 12 production pipelines, 100+ tools, 700+ agent skill and production-knowledge files. Turn your AI coding assistant into a full video production studio.", "全球首个开源、代理式的视频生产系统：12 条生产流水线、100+ 工具、700+ 代理技能与制作知识文件，把你的 AI 编程助手变成一整个视频制作工作室。"],
  ['cloudflare/cloudflare-os', "Agent workspace built on Cloudflare Workers for creating documents, building apps, and running agents with your company’s context and systems.", "建在 Cloudflare Workers 上的代理工作区：带着你公司的上下文和系统来写文档、做应用、跑代理。"],
  ['cluvexstudio/aether', "A Rust userspace WARP core for censored networks, built around MASQUE over HTTP/3 and HTTP/2.", "面向受管制网络的 Rust 用户态 WARP 核心，围绕 MASQUE over HTTP/3 与 HTTP/2 构建。"],
  ['coreyhaines31/marketingskills', "Marketing skills for Claude Code and AI agents. CRO, copywriting, SEO, analytics, and growth engineering.", "给 Claude Code 和 AI 代理用的营销技能：转化率优化、文案、SEO、分析与增长工程。"],
  ['cs341-illinois/coursebook', "Open Source Introductory Systems Programming Textbook for the University of Illinois", "伊利诺伊大学的开源系统编程入门教材。"],
  ['cursor/plugins', "Cursor plugin specification and official plugins", "Cursor 插件规范与官方插件。"],
  ['debpalash/voicestudio', "VoiceStudio is the open-source, fully-local ElevenLabs alternative — voice cloning, voice design, video dubbing, dictation, transcription & audiobook creation in 646 languages.", "完全本地的开源 ElevenLabs 替代品：声音克隆、音色设计、视频配音、口述、转写与有声书制作，支持 646 种语言。"],
  ['dietrichgebert/ponytail', "Makes your AI agent think like the laziest senior dev in the room. The best code is the code you never wrote.", "让你的 AI 代理像屋里最懒的资深工程师那样思考：最好的代码是你根本没写的那一行。"],
  ['duartesantos8/opengym', "Self-hosted gym & body-weight tracker — plan routines, log workouts (supersets, warm-ups, cardio), see which muscles are trained, fatigued or detrained, import from FitNotes/Strong/Hevy, passkey login. Your data, your server.", "自托管的健身房与自重训练记录器：排动作、记训练（超级组、热身、有氧）、看哪些肌群在练、在疲劳或退化，可从 FitNotes / Strong / Hevy 导入，用 passkey 登录。数据在你的服务器上。"],
  ['earthtojake/text-to-cad', "Give your agent CAD superpowers.", "给你的代理装上 CAD 超能力。"],
  ['effect-ts/effect', "Build production-ready applications in TypeScript", "用 TypeScript 构建能上生产的应用。"],
  ['falkordb/falkordb', "A super fast Graph Database uses GraphBLAS under the hood for its sparse adjacency matrix graph representation. Our goal is to provide the best Knowledge Graph for LLM (GraphRAG).", "极快的图数据库，底层用 GraphBLAS 以稀疏邻接矩阵存图；目标是给 LLM 提供最好的知识图谱（GraphRAG）。"],
  ['garrytan/gstack', "Use Garry Tan's exact Claude Code setup: 23 opinionated tools that serve as CEO, Designer, Eng Manager, Release Manager, Doc Engineer, and QA", "照搬 Garry Tan 那套 Claude Code 配置：23 个有主张的工具，分别当 CEO、设计师、工程经理、发布经理、文档工程师和 QA。"],
  ['gaurav-gosain/tuios', "A terminal window manager that knows what your agents are doing. Tiling panes, workspaces, sessions that survive restarts, and one Inbox for every coding agent.", "知道你那些代理在干什么的终端窗口管理器：平铺窗格、工作区、重启不丢的会话，外加一个收拢所有编程代理的收件箱。"],
  ['getsentry/sentry', "Developer-first error tracking and performance monitoring", "开发者优先的错误追踪与性能监控。"],
  ['helix-editor/helix', "A post-modern modal text editor.", "后现代模态文本编辑器。"],
  ['heygen-com/hyperframes', "Write HTML. Render video. Built for agents.", "写 HTML，渲染成视频，为代理而生。"],
  ['hunxbyts/ghosttrack', "Useful tool to track location or mobile number", "用来定位行踪或追踪手机号码的工具。"],
  ['hydra-db/hydradb', "HydraDB - fast graph database on object storage", "HydraDB：建在对象存储上的快速图数据库。"],
  ['jaywebtech/autoshorts', "AutoShorts is a local-first desktop application for turning long-form video or audio recordings into high-impact, vertical short-form clip candidates (9:16 portrait) with AI-powered viral moment ranking.", "本地优先的桌面应用，把长视频或长录音切成有冲击力的竖屏（9:16）短片候选，并用 AI 给爆款瞬间排序。"],
  ['juspay/hyperswitch', "Open source, composable payments platform | PCI compliant | SaaS and Self-host options | Enables connectivity to multiple payment, payout, fraud, vault and tokenization providers | Uplifts authorization with intelligent routing and revenue recovery | Reduce payment processing costs with cost observability | Reduces payment ops with reconciliation", "开源、可组合的支付平台 | PCI 合规 | SaaS 与自托管可选 | 能对接多家支付、出款、风控、保险库与令牌化服务商 | 用智能路由和收入挽回抬高授权成功率 | 用成本可观测压低支付处理成本 | 用对账减少支付运维。"],
  ['longbridge/gpui-kit', "Rust GUI components for building fantastic cross-platform desktop application by using GPUI.", "用 GPUI 打造出色跨平台桌面应用的 Rust GUI 组件。"],
  ['magnitudedev/magnitude', "Open source inference engine for agents that optimizes itself for your exact hardware. Compiles and tunes its kernels on your device, so open models run up to 2x faster than llama.cpp. Works on Apple Silicon, NVIDIA, AMD, or just a CPU.", "为代理而生的开源推理引擎，会针对你的具体硬件自我优化：在你设备上编译并调优 kernel，开源模型比 llama.cpp 快至多 2 倍。Apple Silicon、NVIDIA、AMD 或纯 CPU 都能跑。"],
  ['max-sixty/worktrunk', "Worktrunk is a CLI for Git worktree management, designed for parallel AI agent workflows", "Worktrunk 是管理 Git worktree 的 CLI，为并行的 AI 代理工作流而设计。"],
  ['michael-denyer/pstack-claude', "Claude Code, Codex, Pi, OpenCode, Gemini, and Prime Agent versions of Poteto's pstack. Rigorous agent workflows with Cursor primitives translated for other harnesses.", "Poteto 的 pstack 的 Claude Code / Codex / Pi / OpenCode / Gemini / Prime 代理版：把 Cursor 那套严格的代理流程翻给别的运行环境用。"],
  ['mksglu/context-mode', "Context window optimization for AI coding agents. Sandboxes tool output (98% reduction), persists session memory, and enforces routing across 17 platforms via MCP + hooks.", "AI 编程代理的上下文窗口优化：把工具输出关进沙箱（省 98%）、持久化会话记忆，并靠 MCP + hooks 在 17 个平台上强制路由。"],
  ['msitarzewski/agency-agents', "A complete AI agency at your fingertips - From frontend wizards to Reddit community ninjas, from whimsy injectors to reality checkers. Each agent is a specialized expert with personality, processes, and proven deliverables.", "一整个 AI 代理机构随你调：从前端魔法师到 Reddit 社区常客，从注入趣味到泼冷水。每个代理都是有性格、有流程、有交付成果的专才。"],
  ['mvschwarz/openrig', "Build your own network of agents from Claude Code, Codex and Pi: persistent teams with roles, shared context and owned work.", "用 Claude Code、Codex 和 Pi 搭出自己的代理网络：常驻团队，有角色分工、共享上下文、各自认领工作。"],
  ['nationalsecurityagency/ghidra', "Ghidra is a software reverse engineering (SRE) framework", "Ghidra 是一套软件逆向工程（SRE）框架。"],
  ['nvidia/openshell', "OpenShell is the safe, private runtime for autonomous AI agents.", "OpenShell 是自主 AI 代理的安全私有运行时。"],
  ['opencut-app/opencut', "The open-source CapCut alternative", "开源的 CapCut 替代品。"],
  ['pablostanley/yoinks', "yoink any video from your terminal. no shady ads.", "在终端里抓取任意视频，没有那些乱七八糟的广告。"],
  ['panniantong/agent-reach', "Give your AI agent eyes to see the entire internet. Read & search Twitter, Reddit, YouTube, GitHub, Bilibili, XiaoHongShu — one CLI, zero API fees.", "给你的 AI 代理一双眼，看清整个互联网：读取和搜索 Twitter、Reddit、YouTube、GitHub、B 站、小红书——一个 CLI，零 API 费用。"],
  ['paperclipai/paperclip', "The open-source app everyone uses to manage agents at work", "大家上班时管理代理都用的那个开源应用。"],
  ['pbakaus/impeccable', "The design language that makes your AI harness better at design.", "让你的 AI 运行环境更懂设计的设计语言。"],
  ['pumpkin-mc/pumpkin', "Empowering everyone to host fast and efficient Minecraft servers", "让人人都能开又快又省资源的 Minecraft 服务器。"],
  ['pydantic/monty', "A minimal, secure Python interpreter written in Rust for use by AI", "用 Rust 写的极简、安全的 Python 解释器，供 AI 使用。"],
  ['rohitg00/ai-engineering-from-scratch', "Learn it. Build it. Ship it for others.", "学会它，造出来，交付给别人用。"],
  ['rust-lang/rust', "Empowering everyone to build reliable and efficient software.", "让人人都能构建可靠而高效的软件。"],
  ['ruvnet/ruview', "π RuView turns commodity WiFi signals into real-time spatial intelligence, vital sign monitoring, and presence detection — all without a single pixel of video.", "把普通 WiFi 信号变成实时空间情报、生命体征监测和在场检测——全程不用一个像素的视频。"],
  ['storytold/artcraft', "ArtCraft is an intentional crafting engine for artists, designers, and filmmakers", "ArtCraft 是给艺术家、设计师和电影人用的用心创作引擎。"],
  ['stremio/stremio-web', "Stremio - Freedom to Stream", "Stremio——流媒体自由。"],
  ['superdesigndev/treg', "OpenRouter for agent tools. Join community here: https://discord.gg/6mQYYfFMAn", "代理工具界的 OpenRouter（社区邀请链接见原文）。"],
  ['tashfeenahmed/freellmapi', "7.4 billion tokens per month. 34 free LLM providers. 635 free model endpoints. All behind one /v1 endpoint, plus any custom OpenAI-compatible endpoint. Smart routing, automatic failover, encrypted keys. Personal experimentation only.", "每月 74 亿 token、34 家免费 LLM 服务商、635 个免费模型端点，全收在一个 /v1 端点后面，也支持任意自定义的 OpenAI 兼容端点。智能路由、自动故障转移、密钥加密，仅限个人实验。"],
  ['tencent/weknora', "Open-source LLM knowledge platform: turn raw documents into a queryable RAG, an autonomous reasoning agent, and a self-maintaining Wiki.", "开源 LLM 知识平台：把原始文档变成可查询的 RAG、自主推理的代理，和自我维护的 Wiki。"],
  ['tencentcloud/octop', "A smarter, self-hosted AI assistant — multi-user, multi-agent.", "更聪明的自托管 AI 助手——多用户、多代理。"],
  ['tester-army/e2e', "Next generation e2e testing framework for web and mobile apps.", "面向 Web 与移动应用的下一代端到端测试框架。"],
  ['thedotmack/claude-mem', "Persistent Context Across Sessions for Every Agent – Captures everything your agent does during sessions, compresses it with AI, and injects relevant context back into future sessions. Works with Claude Code, OpenClaw, Codex, Gemini, Hermes, Copilot, OpenCode + More", "让所有代理跨会话保住上下文：记下代理在会话里做的一切，用 AI 压缩，再把相关上下文注回后续会话。支持 Claude Code、OpenClaw、Codex、Gemini、Hermes、Copilot、OpenCode 等。"],
  ['tile-ai/tilelang', "Domain-specific language designed to streamline the development of high-performance GPU/CPU/Accelerators kernels", "为开发高性能 GPU / CPU / 加速器 kernel 而设计的领域专用语言。"],
  ['timhartmann7/omnyssh', "Fast, open-source SSH client and server manager for macOS, Windows and Linux. Desktop GUI and terminal TUI with a live metrics dashboard, tabbed terminal, SFTP file manager, port forwarding, one-click SSH keys and snippets. Built in Rust.", "macOS、Windows、Linux 上快速、开源的 SSH 客户端与服务器管理器。桌面 GUI 与终端 TUI，带实时指标面板、多标签终端、SFTP 文件管理、端口转发、一键 SSH 密钥与代码片段，用 Rust 写成。"],
  ['tokio-rs/topcoat', "A batteries-included framework for building web apps", "电池全含的 Web 应用开发框架。"],
  ['touchhle/touchhle', "High-level emulator for early iOS apps. This repo is used for issues, releases and CI. Submit patches at: https://review.gerrithub.io/admin/repos/touchHLE/touchHLE", "早期 iOS 应用的高级模拟器。这个仓库只放 issue、发布和 CI，补丁请提交到原文给的地址。"],
  ['trycua/cua', "Scale computer-use 2.0 with open-source drivers, cross-OS fleets, and benchmarks for training, evaluation, and data generation.", "用开源驱动、跨操作系统的代理机群和基准测试，把 computer-use 2.0 规模化，服务训练、评估与数据生成。"],
  ['tt-a1i/archify', "Turn any idea, plan, or codebase into a beautiful interactive diagram. An agent skill for Claude Code, Codex, and more.", "把任意想法、计划或代码库变成漂亮的交互式图表；面向 Claude Code、Codex 等的代理技能。"],
  ['tursodatabase/turso', "A SQL database in Rust: SQLite-compatible, now also speaking Postgres (experimental). The LLVM of databases.", "用 Rust 写的 SQL 数据库：兼容 SQLite，现在也说 Postgres（实验性），自比数据库界的 LLVM。"],
  ['vectorize-io/hindsight', "Hindsight: Agent Memory That Learns", "Hindsight：会学习的代理记忆。"],
  ['vercel/next.js', "The React Framework", "React 框架。"],
  ['xingkongliang/skills-manager', "A lightweight desktop app to manage, sync, and organize AI agent skills across 50+ coding tools — Claude Code, Codex, Cursor, Copilot, Gemini CLI, and more.", "轻量桌面应用，在 50+ 编程工具之间管理、同步和整理 AI 代理技能——Claude Code、Codex、Cursor、Copilot、Gemini CLI 等。"],
  ['zeronsh/zeron', "A native control plane for Claude Code, Codex, Cursor, Devin and other coding agents.", "Claude Code、Codex、Cursor、Devin 等编程代理的原生控制平面。"],
];

const BY_REPO = new Map(DESC_ZH_ROWS.map(([repo, src, zh]) => [repo, { src, zh }]));

/** 比对用的归一：只掐首尾空白、把连续空白压成一个空格。不做大小写、不做标点折叠 —— 那是猜。 */
export function descZhNorm(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * 查一条译文。**只在「主键命中 + 原文逐字相同」时返回译文**，其余一律空串。
 * 空串而不是 undefined：调用方 `if (zh)` 就够，界面上「没译」和「译成空」不会是两种样子。
 */
export function descZhFor(repo, desc) {
  const hit = BY_REPO.get(String(repo ?? '').toLowerCase());
  if (!hit) return '';
  return hit.src === descZhNorm(desc) ? hit.zh : '';
}

/** 一榜行 → 命中的 { 主键: 译文 }。榜面行里 desc 已经过 textOf 清洗，与表里的原文同一口径。 */
export function descZhHits(rows = []) {
  const hits = {};
  for (const r of rows) {
    const zh = descZhFor(r?.repo, r?.desc);
    if (zh) hits[r.repo] = zh;
  }
  return hits;
}

/** 词表条目数（用例与文档要对账用，别让「表有多少条」变成口头数字）。 */
export const DESC_ZH_COUNT = BY_REPO.size;
