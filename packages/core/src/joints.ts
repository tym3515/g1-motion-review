/** 身体部位分组，用于时间轴按部位汇总。 */
export type JointGroup = 'L_LEG' | 'R_LEG' | 'WAIST' | 'L_ARM' | 'R_ARM';

export interface JointInfo {
  /** URDF 里的关节名。 */
  name: string;
  /** 界面上显示的中文名。 */
  zh: string;
  group: JointGroup;
}

export const GROUPS: ReadonlyArray<{ id: JointGroup; zh: string }> = [
  { id: 'L_LEG', zh: '左腿' },
  { id: 'R_LEG', zh: '右腿' },
  { id: 'WAIST', zh: '腰' },
  { id: 'L_ARM', zh: '左臂' },
  { id: 'R_ARM', zh: '右臂' },
];

const j = (name: string, zh: string, group: JointGroup): JointInfo => ({ name, zh, group });

/**
 * G1 29 自由度版本的旋转关节，顺序与宇树 LAFAN1 重定向数据集的 CSV 列顺序一致
 * （前 7 列是根节点位姿，之后依次是这 29 个关节）。
 */
export const G1_JOINTS: readonly JointInfo[] = [
  j('left_hip_pitch_joint', '左髋 俯仰', 'L_LEG'),
  j('left_hip_roll_joint', '左髋 横滚', 'L_LEG'),
  j('left_hip_yaw_joint', '左髋 偏航', 'L_LEG'),
  j('left_knee_joint', '左膝', 'L_LEG'),
  j('left_ankle_pitch_joint', '左踝 俯仰', 'L_LEG'),
  j('left_ankle_roll_joint', '左踝 横滚', 'L_LEG'),
  j('right_hip_pitch_joint', '右髋 俯仰', 'R_LEG'),
  j('right_hip_roll_joint', '右髋 横滚', 'R_LEG'),
  j('right_hip_yaw_joint', '右髋 偏航', 'R_LEG'),
  j('right_knee_joint', '右膝', 'R_LEG'),
  j('right_ankle_pitch_joint', '右踝 俯仰', 'R_LEG'),
  j('right_ankle_roll_joint', '右踝 横滚', 'R_LEG'),
  j('waist_yaw_joint', '腰 偏航', 'WAIST'),
  j('waist_roll_joint', '腰 横滚', 'WAIST'),
  j('waist_pitch_joint', '腰 俯仰', 'WAIST'),
  j('left_shoulder_pitch_joint', '左肩 俯仰', 'L_ARM'),
  j('left_shoulder_roll_joint', '左肩 横滚', 'L_ARM'),
  j('left_shoulder_yaw_joint', '左肩 偏航', 'L_ARM'),
  j('left_elbow_joint', '左肘', 'L_ARM'),
  j('left_wrist_roll_joint', '左腕 横滚', 'L_ARM'),
  j('left_wrist_pitch_joint', '左腕 俯仰', 'L_ARM'),
  j('left_wrist_yaw_joint', '左腕 偏航', 'L_ARM'),
  j('right_shoulder_pitch_joint', '右肩 俯仰', 'R_ARM'),
  j('right_shoulder_roll_joint', '右肩 横滚', 'R_ARM'),
  j('right_shoulder_yaw_joint', '右肩 偏航', 'R_ARM'),
  j('right_elbow_joint', '右肘', 'R_ARM'),
  j('right_wrist_roll_joint', '右腕 横滚', 'R_ARM'),
  j('right_wrist_pitch_joint', '右腕 俯仰', 'R_ARM'),
  j('right_wrist_yaw_joint', '右腕 偏航', 'R_ARM'),
];

export const G1_JOINT_NAMES: readonly string[] = G1_JOINTS.map((x) => x.name);

export const JOINT_INDEX: ReadonlyMap<string, number> = new Map(G1_JOINTS.map((x, i) => [x.name, i]));

/** 每个关节所属分组在 GROUPS 中的下标。 */
export const JOINT_GROUP_INDEX: readonly number[] = G1_JOINTS.map((x) => GROUPS.findIndex((g) => g.id === x.group));

/** LAFAN1 CSV 每行的列数：根节点 7 列 + 29 个关节。 */
export const LAFAN_COLUMNS = 7 + G1_JOINTS.length;
