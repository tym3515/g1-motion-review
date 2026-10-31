import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import URDFLoader, { type URDFJoint, type URDFRobot } from 'urdf-loader';
import { base64ToBytes } from '@g1/core';
import type { Colors } from '../lib/theme';

interface PackedMesh { p: string; i: string; i32: boolean }

const DEG = Math.PI / 180;
const HOME = { pos: new THREE.Vector3(2.5, 1.45, 2.9), target: new THREE.Vector3(0, 0.7, 0) };

/**
 * three.js 场景。它不订阅任何 store：外面每帧把姿态和着色状态传进来。
 * 渲染层和 React 状态分开，播放时不会因为 60 Hz 的时间变化触发组件重渲染。
 */
export class RobotScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.05, 200);
  readonly controls: OrbitControls;
  private readonly world = new THREE.Group();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.3);
  private readonly ground: THREE.Mesh;
  private grid: THREE.GridHelper | null = null;
  private robot: URDFRobot | null = null;
  private ghost: URDFRobot | null = null;
  private readonly ghostMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.38, depthWrite: false, roughness: 0.5 });
  private jointNames: string[] = [];
  private jointMeshes: THREE.Mesh[][] = [];
  private meshState: number[] = [];
  private colors: Colors;
  private readonly tmp = new THREE.Vector3();
  follow = true;

  constructor(private readonly canvas: HTMLCanvasElement, colors: Colors) {
    this.colors = colors;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera.position.copy(HOME.pos);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(HOME.target);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 14;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8a96, 1.15));
    this.sun.position.set(2.2, 5, 2.8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -2.2, near: 0.5, far: 14 });
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-3, 2.5, -2.5);
    this.scene.add(rim);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.2 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // URDF 是 Z 朝上，three.js 是 Y 朝上：整体绕 X 轴转 -90°
    this.world.rotation.x = -Math.PI / 2;
    this.scene.add(this.world);
    this.applyColors(colors);
  }

  applyColors(c: Colors) {
    this.colors = c;
    this.scene.background = new THREE.Color(c.stage);
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    this.grid = new THREE.GridHelper(16, 32, c['grid-major'], c['grid-minor']);
    this.grid.position.y = 0.001;
    this.scene.add(this.grid);
    this.ghostMat.color.set(c.live);
    this.meshState.fill(-1);
  }

  /** 加载 URDF。网格事先简化并打包成一个 JSON（顶点 Float32 + 索引，base64），一次请求拿全。 */
  async load(urdfUrl: string, meshBundleUrl: string, jointNames: string[], onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const bundleP = fetch(meshBundleUrl).then((r) => {
      if (!r.ok) throw new Error(`网格包读取失败：HTTP ${r.status}`);
      return r.json() as Promise<Record<string, PackedMesh>>;
    });
    const manager = new THREE.LoadingManager();
    if (onProgress) manager.onProgress = (_u, loaded, total) => onProgress(loaded, total);
    const loader = new URDFLoader(manager);
    loader.loadMeshCb = (path, mgr, material, done) => {
      mgr.itemStart(path);
      const key = path.split('/').pop() ?? path;
      bundleP
        .then((bundle) => {
          const m = bundle[key];
          if (!m) throw new Error(`网格包里没有 ${key}`);
          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(base64ToBytes(m.p).buffer), 3));
          const idx = base64ToBytes(m.i).buffer;
          geom.setIndex(new THREE.BufferAttribute(m.i32 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
          let g: THREE.BufferGeometry = geom;
          try { g = toCreasedNormals(geom, 32 * DEG); } catch { geom.computeVertexNormals(); }
          const src = (material as THREE.MeshPhongMaterial | undefined)?.color;
          const dark = src ? (src.r + src.g + src.b) / 3 < 0.3 : false;
          const mat = new THREE.MeshStandardMaterial({ color: dark ? 0x2c3238 : 0xc4cad0, roughness: dark ? 0.62 : 0.46, metalness: dark ? 0.25 : 0.2 });
          const mesh = new THREE.Mesh(g, mat);
          mesh.castShadow = true;
          mesh.userData.base = mat.color.clone();
          done(mesh);
        })
        .catch((err: Error) => done(null as unknown as THREE.Object3D, err))
        .finally(() => mgr.itemEnd(path));
    };

    const robot = await new Promise<URDFRobot>((resolve, reject) => {
      let r: URDFRobot | null = null;
      manager.onLoad = () => { if (r) resolve(r); };
      loader.load(urdfUrl, (x) => { r = x; }, undefined, reject);
      setTimeout(() => reject(new Error('加载超时')), 60000);
    });

    // 显示真实指令值：不让加载器把越限角度夹回限位以内
    for (const jt of Object.values(robot.joints)) jt.ignoreLimits = true;
    robot.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });

    this.jointNames = jointNames;
    this.jointMeshes = jointNames.map((name) => {
      const jt = robot.joints[name] as URDFJoint | undefined;
      const out: THREE.Mesh[] = [];
      const link = jt?.children.find((c) => (c as unknown as { isURDFLink?: boolean }).isURDFLink);
      if (link) collectMeshes(link, out);
      for (const m of out) m.material = (m.material as THREE.Material).clone();
      return out;
    });
    this.meshState = jointNames.map(() => -1);

    // 实际状态用一个半透明的机器人叠在上面
    const ghost = robot.clone(true) as URDFRobot;
    ghost.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = this.ghostMat; m.castShadow = false; } });
    for (const jt of Object.values(ghost.joints)) jt.ignoreLimits = true;
    ghost.visible = false;

    this.robot = robot;
    this.ghost = ghost;
    this.world.add(robot, ghost);
  }

  get loaded() { return !!this.robot; }

  setPose(q: ArrayLike<number>, root: ArrayLike<number> | null) {
    if (!this.robot) return;
    applyPose(this.robot, this.jointNames, q, root);
    this.robot.updateMatrixWorld(true);
    this.robot.getWorldPosition(this.tmp);
    const tx = this.tmp.x, tz = this.tmp.z;
    if (this.follow) {
      const dx = tx - this.controls.target.x, dz = tz - this.controls.target.z;
      this.controls.target.x += dx; this.controls.target.z += dz;
      this.camera.position.x += dx; this.camera.position.z += dz;
    }
    // 地面网格按 0.5 m 步长跟着机器人走
    if (this.grid) { this.grid.position.x = Math.round(tx / 0.5) * 0.5; this.grid.position.z = Math.round(tz / 0.5) * 0.5; }
    this.ground.position.set(tx, 0, tz);
    this.sun.target.position.set(tx, 0, tz);
    this.sun.position.set(tx + 2.2, 5, tz + 2.8);
  }

  setGhost(q: ArrayLike<number> | null, root: ArrayLike<number> | null) {
    if (!this.ghost) return;
    this.ghost.visible = !!q;
    if (q) applyPose(this.ghost, this.jointNames, q, root ?? (this.robot ? poseOf(this.robot) : null));
  }

  /** severity: 0 正常 1 贴近 2 超限；sel 是选中的关节。 */
  setHighlights(severity: (j: number) => number, sel: number) {
    const c = this.colors;
    for (let j = 0; j < this.jointMeshes.length; j++) {
      const s = severity(j);
      const code = s * 2 + (j === sel ? 1 : 0);
      if (this.meshState[j] === code) continue;
      this.meshState[j] = code;
      for (const m of this.jointMeshes[j]) {
        const mat = m.material as THREE.MeshStandardMaterial;
        if (s === 2) { mat.color.set(c.bad); mat.emissive.set(c.bad).multiplyScalar(0.25); }
        else if (s === 1) { mat.color.set(c['warn-fill']); mat.emissive.setRGB(0, 0, 0); }
        else if (j === sel) { mat.color.copy(m.userData.base as THREE.Color).lerp(new THREE.Color(c.accent), 0.55); mat.emissive.setRGB(0, 0, 0); }
        else { mat.color.copy(m.userData.base as THREE.Color); mat.emissive.setRGB(0, 0, 0); }
      }
    }
  }

  resetCamera() {
    const off = HOME.pos.clone().sub(HOME.target);
    const base = this.robot ? new THREE.Vector3(this.tmp.x, HOME.target.y, this.tmp.z) : HOME.target.clone();
    this.controls.target.copy(base);
    this.camera.position.copy(base).add(off);
  }

  render() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const pr = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.round(w * pr) || this.canvas.height !== Math.round(h * pr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.controls.dispose();
    this.renderer.dispose();
  }
}

function collectMeshes(obj: THREE.Object3D, out: THREE.Mesh[]) {
  for (const c of obj.children) {
    const jt = c as unknown as URDFJoint;
    if (jt.isURDFJoint && jt.jointType !== 'fixed') continue;
    if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
    collectMeshes(c, out);
  }
}

function applyPose(robot: URDFRobot, names: string[], q: ArrayLike<number>, root: ArrayLike<number> | null) {
  for (let j = 0; j < names.length; j++) robot.joints[names[j]]?.setJointValue(q[j]);
  if (root) {
    robot.position.set(root[0], root[1], root[2]);
    robot.quaternion.set(root[3], root[4], root[5], root[6]);
  } else {
    robot.position.set(0, 0, 0.793);
    robot.quaternion.identity();
  }
}

function poseOf(robot: URDFRobot): number[] {
  const p = robot.position, q = robot.quaternion;
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
}
