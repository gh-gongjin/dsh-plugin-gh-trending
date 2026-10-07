/**
 * 极小的记录校验器 —— 只为满足宿主 storageDomain 的调用面。
 *
 * 背景（见 ../dsh-plugin-stock-analysis/docs/host-capabilities.md 三）：`ctx.storageDomain` 只对记录调用
 * `schema.parse(v)` 与 `schema.safeParse(v)`，且官方实现里**零 instanceof 检查**。
 * 官方用 `@deepseek-ai/schemastery`，但插件不能 import 任何 `@deepseek-ai/*`
 * （link: 挂载会解析出第二份模块实例），所以这里自造一个形状相同的实现。
 * 双源约束：本文件与 ../dsh-plugin-sysops/lib/kv-schema.js、../dsh-plugin-stock-analysis/lib/kv-schema.js
 * 是同一份实现的三份拷贝，必须保持同源、不要各自漂移 ——
 * 本拷贝除本段注释外与 sysops 版逐字一致，改动任一份都要同步另两份。
 * 宿主 storageDomain 只调 parse/safeParse 且零 instanceof 检查，官方包不能 import（link: 会解析出第二份实例）。
 *
 * 设计取舍：**只做记录级校验，不做类型系统**。校验失败的记录会被 open() 抛
 * `invalid-record`，命名到具体表与 key —— 这正是我们要的：坏数据要么进不来，
 * 要么进得来就被指名道姓地报出来，绝不静默接受。
 */

const FAIL = Symbol('kv-schema.fail');

/** @returns {{ success: boolean, data?: unknown, error?: Error }} */
function safe(validate, value) {
  try {
    const data = validate(value);
    if (data === FAIL) return { success: false, error: new Error('校验未通过') };
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** 把校验函数包成宿主认识的样子。 */
export function makeSchema(validate) {
  return {
    safeParse(value) {
      return safe(validate, value);
    },
    parse(value) {
      const result = safe(validate, value);
      if (!result.success) throw result.error;
      return result.data;
    },
  };
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 必填字符串，空串视为未填（避免「填了个空格」冒充有值）。 */
export const requiredString = (label) =>
  makeSchema((v) => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`${label} 必填，且必须是非空字符串`);
    }
    return v;
  });

/**
 * 可选字符串；缺省或空串都归一成 undefined，不留空壳字段。
 *
 * @param opts.maxLength 给了就限长。**超长是"报错"不是"截断"** —— 截断会把一份
 *   用户自己写的提示词悄悄改成半句话，而他还以为自己存的是完整那份。
 *   宁可这次存不进去、界面把原因写出来。
 */
export const optionalString = (label, opts = {}) => {
  const max = Number(opts.maxLength);
  return makeSchema((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new Error(`${label} 必须是字符串`);
    if (Number.isFinite(max) && max > 0 && v.length > max) {
      throw new Error(`${label} 过长（${v.length} 字，上限 ${max} 字）`);
    }
    return v;
  });
};

/** 必填整数。 */
export const requiredInt = (label) =>
  makeSchema((v) => {
    if (!Number.isInteger(v)) throw new Error(`${label} 必填，且必须是整数`);
    return v;
  });

/** 可选整数。 */
export const optionalInt = (label) =>
  makeSchema((v) => {
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v)) throw new Error(`${label} 必须是整数`);
    return v;
  });

/**
 * 可空字符串：显式 `null` 会被**保留**成 `null`，而不是归一成 `undefined`。
 *
 * 用于「字段存在且值就是 null」有语义的场合 —— 典型是 `archive.actionRef`：
 * 它的 null 表示"这份结论不产生操作"，是要**落在数据上**的事实，
 * 不能被当成"没填"而抹掉。可选字段用 `optionalString`，不要用这个。
 */
export const nullableString = (label) =>
  makeSchema((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new Error(`${label} 必须是字符串或 null`);
    return v;
  });

/** 必填数字（整数与小数都收）。 */
export const requiredNumber = (label) =>
  makeSchema((v) => {
    if (!Number.isFinite(v)) throw new Error(`${label} 必填，且必须是数字`);
    return v;
  });

/** 可选数字。`NaN` / `Infinity` 一律当没填 —— 它们进得了 JSON 却没法参与比较。 */
export const optionalNumber = (label) =>
  makeSchema((v) => {
    if (v === undefined || v === null) return undefined;
    if (!Number.isFinite(v)) throw new Error(`${label} 必须是数字，收到 ${JSON.stringify(v)}`);
    return v;
  });

/** 可选布尔。 */
export const optionalBool = (label) =>
  makeSchema((v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') throw new Error(`${label} 必须是布尔值`);
    return v;
  });

