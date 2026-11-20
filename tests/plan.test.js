import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRecord, locationAllowed, pickOnePerSpecies } from '../js/lib/plan.js';

const base = {
  key: '1-1', obsId: 1, photoId: 1, position: 0, licenseCode: 'cc-by', hidden: false,
  taxonId: 10, taxonName: 'Saxicola maurus', qualityGrade: 'research', observer: 'example_naturalist',
  lat: 10, lng: 76, obscured: false, geoprivacy: null, taxonGeoprivacy: null, faves: 0, width: 100, height: 100,
};
const opts = { userLogin: 'example_naturalist' };

test('a CC BY research-grade photo by the user is eligible', () => {
  assert.deepEqual(planRecord(base, opts), { eligible: true, reason: null, detail: null });
});

test('skips licenses Commons cannot take', () => {
  assert.deepEqual(planRecord({ ...base, licenseCode: 'cc-by-nc' }, opts), { eligible: false, reason: 'license', detail: 'cc-by-nc' });
  assert.equal(planRecord({ ...base, licenseCode: 'cc-by-nd' }, opts).reason, 'license');
  assert.equal(planRecord({ ...base, licenseCode: null }, opts).reason, 'no-license');
});

test('applies the minimum quality grade', () => {
  assert.deepEqual(planRecord({ ...base, qualityGrade: 'needs_id' }, opts), { eligible: false, reason: 'quality', detail: 'needs_id' });
  assert.equal(planRecord({ ...base, qualityGrade: 'needs_id' }, { ...opts, minQuality: 'needs_id' }).eligible, true);
  assert.equal(planRecord({ ...base, qualityGrade: 'casual' }, { ...opts, minQuality: 'needs_id' }).reason, 'quality');
  assert.equal(planRecord({ ...base, qualityGrade: 'casual' }, { ...opts, minQuality: 'casual' }).eligible, true);
});

test('requires a taxon unless told otherwise', () => {
  assert.equal(planRecord({ ...base, taxonName: null }, opts).reason, 'no-taxon');
  assert.equal(planRecord({ ...base, taxonName: null }, { ...opts, requireTaxon: false }).eligible, true);
});

test("never plans someone else's photo or a hidden one", () => {
  assert.equal(planRecord({ ...base, observer: 'someoneelse' }, opts).reason, 'not-owner');
  assert.equal(planRecord({ ...base, observer: 'Example_Naturalist' }, opts).eligible, true);
  assert.equal(planRecord({ ...base, hidden: true }, opts).reason, 'hidden');
});

test('coordinates are only published when iNaturalist shows them openly', () => {
  assert.equal(locationAllowed(base), true);
  assert.equal(locationAllowed({ ...base, obscured: true }), false);
  assert.equal(locationAllowed({ ...base, geoprivacy: 'obscured' }), false);
  assert.equal(locationAllowed({ ...base, geoprivacy: 'private' }), false);
  assert.equal(locationAllowed({ ...base, taxonGeoprivacy: 'obscured' }), false);
  assert.equal(locationAllowed({ ...base, lat: null }), false);
  assert.equal(locationAllowed({ ...base, geoprivacy: 'open' }), true);
});

test('picks one photo per species: most faves, then quality, then first photo', () => {
  const records = [
    { ...base, key: 'a', taxonId: 1, faves: 0 },
    { ...base, key: 'b', taxonId: 1, faves: 3 },
    { ...base, key: 'c', taxonId: 2, qualityGrade: 'needs_id' },
    { ...base, key: 'd', taxonId: 2, qualityGrade: 'research' },
    { ...base, key: 'e', taxonId: 3, position: 1 },
    { ...base, key: 'f', taxonId: 3, position: 0 },
    { ...base, key: 'g', taxonId: 4, licenseCode: 'cc-by-nc' },
    { ...base, key: 'h', taxonId: null },
  ];
  const picked = pickOnePerSpecies(records, (r) => planRecord(r, { ...opts, minQuality: 'needs_id' }).eligible);
  assert.deepEqual(picked.map((r) => r.key).sort(), ['b', 'd', 'f']);
});
