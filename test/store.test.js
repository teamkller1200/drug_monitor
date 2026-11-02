import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, emptyData, validateData } from '../src/store.js';

function memory() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => [...m.values()].join(),
  };
}

const dose = { id: 'a', itemId: 'secret-item', route: 'oral', takenAt: '2026-01-01T00:00:00Z', amount: { min: 1, max: 2 } };

test('data round-trips and nothing readable reaches storage', async () => {
  const mem = memory();
  const s = createStore(mem);
  await s.create('pw', { ...emptyData(), doses: [dose] });
  assert.ok(!mem.dump().includes('secret-item'));
  const fresh = createStore(mem);
  assert.deepEqual((await fresh.unlock('pw')).doses, [dose]);
});

test('a wrong password is rejected and keeps the vault', async () => {
  const mem = memory();
  await createStore(mem).create('pw');
  const s = createStore(mem);
  await assert.rejects(s.unlock('nope'));
  assert.equal(s.isUnlocked(), false);
  assert.ok(await s.unlock('pw'));
});

test('saves re-encrypt with a new iv and need the key', async () => {
  const mem = memory();
  const s = createStore(mem);
  const data = await s.create('pw');
  const before = mem.dump();
  await s.save(data);
  assert.notEqual(mem.dump(), before);
  s.lock();
  await assert.rejects(s.save(data), /locked/);
});

test('wipe removes the vault and the lock flag', async () => {
  const mem = memory();
  const s = createStore(mem);
  await s.create('pw');
  s.writeOpLock({ until: 1 });
  s.wipe();
  assert.equal(s.hasVault(), false);
  assert.equal(s.readOpLock(), null);
});

test('import validation rejects malformed data', () => {
  assert.ok(validateData({ profile: { weightKg: 60 }, doses: [dose] }).settings);
  for (const bad of [null, {}, { profile: {}, doses: [] }, { profile: { weightKg: 60 }, doses: [{ ...dose, amount: { min: 3, max: 1 } }] }]) {
    assert.throws(() => validateData(bad));
  }
});
