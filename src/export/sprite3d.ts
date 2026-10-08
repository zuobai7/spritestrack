import * as THREE from 'three';
import type { VoxelGrid } from '../core/VoxelGrid';
import type { LightSettings } from '../core/lighting';
import { greedyGeometry, lightVector } from '../render/meshBuilder';
import { createImage, outlineImage, scaleImage, type RgbaImage } from './image';

export interface Render3dOptions {
  /** Output cell size in pixels (square) before upscaling. */
  size: number;
  /** Camera elevation in degrees (0 = side view, 90 = top-down). */
  elevation: number;
  /** Orthographic (pixel-art friendly) or perspective camera. */
  orthographic: boolean;
  light: LightSettings;
  outline: number | null;
  scale: number;
}

/**
 * Renders voxel frames with three.js from several angles. The camera and the
 * light stay fixed while the model turns, so lighting and cast shadows change
 * from angle to angle. One renderer is reused for every image.
 */
export class Sprite3dRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = new THREE.OrthographicCamera();
  private pivot = new THREE.Group();
  private mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  private ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.35 }));
  private sun = new THREE.DirectionalLight(0xffffff, 1);
  private ambient = new THREE.AmbientLight(0xffffff, 1);
  private canvas: HTMLCanvasElement;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.pivot.add(this.mesh);
    this.scene.add(this.pivot, this.ground, this.sun, this.sun.target, this.ambient);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.renderer.dispose();
  }

  /** Renders one frame at one angle (degrees, same convention as the stack renderer). */
  render(grid: VoxelGrid, palette: number[], angle: number, o: Render3dOptions): RgbaImage {
    const size = Math.max(4, Math.floor(o.size));
    this.renderer.setSize(size, size, false);
    this.mesh.geometry.dispose();
    this.mesh.geometry = greedyGeometry(grid, palette, 1, true);
    this.pivot.rotation.y = (-angle * Math.PI) / 180;

    const radius = Math.hypot(grid.sx, grid.sy, grid.sz) / 2;
    const center = new THREE.Vector3(0, grid.sy / 2, 0);
    const el = (o.elevation * Math.PI) / 180;
    const camDir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));
    if (o.orthographic) {
      const cam = this.camera instanceof THREE.OrthographicCamera ? this.camera : new THREE.OrthographicCamera();
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 0.1;
      cam.far = radius * 8;
      this.camera = cam;
    } else {
      const cam = this.camera instanceof THREE.PerspectiveCamera ? this.camera : new THREE.PerspectiveCamera();
      cam.fov = 30;
      cam.aspect = 1;
      cam.near = 0.1;
      cam.far = radius * 20;
      this.camera = cam;
    }
    const dist = o.orthographic ? radius * 3 : radius / Math.sin((15 * Math.PI) / 180);
    this.camera.position.copy(center).addScaledVector(camDir, dist);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();

    const L = o.light;
    const dir = lightVector(L.azimuth, L.elevation);
    this.sun.position.copy(center).addScaledVector(dir, radius * 3);
    this.sun.target.position.copy(center);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -radius * 2;
    sc.right = sc.top = radius * 2;
    sc.near = 0.1;
    sc.far = radius * 8;
    sc.updateProjectionMatrix();
    this.sun.intensity = L.enabled ? L.intensity * Math.PI : 0;
    this.ambient.intensity = L.enabled ? L.ambient * Math.PI : Math.PI;
    this.sun.castShadow = L.enabled && L.shadows;
    this.ground.visible = L.enabled && L.groundShadow;
    this.ground.scale.set(radius * 6, radius * 6, 1);
    (this.ground.material as THREE.ShadowMaterial).opacity = L.shadowOpacity;

    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.getContext();
    const buf = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const img = createImage(size, size);
    for (let y = 0; y < size; y++) img.data.set(buf.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    // Hard alpha for clean pixel art; keep partial alpha only for shadow pixels
    for (let i = 0; i < img.data.length; i += 4) {
      const a = img.data[i + 3];
      if (a > 0 && a < 255 && (img.data[i] | img.data[i + 1] | img.data[i + 2]) !== 0) {
        // Premultiplied → straight alpha
        img.data[i] = Math.min(255, Math.round((img.data[i] * 255) / a));
        img.data[i + 1] = Math.min(255, Math.round((img.data[i + 1] * 255) / a));
        img.data[i + 2] = Math.min(255, Math.round((img.data[i + 2] * 255) / a));
      }
    }
    let out = o.outline !== null ? outlineImage(img, o.outline) : img;
    out = scaleImage(out, o.scale);
    return out;
  }
}
