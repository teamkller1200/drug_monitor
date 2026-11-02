import test from 'node:test';
import assert from 'node:assert/strict';
import { expandDoses, simulate, simulateDrug, valueAt, phaseAt, isPresent } from '../src/pk.js';

const H = 3600e3;
const T0 = Date.UTC(2026, 0, 1);
// Round test fixtures, not real drug data.
const drug = {
  id: 'x', elimination: 'linear', cv: 0.3,
  routes: { oral: { F: 0.8, ka: 2 } },
  central: { halfLifeH: 5, VdLperKg: 1 },
};
const dose = (mg, h = 0) => ({ drugId: 'x', route: 'oral', takenAt: T0 + h * H, mgMin: mg, mgMax: mg });
const run = (d, doses, opts = {}, profile = { weightKg: 70 }) =>
  simulateDrug(d, doses, profile, { from: T0, to: T0 + 48 * H, ...opts });
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} vs ${b}`);

function bateman(tH) {
  const ke = Math.LN2 / 5, ka = 2, V = 70;
  return ((0.8 * 100 * ka) / (V * (ka - ke))) * (Math.exp(-ke * tH) - Math.exp(-ka * tH));
}

test('matches the Bateman solution', () => {
  const r = run(drug, [dose(100)]);
  for (const h of [0.5, 1, 3, 10, 24]) near(valueAt(r.t, r.c, T0 + h * H), bateman(h), 0.005);
});

test('doses superpose', () => {
  const a = run(drug, [dose(100)]);
  const b = run(drug, [dose(100, 6)]);
  const both = run(drug, [dose(100), dose(100, 6)]);
  const at = T0 + 12 * H;
  near(valueAt(both.t, both.c, at), valueAt(a.t, a.c, at) + valueAt(b.t, b.c, at), 1e-6);
});

test('zero-order elimination falls in a straight line', () => {
  const d = {
    id: 'z', elimination: 'zero',
    routes: { oral: { F: 1, ka: 8 } },
    central: { VdLperKg: 1, vmaxMgPerH: 7000 },
  };
  const r = run(d, [{ ...dose(30000), drugId: 'z' }]);
  const c = (h) => valueAt(r.t, r.c, T0 + h * H);
  near(c(1) - c(2), c(2) - c(3), 0.02);
});

test('saturable elimination has a longer apparent half-life at higher doses', () => {
  const d = { id: 'm', elimination: 'mm', routes: { iv: {} }, central: { VdLperKg: 1, vmaxMgPerH: 70, kmMgL: 1 } };
  const ratio = (mg) => {
    const r = run(d, [{ ...dose(mg), drugId: 'm', route: 'iv' }]);
    return valueAt(r.t, r.c, T0 + 2 * H) / valueAt(r.t, r.c, T0);
  };
  assert.ok(ratio(700) > ratio(35));
});

test('metabolite conserves mass', () => {
  const d = {
    ...drug, id: 'p',
    routes: { iv: {} },
    metabolites: [{ id: 'q', frac: 1, halfLifeH: 1e9, VdLperKg: 1 }],
  };
  const r = run(d, [{ ...dose(100), drugId: 'p', route: 'iv' }]);
  const i = r.t.length - 1;
  near((r.c[i] + r.metabolites.q[i]) * 70, 100, 1e-4);
});

test('smoker covariate shortens half-life, unmatched rule is ignored', () => {
  const d = { ...drug, covariates: [{ on: 'smoker', when: true, mult: { cl: 2 } }] };
  const at = T0 + 12 * H;
  const value = (profile) => {
    const r = run(d, [dose(100)], {}, profile);
    return valueAt(r.t, r.c, at);
  };
  assert.ok(value({ weightKg: 70, smoker: true }) < value({ weightKg: 70 }));
  near(value({ weightKg: 70, smoker: false }), value({ weightKg: 70 }), 1e-12);
});

test('weight scales volume and clearance', () => {
  const at = T0 + 1 * H;
  const value = (weightKg) => {
    const r = run(drug, [dose(100)], {}, { weightKg });
    return valueAt(r.t, r.c, at);
  };
  assert.ok(value(50) > value(70));
});

test('bands bracket the centre and carry the dose range', () => {
  const doses = [{ ...dose(100), mgMin: 50, mgMax: 200 }];
  const r = simulate(doses, [drug], { weightKg: 70 }, { now: T0 + H }).x;
  r.ce.forEach((v, i) => assert.ok(r.low[i] <= v + 1e-12 && v <= r.high[i] + 1e-12));
});

test('variability alone changes the elimination rate of the band edges', () => {
  const r = simulate([dose(100)], [drug], { weightKg: 70 }, { now: T0 + H }).x;
  const at = (arr, h) => valueAt(r.t, arr, T0 + h * H);
  // A faster edge must lose a larger share over time, not just start lower.
  assert.ok(at(r.low, 20) / at(r.low, 2) < at(r.high, 20) / at(r.high, 2));
});

test('phases move from onset through peak to comedown and gone', () => {
  const d = { ...drug, effect: { ke0: 1 } };
  const r = simulate([dose(100)], [d], { weightKg: 70 }, { now: T0, horizonH: 200 }).x;
  assert.equal(phaseAt(r, T0 + 0.05 * H), 'onset');
  const peakAt = r.t[r.ce.indexOf(r.peak)];
  assert.equal(phaseAt(r, peakAt), 'peak');
  assert.equal(phaseAt(r, peakAt + 8 * H), 'comedown');
  assert.equal(phaseAt(r, peakAt + 60 * H), 'gone');
  assert.equal(phaseAt(r, T0 - H), 'none');
});

test('presentAtLeastH keeps a fast-clearing drug present and out of the gone phase', () => {
  const d = { ...drug, central: { halfLifeH: 1, VdLperKg: 1 } };
  const profile = { weightKg: 70 };
  const at = T0 + 30 * H;
  const plain = simulate([dose(100)], [d], profile, { now: T0, horizonH: 48 }).x;
  const held = simulate([dose(100)], [{ ...d, presentAtLeastH: 48 }], profile, { now: T0, horizonH: 60 }).x;
  assert.equal(isPresent(plain, at), false);
  assert.equal(isPresent(held, at), true);
  assert.equal(phaseAt(held, at), 'comedown');
  assert.equal(isPresent(held, T0 + 49 * H), false);
  assert.ok(simulate([dose(100)], [{ ...d, presentAtLeastH: 48 }], profile, { now: at }).x);
});

test('doses older than ten half-lives are dropped', () => {
  const r = simulate([dose(100, -100)], [drug], { weightKg: 70 }, { now: T0 });
  assert.equal(r.x, undefined);
});

test('products expand into ingredients', () => {
  const products = [{ id: 'prod', ingredients: [{ drug: 'a', mgPerUnit: 10 }, { drug: 'b', mgPerUnit: 2 }] }];
  const out = expandDoses(
    [{ itemId: 'prod', route: 'oral', takenAt: new Date(T0).toISOString(), amount: { min: 2, max: 3 } }],
    products,
  );
  assert.deepEqual(out.map((d) => [d.drugId, d.mgMin, d.mgMax]), [['a', 20, 30], ['b', 4, 6]]);
});

test('a route without parameters fails loudly', () => {
  assert.throws(() => run(drug, [{ ...dose(1), route: 'nasal' }]), /route nasal/);
});
