/**
 * 记录域（`gh_trending`）仓储的共用底座 —— sysops / modelwatch `lib/kv-records-base.js` 的同源拷贝
 * （只差错误码前缀 GHT_），供 lib/stores.js 的 state / events / prefs / seen 四表使用。
 * ⚠️ 同源拷贝：这里的改动要与 sysops、dsh-plugin-stock-analysis、modelwatch 三处同名文件对齐，不许各自漂移。
 *
 * ## 为什么必须有「按设施去重的域打开登记表」（Ruling-71 T13-D）
 *
 * 宿主契约写明 **domain 名是排他的**：同一个名字重复 `open()` 会报 `already-open`
 * （见 `dsh-plugin-stock-analysis/docs/host-capabilities.md`）。参照实现没撞上这一劫，
 * 是因为它三个仓储各开各的域；本仓库的三张表（`alert_hit` / `clean_plan` / `clean_log`）
 * **刻意放在同一个域里**（分域会让"记录"这一类事实被拆散，且每次多开一个域），
 * 于是「每个仓储各缓存一个 open promise」的前提直接失效：Task 19 装配现场
 * 第二个碰这个域的仓储必然抛 `already-open`。
 *
 * 所以这里把 open 收口成登记表：
 * - `WeakMap<facility, Map<domainName, { promise, handle, refs, closing, closingDone }>>`。
 *   用 WeakMap 是为了测试里每例新建的设施不会被登记表 strong-hold 住（否则每跑一例泄漏一个域）。
 * - 首个调用者真的 `facility.open(domain)`，后来者复用同一个 promise 并 `refs += 1`。
 * - **open 失败清掉 entry**：保留已交付骨架「失败可重试」的语义（hit-3 钉着这条）。
 * - `release()` 只有把 `refs` 降到 0 才真的 `handle.close()` —— 否则 `planStore.close()`
 *   会顺手把还活着的 `logStore` 与告警仓储的域关掉。
 * - **真关完之前不摘牌**：`closing` 期间 entry 仍留在表里，此刻来的新持有者等关完再重新 open。
 *   摘早了就是在"名字尚未释放"的窗口里放行另一发 `open()`（F-3）。
 *
 * ## 「仓储终态」与「域关闭」是两件事
 *
 * `close()` 后自己再写要报 `CLOSED`：那是**每个仓储实例**的语义，由各仓储自己持有
 * `closed` 标志与写队列。`release()` 关掉域：那是**登记表**的语义，只在最后一个持有者
 * 放手时发生。两者不许混（本文件把两条路分开写，就是为了不让实现者顺手把域当实例关掉）。
 *
 * ## 为什么不迁移 `lib/alerts/store.js` / `lib/prefs/store.js`（Ruling-63）
 *
 * 两者各有已签收的变异级测试与不同的错误词表，为 DRY 重写已交付主路径不划算。
 * alerts 侧只把那一发 `facility.open()` 换成经本文件登记表取 handle —— 那是撞车修复，
 * 不是骨架迁移。
 */
/**
 * 稳定错误码：与 `PREFS_ERROR` 同名同形，Task 18 按 `e.code` 分支（裸 Error 接不住）。
 * 四个交付 code 照简报；`INVALID` 是骨架「脏行必须挡在 put 之前」带出的第五个，
 * 取值与 `PREFS_INVALID` 同式。
 */
export const RECORDS_ERROR = {
  UNAVAILABLE: 'GHT_RECORDS_UNAVAILABLE',
  DUPLICATE: 'GHT_RECORDS_DUPLICATE',
  NOT_FOUND: 'GHT_RECORDS_NOT_FOUND',
  CLOSED: 'GHT_RECORDS_CLOSED',
  INVALID: 'GHT_RECORDS_INVALID',
};

/** 带 code 的记录域错误。`code` 取 `RECORDS_ERROR` 的字面值，Task 18 按 code 分支。 */
export class RecordsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecordsError';
    this.code = code;
  }
}

