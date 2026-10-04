import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function buildLayerGeometry(layer, bounds, scale, baseZ, depth) {
  const [minX, minY, maxX, maxY] = bounds;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const positions = [];
  const pointAt = (point, z) => [
    (point.x - centerX) * scale,
    (point.y - centerY) * scale,
    z
  ];
  const triangle = (first, second, third) => positions.push(...first, ...second, ...third);

  for (const polygon of layer.polygons) {
    const points = polygon.filter((point, index) => {
      const previous = polygon[(index + polygon.length - 1) % polygon.length];
      return point[0] !== previous[0] || point[1] !== previous[1];
    });
    if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) {
      points.pop();
    }
    if (points.length < 3) continue;

    let contour = points.map(([x, y]) => new THREE.Vector2(x, y));
    if (THREE.ShapeUtils.isClockWise(contour)) contour = contour.reverse();
    const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [first, second, third] of triangles) {
      triangle(
        pointAt(contour[first], baseZ + depth),
        pointAt(contour[second], baseZ + depth),
        pointAt(contour[third], baseZ + depth)
      );
      triangle(
        pointAt(contour[third], baseZ),
        pointAt(contour[second], baseZ),
        pointAt(contour[first], baseZ)
      );
    }

    for (let index = 0; index < contour.length; index += 1) {
      const first = contour[index];
      const second = contour[(index + 1) % contour.length];
      const firstBottom = pointAt(first, baseZ);
      const secondBottom = pointAt(second, baseZ);
      const firstTop = pointAt(first, baseZ + depth);
      const secondTop = pointAt(second, baseZ + depth);
      triangle(firstBottom, secondBottom, secondTop);
      triangle(firstBottom, secondTop, firstTop);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export class Gds3dRenderer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#070b12');
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 5000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', 'Orbit, zoom, and pan the verified GDSII exploded layer model');
    this.renderer.domElement.tabIndex = 0;
    this.container.replaceChildren(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.screenSpacePanning = true;
    this.controls.maxDistance = 4000;
    this.layerGroups = new Map();
    this.geometry = new Set();
    this.materials = new Set();

    this.scene.add(new THREE.AmbientLight('#b7d9ff', 1.8));
    const keyLight = new THREE.DirectionalLight('#ffffff', 3.2);
    keyLight.position.set(120, -100, 180);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight('#68bfff', 1.5);
    fillLight.position.set(-110, 120, 90);
    this.scene.add(fillLight);
    this.grid = new THREE.GridHelper(120, 24, '#295474', '#172d40');
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.animate();
  }

  addPreview(preview) {
    for (const group of this.layerGroups.values()) {
      this.scene.remove(group);
      for (const mesh of group.children) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    }
    this.layerGroups.clear();
    this.geometry.clear();
    this.materials.clear();

    const [minX, minY, maxX, maxY] = preview.bounds;
    const physicalWidth = maxX - minX;
    const physicalHeight = maxY - minY;
    const scale = 110 / Math.max(physicalWidth, physicalHeight);
    const layerSpacing = Math.max(1.15, Math.min(2.5, 100 / Math.max(preview.layers.length, 1)));
    const depth = Math.min(0.55, layerSpacing * 0.4);

    preview.layers.forEach((layer, index) => {
      const key = `${layer.layer}/${layer.datatype}`;
      const hue = ((layer.layer * 47 + layer.datatype * 19 + 185) % 360) / 360;
      const color = new THREE.Color().setHSL(hue, 0.83, 0.66);
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: color.clone().multiplyScalar(0.13),
        metalness: 0.24,
        roughness: 0.46,
        side: THREE.DoubleSide
      });
      const layerGeometry = buildLayerGeometry(layer, preview.bounds, scale, index * layerSpacing, depth);
      const group = new THREE.Group();
      group.name = key;
      group.add(new THREE.Mesh(layerGeometry, material));
      this.scene.add(group);
      this.layerGroups.set(key, group);
      this.geometry.add(layerGeometry);
      this.materials.add(material);
    });

    const centerZ = Math.max(0, (preview.layers.length - 1) * layerSpacing / 2);
    this.grid.position.z = -layerSpacing;
    this.controls.target.set(0, 0, centerZ);
    const distance = Math.max(physicalWidth, physicalHeight, centerZ + 1) * scale * 1.55;
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(distance * 0.85, -distance * 1.05, centerZ + distance * 0.9);
    this.camera.near = Math.max(0.01, distance / 5000);
    this.camera.far = Math.max(5000, distance * 8);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.resize();
    this.controls.saveState();
  }

  resetView() {
    this.controls.reset();
  }

  setAutoRotate(enabled) {
    this.controls.autoRotate = enabled;
  }

  setLayerVisible(key, visible) {
    const group = this.layerGroups.get(key);
    if (group) group.visible = visible;
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

  animate() {
    this.frame = window.requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.geometry.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.layerGroups.clear();
  }
}
