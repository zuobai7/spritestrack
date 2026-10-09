import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Editor, Tool } from '../editor/Editor';
import { raycastAxisPlane, raycastGrid, raycastPlaneY, type Vec3 } from '../core/raycast';
import { buildCellFaces } from '../core/mesher';
import { boxCells, lineCells, mirrored, normBox } from '../core/tools';
import { t } from '../i18n';
import { culledGeometry, lightVector } from './meshBuilder';

interface PickResult {
  /** Cell an "add" would fill. */
  place: Vec3 | null;
  /** Existing voxel under the cursor (erase/paint target). */
  target: Vec3 | null;
  normal: Vec3;
}

interface Drag {
  /** Tool and pointer that started the drag (the tool can change mid-drag via shortcuts). */
  tool: Tool;
  pointerId: number;
  erase: boolean;
  start: Vec3 | null;
  axis: number;
  level: number;
  /** Coordinate (on `axis`) of the face plane the drag started on. */
  plane: number;
  last: Vec3 | null;
  moved: boolean;
}

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'iso';

/** Above this many cells the tool preview only shows the cursor (building the mesh would stall). */
const PREVIEW_LIMIT = 120_000;
const ERASE_COLOR = 0xff4466;

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
  /** Highlights the voxels the current tool would change at the cursor. */
  private preview: THREE.Mesh;
  private previewKey = '';
  /** Floating hint next to the cursor (picked color, fill size). */
  private tip: HTMLDivElement;
  private lastPointer: PointerEvent | null = null;
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
  /** The voxel meshes are rebuilt at most once per animation frame. */
  private meshDirty = false;
  private paletteKey = '';
  private gridKey = '';
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
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x1b1c22);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 4000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    // One finger draws with the tool; two fingers turn and zoom the camera
    this.controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
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
    this.preview = new THREE.Mesh(
      new THREE.BufferGeometry(),
      // Drawn over the voxel faces it covers, never hiding anything behind them
      new THREE.MeshLambertMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      }),
    );
    this.preview.renderOrder = 5;
    this.preview.visible = false;
    this.tip = document.createElement('div');
    this.tip.className = 'view-tip';
    this.tip.hidden = true;
    container.appendChild(this.tip);
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
      this.preview,
      this.selectionBox,
      this.pivots,
      this.reference,
    );

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    // A drag must never outlive the press: the browser may cancel the pointer,
    // or the window may lose focus while the button is down
    el.addEventListener('pointercancel', (e) => this.drag?.pointerId === e.pointerId && this.endDrag(false));
    el.addEventListener('pointerleave', () => {
      this.lastPointer = null;
      if (!this.drag) this.hideCursor();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      this.setAlt(e.altKey);
      if (e.key === 'Escape' && this.drag) this.endDrag(false);
    });
    window.addEventListener('keyup', (e) => this.setAlt(e.altKey));
    window.addEventListener('blur', () => {
      this.setAlt(false);
      this.endDrag(false);
    });
    new ResizeObserver(() => this.resize()).observe(container);

    editor.on('model', () => this.rebuildMesh());
    editor.on('frame', () => this.rebuildMesh());
    // Picking a color also sends 'palette'; only real palette changes need new meshes
    editor.on('palette', () => {
      const key = editor.project.palette.join(',');
      if (key === this.paletteKey) return;
      this.paletteKey = key;
      this.rebuildMesh();
    });
    // The hover preview follows changes made without moving the mouse (a
    // click, a shortcut, another color)
    for (const ev of ['model', 'frame', 'palette', 'state', 'frames'] as const)
      editor.on(ev, () => {
        if (this.lastPointer && !this.drag) this.updateCursor(this.lastPointer);
      });
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
    // Moving the window to a screen with another pixel density changes no size, so watch for it
    const watchDensity = () =>
      matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
        'change',
        () => {
          this.resize();
          watchDensity();
        },
        { once: true },
      );
    watchDensity();
    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      if (this.meshDirty) this.buildMeshes();
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    const { sx, sy, sz } = this.editor.project;
    this.root.position.set(-sx / 2, 0, -sz / 2);
    this.ground.scale.set(sx * 3, sz * 3, 1);
    this.ground.position.set(sx / 2, -0.001, sz / 2);
    // The grid only changes with the model size
    const gridKey = `${sx},${sy},${sz}`;
    if (gridKey !== this.gridKey) {
      this.gridKey = gridKey;
      this.buildGrid();
    }
    this.updateLayerPlane();
    this.updateLight();
    this.updateSelection();
    this.updatePivots();
    this.updateReference();
    this.rebuildMesh();
    if (resetCam) this.resetCamera();
  }

  private buildGrid(): void {
    disposeChildren(this.gridLines);
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
    disposeChildren(this.pivots);
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

  /** Marks the voxel meshes for rebuilding on the next animation frame. */
  rebuildMesh(): void {
    this.meshDirty = true;
    this.needsRender = true;
  }

  private buildMeshes(): void {
    this.meshDirty = false;
    const ed = this.editor;
    this.paletteKey = ed.project.palette.join(',');
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
      // The voxels of the current layer where they are seen (their top and
      // side faces), otherwise the layer's floor
      const hit = raycastGrid(g, o, d, ed.layer);
      if (hit && hit.voxel[1] === ed.layer) return { place: hit.voxel, target: hit.voxel, normal: [0, 1, 0] };
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
  private pickOnPlane(e: PointerEvent, d: Drag): Vec3 | null {
    const ray = this.gridRay(e);
    return raycastAxisPlane(this.editor.frame, ray.o, ray.d, d.axis, d.level, d.plane);
  }

  // ---- input --------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (!e.isPrimary) {
      // A second finger: the camera takes over, so the first finger's drag ends
      if (this.drag) this.endDrag(false);
      return;
    }
    if (e.button !== 0 || e.altKey) return;
    // A previous drag whose release never arrived ends here
    if (this.drag) this.endDrag(true);
    const ed = this.editor;
    ed.stop();
    const r = this.pick(e);
    const axis = r.normal[0] ? 0 : r.normal[1] ? 1 : 2;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.hidePreview();

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
    // The drag goes on along the plane of the face that was clicked: the far
    // side of an empty cell or the near side of a voxel
    const faceOf = (c: Vec3, isVoxel: boolean) => c[axis] + ((r.normal[axis] > 0) === isVoxel ? 1 : 0);
    const drag = (start: Vec3 | null, level: number, isErase = erase, isVoxel = isErase): Drag => ({
      tool: ed.tool,
      pointerId: e.pointerId,
      erase: isErase,
      start,
      axis,
      level,
      plane: start ? faceOf(start, isVoxel) : level + 0.5,
      last: start,
      moved: false,
    });
    switch (ed.tool) {
      case 'add': {
        const c = erase ? r.target : r.place;
        if (!c) return;
        ed.beginStroke();
        ed.strokeSet(ed.brushAt(c), erase ? 0 : ed.color, erase ? 'set' : 'add');
        this.drag = drag(c, c[axis]);
        break;
      }
      case 'erase':
      case 'paint': {
        ed.beginStroke();
        if (r.target) ed.strokeSet(ed.brushAt(r.target), ed.tool === 'erase' ? 0 : ed.color, ed.tool === 'erase' ? 'set' : 'paint');
        this.drag = drag(r.target, 0, ed.tool === 'erase');
        break;
      }
      case 'part': {
        if (e.shiftKey) {
          if (r.target) ed.assignConnectedToPart(r.target);
          return;
        }
        ed.beginStroke('parts');
        if (r.target) ed.strokeSet(ed.brushAt(r.target), ed.activePart);
        this.drag = drag(r.target, 0, false);
        break;
      }
      case 'pick': {
        if (r.target) ed.setColor(ed.frame.get(r.target[0], r.target[1], r.target[2]));
        break;
      }
      case 'fill': {
        const c = ed.mode === 'layer' ? r.place : r.target;
        // fillCells already includes the mirrored areas
        if (c) ed.applyCells(ed.fillCells(c, r.normal), ed.color, 'fill', 'set', false);
        break;
      }
      case 'box':
      case 'line': {
        const c = erase ? r.target : r.place;
        if (!c) return;
        this.drag = drag(c, c[axis]);
        this.showShape(c, c);
        break;
      }
      case 'select': {
        const onVoxel = ed.mode !== 'layer' && !!r.target;
        const c = onVoxel ? r.target : r.place;
        if (!c) {
          ed.setSelection(null);
          return;
        }
        this.drag = drag(c, c[axis], false, onVoxel);
        this.showShape(c, c);
        break;
      }
    }
  }

  private onMove(e: PointerEvent): void {
    const ed = this.editor;
    this.lastPointer = e;
    if (this.drag?.pointerId === e.pointerId && (e.buttons & 1) === 0) {
      // The left button was released without a pointerup reaching us (for
      // example while the right button was still held): finish the drag now
      this.endDrag(true, e.shiftKey);
    }
    if (this.drag && this.drag.tool !== 'box' && this.drag.tool !== 'line' && this.drag.tool !== 'select' && !ed.stroking) {
      // An undo, frame change or playback closed the stroke mid-drag; painting
      // on would start writing somewhere else
      this.drag = null;
    }
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) {
      this.updateCursor(e);
      return;
    }
    switch (d.tool) {
      case 'add': {
        const c = this.pickOnPlane(e, d);
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
          const value = d.tool === 'part' ? ed.activePart : d.tool === 'erase' ? 0 : ed.color;
          ed.strokeSet(ed.brushAt(r.target), value, d.tool === 'paint' ? 'paint' : 'set');
        }
        this.showBrushAt(r.target, d.tool === 'erase');
        break;
      }
      case 'box':
      case 'line':
      case 'select': {
        const c = this.pickOnPlane(e, d);
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
    // Any release ends the drag: with several buttons held, the pointerup
    // reports the last button released, which need not be the left one
    if (!this.drag || this.drag.pointerId !== e.pointerId) return;
    this.endDrag(true, e.shiftKey);
  }

  /**
   * Finishes the current drag. Strokes are always recorded; with `apply`
   * false an unfinished box, line or selection is dropped instead of applied.
   */
  private endDrag(apply: boolean, shift = false): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const ed = this.editor;
    if (d.tool === 'box' || d.tool === 'line') {
      if (apply && d.start && d.last) {
        const cells = d.tool === 'box' ? boxCells(d.start, d.last) : lineCells(d.start, d.last);
        ed.applyCells(cells, d.erase ? 0 : ed.color, d.tool);
      }
      this.hideCursor();
    } else if (d.tool === 'select') {
      this.hideCursor();
      if (!apply || !d.start || !d.last) return;
      if (!d.moved && ed.mode === '3d') {
        // A click (no drag) selects the connected object
        if (ed.frame.get(d.start[0], d.start[1], d.start[2])) ed.selectConnected(d.start);
        else ed.setSelection(null);
        return;
      }
      const b = normBox(d.start, d.last);
      const size = [ed.project.sx, ed.project.sy, ed.project.sz];
      if (ed.mode === '3d' || shift) {
        // Extend through the whole model along the axis the drag plane faces
        const ax = ed.mode === '3d' ? d.axis : 1;
        b.min[ax] = 0;
        b.max[ax] = size[ax] - 1;
      }
      ed.setSelection(b);
    } else {
      ed.endStroke(d.tool);
    }
  }

  private updateCursor(e: PointerEvent): void {
    const ed = this.editor;
    const r = this.pick(e);
    if (ed.pivotPick !== null) {
      this.hidePreview();
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
    this.updatePreview(e, c, r.normal, erase);
    if (c) {
      const v = ed.frame.get(c[0], c[1], c[2]);
      const part = ed.project.rig && v ? ed.project.rig.parts.find((p) => p.id === ed.project.rig!.partMap.get(c[0], c[1], c[2])) : undefined;
      this.onStatus(`x ${c[0]}  y ${c[1]}  z ${c[2]}${v ? `  #${v}` : ''}${part && ed.partOverlay ? `  · ${part.name}` : ''}`);
    } else this.onStatus('');
  }

  /**
   * Shows what the tool would do here: the voxels a fill, paint, erase, add or
   * part brush would change (mirrors included), and a hint with the color the
   * eyedropper would pick or how many voxels a fill would recolor.
   */
  private updatePreview(e: PointerEvent, c: Vec3 | null, normal: Vec3, erase: boolean): void {
    const ed = this.editor;
    const tool = ed.tool;
    if (!c) return this.hidePreview();
    const pal = ed.project.palette;
    const hex = (i: number) => '#' + (pal[i] ?? 0).toString(16).padStart(6, '0');
    if (tool === 'pick') {
      const v = ed.frame.get(c[0], c[1], c[2]);
      this.hidePreview();
      if (!v) return;
      (this.cursorFill.material as THREE.MeshBasicMaterial).color.set(hex(v));
      return this.showTip(e, hex(v), `${t('pickTip')} #${v} · ${hex(v).toUpperCase()}`);
    }
    if (tool !== 'fill' && tool !== 'paint' && tool !== 'add' && tool !== 'erase' && tool !== 'part') return this.hidePreview();
    const g = ed.frame;
    const rig = ed.project.rig;
    const partColor = rig?.parts.find((p) => p.id === ed.activePart)?.color ?? 0xffffff;
    const color = erase ? ERASE_COLOR : tool === 'part' ? partColor : pal[ed.color] ?? 0xffffff;
    const key = [tool, erase, ed.mode, ed.layer, c, normal, ed.color, ed.activePart, ed.brush.size, ed.brush.shape, ed.mirror.x, ed.mirror.y, ed.mirror.z, ed.version(g), g.sx, g.sy, g.sz, color].join('|');
    if (key === this.previewKey) {
      if (this.preview.visible) this.cursorFill.visible = false;
      if (!this.tip.hidden) this.moveTip(e);
      return;
    }
    this.previewKey = key;
    let cells: Vec3[];
    if (tool === 'fill') cells = ed.fillCells(c, normal);
    else {
      // Brush cells and their mirror images that the stroke would actually change
      const seen = new Set<number>();
      cells = [];
      for (const b of ed.brushAt(c))
        for (const m of mirrored(g, b, ed.mirror)) {
          if (!g.inBounds(m[0], m[1], m[2])) continue;
          const i = g.index(m[0], m[1], m[2]);
          const filled = g.data[i] !== 0;
          if (seen.has(i) || (tool === 'add' && !erase ? filled : !filled)) continue;
          seen.add(i);
          cells.push(m);
        }
    }
    this.setPreviewCells(cells, color);
    if (tool !== 'fill') return this.hideTip();
    const changed = cells.reduce((n, q) => n + (g.get(q[0], q[1], q[2]) !== ed.color ? 1 : 0), 0);
    this.showTip(e, hex(ed.color), changed ? `${t('fillTip')} ${changed} ${t('voxels')}` : t('fillSame'));
  }

  private setPreviewCells(cells: Vec3[], color: number): void {
    const ed = this.editor;
    const g = ed.frame;
    const show = cells.length > 0 && cells.length <= PREVIEW_LIMIT;
    this.preview.visible = show;
    this.preview.geometry.dispose();
    this.preview.geometry = new THREE.BufferGeometry();
    if (show) {
      // In layer mode the voxels above the layer are hidden, so they don't cover anything
      const maxY = ed.mode === 'layer' ? ed.layer : Infinity;
      const m = buildCellFaces(cells, [g.sx, g.sy, g.sz], (x, y, z) => y <= maxY && g.get(x, y, z) !== 0);
      const geo = this.preview.geometry;
      geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geo.computeBoundingSphere();
      (this.preview.material as THREE.MeshLambertMaterial).color.setHex(color);
      // The exact cells are shown, so the cursor box only outlines the brush
      this.cursorFill.visible = false;
    }
    this.needsRender = true;
  }

  private showTip(e: PointerEvent, swatch: string, text: string): void {
    this.tip.replaceChildren();
    const chip = document.createElement('span');
    chip.className = 'swatch';
    chip.style.background = swatch;
    this.tip.append(chip, text);
    this.tip.hidden = false;
    this.moveTip(e);
  }

  private moveTip(e: PointerEvent): void {
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Below right of the pointer, flipped to the other side near the edges
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    this.tip.style.left = `${x + 16 + w > rect.width ? Math.max(0, x - 12 - w) : x + 16}px`;
    this.tip.style.top = `${y + 18 + h > rect.height ? Math.max(0, y - 10 - h) : y + 18}px`;
  }

  private hideTip(): void {
    this.tip.hidden = true;
  }

  private hidePreview(): void {
    this.previewKey = '';
    if (this.preview.visible) {
      this.preview.visible = false;
      this.needsRender = true;
    }
    this.hideTip();
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
    this.hidePreview();
    this.needsRender = true;
  }

  requestRender(): void {
    this.needsRender = true;
  }
}

/** Removes a group's children and frees their GPU resources. */
function disposeChildren(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    child.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }
  group.clear();
}
