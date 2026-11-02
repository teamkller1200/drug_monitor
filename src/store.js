const VAULT = 'dm.vault';
const OPLOCK = 'dm.oplock';
const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function emptyData() {
  return { profile: { weightKg: 60 }, doses: [], settings: { allowAddWhileLocked: false } };
}

export function validateData(data) {
  const ok =
    data && typeof data === 'object' &&
    data.profile && typeof data.profile === 'object' &&
    Number.isFinite(data.profile.weightKg) && data.profile.weightKg > 0 &&
    Array.isArray(data.doses) &&
    data.doses.every((d) =>
      typeof d.id === 'string' && typeof d.itemId === 'string' && typeof d.route === 'string' &&
      !Number.isNaN(new Date(d.takenAt).getTime()) &&
      d.amount && Number.isFinite(d.amount.min) && Number.isFinite(d.amount.max) &&
      d.amount.min >= 0 && d.amount.max >= d.amount.min);
  if (!ok) throw new Error('データの形式が正しくありません');
  return { settings: emptyData().settings, ...data };
}

export function createStore(storage) {
  let key = null;
  let salt = null;

  async function save(data) {
    if (!key) throw new Error('locked');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data_ = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
    storage.setItem(VAULT, JSON.stringify({ salt: toB64(salt), iv: toB64(iv), data: toB64(data_), iterations: ITERATIONS }));
  }

  return {
    hasVault: () => storage.getItem(VAULT) !== null,

    async create(password, data = emptyData()) {
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await deriveKey(password, salt, ITERATIONS);
      await save(data);
      return data;
    },

    // A wrong password makes AES-GCM reject, and the vault is left untouched.
    async unlock(password) {
      const v = JSON.parse(storage.getItem(VAULT));
      const s = fromB64(v.salt);
      const k = await deriveKey(password, s, v.iterations);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(v.iv) }, k, fromB64(v.data));
      [key, salt] = [k, s];
      return JSON.parse(dec.decode(plain));
    },

    save,
    lock() { key = null; },
    isUnlocked: () => key !== null,

    wipe() {
      key = null;
      storage.removeItem(VAULT);
      storage.removeItem(OPLOCK);
    },

    readOpLock: () => JSON.parse(storage.getItem(OPLOCK) ?? 'null'),
    writeOpLock: (state) => storage.setItem(OPLOCK, JSON.stringify(state)),
  };
}
