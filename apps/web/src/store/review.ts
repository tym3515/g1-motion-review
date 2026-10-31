import { create } from 'zustand';
import {
  computeVelocity,
  DEFAULT_RULES,
  duration,
  groupSeverity,
  ImportError,
  injectTestDeviation,
  parseCsv,
  parseJson,
  type Analysis,
  type Limit,
  type Rules,
  type TimelineEvent,
  type Trajectory,
} from '@g1/core';
import { analysisFromProto, trajectoryFromProto, trajectoryToProto } from '@g1/service';
import { ConnectError } from '@connectrpc/connect';
import { backendLabel, makeClient, type Backend, type ReviewClient } from '../api/client';
import { usePlayback } from './playback';

export interface ClipEntry {
  id: string;
  name: string;
  fps: number;
  frames: number;
  /** server：服务端已有的动作，按 id 调用；local：本地导入的，整条轨迹随请求上传 */
  origin: 'server' | 'local';
  local?: Trajectory;
}

interface ReviewState {
  backend: Backend;
  bootState: 'booting' | 'ready' | 'error';
  bootError: string | null;
  robotName: string;
  limits: Limit[] | null;
  urdfPath: string;
  clips: ClipEntry[];
  clipId: string | null;
  loadingClip: boolean;
  /** 加载进来的原始轨迹 */
  base: Trajectory | null;
  /** 实际显示和审核的轨迹：勾选测试偏差时在 base 上叠加偏差 */
  planned: Trajectory | null;
  velocity: Float32Array | null;
  analysis: Analysis | null;
  groupSev: Uint8Array | null;
  /** 服务端计算耗时和整次调用耗时，毫秒 */
  timing: { server: number; roundTrip: number } | null;
  analyzing: boolean;
  analyzeError: string | null;
  rules: Rules;
  inject: boolean;
  sel: number;
  curveMode: 'pos' | 'vel';
  curveRange: 'all' | 'win';
  notice: { text: string; error: boolean } | null;

  boot(): Promise<void>;
  setBackend(b: Backend): Promise<void>;
  selectClip(id: string): Promise<void>;
  setRules(r: Partial<Rules>): void;
  setInject(v: boolean): void;
  select(j: number): void;
  setCurveMode(m: 'pos' | 'vel'): void;
  setCurveRange(r: 'all' | 'win'): void;
  importFile(file: File): Promise<void>;
  dismissNotice(): void;
}

let client: ReviewClient = makeClient({ kind: 'worker' });
export const getClient = () => client;

let analyzeSeq = 0;
let analyzeTimer: ReturnType<typeof setTimeout> | null = null;

const errText = (e: unknown) => (e instanceof ConnectError ? e.rawMessage : e instanceof Error ? e.message : String(e));

