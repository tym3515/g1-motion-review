import { fromBinary, toBinary, type DescMessage, type DescMethod, type DescMethodStreaming, type DescMethodUnary } from '@bufbuild/protobuf';
import { ConnectError, createRouterTransport, type Transport } from '@connectrpc/connect';
import { MotionReviewService } from '@g1/proto';
import { registerMotionReview, type DataSource } from '@g1/service';
import type { FromWorker, ToWorker } from './protocol';

/**
 * 浏览器里的"后端"：和 Node 后端注册的是同一个服务实现，只是数据用 fetch 读、
 * 调用走 postMessage。静态托管（GitHub Pages、在线预览）时用它，不需要任何服务器。
 */
interface WorkerScope {
  postMessage(msg: FromWorker, transfer: Transferable[]): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent<ToWorker>) => void): void;
}
const scope = self as unknown as WorkerScope;

let transport: Transport | null = null;
const inflight = new Map<number, AbortController>();
const methods = new Map<string, DescMethod>(MotionReviewService.methods.map((m) => [m.name, m]));

function post(msg: FromWorker) {
  const transfer = 'payload' in msg ? [msg.payload.buffer as ArrayBuffer] : [];
  scope.postMessage(msg, transfer);
}

function fail(id: number, e: unknown) {
  const err = ConnectError.from(e);
  post({ kind: 'error', id, code: err.code, message: err.rawMessage });
}

async function handleCall(id: number, name: string, payload: Uint8Array) {
  const method = methods.get(name);
  if (!transport) return fail(id, new Error('Worker 还没有初始化'));
  if (!method) return fail(id, new Error(`未知方法 ${name}`));
  const ctrl = new AbortController();
  inflight.set(id, ctrl);
  const input = fromBinary(method.input as DescMessage, payload);
  try {
    if (method.methodKind === 'unary') {
      const res = await transport.unary(method as DescMethodUnary, ctrl.signal, undefined, undefined, input);
      post({ kind: 'unary', id, payload: toBinary(method.output, res.message) });
    } else if (method.methodKind === 'server_streaming') {
      const res = await transport.stream(method as DescMethodStreaming, ctrl.signal, undefined, undefined, (async function* () { yield input; })());
      for await (const m of res.message) {
        if (ctrl.signal.aborted) break;
        post({ kind: 'msg', id, payload: toBinary(method.output, m) });
      }
      post({ kind: 'end', id });
    } else {
      fail(id, new Error(`Worker 传输不支持 ${method.methodKind} 调用`));
    }
  } catch (e) {
    if (!ctrl.signal.aborted) fail(id, e);
  } finally {
    inflight.delete(id);
  }
}

scope.addEventListener('message', (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.kind === 'init') {
    const base = msg.dataBase;
    const source: DataSource = {
      async readText(p) {
        const res = await fetch(new URL(p, base));
        if (!res.ok) throw new Error(`读取 ${p} 失败：HTTP ${res.status}`);
        return res.text();
      },
    };
    transport = createRouterTransport((router) => registerMotionReview(router, source));
  } else if (msg.kind === 'call') {
    void handleCall(msg.id, msg.method, msg.payload);
  } else if (msg.kind === 'cancel') {
    inflight.get(msg.id)?.abort();
  }
});
