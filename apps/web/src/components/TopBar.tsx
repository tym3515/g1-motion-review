import { useRef, useState } from 'react';
import { useReview } from '../store/review';
import { useInspector } from '../api/inspector';
import type { Backend } from '../api/client';

const VERDICT_TEXT = { pass: '通过', pass_near_limit: '通过 · 有贴近限位', fail: '未通过' } as const;

export function TopBar() {
  const clips = useReview((s) => s.clips);
  const clipId = useReview((s) => s.clipId);
  const selectClip = useReview((s) => s.selectClip);
  const importFile = useReview((s) => s.importFile);
  const analysis = useReview((s) => s.analysis);
  const robotName = useReview((s) => s.robotName);
  const backend = useReview((s) => s.backend);
  const setBackend = useReview((s) => s.setBackend);
  const calls = useInspector((s) => s.calls.length);
  const setOpen = useInspector((s) => s.setOpen);
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('http://localhost:8080');

  const onBackend = (kind: Backend['kind']) => {
    void setBackend(kind === 'worker' ? { kind } : { kind, baseUrl: url.replace(/\/$/, '') });
  };

  return (
    <header className="bar">
      <div className="brand">
        <h1>G1 动作审核台</h1>
        <p>
          宇树 G1 · 29 个旋转关节 · <span className="mono">{robotName || 'g1_29dof_rev_1_0'}</span>
        </p>
      </div>

      <label className="field">
        <span>动作</span>
        <select id="clipSel" value={clipId ?? ''} onChange={(e) => void selectClip(e.target.value)}>
          {clips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {Math.round(c.frames / c.fps)} s
            </option>
          ))}
        </select>
      </label>
      <button className="btn" type="button" onClick={() => fileRef.current?.click()}>
        导入轨迹
      </button>
      <input
        ref={fileRef}
        id="fileIn"
        type="file"
        accept=".csv,.txt,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.target.value = '';
        }}
      />

      <label className="field" title="同一个客户端，只换 Transport">
        <span>服务</span>
        <select id="backendSel" value={backend.kind} onChange={(e) => onBackend(e.target.value as Backend['kind'])}>
          <option value="worker">浏览器内 Worker</option>
          <option value="connect">本地后端 · Connect</option>
          <option value="grpc-web">本地后端 · gRPC-Web</option>
        </select>
      </label>
      {backend.kind !== 'worker' && (
        <input
          id="backendUrl"
          type="url"
          aria-label="后端地址"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onBackend(backend.kind); }}
          onBlur={() => { if (url.replace(/\/$/, '') !== backend.baseUrl) onBackend(backend.kind); }}
        />
      )}

      <button className="btn" type="button" onClick={() => setOpen(true)}>
        接口调试<span className="badge">{calls}</span>
      </button>

      <div className={`verdict ${analysis ? `v-${analysis.verdict}` : ''}`} role="status">
        {analysis ? `${VERDICT_TEXT[analysis.verdict]}${analysis.segments.length ? ` · ${analysis.segments.length} 段超限` : ''}` : '审核中'}
      </div>
    </header>
  );
}

export function Notice() {
  const notice = useReview((s) => s.notice);
  const analyzeError = useReview((s) => s.analyzeError);
  const dismiss = useReview((s) => s.dismissNotice);
  const n = analyzeError ? { text: analyzeError, error: true } : notice;
  if (!n) return <div hidden />;
  return (
    <div className={`notice${n.error ? ' err' : ''}`} role={n.error ? 'alert' : 'status'}>
      <p>{n.text}</p>
      {!analyzeError && (
        <button type="button" aria-label="关闭提示" onClick={dismiss}>
          ×
        </button>
      )}
    </div>
  );
}
