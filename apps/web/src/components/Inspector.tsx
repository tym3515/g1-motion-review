import { useEffect, useState } from 'react';
import { bufCurl, useInspector, type CallRecord } from '../api/inspector';
import { fmtKB } from '../lib/format';

const STATE_TEXT: Record<CallRecord['state'], string> = { pending: '等待中', streaming: '推送中', ok: 'OK', error: '出错', canceled: '已取消' };
const VIA_TEXT: Record<string, string> = { worker: 'Web Worker', connect: 'Connect', 'grpc-web': 'gRPC-Web' };

export function InspectorDrawer() {
  const open = useInspector((s) => s.open);
  const calls = useInspector((s) => s.calls);
  const setOpen = useInspector((s) => s.setOpen);
  const clear = useInspector((s) => s.clear);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <aside className="drawer" role="dialog" aria-label="接口调试">
      <header>
        <h2>接口调试 · g1.review.v1.MotionReviewService</h2>
        <button className="btn sm" type="button" onClick={clear}>清空</button>
        <button className="btn sm" type="button" onClick={() => setOpen(false)}>关闭</button>
      </header>
      <p className="hint">每次 RPC 的请求、响应和耗时。消息按 proto 编码后交给传输层，二进制字段只显示长度。本地后端运行时，可以复制 buf curl 命令在终端里重放。</p>
      <ol>
        {calls.length === 0 && <li className="call"><p className="hint">还没有调用。</p></li>}
        {calls.map((c) => (
          <li key={c.id} className="call">
            <button type="button" onClick={() => setExpanded(expanded === c.id ? null : c.id)} aria-expanded={expanded === c.id}>
              <span className="m">{c.method}{c.kind === 'server_streaming' ? ' ⇉' : ''}</span>
              <span className={`st ${c.state}`}>{STATE_TEXT[c.state]}</span>
              <span className="meta">
                <span>{new Date(c.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span>{VIA_TEXT[c.via] ?? c.via}</span>
                <span>请求 {fmtKB(c.requestBytes)}</span>
                <span>{c.kind === 'server_streaming' ? `${c.messages} 条 · ${fmtKB(c.responseBytes)}` : `响应 ${fmtKB(c.responseBytes)}`}</span>
                {c.duration !== null && <span>{c.duration < 1000 ? `${c.duration.toFixed(1)} ms` : `${(c.duration / 1000).toFixed(1)} s`}</span>}
              </span>
            </button>
            {expanded === c.id && <CallDetail c={c} />}
          </li>
        ))}
      </ol>
    </aside>
  );
}

function CallDetail({ c }: { c: CallRecord }) {
  const [copied, setCopied] = useState(false);
  const cmd = bufCurl(c);
  const copy = () => {
    navigator.clipboard.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => setCopied(false));
  };
  return (
    <div className="detail">
      {c.error && <p className="errline">{c.error}</p>}
      <h3>请求 {c.service}/{c.method}</h3>
      <pre>{JSON.stringify(c.requestJson, null, 2)}</pre>
      <h3>{c.kind === 'server_streaming' ? '最近一条流消息' : '响应'}</h3>
      <pre>{c.responseJson === null ? '—' : JSON.stringify(c.responseJson, null, 2)}</pre>
      <h3>在终端重放{c.via === 'worker' ? '（先 npm run dev:server 启动本地后端）' : ''}</h3>
      <pre>{cmd}</pre>
      <div><button className="btn sm" type="button" onClick={copy}>{copied ? '已复制' : '复制命令'}</button></div>
    </div>
  );
}
