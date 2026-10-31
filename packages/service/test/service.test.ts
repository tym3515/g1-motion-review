import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { G1_JOINT_NAMES } from '@g1/core';
import { MotionReviewService, TrajectorySchema, Verdict } from '@g1/proto';
import { registerMotionReview, type DataSource } from '../src/index.js';

const root = fileURLToPath(new URL('../../../apps/web/public/data/', import.meta.url));
const fsSource: DataSource = { readText: (p) => readFile(root + p, 'utf8') };

/** 走完整的 Connect 路由：请求和响应都会序列化成二进制再解回来，和真实网络调用一致。 */
function client() {
  const transport = createRouterTransport((router) => registerMotionReview(router, fsSource, { sleep: async () => {} }));
  return createClient(MotionReviewService, transport);
}

describe('MotionReviewService', () => {
  it('GetRobot 按数据列顺序返回 29 个关节限位', async () => {
    const r = await client().getRobot({});
    expect(r.name).toBe('g1_29dof_rev_1_0');
    expect(r.joints.map((j) => j.name)).toEqual(G1_JOINT_NAMES);
    expect(r.urdfPath).toMatch(/\.urdf\.xml$/);
  });

  it('ListClips 和 GetClip', async () => {
    const c = client();
    const { clips } = await c.listClips({});
    expect(clips.map((x) => x.id)).toEqual(['dance1_subject2', 'fightAndSports1_subject1', 'jumps1_subject1']);
    const { info, trajectory } = await c.getClip({ clipId: 'dance1_subject2' });
    expect(info?.frameCount).toBe(3945);
    expect(trajectory?.positions.byteLength).toBe(3945 * 29 * 4);
    expect(trajectory?.rootPoses.byteLength).toBe(3945 * 7 * 4);
  });

  // 这组数字与最早的单文件原生 JS 版本逐项一致，用来保证重写没有改变检查结果
  it('Analyze 舞蹈 1 的结果与原版一致', async () => {
    const r = await client().analyze({ source: { case: 'clipId', value: 'dance1_subject2' }, rules: { marginRad: (5 * Math.PI) / 180, velocityFactor: 0.5 } });
    expect({ over: r.overFrames, vel: r.velocityFrames, near: r.nearFrames, segs: r.segments.length }).toEqual({ over: 0, vel: 234, near: 2051, segs: 120 });
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.frameStatus.byteLength).toBe(0);
  });

  it('叠加测试偏差后出现位置超限，并返回逐帧状态', async () => {
    const r = await client().analyze({
      source: { case: 'clipId', value: 'dance1_subject2' },
      rules: { marginRad: (5 * Math.PI) / 180, velocityFactor: 0.5, injectTestDeviation: true },
      includeFrameStatus: true,
    });
    expect({ over: r.overFrames, vel: r.velocityFrames, near: r.nearFrames, segs: r.segments.length }).toEqual({ over: 124, vel: 234, near: 2048, segs: 122 });
    expect(r.frameStatus.byteLength).toBe(3945 * 29);
  });

  it('客户端上传的轨迹与服务端动作得到相同结论', async () => {
    const c = client();
    const { trajectory } = await c.getClip({ clipId: 'jumps1_subject1' });
    const rules = { marginRad: 0.05, velocityFactor: 0.6 };
    const a = await c.analyze({ source: { case: 'clipId', value: 'jumps1_subject1' }, rules });
    const b = await c.analyze({ source: { case: 'trajectory', value: trajectory! }, rules });
    expect(b.segments.length).toBe(a.segments.length);
    expect(b.nearFrames).toBe(a.nearFrames);
  });

  it('错误用标准的 gRPC 状态码返回', async () => {
    const c = client();
    await expect(c.getClip({ clipId: 'nope' })).rejects.toMatchObject({ code: Code.NotFound });
    const bad = create(TrajectorySchema, { fps: 30, frameCount: 10, positions: new Uint8Array(12) });
    const err = await c.analyze({ source: { case: 'trajectory', value: bad } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
  });

  it('StreamJointStates 按频率推进时间，名字只在第一条里，限位生效时不越界', async () => {
    const c = client();
    const { joints } = await c.getRobot({});
    const got: { stamp: number; seq: number; names: number; pos: number[] }[] = [];
    const stream = c.streamJointStates({
      source: { case: 'clipId', value: 'dance1_subject2' },
      rateHz: 50,
      speed: 1,
      startTime: 10,
      injectTestDeviation: true,
      tracker: { bandwidthHz: 6, latencyMs: 40, noiseDeg: 0, enforceLimits: true, velocityFactor: 0.5 },
    });
    // 提前 break 会让客户端取消这次调用，服务端的循环随之结束
    for await (const m of stream) {
      got.push({ stamp: m.state!.stamp, seq: m.state!.seq, names: m.state!.name.length, pos: m.state!.position });
      if (got.length === 40) break;
    }
    expect(got).toHaveLength(40);
    expect(got[0].names).toBe(29);
    expect(got[1].names).toBe(0);
    expect(got[1].stamp - got[0].stamp).toBeCloseTo(0.02, 6);
    for (const g of got) g.pos.forEach((x, j) => {
      expect(x).toBeGreaterThanOrEqual(joints[j].lower - 1e-9);
      expect(x).toBeLessThanOrEqual(joints[j].upper + 1e-9);
    });
  });
});
