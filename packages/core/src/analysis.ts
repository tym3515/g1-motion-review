import type { Limit } from './limits.js';
import type { Trajectory } from './trajectory.js';
import { JOINT_GROUP_INDEX, GROUPS } from './joints.js';

export interface Rules {
  /** 安全余量，弧度 */
  marginRad: number;
  /** 速度上限 = URDF velocity × velocityFactor */
  velocityFactor: number;
}

export const DEFAULT_RULES: Rules = { marginRad: (5 * Math.PI) / 180, velocityFactor: 0.5 };

/** 逐帧状态字节：低 2 位是位置状态，第 3 位是速度超限。与 proto 里 frame_status 的约定一致。 */
export const POS_OK = 0;
export const POS_NEAR = 1;
export const POS_OVER = 2;
export const VEL_BAD = 4;
export const posOf = (s: number) => s & 3;
export const isBad = (s: number) => (s & 3) === POS_OVER || (s & VEL_BAD) !== 0;
/** 渲染用的严重程度：0 正常，1 贴近，2 超限（位置或速度）。 */
export const severity = (s: number) => (isBad(s) ? 2 : (s & 3) === POS_NEAR ? 1 : 0);

export type Verdict = 'pass' | 'pass_near_limit' | 'fail';

export interface JointHit {
  joint: number;
  /** 最大越限量，弧度；0 表示位置没超限 */
  positionExcess: number;
  /** 段内最大角速度，弧度每秒；0 表示速度没超限 */
  peakVelocity: number;
  velocityLimit: number;
}

export interface Segment {
  startFrame: number;
  endFrame: number;
  hits: JointHit[];
}

export interface JointStats {
  overFrames: number;
  nearFrames: number;
  velocityFrames: number;
}

export interface Analysis {
  verdict: Verdict;
  frameCount: number;
  overFrames: number;
  velocityFrames: number;
  nearFrames: number;
  segments: Segment[];
  joints: JointStats[];
  /** frameCount × 关节数 */
  status: Uint8Array;
}

/** 超限帧合并成段时允许的最大间隔帧数。 */
export const SEGMENT_GAP = 3;
/** 位置判定的数值容差，弧度。重定向数据常常正好停在限位上，不算超限。 */
export const POSITION_TOLERANCE = 1e-4;

/** 中心差分求角速度（弧度每秒），首尾帧用单侧差分。 */
export function computeVelocity(q: Float32Array, frameCount: number, nj: number, fps: number): Float32Array {
  const vel = new Float32Array(frameCount * nj);
  for (let f = 0; f < frameCount; f++) {
    const a = Math.max(0, f - 1), b = Math.min(frameCount - 1, f + 1);
    const dt = (b - a) / fps || 1;
    for (let j = 0; j < nj; j++) vel[f * nj + j] = (q[b * nj + j] - q[a * nj + j]) / dt;
  }
  return vel;
}

/**
 * 逐帧检查位置和速度。limits 的顺序必须与 traj.jointNames 一致。
 * 复杂度 O(帧数 × 关节数)，7,000 帧 × 29 个关节在普通笔记本上是几毫秒。
 */
export function analyze(traj: Trajectory, limits: readonly Limit[], rules: Rules): Analysis {
  const n = traj.frameCount, nj = traj.jointNames.length, q = traj.q;
  if (limits.length !== nj) throw new Error(`限位数量 ${limits.length} 与关节数 ${nj} 不一致`);
  const vel = computeVelocity(q, n, nj, traj.fps);
  const status = new Uint8Array(n * nj);
  const joints: JointStats[] = limits.map(() => ({ overFrames: 0, nearFrames: 0, velocityFrames: 0 }));
  const frameBad = new Uint8Array(n);
  let overFrames = 0, velocityFrames = 0, nearFrames = 0;
  const m = rules.marginRad, tol = POSITION_TOLERANCE;
  for (let f = 0; f < n; f++) {
    let anyO = 0, anyV = 0, anyN = 0;
    for (let j = 0; j < nj; j++) {
      const { lower, upper, velocity } = limits[j];
      const x = q[f * nj + j];
      let s = POS_OK;
      if (x > upper + tol || x < lower - tol) s = POS_OVER;
      else if (x > upper - m || x < lower + m) s = POS_NEAR;
      if (Math.abs(vel[f * nj + j]) > velocity * rules.velocityFactor) s |= VEL_BAD;
      status[f * nj + j] = s;
      const st = joints[j];
      if ((s & 3) === POS_OVER) { st.overFrames++; anyO = 1; } else if ((s & 3) === POS_NEAR) { st.nearFrames++; anyN = 1; }
      if (s & VEL_BAD) { st.velocityFrames++; anyV = 1; }
    }
    frameBad[f] = anyO | anyV;
    overFrames += anyO; velocityFrames += anyV; nearFrames += anyN;
  }

  const segments: Segment[] = [];
  let cur: Segment | null = null;
  for (let f = 0; f < n; f++) {
    if (!frameBad[f]) continue;
    if (cur && f - cur.endFrame <= SEGMENT_GAP) cur.endFrame = f;
    else { cur = { startFrame: f, endFrame: f, hits: [] }; segments.push(cur); }
  }
  for (const s of segments) {
    const hits = new Map<number, JointHit>();
    for (let f = s.startFrame; f <= s.endFrame; f++) {
      for (let j = 0; j < nj; j++) {
        const st = status[f * nj + j];
        if (!isBad(st)) continue;
        const { lower, upper, velocity } = limits[j];
        const h = hits.get(j) ?? { joint: j, positionExcess: 0, peakVelocity: 0, velocityLimit: velocity * rules.velocityFactor };
        if ((st & 3) === POS_OVER) {
          const x = q[f * nj + j];
          h.positionExcess = Math.max(h.positionExcess, x > upper ? x - upper : lower - x);
        }
        if (st & VEL_BAD) h.peakVelocity = Math.max(h.peakVelocity, Math.abs(vel[f * nj + j]));
        hits.set(j, h);
      }
    }
    s.hits = [...hits.values()].sort((a, b) => b.positionExcess - a.positionExcess || b.peakVelocity / b.velocityLimit - a.peakVelocity / a.velocityLimit);
  }

  const verdict: Verdict = segments.length ? 'fail' : nearFrames ? 'pass_near_limit' : 'pass';
  return { verdict, frameCount: n, overFrames, velocityFrames, nearFrames, segments, joints, status };
}

/** 把逐关节状态汇总成按身体部位的最严重程度，时间轴用。返回 frameCount × GROUPS.length。 */
export function groupSeverity(status: Uint8Array, frameCount: number, nj: number): Uint8Array {
  const ng = GROUPS.length;
  const out = new Uint8Array(frameCount * ng);
  for (let f = 0; f < frameCount; f++) {
    for (let j = 0; j < nj; j++) {
      const s = severity(status[f * nj + j]);
      const k = f * ng + JOINT_GROUP_INDEX[j];
      if (s > out[k]) out[k] = s;
    }
  }
  return out;
}
