// ============================================================
// dsh-plugin-gh-trending — Browser Client Half（浏览器半边）
// ============================================================
// 1) sidebar.panellist 注册图标按钮  2) main keyed slot 注册整页 UI。
// 数据通路：SSE 主（首帧 snapshot，检查完 update 帧 = 全量快照）、手动检查兜底。
// **不用 EventSource**（继承 sysops 口径：断线要能重连补帧）。
//
// 一份真相：本文件不定义任何枚举/判定口径 —— boardLabels / eventKindLabels /
// intervals / topNRange / sourceNote / langCheck 全部来自宿主 index-inject 载荷；
// 载荷没到就如实显示「配置未就位」，绝不自己补一份文案。
// 不自动弹提示层：错误与状态一律就地落卡（.gt-notice）。
// 唯一的浮层是**用户自己点出来的**仓库详情对话框（点仓库名 → 中文解释），它不自动出现、不抢焦点以外的东西。
//
// 页签：总览 / 日榜 / 周榜 / 月榜 / 变化记录 / 设置（与 modelwatch 同形：一屏一件事，
// 段与段不再靠一路滚；三档榜从「卡内分段器」升成「三个页签」，卡内不再套一层切换）。
//    CSS 模板串里注释与选择器都不许出现反引号。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-gh-trending',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    const GLOBAL_KEY = '__GH_TRENDING__';
    const cfg = () => globalThis[GLOBAL_KEY] || {};
    const PANEL_ID = cfg().panelId || 'gh-trending';
    const PANEL_ORDER = () => Number(cfg().panelOrder) || 16;
    const API_BASE = () => cfg().api || '/gh-trending/api';
    const BOARDS = () => (Array.isArray(cfg().boards) && cfg().boards.length ? cfg().boards : ['daily', 'weekly', 'monthly']);
    const boardLabel = (b) => (cfg().boardLabels || {})[b] || b;

    // ------------------------------------------------------------
    // 1) 样式：宿主 token 优先，原型值兜底
    // ------------------------------------------------------------
    // ⛔ 不许用 container-type + @container（modelwatch 真机炸过：宿主主区是 flex，
    //   根容器宽度按内容算 ⇒ containment 之后算出 0 宽，整页塌成竖线）。只用 @media。
    // ⛔ 根规则必须自带 box-sizing:border-box：宿主 web 端 CSS 里没有任何通配 box-sizing，
    //   根是 content-box 时 width:100% + 左右 padding ⇒ 外框比面板宽 ⇒ 右半边被顶出可视区。
    const STYLE_ID = 'dsh-plugin-gh-trending:style';
    const CSS = `
.gt-root{--gt-fg:var(--dsw-alias-label-primary,#1a1a1a);--gt-muted:var(--dsw-alias-label-secondary,#6b6b70);
  --gt-faint:var(--dsw-alias-label-tertiary,#a0a0a6);
  --gt-card:var(--dsw-alias-bg-base,#ffffff);--gt-soft:var(--dsw-alias-bg-layer-2,#fafafb);
  --gt-hover:var(--dsw-alias-bg-layer-3,#f0f0f1);
  --gt-line:var(--dsw-alias-border-l1,#ebebed);--gt-line2:var(--dsw-alias-border-l2,#e0e0e3);
  --gt-ok:#1f883d;--gt-err:#c0392b;--gt-warn:#9a6700;--gt-info:var(--dsw-alias-state-business-primary,#3d6fe0);
  box-sizing:border-box;color:var(--gt-fg);background:transparent;padding:0 20px 28px;
  width:100%;max-width:1320px;margin:0 auto;max-height:100vh;overflow-y:auto;
  display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5}
.gt-root *{box-sizing:border-box}
.gt-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
.gt-r{text-align:right}
.gt-sub{color:var(--gt-muted);font-size:12px}
.gt-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}
.gt-head-l{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}
.gt-head-r{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.gt-title{font-size:17px;font-weight:600;letter-spacing:.2px;white-space:nowrap}
.gt-card{background:var(--gt-card);border:1px solid var(--gt-line);border-radius:12px;overflow:hidden;min-width:0}
.gt-card-h{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--gt-soft);border-bottom:1px solid var(--gt-line);flex-wrap:wrap}
.gt-card-t{font-weight:600;font-size:13px;white-space:nowrap}
.gt-card-n{margin-left:auto;color:var(--gt-muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.gt-card-b{padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.gt-note{margin:0;padding:8px 14px 10px;border-top:1px solid var(--gt-line);color:var(--gt-faint);font-size:11px}
.gt-panel{display:flex;flex-direction:column;gap:12px;min-width:0}
.gt-notice{padding:7px 10px;border-radius:8px;border:1px solid var(--gt-line);border-left:3px solid var(--gt-warn);
  background:var(--gt-soft);color:var(--gt-muted);font-size:12px;line-height:1.5}
.gt-notice-err{border-left-color:var(--gt-err)}
/* 一榜一页签之后，卡内滚动区拿的是整页高度，不再是单页六段时那个 520px 小窗：
   固定值让日榜第 15 行藏在嵌套滚动条后面、下方却空着一大片（真机截图抓到）。 */
.gt-scroll{max-height:calc(100vh - 220px);overflow-y:auto;overflow-x:hidden;min-width:0}
.gt-tbl{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:12px}
.gt-tbl th{position:sticky;top:0;z-index:1;background:var(--gt-card);text-align:left;font-weight:500;
  color:var(--gt-muted);font-size:11px;padding:7px 8px;border-bottom:1px solid var(--gt-line);white-space:nowrap}
.gt-tbl th:first-child,.gt-tbl td:first-child{padding-left:14px}
.gt-tbl th:last-child,.gt-tbl td:last-child{padding-right:14px}
/* th 上的 text-align:left 特异性比 .gt-r 高，右对齐列的表头必须再点一次名才压得住 */
.gt-tbl th.gt-r{text-align:right}
/* 列宽：# 与三个数值列拿死数，「描述」列 width:auto 吃全部余量，末尾兜底列收起。
   ★ 教训（modelwatch 真机截图）：让末尾空列吃余量 ⇒ 数值列浮在中间不贴右，整行像错位。
     空白要有去处，这里把余量交给唯一能被读成"内容"的描述列。
   ★ 教训（真机 2026-10-05 用户截图）：col 的类名不许和格子里的元素同名。
     col.gt-repo 与 a.gt-repo、col.gt-desc 与 span.gt-desc 撞名，而单元格那两条带 display:block ⇒
     col 的 display 被改成 block 就退出列布局，整张表的列宽从它俩起向左错两格：
     仓库吃到 104（那是给语言的）、描述吃到 78、本轮新增吃到兜底列的 0（整列隐形），余量全灌进「较上轮」。
     所以列宽类一律带 gt-col- 前缀；client.test.mjs 有一条静态断言钉住它（col 的类名不许出现在任何带 display 的规则里）。
     注意这段在模板字符串里：反引号会把 CSS 截断，注释里别写。 */
.gt-tbl col.gt-col-repo{width:268px}
.gt-tbl col.gt-col-desc{width:auto}
.gt-tbl col.gt-tail,.gt-tbl th.gt-tail,.gt-tbl td.gt-tail{width:0;padding:0}
@media (max-width:1000px){.gt-tbl col.gt-col-repo{width:auto}.gt-tbl col.gt-col-desc{width:160px}}
.gt-tbl td{padding:6px 8px;border-bottom:1px solid var(--gt-line);vertical-align:middle;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gt-tbl tbody tr:last-child td{border-bottom:none}
.gt-tbl tbody tr:hover td{background:var(--gt-hover)}
.gt-tbl tbody tr.gt-new td{background:#f7fbff}
.gt-rank{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:8px;
  font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;flex:0 0 auto}
/* 前三名金/银/铜，其余中性 —— 三档色值与兄弟插件 modelwatch 的 .mw-rank-1/2/3 逐字相同（观感口径对表）。 */
.gt-rank-1{background:#e8b530;color:#3d2c00}
.gt-rank-2{background:#c3c9d2;color:#2f353c}
.gt-rank-3{background:#cf9a63;color:#3a2410}
.gt-rank-n{background:var(--gt-soft);color:var(--gt-faint);border:1px solid var(--gt-line)}
.gt-repo{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.gt-desc{color:var(--gt-muted);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gt-lang{display:inline-flex;align-items:center;gap:5px;max-width:100%;overflow:hidden}
.gt-lang i{width:8px;height:8px;border-radius:50%;flex:0 0 8px;background:var(--gt-faint)}
.gt-lang span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gt-up{color:var(--gt-ok)}
.gt-down{color:var(--gt-err)}
.gt-flat{color:var(--gt-faint)}
.gt-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;border:1px solid var(--gt-line2);
  background:var(--gt-soft);color:var(--gt-muted);font-size:10px;white-space:nowrap}
.gt-empty{margin:0;padding:10px 14px;color:var(--gt-muted);font-size:12px}
.gt-tl{list-style:none;margin:0;padding:2px 14px;display:flex;flex-direction:column}
.gt-tl li{display:flex;align-items:flex-start;gap:9px;padding:7px 0;border-bottom:1px solid var(--gt-line);min-width:0}
.gt-tl li:last-child{border-bottom:none}
.gt-tl li:before{content:'';flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:var(--gt-faint);align-self:center;margin-right:-2px}
.gt-tl li[data-kind="board_enter"]:before,.gt-tl li[data-kind="first_on_board"]:before,.gt-tl li[data-kind="rising_cross"]:before{background:var(--gt-info)}
.gt-tl li[data-kind="board_exit"]:before,.gt-tl li[data-kind="source_error"]:before,.gt-tl li[data-kind="cooling_cross"]:before{background:var(--gt-err)}
.gt-tl li[data-kind="source_recover"]:before{background:var(--gt-ok)}
.gt-tl li[data-kind="board_move"]:before,.gt-tl li[data-kind="renamed"]:before{background:var(--gt-warn)}
.gt-chip{flex:0 0 auto;min-width:74px;text-align:center;padding:1px 8px;border-radius:999px;
  border:1px solid var(--gt-line2);background:var(--gt-soft);color:var(--gt-muted);font-size:11px}
.gt-tl-body{min-width:0;flex:1 1 auto;overflow-wrap:anywhere;line-height:1.45}
.gt-tl-body .gt-sub{margin-left:6px}
.gt-ago{flex:0 0 auto;color:var(--gt-faint);font-size:11px;white-space:nowrap;align-self:flex-start;padding-top:1px}
.gt-srcrow{display:flex;align-items:baseline;gap:9px;min-width:0;flex-wrap:wrap}
.gt-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:var(--gt-faint);align-self:center}
.gt-dot-ok{background:var(--gt-ok)}
.gt-dot-err{background:var(--gt-err)}
.gt-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
  border:1px solid var(--gt-line);background:var(--gt-soft);font-size:12px;color:var(--gt-muted);white-space:nowrap}
/* ---------- 页签 ---------- */
/* 页头 + 页签条钉在滚动顶部：一榜一页签之后内容有整页高，滚到底就切不了签了。
   两者必须包在同一块 sticky 里——各自 sticky 到 top:0 会叠在一起，页签盖住页头。
   顶部那 16px 从根挪到这里：根还留着 padding-top 时，sticky 只贴到内容盒上沿，
   那 16px 的缝里会露出滚上来的卡片（真机量到 gap:16、缝里站着 .gt-mini）。
   flex:none 同 .gt-tabs 的教训（根是 column flex，超高就收缩）。 */
.gt-topbar{position:sticky;top:0;z-index:2;background:var(--gt-card);flex:none;padding-top:16px;
  display:flex;flex-direction:column;gap:12px;min-width:0}
/* ★ flex:none 不是可有可无：根是 column flex 且 max-height:100vh，内容一超高就产生收缩压力。
   ★★ 这里原先还挂着 overflow-x:auto「防六签挤不下」，第九轮真机截图把它撤了，两条理由：
     ① 它让 nav 成了两轴滚动容器（overflow-y:visible 配 overflow-x:auto 按规范算 auto），
        而 .gt-tab.on:after{bottom:-1px} 把可滚溢出撑到 34 > clientHeight 33 ⇒ 页签条右端凭空多出一条竖向滚动条
        （用户圈的正是它；tmp/probe-sbar.mjs 在真宿主上量到 overflowsY:1、六签 scrollWidth==clientWidth 根本没横向溢出）；
     ② 同一句还制造过另一个坑：滚动盒的自动最小尺寸按规范算 0（min-height:auto 只对非滚动盒生效），
        整条页签曾被压成 1px 的 border-bottom、按钮溢出被裁掉、hit-test 落到根上。那条靠 flex:none 收住，
        现在 overflow 撤了，两条一起干净。 */
.gt-tabs{display:flex;gap:2px;border-bottom:1px solid var(--gt-line);margin-top:2px;flex:none}
.gt-tab{position:relative;display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;
  font-family:inherit;font-size:13px;color:var(--gt-muted);padding:8px 12px;cursor:pointer;
  border-radius:8px 8px 0 0;white-space:nowrap}
.gt-tab:hover{color:var(--gt-fg);background:var(--gt-soft)}
.gt-tab.on{color:var(--gt-fg);font-weight:600}
.gt-tab.on:after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:2px;
  background:var(--gt-fg);border-radius:2px}
.gt-tab-n{font-size:11px;color:var(--gt-faint);font-variant-numeric:tabular-nums}
.gt-tab.on .gt-tab-n{color:var(--gt-muted)}
.gt-link{border:none;background:transparent;color:var(--gt-info);font-family:inherit;font-size:12px;
  cursor:pointer;padding:0;margin-left:auto;white-space:nowrap}
.gt-link:hover{text-decoration:underline}
/* 卡头里「计数 + 链接」要贴在一起收在右侧：两个 margin-left:auto 会把空白对半分，计数飘到中间 */
.gt-card-h .gt-card-n+.gt-link{margin-left:2px}
/* 设置行里的链接要贴着标签排：.gt-link 那条 margin-left:auto 是给卡头「完整榜单 →」推到行尾用的，注册那两枚不该被推走 */
.gt-setrow .gt-link{margin-left:0}
.gt-setrow{display:flex;flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap}
.gt-setlabel{flex:0 0 auto;min-width:62px;color:var(--gt-muted);font-size:12px}
.gt-seg{display:inline-flex;padding:2px;gap:2px;background:var(--gt-soft);border:1px solid var(--gt-line);border-radius:8px}
.gt-seg button{border:none;background:transparent;color:var(--gt-muted);font-family:inherit;font-size:12px;
  padding:3px 10px;border-radius:6px;cursor:pointer}
.gt-seg button.on{background:var(--gt-fg);color:var(--gt-card);font-weight:500}
.gt-btn{font-family:inherit;font-size:12px;border-radius:8px;cursor:pointer;border:1px solid var(--gt-line2);
  background:var(--gt-card);color:var(--gt-fg);padding:4px 12px}
.gt-btn:hover:not(:disabled){background:var(--gt-hover)}
.gt-btn:disabled{opacity:.5;cursor:default}
.gt-btn-main{background:var(--gt-fg);border-color:var(--gt-fg);color:var(--gt-card);font-weight:500;padding:5px 14px}
.gt-btn.gt-btn-main:hover:not(:disabled){background:var(--gt-fg);opacity:.86}
.gt-step{width:28px;padding:4px 0;text-align:center;font-size:14px;line-height:1}
.gt-count{min-width:34px;text-align:center;font-weight:600}
.gt-input{font-family:inherit;font-size:12px;padding:4px 8px;border-radius:8px;border:1px solid var(--gt-line2);
  background:var(--gt-card);color:var(--gt-fg);min-width:0;width:160px}
.gt-saved{color:var(--gt-ok);font-size:12px}
/* 页头回执：跑完一轮是「告知」不是「状态」，所以走中性档——
   绿留给设置卡的「已保存」这类成功回执，红只给真的坏了的事。 */
.gt-receipt{color:var(--gt-muted);font-size:12px}
.gt-receipt-err{color:var(--gt-err)}
.gt-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:start}
@media (max-width:900px){.gt-cols{grid-template-columns:minmax(0,1fr)}}
/* 总览的三榜小结：auto-fit 自己收列，窄视口退两列 / 一列，不需要再加断点 */
.gt-boards3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;align-items:start}
.gt-mini{display:flex;align-items:baseline;gap:8px;min-width:0;padding:5px 0;border-bottom:1px solid var(--gt-line)}
.gt-mini:last-child{border-bottom:none}
.gt-mini-t{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gt-mini-s{color:var(--gt-faint);font-size:11px;flex:0 0 auto}
.gt-mini-n{margin-left:auto;flex:0 0 auto;color:var(--gt-faint);font-size:11px;font-variant-numeric:tabular-nums}
/* 外链一律收进本面板的字色：不写这一条就吃浏览器默认的蓝 + 下划线（真机截图抓到，断言全绿看不见）。
   主次靠 hover 才显下划线，颜色不动 —— 状态色留给状态，链接不该抢宿主令牌。 */
.gt-root a{color:inherit;text-decoration:none}
.gt-root a:hover{text-decoration:underline}
/* ---------- 仓库详情对话框（点仓库名才出现；自动弹出的提示层仍然禁止） ---------- */
/* 遮罩底色先给死值再给 color-mix：不认 color-mix 的浏览器把第二行当非法值丢掉，
   只留第一行 —— 反过来写就只剩硬编码色，宿主换肤时遮罩会跟不上字色。
   ★ 透明度是这里唯一能被读成「黑块」的地方，取值必须真机截图核，不能只看断言。 */
.gt-modal-mask{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(15,17,21,.34);background:color-mix(in srgb,var(--gt-fg) 26%,transparent)}
/* 对话框自己滚：根容器也在滚，两层都滚会互相抢；max-height 收在视口内才谈得上 overflow。 */
.gt-modal{box-sizing:border-box;width:100%;max-width:680px;max-height:86vh;overflow-y:auto;min-width:0;
  display:flex;flex-direction:column;background:var(--gt-card);border:1px solid var(--gt-line2);
  border-radius:12px;box-shadow:0 12px 32px rgba(15,17,21,.18)}
.gt-modal-h{position:sticky;top:0;z-index:1;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
  padding:10px 14px;background:var(--gt-card);border-bottom:1px solid var(--gt-line)}
.gt-modal-t{font-size:14px;font-weight:600;min-width:0;overflow-wrap:anywhere}
.gt-modal-x{margin-left:auto;flex:0 0 auto;border:none;background:transparent;color:var(--gt-muted);
  font-family:inherit;font-size:15px;line-height:1;padding:3px 8px;border-radius:6px;cursor:pointer}
.gt-modal-x:hover{color:var(--gt-fg);background:var(--gt-hover)}
.gt-modal-b{padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.gt-modal-h2{font-size:11px;font-weight:600;color:var(--gt-muted);letter-spacing:.3px}
/* 段名与它的正文是一组：块级 div 之间没有 gap，两组会挤成一坨（真机截图抓到） */
.gt-modal-sec{display:flex;flex-direction:column;gap:6px;min-width:0}
.gt-modal-p{margin:0;line-height:1.65;overflow-wrap:anywhere}
/* 段里的元数据两列：列名吃宿主 sections[].facts[].label，值缺位时宿主根本不会给这一条，所以这里不用防 undefined */
.gt-modal-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 14px;margin:0;font-size:12px}
.gt-modal-facts dt{color:var(--gt-muted);white-space:nowrap}
.gt-modal-facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
/* README 节选是原文：pre-wrap 保留段落换行，但字体跟宿主走（塞等宽字体在中文段落里只是噪音） */
.gt-modal-readme{margin:0;padding:10px 12px;border:1px solid var(--gt-line);border-radius:8px;
  background:var(--gt-soft);font-size:12px;line-height:1.65;white-space:pre-wrap;
  overflow-wrap:anywhere;max-height:40vh;overflow-y:auto;min-width:0}
.gt-modal-f{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;
  border-top:1px solid var(--gt-line);background:var(--gt-soft)}`;

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return () => {};
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
      return () => el.remove();
    }

    // ------------------------------------------------------------
    // 2) 纯函数 helpers（测试从这里取，界面与测试吃同一份）
    // ------------------------------------------------------------
    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；无值说「从未」。 */
    function fmtAge(ms, nowMs) {
      if (!Number.isFinite(ms) || ms <= 0) return '从未';
      const s = Math.max(0, ((nowMs ?? Date.now()) - ms) / 1000);
      if (s < 60) return '刚刚';
      if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
      if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
      return `${Math.floor(s / 86400)} 天前`;
    }
    /** 未来时刻：与 fmtAge 同一套量级词，只是方向朝前。无有效值给空串，由调用方决定这句话说不说。 */
    function fmtIn(ms, nowMs) {
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const s = Math.round((ms - (nowMs ?? Date.now())) / 1000);
      if (s <= 0) return '就在下一轮';
      if (s < 60) return `${s} 秒后`;
      if (s < 3600) return `${Math.floor(s / 60)} 分钟后`;
      if (s < 86400) return `${Math.floor(s / 3600)} 小时后`;
      return `${Math.floor(s / 86400)} 天后`;
    }
    /** star / fork 是计数不是容量 ⇒ 1000 进制。 */
    function fmtCount(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '—';
      if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K`;
      return String(Math.round(v));
    }
    /** 名次变化：只在宿主给了 delta 时说话；没给就是「新进」，不冒充持平。 */
    function deltaCell(d) {
      if (Number.isFinite(d) && d > 0) return { text: `▲${d}`, cls: 'gt-up' };
      if (Number.isFinite(d) && d < 0) return { text: `▼${-d}`, cls: 'gt-down' };
      if (d === 0) return { text: '—', cls: 'gt-flat' };
      return { text: '新进', cls: 'gt-flat' };
    }
    function kindLabel(kind) {
      const map = cfg().eventKindLabels || {};
      return map[kind] || kind;
    }
    /**
     * 仓库名的链接属性：href 保留是给中键 / 右键「新标签页打开」留的活路，
     * 只有普通左键才拦下来去弹详情（带任一修饰键、或非左键一律交给浏览器）。
     * 没接 onRepo（比如某处不想要弹框）就一个都不拦，别把点开的路堵死。
     */
    function repoLinkProps(repo, onRepo) {
      return {
        href: `https://github.com/${repo}`,
        target: '_blank',
        rel: 'noreferrer',
        title: repo,
        onClick: (e) => {
          if (!onRepo) return;
          // 只拦「普通左键」：button 必须 === 0 且不带任何修饰键。
          // 中右键、ctrl/cmd 新标签页、以及没有 button 字段的合成事件一律交回浏览器 ——
          // 宁可开成 GitHub 标签页，也不要凭一个认不出的事件弹个框。
          if (e && (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
          if (e && typeof e.preventDefault === 'function') e.preventDefault();
          onRepo(repo);
        },
      };
    }
    /** Esc 关对话框：单独成函数，用例才不必为了测一个按键去驱动 useEffect。 */
    function escClose(e, close) {
      if (e && e.key === 'Escape' && typeof close === 'function') close();
    }
    /** 详情对话框的空闲态：模块级常量，关闭与初始都归它，免得两处各写一份形状。 */
    const IDLE_DETAIL = { repo: '', loading: false, view: null, err: '' };
    /** 合并 = 整体替换快照。update 帧就是 GET snapshot 的同形载荷，凭空补字段一律禁止（S17 教训）。 */
    function mergeFrame(prev, frame) {
      if (frame && typeof frame === 'object' && frame.kind === 'event') return prev;
      return frame && typeof frame === 'object' ? frame : prev;
    }

    async function api(path, opts = {}) {
      const res = await fetch(`${API_BASE()}${path}`, opts);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok !== true) {
        const msg = body?.error?.message || `HTTP ${res.status}`;
        throw Object.assign(new Error(msg), { code: body?.error?.code });
      }
      return body.data;
    }

    async function consumeSse(res, onEvent) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message';
          const dataLines = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          try { onEvent(ev, JSON.parse(dataLines.join('\n'))); } catch { /* 坏帧丢弃：下一帧会是全量快照 */ }
        }
      }
    }

    function useStream(setSnap, setConn) {
      const stopRef = useRef(false);
      useEffect(() => {
        stopRef.current = false;
        let retry = null;
        (async function loop() {
          while (!stopRef.current) {
            try {
              const res = await fetch(`${API_BASE()}/stream`);
              if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
              setConn({ ok: true, note: '' });
              await consumeSse(res, (ev, data) => {
                if (ev === 'snapshot' || ev === 'update') setSnap((prev) => mergeFrame(prev, data));
              });
              if (!stopRef.current) setConn({ ok: false, note: '推流断开，正在重连' });
            } catch (e) {
              if (!stopRef.current) setConn({ ok: false, note: `推流不可用：${e?.message ?? e}（点「立即检查」后需刷新页面）` });
            }
            if (stopRef.current) break;
            await new Promise((r) => { retry = setTimeout(r, 5000); });
          }
        })();
        return () => { stopRef.current = true; if (retry) clearTimeout(retry); };
      }, []);
    }

    // ------------------------------------------------------------
    // 3) 各段
    // ------------------------------------------------------------
    /** 页头：标题 + 三榜汇总状态 + 唯一的主操作 + 该操作的回执。 */
    function Header({ snap, conn, checking, lastErr, checkNote, onCheck }) {
      const boards = BOARDS();
      const b = snap?.boards || {};
      const bad = boards.filter((k) => b[k] && b[k].hasData === true && b[k].ok !== true);
      const absent = boards.filter((k) => !b[k] || b[k].hasData !== true);
      let dot = 'gt-dot';
      let text = '等待首帧';
      if (snap) {
        if (bad.length) { dot = 'gt-dot gt-dot-err'; text = `${bad.map(boardLabel).join('、')}故障`; }
        else if (absent.length) { dot = 'gt-dot'; text = '还没有榜面数据'; }
        else { dot = 'gt-dot gt-dot-ok'; text = '三榜数据在位'; }
      }
      const tip = [
        bad.map((k) => `${boardLabel(k)}：${b[k]?.error || '原因未给出'}`).join('；'),
        conn && !conn.ok && conn.note ? conn.note : '',
      ].filter(Boolean).join('；');
      const lang = snap?.prefs?.language;
      return h('header', { className: 'gt-head' },
        h('div', { className: 'gt-head-l' },
          h('span', { className: 'gt-title' }, cfg().label || 'GitHub 热榜'),
          lang ? h('span', { className: 'gt-sub' }, `只看 ${lang}`) : null),
        h('div', { className: 'gt-head-r' },
          h('span', { className: 'gt-pill', title: tip || undefined }, h('i', { className: dot }), text),
          snap ? h('span', { className: 'gt-sub gt-num' }, `检查于 ${fmtAge(snap.at, Date.now())}`) : null,
          /* 手动检查的回执跟着按钮走：原先成功回执渲染在设置卡的卡头、失败回执渲染在总览的三榜卡，
             页签化之后点「立即检查」的人多半停在榜单页签上，等于两头回执都收进了别的页签。
             偏好保存的「已保存」仍留在设置卡（那是那张卡的改动反馈）。 */
          checkNote ? h('span', { className: 'gt-receipt gt-num' }, checkNote) : null,
          lastErr ? h('span', { className: 'gt-receipt gt-receipt-err gt-num', title: lastErr }, `检查失败：${lastErr}`) : null,
          h('button', { className: 'gt-btn gt-btn-main', disabled: checking || !snap, onClick: onCheck },
            checking ? '检查中…' : '立即检查')));
    }

    /** 三榜明细：各挂各的闸，坏在哪一榜就只说哪一榜。 */
    function StatusCard({ snap, conn }) {
      const boards = BOARDS();
      const bad = boards.filter((k) => snap?.boards?.[k] && snap.boards[k].hasData === true && snap.boards[k].ok !== true);
      const row = (board) => {
        const s = snap?.boards?.[board];
        if (!s) return null;
        const stale = !s.ok && s.rowsTotal ? `（显示 ${fmtAge(s.at, snap?.at)}的上次成功数据）` : '';
        const streak = !s.ok && s.failStreak ? ` · 已连续 ${s.failStreak} 轮` : '';
        return h('div', { key: board, className: 'gt-srcrow' },
          h('i', { className: `gt-dot ${s.ok ? 'gt-dot-ok' : 'gt-dot-err'}` }),
          h('b', null, boardLabel(board)),
          h('span', { className: 'gt-sub gt-num', title: s.ok ? '' : (s.error || '') },
            s.ok
              ? `榜上 ${s.rowsTotal} 条 · 榜面数据 ${fmtAge(s.at, snap?.at)} · 最近取回 ${fmtAge(s.lastFetchAt, snap?.at)}`
              : `故障 · ${s.error || '原因未给出'}${stale}${streak}`));
      };
      const cad = snap?.cadence;
      const nextIn = bad.length && cad && cad.nextCheckAt ? fmtIn(cad.nextCheckAt, snap?.at) : '';
      const notices = [
        snap && snap.storage && !snap.storage.available
          ? h('div', { key: 'storage', className: 'gt-notice gt-notice-err' }, '存储不可用：榜面照看，但变化史与偏好改动留不下来') : null,
        bad.some((k) => snap.boards[k].transport === true) && snap?.transportHint
          ? h('div', { key: 'transport', className: 'gt-notice' }, snap.transportHint) : null,
        nextIn ? h('div', { key: 'next', className: 'gt-notice gt-num' }, `下次自动检查 ${nextIn}`) : null,
        conn && !conn.ok && conn.note ? h('div', { key: 'conn', className: 'gt-notice' }, conn.note) : null,
      ].filter(Boolean);
      return h('section', { className: 'gt-card' },
        h('div', { className: 'gt-card-h' },
          h('span', { className: 'gt-card-t' }, '三榜状态')),
        h('div', { className: 'gt-card-b' },
          boards.map(row),
          notices.length ? notices : null));
    }

    function RankBadge({ rank }) {
      const n = Number(rank);
      const medal = Number.isFinite(n) && n >= 1 && n <= 3;
      return h('span', { className: medal ? `gt-rank gt-rank-${n}` : 'gt-rank gt-rank-n', title: `第 ${rank} 名` }, String(rank));
    }

    /** 榜单表：一榜一页签，卡内不再套一层分段器（页签本身就是切换器）。 */
    function BoardCard({ snap, board, onRepo }) {
      const b = snap?.boards?.[board] || { rows: [], rowsTotal: 0, ok: false, error: '还没跑过第一轮检查' };
      const rows = b.rows || [];
      const addedLabel = (cfg().boardAddedLabels || {})[board] || '新增';
      const stale = !b.ok && rows.length > 0;
      // 内置离线预译：命中表由宿主算好（snap.descZh.hits），这一半边只做「有没有这一行」的取值，不自己判原文。
      const zh = snap?.descZh || { label: '', note: '', hits: {} };
      const zhRows = rows.filter((r) => zh.hits?.[r.repo]);
      return h('section', { className: 'gt-card' },
        h('div', { className: 'gt-card-h' },
          h('span', { className: 'gt-card-t' }, boardLabel(board)),
          h('span', { className: 'gt-sub gt-num', title: zh.note }, `榜面数据 ${fmtAge(b.at, snap?.at)} · ${b.ok ? '最近取回' : '最近尝试'} ${fmtAge(b.lastFetchAt, snap?.at)}${zhRows.length ? ` · 描述中译为${zh.label}` : ''}`),
          h('span', { className: 'gt-card-n gt-num' }, `${rows.length} / ${b.rowsTotal} 条`)),
        h('div', { className: 'gt-card-b' },
          stale
            ? h('div', { className: 'gt-notice gt-notice-err' }, `本轮${boardLabel(board)}故障：${b.error || '原因未给出'}；下面显示的是上次成功数据`) : null,
          !stale && rows.length === 0
            ? h('p', { className: 'gt-empty' }, b.ok ? '这一档今天没有上榜仓库' : `${boardLabel(board)}：${b.error || '还没有数据'}`)
            : null,
          rows.length
            ? h('div', { className: 'gt-scroll' }, h('table', { className: 'gt-tbl' },
                h('colgroup', null,
                  h('col', { style: { width: 46 } }),
                  h('col', { className: 'gt-col-repo' }),
                  h('col', { className: 'gt-col-desc' }),
                  h('col', { style: { width: 112 } }),
                  h('col', { style: { width: 64 } }),
                  h('col', { style: { width: 72 } }),
                  h('col', { style: { width: 56 } }),
                  h('col', { className: 'gt-tail' })),
                h('thead', null, h('tr', null,
                  h('th', { className: 'gt-r' }, '#'),
                  h('th', null, '仓库'),
                  h('th', null, '描述'),
                  h('th', null, '语言'),
                  h('th', { className: 'gt-r' }, '累计 ★'),
                  h('th', { className: 'gt-r' }, addedLabel),
                  h('th', { className: 'gt-r' }, '较上轮'),
                  h('th', { className: 'gt-tail' }, ''))),
                h('tbody', null, rows.map((r) => {
                  const dd = deltaCell(r.delta);
                  const t = zh.hits?.[r.repo] || '';
                  return h('tr', { key: r.repo, className: r.fresh ? 'gt-new' : '' },
                    h('td', { className: 'gt-r' }, h(RankBadge, { rank: r.rank })),
                    h('td', null,
                      h('a', { className: 'gt-repo', ...repoLinkProps(r.repo, onRepo) }, r.name),
                      r.renamedFrom ? h('span', { className: 'gt-tag' }, `原 ${r.renamedFrom}`) : null,
                      r.fresh ? h('span', { className: 'gt-tag' }, '新面孔') : null),
                    h('td', null, h('span', {
                      className: 'gt-desc',
                      // 悬停必须看得到原文：译文是预译的，读的人有权核对它翻的是哪一句
                      title: t ? `原文：${r.desc}\n${zh.note}` : (r.desc || ''),
                    }, t || r.desc || '—')),
                    h('td', null, r.lang
                      ? h('span', { className: 'gt-lang' }, h('i', { style: r.langColor ? { background: r.langColor } : null }), h('span', null, r.lang))
                      : h('span', { className: 'gt-flat' }, '—')),
                    h('td', { className: 'gt-r gt-num' }, fmtCount(r.stars)),
                    h('td', { className: 'gt-r gt-num' }, fmtCount(r.added)),
                    h('td', { className: `gt-r gt-num ${dd.cls}` }, dd.text),
                    h('td', { className: 'gt-tail' }, ''));
                }))))
            : null),
        h('p', { className: 'gt-note' }, snap?.sourceNote || '来源文案未就位'));
    }

    /** 跨榜同现：吃同一次检查的三张榜，零额外请求。 */
    function CrossCard({ snap, onRepo }) {
      const cross = snap?.cross || { rising: [], cooling: [] };
      const list = (title, rows, empty) => h('div', { className: 'gt-card-b' },
        h('div', { className: 'gt-mini' }, h('span', { className: 'gt-mini-t' }, title), h('span', { className: 'gt-mini-n gt-num' }, `${rows.length} 个`)),
        rows.length
          ? rows.map((r) => h('div', { key: r.repo, className: 'gt-mini' },
              h('a', { className: 'gt-mini-t', ...repoLinkProps(r.repo, onRepo) }, r.name || r.repo),
              h('span', { className: 'gt-mini-s' }, (r.boards || []).map(boardLabel).join(' + ')),
              h('span', { className: 'gt-mini-n gt-num' }, r.lostBoards ? `退出 ${(r.lostBoards || []).map(boardLabel).join('、')}` : `最高第 ${r.bestRank} 名`)))
          : h('p', { className: 'gt-empty' }, empty));
      return h('section', { className: 'gt-card' },
        h('div', { className: 'gt-card-h' },
          h('span', { className: 'gt-card-t' }, '跨榜同现'),
          h('span', { className: 'gt-card-n' }, `同时上 ≥${cfg().crossMin ?? 2} 张榜`)),
        h('div', { className: 'gt-card-b' },
          h('div', { className: 'gt-cols' },
            // 段标题是本页的措辞，不复用宿主的事件枚举（「热度收敛」是 cooling_cross 的片名，两处各写各的会漂）
            list('持续升温', cross.rising || [], '这一轮没有仓库同时在多张榜上'),
            list('热度回落', cross.cooling || [], '没有仓库从多榜掉到只剩一榜')),
          cross.note ? h('p', { className: 'gt-note' }, cross.note) : null));
    }

    function EventsCard({ snap }) {
      const evs = snap?.events ?? [];
      return h('section', { className: 'gt-card' },
        h('div', { className: 'gt-card-h' },
          h('span', { className: 'gt-card-t' }, '变化记录'),
          h('span', { className: 'gt-card-n gt-num' }, `${evs.length} 条`)),
        evs.length
          ? h('div', { className: 'gt-scroll' }, h('ul', { className: 'gt-tl' }, evs.map((e) =>
              h('li', { key: e.id, 'data-kind': e.kind },
                h('span', { className: 'gt-chip' }, kindLabel(e.kind)),
                h('span', { className: 'gt-tl-body' },
                  e.repo || e.detail || '',
                  e.board ? h('span', { className: 'gt-sub' }, boardLabel(e.board)) : null,
                  e.repo && e.detail ? h('span', { className: 'gt-sub' }, e.detail) : null),
                h('span', { className: 'gt-ago gt-num' }, fmtAge(e.at, snap?.at))))))
          : h('p', { className: 'gt-empty' }, snap && snap.storage && !snap.storage.available
              ? '存储不可用，变化不会留痕'
              : '还没有记录'));
    }

    /** 设置：可改项 = 间隔 / 详情缓存时长 / 条数 / 流水保留 / 语言 / 出网方式 / 现译引擎 + 该档凭据与注册地址 / 现译两档 + 只读运行环境。 */
    function SettingsCard({ snap, saving, savedNote, savedErr, onInterval, onSave, language, onLanguage, proxyUrl, onProxyUrl, credDraft, onCred }) {
      const intervals = cfg().intervals || [];
      const labels = cfg().intervalLabels || {};
      const cur = snap?.prefs?.intervalMin;
      const cacheHours = cfg().cacheHours || [];
      const cacheLabels = cfg().cacheHourLabels || {};
      const curCache = snap?.prefs?.repoCacheHours;
      const range = cfg().topNRange || {};
      const topN = snap?.prefs?.topN;
      const evRange = cfg().keepEventsRange || {};
      const keep = snap?.prefs?.keepEvents;
      const modes = cfg().proxyModes || [];
      const modeLabels = cfg().proxyModeLabels || {};
      const modeHints = cfg().proxyModeHints || {};
      const proxyMax = cfg().proxyUrlMax || 200;
      const proxyMode = snap?.prefs?.proxyMode;
      if (!intervals.length || !snap) {
        return h('section', { className: 'gt-card' },
          h('div', { className: 'gt-card-b' },
            h('div', { className: 'gt-notice' }, '配置未就位：宿主载荷还没到，刷新页面试试')));
      }
      const bump = (key, v, min, max, dx) => onSave({ [key]: Math.min(max, Math.max(min, v + dx)) });
      const stepper = (key, v, min, max, dx, unit) => [
        h('button', { key: 'm', className: 'gt-btn gt-step', disabled: !(v > min), onClick: () => bump(key, v, min, max, -dx) }, '−'),
        h('span', { key: 'v', className: 'gt-num gt-count' }, String(v)),
        h('button', { key: 'p', className: 'gt-btn gt-step', disabled: !(v < max), onClick: () => bump(key, v, min, max, dx) }, '+'),
        h('span', { key: 'u', className: 'gt-sub gt-num' }, unit),
      ];
      const langHint = (cfg().langCheck || {}).unknown || '';
      // 现译这一路：只有「库里 true」才算开（宿主那边同样只认 true），旧宿主没给这个键时整段不渲染。
      const tr = snap?.translator || null;
      const switchBtns = (key, on) => [false, true].map((v) => h('button', {
        key: v ? 'on' : 'off',
        className: v === on ? 'on' : '',
        disabled: saving || v === on,
        onClick: () => onSave({ [key]: v }),
      }, v ? '开' : '关'));
      const draftProxy = (proxyUrl ?? '').trim();
      // 凭据草稿（第十轮起三家六格，一个 map 全装）：
      //  · 非密钥格（AppID / SecretId / AccessKeyId）没草稿时回填库里的值 —— 它不是密钥，快照里本来就有；
      //  · 密钥格**从不回填**（`publicPrefs` 摘掉了它，快照里从来没有），所以留空 = 「不改动」，
      //    真要清空是旁边那颗「清除」的语义。★ 这一条不许退回去：草稿一回填就等于把密钥念回界面上。
      const credFields = tr?.credFields || [];
      const storedCred = (f) => (f.secret ? '' : String(snap?.prefs?.[f.key] ?? ''));
      const draftCred = (f) => (credDraft && Object.prototype.hasOwnProperty.call(credDraft, f.key)
        ? credDraft[f.key] : storedCred(f));
      // patch 只带**真改过**的格；密钥格还多一道：空草稿压根不进 patch（进了就是"清除"，那是另一个按钮的语义）。
      const credPatch = {};
      for (const f of credFields) {
        const v = String(draftCred(f) ?? '').trim();
        if (v === String(storedCred(f) ?? '').trim()) continue;
        if (f.secret && !v) continue;
        credPatch[f.key] = v;
      }
      const credDirty = Object.keys(credPatch).length > 0;
      const credClear = Object.fromEntries(credFields.map((f) => [f.key, '']));
      // GitHub 令牌那一行（第二十一轮，用户裁定「填令牌把配额抬到 5000/h」）：
      // ★ 草稿共用上面那一个 `credDraft`（按 pref 键索引，与"选中的是哪一家"无关），保存后由同一处清空。
      //   密钥格**从不回填**（`publicPrefs` 已经把它摘掉了，快照里从来没有这一格）⇒ 留空 = 不改动，清空是那颗「清除」的语义。
      //   旧宿主没给 `snap.github` ⇒ 整行不摆（同出网方式那一行那条判据：摆一个填了没用的框比没有更糟）。
      const gh = snap?.github || null;
      const ghFields = gh?.credFields || [];
      const ghDraftV = (f) => (credDraft && Object.prototype.hasOwnProperty.call(credDraft, f.key) ? credDraft[f.key] : '');
      const ghPatch = {};
      for (const f of ghFields) {
        const v = String(ghDraftV(f) ?? '').trim();
        if (!v) continue;                       // 空草稿不进 patch：进了就是"清除"，那是另一个按钮的语义
        ghPatch[f.key] = v;
      }
      const ghDirty = Object.keys(ghPatch).length > 0;
      const ghClear = Object.fromEntries(ghFields.map((f) => [f.key, '']));
      // 切到 custom 必须带着地址一起发：只发模式的话，宿主那一关的成对校验会当场拒（库里没地址），
      // 用户看到的就是「点了没反应 + 一句保存失败」。地址已经在框里，就顺手用它。
      const chooseMode = (m) => onSave(m === 'custom' ? { proxyMode: m, proxyUrl: draftProxy } : { proxyMode: m });
      return h('section', { className: 'gt-card' },
        h('div', { className: 'gt-card-h' },
          h('span', { className: 'gt-card-t' }, '设置'),
          h('span', { className: 'gt-card-n' }, '改动即生效'),
          saving ? h('span', { className: 'gt-card-n gt-num' }, '保存中…') : null,
          savedNote ? h('span', { className: savedErr ? 'gt-sub' : 'gt-saved gt-num' }, savedNote) : null),
        h('div', { className: 'gt-card-b' },
          h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '检查间隔'),
            h('span', { className: 'gt-seg' }, intervals.map((v) =>
              h('button', { key: v, className: v === cur ? 'on' : '', onClick: () => onInterval(v) }, labels[v] || `${v} 分`)))),
          // 详情缓存时长（第十二轮，用户裁定「进设置页，默认 24 小时」）：与检查间隔同形状，档位与中文标签都吃载荷。
          // ★ 载荷没给 cacheHours（旧宿主）就不摆这一行 —— 一排空按钮比没有更难解释（同出网方式那条判据）。
          //   失败行那 5 分钟不进这里（按裁定留在 domain 的常数里）。
          cacheHours.length ? h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '详情缓存'),
            h('span', { className: 'gt-seg' }, cacheHours.map((v) =>
              h('button', { key: v, className: v === curCache ? 'on' : '', disabled: saving, onClick: () => onSave({ repoCacheHours: v }) }, cacheLabels[v] || `${v} 小时`)))) : null,
          h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '榜单条数'),
            stepper('topN', topN ?? range.min, range.min, range.max, 1, `条（${range.min}–${range.max}，超出榜长即显示全榜）`)),
          h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '流水保留'),
            stepper('keepEvents', keep ?? evRange.min, evRange.min, evRange.max, evRange.step || 50,
              `条（超出裁老，${evRange.min}–${evRange.max}）`)),
          h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '语言过滤'),
            h('input', {
              className: 'gt-input', type: 'text', value: language ?? '', placeholder: '留空 = 全站，如 rust / typescript',
              onChange: (e) => onLanguage(e.target.value),
            }),
            h('button', { className: 'gt-btn', disabled: saving, onClick: () => onSave({ language }) }, '保存'),
            langHint ? h('span', { className: 'gt-sub' }, langHint) : null),
          // 载荷没给 proxyModes（旧宿主）就不摆这一行：三个空按钮的分段器比没有更难解释
          modes.length ? h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '出网方式'),
            h('span', { className: 'gt-seg' }, modes.map((m) =>
              h('button', { key: m, className: m === proxyMode ? 'on' : '', onClick: () => chooseMode(m) }, modeLabels[m] || m))),
            h('input', {
              className: 'gt-input', type: 'text', value: proxyUrl ?? '', placeholder: '127.0.0.1:7897',
              maxLength: proxyMax, onChange: (e) => onProxyUrl(e.target.value),
            }),
            // 只在草稿与库里的值不同时才许发：既挡住「点了一下什么都没改」，又留着「清空地址」这条路
            // （真机走查抓到：空草稿一律禁掉的话，存过的地址就再也清不掉，换档时还会被一起发出去）
            h('button', { className: 'gt-btn', disabled: saving || draftProxy === (snap?.prefs?.proxyUrl ?? '').trim(), onClick: () => onSave({ proxyUrl: draftProxy }) }, '保存'),
            h('span', { className: 'gt-sub' }, modeHints[proxyMode] || '')) : null,
          // GitHub 令牌（第二十一轮）：填了就用认证调用去 api.github.com（配额 60 → 5000 那一档），空着照旧匿名发。
          // 字段表、说明句、「库里已存」那一句、创建令牌的网址全部来自 snap.github，界面一个字不写。
          gh && ghFields.length ? h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, 'GitHub 令牌'),
            ghFields.map((f) => h('input', {
              key: f.key,
              className: 'gt-input',
              type: f.secret ? 'password' : 'text',
              value: ghDraftV(f),
              autoComplete: f.secret ? 'new-password' : 'off',
              placeholder: f.secret && f.has ? (gh.secretSavedHint || '') : f.label,
              maxLength: f.maxLength,
              onChange: (e) => onCred(f.key, e.target.value),
            })),
            h('button', { className: 'gt-btn', disabled: saving || !ghDirty, onClick: () => onSave(ghPatch) }, '保存'),
            // 清除只在库里真有过令牌时才给（同上面那颗）：没填时点了等于把空串再存一遍空串
            gh.credStored ? h('button', { className: 'gt-btn', disabled: saving, onClick: () => onSave(ghClear) }, '清除') : null,
            h('span', { className: 'gt-sub' }, gh.note || '')) : null,
          gh?.register?.links?.length ? h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '创建令牌'),
            gh.register.links.map((l) => h('a', {
              key: l.url, className: 'gt-link', href: l.url, target: '_blank', rel: 'noreferrer',
            }, l.label)),
            gh.register.quota ? h('span', { className: 'gt-sub' }, gh.register.quota) : null) : null,
          // 现译引擎五档（第十轮）：档名、顺序、当前档、发不出去的原因、这一档是什么、要填哪几格、去哪注册，
          // 全部来自 snap.translator，界面一个字不写（换 domain 里的文案，屏上跟着变，客户端不排表）。
          tr ? h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '现译引擎'),
            h('span', { className: 'gt-seg' }, (tr.engines || []).map((e) => h('button', {
              key: e, className: e === tr.engine ? 'on' : '', disabled: saving || e === tr.engine,
              onClick: () => onSave({ translateEngine: e }),
            }, (tr.engineLabels || {})[e] || e))),
            tr.engineHint ? h('span', { className: 'gt-sub' }, tr.engineHint) : null,
            tr.ready ? null : h('span', { className: 'gt-sub' }, tr.notReadyHint)) : null,
          // 凭据行只在**这一档真要吃凭据**时摆（免费接口与宿主模型那一档压根没有这一行）：
          // 摆两个填了没用的输入框就是多此一举。字段表来自宿主（三家六格），键名/长度/是否密钥都不在这边写。
          tr && credFields.length ? h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '接口凭据'),
            credFields.map((f) => h('input', {
              key: f.key,
              className: 'gt-input',
              type: f.secret ? 'password' : 'text',
              value: draftCred(f),
              autoComplete: f.secret ? 'new-password' : 'off',
              placeholder: f.secret && f.has ? (tr.secretSavedHint || '') : f.label,
              maxLength: f.maxLength,
              onChange: (e) => onCred(f.key, e.target.value),
            })),
            h('button', { className: 'gt-btn', disabled: saving || !credDirty, onClick: () => onSave(credPatch) }, '保存'),
            // 清除只在库里这一档已经有凭据时才给：没凭据时这个按钮点了等于把空串再存一遍空串
            tr.credStored ? h('button', { className: 'gt-btn', disabled: saving, onClick: () => onSave(credClear) }, '清除') : null,
            h('span', { className: 'gt-sub' }, tr.credNote || '')) : null,
          // 「切换官方接口时，下面显示去哪个网址注册key」（用户裁定 10-06 第十轮）：
          // 注册地址与额度只跟着**当前选中那一家**说，额度这些数字随时会过期，所以每句都带「以官网为准」。
          tr?.register?.links?.length ? h('div', { className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, '注册拿密钥'),
            tr.register.links.map((l) => h('a', {
              key: l.url, className: 'gt-link', href: l.url, target: '_blank', rel: 'noreferrer',
            }, l.label)),
            tr.register.quota ? h('span', { className: 'gt-sub' }, tr.register.quota) : null) : null,
          // 现译开关：行清单、行名、说明句、开没开**全部**来自宿主那份 `switchRows`（这一边一个字都不写）。
          // ★ 第十五轮曾把翻译四档的摘要那一行从表里去掉；**第十七轮用户改判放回** ⇒ 五档两行都摆。
          //   "不挂假名"那一半由宿主的 `r.label` 兜着（免费/官方那四档念的是「这一段是节译不是摘要」）。
          //   载荷没给这个键（旧宿主）就整段不摆，摆点了没反应的开关比没有更糟。
          ...(tr?.switchRows || []).map((r) => h('div', { key: r.key, className: 'gt-setrow' },
            h('span', { className: 'gt-setlabel' }, r.row),
            h('span', { className: 'gt-seg' }, switchBtns(r.key, r.on === true)),
            h('span', { className: 'gt-sub' }, r.label || ''))),
          tr && tr.note ? h('div', { className: 'gt-setrow' }, h('span', { className: 'gt-sub' }, tr.note)) : null));
    }

    /** 只读运行环境：能力表与传输路径都来自宿主快照，界面不自己判。 */
    function EnvCard({ snap }) {
      const caps = snap?.capabilityRows || [];
      const net = snap?.net;
      const netDot = !net || net.status === 'idle' ? 'gt-dot' : `gt-dot ${net.status === 'ok' ? 'gt-dot-ok' : 'gt-dot-err'}`;
      return h('section', { className: 'gt-card' },
        h('div', { className: 'gt-card-h' },
          h('span', { className: 'gt-card-t' }, '运行环境'),
          h('span', { className: 'gt-card-n' }, '宿主能力 · 只读')),
        h('div', { className: 'gt-card-b' },
          // 传输路径排在能力表之前：这一行回答的是「抓取为什么失败」，是用户点开设置页的来意
          net ? h('div', { className: 'gt-srcrow' },
            h('i', { className: netDot }),
            h('b', null, '传输路径'),
            h('span', { className: 'gt-sub', title: [net.source, net.reason].filter(Boolean).join(' ') }, net.text || ''))
            : null,
          caps.length
            ? caps.map((r) => h('div', { key: r.key, className: 'gt-srcrow' },
                h('i', { className: `gt-dot ${r.ok ? 'gt-dot-ok' : 'gt-dot-err'}` }),
                h('b', null, r.label),
                h('span', { className: 'gt-sub', title: r.ok ? '' : (r.detail || r.fallback || '') },
                  r.ok ? '在位' : (r.detail || r.fallback || '不可用'))))
            : h('p', { className: 'gt-empty' }, '当前快照没有带回能力表')));
    }

    /** 页签表：只放界面结构；三个榜签的标题吃载荷 boardLabels，客户端不另立一份榜名。 */
    const TABS = [
      { id: 'overview', label: '总览' },
      ...BOARDS().map((b) => ({ id: b, label: boardLabel(b) })),
      { id: 'events', label: '变化记录' },
      { id: 'settings', label: '设置' },
    ];

    function TabBar({ tab, onTab, snap }) {
      const counts = BOARDS().reduce((acc, b) => { acc[b] = snap?.boards?.[b]?.rowsTotal ?? 0; return acc; }, {});
      counts.events = (snap?.events || []).length;
      return h('nav', { className: 'gt-tabs' }, TABS.map((t) =>
        h('button', {
          key: t.id,
          className: `gt-tab${tab === t.id ? ' on' : ''}`,
          onClick: () => onTab(t.id),
        }, t.label, counts[t.id] ? h('span', { className: 'gt-tab-n gt-num' }, String(counts[t.id])) : null)));
    }

    /** 总览的一榜小结：前 3 行 + 「完整榜单 →」，判定与文案一律吃快照。 */
    function BoardMini({ snap, board, onGo, onRepo }) {
      const b = snap?.boards?.[board] || {};
      const rows = (b.rows || []).slice(0, 3);
      const addedLabel = (cfg().boardAddedLabels || {})[board] || '新增';
      return h('section', { className: 'gt-card' },
        h('div', { className: 'gt-card-h' },
          h('span', { className: 'gt-card-t' }, boardLabel(board)),
          h('span', { className: 'gt-card-n gt-num' }, `${b.rowsTotal ?? 0} 条`),
          h('button', { className: 'gt-link', onClick: () => onGo(board) }, '完整榜单 →')),
        rows.length
          ? h('div', { className: 'gt-card-b' }, rows.map((r) => h('div', { key: r.repo, className: 'gt-mini' },
              h(RankBadge, { rank: r.rank }),
              h('a', { className: 'gt-mini-t', ...repoLinkProps(r.repo, onRepo) }, r.name),
              h('span', { className: 'gt-mini-n gt-num', title: addedLabel }, `+${fmtCount(r.added)}`))))
          : h('p', { className: 'gt-empty' }, b.ok ? '这一档今天没有上榜仓库' : (b.error || '还没有数据')));
    }

    /** 总览：三榜状态 → 各榜前三 → 跨榜同现。一屏看完「要不要点进某一榜」。
     *  原先这里挂过一张「最近变化」小结（2026-10-05 用户口径去掉：流水看全量就去变化记录页签，
     *  摆在总览只是把同一批事件再念四遍，还占掉一屏里最贵的位置）。 */
    function OverviewTab({ snap, conn, onGo, onRepo }) {
      return h('div', { className: 'gt-panel' },
        h(StatusCard, { snap, conn }),
        h('div', { className: 'gt-boards3' }, BOARDS().map((b) => h(BoardMini, { key: b, snap, board: b, onGo, onRepo }))),
        h(CrossCard, { snap, onRepo }));
    }

    /**
     * 段里那四块的字面形状（键必须与 domain 的 `REPO_BLOCK_KINDS` 逐一对应，用例逐块喂四种 `kind` 核对都摆得出来）。
     * ★ 这里只决定「用什么标签、挂什么类」，不判"这一段该显示成什么"：段序、句子、哪句算小字全是宿主 `repoSections` 定好的。
     */
    const DETAIL_BLOCK = {
      p: ['p', 'gt-modal-p'],
      sub: ['p', 'gt-modal-p gt-sub'],
      num: ['p', 'gt-modal-p gt-sub gt-num'],
      excerpt: ['div', 'gt-modal-readme'],
    };
    const detailBlock = (secKey, i, b) => {
      const shape = DETAIL_BLOCK[b?.kind];
      return shape ? h(shape[0], { key: `${secKey}b${i}`, className: shape[1] }, b.text) : null;
    };

    /**
     * 仓库详情对话框：中文解释的**句子与段名**全部来自宿主 repoView 的 `sections`
     * （第十一轮「结构化摘要」：段序、段里摆什么、哪句算小字，都在宿主 `repoSections` 定死，这里只按 `blocks[].kind` 摆字。
     *   第十二轮起段对象没有 `source` 这一格，界面上也没有那一句来源落款 —— 不是这里少摆了一块）。
     * 这里一个字不加：不判"这一段该显示成什么"、不自己拼「中文描述（…）：」那种带来源标签的整句、不排段序。
     * 三种没内容的样子各说各的：还在取（loading）、请求本身坏了（err）、取回来了但 ok:false（view.error）。
     */
    function DetailModal({ detail, onClose, onRefresh }) {
      const v = detail.view;
      const repo = detail.repo || v?.repo || '';
      const githubUrl = v?.htmlUrl || `https://github.com/${repo}`;
      const ageText = v ? fmtAge(v.cached ? Date.now() - (Number(v.cacheAgeMs) || 0) : v.at, Date.now()) : '';
      const rateLeft = v?.rate?.left;
      // 重置时刻只在「还没到」的时候说：fmtIn 对已过的时刻给「就在下一轮」，那是检查节拍的词，用在配额上是假话
      const resetIn = v?.rate?.resetAt > Date.now() ? fmtIn(v.rate.resetAt, Date.now()) : '';
      const rateText = Number.isFinite(rateLeft)
        // ★ 第二十一轮：「匿名 / 已认证」这两个字**只从宿主来**（`rate.label` 的判据是 GitHub 自己回的 `x-ratelimit-limit`）。
        //   这里不写兜底的那一句：客户端抄一份"没给就当匿名"，等于在同一屏上放第二个真相 ——
        //   载荷恒由 repoView() 拼，label 恒在，缺了那是宿主出了 bug，该露出来而不是被界面圆掉。
        ? `${v.rate.label}剩 ${rateLeft} / ${v.rate.limit}${resetIn ? `，${resetIn}重置` : ''}`
        : '';
      const sections = v?.ok === true ? (Array.isArray(v.sections) ? v.sections : []) : [];
      useEffect(() => {
        const onKey = (e) => escClose(e, onClose);
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      return h('div', {
        className: 'gt-modal-mask',
        onClick: (e) => { if (e && e.target !== e.currentTarget) return; onClose(); },
      },
        h('div', {
          className: 'gt-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '仓库详情',
          // tabIndex + autoFocus：开框后 Tab 先落在框里（× 在最前），不是落在遮罩后面那半张榜单上
          tabIndex: -1,
          autoFocus: true,
        },
          h('div', { className: 'gt-modal-h' },
            h('span', { className: 'gt-modal-t' }, v?.name || repo),
            h('span', { className: 'gt-sub gt-num', title: repo }, repo),
            h('button', { className: 'gt-modal-x', onClick: onClose, title: '关闭（Esc）' }, '×')),
          h('div', { className: 'gt-modal-b' },
            detail.loading
              ? h('p', { className: 'gt-modal-p gt-sub' }, '正在取这份仓库的详情：最多四发出网（元数据、README，必要时再看有没有中文那份），比榜面慢一些。')
              : null,
            detail.err
              ? h('div', { className: 'gt-notice gt-notice-err' }, `详情请求本身失败：${detail.err}`) : null,
            v && !v.ok
              ? h('div', { className: 'gt-notice gt-notice-err' },
                  h('div', null, v.error || '详情没取到'),
                  v.errText ? h('div', { className: 'gt-sub' }, v.errText) : null)
              : null,
            sections.map((sec) => h('div', { key: sec.key, className: 'gt-modal-sec' },
              h('div', { className: 'gt-modal-h2' }, sec.label),
              (sec.blocks || []).map((b, i) => detailBlock(sec.key, i, b)),
              (sec.facts || []).length
                ? h('dl', { className: 'gt-modal-facts' }, sec.facts.map((f) => [
                    h('dt', { key: `d${f.key}` }, f.label),
                    h('dd', { key: `v${f.key}` }, f.value),
                  ]))
                : null)),
            v && v.ok && rateText ? h('p', { className: 'gt-modal-p gt-sub gt-num' }, rateText) : null),
          h('div', { className: 'gt-modal-f' },
            v && !v.ok
              ? h('button', { className: 'gt-btn', onClick: onRefresh }, '重新取一次')
              : h('button', { className: 'gt-btn', onClick: onRefresh }, '重新取一次（不走缓存）'),
            v && v.ok && ageText ? h('span', { className: 'gt-sub gt-num' }, `${v.cached ? '缓存于' : '取回于'} ${ageText}`) : null,
            h('a', { className: 'gt-link', href: githubUrl, target: '_blank', rel: 'noreferrer' }, '在 GitHub 打开 ↗'),
            v && v.homepage ? h('a', { className: 'gt-link', href: v.homepage, target: '_blank', rel: 'noreferrer' }, '项目主页 ↗') : null)));
    }

    function TrendingPanelIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none' },
        h('path', { d: 'M3 14l4-5 3 2.5L16 5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M12.5 5H16v3.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function GhTrendingPage() {
      const [snap, setSnap] = useState(null);
      const [conn, setConn] = useState({ ok: false, note: '' });
      const [tab, setTab] = useState('overview');
      const [checking, setChecking] = useState(false);
      const [lastErr, setLastErr] = useState('');
      const [checkNote, setCheckNote] = useState('');
      const [saving, setSaving] = useState(false);
      const [savedNote, setSavedNote] = useState('');
      const [savedErr, setSavedErr] = useState(false);
      const [language, setLanguage] = useState('');
      const langInit = useRef(false);
      const [proxyUrl, setProxyUrl] = useState('');
      const proxyInit = useRef(false);
      // 凭据草稿：三家六格共用一个 map（键 = 偏好里的键名）。★ 密钥格永不回填、发完即清（`null` = 一格都没动过）。
      const [credDraft, setCredDraft] = useState(null);
      const [detail, setDetail] = useState(IDLE_DETAIL);
      // 迟到的那一份不该盖掉人后来点的那一份：每开一次就换号，回来时对不上号就丢
      const detailSeq = useRef(0);
      useStream(setSnap, setConn);

      // 语言输入框只在首帧用库里的值初始化一次，否则每次 update 帧都会把用户正在打的字冲掉
      useEffect(() => {
        if (langInit.current || !snap) return;
        langInit.current = true;
        setLanguage(snap?.prefs?.language ?? '');
      }, [snap]);

      // 代理地址同理：它是「一边打字一边可能被 update 帧冲掉」的同一个坑，不是两个坑
      useEffect(() => {
        if (proxyInit.current || !snap) return;
        proxyInit.current = true;
        setProxyUrl(snap?.prefs?.proxyUrl ?? '');
      }, [snap]);

      // AppID / SecretId / AccessKeyId 是同一个坑（正在打的字会被 update 帧冲掉），所以草稿一旦动过就不再回填；
      // 没动过的那些格每次现读库里的值（`credDraft` 里没这个键 ⇒ 吃 `snap.prefs`），换引擎时不会串台。
      function setCred(key, v) {
        setCredDraft((d) => ({ ...(d || {}), [key]: v }));
      }

      async function doCheck() {
        setChecking(true); setLastErr(''); setCheckNote('');
        try {
          const r = await api('/check', { method: 'POST' });
          if (!conn.ok) setSnap(await api('/snapshot'));
          const p = r.produced || {};
          const n = BOARDS().reduce((a, k) => a + Object.values(p[k] || {}).reduce((x, y) => x + y, 0), 0)
            + (r.producedCross?.rising ?? 0) + (r.producedCross?.cooling ?? 0);
          setCheckNote(`本轮 ${new Date(r.at).toLocaleTimeString()} 完成，记录 ${n} 项变化`);
        } catch (e) {
          setLastErr(e?.message ?? String(e));
        } finally {
          setChecking(false);
        }
      }
      /**
       * 开详情：先落「正在取」再发请求（这一发最多四出网，不给回执就等于让人对着静止的屏幕等）。
       * keep=true 是「重新取一次」：旧内容留在屏幕上，只在按钮旁长个「正在取」，不把已有解释抹掉。
       */
      async function loadDetail(repo, { refresh = false, keep = false } = {}) {
        const seq = (detailSeq.current = (detailSeq.current || 0) + 1);
        setDetail(keep ? { repo, loading: true, view: detail.view, err: '' } : { repo, loading: true, view: null, err: '' });
        try {
          const v = await api(`/repo?name=${encodeURIComponent(repo)}${refresh ? '&refresh=1' : ''}`);
          if (detailSeq.current !== seq) return;
          setDetail({ repo, loading: false, view: v, err: '' });
        } catch (e) {
          if (detailSeq.current !== seq) return;
          setDetail({ repo, loading: false, view: null, err: e?.message ?? String(e) });
        }
      }
      function closeDetail() {
        detailSeq.current = (detailSeq.current || 0) + 1;   // 关掉的这一刻起，迟到的回执一律作废
        setDetail(IDLE_DETAIL);
      }

      async function savePrefs(patch) {
        setSaving(true); setSavedNote(''); setSavedErr(false);
        try {
          const saved = await api('/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
          setSnap((p) => (p ? { ...p, prefs: saved } : p));
          if (patch.language !== undefined) setLanguage(saved.language ?? '');
          if (patch.proxyUrl !== undefined) setProxyUrl(saved.proxyUrl ?? '');
          // 发出去过的那几格把草稿丢掉：非密钥格此后现读回执里的值（库里那份才是真相），
          // 密钥格则回到「空白 = 不改动」——留着草稿的话，下一次保存会把它当成"新密钥"再发一遍。
          if (Object.keys(credDraft || {}).some((k) => patch[k] !== undefined)) {
            setCredDraft((d) => Object.fromEntries(Object.entries(d || {}).filter(([k]) => patch[k] === undefined)));
          }
          setSavedNote('已保存');
        } catch (e) {
          setSavedErr(true);
          setSavedNote(`保存失败：${e?.message ?? e}`);
        } finally {
          setSaving(false);
        }
      }

      const settings = h(SettingsCard, {
        snap, saving, savedNote, savedErr, language, proxyUrl, credDraft,
        onLanguage: setLanguage,
        onProxyUrl: setProxyUrl,
        onCred: setCred,
        onInterval: (v) => savePrefs({ intervalMin: v }),
        onSave: (p) => savePrefs(p),
      });
      const onRepo = (repo) => { loadDetail(repo); };
      let panel;
      if (tab === 'settings') panel = h('div', { className: 'gt-panel' }, settings, h(EnvCard, { snap }));
      else if (BOARDS().includes(tab)) panel = h(BoardCard, { snap, board: tab, onRepo });
      else if (tab === 'events') panel = h(EventsCard, { snap });
      else panel = h(OverviewTab, { snap, conn, onGo: setTab, onRepo });

      const opened = detail.repo !== '' || detail.view !== null;
      return h('div', { className: 'gt-root' },
        h('div', { className: 'gt-topbar' },
          h(Header, { snap, conn, checking, lastErr, checkNote, onCheck: doCheck }),
          h(TabBar, { tab, onTab: setTab, snap })),
        panel,
        opened
          ? h(DetailModal, {
              detail,
              onClose: closeDetail,
              onRefresh: () => loadDetail(detail.repo, { refresh: true, keep: true }),
            })
          : null);
    }

    // ------------------------------------------------------------
    // 4) apply：入口注册
    // ------------------------------------------------------------
    function apply(ctx) {
      if (!cfg().routePrefix) return; // 没路由前缀 = 没 webServer：一个入口都不注册
      ctx.effect(() => injectStyle(), 'gh-trending:style');
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER(), label: () => cfg().label || 'GitHub 热榜' },
          TrendingPanelIcon,
        ));
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, GhTrendingPage));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.PANEL_ID = PANEL_ID;
    exports.__test = {
      cfg, API_BASE, BOARDS, boardLabel, fmtAge, fmtIn, fmtCount, deltaCell, kindLabel, mergeFrame, api, consumeSse, TABS,
      repoLinkProps, escClose, IDLE_DETAIL,
      components: {
        Header, TabBar, OverviewTab, BoardMini, StatusCard, BoardCard, CrossCard,
        EventsCard, SettingsCard, EnvCard, RankBadge, DetailModal, GhTrendingPage,
      },
    };
    // 宿主 ModuleLoader 吃的是 factory 的**返回值**当模块导出：
    // 返回 module 会让外层拿不到 apply ⇒ 真机报 "invalid plugin, received object"。
    return module.exports;
  },
});
