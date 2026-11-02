import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, valueAt, phaseAt } from '../src/pk.js';
import { evaluate, pkMods } from '../src/interactions.js';

const H = 3600e3;
const T0 = Date.UTC(2026, 0, 1);
const base = { elimination: 'linear', routes: { oral: { F: 1, ka: 4 } }, central: { halfLifeH: 2, VdLperKg: 1 } };
const opioid = { ...base, id: 'op', classes: ['opioid'] };
const benzo = { ...base, id: 'bz', classes: ['benzodiazepine'] };
const other = { ...base, id: 'ot', classes: [] };
const drugs = [opioid, benzo, other];
const rule = { a: 'class:opioid', b: 'class:benzodiazepine', kind: 'pd', severity: 'fatal', mechanism: '呼吸抑制', source: 's' };
const profile = { weightKg: 70 };
const dose = (drugId, h = 0, mg = 100) => ({ drugId, route: 'oral', takenAt: T0 + h * H, mgMin: mg, mgMax: mg });

function check(doses, now, { rules = [rule], limits = [] } = {}) {
  const results = simulate(doses, drugs, profile, { now });
  return evaluate({ doses, results, drugs, rules, limits, now });
}

test('a rule fires in either order while both are in the body', () => {
  const { alerts } = check([dose('bz'), dose('op')], T0 + H);
  assert.equal(alerts[0].severity, 'fatal');
  assert.deepEqual(alerts[0].items.sort(), ['bz', 'op']);
});

test('a dose still in its absorption lag already counts', () => {
  const lagged = { ...opioid, routes: { oral: { F: 1, ka: 4, tlagH: 0.5 } } };
  const list = [lagged, benzo];
  const doses = [dose('bz', -1), dose('op')];
  const now = T0 + 60e3;
  const results = simulate(doses, list, profile, { now });
  const { alerts } = evaluate({ doses, results, drugs: list, rules: [rule], limits: [], now });
  assert.equal(alerts[0]?.severity, 'fatal');
  assert.equal(phaseAt(results.op, now), 'onset');
});

test('no alert once one substance has gone', () => {
  const { alerts } = check([dose('op'), dose('bz', 20)], T0 + 21 * H);
  assert.equal(alerts.length, 0);
});

test('a pair without a rule is reported as unknown, never safe', () => {
  const { alerts, unknown } = check([dose('op'), dose('ot')], T0 + H);
  assert.equal(alerts.length, 0);
  assert.deepEqual(unknown, [['op', 'ot']]);
});

test('cumulative limit warns near and over the limit, across doses', () => {
  const limits = [{ drug: 'ot', windowH: 24, maxMg: 300, severity: 'fatal', source: 's' }];
  const near = check([dose('ot'), dose('ot', 1, 150)], T0 + 2 * H, { limits });
  assert.equal(near.alerts[0].severity, 'caution');
  const over = check([dose('ot'), dose('ot', 1, 250)], T0 + 2 * H, { limits });
  assert.equal(over.alerts[0].severity, 'fatal');
  const expired = check([dose('ot'), dose('ot', 1, 250)], T0 + 30 * H, { limits });
  assert.equal(expired.alerts.length, 0);
});

test('alerts are sorted by severity', () => {
  const rules = [{ ...rule, severity: 'caution' }, rule];
  const { alerts } = check([dose('op'), dose('bz')], T0 + H, { rules });
  assert.deepEqual(alerts.map((a) => a.severity), ['fatal', 'caution']);
});

test('an inhibitor slows the target only while it is present', () => {
  const rules = [{ a: 'drug:ot', b: 'drug:op', kind: 'pk', effect: { clMult: 0.2 }, severity: 'caution', mechanism: 'm', source: 's' }];
  const doses = [dose('ot'), dose('op')];
  const now = T0 + H;
  const baseRun = simulate(doses, drugs, profile, { now });
  const modded = simulate(doses, drugs, profile, { now, pkMods: pkMods(rules, baseRun, drugs) });
  const at = T0 + 4 * H;
  assert.ok(valueAt(modded.op.t, modded.op.c, at) > valueAt(baseRun.op.t, baseRun.op.c, at));
  near(valueAt(modded.ot.t, modded.ot.c, at), valueAt(baseRun.ot.t, baseRun.ot.c, at));
});

function near(a, b) {
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
}
