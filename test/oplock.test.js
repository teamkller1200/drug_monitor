import test from 'node:test';
import assert from 'node:assert/strict';
import * as lock from '../src/oplock.js';

const H = 3600e3;
const MIN = 60e3;
const T0 = 1000 * H;
const locked = () => lock.start(lock.unlocked(), T0, 6);

test('mutations are refused while locked and allowed otherwise', () => {
  for (const a of ['dose:add', 'dose:edit', 'dose:delete', 'settings:update', 'data:export', 'data:import', 'data:wipe']) {
    assert.equal(lock.allowed(a, locked(), T0), false, a);
    assert.equal(lock.allowed(a, lock.unlocked(), T0), true, a);
  }
});

test('navigation and the unlock steps stay available', () => {
  for (const a of ['nav', 'vault:lock', 'unlock:request', 'unlock:cancel', 'unlock:finish']) {
    assert.equal(lock.allowed(a, locked(), T0), true, a);
  }
});

test('add-while-locked only opens dose:add', () => {
  const settings = { allowAddWhileLocked: true };
  assert.equal(lock.allowed('dose:add', locked(), T0, settings), true);
  assert.equal(lock.allowed('dose:delete', locked(), T0, settings), false);
});

test('lock expires on its own', () => {
  assert.equal(lock.isLocked(locked(), T0 + 6 * H - 1), true);
  assert.equal(lock.isLocked(locked(), T0 + 6 * H), false);
});

test('extending moves the deadline later and start cannot shorten it', () => {
  const s = lock.extend(locked(), T0, 3);
  assert.equal(s.until, T0 + 9 * H);
  assert.equal(lock.start(s, T0, 1).until, T0 + 9 * H);
});

test('early unlock needs the wait and the reversed code', () => {
  const s = lock.requestUnlock(locked(), T0, '123456');
  assert.equal(lock.isLocked(lock.finishUnlock(s, T0 + 4 * MIN, '654321'), T0 + 4 * MIN), true);
  const wrong = lock.finishUnlock(s, T0 + 5 * MIN, '123456');
  assert.equal(lock.isLocked(wrong, T0 + 5 * MIN), true);
  assert.equal(wrong.unlockAt, null);
  assert.equal(lock.isLocked(lock.finishUnlock(s, T0 + 5 * MIN, '654321'), T0 + 5 * MIN), false);
});

test('repeating the request does not restart or skip the wait', () => {
  const s = lock.requestUnlock(locked(), T0, '123456');
  assert.equal(lock.requestUnlock(s, T0 + MIN, '999999').unlockAt, s.unlockAt);
});

test('the wait can be cancelled', () => {
  const s = lock.cancelUnlock(lock.requestUnlock(locked(), T0, '123456'));
  assert.equal(s.unlockAt, null);
  assert.equal(lock.isLocked(s, T0), true);
});
