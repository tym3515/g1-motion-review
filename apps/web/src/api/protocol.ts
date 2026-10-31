/**
 * 主线程和 review.worker 之间的消息。请求和响应都是 proto 二进制，
 * 和网络上传输的内容一样，Worker 就是一个跑在浏览器里的后端。
 */
export type ToWorker =
  | { kind: 'init'; dataBase: string }
  | { kind: 'call'; id: number; method: string; payload: Uint8Array }
  | { kind: 'cancel'; id: number };

export type FromWorker =
  | { kind: 'unary'; id: number; payload: Uint8Array }
  | { kind: 'msg'; id: number; payload: Uint8Array }
  | { kind: 'end'; id: number }
  | { kind: 'error'; id: number; code: number; message: string };