/**
 * `facility -> Map<domainName, entry>`，`entry = { promise, handle, refs, closing, closingDone }`。
 * @type {WeakMap<object, Map<string, object>>}
 */
const domainsByFacility = new WeakMap();

/**
 * 取域 handle：同一设施同一域只 open 一次，后来者复用并计数。
 *
 * @param options.facility 宿主 `ctx.storageDomain` 设施对象
 * @param options.domain 已声明的域（`defineDomain` 的返回）
 * @param options.logger 可选，open 失败本身不 warn（错误会往上抛）
 * @param options.openFailLabel 中文文案前缀，如 `清单快照域 open 失败`
 * @param options.ErrorCtor 错误类（alerts 侧沿用它自己的 `RecordsError`）
 * @param options.unavailableCode open 失败映射的 code（alerts 侧沿用 `RECORDS_UNAVAILABLE`）
 * @returns Promise<handle>；失败时 reject 带 code 的错误，**且 entry 被清掉以便重试**。
 */
export function acquireDomain({
  facility,
  domain,
  logger,
  openFailLabel = '记录域 open 失败',
  ErrorCtor = RecordsError,
  unavailableCode = RECORDS_ERROR.UNAVAILABLE,
} = {}) {
  let byName = domainsByFacility.get(facility);
  if (!byName) {
    byName = new Map();
    domainsByFacility.set(facility, byName);
  }
  let entry = byName.get(domain.name);
  if (entry?.closing) {
    // 有人正在关这个域：等它真关完再由自己重新 open。复用 `entry.promise` 会拿到一个即将被
    // close 的 handle；并行另开则在同名域上撞 `already-open` —— 两条都不是"新持有者"该得到的
    // （F-3 / 复评 S3：`planStore.close()` 的窗口里 `logStore` 正常首写硬失败）。
    // 删除 entry 的动作挂在 `closingDone` 的第一个 then 上，所以这里再 acquire 时必定查不到旧 entry。
    return entry.closingDone.then(() =>
      acquireDomain({ facility, domain, logger, openFailLabel, ErrorCtor, unavailableCode }),
    );
  }
  if (!entry) {
    entry = { promise: null, handle: null, refs: 0, closing: false };
    byName.set(domain.name, entry);
    entry.promise = (async () => {
      try {
        const handle = await facility.open(domain);
        entry.handle = handle;
        return handle;
      } catch (error) {
        if (byName.get(domain.name) === entry) byName.delete(domain.name);
        // open 失败也是降级：映射成带 code 的 UNAVAILABLE，并把原始 message 留在后面
        throw new ErrorCtor(unavailableCode, `${openFailLabel}：${error?.message ?? error}`);
      }
    })();
  }
  entry.refs += 1;
  return entry.promise;
}

/**
 * 放手：`refs -= 1`，**只有降到 0 才真的关域**。
 *
 * 顺序是「先真关完、后摘 entry」，不是反过来（F-3）：域名排他，摘早了关闭窗口里的
 * 另一个仓储查不到 entry 就会自己发一发 `open()`，撞上尚未释放的名字。
 * @returns Promise<boolean> 返回是否真的关掉了域（false = 还有别人持有 / 从没 open 成功）
 */
export async function releaseDomain({
  facility,
  domain,
  logger,
  closeFailLabel = '记录域关闭失败',
} = {}) {
  const byName = domainsByFacility.get(facility);
  const entry = byName?.get(domain.name);
  if (!entry) return false; // 本设施上这个域没被持有（或 open 从未成功）
  entry.refs -= 1;
  if (entry.refs > 0 || entry.closing) return false; // 还活着，别人还在用
  entry.closing = true;
  const done = (async () => {
    const handle = entry.handle ?? (await entry.promise.catch(() => null));
    if (!handle) return false; // 从没 open 成功，无域可关
    try {
      await handle.close();
    } catch (error) {
      logger?.warn?.(`[gh-trending] ${closeFailLabel}：${error?.message ?? error}`);
    }
    return true;
  })();
  // 这个 then 比任何后来者都先跑 ⇒ 等 `closingDone` 的人醒来时 entry 已摘，会走全新 open
  entry.closingDone = done.then((closed) => {
    if (byName.get(domain.name) === entry) byName.delete(domain.name);
    return closed;
  });
  return entry.closingDone;
}

