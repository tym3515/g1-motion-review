import { useEffect, useRef, useState } from 'react';
import { buildReport, G1_JOINTS, GROUPS, duration, POS_OVER, VEL_BAD } from '@g1/core';
import { useReview } from '../store/review';
import { usePlayback } from '../store/playback';
import { samples, useLive } from '../store/live';
import { useThrottledTime, createDrawScheduler } from '../lib/hooks';
import { fitCanvas, formatTime, niceStep, toDeg } from '../lib/format';
import { getColors, onColors } from '../lib/theme';

const NJ = G1_JOINTS.length;

/** 跳到上一处或下一处问题段，并选中该段最严重的关节。 */
export function jumpIssue(dir: 1 | -1) {
  const { analysis: a, planned, select } = useReview.getState();
  if (!a || !planned || !a.segments.length) return;
  const pb = usePlayback.getState();
  const f = Math.floor(pb.t * planned.fps + 1e-6);
  const s = dir > 0 ? a.segments.find((x) => x.startFrame > f) ?? a.segments[0] : [...a.segments].reverse().find((x) => x.startFrame < f - 1) ?? a.segments[a.segments.length - 1];
  pb.setPlaying(false);
  pb.setT(s.startFrame / planned.fps);
  if (s.hits.length) select(s.hits[0].joint);
}

export function stepFrame(dir: 1 | -1, seconds = false) {
  const { planned } = useReview.getState();
  if (!planned) return;
  const pb = usePlayback.getState();
  pb.setPlaying(false);
  const dur = duration(planned);
  const t = seconds ? pb.t + dir : (Math.floor(pb.t * planned.fps + 1e-6) + dir) / planned.fps;
  pb.setT(Math.max(0, Math.min(dur, t)));
}

export function togglePlay() {
  const { planned } = useReview.getState();
  if (!planned || useLive.getState().source) return;
  const pb = usePlayback.getState();
  if (!pb.playing && pb.t >= duration(planned) - 1e-6) pb.setT(0);
  pb.setPlaying(!pb.playing);
}

