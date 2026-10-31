export { formatTime } from '@g1/core';

export const DEG = Math.PI / 180;
export const toDeg = (r: number) => r / DEG;
export const fmtN = (n: number) => n.toLocaleString('zh-CN');
export const fmtKB = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`);

export function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / p;
  return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * p;
}

/** 让画布的像素尺寸跟随 CSS 尺寸和设备像素比，返回是否改变过。 */
export function fitCanvas(cv: HTMLCanvasElement): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
  return false;
}
