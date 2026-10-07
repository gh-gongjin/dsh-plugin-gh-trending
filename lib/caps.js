/**
 * lib/caps.js —— sysops / modelwatch 同名文件的收缩拷贝（只留本插件用到的三项能力）。
 * 三种状态的区分口径不许漂：没探测过 / 探测过且缺 / 宿主架构上不提供。
 *
 * 本插件刻意**不**注入 llm：界面不需要模型解读（spec §0 裁定）；
 * 也刻意**不**用 ctx.schedule / ctx.jobs —— 那两个会把轮询播报灌进用户的 Agent 会话。
 */
export const CAP_KEYS = ['storageDomain', 'timer', 'webServer'];

/** 中文文案逐字取自 spec §5；改这里要同步改 spec。 */
export const CAP_ROWS = [
  { key: 'storageDomain', label: '宿主存储 storageDomain', fallback: '抓取照跑，但本轮变化无法留痕：状态行就地写明，设置页转只读' },
  { key: 'timer', label: '宿主定时器 ctx.interval', fallback: '退到 setInterval（unref），插件卸载时显式清；这行降级如实标出来' },
  { key: 'webServer', label: '宿主 Web 服务', fallback: '不注册侧边栏入口（点开空白页比看不到入口更糟）' },
];

export function createCaps({ logger } = {}) {
  const found = Object.fromEntries(CAP_KEYS.map((k) => [k, false]));
  const detail = {};
  const warned = new Set();
  return {
    mark(key, ok, why = '') {
      if (!CAP_KEYS.includes(key)) throw new Error(`未知能力键：${key}`);
      found[key] = Boolean(ok);
      if (why) detail[key] = why;
      else if (ok) delete detail[key];
      if (!found[key] && !warned.has(key)) {
        warned.add(key);
        logger?.warn?.(`[gh-trending] 宿主缺少 ${key}：${CAP_ROWS.find((r) => r.key === key).fallback}`);
      }
    },
    read: () => ({ ...found }),
    rows: () => CAP_ROWS.map((r) => ({ ...r, ok: found[r.key], detail: detail[r.key] ?? '' })),
    get storageDomain() { return found.storageDomain; },
    get timer() { return found.timer; },
    get webServer() { return found.webServer; },
  };
}
