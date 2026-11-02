const H = 3600e3;
const LN2 = Math.LN2;
// shortcut: zero-order is Michaelis-Menten with a small Km to stay stable at dt=1min, near-zero tail is approximate.
const ZERO_KM = 10;
const PRESENT_RATIO = 0.05;
const PEAK_RATIO = 0.8;

export function expandDoses(doses, products) {
  return doses.flatMap((d) => {
    const product = products.find((p) => p.id === d.itemId);
    const parts = product
      ? product.ingredients.map((i) => ({ drugId: i.drug, mult: i.mgPerUnit }))
      : [{ drugId: d.itemId, mult: 1 }];
    return parts.map(({ drugId, mult }) => ({
      drugId,
      route: d.route,
      takenAt: new Date(d.takenAt).getTime(),
      mgMin: d.amount.min * mult,
      mgMax: d.amount.max * mult,
    }));
  });
}

// Later covariate rules multiply; a rule without a matching profile value is ignored.
function covariateMults(drug, profile) {
  const m = { cl: 1, frac: 1 };
  for (const c of drug.covariates ?? []) {
    if (profile[c.on] !== c.when) continue;
    m.cl *= c.mult.cl ?? 1;
    m.frac *= c.mult.frac ?? 1;
  }
  return m;
}

export function resolveParams(drug, profile, scale = 1) {
  const wt = profile.weightKg ?? 70;
  const cov = covariateMults(drug, profile);
  const c = drug.central;
  // scale>1 means a faster/wider person, giving the low edge of the band.
  const metabolites = (drug.metabolites ?? []).map((m) => ({
    id: m.id,
    active: !!m.active,
    frac: m.frac * cov.frac,
    k: LN2 / m.halfLifeH,
    V: m.VdLperKg * wt * scale,
  }));
  return {
    V: c.VdLperKg * wt * scale,
    // CL ~ wt^0.75 and V ~ wt, so k ~ wt^-0.25.
    k: drug.elimination === 'linear' ? (LN2 / c.halfLifeH) * (wt / 70) ** -0.25 * cov.cl * scale : 0,
    vmax: (c.vmaxMgPerH ?? 0) * (wt / 70) ** 0.75 * cov.cl * scale,
    km: drug.elimination === 'zero' ? ZERO_KM : c.kmMgL,
    metabolites,
    ke0: drug.effect?.ke0,
    target: drug.effect?.target,
  };
}

function deriv(y, p, routes, mod) {
  const dy = new Array(y.length).fill(0);
  const A = routes.length;
  routes.forEach((r, i) => {
    const rate = r.ka * y[i];
    dy[i] = -rate;
    dy[A] += rate;
  });
  const C = y[A] / p.V;
  const elim = p.k > 0 ? p.k * mod.cl * y[A] : (p.vmax * mod.cl * C) / (p.km + C);
  dy[A] -= elim;
  p.metabolites.forEach((m, j) => {
    const idx = A + 1 + j;
    dy[idx] = elim * m.frac * mod.frac - m.k * y[idx];
  });
  if (p.ke0) {
    const t = p.metabolites.findIndex((m) => m.id === p.target);
    const Ct = t >= 0 ? y[A + 1 + t] / p.metabolites[t].V : C;
    dy[y.length - 1] = p.ke0 * (Ct - y[y.length - 1]);
  }
  return dy;
}

function rk4(y, h, p, routes, mod) {
  const add = (a, b, s) => a.map((v, i) => v + b[i] * s);
  const k1 = deriv(y, p, routes, mod);
  const k2 = deriv(add(y, k1, h / 2), p, routes, mod);
  const k3 = deriv(add(y, k2, h / 2), p, routes, mod);
  const k4 = deriv(add(y, k3, h), p, routes, mod);
  return y.map((v, i) => Math.max(0, v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])));
}

const NO_MOD = () => ({ cl: 1, frac: 1 });

