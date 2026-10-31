import { G1_JOINTS, GROUPS, JOINT_GROUP_INDEX, severity } from '@g1/core';
import { useReview } from '../store/review';
import { useLive } from '../store/live';
import { useThrottledTime } from '../lib/hooks';
import { DEG, fmtN, toDeg } from '../lib/format';

export function Summary() {
  const a = useReview((s) => s.analysis);
  const fps = useReview((s) => s.planned?.fps ?? 30);
  const timing = useReview((s) => s.timing);
  const analyzing = useReview((s) => s.analyzing);
  const backend = useReview((s) => s.backend);
  const cell = (label: string, n: number, cls: 'bad' | 'warn') => (
    <div className={`stat ${cls}${n === 0 ? ' zero' : ''}`}>
      <b>{fmtN(n)}</b>
      <span>{label}</span>
      <small>{(n / fps).toFixed(1)} s</small>
    </div>
  );
  return (
    <>
      <div className="summary">
        {cell('位置超限', a?.overFrames ?? 0, 'bad')}
        {cell('速度超限', a?.velocityFrames ?? 0, 'bad')}
        {cell('贴近限位', a?.nearFrames ?? 0, 'warn')}
      </div>
      <div className="timing mono" aria-live="polite">
        {analyzing ? <span className="busy">Analyze 调用中…</span> : timing ? (
          <>
            <span>Analyze 服务端 {timing.server.toFixed(1)} ms</span>
            <span>往返 {timing.roundTrip.toFixed(1)} ms</span>
            <span>经 {backend.kind === 'worker' ? 'Web Worker' : backend.kind === 'connect' ? 'Connect' : 'gRPC-Web'}</span>
          </>
        ) : <span>—</span>}
      </div>
    </>
  );
}

export function RulesPanel() {
  const rules = useReview((s) => s.rules);
  const inject = useReview((s) => s.inject);
  const setRules = useReview((s) => s.setRules);
  const setInject = useReview((s) => s.setInject);
  const margin = Math.round(toDeg(rules.marginRad));
  const vfac = Math.round(rules.velocityFactor * 100);
  return (
    <div className="rules">
      <div className="rule">
        <label htmlFor="margin">安全余量</label>
        <input type="range" id="margin" min={0} max={15} step={1} value={margin} onChange={(e) => setRules({ marginRad: Number(e.target.value) * DEG })} />
        <output htmlFor="margin">{margin}°</output>
      </div>
      <div className="rule">
        <label htmlFor="vfac">速度上限</label>
        <input type="range" id="vfac" min={20} max={100} step={5} value={vfac} onChange={(e) => setRules({ velocityFactor: Number(e.target.value) / 100 })} />
        <output htmlFor="vfac">{vfac}%</output>
      </div>
      <label className="chk" htmlFor="inject">
        <input type="checkbox" id="inject" checked={inject} onChange={(e) => setInject(e.target.checked)} /> 叠加测试偏差：让踝、肘、腰各越限 6–10°
      </label>
      <p className="note">位置按 URDF 限位判定，距限位小于安全余量记为贴近。速度上限取 URDF velocity 乘以百分比。规则每次变化都会重新调用 Analyze，数字为帧数。</p>
    </div>
  );
}

export function JointList() {
  const t = useThrottledTime(15);
  const planned = useReview((s) => s.planned);
  const limits = useReview((s) => s.limits);
  const a = useReview((s) => s.analysis);
  const sel = useReview((s) => s.sel);
  const select = useReview((s) => s.select);
  const margin = useReview((s) => s.rules.marginRad);
  // 实际状态跟着节流后的时间一起刷新，不单独订阅 50 Hz 的数据流
  useLive((s) => s.latest !== null);
  const latest = useLive.getState().latest;
  if (!planned || !limits) return <div className="joints" />;
  const nj = planned.jointNames.length;
  const f = Math.max(0, Math.min(planned.frameCount - 1, Math.floor(t * planned.fps + 1e-6)));
  const st = a && a.frameCount === planned.frameCount ? a.status : null;

  return (
    <div className="joints" role="list" aria-label="关节">
      {GROUPS.map((g, gi) => {
        let bad = 0, near = 0;
        G1_JOINTS.forEach((_, j) => {
          if (JOINT_GROUP_INDEX[j] !== gi || !a) return;
          bad += a.joints[j].overFrames + a.joints[j].velocityFrames;
          near += a.joints[j].nearFrames;
        });
        return (
          <div key={g.id} role="group" aria-label={g.zh}>
            <div className="jgh">
              <span>{g.zh}</span>
              <span className={`jgs ${bad ? 'bad' : near ? 'warn' : ''}`}>{bad ? `超限 ${fmtN(bad)}` : near ? `贴限 ${fmtN(near)}` : '正常'}</span>
            </div>
            {G1_JOINTS.map((jt, j) => {
              if (JOINT_GROUP_INDEX[j] !== gi) return null;
              const { lower, upper } = limits[j];
              const x = planned.q[f * nj + j];
              const pos = (v: number) => `${(Math.max(-0.04, Math.min(1.04, (v - lower) / (upper - lower))) * 100).toFixed(2)}%`;
              const s = st ? st[f * nj + j] : 0;
              const sev = severity(s);
              const c = a?.joints[j];
              const badN = c ? c.overFrames + c.velocityFrames : 0;
              const pct = `${Math.min(50, (margin / (upper - lower)) * 100)}%`;
              return (
                <button
                  key={jt.name}
                  type="button"
                  role="listitem"
                  className={`jrow s${sev}${j === sel ? ' sel' : ''}`}
                  onClick={() => select(j)}
                  aria-pressed={j === sel}
                >
                  <i className="dot" />
                  <span className="jn">
                    {jt.zh}
                    <small>{jt.name.replace(/_joint$/, '')}</small>
                  </span>
                  <span className="jb">
                    <i className="sl" style={{ width: pct }} />
                    <i className="sr" style={{ width: pct }} />
                    {latest && <i className="ak" style={{ left: pos(latest[j]) }} title="实际" />}
                    <i className="mk" style={{ left: pos(x) }} />
                  </span>
                  <span className="jv mono">{toDeg(x).toFixed(1)}°</span>
                  <span
                    className={`jc mono ${badN ? 'bad' : c?.nearFrames ? 'warn' : ''}`}
                    title={c ? (badN ? `超限 ${badN} 帧（位置 ${c.overFrames}，速度 ${c.velocityFrames}）` : c.nearFrames ? `贴近限位 ${c.nearFrames} 帧` : '') : ''}
                  >
                    {badN ? fmtN(badN) : c?.nearFrames ? fmtN(c.nearFrames) : ''}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
