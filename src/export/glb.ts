import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Animation } from '../core/Project';
import { greedyGeometry } from '../render/meshBuilder';

/**
 * Exports frames as a binary glTF (.glb). With several frames, each frame is a
 * child node and a glTF animation toggles their scale (step interpolation), so
 * the flip-book plays in Blender, Godot, Unity, three.js, etc.
 */
export async function exportGlb(anims: Animation[], palette: number[], scale: number, center: boolean): Promise<ArrayBuffer> {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const clips: THREE.AnimationClip[] = [];
  const multi = anims.some((a) => a.frames.length > 1) || anims.length > 1;
  anims.forEach((anim, ai) => {
    const group = new THREE.Group();
    group.name = anim.name || `anim${ai}`;
    scene.add(group);
    anim.frames.forEach((f, fi) => {
      const mesh = new THREE.Mesh(greedyGeometry(f, palette, scale, center), material);
      mesh.name = `${group.name}_frame${fi}`;
      if (multi && !(ai === 0 && fi === 0)) mesh.scale.setScalar(0);
      group.add(mesh);
    });
    if (!multi) return;
    const dt = 1 / Math.max(1, anim.fps);
    const n = anim.frames.length;
    const times = Array.from({ length: n + 1 }, (_, i) => i * dt);
    const tracks: THREE.KeyframeTrack[] = [];
    // Hide other animations' frames during this clip
    anims.forEach((other, oi) =>
      other.frames.forEach((_, fi) => {
        const name = `${other.name || `anim${oi}`}_frame${fi}`;
        const values: number[] = [];
        for (let k = 0; k <= n; k++) {
          const on = oi === ai && fi === k % n ? 1 : 0;
          values.push(on, on, on);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, values, THREE.InterpolateDiscrete));
      }),
    );
    clips.push(new THREE.AnimationClip(group.name, n * dt, tracks));
  });
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true, animations: clips });
  material.dispose();
  return result as ArrayBuffer;
}
