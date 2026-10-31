import { useEffect, useRef, useState } from 'react';
import { G1_JOINT_NAMES, sampleJoints, sampleRoot, severity, type TimelineEvent } from '@g1/core';
import { RobotScene } from '../three/RobotScene';
import { DATA_BASE } from '../api/client';
import { getColors, onColors } from '../lib/theme';
import { fmtN } from '../lib/format';
import { useThrottledTime } from '../lib/hooks';
import { useReview } from '../store/review';
import { usePlayback } from '../store/playback';
import { useLive } from '../store/live';

const NJ = G1_JOINT_NAMES.length;

export function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<RobotScene | null>(null);
  const [loadState, setLoadState] = useState<{ text: string; error: boolean } | null>({ text: '正在加载 G1 模型', error: false });
  const [dragging, setDragging] = useState(false);
  const urdfPath = useReview((s) => s.urdfPath);
  const bootError = useReview((s) => s.bootError);
  const loadingClip = useReview((s) => s.loadingClip);
  const importFile = useReview((s) => s.importFile);
  const follow = usePlayback((s) => s.follow);
  const setFollow = usePlayback((s) => s.setFollow);
  const liveOn = useLive((s) => s.latest !== null);

  // 场景：创建一次，自带渲染循环，每帧从 store 读当前状态
  useEffect(() => {
    const scene = new RobotScene(canvasRef.current!, getColors());
    sceneRef.current = scene;
    const offColors = onColors((c) => scene.applyColors(c));
    const q = new Float32Array(NJ);
    const root = new Float32Array(7);
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const { planned, analysis, sel } = useReview.getState();
      const { t, follow } = usePlayback.getState();
      scene.follow = follow;
      if (scene.loaded && planned) {
        sampleJoints(planned, t, q);
        scene.setPose(q, sampleRoot(planned, t, root) ? root : null);
        const live = useLive.getState();
        scene.setGhost(live.latest, live.latestRoot);
        const f = Math.max(0, Math.min(planned.frameCount - 1, Math.floor(t * planned.fps + 1e-6)));
        const st = analysis && analysis.frameCount === planned.frameCount ? analysis.status : null;
        scene.setHighlights((j) => (st ? severity(st[f * NJ + j]) : 0), sel);
      }
      scene.render();
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); offColors(); scene.dispose(); sceneRef.current = null; };
  }, []);

  // 服务端告诉我们 URDF 在哪，再去加载模型
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !urdfPath || scene.loaded) return;
    scene
      .load(new URL(urdfPath, DATA_BASE).href, new URL('g1/meshes.json', DATA_BASE).href, [...G1_JOINT_NAMES], (l, n) => setLoadState({ text: `正在加载 G1 模型 ${l} / ${n}`, error: false }))
      .then(() => setLoadState(null))
      .catch((e: Error) => setLoadState({ text: `G1 模型没有加载成功：${e.message}`, error: true }));
  }, [urdfPath]);

  const overlay = bootError ? { text: bootError, error: true } : loadState ?? (loadingClip ? { text: '正在加载动作', error: false } : null);

  return (
    <section
      className="viewport"
      aria-label="G1 三维预览"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void importFile(f); }}
    >
      <canvas ref={canvasRef} />
      <Hud />
      <div className="hud tr">
        <span><i className="sw ok" />正常</span>
        <span><i className="sw warn" />贴近限位</span>
        <span><i className="sw bad" />超限</span>
        {liveOn && <span><i className="sw live" />实际状态</span>}
      </div>
      <div className="hud bl">
        <label className="chk"><input type="checkbox" id="follow" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 镜头跟随</label>
        <button className="btn sm" type="button" onClick={() => sceneRef.current?.resetCamera()}>重置视角</button>
      </div>
      {dragging && <div className="drop-hint">松开鼠标导入轨迹</div>}
      {overlay && (
        <div className={`overlay${overlay.error ? ' err' : ''}`}>
          {!overlay.error && <div className="spinner" />}
          <p>{overlay.text}</p>
        </div>
      )}
    </section>
  );
}

function Hud() {
  const t = useThrottledTime(12);
  const planned = useReview((s) => s.planned);
  const clip = useReview((s) => s.clips.find((c) => c.id === s.clipId));
  if (!planned) return <div className="hud tl"><b>—</b></div>;
  const f = Math.max(0, Math.min(planned.frameCount - 1, Math.floor(t * planned.fps + 1e-6)));
  let ev: TimelineEvent | null = null;
  for (const e of planned.events) { if (e.t <= t + 1e-6) ev = e; else break; }
  return (
    <div className="hud tl">
      <b>{clip?.name ?? '—'}</b>
      <span className="mono">帧 {fmtN(f + 1)} / {fmtN(planned.frameCount)} · {planned.fps} fps</span>
      {planned.events.length > 0 && (
        <span>
          最近事件 {ev ? `${ev.t.toFixed(1)} s · ${ev.type === 'face' ? `表情 ${ev.name ?? ''}` : ev.type === 'speech' ? '语音' : ev.type}` : '—'}
        </span>
      )}
    </div>
  );
}
