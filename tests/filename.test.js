import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilename, sanitizeTitlePart, utf8Length } from '../js/lib/filename.js';

const rec = (overrides = {}) => ({ obsId: 123456789, photoId: 987654321, ext: 'jpg', taxonName: 'Saxicola maurus', ...overrides });

test('builds "<Taxon> (iNaturalist <obs>-<photo>).<ext>"', () => {
  assert.equal(buildFilename(rec()), 'Saxicola maurus (iNaturalist 123456789-987654321).jpg');
  assert.equal(buildFilename(rec({ ext: 'png' })), 'Saxicola maurus (iNaturalist 123456789-987654321).png');
});

test('replaces characters MediaWiki forbids in file names', () => {
  assert.equal(sanitizeTitlePart('A#B'), 'A-B');
  assert.equal(sanitizeTitlePart('A<B>C'), 'A-B-C');
  assert.equal(sanitizeTitlePart('A[B]C'), 'A-B-C');
  assert.equal(sanitizeTitlePart('A|B{C}D'), 'A-B-C-D');
  assert.equal(sanitizeTitlePart('A:B/C\\D'), 'A-B-C-D');
  assert.equal(sanitizeTitlePart('Foo%20bar'), 'Foo-20bar');
  assert.equal(sanitizeTitlePart('a~~~~b'), 'a-b');
});

test('collapses whitespace and underscores, trims edges and strips control characters', () => {
  assert.equal(sanitizeTitlePart('  Foo__bar\tbaz\n '), 'Foo bar baz');
  assert.equal(sanitizeTitlePart('Foo\u0000bar\u200bbaz'), 'Foo bar baz');
  assert.equal(sanitizeTitlePart('...Foo bar.'), 'Foo bar');
});

test('keeps legitimate taxon characters such as the hybrid sign', () => {
  assert.equal(sanitizeTitlePart('Mentha × piperita'), 'Mentha × piperita');
  assert.equal(sanitizeTitlePart('Ficus benghalensis var. krishnae'), 'Ficus benghalensis var. krishnae');
});

test('capitalises the first letter and names unidentified organisms', () => {
  assert.equal(buildFilename(rec({ taxonName: 'x-ray tetra' })), 'X-ray tetra (iNaturalist 123456789-987654321).jpg');
  assert.equal(buildFilename(rec({ taxonName: null })), 'Unidentified organism (iNaturalist 123456789-987654321).jpg');
  assert.equal(buildFilename(rec({ taxonName: '###' })), 'Unidentified organism (iNaturalist 123456789-987654321).jpg');
});

test('truncates long names to 240 UTF-8 bytes and keeps the identifying suffix', () => {
  const long = 'Ä'.repeat(300);
  const name = buildFilename(rec({ taxonName: long }));
  assert.ok(utf8Length(name) <= 240, `got ${utf8Length(name)} bytes`);
  assert.ok(name.endsWith(' (iNaturalist 123456789-987654321).jpg'));
});
