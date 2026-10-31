import { describe, expect, it } from 'vitest';
import {
  bytesToF32,
  f32ToBytes,
  fromLafanColumns,
  G1_JOINT_NAMES,
  ImportError,
  parseCsv,
  parseJson,
  sampleJoints,
  sampleRoot,
} from '../src/index.js';

const row36 = (k: number) => [k, 0, 0.78, 0, 0, 0, 1, ...Array.from({ length: 29 }, (_, j) => k + j / 100)];

describe('parseCsv', () => {
  it('跳过表头，36 列时拆出根节点', () => {
    const text = ['x,y,z,qx,qy,qz,qw,' + G1_JOINT_NAMES.join(','), row36(0).join(','), row36(1).join(',')].join('\n');
    const tr = parseCsv(text);
    expect(tr.frameCount).toBe(2);
    expect(tr.root).not.toBeNull();
    expect(tr.root![7]).toBe(1);
    expect(tr.q[29 + 3]).toBeCloseTo(1.03, 6);
  });

  it('29 列时没有根节点', () => {
    const tr = parseCsv([Array(29).fill(0.1).join(','), Array(29).fill(0.2).join(',')].join('\n'));
    expect(tr.root).toBeNull();
    expect(tr.q[29]).toBeCloseTo(0.2, 6);
  });

  it('列数不对时给出能看懂的错误', () => {
    expect(() => parseCsv('1,2,3\n4,5,6')).toThrow(ImportError);
    expect(() => parseCsv([row36(0).join(','), row36(1).slice(0, 30).join(',')].join('\n'))).toThrow(/列数不一致/);
  });
});

describe('parseJson', () => {
  it('按关节名对齐，缺的关节取 0', () => {
    const r = parseJson(JSON.stringify({ fps: 50, joints: ['right_elbow_joint', 'unknown_joint'], frames: [[0.5, 9], [0.6, 9]] }));
    expect(r.kind).toBe('trajectory');
    if (r.kind !== 'trajectory') return;
    const tr = r.trajectory;
    const elbow = G1_JOINT_NAMES.indexOf('right_elbow_joint');
    expect(tr.fps).toBe(50);
    expect(tr.q[29 + elbow]).toBeCloseTo(0.6, 6);
    expect(tr.q[0]).toBe(0);
  });

  it('frames 可以是按帧展开的一维数组', () => {
    const r = parseJson(JSON.stringify({ joints: ['a_joint', 'left_knee_joint'], frames: [0, 1, 0, 2] }));
    expect(r.kind === 'trajectory' && r.trajectory.frameCount).toBe(2);
  });

  it('只有 events 时返回事件，并按时间排序、丢掉不完整的项', () => {
    const r = parseJson(JSON.stringify({ events: [{ t: 3, type: 'face', name: 'happy' }, { t: 1, type: 'face', name: 'listening' }, { type: 'face' }] }));
    expect(r).toEqual({ kind: 'events', events: [{ t: 1, type: 'face', name: 'listening' }, { t: 3, type: 'face', name: 'happy' }] });
  });

  it('关节名全都对不上时报错', () => {
    expect(() => parseJson(JSON.stringify({ joints: ['x'], frames: [[1]] }))).toThrow(/对不上/);
  });
});

describe('字节编解码与采样', () => {
  it('Float32 与 proto bytes 往返不丢精度，并能处理未对齐的偏移', () => {
    const a = new Float32Array([1.5, -2.25, 3.125]);
    const b = f32ToBytes(a);
    const padded = new Uint8Array(b.length + 1);
    padded.set(b, 1);
    expect(Array.from(bytesToF32(padded.subarray(1)))).toEqual([1.5, -2.25, 3.125]);
  });

  it('LAFAN1 的 36 列按帧拆开，并在帧间线性插值', () => {
    const data = new Float32Array([...row36(0), ...row36(1)]);
    const tr = fromLafanColumns(data, 10);
    const out = new Float32Array(29);
    sampleJoints(tr, 0.05, out); // 两帧正中间
    expect(out[0]).toBeCloseTo(0.5, 6);
    const r = new Float32Array(7);
    expect(sampleRoot(tr, 0.05, r)).toBe(true);
    expect(Math.hypot(r[3], r[4], r[5], r[6])).toBeCloseTo(1, 6);
  });
});
