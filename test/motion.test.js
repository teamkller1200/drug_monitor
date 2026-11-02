import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.matchMedia ??= () => ({ matches: false });
const { project, rubberband } = await import('../src/motion.js');

test('project throws further with more velocity and is zero at rest', () => {
  assert.equal(project(0), 0);
  assert.ok(Math.abs(project(1000) - 499) < 1e-9);
});

test('rubberband follows less the further it is pulled and keeps direction', () => {
  assert.ok(rubberband(100, 300) < 100);
  assert.ok(rubberband(400, 300) - rubberband(300, 300) < rubberband(100, 300));
  assert.equal(rubberband(-100, 300), -rubberband(100, 300));
});
