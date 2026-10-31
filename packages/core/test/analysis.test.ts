import { describe, expect, it } from 'vitest';
import {
  analyze,
  computeVelocity,
  groupSeverity,
  POS_NEAR,
  POS_OVER,
  VEL_BAD,
  type Limit,
  type Trajectory,
} from '../src/index.js';

const lim = (name: string, lower: number, upper: number, velocity: number): Limit => ({ name, lower, upper, velocity, effort: 0 });

/**
 * 两个关节、10 帧、10 fps 的手工轨迹：
 * - a 在第 2、4 帧贴近上限，第 3 帧越过上限 0.2
 * - b 在第 6 帧从 0 跳到 1.5，中心差分在第 5、6 帧得到 7.5 rad/s，超过 10 × 0.5 = 5 rad/s
 */
function fixture(): { tr: Trajectory; limits: Limit[] } {
  const a = [0, 0.4, 0.95, 1.2, 0.95, 0.5, 0, 0, 0, 0];
  const b = [0, 0, 0, 0, 0, 0, 1.5, 1.5, 1.5, 1.5];
  const q = new Float32Array(20);
  a.forEach((v, f) => { q[f * 2] = v; q[f * 2 + 1] = b[f]; });
  return {
    tr: { fps: 10, frameCount: 10, jointNames: ['a', 'b'], q, root: null, events: [] },
    limits: [lim('a', -1, 1, 10), lim('b', -5, 5, 10)],
  };
}

describe('computeVelocity', () => {
  it('内部帧用中心差分，首尾帧用单侧差分', () => {
    const q = new Float32Array([0, 1, 3, 6]);
    const v = computeVelocity(q, 4, 1, 10);
    expect(Array.from(v)).toEqual([10, 15, 25, 30]);
  });
});

describe('analyze', () => {
  it('分别统计位置超限、速度超限和贴近限位的帧', () => {
    const { tr, limits } = fixture();
    const r = analyze(tr, limits, { marginRad: 0.1, velocityFactor: 0.5 });
    expect(r.overFrames).toBe(1);
    expect(r.velocityFrames).toBe(2);
    expect(r.nearFrames).toBe(2);
    expect(r.verdict).toBe('fail');
    expect(r.status[3 * 2 + 0] & 3).toBe(POS_OVER);
    expect(r.status[2 * 2 + 0] & 3).toBe(POS_NEAR);
    expect(r.status[5 * 2 + 1] & VEL_BAD).toBe(VEL_BAD);
    expect(r.status[7 * 2 + 1]).toBe(0);
    expect(r.joints[0]).toEqual({ overFrames: 1, nearFrames: 2, velocityFrames: 0 });
    expect(r.joints[1]).toEqual({ overFrames: 0, nearFrames: 0, velocityFrames: 2 });
  });

  it('间隔不超过 3 帧的超限帧合并成一段，位置越限的关节排在前面', () => {
    const { tr, limits } = fixture();
    const r = analyze(tr, limits, { marginRad: 0.1, velocityFactor: 0.5 });
    expect(r.segments).toHaveLength(1);
    const [s] = r.segments;
    expect([s.startFrame, s.endFrame]).toEqual([3, 6]);
    expect(s.hits.map((h) => h.joint)).toEqual([0, 1]);
    expect(s.hits[0].positionExcess).toBeCloseTo(0.2, 5);
    expect(s.hits[1].peakVelocity).toBeCloseTo(7.5, 5);
    expect(s.hits[1].velocityLimit).toBe(5);
  });

  it('放宽规则后只剩贴近限位，结论变为有条件通过', () => {
    const { tr } = fixture();
    const wide = [lim('a', -1.5, 1.5, 100), lim('b', -5, 5, 100)];
    const r = analyze(tr, wide, { marginRad: 0.4, velocityFactor: 1 });
    expect(r.verdict).toBe('pass_near_limit');
    expect(r.segments).toHaveLength(0);
    const r2 = analyze(tr, wide, { marginRad: 0, velocityFactor: 1 });
    expect(r2.verdict).toBe('pass');
  });

  it('正好停在限位上不算超限', () => {
    const tr: Trajectory = { fps: 30, frameCount: 3, jointNames: ['a'], q: new Float32Array([1, 1, 1]), root: null, events: [] };
    const r = analyze(tr, [lim('a', -1, 1, 10)], { marginRad: 0, velocityFactor: 1 });
    expect(r.overFrames).toBe(0);
  });

  it('限位数量和关节数不一致时报错', () => {
    const { tr } = fixture();
    expect(() => analyze(tr, [lim('a', -1, 1, 1)], { marginRad: 0, velocityFactor: 1 })).toThrow();
  });
});

describe('groupSeverity', () => {
  it('每个身体部位取组内最严重的关节', () => {
    // 29 个关节、1 帧：左膝（下标 3，左腿）贴近，右肘（下标 25，右臂）速度超限
    const status = new Uint8Array(29);
    status[3] = POS_NEAR;
    status[25] = VEL_BAD;
    const g = groupSeverity(status, 1, 29);
    expect(Array.from(g)).toEqual([1, 0, 0, 0, 2]);
  });
});
