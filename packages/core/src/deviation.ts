import type { Limit } from './limits.js';
import type { Trajectory } from './trajectory.js';

/** 测试偏差：在三个关节上各叠加一个 3 秒宽的平滑鼓包，让它们越过限位。 */
export const TEST_DEVIATIONS: ReadonlyArray<{ joint: string; overRad: number; at: number }> = [
  { joint: 'left_ankle_roll_joint', overRad: (6 * Math.PI) / 180, at: 0.22 },
  { joint: 'right_elbow_joint', overRad: (10 * Math.PI) / 180, at: 0.5 },
  { joint: 'waist_pitch_joint', overRad: (8 * Math.PI) / 180, at: 0.78 },
];

/**
 * 返回一条叠加了测试偏差的新轨迹，原轨迹不变。
 * 鼓包中心在动作时长的 at 处，往更近的那一侧限位推，峰值越限 overRad。
 * 用来验证"超限高亮"这条链路是通的：重定向数据集本身已经把角度卡在限位内了。
 */
export function injectTestDeviation(tr: Trajectory, limits: readonly Limit[]): Trajectory {
  const nj = tr.jointNames.length, n = tr.frameCount;
  const q = tr.q.slice();
  const half = Math.round(1.5 * tr.fps);
  for (const d of TEST_DEVIATIONS) {
    const j = tr.jointNames.indexOf(d.joint);
    if (j < 0) continue;
    const fc = Math.min(n - 1, Math.round(d.at * n));
    const v = tr.q[fc * nj + j];
    const { lower, upper } = limits[j];
    const up = upper - v <= v - lower;
    const amp = up ? upper - v + d.overRad : -(v - lower + d.overRad);
    for (let f = Math.max(0, fc - half); f <= Math.min(n - 1, fc + half); f++) {
      const x = (f - fc) / half;
      q[f * nj + j] += amp * Math.cos((x * Math.PI) / 2) ** 2;
    }
  }
  return { ...tr, q };
}
