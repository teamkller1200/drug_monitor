import { isPresent } from './pk.js';

const H = 3600e3;
const ORDER = { fatal: 0, danger: 1, caution: 2 };
const NEAR_LIMIT = 0.8;

function matches(ref, drug) {
  const [kind, name] = ref.split(':');
  return kind === 'drug' ? drug.id === name : (drug.classes ?? []).includes(name);
}

function ruleFits(rule, a, b) {
  return (matches(rule.a, a) && matches(rule.b, b)) || (matches(rule.a, b) && matches(rule.b, a));
}

// shortcut: an inhibitor applies fully while present, no graded inhibition; upgrade when a drug's data needs it.
export function pkMods(rules, baseResults, drugs) {
  return (target) => {
    const active = rules
      .filter((r) => r.kind === 'pk')
      .flatMap((r) =>
        drugs
          // Directional, unlike PD rules: a is the inhibitor, b the affected drug.
          .filter((d) => d.id !== target.id && baseResults[d.id] && matches(r.a, d) && matches(r.b, target))
          .map((d) => ({ inhibitor: d.id, effect: r.effect ?? {} })),
      );
    return (t) => {
      const m = { cl: 1, frac: 1 };
      for (const { inhibitor, effect } of active) {
        if (!isPresent(baseResults[inhibitor], t)) continue;
        m.cl *= effect.clMult ?? 1;
        m.frac *= effect.fracMult ?? 1;
      }
      return m;
    };
  };
}

function cumulativeAlerts(doses, limits, now) {
  return limits.flatMap((l) => {
    const total = doses
      .filter((d) => d.drugId === l.drug && d.takenAt <= now && d.takenAt > now - l.windowH * H)
      .reduce((sum, d) => sum + d.mgMax, 0);
    const ratio = total / l.maxMg;
    if (ratio < NEAR_LIMIT) return [];
    return [{
      kind: 'limit',
      severity: ratio >= 1 ? l.severity : 'caution',
      items: [l.drug],
      mechanism: ratio >= 1 ? `${l.windowH}時間の累積量が上限を超えています` : `${l.windowH}時間の累積量が上限に近づいています`,
      source: l.source,
    }];
  });
}

export function evaluate({ doses, results, drugs, rules, limits, now }) {
  const present = drugs.filter((d) => isPresent(results[d.id], now));
  const alerts = [];
  const unknown = [];
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const hits = rules.filter((r) => ruleFits(r, present[i], present[j]));
      if (!hits.length) unknown.push([present[i].id, present[j].id]);
      for (const r of hits) {
        alerts.push({
          kind: r.kind,
          severity: r.severity,
          items: [present[i].id, present[j].id],
          mechanism: r.mechanism,
          source: r.source,
        });
      }
    }
  }
  alerts.push(...cumulativeAlerts(doses, limits, now));
  alerts.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return { alerts, unknown };
}
