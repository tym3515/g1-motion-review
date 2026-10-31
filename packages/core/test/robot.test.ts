import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyze,
  base64ToBytes,
  bytesToF32,
  DEFAULT_RULES,
  fromLafanColumns,
  G1_JOINT_NAMES,
  injectTestDeviation,
  orderLimits,
  parseUrdfLimits,
  Tracker,
  trackingError,
} from '../src/index.js';

const data = (p: string) => fileURLToPath(new URL(`../../../apps/web/public/data/${p}`, import.meta.url));
const urdf = readFileSync(data('g1/g1_29dof_rev_1_0.urdf.xml'), 'utf8');
const robot = parseUrdfLimits(urdf);
const limits = orderLimits(robot, G1_JOINT_NAMES);

describe('URDF 限位', () => {
  it('读出 G1 的 29 个旋转关节', () => {
    expect(robot.robotName).toBe('g1_29dof_rev_1_0');
    expect(robot.joints.size).toBe(29);
    const knee = robot.joints.get('left_knee_joint')!;
    expect(knee.lower).toBeCloseTo(-0.087267, 6);
    expect(knee.upper).toBeCloseTo(2.8798, 6);
    expect(knee.velocity).toBe(20);
  });

  it('关节缺失时直接报错', () => {
    expect(() => orderLimits(robot, ['no_such_joint'])).toThrow(/找不到/);
  });
});

describe('测试偏差', () => {
  it('只让三个指定关节越限，其余关节不变', () => {
    const raw = bytesToF32(base64ToBytes(readFileSync(data('motions/dance1_subject2.f32.txt'), 'utf8')));
    const tr = fromLafanColumns(raw, 30);
    const before = analyze(tr, limits, DEFAULT_RULES);
    const after = analyze(injectTestDeviation(tr, limits), limits, DEFAULT_RULES);
    expect(before.overFrames).toBe(0);
    const overJoints = after.joints.map((j, i) => (j.overFrames ? G1_JOINT_NAMES[i] : null)).filter(Boolean);
    expect(overJoints.sort()).toEqual(['left_ankle_roll_joint', 'right_elbow_joint', 'waist_pitch_joint']);
  });
});

describe('跟踪模型', () => {
  const model = { bandwidthHz: 6, latencyMs: 0, noiseDeg: 0, enforceLimits: true, velocityFactor: 0.5 };

  it('目标在限位外时，实际角度停在限位上', () => {
    const t = new Tracker(limits, model);
    t.reset(new Float64Array(29));
    const target = new Float64Array(29).fill(10);
    for (let i = 0; i < 500; i++) t.step(target, 0.01);
    limits.forEach((l, j) => expect(t.q[j]).toBeCloseTo(l.upper, 6));
  });

  it('角速度不超过 URDF velocity × 系数', () => {
    const t = new Tracker(limits, { ...model, enforceLimits: false });
    t.reset(new Float64Array(29));
    t.step(new Float64Array(29).fill(1), 0.01);
    limits.forEach((l, j) => expect(Math.abs(t.v[j])).toBeLessThanOrEqual(l.velocity * 0.5 + 1e-9));
  });

  it('目标可达时误差收敛到零附近', () => {
    const t = new Tracker(limits, model);
    t.reset(new Float64Array(29));
    const target = new Float64Array(29).fill(0.1);
    for (let i = 0; i < 200; i++) t.step(target, 0.01);
    expect(trackingError(target, t.q).max).toBeLessThan(1e-6);
  });
});
