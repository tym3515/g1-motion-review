import { G1_JOINT_NAMES, JOINT_INDEX, LAFAN_COLUMNS } from './joints.js';

/** 时间轴事件，与表情屏联调台的消息同构：{"t":1.5,"type":"face","name":"happy"}。 */
export interface TimelineEvent {
  t: number;
  type: string;
  name?: string;
  [extra: string]: unknown;
}

/**
 * 内存里的轨迹。关节角按帧展开存成一块 Float32Array：
 * 第 f 帧第 j 个关节在 q[f * jointNames.length + j]。
 */
export interface Trajectory {
  fps: number;
  frameCount: number;
  jointNames: string[];
  /** 弧度 */
  q: Float32Array;
  /** 每帧 7 个数：x y z qx qy qz qw；没有根节点轨迹时为 null */
  root: Float32Array | null;
  events: TimelineEvent[];
}

export const duration = (t: Pick<Trajectory, 'fps' | 'frameCount'>) => (t.frameCount > 1 ? (t.frameCount - 1) / t.fps : 0);

// ---------- 字节与 base64 ----------

/** Float32Array 转成小端字节（proto 的 bytes 字段）。复制一份，保证偏移对齐。 */
export function f32ToBytes(a: Float32Array): Uint8Array {
  const out = new Uint8Array(a.byteLength);
  out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return out;
}

/** proto 的 bytes 字段转回 Float32Array。bytes 的偏移可能不是 4 的倍数，所以先复制。 */
export function bytesToF32(b: Uint8Array): Float32Array {
  if (b.byteLength % 4 !== 0) throw new Error(`字节数 ${b.byteLength} 不是 4 的倍数`);
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- LAFAN1 格式 ----------

/**
 * 宇树 LAFAN1 重定向数据集的一帧是 36 个数：根节点 x y z qx qy qz qw，然后 29 个关节角。
 * 这里把按帧展开的 36 列数据拆成根节点和关节两块。
 */
export function fromLafanColumns(data: Float32Array, fps: number): Trajectory {
  const cols = LAFAN_COLUMNS;
  if (data.length % cols !== 0) throw new Error(`数据长度 ${data.length} 不是 ${cols} 的倍数`);
  const n = data.length / cols;
  const nj = cols - 7;
  const q = new Float32Array(n * nj);
  const root = new Float32Array(n * 7);
  for (let f = 0; f < n; f++) {
    const o = f * cols;
    root.set(data.subarray(o, o + 7), f * 7);
    q.set(data.subarray(o + 7, o + cols), f * nj);
  }
  return { fps, frameCount: n, jointNames: [...G1_JOINT_NAMES], q, root, events: [] };
}

// ---------- 导入：CSV 与 JSON ----------

export class ImportError extends Error {}

/** CSV 每行 36 列（根节点 7 + 关节 29）或 29 列（只有关节），弧度，可以有表头。 */
export function parseCsv(text: string, fps = 30): Trajectory {
  const rows: number[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/[,\s;]+/).filter(Boolean).map(Number);
    if (cells.some(Number.isNaN)) {
      if (rows.length === 0) continue; // 表头
      throw new ImportError(`第 ${rows.length + 1} 行含非数字内容`);
    }
    rows.push(cells);
  }
  if (rows.length === 0) throw new ImportError('没有读到数据行');
  const cols = rows[0].length;
  if (cols !== LAFAN_COLUMNS && cols !== G1_JOINT_NAMES.length) {
    throw new ImportError(`每行有 ${cols} 列，需要 ${LAFAN_COLUMNS} 列（根节点 7 + 关节 29）或 ${G1_JOINT_NAMES.length} 列（只含关节）`);
  }
  const nj = G1_JOINT_NAMES.length;
  const n = rows.length;
  const q = new Float32Array(n * nj);
  const root = cols === LAFAN_COLUMNS ? new Float32Array(n * 7) : null;
  const off = root ? 7 : 0;
  rows.forEach((r, f) => {
    if (r.length !== cols) throw new ImportError(`第 ${f + 1} 行列数不一致`);
    if (root) for (let k = 0; k < 7; k++) root[f * 7 + k] = r[k];
    for (let jj = 0; jj < nj; jj++) q[f * nj + jj] = r[off + jj];
  });
  return { fps, frameCount: n, jointNames: [...G1_JOINT_NAMES], q, root, events: [] };
}

