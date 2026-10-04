import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const i7ConceptSpec = Object.freeze({
  title: 'Intel Core i7-1165G7-inspired concept',
  classification: 'illustrative-not-intel-gdsii',
  disclaimer: 'Illustrative floorplan only; not Intel design data, measured silicon, or fabrication geometry.',
  blocks: Object.freeze([
    Object.freeze({ id: 'cpu-0', label: 'CPU CORE 0', x: -7.2, y: 4.6, width: 4.7, height: 3.4, color: '#55b9ff' }),
    Object.freeze({ id: 'cpu-1', label: 'CPU CORE 1', x: -1.9, y: 4.6, width: 4.7, height: 3.4, color: '#55b9ff' }),
    Object.freeze({ id: 'cpu-2', label: 'CPU CORE 2', x: -7.2, y: 0.4, width: 4.7, height: 3.4, color: '#55b9ff' }),
    Object.freeze({ id: 'cpu-3', label: 'CPU CORE 3', x: -1.9, y: 0.4, width: 4.7, height: 3.4, color: '#55b9ff' }),
    Object.freeze({ id: 'shared-cache', label: 'SHARED L3 CACHE', x: -6.7, y: -4.4, width: 9.8, height: 2.6, color: '#4de2c5' }),
    Object.freeze({ id: 'xe-graphics', label: 'XE-LP GRAPHICS', x: 6.4, y: 3.0, width: 8.2, height: 6.4, color: '#a783ff' }),
    Object.freeze({ id: 'media-display', label: 'MEDIA / DISPLAY', x: 5.2, y: -1.5, width: 4.2, height: 2.8, color: '#ff9b61' }),
    Object.freeze({ id: 'system-agent', label: 'SYSTEM AGENT', x: 0.8, y: -4.3, width: 4.2, height: 2.7, color: '#ffd166' }),
    Object.freeze({ id: 'memory-io', label: 'MEMORY / I-O', x: 6.3, y: -4.3, width: 5.1, height: 2.7, color: '#ee789a' })
  ])
});

function makeLabel(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a canvas for processor block labels.');
  context.font = '700 32px Segoe UI, Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#07101b';
  context.fillRect(0, 5, canvas.width, canvas.height - 10);
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.strokeRect(1.5, 6.5, canvas.width - 3, canvas.height - 13);
  context.fillStyle = '#f4faff';
  context.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 16);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(4.4, 0.83, 1);
  return sprite;
}

export class I7ConceptRenderer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#070b12');
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', 'Orbit, zoom, and pan the illustrative i7-inspired concept floorplan');
    this.renderer.domElement.tabIndex = 0;
    container.replaceChildren(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.screenSpacePanning = true;
    this.controls.maxDistance = 110;
    this.geometries = new Set();
    this.materials = new Set();
    this.textures = new Set();

    this.scene.add(new THREE.AmbientLight('#b7d9ff', 1.6));
    const keyLight = new THREE.DirectionalLight('#ffffff', 3);
    keyLight.position.set(-12, -8, 24);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight('#68bfff', 1.4);
    fillLight.position.set(13, 11, 17);
    this.scene.add(fillLight);

    const grid = new THREE.GridHelper(36, 36, '#295474', '#172d40');
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -1.8;
    this.scene.add(grid);
    this.addSlab(0, 0, -1.05, 27, 19, 1.1, '#303947', 0.5, 0.65);
    this.addSlab(0, 0, -0.29, 25, 17, 0.36, '#6e7885', 0.32, 0.52);
    this.addSlab(0, 0, 0.02, 24.5, 16.5, 0.22, '#182c43', 0.18, 0.64);

    for (const block of i7ConceptSpec.blocks) this.addBlock(block);
    this.addInterconnect();

    this.controls.target.set(0, 0, 1.5);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(30, -38, 34);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.controls.saveState();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  track(geometry, material) {
    this.geometries.add(geometry);
    this.materials.add(material);
  }

  addSlab(x, y, z, width, height, depth, color, metalness, roughness) {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const material = new THREE.MeshStandardMaterial({ color, metalness, roughness, side: THREE.DoubleSide });
    this.track(geometry, material);
    this.scene.add(new THREE.Mesh(geometry, material).translateZ(z));
  }

  addBlock(block) {
    const group = new THREE.Group();
    group.name = block.id;
    group.position.set(block.x, block.y, 0.3);
    const geometry = new THREE.BoxGeometry(block.width, block.height, 1.05);
    const color = new THREE.Color(block.color);
    const material = new THREE.MeshStandardMaterial({
      color: color.clone().multiplyScalar(0.48),
      emissive: color,
      emissiveIntensity: 0.23,
      metalness: 0.25,
      roughness: 0.34
    });
    this.track(geometry, material);
    group.add(new THREE.Mesh(geometry, material).translateZ(0.525));

    const outlineGeometry = new THREE.EdgesGeometry(geometry);
    const outlineMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
    this.track(outlineGeometry, outlineMaterial);
    group.add(new THREE.LineSegments(outlineGeometry, outlineMaterial).translateZ(0.525));

    const label = makeLabel(block.label, block.color);
    this.textures.add(label.material.map);
    this.materials.add(label.material);
    label.position.set(0, 0, 1.08);
    label.scale.set(Math.min(block.width * 0.88, 5.3), 0.78, 1);
    group.add(label);
    this.scene.add(group);
  }

  addInterconnect() {
    const points = [
      [-10.2, -6.2, 1.0], [-10.2, 8.2, 1.0], [10.2, 8.2, 1.0],
      [10.2, -6.2, 1.0], [-10.2, -6.2, 1.0]
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
    const geometry = new THREE.TubeGeometry(curve, 120, 0.075, 6, true);
    const material = new THREE.MeshBasicMaterial({ color: '#55e6d3' });
    this.track(geometry, material);
    this.scene.add(new THREE.Mesh(geometry, material));

    const anchors = [
      [-7.2, 4.6], [-1.9, 4.6], [-7.2, 0.4], [-1.9, 0.4],
      [-6.7, -4.4], [6.4, 3.0], [5.2, -1.5], [0.8, -4.3], [6.3, -4.3]
    ];
    for (const [x, y] of anchors) {
      const from = new THREE.Vector3(x, y, 1.0);
      const to = new THREE.Vector3(x, y, 0.6);
      const trace = new THREE.BufferGeometry().setFromPoints([from, to]);
      const wire = new THREE.Line(trace, new THREE.LineBasicMaterial({ color: '#66bdf8' }));
      this.track(trace, wire.material);
      this.scene.add(wire);
    }
  }

  resize() {
    if (!this.container || !this.renderer) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  resetView() {
    this.controls.reset();
  }

  setAutoRotate(enabled) {
    this.controls.autoRotate = enabled;
  }

  animate() {
    this.frame = window.requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
