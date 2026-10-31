import { createClient, type Client, type Transport } from '@connectrpc/connect';
import { createConnectTransport, createGrpcWebTransport } from '@connectrpc/connect-web';
import { MotionReviewService } from '@g1/proto';
import { withInspector } from './inspector';
import { createWorkerTransport } from './worker-transport';

export type Backend =
  | { kind: 'worker' }
  | { kind: 'connect'; baseUrl: string }
  | { kind: 'grpc-web'; baseUrl: string };

export type ReviewClient = Client<typeof MotionReviewService>;

export const DATA_BASE = new URL('data/', document.baseURI).href;

let worker: Worker | null = null;
let workerTransport: Transport | null = null;

function getWorkerTransport(): Transport {
  if (!workerTransport) {
    worker = new Worker(new URL('./review.worker.ts', import.meta.url), { type: 'module', name: 'review-service' });
    workerTransport = createWorkerTransport(worker, DATA_BASE);
  }
  return workerTransport;
}

/**
 * 根据选择的后端创建客户端。三种情况用的是同一份生成代码和同一个 createClient，
 * 只有 Transport 不同。
 */
export function makeClient(b: Backend): ReviewClient {
  let transport: Transport;
  let base = '';
  if (b.kind === 'worker') transport = getWorkerTransport();
  else if (b.kind === 'connect') { base = b.baseUrl; transport = createConnectTransport({ baseUrl: b.baseUrl, useBinaryFormat: true }); }
  else { base = b.baseUrl; transport = createGrpcWebTransport({ baseUrl: b.baseUrl }); }
  return createClient(MotionReviewService, withInspector(transport, b.kind, base));
}

export const backendLabel = (b: Backend) =>
  b.kind === 'worker' ? '浏览器内 Worker' : b.kind === 'connect' ? `Connect · ${b.baseUrl}` : `gRPC-Web · ${b.baseUrl}`;
