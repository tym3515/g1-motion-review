import http from 'node:http';
import http2 from 'node:http2';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cors as connectCors, type Interceptor } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { registerMotionReview, type DataSource } from '@g1/service';

const PORT = Number(process.env.PORT ?? 8080);
const GRPC_PORT = Number(process.env.GRPC_PORT ?? 8081);
const DATA_DIR = resolve(process.env.G1_DATA_DIR ?? fileURLToPath(new URL('../../web/public/data/', import.meta.url)));
/** 逗号分隔；默认只放行本机开发端口。 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173').split(',').map((s) => s.trim());

/** 从数据目录读文件，拒绝跳出目录的路径。 */
const fsSource: DataSource = {
  async readText(p) {
    const full = resolve(DATA_DIR, p);
    if (!full.startsWith(DATA_DIR + sep)) throw new Error(`拒绝访问数据目录以外的路径：${p}`);
    return readFile(full, 'utf8');
  },
};

/** 打印每次调用的方法、耗时和结果，流式调用在流结束时打印消息数。 */
const logger: Interceptor = (next) => async (req) => {
  const t0 = performance.now();
  const name = `${req.method.parent.name}/${req.method.name}`;
  try {
    const res = await next(req);
    if (!res.stream) {
      console.log(`${name} ok ${(performance.now() - t0).toFixed(1)} ms`);
      return res;
    }
    const inner = res.message;
    return {
      ...res,
      message: (async function* () {
        let count = 0;
        try {
          for await (const m of inner) { count++; yield m; }
        } finally {
          console.log(`${name} stream closed after ${count} messages, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        }
      })(),
    };
  } catch (e) {
    console.log(`${name} error ${(e as Error).message}`);
    throw e;
  }
};

const handler = connectNodeAdapter({
  routes: (router) => registerMotionReview(router, fsSource),
  interceptors: [logger],
});

// 8080：HTTP/1.1，浏览器用 Connect 或 gRPC-Web 协议访问，需要 CORS
const web = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', connectCors.allowedMethods.join(','));
    res.setHeader('Access-Control-Allow-Headers', connectCors.allowedHeaders.join(','));
    res.setHeader('Access-Control-Expose-Headers', connectCors.exposedHeaders.join(','));
    res.setHeader('Access-Control-Max-Age', '7200');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
  handler(req, res);
});

// 8081：h2c（明文 HTTP/2），原生 gRPC 客户端用，比如 grpcurl、buf curl --protocol grpc、其他后端服务
const grpc = http2.createServer(handler);

web.listen(PORT, () => {
  console.log(`Connect / gRPC-Web  http://localhost:${PORT}`);
  console.log(`数据目录            ${DATA_DIR}`);
});
grpc.listen(GRPC_PORT, () => console.log(`gRPC (h2c)          localhost:${GRPC_PORT}`));

const stop = () => { web.close(); grpc.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
