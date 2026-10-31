/**
 * rosbridge v2 协议的最小客户端：只做订阅。协议本身就是 WebSocket 上的 JSON，
 * 不引入 roslibjs 也能说清楚每条消息长什么样。
 * 真机或仿真端运行：ros2 launch rosbridge_server rosbridge_websocket_launch.xml
 */
export interface RosJointState {
  header?: { stamp?: { sec?: number; nanosec?: number; secs?: number; nsecs?: number }; frame_id?: string };
  name: string[];
  position: number[];
  velocity?: number[];
}

export interface RosSubscription {
  close(): void;
}

export function stampSeconds(m: RosJointState): number | null {
  const s = m.header?.stamp;
  if (!s) return null;
  const sec = s.sec ?? s.secs, ns = s.nanosec ?? s.nsecs ?? 0;
  return sec === undefined ? null : sec + ns * 1e-9;
}

export function subscribeJointStates(
  url: string,
  topic: string,
  handlers: { onOpen(): void; onMessage(m: RosJointState): void; onClose(reason: string): void },
): RosSubscription {
  let closedByUs = false;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    queueMicrotask(() => handlers.onClose(`地址无效：${(e as Error).message}`));
    return { close() {} };
  }
  const id = `g1_review_${Math.random().toString(36).slice(2, 8)}`;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ op: 'subscribe', id, topic, type: 'sensor_msgs/msg/JointState', queue_length: 1 }));
    handlers.onOpen();
  });
  ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as { op?: string; topic?: string; msg?: RosJointState };
      if (m.op === 'publish' && m.topic === topic && m.msg) handlers.onMessage(m.msg);
    } catch {
      /* 忽略非 JSON 消息 */
    }
  });
  ws.addEventListener('close', (ev) => {
    if (!closedByUs) handlers.onClose(ev.reason || `连接已断开（代码 ${ev.code}）`);
  });
  ws.addEventListener('error', () => {
    if (!closedByUs) handlers.onClose(`连不上 ${url}`);
  });
  return {
    close() {
      closedByUs = true;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'unsubscribe', id, topic }));
      ws.close();
    },
  };
}
