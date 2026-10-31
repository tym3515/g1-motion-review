import type { Limit } from './limits.js';

export interface TrackerModel {
  /** 跟踪带宽，Hz */
  bandwidthHz: number;
  /** 指令到执行的延迟，毫秒 */
  latencyMs: number;
  /** 编码器噪声标准差，度 */
  noiseDeg: number;
  /** 实际角度不越过 URDF 限位 */
  enforceLimits: boolean;
  /** 实际角速度上限 = URDF velocity × 该系数；0 表示不限制 */
  velocityFactor: number;
}

export const DEFAULT_TRACKER: TrackerModel = {
  bandwidthHz: 6,
  latencyMs: 40,
  noiseDeg: 0.15,
  enforceLimits: true,
  velocityFactor: 0.5,
};

/** 可复现的伪随机数（mulberry32）加 Box–Muller 正态分布，测试里结果固定。 */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(uniform(), 1e-12), v = uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { uniform, normal };
}

/**
 * 一阶跟踪模型，用来模拟真机跟踪规划轨迹：
 * 期望速度 = 误差 × 2π × 带宽，再按速度上限截断、按限位截断。
 * 规划轨迹超限或太快的地方，实际角度跟不上，跟踪误差就在那里变大。
 */
export class Tracker {
  readonly q: Float64Array;
  readonly v: Float64Array;
  private readonly rng: ReturnType<typeof createRng>;

  constructor(private readonly limits: readonly Limit[], private readonly model: TrackerModel, seed = 1) {
    this.q = new Float64Array(limits.length);
    this.v = new Float64Array(limits.length);
    this.rng = createRng(seed);
  }

  reset(q0: ArrayLike<number>): void {
    for (let j = 0; j < this.q.length; j++) { this.q[j] = this.clampPos(j, q0[j]); this.v[j] = 0; }
  }

  step(target: ArrayLike<number>, dt: number): void {
    const k = 2 * Math.PI * this.model.bandwidthHz;
    // 步长太大时一阶模型会过冲，把增益限制在 1/dt 以内
    const gain = Math.min(k, 1 / Math.max(dt, 1e-6));
    for (let j = 0; j < this.q.length; j++) {
      let v = (target[j] - this.q[j]) * gain;
      if (this.model.velocityFactor > 0) {
        const vmax = this.limits[j].velocity * this.model.velocityFactor;
        v = Math.max(-vmax, Math.min(vmax, v));
      }
      const next = this.clampPos(j, this.q[j] + v * dt);
      this.v[j] = (next - this.q[j]) / dt;
      this.q[j] = next;
    }
  }

  /** 带测量噪声的读数，写入 out。 */
  measure(out: Float64Array | number[]): void {
    const sigma = (this.model.noiseDeg * Math.PI) / 180;
    for (let j = 0; j < this.q.length; j++) out[j] = this.q[j] + (sigma > 0 ? this.rng.normal() * sigma : 0);
  }

  private clampPos(j: number, x: number): number {
    if (!this.model.enforceLimits) return x;
    const { lower, upper } = this.limits[j];
    return Math.max(lower, Math.min(upper, x));
  }
}

/** 实际与规划之间的跟踪误差统计，弧度。 */
export function trackingError(plan: ArrayLike<number>, actual: ArrayLike<number>): { rms: number; max: number; maxJoint: number } {
  let s = 0, max = 0, maxJoint = -1;
  const n = plan.length;
  for (let j = 0; j < n; j++) {
    const e = Math.abs(actual[j] - plan[j]);
    s += e * e;
    if (e > max) { max = e; maxJoint = j; }
  }
  return { rms: Math.sqrt(s / Math.max(1, n)), max, maxJoint };
}
