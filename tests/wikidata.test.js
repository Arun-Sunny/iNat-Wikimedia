import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupTaxonQids, buildTaxonQuery } from '../js/lib/wikidata.js';
import { fakeFetch, jsonResponse } from './helpers.js';

const binding = (id, qid) => ({ id: { value: id }, item: { value: `http://www.wikidata.org/entity/${qid}` } });

test('builds a VALUES query over P3151 and strips anything that is not a digit', () => {
  assert.equal(
    buildTaxonQuery(['201193', '12"} ?x']),
    'SELECT ?id ?item WHERE { VALUES ?id { "201193" "12" } ?item wdt:P3151 ?id . }',
  );
});

test('maps iNaturalist taxon IDs to items, with null for unknown taxa', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ results: { bindings: [binding('201193', 'Q1589281')] } }));
  const out = await lookupTaxonQids([201193, 999, 201193, null], { fetchFn, sparqlUrl: 'https://wdqs.test/sparql' });
  assert.equal(out.get('201193'), 'Q1589281');
  assert.equal(out.get('999'), null);
  assert.equal(out.size, 2);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url.origin + url.pathname, 'https://wdqs.test/sparql');
  assert.match(url.searchParams.get('query'), /VALUES \?id \{ "201193" "999" \}/);
  assert.equal(init.headers.Accept, 'application/sparql-results+json');
});

test('prefers the lowest Q-number when two items share an iNaturalist ID', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ results: { bindings: [binding('5', 'Q900'), binding('5', 'Q12'), binding('5', 'Q300')] } }));
  const out = await lookupTaxonQids([5], { fetchFn });
  assert.equal(out.get('5'), 'Q12');
});

test('queries in batches', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ results: { bindings: [] } }));
  await lookupTaxonQids(Array.from({ length: 450 }, (_, i) => i + 1), { fetchFn, batchSize: 200 });
  assert.equal(fetchFn.calls.length, 3);
});

test('fails clearly when the query service is down', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({}, 503));
  await assert.rejects(lookupTaxonQids([1], { fetchFn }), /HTTP 503/);
});
