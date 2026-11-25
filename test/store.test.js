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

// Builds a vault in the old encrypted layout so migration can be exercised.
async function legacyVault(password, data) {
  const enc = new TextEncoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
  return JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(cipher), iterations: 600000 });
}

test('data round-trips without a password', async () => {
  const mem = memory();
  const s = createStore(mem);
  await s.create({ ...emptyData(), doses: [dose] });
  const fresh = createStore(mem);
  assert.equal(fresh.hasVault(), true);
  assert.equal(fresh.hasLegacyVault(), false);
  assert.deepEqual(fresh.read().doses, [dose]);
});

test('an empty store reads as default data', () => {
  const s = createStore(memory());
  assert.equal(s.hasVault(), false);
  assert.deepEqual(s.read(), emptyData());
});

test('a legacy encrypted vault is migrated with the right password only', async () => {
  const mem = memory();
  mem.setItem('dm.vault', await legacyVault('pw', { ...emptyData(), doses: [dose] }));
  const s = createStore(mem);
  assert.equal(s.hasLegacyVault(), true);
  assert.equal(s.hasVault(), false);
  await assert.rejects(s.unlockLegacy('nope'));
  assert.equal(s.hasLegacyVault(), true);
  assert.deepEqual((await s.unlockLegacy('pw')).doses, [dose]);
  assert.equal(s.hasLegacyVault(), false);
  assert.deepEqual(s.read().doses, [dose]);
  assert.ok(!mem.dump().includes('"salt"'));
});

test('saves replace the stored data', async () => {
  const mem = memory();
  const s = createStore(mem);
  const data = await s.create();
  await s.save({ ...data, profile: { weightKg: 80 } });
  assert.equal(createStore(mem).read().profile.weightKg, 80);
});

test('wipe removes the vault and the lock flag', async () => {
  const mem = memory();
  const s = createStore(mem);
  await s.create();
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
