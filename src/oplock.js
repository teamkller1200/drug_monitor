const H = 3600e3;
const MIN = 60e3;
export const LOCK_HOURS = [1, 3, 6, 12];
export const UNLOCK_WAIT_MIN = 5;

const ALWAYS = new Set(['nav', 'vault:lock', 'lock:extend', 'unlock:request', 'unlock:cancel', 'unlock:finish']);

export const unlocked = () => ({ until: 0, unlockAt: null, code: null });

export function isLocked(state, now) {
  return state.until > now;
}

export function start(state, now, hours) {
  if (isLocked(state, now)) return state;
  return { ...unlocked(), until: now + hours * H };
}

// The deadline only ever moves later, so a confused user cannot shorten it.
export function extend(state, now, hours) {
  return isLocked(state, now) ? { ...state, until: state.until + hours * H } : state;
}

export function requestUnlock(state, now, code) {
  if (!isLocked(state, now) || state.unlockAt) return state;
  return { ...state, unlockAt: now + UNLOCK_WAIT_MIN * MIN, code };
}

export function cancelUnlock(state) {
  return { ...state, unlockAt: null, code: null };
}

export function waitOver(state, now) {
  return state.unlockAt !== null && now >= state.unlockAt;
}

export function finishUnlock(state, now, typed) {
  if (!waitOver(state, now)) return state;
  return typed === [...state.code].reverse().join('') ? unlocked() : cancelUnlock(state);
}

export function allowed(action, state, now, settings = {}) {
  if (!isLocked(state, now) || ALWAYS.has(action)) return true;
  return action === 'dose:add' && !!settings.allowAddWhileLocked;
}