export function simulateDrug(drug, doses, profile, { from, to, stepMin = 1, sampleMin = 5, scale = 1, pick = 'mid', mod = NO_MOD }) {
  const p = resolveParams(drug, profile, scale);
  const routeIds = [...new Set(doses.map((d) => d.route))];
  const routes = routeIds.map((id) => {
    const r = drug.routes[id];
    if (!r) throw new Error(`${drug.id}: route ${id} has no parameters`);
    return { ...r, ka: r.ka ?? 0 };
  });
  const A = routes.length;
  const events = doses
    .flatMap((d) => {
      const i = routeIds.indexOf(d.route);
      const r = routes[i];
      const mg = pick === 'min' ? d.mgMin : pick === 'max' ? d.mgMax : (d.mgMin + d.mgMax) / 2;
      return [{ at: d.takenAt + (r.tlagH ?? 0) * H, idx: r.ka ? i : A, amount: mg * (r.F ?? 1) }];
    })
    .sort((a, b) => a.at - b.at);

  const size = A + 1 + p.metabolites.length + 1;
  let y = new Array(size).fill(0);
  const steps = Math.ceil((to - from) / (stepMin * 60e3));
  const every = Math.max(1, Math.round(sampleMin / stepMin));
  const t = [], c = [], ce = [];
  const mets = p.metabolites.map(() => []);
  const hH = stepMin / 60;
  let next = 0;
  for (let s = 0; s <= steps; s++) {
    const now = from + s * stepMin * 60e3;
    while (next < events.length && events[next].at <= now) y[events[next].idx] += events[next++].amount;
    if (s % every === 0) {
      t.push(now);
      c.push(y[A] / p.V);
      p.metabolites.forEach((m, j) => mets[j].push(y[A + 1 + j] / m.V));
      const ti = p.metabolites.findIndex((m) => m.id === p.target);
      ce.push(p.ke0 ? y[size - 1] : ti >= 0 ? y[A + 1 + ti] / p.metabolites[ti].V : y[A] / p.V);
    }
    y = rk4(y, hH, p, routes, mod(now));
  }
  return { t, c, ce, metabolites: Object.fromEntries(p.metabolites.map((m, j) => [m.id, mets[j]])) };
}

export function valueAt(t, values, at) {
  if (!t.length || at <= t[0]) return at === t[0] ? values[0] : 0;
  if (at >= t[t.length - 1]) return values[values.length - 1];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m] <= at) lo = m; else hi = m;
  }
  return values[lo] + ((values[hi] - values[lo]) * (at - t[lo])) / (t[hi] - t[lo]);
}

function slowestHalfLifeH(drug) {
  return Math.max(drug.central.halfLifeH ?? 24, ...(drug.metabolites ?? []).map((m) => m.halfLifeH));
}

function runBands(drug, doses, profile, range) {
  const cv = drug.cv ?? 0;
  const mid = simulateDrug(drug, doses, profile, range);
  const low = simulateDrug(drug, doses, profile, { ...range, pick: 'min', scale: 1 + cv });
  const high = simulateDrug(drug, doses, profile, { ...range, pick: 'max', scale: 1 / (1 + cv) });
  const peak = Math.max(...mid.ce, 0);
  const peakAt = mid.t[mid.ce.indexOf(peak)];
  return { ...mid, low: low.ce, high: high.ce, peak, doseTimes: doses.map((d) => d.takenAt), toPeakMs: peakAt - mid.t[0] };
}

// Taken but still absorbing: the level looks low, yet the substance is on its way in.
function absorbing(result, at) {
  return result.doseTimes.some((t) => at >= t && at - t <= result.toPeakMs);
}

export function simulate(doses, drugs, profile, { now, horizonH = 24, pkMods = null }) {
  const out = {};
  const to = now + horizonH * H;
  for (const drug of drugs) {
    const cutoff = now - 10 * slowestHalfLifeH(drug) * H;
    const own = doses.filter((d) => d.drugId === drug.id && d.takenAt >= cutoff);
    if (!own.length) continue;
    const from = Math.min(...own.map((d) => d.takenAt));
    out[drug.id] = runBands(drug, own, profile, { from, to, ...(pkMods && { mod: pkMods(drug) }) });
  }
  return out;
}

// Relative to the drug's own simulated peak, so a small dose still counts as present (errs towards warning).
export function isPresent(result, at) {
  if (!result || result.peak <= 0 || at < result.t[0]) return false;
  return absorbing(result, at) || valueAt(result.t, result.ce, at) >= result.peak * PRESENT_RATIO;
}

export function phaseAt(result, at) {
  if (!result || result.peak <= 0 || at < result.t[0]) return 'none';
  const v = valueAt(result.t, result.ce, at);
  const rising = valueAt(result.t, result.ce, at + 300e3) > v;
  if (v >= result.peak * PEAK_RATIO) return 'peak';
  if (rising || absorbing(result, at)) return 'onset';
  return v >= result.peak * PRESENT_RATIO ? 'comedown' : 'gone';
}