export function normEvents(list: unknown): TimelineEvent[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e): e is TimelineEvent => !!e && typeof e === 'object' && typeof (e as TimelineEvent).t === 'number' && Number.isFinite((e as TimelineEvent).t) && typeof (e as TimelineEvent).type === 'string')
    .sort((a, b) => a.t - b.t);
}

export type JsonImport = { kind: 'trajectory'; trajectory: Trajectory } | { kind: 'events'; events: TimelineEvent[] };

/**
 * JSON：{"fps":30,"joints":[关节名],"frames":[[…]],"root":[[…]],"events":[…]}。
 * joints 省略时按 G1 默认顺序；只有 events 时返回事件，叠加到当前动作上。
 * 关节名按名字对齐，JSON 里多出的关节忽略，缺的关节取 0。
 */
export function parseJson(text: string): JsonImport {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ImportError(`JSON 格式错误：${(e as Error).message}`);
  }
  const fps = Number(d.fps) || 30;
  const names = Array.isArray(d.joints) ? (d.joints as string[]) : [...G1_JOINT_NAMES];
  const events = normEvents(d.events);
  let frames = d.frames as unknown;
  if (!Array.isArray(frames)) {
    if (events.length) return { kind: 'events', events };
    throw new ImportError('JSON 里缺少 frames 数组');
  }
  if (typeof frames[0] === 'number') {
    const k = names.length;
    const flat = frames as number[];
    const out: number[][] = [];
    for (let i = 0; i + k <= flat.length; i += k) out.push(flat.slice(i, i + k));
    frames = out;
  }
  const rows = frames as number[][];
  const map = names.map((nm) => JOINT_INDEX.get(nm) ?? -1);
  if (!map.some((x) => x >= 0)) throw new ImportError('joints 里的关节名和 G1 的 URDF 对不上');
  const nj = G1_JOINT_NAMES.length;
  const n = rows.length;
  const q = new Float32Array(n * nj);
  rows.forEach((r, f) => map.forEach((jj, k) => { if (jj >= 0) q[f * nj + jj] = Number(r[k]) || 0; }));
  let root: Float32Array | null = null;
  if (Array.isArray(d.root) && d.root.length === n) {
    root = new Float32Array(n * 7);
    (d.root as number[][]).forEach((r, f) => { for (let k = 0; k < 7; k++) root![f * 7 + k] = Number(r[k]) || 0; });
  }
  return { kind: 'trajectory', trajectory: { fps, frameCount: n, jointNames: [...G1_JOINT_NAMES], q, root, events } };
}

// ---------- 采样 ----------

/** 在时间 t（秒）处线性插值关节角，写入 out。t 超出范围时取首尾帧。 */
export function sampleJoints(tr: Trajectory, t: number, out: Float32Array | Float64Array): void {
  const nj = tr.jointNames.length;
  const x = Math.max(0, Math.min(tr.frameCount - 1, t * tr.fps));
  const f0 = Math.floor(x), f1 = Math.min(tr.frameCount - 1, f0 + 1), a = x - f0;
  const o0 = f0 * nj, o1 = f1 * nj;
  for (let j = 0; j < nj; j++) out[j] = tr.q[o0 + j] * (1 - a) + tr.q[o1 + j] * a;
}

/** 在时间 t 处插值根节点位姿；四元数用归一化线性插值，相邻帧夹角很小，误差可以忽略。 */
export function sampleRoot(tr: Trajectory, t: number, out: Float32Array | Float64Array): boolean {
  if (!tr.root) return false;
  const x = Math.max(0, Math.min(tr.frameCount - 1, t * tr.fps));
  const f0 = Math.floor(x), f1 = Math.min(tr.frameCount - 1, f0 + 1), a = x - f0;
  const r = tr.root, o0 = f0 * 7, o1 = f1 * 7;
  for (let k = 0; k < 3; k++) out[k] = r[o0 + k] * (1 - a) + r[o1 + k] * a;
  const dot = r[o0 + 3] * r[o1 + 3] + r[o0 + 4] * r[o1 + 4] + r[o0 + 5] * r[o1 + 5] + r[o0 + 6] * r[o1 + 6];
  const s = dot < 0 ? -1 : 1; // 走短弧
  let len = 0;
  for (let k = 3; k < 7; k++) { out[k] = r[o0 + k] * (1 - a) + s * r[o1 + k] * a; len += out[k] * out[k]; }
  len = Math.sqrt(len) || 1;
  for (let k = 3; k < 7; k++) out[k] /= len;
  return true;
}