/**
 * 记录域仓储骨架：`facilityOf` / `assertUsable` / `ensureDomain` / `available` + `close` + 串行写队列。
 * 各仓储真正独有的 `save/get/list/trim/查重` 留在自己文件里（Ruling-63）。
 *
 * @param options.getFacility 惰性取设施函数。**不要直接读 ctx 属性** —— Context 是代理。
 * @param options.domain 目标域
 * @param options.table 该仓储负责的表名
 * @param options.labels 中文文案表，四份骨架的错误词表各不相同
 */
export function createRecordRepo({ getFacility, logger, domain, table: tableName, labels = {} } = {}) {
  let opening = null;
  let closed = false;
  let held = null; // 真正 acquire 过的设施，close 时按它去 release

  const facilityOf = () => {
    try {
      return typeof getFacility === 'function' ? getFacility() : undefined;
    } catch {
      return undefined;
    }
  };

  // 写队列：KV 没有事务，串行是唯一能保证「谁最后写」确定的办法（同 prefs/alerts）
  let chain = Promise.resolve();
  const enqueue = (job) => {
    const run = chain.then(() => job());
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  function assertUsable() {
    if (closed) throw new RecordsError(RECORDS_ERROR.CLOSED, labels.closed ?? '记录仓储已关闭');
    const f = facilityOf();
    if (!f || typeof f.open !== 'function') {
      throw new RecordsError(
        RECORDS_ERROR.UNAVAILABLE,
        labels.noFacility ?? '宿主未提供 ctx.storageDomain，记录无法落库（换台机器会丢）',
      );
    }
  }

  /** 懒打开：经登记表取 handle（同一设施同一域只 open 一次，Ruling-71 T13-D）。 */
  function ensureDomain() {
    assertUsable();
    if (!opening) {
      const facility = facilityOf();
      held = facility;
      opening = acquireDomain({
        facility,
        domain,
        logger,
        openFailLabel: labels.openFail ?? '记录域 open 失败',
      });
      opening.catch(() => {
        opening = null; // 失败允许下次重试，不要缓存一个坏掉的 promise
        held = null;
      });
    }
    return opening;
  }

  async function tableOf() {
    const handle = await ensureDomain();
    return handle.table(tableName);
  }

  /** 脏行必须在 put 之前被 schema 挡下并包成带 code 的 INVALID，否则半条脏记录会留在域里。 */
  function parseOrInvalid(value) {
    try {
      return domain.tables[tableName].valueSchema.parse(value);
    } catch (e) {
      throw new RecordsError(
        RECORDS_ERROR.INVALID,
        `${labels.invalid ?? '记录校验失败'}：${e?.message ?? e}`,
      );
    }
  }

  return {
    get available() {
      const f = facilityOf();
      return Boolean(f && typeof f.open === 'function') && !closed;
    },

    /** 供宿主卸载时调用。必须 await，否则紧接着重新 open 会撞 already-open。 */
    async close() {
      closed = true;
      const pending = opening;
      opening = null;
      if (!pending) return; // 从没 acquire 过，不该去减别人的 refs
      const facility = held;
      held = null;
      await releaseDomain({
        facility,
        domain,
        logger,
        closeFailLabel: labels.closeFail ?? '记录域关闭失败',
      });
    },

    assertUsable,
    enqueue,
    tableOf,
    parseOrInvalid,
    get isClosed() {
      return closed;
    },
  };
}
