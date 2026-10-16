import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import './auth-orbit.css';

const gallery = ['mist', 'forest', 'night', 'ocean', 'cosmos', 'color', 'gallery', 'painting', 'studio', 'lake', 'coast', 'canopy', 'journey', 'gradient', 'golden'];
const pictures = gallery.map(name => `${import.meta.env.BASE_URL}auth-gallery/${name}.webp`);
const vertexShader = `
  varying vec2 vUv;
  uniform float uCurve;
  uniform float uHover;
  uniform vec2 uPointer;
  void main() {
    vUv = uv;
    vec3 p = position;
    p.z += (1.0 - pow(p.x * 2.0, 2.0)) * uCurve;
    p.z += exp(-length(uv - uPointer) * 5.0) * uHover * 18.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const fragmentShader = `
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform vec2 uRepeat;
  uniform vec2 uSize;
  uniform float uOpacity;
  uniform float uHover;
  uniform float uFlare;
  void main() {
    vec2 uv = (vUv - 0.5) * uRepeat + 0.5;
    vec2 shift = (vUv - 0.5) * (0.008 * (1.0 - uHover) + uFlare);
    vec3 color = vec3(texture2D(uMap, uv + shift).r, texture2D(uMap, uv).g, texture2D(uMap, uv - shift).b);
    vec2 q = abs((vUv - 0.5) * uSize) - uSize * 0.5 + 9.0;
    float edge = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 9.0;
    float alpha = 1.0 - smoothstep(-0.8, 0.8, edge);
    float frame = smoothstep(-1.8, -0.7, edge) * 0.15;
    color = mix(color, vec3(0.85, 0.94, 0.95), frame);
    gl_FragColor = vec4(color, alpha * uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Decorative, local-only image galaxy. No account images or GPU inference are used. */
export default function AuthOrbit() {
  const host = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const wake = useRef<(() => void) | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); }
    catch { element.dataset.state = 'static'; return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.setClearColor(0x101415, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 12000);
    const guides = new THREE.Group();
    const field = new THREE.Group();
    scene.add(guides, field);
    const geometry = new THREE.PlaneGeometry(1, 1, 20, 12);
    const loader = new THREE.TextureLoader();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2(5, 5);
    const resources: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [geometry];
    const textures = pictures.map(src => {
      const texture = loader.load(src, () => schedule(), undefined, () => { element.dataset.assetError = 'true'; });
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      resources.push(texture);
      return texture;
    });
    type Card = { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; arm: number; slot: number; held: number; lock: number; holdOffset: number; hover: number; flare: number; x: number; y: number; h: number };
    let cards: Card[] = [];
    let width = 1, height = 1, radius = 1, slots = 1, arms = 6;
    let frame = 0, disposed = false, clock = 0, previous = performance.now();
    let journey = 0, spin = -0.28, spinVelocity = 0, rest = 0;
    let target = -1, boosted = -1, boost = 0;
    let rx = 0, ry = 0, vx = 0, vy = 0, tx = 0, ty = 0;
    let active = false, dragging = false, downX = 0, downY = 0, dragDistance = 0;
    let lastX = 0, lastY = 0, mouseX = 0, mouseY = 0;
    const pulses: Array<{ x: number; y: number; time: number }> = [];
    const lineMaterial = new THREE.LineBasicMaterial({ color: '#92b6ba', transparent: true, opacity: 0.13, depthTest: false });
    resources.push(lineMaterial);

    function isMoving() { return !reduced.matches && !pausedRef.current && !document.hidden; }
    const fraction = (value: number) => value - Math.floor(value);
    function schedule() {
      if (!disposed && !frame) frame = requestAnimationFrame(render);
    }
    wake.current = schedule;
    function layout() {
      width = element!.clientWidth; height = element!.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.position.z = height / (2 * Math.tan(THREE.MathUtils.degToRad(22.5)));
      camera.updateProjectionMatrix();
      radius = Math.hypot(width, height) * 0.5;
      const mobile = width < 680;
      arms = mobile ? 3 : 6;
      const count = mobile ? 14 : Math.max(24, Math.round(56 * Math.min(1, width * height / 1650000)));
      slots = Math.ceil(count / arms);
      for (const card of cards) { field.remove(card.mesh); card.mesh.material.dispose(); }
      cards = Array.from({ length: count }, (_, index) => {
        const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, transparent: true, depthTest: false, depthWrite: false,
          uniforms: { uMap: { value: textures[(index * 7) % textures.length] }, uRepeat: { value: new THREE.Vector2(1, 1) }, uSize: { value: new THREE.Vector2(160, 110) }, uOpacity: { value: 0 }, uHover: { value: 0 }, uFlare: { value: 0 }, uCurve: { value: 26 }, uPointer: { value: new THREE.Vector2(0.5, 0.5) } },
        });
        const mesh = new THREE.Mesh(geometry, material);
        field.add(mesh);
        return { mesh, arm: index % arms, slot: Math.floor(index / arms), held: 0, lock: 0, holdOffset: 0, hover: 0, flare: 0, x: 0, y: 0, h: 0 };
      });
      for (const object of [...guides.children]) { guides.remove(object); (object as THREE.Line).geometry.dispose(); }
      const outer = radius + height * 0.3;
      for (let arm = 0; arm < arms; arm++) {
        const points: THREE.Vector3[] = [];
        for (let n = 0; n <= 220; n++) {
          const p = n / 220, a = arm * Math.PI * 2 / arms + p * Math.PI * 2.1;
          const r = radius * 0.08 + p * outer;
          points.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, -35));
        }
        guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial));
        const ticks: THREE.Vector3[] = [];
        for (let n = 5; n < 20; n++) {
          const p = n / 20, a = arm * Math.PI * 2 / arms + p * Math.PI * 2.1;
          const r = radius * 0.08 + p * outer;
          ticks.push(new THREE.Vector3(Math.cos(a) * (r - 3), Math.sin(a) * (r - 3), -34), new THREE.Vector3(Math.cos(a) * (r + 3), Math.sin(a) * (r + 3), -34));
        }
        guides.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), lineMaterial));
      }
      const circlePoints = Array.from({ length: 181 }, (_, i) => new THREE.Vector3(Math.cos(i / 180 * Math.PI * 2) * radius * 0.56, Math.sin(i / 180 * Math.PI * 2) * radius * 0.56, -36));
      const dashed = new THREE.LineDashedMaterial({ color: '#92b6ba', transparent: true, opacity: 0.13, dashSize: 6, gapSize: 10 });
      const circle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePoints), dashed);
      circle.computeLineDistances(); guides.add(circle); resources.push(dashed);
      target = -1; boosted = -1;
      schedule();
    }
    function render(now: number) {
      frame = 0;
      if (disposed) return;
      const moving = isMoving();
      const dt = Math.min((now - previous) / 1000, 0.05); previous = now;
      const step = moving ? dt : 0;
      clock += step;
      const blend = (tau: number) => 1 - Math.exp(-step / tau);
      rest += ((target >= 0 ? 1 : 0) - rest) * blend(1);
      const advance = step * 0.57 / 60;
      journey += advance;
      spin += step * THREE.MathUtils.degToRad(-50) / 60 * (1 - rest) + spinVelocity * step;
      spinVelocity *= Math.exp(-step / 0.6);
      // Damped spring: mass 1, stiffness 100, damping 10; velocity survives retargeting.
      vx += ((tx - rx) * 100 - vx * 10) * step;
      vy += ((ty - ry) * 100 - vy * 10) * step;
      rx += vx * step; ry += vy * step;
      field.rotation.set(rx, ry, 0); guides.rotation.set(rx, ry, spin);
      boost += ((boosted === target && boosted >= 0 ? 1 : 0) - boost) * blend(0.18);
      const outer = radius + height * 0.3;
      const cos = Math.cos(spin), sin = Math.sin(spin);
      const intro = reduced.matches ? 1 : Math.min(1, clock / 1.5);
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        card.held += ((target === i ? 1 : rest) - card.held) * blend(target === i ? 0.15 : 1);
        card.holdOffset -= advance * card.held;
        const p = fraction((card.slot + 0.5 + card.arm * 0.76) / slots + journey + card.holdOffset);
        const angle = card.arm * Math.PI * 2 / arms + p * Math.PI * 2.1;
        const r = radius * 0.08 + p * outer;
        card.hover += ((target === i ? 1 : 0) - card.hover) * blend(0.12);
        const drift = moving ? 6 * (1 - card.hover) : 0;
        const x = r * Math.cos(angle) + Math.sin(clock * 0.25 + i * 2.399) * drift;
        const y = r * Math.sin(angle) + Math.cos(clock * 0.35 + i * 1.713) * drift;
        card.x = x * cos - y * sin; card.y = x * sin + y * cos;
        const distance = Math.hypot(mouseX - card.x, mouseY - card.y);
        const influence = active ? Math.exp(-distance * distance / (320 * 320)) : 0;
        const tug = influence * 8 / Math.max(1, distance);
        card.mesh.position.set(card.x + (mouseX - card.x) * tug, card.y + (mouseY - card.y) * tug, card.hover * 45 + i * 0.01);
        let nearest = Infinity;
        for (let j = 0; j < cards.length; j++) {
          if (j === i) continue;
          const other = cards[j], op = fraction((other.slot + 0.5 + other.arm * 0.76) / slots + journey + other.holdOffset);
          const oa = other.arm * Math.PI * 2 / arms + op * Math.PI * 2.1;
          const or = radius * 0.08 + op * outer;
          nearest = Math.min(nearest, Math.max(Math.abs(x - or * Math.cos(oa)) / 1.55, Math.abs(y - or * Math.sin(oa))));
        }
        const base = Math.max(35, Math.min(height * 0.23, nearest * 0.82, height * (0.065 + p * 0.19)));
        card.h = base * (1 + card.hover * 0.1 + (i === boosted ? boost * 1.35 : 0));
        const aspect = 1 + Math.min(1, p / 0.3) * 0.6;
        const w = card.h * aspect;
        card.mesh.scale.set(w, card.h, 1);
        card.mesh.rotation.set(-ry * 0.65, -rx * 0.5, Math.sin(i * 1.7 + clock * 0.06) * 0.025 * (1 - card.hover));
        const uniforms = card.mesh.material.uniforms;
        uniforms.uSize.value.set(w, card.h);
        const image = uniforms.uMap.value.image as HTMLImageElement | undefined;
        if (!image?.width) { card.mesh.visible = false; continue; }
        card.mesh.visible = true;
        const imageAspect = image.width / image.height;
        uniforms.uRepeat.value.set(imageAspect > aspect ? aspect / imageAspect : 1, imageAspect < aspect ? imageAspect / aspect : 1);
        uniforms.uOpacity.value = Math.min(1, p / 0.14) * intro * 0.95;
        uniforms.uHover.value = card.hover;
        uniforms.uCurve.value = 24 * (1 - card.hover * 0.85);
        card.flare = Math.max(card.flare * Math.exp(-step * 3), influence * 0.018 * (1 - card.hover));
        let ripple = 0;
        for (const pulse of pulses) {
          const age = clock - pulse.time;
          const delta = Math.abs(Math.hypot(card.x - pulse.x, card.y - pulse.y) - age * 900);
          ripple += Math.exp(-delta * delta / (140 * 140)) * Math.max(0, 1 - age / 1.8) * 0.025;
        }
        uniforms.uFlare.value = card.flare + ripple;
        card.mesh.renderOrder = card.hover > 0.2 ? 100 + i : i;
      }
      while (pulses[0] && clock - pulses[0].time > 1.8) pulses.shift();
      scene.updateMatrixWorld();
      if (moving && active && !dragging) {
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(cards.filter(c => c.mesh.visible).map(c => c.mesh))[0];
        target = hit ? cards.findIndex(c => c.mesh === hit.object) : -1;
        if (hit?.uv && target >= 0) cards[target].mesh.material.uniforms.uPointer.value.copy(hit.uv);
      } else if (!active) target = -1;
      element!.dataset.hovered = String(target);
      element!.dataset.state = moving ? 'running' : 'paused';
      renderer.domElement.style.cursor = target >= 0 ? dragging ? 'grabbing' : 'pointer' : dragging ? 'grabbing' : 'grab';
      renderer.render(scene, camera);
      if (moving) schedule();
    }
    function move(event: PointerEvent) {
      if (!fine.matches || !isMoving()) return;
      const onForm = (event.target as Element).closest('.auth-card, .auth-header, .auth-motion-toggle');
      active = !onForm;
      const dx = event.clientX - lastX, dy = event.clientY - lastY;
      lastX = event.clientX; lastY = event.clientY;
      mouseX = event.clientX - width / 2; mouseY = height / 2 - event.clientY;
      pointer.set(event.clientX / width * 2 - 1, -event.clientY / height * 2 + 1);
      tx = active ? mouseY / height * 0.08 : 0;
      ty = active ? mouseX / width * 0.08 : 0;
      if (active) spinVelocity = Math.max(-0.45, Math.min(0.45, spinVelocity + dx * (dragging ? 0.007 : 0.0006)));
      if (dragging) { spin += dx * 0.0018; journey += dy * 0.00008; dragDistance = Math.hypot(event.clientX - downX, event.clientY - downY); }
    }
    function down(event: PointerEvent) {
      if (!isMoving() || event.target !== renderer.domElement) return;
      dragging = true; downX = lastX = event.clientX; downY = lastY = event.clientY; dragDistance = 0;
      renderer.domElement.setPointerCapture(event.pointerId);
    }
    function up(event: PointerEvent) {
      if (dragging && dragDistance < 5) {
        pulses.push({ x: event.clientX - width / 2, y: height / 2 - event.clientY, time: clock });
        boosted = boosted === target ? -1 : target;
      }
      dragging = false;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    }
    function wheel(event: WheelEvent) { if (isMoving() && event.target === renderer.domElement) { journey += event.deltaY * 0.00012; spinVelocity += Math.max(-0.12, Math.min(0.12, event.deltaY * 0.0001)); } }
    function leave() { active = false; target = -1; tx = 0; ty = 0; }
    function visibility() { previous = performance.now(); if (!document.hidden) schedule(); }
    function motionPreference() { previous = performance.now(); target = -1; if (reduced.matches) { tx = ty = rx = ry = vx = vy = 0; } schedule(); }
    const observer = new ResizeObserver(layout);
    observer.observe(element);
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointerup', up);
    renderer.domElement.addEventListener('pointercancel', up);
    renderer.domElement.addEventListener('wheel', wheel, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', motionPreference);
    layout();
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); wake.current = null;
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave);
      renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointerup', up); renderer.domElement.removeEventListener('pointercancel', up); renderer.domElement.removeEventListener('wheel', wheel);
      document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', motionPreference);
      for (const card of cards) card.mesh.material.dispose();
      for (const object of guides.children) (object as THREE.Line).geometry.dispose();
      for (const resource of resources) resource.dispose();
      renderer.dispose(); renderer.domElement.remove();
    };
  }, []);

  return <><div className="auth-orbit" ref={host} aria-hidden="true" /><div className="auth-orbit-scrim" aria-hidden="true" /><button type="button" className="auth-motion-toggle" aria-label={paused ? '播放动态背景' : '暂停动态背景'} aria-pressed={paused} onClick={() => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); wake.current?.(); }}><span aria-hidden="true">{paused ? '▷' : 'Ⅱ'}</span>{paused ? '播放背景' : '暂停背景'}</button></>;
}
