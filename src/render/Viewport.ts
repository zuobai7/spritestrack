import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Editor } from '../editor/Editor';
import { raycastAxisPlane, raycastGrid, raycastPlaneY, type Vec3 } from '../core/raycast';
import { boxCells, floodCells, lineCells, surfaceFillCells } from '../core/tools';
import { culledGeometry, lightVector } from './meshBuilder';

interface PickResult {
  /** Cell an "add" would fill. */
  place: Vec3 | null;
  /** Existing voxel under the cursor (erase/paint target). */
  target: Vec3 | null;
  normal: Vec3;
}

/**
 * The 3D editing view: renders the current frame, the grid, the layer plane,
 * onion skin and the cursor, and turns pointer input into tool actions.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private root = new THREE.Group();
  private voxelMesh: THREE.Mesh;
  private ghostMesh: THREE.Mesh;
  private onionMesh: THREE.Mesh;
  private gridLines = new THREE.Group();
  private layerPlane: THREE.Mesh;
  private cursor: THREE.LineSegments;
  private cursorFill: THREE.Mesh;
  private ground: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private raycaster = new THREE.Raycaster();
  private drag: { button: number; erase: boolean; start: Vec3 | null; axis: number; level: number; last: Vec3 | null } | null = null;
  private needsRender = true;
  private altDown = false;
  onStatus: (text: string) => void = () => {};

  constructor(
    readonly container: HTMLElement,
    readonly editor: Editor,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x1e1f26);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.ambient = new THREE.HemisphereLight(0xffffff, 0x8890a0, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.ambient, this.sun, this.sun.target);

    this.scene.add(this.root);
    this.voxelMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.voxelMesh.castShadow = true;
    this.voxelMesh.receiveShadow = true;
    this.ghostMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    this.onionMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xff5577, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.35 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.layerPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x5aa0ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.layerPlane.rotation.x = -Math.PI / 2;
    const cubeEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.cursor = new THREE.LineSegments(cubeEdges, new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.cursorFill = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    this.root.add(this.voxelMesh, this.ghostMesh, this.onionMesh, this.ground, this.gridLines, this.layerPlane, this.cursor, this.cursorFill);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => this.hideCursor());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.setAlt(e.altKey));
    window.addEventListener('keyup', (e) => this.setAlt(e.altKey));
    new ResizeObserver(() => this.resize()).observe(container);

    editor.on('model', () => this.rebuildMesh());
    editor.on('frame', () => this.rebuildMesh());
    editor.on('palette', () => this.rebuildMesh());
    editor.on('state', () => {
      this.rebuildMesh();
      this.updateLayerPlane();
    });
    editor.on('light', () => this.updateLight());
    editor.on('project', () => this.rebuildAll(true));
    editor.on('frames', () => this.rebuildAll(false));

    this.rebuildAll(true);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      if (this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  private setAlt(on: boolean): void {
    if (on === this.altDown) return;
    this.altDown = on;
    this.controls.mouseButtons.LEFT = on ? THREE.MOUSE.ROTATE : null;
  }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /** Recenters the camera on the model volume. */
  resetCamera(): void {
    const { sx, sy, sz } = this.editor.project;
    const r = Math.max(sx, sy, sz);
    this.controls.target.set(0, sy * 0.4, 0);
    this.camera.position.set(r * 1.25, r * 1.1, r * 1.6);
    this.controls.update();
    this.needsRender = true;
  }

  private rebuildAll(resetCam: boolean): void {
    const { sx, sz } = this.editor.project;
    this.root.position.set(-sx / 2, 0, -sz / 2);
    this.ground.scale.set(sx * 3, sz * 3, 1);
    this.ground.position.set(sx / 2, -0.001, sz / 2);
    this.buildGrid();
    this.updateLayerPlane();
    this.updateLight();
    this.rebuildMesh();
    if (resetCam) this.resetCamera();
  }

  private buildGrid(): void {
    this.gridLines.clear();
    const { sx, sy, sz } = this.editor.project;
    const pts: number[] = [];
    for (let x = 0; x <= sx; x++) pts.push(x, 0, 0, x, 0, sz);
    for (let z = 0; z <= sz; z++) pts.push(0, 0, z, sx, 0, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3a3d4d }));
    // Bounding volume
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)),
      new THREE.LineBasicMaterial({ color: 0x4a4e63, transparent: true, opacity: 0.6 }),
    );
    box.position.set(sx / 2, sy / 2, sz / 2);
    // Axis hint: red = +x, blue = +z (front)
    const axis = new THREE.BufferGeometry();
    axis.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.01, 0, sx, 0.01, 0, 0, 0.01, 0, 0, 0.01, sz], 3));
    axis.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.3, 0.3, 1, 0.3, 0.3, 0.3, 0.5, 1, 0.3, 0.5, 1], 3));
    const axes = new THREE.LineSegments(axis, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.gridLines.add(lines, box, axes);
    this.gridLines.visible = this.editor.showGrid;
    this.needsRender = true;
  }

  private updateLayerPlane(): void {
    const { sx, sz } = this.editor.project;
    const layerMode = this.editor.mode === 'layer';
    this.layerPlane.visible = layerMode;
    this.layerPlane.scale.set(sx, sz, 1);
    this.layerPlane.position.set(sx / 2, this.editor.layer + 0.002, sz / 2);
    this.gridLines.visible = this.editor.showGrid;
    if (layerMode) {
      this.gridLines.position.y = this.editor.layer;
    } else {
      this.gridLines.position.y = 0;
    }
    this.needsRender = true;
  }

  private updateLight(): void {
    const L = this.editor.light;
    const { sx, sy, sz } = this.editor.project;
    const r = Math.max(sx, sy, sz);
    const dir = lightVector(L.azimuth, L.elevation);
    const center = new THREE.Vector3(0, sy / 2, 0);
    this.sun.position.copy(center).addScaledVector(dir, r * 2);
    this.sun.target.position.copy(center);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r * 1.5;
    cam.right = cam.top = r * 1.5;
    cam.near = 0.1;
    cam.far = r * 5;
    cam.updateProjectionMatrix();
    const on = L.enabled;
    this.sun.intensity = on ? L.intensity * Math.PI : 0;
    this.ambient.intensity = on ? L.ambient * Math.PI * 0.9 : Math.PI;
    this.sun.castShadow = on && L.shadows;
    this.ground.visible = on && L.groundShadow;
    (this.ground.material as THREE.ShadowMaterial).opacity = L.shadowOpacity;
    this.needsRender = true;
  }

  rebuildMesh(): void {
    const ed = this.editor;
    const layerMode = ed.mode === 'layer';
    const maxY = layerMode ? ed.layer : Infinity;
    this.voxelMesh.geometry.dispose();
    this.voxelMesh.geometry = culledGeometry(ed.frame, ed.project.palette, { maxY, ao: ed.ao });
    this.ghostMesh.geometry.dispose();
    this.ghostMesh.visible = layerMode && ed.showAbove && ed.layer < ed.project.sy - 1;
    this.ghostMesh.geometry = this.ghostMesh.visible
      ? culledGeometry(ed.frame, ed.project.palette, { minY: ed.layer + 1, ao: false })
      : new THREE.BufferGeometry();
    this.onionMesh.geometry.dispose();
    const prev = ed.onion && !ed.playing ? ed.prevFrame : null;
    this.onionMesh.visible = !!prev;
    this.onionMesh.geometry = prev ? culledGeometry(prev, ed.project.palette, { maxY, ao: false }) : new THREE.BufferGeometry();
    this.needsRender = true;
  }

  // ---- picking ------------------------------------------------------------

  private gridRay(e: PointerEvent): { o: Vec3; d: Vec3 } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin.clone().sub(this.root.position);
    const d = this.raycaster.ray.direction;
    return { o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] };
  }

  private pick(e: PointerEvent): PickResult {
    const ed = this.editor;
    const g = ed.frame;
    const { o, d } = this.gridRay(e);
    if (ed.mode === 'layer') {
      const c = raycastPlaneY(g, o, d, ed.layer);
      return { place: c, target: c && g.get(c[0], c[1], c[2]) ? c : null, normal: [0, 1, 0] };
    }
    const hit = raycastGrid(g, o, d);
    if (hit) {
      const p: Vec3 = [hit.voxel[0] + hit.normal[0], hit.voxel[1] + hit.normal[1], hit.voxel[2] + hit.normal[2]];
      return { place: g.inBounds(p[0], p[1], p[2]) ? p : null, target: hit.voxel, normal: hit.normal };
    }
    return { place: raycastPlaneY(g, o, d, 0), target: null, normal: [0, 1, 0] };
  }

  /** Continues a drag on the plane where it started. */
  private pickOnPlane(e: PointerEvent, axis: number, level: number): Vec3 | null {
    const { o, d } = this.gridRay(e);
    return raycastAxisPlane(this.editor.frame, o, d, axis, level);
  }

  // ---- input --------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || e.altKey) return;
    const ed = this.editor;
    ed.stop();
    const r = this.pick(e);
    const erase = e.shiftKey && (ed.tool === 'add' || ed.tool === 'box' || ed.tool === 'line');
    const axis = r.normal[0] ? 0 : r.normal[1] ? 1 : 2;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    switch (ed.tool) {
      case 'add': {
        const c = erase ? r.target : r.place;
        if (!c) return;
        ed.beginStroke();
        ed.strokeSet([c], erase ? 0 : ed.color);
        this.drag = { button: 0, erase, start: c, axis, level: c[axis], last: c };
        break;
      }
      case 'erase':
      case 'paint': {
        ed.beginStroke();
        if (r.target) ed.strokeSet([r.target], ed.tool === 'erase' ? 0 : ed.color);
        this.drag = { button: 0, erase: ed.tool === 'erase', start: r.target, axis, level: 0, last: r.target };
        break;
      }
      case 'pick': {
        if (r.target) ed.setColor(ed.frame.get(r.target[0], r.target[1], r.target[2]));
        break;
      }
      case 'fill': {
        if (ed.mode === 'layer') {
          if (!r.place) return;
          ed.applyCells(floodCells(ed.frame, r.place, true), ed.color, 'fill');
        } else if (r.target) {
          ed.applyCells(surfaceFillCells(ed.frame, r.target, r.normal), ed.color, 'fill');
        }
        break;
      }
      case 'box':
      case 'line': {
        const c = erase ? r.target : r.place;
        if (!c) return;
        this.drag = { button: 0, erase, start: c, axis, level: c[axis], last: c };
        this.showShape(c, c);
        break;
      }
    }
  }

  private onMove(e: PointerEvent): void {
    const ed = this.editor;
    if (!this.drag) {
      this.updateCursor(e);
      return;
    }
    const d = this.drag;
    switch (ed.tool) {
      case 'add': {
        const c = this.pickOnPlane(e, d.axis, d.level);
        if (c && (!d.last || c.some((v, i) => v !== d.last![i]))) {
          ed.strokeSet(d.last ? lineCells(d.last, c) : [c], d.erase ? 0 : ed.color);
          d.last = c;
        }
        this.showCursorAt(c, d.erase);
        break;
      }
      case 'erase':
      case 'paint': {
        const r = this.pick(e);
        if (r.target) ed.strokeSet([r.target], ed.tool === 'erase' ? 0 : ed.color);
        this.showCursorAt(r.target, ed.tool === 'erase');
        break;
      }
      case 'box':
      case 'line': {
        const c = this.pickOnPlane(e, d.axis, d.level);
        if (c) d.last = c;
        if (d.start && d.last) this.showShape(d.start, d.last);
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag || e.button !== 0) return;
    const ed = this.editor;
    const d = this.drag;
    this.drag = null;
    if (ed.tool === 'box' || ed.tool === 'line') {
      if (d.start && d.last) {
        const cells = ed.tool === 'box' ? boxCells(d.start, d.last) : lineCells(d.start, d.last);
        ed.applyCells(cells, d.erase ? 0 : ed.color, ed.tool);
      }
      this.hideCursor();
    } else {
      ed.endStroke(ed.tool);
    }
  }

  private updateCursor(e: PointerEvent): void {
    const ed = this.editor;
    const r = this.pick(e);
    const erase = ed.tool === 'erase' || (e.shiftKey && (ed.tool === 'add' || ed.tool === 'box' || ed.tool === 'line'));
    const usesTarget = erase || ed.tool === 'paint' || ed.tool === 'pick' || (ed.tool === 'fill' && ed.mode === '3d');
    const c = usesTarget ? r.target : r.place;
    this.showCursorAt(c, erase);
    if (c) {
      const v = ed.frame.get(c[0], c[1], c[2]);
      this.onStatus(`x ${c[0]}  y ${c[1]}  z ${c[2]}${v ? `  #${v}` : ''}`);
    } else this.onStatus('');
  }

  private showCursorAt(c: Vec3 | null, erase: boolean): void {
    if (!c) return this.hideCursor();
    this.cursor.visible = true;
    this.cursorFill.visible = true;
    this.cursor.scale.set(1.02, 1.02, 1.02);
    this.cursorFill.scale.set(1.0, 1.0, 1.0);
    this.cursor.position.set(c[0] + 0.5, c[1] + 0.5, c[2] + 0.5);
    this.cursorFill.position.copy(this.cursor.position);
    const color = erase ? 0xff4466 : new THREE.Color(this.editor.project.palette[this.editor.color]).getHex();
    (this.cursor.material as THREE.LineBasicMaterial).color.setHex(erase ? 0xff4466 : 0xffffff);
    (this.cursorFill.material as THREE.MeshBasicMaterial).color.setHex(color);
    this.needsRender = true;
  }

  private showShape(a: Vec3, b: Vec3): void {
    const min = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
    const max = [Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1, Math.max(a[2], b[2]) + 1];
    this.cursor.visible = true;
    this.cursorFill.visible = true;
    const s = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    this.cursor.scale.set(s[0] + 0.02, s[1] + 0.02, s[2] + 0.02);
    this.cursorFill.scale.set(s[0], s[1], s[2]);
    this.cursor.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    this.cursorFill.position.copy(this.cursor.position);
    this.onStatus(`${s[0]} × ${s[1]} × ${s[2]}`);
    this.needsRender = true;
  }

  private hideCursor(): void {
    this.cursor.visible = false;
    this.cursorFill.visible = false;
    this.needsRender = true;
  }

  requestRender(): void {
    this.needsRender = true;
  }

  /** PNG snapshot of the current view (for thumbnails or sharing). */
  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
