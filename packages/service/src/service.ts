import { Code, ConnectError, type ConnectRouter, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import {
  analyze,
  base64ToBytes,
  bytesToF32,
  duration,
  fromLafanColumns,
  G1_JOINT_NAMES,
  injectTestDeviation,
  orderLimits,
  parseUrdfLimits,
  sampleJoints,
  sampleRoot,
  Tracker,
  type Limit,
  type Trajectory,
} from '@g1/core';
import { MotionReviewService, type AnalyzeRequest, type StreamJointStatesRequest, type StreamJointStatesResponseSchema } from '@g1/proto';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { analysisToProto, rulesFromProto, trackerFromProto, trajectoryFromProto, trajectoryToProto } from './convert.js';
import { CLIP_INDEX_PATH, CLIP_SOURCE, ROBOT_URDF_PATH, type ClipMeta, type DataSource } from './source.js';

export interface ServiceOptions {
  /** 毫秒时钟，测试里可以替换。 */
  now?: () => number;
  /** 可中断的等待，测试里可以替换成立即返回。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
  });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * MotionReviewService 的实现。它不知道自己跑在 Node 还是浏览器里，也不知道走的是
 * Connect、gRPC 还是 Worker 消息，只通过 DataSource 读数据。
 */
export function createMotionReviewService(source: DataSource, opts: ServiceOptions = {}): ServiceImpl<typeof MotionReviewService> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? defaultSleep;

  let robotP: Promise<{ name: string; limits: Limit[] }> | null = null;
  const robot = () =>
    (robotP ??= source.readText(ROBOT_URDF_PATH).then((xml) => {
      const r = parseUrdfLimits(xml);
      return { name: r.robotName, limits: orderLimits(r, G1_JOINT_NAMES) };
    }));

  let indexP: Promise<ClipMeta[]> | null = null;
  const clipIndex = () => (indexP ??= source.readText(CLIP_INDEX_PATH).then((t) => JSON.parse(t) as ClipMeta[]));

  const clipCache = new Map<string, Promise<{ meta: ClipMeta; tr: Trajectory }>>();
  const loadClip = (id: string) => {
    let p = clipCache.get(id);
    if (!p) {
      p = clipIndex().then(async (list) => {
        const meta = list.find((c) => c.id === id);
        if (!meta) throw new ConnectError(`没有名为 ${id} 的动作`, Code.NotFound);
        const raw = bytesToF32(base64ToBytes(await source.readText(meta.file)));
        return { meta, tr: fromLafanColumns(raw, meta.fps) };
      });
      p.catch(() => clipCache.delete(id));
      clipCache.set(id, p);
    }
    return p;
  };

  const resolve = async (src: AnalyzeRequest['source'] | StreamJointStatesRequest['source']): Promise<Trajectory> => {
    if (src.case === 'clipId') return (await loadClip(src.value)).tr;
    if (src.case === 'trajectory') return trajectoryFromProto(src.value);
    throw new ConnectError('需要 clip_id 或 trajectory', Code.InvalidArgument);
  };

  return {
    async getRobot() {
      const r = await robot();
      return { name: r.name, joints: r.limits, urdfPath: ROBOT_URDF_PATH };
    },

    async listClips() {
      const list = await clipIndex();
      return {
        clips: list.map((c) => ({ id: c.id, name: c.name, fps: c.fps, frameCount: c.frames, hasRoot: c.cols === 36, source: CLIP_SOURCE })),
      };
    },

    async getClip(req) {
      const { meta, tr } = await loadClip(req.clipId);
      return {
        info: { id: meta.id, name: meta.name, fps: meta.fps, frameCount: tr.frameCount, hasRoot: !!tr.root, source: CLIP_SOURCE },
        trajectory: trajectoryToProto(tr),
      };
    },

    async analyze(req) {
      const t0 = now();
      const { limits } = await robot();
      let tr = await resolve(req.source);
      const rules = rulesFromProto(req.rules);
      if (req.rules?.injectTestDeviation) tr = injectTestDeviation(tr, limits);
      const a = analyze(tr, limits, rules);
      return analysisToProto(a, req.includeFrameStatus, now() - t0);
    },

    async *streamJointStates(req, ctx: HandlerContext): AsyncGenerator<MessageInitShape<typeof StreamJointStatesResponseSchema>> {
      const { limits } = await robot();
      let plan = await resolve(req.source);
      if (req.injectTestDeviation) plan = injectTestDeviation(plan, limits);
      const model = trackerFromProto(req.tracker);
      const rate = clamp(req.rateHz || 50, 1, 200);
      const speed = clamp(req.speed || 1, 0.05, 8);
      const period = 1000 / rate;
      const dtSim = speed / rate;
      const dur = duration(plan);
      const latency = model.latencyMs / 1000;

      const nj = G1_JOINT_NAMES.length;
      const target = new Float64Array(nj);
      const meas = new Float64Array(nj);
      const root = new Float64Array(7);
      const tracker = new Tracker(limits, model);
      let t = clamp(req.startTime, 0, dur);
      sampleJoints(plan, t, target);
      tracker.reset(target);

      const start = now();
      for (let seq = 0; !ctx.signal.aborted; seq++) {
        if (t > dur) {
          if (!req.loop) return;
          t = 0;
          sampleJoints(plan, 0, target);
          tracker.reset(target);
        }
        sampleJoints(plan, Math.max(0, t - latency), target);
        tracker.step(target, dtSim);
        tracker.measure(meas);
        const hasRoot = sampleRoot(plan, Math.max(0, t - latency), root);
        yield {
          state: {
            stamp: t,
            seq,
            // 关节名只在第一条消息里发，之后按同样的顺序只发数值
            name: seq === 0 ? [...G1_JOINT_NAMES] : [],
            position: Array.from(meas),
            velocity: Array.from(tracker.v),
            rootPose: hasRoot ? Array.from(root) : [],
          },
        };
        t += dtSim;
        // 按绝对时间排队，避免 setTimeout 的误差累积
        await sleep(start + (seq + 1) * period - now(), ctx.signal);
      }
    },
  };
}

/** 把服务注册到 Connect 路由上。Node 后端、Worker 里的路由和测试都调这一个函数。 */
export function registerMotionReview(router: ConnectRouter, source: DataSource, opts?: ServiceOptions): ConnectRouter {
  return router.service(MotionReviewService, createMotionReviewService(source, opts));
}
