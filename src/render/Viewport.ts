import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Editor } from '../editor/Editor';
import { raycastAxisPlane, raycastGrid, raycastPlaneY, type Vec3 } from '../core/raycast';
import { boxCells, floodCells, lineCells, normBox, surfaceFillCells } from '../core/tools';
import { culledGeometry, lightVector } from './meshBuilder';

interface PickResult {
  /** Cell an "add" would fill. */
  place: Vec3 | null;
  /** Existing voxel under the cursor (erase/paint target). */
  target: Vec3 | null;
  normal: Vec3;
}

interface Drag {
  erase: boolean;
  start: Vec3 | null;
  axis: number;
  level: number;
  last: Vec3 | null;
  moved: boolean;
}

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'iso';

/**
 * The 3D editing view: renders the current frame, the grid, the layer plane,
 * onion skin, selection, parts and reference image, and turns pointer input
 * into tool actions.
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
  private selectionBox: THREE.LineSegments;
  private pivots = new THREE.Group();
  private reference: THREE.Mesh;
  private referenceUrl = '';
  private ground: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private raycaster = new THREE.Raycaster();
  private drag: Drag | null = null;
  private needsRender = true;
  private altDown = false;
  private viewKey = '';
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

    this.scene.background = new THREE.Color(0x1b1c22);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 4000);
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
      new THREE.MeshBasicMaterial({ color: 0x5aa0ff, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.layerPlane.rotation.x = -Math.PI / 2;
    const cubeEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.cursor = new THREE.LineSegments(cubeEdges, new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.cursorFill = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    this.selectionBox = new THREE.LineSegments(
      cubeEdges.clone(),
      new THREE.LineBasicMaterial({ color: 0xffd23d, depthTest: false, transparent: true }),
    );
    this.selectionBox.renderOrder = 10;
    this.reference = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.reference.visible = false;
    this.root.add(
      this.voxelMesh,
      this.ghostMesh,
      this.onionMesh,
      this.ground,
      this.gridLines,
      this.layerPlane,
      this.cursor,
      this.cursorFill,
      this.selectionBox,
      this.pivots,
      this.reference,
    );

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => this.hideCursor());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.setAlt(e.altKey));
    window.addEventListener('keyup', (e) => this.setAlt(e.altKey));
    window.addEventListener('blur', () => this.setAlt(false));
    new ResizeObserver(() => this.resize()).observe(container);

    editor.on('model', () => this.rebuildMesh());
    editor.on('frame', () => this.rebuildMesh());
    editor.on('palette', () => this.rebuildMesh());
    editor.on('rig', () => {
      if (this.editor.partOverlay) this.rebuildMesh();
      this.updatePivots();
    });
    editor.on('state', () => {
      const key = this.currentViewKey();
      if (key !== this.viewKey) this.rebuildMesh();
      this.updateLayerPlane();
      this.updatePivots();
      this.updateReference();
    });
    editor.on('selection', () => this.updateSelection());
    editor.on('light', () => this.updateLight());
    editor.on('reference', () => this.updateReference());
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

  private currentViewKey(): string {
    const ed = this.editor;
    return [ed.mode, ed.layer, ed.ao, ed.onion, ed.showAbove, ed.partOverlay, ed.playing].join('|');
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

  /** Points the camera at the model from a preset direction. */
  setView(view: ViewName): void {
    const { sx, sy, sz } = this.editor.project;
    const r = Math.max(sx, sy, sz) * 2.1;
    const target = new THREE.Vector3(0, sy * 0.4, 0);
    const dirs: Record<ViewName, [number, number, number]> = {
      front: [0, 0.15, 1],
      back: [0, 0.15, -1],
      left: [-1, 0.15, 0],
      right: [1, 0.15, 0],
      top: [0, 1, 0.0001],
      iso: [0.75, 0.65, 1],
    };
    const d = new THREE.Vector3(...dirs[view]).normalize();
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(d, r);
    this.controls.update();
    this.needsRender = true;
  }

  resetCamera(): void {
    this.setView('iso');
  }

  private rebuildAll(resetCam: boolean): void {
    const { sx, sz } = this.editor.project;
    this.root.position.set(-sx / 2, 0, -sz / 2);
    this.ground.scale.set(sx * 3, sz * 3, 1);
    this.ground.position.set(sx / 2, -0.001, sz / 2);
    this.buildGrid();
    this.updateLayerPlane();
    this.updateLight();
    this.updateSelection();
    this.updatePivots();
    this.updateReference();
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
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x353846 }));
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)),
      new THREE.LineBasicMaterial({ color: 0x4a4e63, transparent: true, opacity: 0.6 }),
    );
    box.position.set(sx / 2, sy / 2, sz / 2);
    // Axis hint: red = +x, blue = +z (the front)
    const axis = new THREE.BufferGeometry();
    axis.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.01, 0, sx, 0.01, 0, 0, 0.01, 0, 0, 0.01, sz], 3));
    axis.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.3, 0.3, 1, 0.3, 0.3, 0.3, 0.5, 1, 0.3, 0.5, 1], 3));
    const axes = new THREE.LineSegments(axis, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.gridLines.add(lines, box, axes);
    this.needsRender = true;
  }

  private updateLayerPlane(): void {
    const { sx, sz } = this.editor.project;
    const layerMode = this.editor.mode === 'layer';
    this.layerPlane.visible = layerMode;
    this.layerPlane.scale.set(sx, sz, 1);
    this.layerPlane.position.set(sx / 2, this.editor.layer + 0.002, sz / 2);
    this.gridLines.visible = this.editor.showGrid;
    this.gridLines.position.y = layerMode ? this.editor.layer : 0;
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

  private updateSelection(): void {
    const s = this.editor.selection;
    this.selectionBox.visible = !!s;
    if (s) {
      const size = [s.max[0] - s.min[0] + 1, s.max[1] - s.min[1] + 1, s.max[2] - s.min[2] + 1];
      this.selectionBox.scale.set(size[0] + 0.04, size[1] + 0.04, size[2] + 0.04);
      this.selectionBox.position.set(s.min[0] + size[0] / 2, s.min[1] + size[1] / 2, s.min[2] + size[2] / 2);
    }
    this.needsRender = true;
  }

  private updatePivots(): void {
    this.pivots.clear();
    const rig = this.editor.project.rig;
    if (!rig || !this.editor.partOverlay) return void (this.needsRender = true);
    const r = Math.max(0.25, Math.max(this.editor.project.sx, this.editor.project.sy) / 64);
    for (const p of rig.parts) {
      const active = p.id === this.editor.activePart;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(active ? r * 1.6 : r, 12, 8),
        new THREE.MeshBasicMaterial({ color: p.color, depthTest: false, transparent: true, opacity: active ? 1 : 0.7 }),
      );
      m.renderOrder = 11;
      m.position.set(p.pivot[0], p.pivot[1], p.pivot[2]);
      this.pivots.add(m);
    }
    this.needsRender = true;
  }

  private updateReference(): void {
    const ref = this.editor.reference;
    const mesh = this.reference;
    if (!ref || !ref.visible) {
      mesh.visible = false;
      this.needsRender = true;
      return;
    }
    const mat = mesh.material as THREE.MeshBasicMaterial;
    if (ref.url !== this.referenceUrl) {
      this.referenceUrl = ref.url;
      new THREE.TextureLoader().load(ref.url, (tex) => {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
        mat.map?.dispose();
        mat.map = tex;
        mat.needsUpdate = true;
        this.needsRender = true;
      });
    }
    mat.opacity = ref.opacity;
    const { sx, sz } = this.editor.project;
    const w = ref.size;
    const h = (ref.size * ref.height) / Math.max(1, ref.width);
    mesh.scale.set(w, h, 1);
    mesh.rotation.set(0, 0, 0);
    if (ref.plane === 'front') {
      mesh.position.set(sx / 2 + ref.offsetX, h / 2 + ref.offsetY, -0.02);
    } else if (ref.plane === 'side') {
      mesh.rotation.y = Math.PI / 2;
      mesh.position.set(-0.02, h / 2 + ref.offsetY, sz / 2 + ref.offsetX);
    } else {
      mesh.rotation.x = -Math.PI / 2;
      const y = ref.followLayer && this.editor.mode === 'layer' ? this.editor.layer + 0.004 : -0.02;
      mesh.position.set(sx / 2 + ref.offsetX, y, sz / 2 + ref.offsetY);
    }
    mesh.visible = true;
    this.needsRender = true;
  }

  rebuildMesh(): void {
    const ed = this.editor;
    this.viewKey = this.currentViewKey();
    const layerMode = ed.mode === 'layer';
    const maxY = layerMode ? ed.layer : Infinity;
    const parts = ed.partOverlay && ed.project.rig ? { map: ed.project.rig.partMap, parts: ed.project.rig.parts } : undefined;
    this.voxelMesh.geometry.dispose();
    this.voxelMesh.geometry = culledGeometry(ed.frame, ed.project.palette, { maxY, ao: ed.ao, parts });
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
    const axis = r.normal[0] ? 0 : r.normal[1] ? 1 : 2;
    this.renderer.domElement.setPointerCapture(e.pointerId);

    if (ed.pivotPick !== null) {
      // Pivot goes to the center of the clicked face (or the ground cell)
      const id = ed.pivotPick;
      ed.pivotPick = null;
      if (r.target) {
        const v = r.target;
        ed.updatePart(id, { pivot: [v[0] + 0.5 + r.normal[0] * 0.5, v[1] + 0.5 + r.normal[1] * 0.5, v[2] + 0.5 + r.normal[2] * 0.5] });
      } else if (r.place) ed.updatePart(id, { pivot: [r.place[0] + 0.5, r.place[1], r.place[2] + 0.5] });
      ed.emit('state');
      return;
    }

    const erase = e.shiftKey && (ed.tool === 'add' || ed.tool === 'box' || ed.tool === 'line');
    switch (ed.tool) {
      case 'add': {
        const c = erase ? r.target : r.place;
        if (!c) return;
        ed.beginStroke();
        ed.strokeSet(ed.brushAt(c), erase ? 0 : ed.color, erase ? 'set' : 'add');
        this.drag = { erase, start: c, axis, level: c[axis], last: c, moved: false };
        break;
      }
      case 'erase':
      case 'paint': {
        ed.beginStroke();
        if (r.target) ed.strokeSet(ed.brushAt(r.target), ed.tool === 'erase' ? 0 : ed.color, ed.tool === 'erase' ? 'set' : 'paint');
        this.drag = { erase: ed.tool === 'erase', start: r.target, axis, level: 0, last: r.target, moved: false };
        break;
      }
      case 'part': {
        if (e.shiftKey) {
          if (r.target) ed.assignConnectedToPart(r.target);
          return;
        }
        ed.beginStroke('parts');
        if (r.target) ed.strokeSet(ed.brushAt(r.target), ed.activePart);
        this.drag = { erase: false, start: r.target, axis, level: 0, last: r.target, moved: false };
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
        this.drag = { erase, start: c, axis, level: c[axis], last: c, moved: false };
        this.showShape(c, c);
        break;
      }
      case 'select': {
        const c = ed.mode === 'layer' ? r.place : r.target ?? r.place;
        if (!c) {
          ed.setSelection(null);
          return;
        }
        this.drag = { erase: false, start: c, axis, level: c[axis], last: c, moved: false };
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
          const path = d.last ? lineCells(d.last, c) : [c];
          ed.strokeSet(path.flatMap((p) => ed.brushAt(p)), d.erase ? 0 : ed.color, d.erase ? 'set' : 'add');
          d.last = c;
        }
        this.showBrushAt(c, d.erase);
        break;
      }
      case 'erase':
      case 'paint':
      case 'part': {
        const r = this.pick(e);
        if (r.target) {
          const value = ed.tool === 'part' ? ed.activePart : ed.tool === 'erase' ? 0 : ed.color;
          ed.strokeSet(ed.brushAt(r.target), value, ed.tool === 'paint' ? 'paint' : 'set');
        }
        this.showBrushAt(r.target, ed.tool === 'erase');
        break;
      }
      case 'box':
      case 'line':
      case 'select': {
        const c = this.pickOnPlane(e, d.axis, d.level);
        if (c) {
          if (d.last && c.some((v, i) => v !== d.last![i])) d.moved = true;
          d.last = c;
        }
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
    } else if (ed.tool === 'select') {
      this.hideCursor();
      if (!d.start || !d.last) return;
      if (!d.moved && ed.mode === '3d') {
        // A click (no drag) selects the connected object
        if (ed.frame.get(d.start[0], d.start[1], d.start[2])) ed.selectConnected(d.start);
        else ed.setSelection(null);
        return;
      }
      const b = normBox(d.start, d.last);
      const size = [ed.project.sx, ed.project.sy, ed.project.sz];
      if (ed.mode === '3d' || e.shiftKey) {
        // Extend through the whole model along the axis the drag plane faces
        const ax = ed.mode === '3d' ? d.axis : 1;
        b.min[ax] = 0;
        b.max[ax] = size[ax] - 1;
      }
      ed.setSelection(b);
    } else {
      ed.endStroke(ed.tool);
    }
  }

  private updateCursor(e: PointerEvent): void {
    const ed = this.editor;
    const r = this.pick(e);
    if (ed.pivotPick !== null) {
      this.showCursorAt(r.target ?? r.place, false, 1);
      this.onStatus('⊕');
      return;
    }
    const erase = ed.tool === 'erase' || (e.shiftKey && (ed.tool === 'add' || ed.tool === 'box' || ed.tool === 'line'));
    const usesTarget =
      erase || ed.tool === 'paint' || ed.tool === 'pick' || ed.tool === 'part' || (ed.tool === 'fill' && ed.mode === '3d') || (ed.tool === 'select' && ed.mode === '3d');
    const c = usesTarget ? r.target : r.place;
    const brushed = ed.tool === 'add' || ed.tool === 'erase' || ed.tool === 'paint' || ed.tool === 'part';
    if (brushed) this.showBrushAt(c, erase);
    else this.showCursorAt(c, erase, 1);
    if (c) {
      const v = ed.frame.get(c[0], c[1], c[2]);
      const part = ed.project.rig && v ? ed.project.rig.parts.find((p) => p.id === ed.project.rig!.partMap.get(c[0], c[1], c[2])) : undefined;
      this.onStatus(`x ${c[0]}  y ${c[1]}  z ${c[2]}${v ? `  #${v}` : ''}${part && ed.partOverlay ? `  · ${part.name}` : ''}`);
    } else this.onStatus('');
  }

  private showBrushAt(c: Vec3 | null, erase: boolean): void {
    if (!c) return this.hideCursor();
    const n = this.editor.brush.size;
    if (n <= 1) return this.showCursorAt(c, erase, 1);
    const cells = this.editor.brushAt(c);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of cells)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[a]);
        max[a] = Math.max(max[a], p[a]);
      }
    this.showShape(min, max, erase);
  }

  private showCursorAt(c: Vec3 | null, erase: boolean, size: number): void {
    if (!c) return this.hideCursor();
    this.cursor.visible = true;
    this.cursorFill.visible = true;
    this.cursor.scale.set(size + 0.02, size + 0.02, size + 0.02);
    this.cursorFill.scale.set(size, size, size);
    this.cursor.position.set(c[0] + 0.5, c[1] + 0.5, c[2] + 0.5);
    this.cursorFill.position.copy(this.cursor.position);
    this.tintCursor(erase);
    this.needsRender = true;
  }

  private tintCursor(erase: boolean): void {
    const ed = this.editor;
    let fill = new THREE.Color(ed.project.palette[ed.color] ?? 0xffffff).getHex();
    if (ed.tool === 'part' && ed.project.rig) fill = ed.project.rig.parts.find((p) => p.id === ed.activePart)?.color ?? fill;
    if (ed.tool === 'select') fill = 0xffd23d;
    (this.cursor.material as THREE.LineBasicMaterial).color.setHex(erase ? 0xff4466 : 0xffffff);
    (this.cursorFill.material as THREE.MeshBasicMaterial).color.setHex(erase ? 0xff4466 : fill);
  }

  private showShape(a: Vec3, b: Vec3, erase = false): void {
    const min = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
    const max = [Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1, Math.max(a[2], b[2]) + 1];
    this.cursor.visible = true;
    this.cursorFill.visible = true;
    const s = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    this.cursor.scale.set(s[0] + 0.02, s[1] + 0.02, s[2] + 0.02);
    this.cursorFill.scale.set(s[0], s[1], s[2]);
    this.cursor.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    this.cursorFill.position.copy(this.cursor.position);
    this.tintCursor(erase || (this.drag?.erase ?? false));
    if (this.drag) this.onStatus(`${s[0]} × ${s[1]} × ${s[2]}`);
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
}
