import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  bytesToF32,
  DEFAULT_RULES,
  DEFAULT_TRACKER,
  f32ToBytes,
  G1_JOINT_NAMES,
  JOINT_INDEX,
  type Analysis,
  type Rules,
  type TimelineEvent,
  type TrackerModel,
  type Trajectory,
  type Verdict,
} from '@g1/core';
import {
  AnalyzeResponseSchema,
  TrajectorySchema,
  Verdict as PbVerdict,
  type AnalyzeResponse,
  type ReviewRules,
  type TrackerModel as PbTracker,
  type Trajectory as PbTrajectory,
} from '@g1/proto';

// ---------- 轨迹 ----------

export function trajectoryToProto(tr: Trajectory): PbTrajectory {
  return create(TrajectorySchema, {
    fps: tr.fps,
    frameCount: tr.frameCount,
    jointNames: tr.jointNames,
    positions: f32ToBytes(tr.q),
    rootPoses: tr.root ? f32ToBytes(tr.root) : new Uint8Array(),
    events: tr.events.map(({ t, type, name, ...rest }) => ({ t, type, name: name ?? '', payloadJson: Object.keys(rest).length ? JSON.stringify(rest) : '' })),
  });
}

/**
 * proto 轨迹转成 G1 关节顺序的内存轨迹。客户端可以只传部分关节、顺序也可以不同，
 * 按名字对齐，没传的关节取 0。数据长度不对时返回 InvalidArgument。
 */
export function trajectoryFromProto(pb: PbTrajectory): Trajectory {
  const names = pb.jointNames.length ? pb.jointNames : [...G1_JOINT_NAMES];
  const n = pb.frameCount;
  const fps = pb.fps > 0 ? pb.fps : 30;
  if (n < 2) throw new ConnectError('轨迹至少需要 2 帧', Code.InvalidArgument);
  const src = bytesToF32(pb.positions);
  if (src.length !== n * names.length) {
    throw new ConnectError(`positions 有 ${src.length} 个数，应为 frame_count × joint_names = ${n * names.length}`, Code.InvalidArgument);
  }
  const map = names.map((nm) => JOINT_INDEX.get(nm) ?? -1);
  if (!map.some((x) => x >= 0)) throw new ConnectError('joint_names 与 G1 的关节名对不上', Code.InvalidArgument);
  const nj = G1_JOINT_NAMES.length;
  let q: Float32Array;
  if (names.length === nj && map.every((x, i) => x === i)) q = src;
  else {
    q = new Float32Array(n * nj);
    for (let f = 0; f < n; f++) map.forEach((jj, k) => { if (jj >= 0) q[f * nj + jj] = src[f * names.length + k]; });
  }
  let root: Float32Array | null = null;
  if (pb.rootPoses.length) {
    root = bytesToF32(pb.rootPoses);
    if (root.length !== n * 7) throw new ConnectError(`root_poses 有 ${root.length} 个数，应为 frame_count × 7`, Code.InvalidArgument);
  }
  const events: TimelineEvent[] = pb.events.map((e) => ({ ...(e.payloadJson ? (JSON.parse(e.payloadJson) as object) : {}), t: e.t, type: e.type, ...(e.name ? { name: e.name } : {}) }));
  return { fps, frameCount: n, jointNames: [...G1_JOINT_NAMES], q, root, events };
}

// ---------- 规则与跟踪模型 ----------

export function rulesFromProto(r: ReviewRules | undefined): Rules {
  if (!r) return DEFAULT_RULES;
  return {
    marginRad: Math.max(0, r.marginRad),
    velocityFactor: r.velocityFactor > 0 ? r.velocityFactor : DEFAULT_RULES.velocityFactor,
  };
}

export function trackerFromProto(t: PbTracker | undefined): TrackerModel {
  if (!t || t.bandwidthHz <= 0) return DEFAULT_TRACKER;
  return {
    bandwidthHz: t.bandwidthHz,
    latencyMs: Math.max(0, t.latencyMs),
    noiseDeg: Math.max(0, t.noiseDeg),
    enforceLimits: t.enforceLimits,
    velocityFactor: Math.max(0, t.velocityFactor),
  };
}

// ---------- 审核结果 ----------

const VERDICT_TO_PB: Record<Verdict, PbVerdict> = {
  pass: PbVerdict.PASS,
  pass_near_limit: PbVerdict.PASS_NEAR_LIMIT,
  fail: PbVerdict.FAIL,
};

export function analysisToProto(a: Analysis, includeStatus: boolean, elapsedMs: number): AnalyzeResponse {
  return create(AnalyzeResponseSchema, {
    verdict: VERDICT_TO_PB[a.verdict],
    frameCount: a.frameCount,
    overFrames: a.overFrames,
    velocityFrames: a.velocityFrames,
    nearFrames: a.nearFrames,
    segments: a.segments.map((s) => ({
      startFrame: s.startFrame,
      endFrame: s.endFrame,
      hits: s.hits.map((h) => ({
        jointIndex: h.joint,
        jointName: G1_JOINT_NAMES[h.joint] ?? '',
        positionExcess: h.positionExcess,
        peakVelocity: h.peakVelocity,
        velocityLimit: h.velocityLimit,
      })),
    })),
    joints: a.joints.map((j) => ({ overFrames: j.overFrames, nearFrames: j.nearFrames, velocityFrames: j.velocityFrames })),
    frameStatus: includeStatus ? a.status : new Uint8Array(),
    elapsedMs,
  });
}

export function analysisFromProto(r: AnalyzeResponse): Analysis {
  const verdict: Verdict = r.verdict === PbVerdict.FAIL ? 'fail' : r.verdict === PbVerdict.PASS_NEAR_LIMIT ? 'pass_near_limit' : 'pass';
  return {
    verdict,
    frameCount: r.frameCount,
    overFrames: r.overFrames,
    velocityFrames: r.velocityFrames,
    nearFrames: r.nearFrames,
    segments: r.segments.map((s) => ({
      startFrame: s.startFrame,
      endFrame: s.endFrame,
      hits: s.hits.map((h) => ({ joint: h.jointIndex, positionExcess: h.positionExcess, peakVelocity: h.peakVelocity, velocityLimit: h.velocityLimit })),
    })),
    joints: r.joints.map((j) => ({ overFrames: j.overFrames, nearFrames: j.nearFrames, velocityFrames: j.velocityFrames })),
    status: r.frameStatus,
  };
}
