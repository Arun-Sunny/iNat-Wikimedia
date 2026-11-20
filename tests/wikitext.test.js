// Golden-file tests for the description page. Regenerate with:  UPDATE_GOLDEN=1 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderWikitext, escapeWikitext } from '../js/lib/wikitext.js';
import { toPhotoRecords } from '../js/lib/inat.js';
import { sampleObservation } from './helpers.js';

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), 'golden');

function golden(name, actual) {
  const file = join(goldenDir, `${name}.wikitext`);
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `golden ${name} differs`);
}

const author = { authorName: 'Alex Example', authorUrl: 'https://www.inaturalist.org/people/example_naturalist' };

test('species with public location, logged-in uploader and extra category', () => {
  const [rec] = toPhotoRecords(sampleObservation());
  golden('species-public-location', renderWikitext(rec, {
    ...author,
    commonsUser: 'Alex Example',
    categories: ['Saxicola maurus', 'Photographs by Alex Example'],
    includeLicenseReview: true,
  }));
});

test('obscured observation leaves out coordinates and place; fallback category; CC BY-SA', () => {
  const obs = sampleObservation({ obscured: true, geoprivacy: 'obscured' });
  obs.photos[0].license_code = 'cc-by-sa';
  const [rec] = toPhotoRecords(obs);
  golden('obscured-fallback', renderWikitext(rec, {
    ...author,
    commonsUser: null,
    categories: ['Media needing categories'],
    includeLicenseReview: true,
  }));
});

test('genus-level taxon, no date, no common name, CC0, no license review', () => {
  const obs = sampleObservation({
    observed_on: null,
    location: null,
    taxon: { id: 12704, name: 'Saxicola', rank: 'genus', preferred_common_name: null },
  });
  obs.photos[0].license_code = 'cc0';
  const [rec] = toPhotoRecords(obs);
  golden('genus-cc0', renderWikitext(rec, {
    ...author,
    commonsUser: 'Alex Example',
    categories: ['Saxicola'],
    includeLicenseReview: false,
  }));
});

test('transfer mode: copied from iNaturalist and credited to the photographer, always with license review', () => {
  const [rec] = toPhotoRecords(sampleObservation());
  golden('transfer-cc-by', renderWikitext(rec, {
    ...author,
    commonsUser: 'Someone Else',
    categories: ['Saxicola maurus'],
    includeLicenseReview: false, // ignored: transfers always need review
    ownWork: false,
  }));
});

test('transfer mode with CC0 has no attribution parameter', () => {
  const obs = sampleObservation();
  obs.photos[0].license_code = 'cc0';
  const [rec] = toPhotoRecords(obs);
  const text = renderWikitext(rec, { ...author, categories: [], ownWork: false });
  assert.match(text, /\n\{\{Cc-zero\}\}\n\{\{iNaturalistreview\}\}\n/);
  assert.ok(!text.includes('{{own}}'));
  assert.ok(!text.includes('{{self'));
});

test('family names are not italicised', () => {
  const [rec] = toPhotoRecords(sampleObservation({ taxon: { id: 7251, name: 'Muscicapidae', rank: 'family', preferred_common_name: 'Old World Flycatchers' } }));
  const text = renderWikitext(rec, { ...author, categories: [] });
  assert.match(text, /\|description=\{\{en\|1=Muscicapidae \(Old World Flycatchers\)/);
});

test('refuses to render a license Commons does not accept', () => {
  const obs = sampleObservation();
  obs.photos[0].license_code = 'cc-by-nc';
  const [rec] = toPhotoRecords(obs);
  assert.throws(() => renderWikitext(rec, { ...author, categories: [] }), /can't be uploaded/);
});

test('escapes text from iNaturalist so it cannot inject templates, links or signatures', () => {
  assert.equal(
    escapeWikitext("[[Evil]] {{x|y=1}} ~~~~ ''b'' __NOTOC__ <b>"),
    "&#91;&#91;Evil&#93;&#93; &#123;&#123;x&#124;y&#61;1&#125;&#125; &#126;&#126;&#126;&#126; &#39;&#39;b&#39;&#39; _&#95;NOTOC_&#95; &#60;b&#62;",
  );
  const [rec] = toPhotoRecords(sampleObservation({ place_guess: 'Near {{delete}} | [[x]]' }));
  const text = renderWikitext(rec, { ...author, categories: [] });
  assert.ok(!text.includes('{{delete}}'));
  assert.ok(!text.includes('[[x]]'));
});
