import { XMLParser } from 'fast-xml-parser';

export interface Limit {
  name: string;
  /** 弧度 */
  lower: number;
  /** 弧度 */
  upper: number;
  /** 弧度每秒，URDF 里通常是电机空载最高速度 */
  velocity: number;
  /** 牛米 */
  effort: number;
}

export interface RobotLimits {
  robotName: string;
  /** 所有 revolute / prismatic 关节，按 URDF 中出现的顺序 */
  joints: Map<string, Limit>;
}

type XmlNode = Record<string, unknown>;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * 从 URDF 文本里读出关节限位。只关心 &lt;joint&gt; 的 name、type 和 &lt;limit&gt;，
 * 不依赖 DOMParser，所以浏览器、Worker 和 Node 都能用。
 */
export function parseUrdfLimits(urdf: string): RobotLimits {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', allowBooleanAttributes: true });
  const doc = parser.parse(urdf) as { robot?: XmlNode };
  const robot = doc.robot;
  if (!robot) throw new Error('URDF 里没有 <robot> 根节点');
  const joints = new Map<string, Limit>();
  for (const jn of asArray(robot.joint as XmlNode | XmlNode[] | undefined)) {
    const type = String(jn['@_type'] ?? '');
    if (type !== 'revolute' && type !== 'prismatic') continue;
    const lim = jn.limit as XmlNode | undefined;
    const name = String(jn['@_name']);
    const num = (k: string) => (lim && lim[k] !== undefined ? Number(lim[k]) : 0);
    joints.set(name, {
      name,
      lower: num('@_lower'),
      upper: num('@_upper'),
      velocity: num('@_velocity'),
      effort: num('@_effort'),
    });
  }
  return { robotName: String(robot['@_name'] ?? ''), joints };
}

/** 按给定的关节顺序取出限位；缺失的关节直接报错，避免静默地用 0 当限位。 */
export function orderLimits(limits: RobotLimits, names: readonly string[]): Limit[] {
  return names.map((n) => {
    const l = limits.joints.get(n);
    if (!l) throw new Error(`URDF 里找不到关节 ${n}`);
    return l;
  });
}
