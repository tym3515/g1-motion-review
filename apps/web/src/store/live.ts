import { create } from 'zustand';
import { ConnectError, Code } from '@connectrpc/connect';
import { DEFAULT_TRACKER, duration, G1_JOINT_NAMES, JOINT_INDEX, sampleJoints, type TrackerModel } from '@g1/core';
import { trajectoryToProto } from '@g1/service';
import { getClient, useReview } from './review';
import { usePlayback } from './playback';
import { stampSeconds, subscribeJointStates, type RosSubscription } from '../lib/rosbridge';

export type LiveSource = 'service' | 'ros';

const NJ = G1_JOINT_NAMES.length;
const CAPACITY = 20000; // 50 Hz 下约 6.5 分钟

/**
 * 实际关节状态的缓冲区。数据量大、更新频繁，放在 store 外面，
 * 通过 version 通知画布重画，避免每条消息都触发 React 重渲染。
 */
export const samples = {
  count: 0,
  stamps: new Float64Array(CAPACITY),
  pos: new Float32Array(CAPACITY * NJ),
  push(stamp: number, q: ArrayLike<number>) {
    if (this.count === CAPACITY) {
      const half = CAPACITY >> 1;
      this.stamps.copyWithin(0, half);
      this.pos.copyWithin(0, half * NJ);
      this.count -= half;
    }
    // 循环播放回到开头时清空，曲线上不会出现一条横跨全段的连线
    if (this.count && stamp < this.stamps[this.count - 1] - 0.5) this.count = 0;
    this.stamps[this.count] = stamp;
    for (let j = 0; j < NJ; j++) this.pos[this.count * NJ + j] = q[j];
    this.count++;
  },
  clear() { this.count = 0; },
};

export interface TrackingStats {
  /** 每个关节最近约 2 秒的 RMS 误差，弧度 */
  rms: Float64Array;
  /** 本次连接以来的最大误差 */
  peak: { value: number; joint: number; t: number };
}

interface LiveState {
  source: LiveSource | null;
  status: 'idle' | 'connecting' | 'streaming' | 'error';
  message: string | null;
  rosUrl: string;
  tracker: TrackerModel;
  /** 最新一帧实际关节角，按 G1 顺序 */
  latest: Float64Array | null;
  latestRoot: Float64Array | null;
  latestStamp: number;
  rate: number;
  version: number;
  stats: TrackingStats | null;
  start(source: LiveSource): void;
  stop(): void;
  setRosUrl(v: string): void;
  setTracker(p: Partial<TrackerModel>): void;
}

let abort: AbortController | null = null;
let rosSub: RosSubscription | null = null;

