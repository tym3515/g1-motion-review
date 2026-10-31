/**
 * 不装 ROS 也能演示"连接 ROS 2"：一个说 rosbridge v2 协议的 WebSocket 服务，
 * 客户端订阅 /joint_states 后，按 sensor_msgs/msg/JointState 的格式推送关节状态。
 *
 * 数据来自同一个 MotionReviewService 的 StreamJointStates（跟踪模型模拟真机），
 * 这里只是换了一层 rosbridge 的外壳。换成真机时，前端代码不用改。
 *
 * 用法：npm run mock:ros -- --clip dance1_subject2 --port 9090 --rate 50 [--inject]
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient, createRouterTransport } from '@connectrpc/connect';
import { WebSocketServer, type WebSocket } from 'ws';
import { MotionReviewService } from '@g1/proto';
import { registerMotionReview, type DataSource } from '@g1/service';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const CLIP = arg('clip', 'dance1_subject2');
const PORT = Number(arg('port', '9090'));
const RATE = Number(arg('rate', '50'));
const INJECT = process.argv.includes('--inject');
const TOPIC = '/joint_states';

const root = fileURLToPath(new URL('../apps/web/public/data/', import.meta.url));
const source: DataSource = { readText: (p) => readFile(root + p, 'utf8') };
const client = createClient(MotionReviewService, createRouterTransport((r) => registerMotionReview(r, source)));

async function publish(ws: WebSocket, signal: AbortSignal) {
  let names: string[] = [];
  const stream = client.streamJointStates(
    {
      source: { case: 'clipId', value: CLIP },
      rateHz: RATE,
      speed: 1,
      loop: true,
      injectTestDeviation: INJECT,
      tracker: { bandwidthHz: 6, latencyMs: 40, noiseDeg: 0.15, enforceLimits: true, velocityFactor: 0.5 },
    },
    { signal },
  );
  for await (const m of stream) {
    const s = m.state!;
    if (s.name.length) names = s.name;
    const now = Date.now();
    const msg = {
      header: { stamp: { sec: Math.floor(now / 1000), nanosec: (now % 1000) * 1e6 }, frame_id: '' },
      name: names,
      position: s.position,
      velocity: s.velocity,
      effort: [],
    };
    if (ws.readyState !== ws.OPEN) break;
    ws.send(JSON.stringify({ op: 'publish', topic: TOPIC, msg }));
  }
}

const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (ws, req) => {
  console.log(`客户端已连接 ${req.socket.remoteAddress}`);
  const subs = new Map<string, AbortController>();
  ws.on('message', (raw) => {
    let m: { op?: string; id?: string; topic?: string; type?: string };
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.op === 'subscribe' && m.topic === TOPIC) {
      const key = m.id ?? TOPIC;
      subs.get(key)?.abort();
      const ctrl = new AbortController();
      subs.set(key, ctrl);
      console.log(`订阅 ${TOPIC}（${m.type ?? '未声明类型'}），动作 ${CLIP}，${RATE} Hz${INJECT ? '，叠加测试偏差' : ''}`);
      publish(ws, ctrl.signal).catch((e: Error) => { if (!ctrl.signal.aborted) console.error('推送出错', e.message); });
    } else if (m.op === 'subscribe') {
      ws.send(JSON.stringify({ op: 'status', level: 'warning', msg: `模拟 rosbridge 只提供 ${TOPIC}`, id: m.id }));
    } else if (m.op === 'unsubscribe') {
      const key = m.id ?? TOPIC;
      subs.get(key)?.abort();
      subs.delete(key);
      console.log('取消订阅');
    }
  });
  ws.on('close', () => { subs.forEach((c) => c.abort()); console.log('客户端已断开'); });
});
console.log(`模拟 rosbridge 已启动 ws://localhost:${PORT}，话题 ${TOPIC}`);
