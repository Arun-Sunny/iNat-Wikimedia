import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCategories, normalizeHashtag } from '../js/lib/project.js';

test('splits categories on new lines and semicolons, not commas', () => {
  assert.deepEqual(parseCategories('Images from Example Contest 2026 in India; Birds of Kerala\nInsects, spiders and allies'), [
    'Images from Example Contest 2026 in India',
    'Birds of Kerala',
    'Insects, spiders and allies',
  ]);
});

test('accepts pasted wiki syntax and cleans it up', () => {
  assert.deepEqual(parseCategories('[[Category:Birds of Kerala]]'), ['Birds of Kerala']);
  assert.deepEqual(parseCategories('Category:Birds of Kerala|sortkey'), ['Birds of Kerala']);
  assert.deepEqual(parseCategories(':category: birds_of_kerala'), ['Birds of kerala']);
  assert.deepEqual(parseCategories('  Foo#Bar  '), ['Foo-Bar']);
});

test('drops empty entries and duplicates, and handles no input', () => {
  assert.deepEqual(parseCategories('A;; A ;\n\n B'), ['A', 'B']);
  assert.deepEqual(parseCategories(''), []);
  assert.deepEqual(parseCategories(null), []);
});

test('normalises hashtags', () => {
  assert.equal(normalizeHashtag('#WLE2026'), '#WLE2026');
  assert.equal(normalizeHashtag('wle2026'), '#wle2026');
  assert.equal(normalizeHashtag(' # my tag '), '#mytag');
  assert.equal(normalizeHashtag(''), '');
  assert.equal(normalizeHashtag('bad!tag'), '');
  assert.equal(normalizeHashtag(undefined), '');
});
