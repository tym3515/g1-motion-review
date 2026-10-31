import type { Analysis, Rules } from './analysis.js';
import { G1_JOINTS } from './joints.js';

const DEG = 180 / Math.PI;

export function formatTime(s: number): string {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
}

const VERDICT_TEXT = { pass: '通过', pass_near_limit: '通过，有贴近限位', fail: '未通过' } as const;

/** 纯文本审核报告，适合贴到工单或聊天里。 */
export function buildReport(opts: {
  clipName: string;
  clipId: string;
  fps: number;
  analysis: Analysis;
  rules: Rules;
  injected: boolean;
  maxSegments?: number;
}): string {
  const { analysis: A, rules, fps } = opts;
  const dur = A.frameCount > 1 ? (A.frameCount - 1) / fps : 0;
  const L: string[] = [];
  L.push('G1 动作审核报告');
  L.push(`动作：${opts.clipName}（${opts.clipId}），${A.frameCount.toLocaleString('zh-CN')} 帧 @ ${fps} fps，${dur.toFixed(1)} s`);
  L.push(`规则：位置按 URDF 限位；安全余量 ${(rules.marginRad * DEG).toFixed(0)}°；速度上限 = URDF velocity × ${Math.round(rules.velocityFactor * 100)}%${opts.injected ? '；已叠加测试偏差' : ''}`);
  L.push(`结论：${VERDICT_TEXT[A.verdict]}${A.segments.length ? `，${A.segments.length} 段超限` : ''}`);
  L.push(`位置超限 ${A.overFrames} 帧 · 速度超限 ${A.velocityFrames} 帧 · 贴近限位 ${A.nearFrames} 帧`);
  const max = opts.maxSegments ?? 50;
  if (A.segments.length) {
    L.push('', '问题段：');
    A.segments.slice(0, max).forEach((s, i) => {
      const parts = s.hits.slice(0, 4).map((h) => {
        const k: string[] = [];
        if (h.positionExcess) k.push(`越限 ${(h.positionExcess * DEG).toFixed(1)}°`);
        if (h.peakVelocity) k.push(`${h.peakVelocity.toFixed(1)} rad/s（上限 ${h.velocityLimit.toFixed(1)}）`);
        return `${G1_JOINTS[h.joint]?.zh ?? h.joint} ${G1_JOINTS[h.joint]?.name ?? ''} ${k.join('，')}`;
      });
      if (s.hits.length > 4) parts.push(`另 ${s.hits.length - 4} 个关节`);
      L.push(`${String(i + 1).padStart(3, ' ')}. ${formatTime(s.startFrame / fps)}–${formatTime(s.endFrame / fps)}  ${parts.join('；')}`);
    });
    if (A.segments.length > max) L.push(`…… 另有 ${A.segments.length - max} 段`);
  }
  return L.join('\n');
}
