/**
 * 服务只通过这个接口读数据，路径相对数据根目录（apps/web/public/data）。
 * Node 后端用文件系统实现，浏览器 Worker 用 fetch 实现，测试里也用文件系统。
 */
export interface DataSource {
  readText(path: string): Promise<string>;
}

/** motions/index.json 里每一项的格式。 */
export interface ClipMeta {
  id: string;
  name: string;
  /** 相对数据根目录的路径，内容是 base64 编码的 float32 小端数据 */
  file: string;
  fps: number;
  frames: number;
  /** 每帧的数值个数，LAFAN1 格式为 36 */
  cols: number;
}

export const ROBOT_URDF_PATH = 'g1/g1_29dof_rev_1_0.urdf.xml';
export const CLIP_INDEX_PATH = 'motions/index.json';
export const CLIP_SOURCE = 'Unitree LAFAN1 Retargeting Dataset（BSD-3-Clause），源自 Ubisoft LAFAN1 动捕';