export function TransportBar() {
  const t = useThrottledTime(20);
  const playing = usePlayback((s) => s.playing);
  const speed = usePlayback((s) => s.speed);
  const loop = usePlayback((s) => s.loop);
  const setSpeed = usePlayback((s) => s.setSpeed);
  const setLoop = usePlayback((s) => s.setLoop);
  const planned = useReview((s) => s.planned);
  const liveBusy = useLive((s) => s.source !== null);
  const dur = planned ? duration(planned) : 0;
  return (
    <div className="transport">
      <button className="btn icon primary" type="button" aria-label={playing ? '暂停' : '播放'} onClick={togglePlay} disabled={liveBusy}>
        <svg viewBox="0 0 16 16">{playing ? <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" /> : <path d="M4 2.5v11l9-5.5z" />}</svg>
      </button>
      <button className="btn icon" type="button" aria-label="上一帧" onClick={() => stepFrame(-1)} disabled={liveBusy}>
        <svg viewBox="0 0 16 16"><path d="M3 3h2v10H3zM13 3v10L6 8z" /></svg>
      </button>
      <button className="btn icon" type="button" aria-label="下一帧" onClick={() => stepFrame(1)} disabled={liveBusy}>
        <svg viewBox="0 0 16 16"><path d="M11 3h2v10h-2zM3 3v10l7-5z" /></svg>
      </button>
      <span className="sep" />
      <button className="btn sm" type="button" onClick={() => jumpIssue(-1)} disabled={liveBusy}>上一处问题</button>
      <button className="btn sm" type="button" onClick={() => jumpIssue(1)} disabled={liveBusy}>下一处问题</button>
      <span className="sep" />
      <label className="chk" htmlFor="speed">速度</label>
      <select id="speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
        {[0.25, 0.5, 1, 2].map((v) => <option key={v} value={v}>{v}×</option>)}
      </select>
      <label className="chk"><input type="checkbox" id="loop" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> 循环</label>
      <span className="clock mono">{formatTime(t)} <span>/ {formatTime(dur)}</span></span>
      <span className="spacer" />
      <span className="keys"><kbd>空格</kbd> 播放 <kbd>←</kbd><kbd>→</kbd> 逐帧 <kbd>[</kbd><kbd>]</kbd> 跳问题</span>
    </div>
  );
}

export function LiveBar() {
  const source = useLive((s) => s.source);
  const status = useLive((s) => s.status);
  const message = useLive((s) => s.message);
  const rosUrl = useLive((s) => s.rosUrl);
  const tracker = useLive((s) => s.tracker);
  const rate = useLive((s) => s.rate);
  const start = useLive((s) => s.start);
  const stop = useLive((s) => s.stop);
  const setRosUrl = useLive((s) => s.setRosUrl);
  const setTracker = useLive((s) => s.setTracker);
  const sel = useReview((s) => s.sel);
  useThrottledTime(6);
  const stats = useLive.getState().stats;
  const num = (id: string, label: string, v: number, onChange: (x: number) => void, step = 1, unit = '') => (
    <label className="tk" htmlFor={id}>
      {label}<input id={id} type="number" value={v} step={step} min={0} onChange={(e) => onChange(Number(e.target.value))} disabled={source !== null} />{unit}
    </label>
  );
  return (
    <div className="livebar" aria-label="实时对比">
      <span className="lbl">实时对比</span>
      <button className={`btn sm live${source === 'service' ? ' on' : ''}`} type="button" onClick={() => (source === 'service' ? stop() : start('service'))} title="调用服务端流 StreamJointStates，模拟真机跟踪当前动作">
        {source === 'service' ? '停止模拟' : '模拟真机'}
      </button>
      {num('bw', '带宽', tracker.bandwidthHz, (x) => setTracker({ bandwidthHz: x }), 1, 'Hz')}
      {num('lat', '延迟', tracker.latencyMs, (x) => setTracker({ latencyMs: x }), 10, 'ms')}
      {num('noise', '噪声', tracker.noiseDeg, (x) => setTracker({ noiseDeg: x }), 0.05, '°')}
      <label className="chk"><input type="checkbox" id="enforce" checked={tracker.enforceLimits} onChange={(e) => setTracker({ enforceLimits: e.target.checked })} disabled={source !== null} /> 限位生效</label>
      <span className="sep" />
      <button className={`btn sm live${source === 'ros' ? ' on' : ''}`} type="button" onClick={() => (source === 'ros' ? stop() : start('ros'))} title="通过 rosbridge 订阅 /joint_states">
        {source === 'ros' ? '断开 ROS 2' : '连接 ROS 2'}
      </button>
      <input id="rosUrl" type="url" aria-label="rosbridge 地址" value={rosUrl} onChange={(e) => setRosUrl(e.target.value)} disabled={source !== null} />
      <span className="spacer" />
      {status === 'error' && message ? <span className="err">{message}</span> : null}
      {status === 'connecting' && <span className="stat-inline">{message ?? '连接中…'}</span>}
      {stats && status !== 'error' && (
        <span className="stat-inline">
          {status === 'streaming' && <>{rate} Hz · </>}
          {G1_JOINTS[sel].zh} 误差 RMS <b>{toDeg(stats.rms[sel]).toFixed(1)}°</b>
          {stats.peak.joint >= 0 && <> · 最大 <b>{toDeg(stats.peak.value).toFixed(1)}°</b> {G1_JOINTS[stats.peak.joint].zh} @ {formatTime(stats.peak.t)}</>}
        </span>
      )}
    </div>
  );
}

// ---------- 时间轴 ----------

const TL = { padL: 44, padR: 10, top: 4, row: 9, gap: 3 };

export function Timeline() {
  const ref = useRef<HTMLCanvasElement>(null);
  const hasEvents = useReview((s) => (s.planned?.events.length ?? 0) > 0);

  useEffect(() => {
    const cv = ref.current!;
    let base: HTMLCanvasElement | null = null;
    let baseKey: unknown[] = [];
    const draw = () => {
      const { planned, groupSev, analysis } = useReview.getState();
      if (!planned || !groupSev || !analysis || analysis.frameCount !== planned.frameCount) return;
      const resized = fitCanvas(cv);
      const C = getColors();
      const dpr = cv.width / cv.clientWidth, W = cv.clientWidth;
      const ctx = cv.getContext('2d')!;
      const dur = duration(planned);
      const x0 = TL.padL, w = W - TL.padL - TL.padR;
      const rows = GROUPS.length + (planned.events.length ? 1 : 0);
      const key = [groupSev, planned.events, C, cv.width, cv.height];
      if (!base || resized || key.some((k, i) => k !== baseKey[i])) {
        baseKey = key;
        base = document.createElement('canvas');
        base.width = cv.width; base.height = cv.height;
        const b = base.getContext('2d')!;
        b.scale(dpr, dpr);
        b.font = `11px ${getComputedStyle(document.body).fontFamily}`;
        b.textBaseline = 'middle';
        const ng = GROUPS.length, n = planned.frameCount;
        const cols = Math.max(1, Math.floor(w));
        GROUPS.forEach((g, gi) => {
          const y = TL.top + gi * (TL.row + TL.gap);
          b.fillStyle = C.muted; b.textAlign = 'right';
          b.fillText(g.zh, x0 - 8, y + TL.row / 2 + 0.5);
          b.fillStyle = C.track; b.fillRect(x0, y, w, TL.row);
          for (let c = 0; c < cols; c++) {
            const fa = Math.floor((c / cols) * n), fb = Math.max(fa + 1, Math.floor(((c + 1) / cols) * n));
            let worst = 0;
            for (let f = fa; f < fb && worst < 2; f++) worst = Math.max(worst, groupSev[f * ng + gi]);
            if (worst) { b.fillStyle = worst === 2 ? C.bad : C['warn-fill']; b.fillRect(x0 + c, y, 1.02, TL.row); }
          }
        });
        if (planned.events.length) {
          const y = TL.top + GROUPS.length * (TL.row + TL.gap);
          b.fillStyle = C.muted; b.textAlign = 'right';
          b.fillText('事件', x0 - 8, y + TL.row / 2 + 0.5);
          b.fillStyle = C.track; b.fillRect(x0, y, w, TL.row);
          for (const e of planned.events) {
            if (e.t < 0 || e.t > dur + 1e-6) continue;
            b.fillStyle = e.type === 'face' ? C.accent : C.muted;
            b.fillRect(Math.round(x0 + (e.t / (dur || 1)) * w) - 1, y - 1, 2, TL.row + 2);
          }
        }
        const step = niceStep(dur, Math.max(3, Math.floor(w / 90)));
        const yT = TL.top + rows * (TL.row + TL.gap) + 8;
        b.fillStyle = C.faint; b.textAlign = 'center';
        for (let s = 0; s <= dur + 1e-6; s += step) {
          const x = x0 + (s / (dur || 1)) * w;
          b.fillRect(x, yT - 7, 1, 3);
          b.fillText(s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`, x, yT + 3);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(base, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t = usePlayback.getState().t;
      const x = x0 + (dur ? t / dur : 0) * w;
      const hB = TL.top + rows * (TL.row + TL.gap) - TL.gap;
      ctx.fillStyle = C.accent;
      ctx.fillRect(Math.round(x) - 1, 0, 2, hB + 3);
      ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 5); ctx.closePath(); ctx.fill();
    };
    const sch = createDrawScheduler(draw);
    const u1 = usePlayback.subscribe((s, p) => { if (s.t !== p.t) sch.request(); });
    const u2 = useReview.subscribe((s, p) => { if (s.groupSev !== p.groupSev || s.planned !== p.planned) sch.request(); });
    const u3 = onColors(() => sch.request());
    const ro = new ResizeObserver(() => sch.request());
    ro.observe(cv);
    sch.request();

    const seek = (e: PointerEvent) => {
      const { planned } = useReview.getState();
      if (!planned || useLive.getState().source) return;
      const r = cv.getBoundingClientRect();
      const w = r.width - TL.padL - TL.padR;
      const pb = usePlayback.getState();
      pb.setT(Math.max(0, Math.min(duration(planned), ((e.clientX - r.left - TL.padL) / w) * duration(planned))));
    };
    const down = (e: PointerEvent) => { cv.setPointerCapture(e.pointerId); seek(e); };
    const move = (e: PointerEvent) => { if (cv.hasPointerCapture(e.pointerId)) seek(e); };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    return () => { u1(); u2(); u3(); ro.disconnect(); sch.cancel(); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); };
  }, []);

  return <canvas ref={ref} className={`tl${hasEvents ? ' ev' : ''}`} aria-label="按身体部位的问题分布，点击或拖动跳转" />;
}

// ---------- 关节曲线 ----------

const CV = { padL: 48, padR: 12, top: 10, bot: 20 };

export function CurvePanel() {
  const ref = useRef<HTMLCanvasElement>(null);
  const sel = useReview((s) => s.sel);
  const mode = useReview((s) => s.curveMode);
  const range = useReview((s) => s.curveRange);
  const setMode = useReview((s) => s.setCurveMode);
  const setRange = useReview((s) => s.setCurveRange);
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    const viewRange = (dur: number, t: number): [number, number] => {
      if (useReview.getState().curveRange === 'all' || dur <= 10) return [0, dur];
      let a = t - 5, b = t + 5;
      if (a < 0) { b -= a; a = 0; }
      if (b > dur) { a -= b - dur; b = dur; }
      return [Math.max(0, a), b];
    };
    const draw = () => {
      const { planned, analysis: A, velocity, limits, sel: j, curveMode, rules } = useReview.getState();
      if (!planned || !A || !velocity || !limits || A.frameCount !== planned.frameCount) return;
      fitCanvas(cv);
      const C = getColors();
      const dpr = cv.width / cv.clientWidth, W = cv.clientWidth, H = cv.clientHeight;
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const t = usePlayback.getState().t;
      const dur = duration(planned);
      const { lower: lo, upper: hi, velocity: vlimU } = limits[j];
      const [t0, t1] = viewRange(dur, t);
      const fps = planned.fps, n = planned.frameCount;
      const f0 = Math.max(0, Math.floor(t0 * fps)), f1 = Math.min(n - 1, Math.ceil(t1 * fps));
      const x0 = CV.padL, x1 = W - CV.padR, y0 = CV.top, y1 = H - CV.bot;
      const X = (tt: number) => x0 + ((tt - t0) / (t1 - t0 || 1)) * (x1 - x0);
      const pos = curveMode === 'pos';
      const val = (f: number) => (pos ? toDeg(planned.q[f * NJ + j]) : velocity[f * NJ + j]);
      let dmin = Infinity, dmax = -Infinity;
      for (let f = f0; f <= f1; f++) { const v = val(f); if (v < dmin) dmin = v; if (v > dmax) dmax = v; }
      // 实际曲线也要落在坐标范围内
      const live = samples.count > 0 && pos;
      if (live) for (let i = 0; i < samples.count; i++) {
        const s = samples.stamps[i]; if (s < t0 || s > t1) continue;
        const v = toDeg(samples.pos[i * NJ + j]); if (v < dmin) dmin = v; if (v > dmax) dmax = v;
      }
      const vlim = vlimU * rules.velocityFactor;
      let ymin: number, ymax: number;
      if (pos) { const L = toDeg(lo), Hh = toDeg(hi), pad = (Hh - L) * 0.08; ymin = Math.min(L, dmin) - pad; ymax = Math.max(Hh, dmax) + pad; }
      else { const m = Math.max(vlim * 1.25, Math.abs(dmin) * 1.08, Math.abs(dmax) * 1.08); ymin = -m; ymax = m; }
      const Y = (v: number) => y1 - ((v - ymin) / (ymax - ymin)) * (y1 - y0);
      const font = getComputedStyle(document.body).fontFamily;
      ctx.font = `11px ${font}`;

      if (pos) {
        const L = toDeg(lo), Hh = toDeg(hi), m = toDeg(rules.marginRad);
        ctx.fillStyle = C['bad-soft'];
        ctx.fillRect(x0, y0, x1 - x0, Math.max(0, Y(Hh) - y0));
        ctx.fillRect(x0, Y(L), x1 - x0, Math.max(0, y1 - Y(L)));
        ctx.fillStyle = C['warn-soft'];
        ctx.fillRect(x0, Y(Hh), x1 - x0, Y(Hh - m) - Y(Hh));
        ctx.fillRect(x0, Y(L + m), x1 - x0, Y(L) - Y(L + m));
      } else {
        ctx.fillStyle = C['bad-soft'];
        ctx.fillRect(x0, y0, x1 - x0, Math.max(0, Y(vlim) - y0));
        ctx.fillRect(x0, Y(-vlim), x1 - x0, Math.max(0, y1 - Y(-vlim)));
      }
      const ys = niceStep(ymax - ymin, 4);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let v = Math.ceil(ymin / ys) * ys; v <= ymax + 1e-9; v += ys) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = C['line-2']; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.fillStyle = C.faint;
        ctx.fillText(`${Math.abs(v) < 1e-9 ? 0 : +v.toFixed(ys < 1 ? 1 : 0)}${pos ? '°' : ''}`, x0 - 6, y);
      }
      const xs = niceStep(t1 - t0, Math.max(3, Math.floor((x1 - x0) / 90)));
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = C.faint;
      for (let tt = Math.ceil(t0 / xs) * xs; tt <= t1 + 1e-9; tt += xs) ctx.fillText(`${+tt.toFixed(xs < 1 ? 1 : 0)}s`, X(tt), y1 + 5);

      ctx.setLineDash([4, 3]); ctx.lineWidth = 1; ctx.strokeStyle = C.bad;
      const lims = pos ? [toDeg(lo), toDeg(hi)] : [-vlim, vlim];
      for (const v of lims) { const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = C.bad;
      ctx.fillText(pos ? `上限 ${toDeg(hi).toFixed(1)}°` : `上限 ${vlim.toFixed(1)}`, x0 + 6, Y(lims[1]) - 2);
      ctx.textBaseline = 'top';
      ctx.fillText(pos ? `下限 ${toDeg(lo).toFixed(1)}°` : `下限 ${(-vlim).toFixed(1)}`, x0 + 6, Y(lims[0]) + 2);

      // 规划曲线：按状态分三条路径着色
      const stOf = (f: number) => { const s = A.status[f * NJ + j]; return pos ? ((s & 3) === POS_OVER ? 2 : s & 3) : s & VEL_BAD ? 2 : 0; };
      const paths = [new Path2D(), new Path2D(), new Path2D()];
      for (let f = f0; f < f1; f++) {
        const p = paths[Math.max(stOf(f), stOf(f + 1))];
        p.moveTo(X(f / fps), Y(val(f)));
        p.lineTo(X((f + 1) / fps), Y(val(f + 1)));
      }
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.lineWidth = 1.5; ctx.strokeStyle = C['line-data']; ctx.stroke(paths[0]);
      ctx.lineWidth = 2; ctx.strokeStyle = C['warn-fill']; ctx.stroke(paths[1]);
      ctx.lineWidth = 2.2; ctx.strokeStyle = C.bad; ctx.stroke(paths[2]);

      // 实际曲线
      if (live) {
        const p = new Path2D();
        let started = false;
        for (let i = 0; i < samples.count; i++) {
          const s = samples.stamps[i];
          if (s < t0 || s > t1) { started = false; continue; }
          const x = X(s), y = Y(toDeg(samples.pos[i * NJ + j]));
          if (started) p.lineTo(x, y); else { p.moveTo(x, y); started = true; }
        }
        ctx.lineWidth = 1.8; ctx.strokeStyle = C.live; ctx.stroke(p);
      }

      const f = Math.max(0, Math.min(n - 1, Math.floor(t * fps + 1e-6)));
      const px = X(t), vy = Y(val(f));
      ctx.fillStyle = C.accent;
      ctx.fillRect(Math.round(px) - 0.5, y0, 1.5, y1 - y0);
      ctx.beginPath(); ctx.arc(px, vy, 3.5, 0, Math.PI * 2); ctx.fill();
      const label = pos ? `${val(f).toFixed(1)}°` : `${val(f).toFixed(2)} rad/s`;
      ctx.font = `500 11px ${font}`;
      const tw = ctx.measureText(label).width + 10;
      let lx = px + 8; if (lx + tw > x1) lx = px - 8 - tw;
      const ly = Math.max(y0, Math.min(y1 - 18, vy - 9));
      ctx.fillStyle = C.raised; ctx.strokeStyle = C.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(lx, ly, tw, 18, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 5, ly + 9.5);
    };
    const sch = createDrawScheduler(draw);
    const u1 = usePlayback.subscribe((s, p) => { if (s.t !== p.t) sch.request(); });
    const u2 = useReview.subscribe(() => sch.request());
    const u3 = useLive.subscribe((s, p) => { if (s.version !== p.version) sch.request(); });
    const u4 = onColors(() => sch.request());
    const ro = new ResizeObserver(() => sch.request());
    ro.observe(cv);
    sch.request();

    const seek = (e: PointerEvent) => {
      const { planned } = useReview.getState();
      if (!planned || useLive.getState().source) return;
      const r = cv.getBoundingClientRect();
      const dur = duration(planned);
      const [t0, t1] = viewRange(dur, usePlayback.getState().t);
      usePlayback.getState().setT(Math.max(0, Math.min(dur, t0 + ((e.clientX - r.left - CV.padL) / (r.width - CV.padL - CV.padR)) * (t1 - t0))));
    };
    const down = (e: PointerEvent) => { cv.setPointerCapture(e.pointerId); seek(e); };
    const move = (e: PointerEvent) => { if (cv.hasPointerCapture(e.pointerId)) seek(e); };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    return () => { u1(); u2(); u3(); u4(); ro.disconnect(); sch.cancel(); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); };
  }, []);

  const copyReport = () => {
    const { analysis, planned, clips, clipId, rules, inject } = useReview.getState();
    if (!analysis || !planned) return;
    const clip = clips.find((c) => c.id === clipId);
    const text = buildReport({ clipName: clip?.name ?? '', clipId: clipId ?? '', fps: planned.fps, analysis, rules, injected: inject });
    const fallback = () => { setReport(text); setTimeout(() => { taRef.current?.focus(); taRef.current?.select(); }, 0); };
    try {
      navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, fallback);
    } catch { fallback(); }
  };

  return (
    <>
      <div className="curve-head">
        <h2>{G1_JOINTS[sel].zh}<small>{G1_JOINTS[sel].name}</small></h2>
        <div className="seg" role="group" aria-label="曲线内容">
          <button type="button" aria-pressed={mode === 'pos'} onClick={() => setMode('pos')}>角度 °</button>
          <button type="button" aria-pressed={mode === 'vel'} onClick={() => setMode('vel')}>角速度 rad/s</button>
        </div>
        <div className="seg" role="group" aria-label="时间范围">
          <button type="button" aria-pressed={range === 'all'} onClick={() => setRange('all')}>全段</button>
          <button type="button" aria-pressed={range === 'win'} onClick={() => setRange('win')}>前后 5 秒</button>
        </div>
        <span className="spacer" />
        <button className="btn sm" type="button" onClick={copyReport}>{copied ? '已复制' : '复制问题报告'}</button>
      </div>
      <canvas ref={ref} className="cv" aria-label="所选关节的曲线" />
      {report !== null && (
        <div className="report">
          <p>浏览器不允许直接写入剪贴板，报告已选中，按 Ctrl+C 或 ⌘C 复制。</p>
          <textarea ref={taRef} readOnly value={report} aria-label="问题报告" />
          <div><button className="btn sm" type="button" onClick={() => setReport(null)}>收起</button></div>
        </div>
      )}
    </>
  );
}
