"use client";

/**
 * The machine, as real geometry.
 *
 * A glTF of the Apple II lit in-browser, turned freely by hand on every axis rather than scrubbed
 * through a fixed set of turntable frames. The model is normalised to its bounding sphere, so no
 * orientation it can be dragged into ever leaves the canvas.
 *
 * The chart is baked onto the monitor's own texture rather than laid over the canvas, so it turns,
 * foreshortens and catches the light with the glass it is drawn on.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Bounding-sphere radius the model is scaled to. Camera at 4.2 with a 28° lens shows ≈ 2.09 units. */
const RADIUS = 1.0;

/** What the machine is showing: mandate size armed per hour, across the three chains. */
const CRT_SERIES = [3, 5, 4, 7, 6, 9, 8, 12, 10, 14, 13, 17, 16, 21, 19, 24];
/** Amber phosphor, the signal orange as a lit tube would show it. */
const PHOSPHOR = "rgb(255, 118, 38)";
const glow = (a: number) => `rgba(255, 118, 38, ${a})`;

const SCREEN_TEXTURE = "/model/textures/Monitor_baseColor.jpg";

/**
 * The lit tube, in texture pixels. The source texture is almost entirely glass — the moulded bezel
 * only eats the outermost few pixels of the UV square — so the chart is given that whole area
 * rather than the smaller box it used to sit in, which left a dark margin the model read as unused
 * screen. Anything drawn outside this rect lands on plastic, not phosphor.
 */
const TUBE = { x: 30, y: 20, w: 458, h: 468 };

/**
 * Paint the chart over the monitor's original texture. Drawn at the texture's own 512px so nothing
 * is resampled, and every interior measure is derived from TUBE so the layout follows the tube
 * instead of being pinned to numbers that only suited one size of it.
 */
function paintScreen(glass: HTMLImageElement): HTMLCanvasElement {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.drawImage(glass, 0, 0, size, size);

  const { x: x0, y: y0, w, h } = TUBE;

  // Dim the tube so the phosphor reads against it. Clamped to the canvas: the tube now reaches
  // close enough to the edge that the old unconditional 8px bleed would run off it.
  const bleed = 6;
  g.fillStyle = "rgba(14, 9, 6, 0.74)";
  g.fillRect(
    Math.max(0, x0 - bleed),
    Math.max(0, y0 - bleed),
    Math.min(size, x0 + w + bleed) - Math.max(0, x0 - bleed),
    Math.min(size, y0 + h + bleed) - Math.max(0, y0 - bleed),
  );

  // Caption and prompt scale with the tube, so widening it makes the readout bigger rather than
  // stranding the same small type in a larger frame.
  const cap = Math.round(h * 0.045);
  g.font = `600 ${cap}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.textBaseline = "top";
  g.fillStyle = PHOSPHOR;
  g.fillText("ARMED / HOUR", x0, y0);
  g.textAlign = "right";
  g.fillText("3 CHAINS", x0 + w, y0);
  g.textAlign = "left";

  // Plot area: everything between the caption and the prompt line.
  const px = x0;
  const py = y0 + cap * 2;
  const pw = w;
  const ph = h - cap * 2 - Math.round(cap * 2.2);
  const max = Math.max(...CRT_SERIES);

  g.strokeStyle = glow(0.22);
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = py + (ph * i) / 4 + 0.5;
    g.beginPath();
    g.moveTo(px, y);
    g.lineTo(px + pw, y);
    g.stroke();
  }

  // Stepped bars, the way a machine of this age would draw them.
  const gap = 4;
  const bw = (pw - gap * (CRT_SERIES.length - 1)) / CRT_SERIES.length;
  g.fillStyle = glow(0.55);
  CRT_SERIES.forEach((v, i) => {
    const bh = Math.round((v / max) * ph);
    g.fillRect(Math.round(px + i * (bw + gap)), py + ph - bh, Math.round(bw), bh);
  });

  // The line over the bars, full phosphor.
  g.strokeStyle = PHOSPHOR;
  g.lineWidth = 3;
  g.lineJoin = "round";
  g.beginPath();
  CRT_SERIES.forEach((v, i) => {
    const x = px + i * (bw + gap) + bw / 2;
    const y = py + ph - (v / max) * ph;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();

  const prompt = Math.round(cap * 0.85);
  g.font = `500 ${prompt}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.fillStyle = glow(0.75);
  g.fillText("> CROSSPERMIT_", x0, y0 + h - prompt * 1.3);

  // Scanlines, so it reads as a tube and not a sticker.
  const sx = Math.max(0, x0 - bleed);
  const sw = Math.min(size, x0 + w + bleed) - sx;
  g.fillStyle = "rgba(0, 0, 0, 0.28)";
  for (let y = y0; y < y0 + h; y += 3) g.fillRect(sx, y, sw, 1);

  return c;
}

export function Machine() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    camera.position.set(0, 0.35, 4.2);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cfca, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-4, 2, -3);
    scene.add(fill);

    // Trackball rather than orbit: no pole clamp, roll included — every axis is free. Slow and
    // heavily damped: it should feel like turning a machine, not flicking a globe.
    const controls = new TrackballControls(camera, renderer.domElement);
    controls.noZoom = true;
    controls.noPan = true;
    controls.rotateSpeed = 0.3;
    controls.dynamicDampingFactor = 0.3; // a short glide after release, never a spin

    const pivot = new THREE.Group();
    pivot.rotation.y = -0.45;
    scene.add(pivot);

    new GLTFLoader().load("/model/scene.gltf", (gltf) => {
      const m = gltf.scene;
      const sphere = new THREE.Box3().setFromObject(m).getBoundingSphere(new THREE.Sphere());
      const s = RADIUS / sphere.radius;
      m.scale.setScalar(s);
      m.position.copy(sphere.center).multiplyScalar(-s);
      pivot.add(m);

      // The chart goes onto the monitor's glass once its own texture is in hand.
      const glass = new Image();
      glass.onload = () => {
        const tex = new THREE.CanvasTexture(paintScreen(glass));
        tex.colorSpace = THREE.SRGBColorSpace;
        // Default flipY stays on: the source texture was loaded with it off, but a canvas is
        // drawn top-down, and the mesh reads it the same way it reads any browser image.
        m.traverse((o) => {
          const mesh = o as THREE.Mesh;
          const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
          if (!mesh.isMesh || mat?.name !== "Monitor") return;
          mat.map = tex;
          mat.color.set(0xffffff);
          mat.emissive.set(0xffffff);
          mat.emissiveMap = tex;
          mat.emissiveIntensity = 0.55;
          mat.needsUpdate = true;
        });
      };
      glass.src = SCREEN_TEXTURE;
    });

    // Idle drift is the affordance; it retires the moment somebody takes hold.
    let turned = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const take = () => {
      turned = true;
      el.classList.add("turned");
    };
    renderer.domElement.addEventListener("pointerdown", take, { once: true });

    const fit = () => {
      // Layout size, not the bounding rect: the entrance tween scales the wrapper and a rect taken
      // mid-tween would leave the canvas at a fraction of its real resolution.
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      controls.handleResize();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();

    renderer.setAnimationLoop(() => {
      if (!turned) pivot.rotation.y += 0.0005;
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className="cpu-stage" ref={host} aria-label="An Apple II with two disk drives" role="img" />;
}
