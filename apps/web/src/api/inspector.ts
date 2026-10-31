import { create, toBinary, toJson, type DescMessage, type DescMethod, type DescMethodStreaming, type DescMethodUnary, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf';
import { ConnectError, type StreamResponse, type Transport, type UnaryResponse } from '@connectrpc/connect';
import { create as createStore } from 'zustand';

export interface CallRecord {
  id: number;
  /** 传输方式：worker、connect、grpc-web */
  via: string;
  baseUrl: string;
  service: string;
  method: string;
  kind: 'unary' | 'server_streaming';
  startedAt: number;
  /** 毫秒；流式调用在结束时才有值 */
  duration: number | null;
  state: 'pending' | 'streaming' | 'ok' | 'error' | 'canceled';
  requestJson: unknown;
  requestBytes: number;
  responseJson: unknown;
  responseBytes: number;
  messages: number;
  error: string | null;
}

interface InspectorState {
  open: boolean;
  calls: CallRecord[];
  setOpen(v: boolean): void;
  clear(): void;
  upsert(r: CallRecord): void;
}

const MAX_CALLS = 80;

export const useInspector = createStore<InspectorState>((set) => ({
  open: false,
  calls: [],
  setOpen: (open) => set({ open }),
  clear: () => set({ calls: [] }),
  upsert: (r) =>
    set((s) => {
      const i = s.calls.findIndex((c) => c.id === r.id);
      const calls = i >= 0 ? s.calls.map((c, k) => (k === i ? { ...r } : c)) : [{ ...r }, ...s.calls].slice(0, MAX_CALLS);
      return { calls };
    }),
}));

/** 大块二进制在 JSON 里是很长的 base64 字符串，面板里只显示长度。数组超长时也截断。 */
function shrink(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 160 ? `<${v.length.toLocaleString()} 字符，已省略>` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, 32).map((x) => shrink(x, depth + 1));
    return v.length > 32 ? [...head, `<另有 ${v.length - 32} 项>`] : head;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = depth > 6 ? '…' : shrink(x, depth + 1);
    return out;
  }
  return v;
}

function describe(schema: DescMessage, msg: MessageShape<DescMessage>) {
  return { json: shrink(toJson(schema, msg, { alwaysEmitImplicit: false })), bytes: toBinary(schema, msg).byteLength };
}

let seq = 0;

/**
 * 包一层 Transport，把每次调用记进接口调试面板。它不关心底下是 Worker 还是 HTTP，
 * 所以面板里看到的请求和响应，就是真正交给传输层的 proto 消息。
 */
export function withInspector(inner: Transport, via: string, baseUrl: string): Transport {
  const upsert = useInspector.getState().upsert;
  const start = (method: DescMethod, kind: CallRecord['kind']): CallRecord => ({
    id: ++seq,
    via,
    baseUrl,
    service: method.parent.typeName,
    method: method.name,
    kind,
    startedAt: Date.now(),
    duration: null,
    state: 'pending',
    requestJson: null,
    requestBytes: 0,
    responseJson: null,
    responseBytes: 0,
    messages: 0,
    error: null,
  });
  const fail = (r: CallRecord, t0: number, e: unknown) => {
    const err = ConnectError.from(e);
    r.state = err.code === 1 ? 'canceled' : 'error';
    r.error = err.code === 1 ? null : err.message;
    r.duration = performance.now() - t0;
    upsert(r);
  };

  return {
    async unary<I extends DescMessage, O extends DescMessage>(
      method: DescMethodUnary<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      header: HeadersInit | undefined,
      input: MessageInitShape<I>,
      contextValues?: Parameters<Transport['unary']>[5],
    ): Promise<UnaryResponse<I, O>> {
      const r = start(method, 'unary');
      const t0 = performance.now();
      const req = describe(method.input, create(method.input, input));
      r.requestJson = req.json; r.requestBytes = req.bytes;
      upsert(r);
      try {
        const res = await inner.unary(method, signal, timeoutMs, header, input, contextValues);
        const out = describe(method.output, res.message);
        r.responseJson = out.json; r.responseBytes = out.bytes; r.messages = 1;
        r.state = 'ok'; r.duration = performance.now() - t0;
        upsert(r);
        return res;
      } catch (e) {
        fail(r, t0, e);
        throw e;
      }
    },

    async stream<I extends DescMessage, O extends DescMessage>(
      method: DescMethodStreaming<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      header: HeadersInit | undefined,
      input: AsyncIterable<MessageInitShape<I>>,
      contextValues?: Parameters<Transport['stream']>[5],
    ): Promise<StreamResponse<I, O>> {
      const r = start(method, 'server_streaming');
      const t0 = performance.now();
      const tapped = (async function* () {
        for await (const m of input) {
          const req = describe(method.input, create(method.input, m));
          r.requestJson = req.json; r.requestBytes = req.bytes;
          upsert(r);
          yield m;
        }
      })();
      let res: StreamResponse<I, O>;
      try {
        res = await inner.stream(method, signal, timeoutMs, header, tapped, contextValues);
      } catch (e) {
        fail(r, t0, e);
        throw e;
      }
      r.state = 'streaming';
      upsert(r);
      let lastUpdate = 0;
      return {
        ...res,
        message: (async function* () {
          try {
            for await (const m of res.message) {
              r.messages++;
              r.responseBytes += toBinary(method.output, m).byteLength;
              const now = performance.now();
              // 流式消息很密，面板每 250 ms 刷新一次
              if (now - lastUpdate > 250) { lastUpdate = now; r.responseJson = describe(method.output, m).json; upsert(r); }
              yield m;
            }
            r.state = 'ok'; r.duration = performance.now() - t0;
            upsert(r);
          } catch (e) {
            fail(r, t0, e);
            throw e;
          } finally {
            if (r.state === 'streaming') { r.state = 'canceled'; r.duration = performance.now() - t0; upsert(r); }
          }
        })(),
      };
    },
  };
}

/** 生成可以直接在终端里跑的 buf curl 命令。 */
export function bufCurl(r: CallRecord, fallbackBase = 'http://localhost:8080'): string {
  const base = r.via === 'worker' ? fallbackBase : r.baseUrl;
  const proto = r.via === 'grpc-web' ? ' --protocol grpcweb' : '';
  const data = JSON.stringify(r.requestJson ?? {});
  const tooBig = data.includes('已省略');
  return `buf curl --schema proto${proto} --data '${tooBig ? '{…请求含大块二进制，已省略…}' : data}' ${base}/${r.service}/${r.method}`;
}
