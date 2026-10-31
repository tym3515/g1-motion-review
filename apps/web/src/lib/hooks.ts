import { useEffect, useState } from 'react';
import { usePlayback } from '../store/playback';

/**
 * 播放时 t 每帧都在变。关节列表这类 DOM 组件没必要 60 Hz 重渲染，
 * 这个 hook 把 t 限制在指定频率以内。
 */
export function useThrottledTime(hz = 15): number {
  const [t, setT] = useState(() => usePlayback.getState().t);
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = usePlayback.subscribe((s, prev) => {
      if (s.t === prev.t) return;
      const now = performance.now();
      const wait = 1000 / hz - (now - last);
      if (wait <= 0) { last = now; setT(s.t); return; }
      if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); setT(usePlayback.getState().t); }, wait);
    });
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, [hz]);
  return t;
}

/** 在 requestAnimationFrame 里合并多次重画请求。 */
export function createDrawScheduler(draw: () => void) {
  let raf = 0;
  return {
    request() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); },
    cancel() { if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
}
