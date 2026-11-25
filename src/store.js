const VAULT = 'dm.vault';
const OPLOCK = 'dm.oplock';
const VERSION = 2;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Only used to migrate a vault written by the old password-protected version.
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

const parse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export function createStore(storage) {
  const readPlain = () => {
    const v = parse(storage.getItem(VAULT));
    return v && v.v === VERSION ? v.data : null;
  };

  // Old layout: { salt, iv, data, iterations } with AES-GCM ciphertext.
  const readLegacy = () => {
    const v = parse(storage.getItem(VAULT));
    return v && v.v !== VERSION && typeof v.salt === 'string' ? v : null;
  };

  const save = (data) => storage.setItem(VAULT, JSON.stringify({ v: VERSION, data }));

  return {
    hasVault: () => readPlain() !== null,
    hasLegacyVault: () => readLegacy() !== null,
    read: () => readPlain() ?? emptyData(),

    async create(data = emptyData()) {
      save(data);
      return data;
    },

    // One-time migration from the password-protected version; afterwards the vault is plain.
    async unlockLegacy(password) {
      const v = readLegacy();
      if (!v) throw new Error('locked');
      const k = await deriveKey(password, fromB64(v.salt), v.iterations);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(v.iv) }, k, fromB64(v.data));
      const data = validateData(JSON.parse(dec.decode(plain)));
      save(data);
      return data;
    },

    save,

    wipe() {
      storage.removeItem(VAULT);
      storage.removeItem(OPLOCK);
    },

    readOpLock: () => JSON.parse(storage.getItem(OPLOCK) ?? 'null'),
    writeOpLock: (state) => storage.setItem(OPLOCK, JSON.stringify(state)),
  };
}