export const useLive = create<LiveState>((set, get) => {
  const planBuf = new Float64Array(NJ);
  let rms2 = new Float64Array(NJ);
  let lastStamp = -1;
  let rateWin: number[] = [];

  function ingest(stamp: number, q: Float64Array, root: Float64Array | null) {
    const planned = useReview.getState().planned;
    samples.push(stamp, q);
    const st = get().stats ?? { rms: new Float64Array(NJ), peak: { value: 0, joint: -1, t: 0 } };
    if (planned) {
      sampleJoints(planned, stamp, planBuf);
      const dt = lastStamp >= 0 && stamp > lastStamp ? stamp - lastStamp : 0.02;
      const a = Math.min(1, dt / 2);
      for (let j = 0; j < NJ; j++) {
        const e = q[j] - planBuf[j];
        rms2[j] = rms2[j] * (1 - a) + a * e * e;
        st.rms[j] = Math.sqrt(rms2[j]);
        if (Math.abs(e) > st.peak.value) st.peak = { value: Math.abs(e), joint: j, t: stamp };
      }
    }
    lastStamp = stamp;
    const now = performance.now();
    rateWin.push(now);
    rateWin = rateWin.filter((x) => now - x < 1000);
    set({ latest: q, latestRoot: root, latestStamp: stamp, status: 'streaming', version: get().version + 1, stats: st, rate: rateWin.length });
    // 实时模式下由数据流驱动时间轴
    usePlayback.getState().setT(stamp);
  }

  function reset() {
    samples.clear();
    rms2 = new Float64Array(NJ);
    lastStamp = -1;
    rateWin = [];
  }

  async function runService(signal: AbortSignal) {
    const rv = useReview.getState(), pb = usePlayback.getState();
    const entry = rv.clips.find((c) => c.id === rv.clipId);
    if (!rv.base || !entry) throw new Error('还没有加载动作');
    const stream = getClient().streamJointStates(
      {
        source: entry.origin === 'local' ? { case: 'trajectory', value: trajectoryToProto(rv.base) } : { case: 'clipId', value: entry.id },
        rateHz: 50,
        speed: pb.speed,
        startTime: pb.t >= duration(rv.base) - 0.05 ? 0 : pb.t,
        tracker: get().tracker,
        injectTestDeviation: rv.inject,
        loop: pb.loop,
      },
      { signal },
    );
    let order: number[] | null = null;
    for await (const m of stream) {
      const s = m.state;
      if (!s) continue;
      if (!order) order = (s.name.length ? s.name : G1_JOINT_NAMES).map((n) => JOINT_INDEX.get(n) ?? -1);
      const q = new Float64Array(NJ);
      order.forEach((j, k) => { if (j >= 0) q[j] = s.position[k]; });
      ingest(s.stamp, q, s.rootPose.length === 7 ? Float64Array.from(s.rootPose) : null);
    }
    if (!signal.aborted) set({ status: 'idle', message: '推送结束', source: null });
  }

  function runRos() {
    const url = get().rosUrl;
    let t0: number | null = null;
    const dur = duration(useReview.getState().planned ?? { fps: 30, frameCount: 1 });
    usePlayback.getState().setT(0);
    rosSub = subscribeJointStates(url, '/joint_states', {
      onOpen: () => set({ status: 'connecting', message: `已连接 ${url}，等待 /joint_states` }),
      onMessage: (msg) => {
        const stamp = stampSeconds(msg) ?? performance.now() / 1000;
        // 第一条消息对齐到动作开头；循环播放时按动作时长取余
        if (t0 === null) t0 = stamp;
        let t = stamp - t0;
        if (usePlayback.getState().loop && dur > 0) t %= dur;
        const q = new Float64Array(NJ);
        msg.name.forEach((n, k) => { const j = JOINT_INDEX.get(n); if (j !== undefined) q[j] = msg.position[k] ?? 0; });
        ingest(t, q, null);
      },
      onClose: (reason) => {
        rosSub = null;
        const local = ['localhost', '127.0.0.1'].includes(location.hostname);
        set({ status: 'error', message: local ? `${reason}。没有真机时可以先运行 npm run mock:ros` : `${reason}。在线预览页不能连本机端口，请在本地用 npm run dev 打开`, source: null });
      },
    });
  }

  return {
    source: null,
    status: 'idle',
    message: null,
    rosUrl: 'ws://localhost:9090',
    tracker: DEFAULT_TRACKER,
    latest: null,
    latestRoot: null,
    latestStamp: 0,
    rate: 0,
    version: 0,
    stats: null,

    start(source) {
      get().stop();
      reset();
      usePlayback.getState().setPlaying(false);
      set({ source, status: 'connecting', message: null, latest: null, latestRoot: null, stats: null, version: get().version + 1 });
      if (source === 'ros') { runRos(); return; }
      abort = new AbortController();
      const signal = abort.signal;
      runService(signal).catch((e: unknown) => {
        if (signal.aborted || (e instanceof ConnectError && e.code === Code.Canceled)) return;
        set({ status: 'error', message: e instanceof ConnectError ? e.rawMessage : String(e), source: null });
      });
    },

    stop() {
      abort?.abort();
      abort = null;
      rosSub?.close();
      rosSub = null;
      set({ source: null, status: get().status === 'error' ? 'error' : 'idle' });
    },

    setRosUrl(rosUrl) { set({ rosUrl }); },
    setTracker(p) { set({ tracker: { ...get().tracker, ...p } }); },
  };
});