/**
 * 必填布尔。默认**不为缺省值兜底** —— 开关语义是二值的，"没填"不是第三种状态。
 * 需要三态（未设置 / 开 / 关）的场合用 `optionalBool`。
 */
export const requiredBool = (label) =>
  makeSchema((v) => {
    if (typeof v !== 'boolean') throw new Error(`${label} 必填，且必须是布尔值`);
    return v;
  });

/**
 * 枚举（必填）。允许集合写死，越界直接拒绝 —— 状态字段最怕脏值，
 * 因为它会被界面直接渲染出来。
 */
export const requiredEnum = (label, allowed) =>
  makeSchema((v) => {
    if (typeof v !== 'string' || !allowed.includes(v)) {
      throw new Error(`${label} 必须是 ${allowed.join(' | ')} 之一，收到 ${JSON.stringify(v)}`);
    }
    return v;
  });

/** 枚举（可选）。 */
export const optionalEnum = (label, allowed) =>
  makeSchema((v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || !allowed.includes(v)) {
      throw new Error(`${label} 必须是 ${allowed.join(' | ')} 之一，收到 ${JSON.stringify(v)}`);
    }
    return v;
  });

/**
 * 标量数组（可选）。元素是**单个校验器**而不是对象形状 ——
 * 典型用途是 id 清单、标签清单（`['1.600519', '0.000001']`）。
 * @param label 字段名，报错时点名用
 * @param itemSchema 每个元素的校验器（如 `requiredString('x')`）
 */
export const arrayOfItem = (label, itemSchema, options = {}) => {
  const { required = false, minLength = 0 } = options;
  return makeSchema((v) => {
    if (v === undefined || v === null) {
      if (required) throw new Error(`${label} 必填`);
      return undefined;
    }
    if (!Array.isArray(v)) throw new Error(`${label} 必须是数组`);
    if (v.length < minLength) throw new Error(`${label} 至少需要 ${minLength} 项，收到 ${v.length} 项`);
    return v.map((item, i) => {
      try {
        return itemSchema.parse(item);
      } catch (e) {
        throw new Error(`${label}[${i}] ${e?.message ?? e}`);
      }
    });
  });
};

/**
 * 对象数组（可选）。用于权重快照、依据清单、来源清单。
 * @param label 字段名，报错时点名用
 * @param itemShape 每项的字段校验器
 * @param options.required 数组本身是否必填
 */
export const arrayOf = (label, itemShape, options = {}) => {
  const { required = false, minLength = 0 } = options;
  return makeSchema((v) => {
    if (v === undefined || v === null) {
      if (required) throw new Error(`${label} 必填`);
      return undefined;
    }
    if (!Array.isArray(v)) throw new Error(`${label} 必须是数组`);
    if (v.length < minLength) throw new Error(`${label} 至少需要 ${minLength} 项，收到 ${v.length} 项`);
    return v.map((item, i) => {
      if (!isPlainObject(item)) throw new Error(`${label}[${i}] 必须是对象`);
      const out = {};
      for (const [key, schema] of Object.entries(itemShape)) {
        out[key] = schema.parse(item[key]);
      }
      return out;
    });
  });
};

/**
 * 固定字段的记录体。**未在 shape 里声明的字段会被丢弃**，不是原样保留 ——
 * 存档要的是确定性，多出来的字段说明调用方与 schema 已经不同步了，
 * 与其默默存下去，不如让它存不进来。
 */
export const record = (shape, label = '记录') =>
  makeSchema((v) => {
    if (!isPlainObject(v)) throw new Error(`${label} 必须是对象`);
    const out = {};
    for (const [key, schema] of Object.entries(shape)) {
      const parsed = schema.parse(v[key]);
      if (parsed !== undefined) out[key] = parsed;
    }
    return out;
  });

/**
 * 声明一张表。等价于官方 `domainTable`（就是包一层 `valueSchema`）。
 */
export const domainTable = (schema) => ({ valueSchema: schema });

/** 官方 dsh-storage/lib/index.js:80 的同一份规则。 */
export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 声明一个 domain。等价于官方 `defineDomain` —— 该校验的地方一处不少，
 * 但**不依赖官方包的实例**。校验失败在模块加载期就炸，而不是等到落盘。
 */
export function defineDomain(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new Error(`domain 名 '${spec.name}' 必须匹配 ${UNIT_NAME_RE}`);
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' 的 version 必须是非负整数，收到 ${spec.version}`);
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new Error(`domain '${spec.name}' 的表名 '${table}' 必须匹配 ${UNIT_NAME_RE}`);
    }
  }
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
    throw new Error(`domain '${spec.name}' 的 global schema 不能接受 null：null 是介质的"从未写入"哨兵，存进去的 null 无法往返`);
  }
  return spec;
}
