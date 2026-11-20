import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLicense, selfParam } from '../js/lib/license.js';

test('maps the three Commons-compatible iNaturalist licenses', () => {
  assert.deepEqual(mapLicense('cc0'), { code: 'cc0', template: 'Cc-zero', qid: 'Q6938433', label: 'CC0 1.0' });
  assert.deepEqual(mapLicense('cc-by'), { code: 'cc-by', template: 'Cc-by-4.0', qid: 'Q20007257', label: 'CC BY 4.0' });
  assert.deepEqual(mapLicense('cc-by-sa'), { code: 'cc-by-sa', template: 'Cc-by-sa-4.0', qid: 'Q18199165', label: 'CC BY-SA 4.0' });
});

test('accepts codes in any case and with stray spaces', () => {
  assert.equal(mapLicense('CC-BY')?.template, 'Cc-by-4.0');
  assert.equal(mapLicense(' cc-by-sa ')?.template, 'Cc-by-sa-4.0');
});

test('rejects NC, ND, missing and unknown licenses', () => {
  for (const code of ['cc-by-nc', 'cc-by-nd', 'cc-by-nc-sa', 'cc-by-nc-nd', null, undefined, '', 'all rights reserved', 'gpl']) {
    assert.equal(mapLicense(code), null, `expected ${code} to be rejected`);
  }
});

test('selfParam gives the lowercase template name {{self}} expects', () => {
  assert.equal(selfParam(mapLicense('cc-by')), 'cc-by-4.0');
  assert.equal(selfParam(mapLicense('cc0')), 'cc-zero');
});
