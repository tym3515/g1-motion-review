import { create, fromBinary, toBinary, type DescMessage, type DescMethodStreaming, type DescMethodUnary, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf';
import { Code, ConnectError, type StreamResponse, type Transport, type UnaryResponse } from '@connectrpc/connect';
import type { FromWorker, ToWorker } from './protocol';

interface Pending {
  onUnary?: (b: Uint8Array) => void;
  onMsg?: (b: Uint8Array) => void;
  onEnd?: () => void;
  onError: (e: ConnectError) => void;
}

/** 一个简单的异步队列：Worker 推来的消息先排队，消费方用 for await 读。 */
function createQueue<T>() {
  const items: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | null = null;
  let rejectWaiting: ((e: unknown) => void) | null = null;
  let done = false;
  let error: unknown = null;
  return {
    push(v: T) {
      if (waiting) { const w = waiting; waiting = rejectWaiting = null; w({ value: v, done: false }); } else items.push(v);
    },
    end() {
      done = true;
      if (waiting) { const w = waiting; waiting = rejectWaiting = null; w({ value: undefined, done: true }); }
    },
    fail(e: unknown) {
      error = e; done = true;
      if (rejectWaiting) { const r = rejectWaiting; waiting = rejectWaiting = null; r(e); }
    },
    get finished() { return done; },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => {
          if (items.length) return Promise.resolve({ value: items.shift()!, done: false });
          if (error) return Promise.reject(error);
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res, rej) => { waiting = res; rejectWaiting = rej; });
        },
      };
    },
  };
}

/**
 * 把调用转发给 review.worker 的 Transport。对上层来说它和 createConnectTransport 返回的没有区别，
 * 同一个 createClient(MotionReviewService, transport) 既能连 Node 后端，也能连浏览器里的 Worker。
 */
export function createWorkerTransport(worker: Worker, dataBase: string): Transport {
  let seq = 0;
  const pending = new Map<number, Pending>();
  const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);

  worker.addEventListener('message', (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.kind === 'unary') { pending.delete(m.id); p.onUnary?.(m.payload); }
    else if (m.kind === 'msg') p.onMsg?.(m.payload);
    else if (m.kind === 'end') { pending.delete(m.id); p.onEnd?.(); }
    else if (m.kind === 'error') { pending.delete(m.id); p.onError(new ConnectError(m.message, m.code as Code)); }
  });
  worker.addEventListener('error', (ev) => {
    const err = new ConnectError(`Worker 出错：${ev.message}`, Code.Internal);
    for (const p of pending.values()) p.onError(err);
    pending.clear();
  });
  send({ kind: 'init', dataBase });

  const encode = <I extends DescMessage>(schema: I, input: MessageInitShape<I>) => {
    const bytes = toBinary(schema, create(schema, input));
    return { bytes, transfer: [bytes.buffer as ArrayBuffer] };
  };

  return {
    async unary<I extends DescMessage, O extends DescMessage>(
      method: DescMethodUnary<I, O>,
      signal: AbortSignal | undefined,
      _timeoutMs: number | undefined,
      _header: HeadersInit | undefined,
      input: MessageInitShape<I>,
    ): Promise<UnaryResponse<I, O>> {
      if (signal?.aborted) throw new ConnectError('调用已取消', Code.Canceled);
      const id = ++seq;
      const { bytes, transfer } = encode(method.input, input);
      const out = await new Promise<Uint8Array>((resolve, reject) => {
        pending.set(id, { onUnary: resolve, onError: reject });
        signal?.addEventListener('abort', () => {
          if (!pending.delete(id)) return;
          send({ kind: 'cancel', id });
          reject(new ConnectError('调用已取消', Code.Canceled));
        }, { once: true });
        send({ kind: 'call', id, method: method.name, payload: bytes }, transfer);
      });
      return {
        stream: false,
        service: method.parent,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message: fromBinary(method.output, out) as MessageShape<O>,
      };
    },

    async stream<I extends DescMessage, O extends DescMessage>(
      method: DescMethodStreaming<I, O>,
      signal: AbortSignal | undefined,
      _timeoutMs: number | undefined,
      _header: HeadersInit | undefined,
      input: AsyncIterable<MessageInitShape<I>>,
    ): Promise<StreamResponse<I, O>> {
      if (method.methodKind !== 'server_streaming') throw new ConnectError('Worker 传输只支持服务端流', Code.Unimplemented);
      const first = await input[Symbol.asyncIterator]().next();
      if (first.done) throw new ConnectError('服务端流需要一条请求消息', Code.InvalidArgument);
      const id = ++seq;
      const q = createQueue<Uint8Array>();
      pending.set(id, { onMsg: (b) => q.push(b), onEnd: () => q.end(), onError: (e) => q.fail(e) });
      const cancel = () => {
        if (!pending.delete(id)) return;
        send({ kind: 'cancel', id });
        q.fail(new ConnectError('调用已取消', Code.Canceled));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const { bytes, transfer } = encode(method.input, first.value);
      send({ kind: 'call', id, method: method.name, payload: bytes }, transfer);
      return {
        stream: true,
        service: method.parent,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message: (async function* () {
          try {
            for await (const b of q) yield fromBinary(method.output, b) as MessageShape<O>;
          } finally {
            // 消费方提前 break 时通知 Worker 停止
            if (!q.finished) cancel();
            signal?.removeEventListener('abort', cancel);
          }
        })(),
      };
    },
  };
}