export const useReview = create<ReviewState>((set, get) => {
  /** 调 Analyze。滑块拖动时会连续触发，只保留最后一次的结果。 */
  async function runAnalyze() {
    const { base, clipId, clips, limits, rules, inject } = get();
    if (!base || !clipId || !limits) return;
    const entry = clips.find((c) => c.id === clipId);
    const my = ++analyzeSeq;
    set({ analyzing: true });
    const t0 = performance.now();
    try {
      const res = await client.analyze({
        source: entry?.origin === 'local' ? { case: 'trajectory', value: trajectoryToProto(base) } : { case: 'clipId', value: clipId },
        rules: { marginRad: rules.marginRad, velocityFactor: rules.velocityFactor, injectTestDeviation: inject },
        includeFrameStatus: true,
      });
      if (my !== analyzeSeq) return;
      const analysis = analysisFromProto(res);
      // 显示用的轨迹要和服务端审核的完全一致，偏差用同一个 core 函数在本地叠加
      const planned = inject ? injectTestDeviation(base, limits) : base;
      set({
        analysis,
        planned,
        velocity: computeVelocity(planned.q, planned.frameCount, planned.jointNames.length, planned.fps),
        groupSev: groupSeverity(analysis.status, analysis.frameCount, planned.jointNames.length),
        timing: { server: res.elapsedMs, roundTrip: performance.now() - t0 },
        analyzing: false,
        analyzeError: null,
      });
    } catch (e) {
      if (my !== analyzeSeq) return;
      set({ analyzing: false, analyzeError: `审核失败：${errText(e)}` });
    }
  }
  const scheduleAnalyze = (delay = 90) => {
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => void runAnalyze(), delay);
  };

  async function loadTrajectory(entry: ClipEntry): Promise<Trajectory> {
    if (entry.origin === 'local' && entry.local) return entry.local;
    const res = await client.getClip({ clipId: entry.id });
    if (!res.trajectory) throw new Error('服务端没有返回轨迹');
    return trajectoryFromProto(res.trajectory);
  }

  return {
    backend: { kind: 'worker' },
    bootState: 'booting',
    bootError: null,
    robotName: '',
    limits: null,
    urdfPath: '',
    clips: [],
    clipId: null,
    loadingClip: false,
    base: null,
    planned: null,
    velocity: null,
    analysis: null,
    groupSev: null,
    timing: null,
    analyzing: false,
    analyzeError: null,
    rules: DEFAULT_RULES,
    inject: false,
    sel: 3,
    curveMode: 'pos',
    curveRange: 'all',
    notice: null,

    async boot() {
      set({ bootState: 'booting', bootError: null });
      try {
        const [robot, list] = await Promise.all([client.getRobot({}), client.listClips({})]);
        const locals = get().clips.filter((c) => c.origin === 'local');
        const clips: ClipEntry[] = [
          ...list.clips.map((c): ClipEntry => ({ id: c.id, name: c.name, fps: c.fps, frames: c.frameCount, origin: 'server' })),
          ...locals,
        ];
        set({
          robotName: robot.name,
          limits: robot.joints.map((j) => ({ name: j.name, lower: j.lower, upper: j.upper, velocity: j.velocity, effort: j.effort })),
          urdfPath: robot.urdfPath,
          clips,
          bootState: 'ready',
        });
        const keep = get().clipId;
        await get().selectClip(keep && clips.some((c) => c.id === keep) ? keep : clips[0].id);
      } catch (e) {
        const b = get().backend;
        const local = ['localhost', '127.0.0.1'].includes(location.hostname);
        const hint = b.kind === 'worker'
          ? ''
          : local
            ? `。先在项目根目录运行 npm run dev:server，确认后端在 ${b.baseUrl} 上监听`
            : '。在线预览页受浏览器安全策略限制，只能用浏览器内 Worker；要连本地后端，请在本地用 npm run dev 打开页面';
        set({ bootState: 'error', bootError: `连不上 ${backendLabel(b)}：${errText(e)}${hint}` });
      }
    },

    async setBackend(b) {
      client = makeClient(b);
      set({ backend: b });
      await get().boot();
    },

    async selectClip(id) {
      const entry = get().clips.find((c) => c.id === id);
      if (!entry) return;
      usePlayback.getState().setPlaying(false);
      set({ clipId: id, loadingClip: true });
      try {
        const base = await loadTrajectory(entry);
        if (get().clipId !== id) return;
        const { limits, inject } = get();
        const planned = inject && limits ? injectTestDeviation(base, limits) : base;
        set({ base, planned, analysis: null, groupSev: null, loadingClip: false });
        usePlayback.getState().setT(0);
        await runAnalyze();
      } catch (e) {
        set({ loadingClip: false, notice: { text: `动作没有加载成功：${errText(e)}`, error: true } });
      }
    },

    setRules(r) { set({ rules: { ...get().rules, ...r } }); scheduleAnalyze(); },
    setInject(v) { set({ inject: v }); scheduleAnalyze(0); },
    select(j) { set({ sel: j }); },
    setCurveMode(curveMode) { set({ curveMode }); },
    setCurveRange(curveRange) { set({ curveRange }); },
    dismissNotice() { set({ notice: null }); },

    async importFile(file) {
      try {
        const text = await file.text();
        const parsed = /\.json$/i.test(file.name) ? parseJson(text) : { kind: 'trajectory' as const, trajectory: parseCsv(text) };
        if (parsed.kind === 'events') {
          const { base, planned, clipId } = get();
          if (!base || !planned) throw new ImportError('还没有加载动作');
          const events: TimelineEvent[] = parsed.events;
          set({ base: { ...base, events }, planned: { ...planned, events }, clips: get().clips.map((c) => (c.id === clipId && c.local ? { ...c, local: { ...c.local, events } } : c)) });
          set({ notice: { text: `已把 ${events.length} 个事件叠加到当前动作，时间轴最下面一行就是事件。`, error: false } });
          return;
        }
        const tr = parsed.trajectory;
        if (tr.frameCount < 2) throw new ImportError('至少需要 2 帧');
        const id = `local:${file.name}:${Date.now()}`;
        const entry: ClipEntry = { id, name: `导入：${file.name}`, fps: tr.fps, frames: tr.frameCount, origin: 'local', local: tr };
        set({ clips: [...get().clips, entry] });
        await get().selectClip(id);
        set({
          notice: {
            text: `已导入 ${file.name}：${tr.frameCount.toLocaleString('zh-CN')} 帧，${tr.root ? '含根节点轨迹' : '不含根节点，机器人原地播放'}，按 ${tr.fps} fps 解析${tr.events.length ? `，含 ${tr.events.length} 个事件` : ''}。审核时整条轨迹随 Analyze 请求上传，时长 ${duration(tr).toFixed(1)} s。`,
            error: false,
          },
        });
      } catch (e) {
        set({
          notice: {
            text: `没能导入 ${file.name}：${errText(e)}。CSV 每行 36 列（根节点 x y z qx qy qz qw + 29 个关节弧度，列序同宇树 LAFAN1 重定向数据集）或 29 列；JSON 为 {"fps":30,"joints":[关节名],"frames":[[…]],"events":[…]}，只含 events 的 JSON 会叠加到当前动作上。`,
            error: true,
          },
        });
      }
    },
  };
});

/** 当前动作时长，秒。 */
export const clipDuration = () => {
  const p = useReview.getState().planned;
  return p ? duration(p) : 0;
};
