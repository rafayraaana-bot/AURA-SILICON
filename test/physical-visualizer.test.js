import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayerGeometry, Gds3dRenderer } from '../public/gds-3d-renderer.js';
import { I7ConceptRenderer, i7ConceptSpec } from '../public/i7-concept-renderer.js';

test('builds finite extruded geometry from verified GDSII polygon coordinates', () => {
  const layer = {
    layer: 68,
    datatype: 20,
    polygons: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[12, 0], [16, 0], [16, 4], [12, 4]]
    ]
  };
  const geometry = buildLayerGeometry(layer, [0, 0, 20, 10], 2, 3, 0.5);
  const positions = geometry.getAttribute('position');

  assert.ok(positions.count > 0);
  assert.equal(positions.count % 3, 0);
  for (let index = 0; index < positions.count; index += 1) {
    assert.ok(Number.isFinite(positions.getX(index)));
    assert.ok(Number.isFinite(positions.getY(index)));
    assert.ok(positions.getZ(index) >= 3 && positions.getZ(index) <= 3.5);
  }
  geometry.dispose();
});

test('triangulates concave GDSII polygons without inventing XY coordinates', () => {
  const layer = {
    layer: 67,
    datatype: 0,
    polygons: [[[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]]]
  };
  const geometry = buildLayerGeometry(layer, [0, 0, 8, 8], 1, 0, 0.25);
  const positions = geometry.getAttribute('position');
  const xy = new Set();

  for (let index = 0; index < positions.count; index += 1) {
    xy.add(`${positions.getX(index)},${positions.getY(index)}`);
  }
  assert.ok(positions.count > 0);
  assert.ok([...xy].every((point) => {
    const [x, y] = point.split(',').map(Number);
    return x >= -4 && x <= 4 && y >= -4 && y <= 4;
  }));
  geometry.dispose();
});

test('keeps the i7-1165G7-inspired floorplan clearly illustrative and distinct from verified GDSII', () => {
  assert.equal(i7ConceptSpec.classification, 'illustrative-not-intel-gdsii');
  assert.match(i7ConceptSpec.disclaimer, /not Intel design data/i);
  assert.match(i7ConceptSpec.title, /i7-1165G7-inspired/i);
  assert.equal(i7ConceptSpec.blocks.filter((block) => block.id.startsWith('cpu-')).length, 4);
  assert.ok(i7ConceptSpec.blocks.some((block) => block.id === 'shared-cache'));
  assert.ok(i7ConceptSpec.blocks.some((block) => block.id === 'xe-graphics'));
  assert.equal(new Set(i7ConceptSpec.blocks.map((block) => block.id)).size, i7ConceptSpec.blocks.length);
  for (const block of i7ConceptSpec.blocks) {
    assert.ok(block.x - block.width / 2 >= -12.25);
    assert.ok(block.x + block.width / 2 <= 12.25);
    assert.ok(block.y - block.height / 2 >= -8.25);
    assert.ok(block.y + block.height / 2 <= 8.25);
  }
});

test('provides camera-reset and auto-rotation controls in both 3D renderers', () => {
  for (const Renderer of [Gds3dRenderer, I7ConceptRenderer]) {
    assert.equal(typeof Renderer.prototype.resetView, 'function');
    assert.equal(typeof Renderer.prototype.setAutoRotate, 'function');
  }
});
