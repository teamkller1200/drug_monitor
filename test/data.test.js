import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}.json`, import.meta.url)));
const files = ['drugs', 'products', 'interactions', 'limits'];
const drugs = load('drugs');
const SEVERITIES = ['caution', 'danger', 'fatal'];

test('every entry has a status, and verified entries a real source', () => {
  for (const f of files) {
    for (const e of load(f)) {
      assert.ok(['draft', 'verified'].includes(e.status), `${f}: ${JSON.stringify(e)}`);
      assert.ok(e.source, `${f}: missing source`);
      if (e.status === 'verified') assert.notEqual(e.source, '未確認', `${f}: unverified source`);
    }
  }
});

test('drugs carry the parameters their model needs', () => {
  for (const d of drugs) {
    assert.ok(['linear', 'zero', 'mm'].includes(d.elimination), d.id);
    assert.ok(Object.keys(d.routes).length, d.id);
    assert.ok(d.central.VdLperKg > 0, d.id);
    if (d.elimination === 'linear') assert.ok(d.central.halfLifeH > 0, d.id);
    else assert.ok(d.central.vmaxMgPerH > 0, d.id);
    if (d.elimination === 'mm') assert.ok(d.central.kmMgL > 0, d.id);
    if (d.effect?.target) assert.ok(d.metabolites.some((m) => m.id === d.effect.target), d.id);
  }
});

test('products reference known drugs and rules use a known severity', () => {
  const ids = drugs.map((d) => d.id);
  for (const p of load('products')) for (const i of p.ingredients) assert.ok(ids.includes(i.drug), p.id);
  for (const r of load('interactions')) assert.ok(SEVERITIES.includes(r.severity));
  for (const l of load('limits')) assert.ok(SEVERITIES.includes(l.severity) && l.maxMg > 0 && ids.includes(l.drug));
});
