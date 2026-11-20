// Resolves iNaturalist taxon IDs to Wikidata items through P3151 (iNaturalist taxon ID).
import { chunk, unique } from './util.js';

export const SPARQL_URL = 'https://query.wikidata.org/sparql';

export function buildTaxonQuery(ids) {
  const values = ids.map((id) => `"${String(id).replace(/\D/g, '')}"`).join(' ');
  return `SELECT ?id ?item WHERE { VALUES ?id { ${values} } ?item wdt:P3151 ?id . }`;
}

/**
 * @returns Map(String(inatTaxonId) → "Q123" | null). When several items carry the same
 * iNaturalist ID, the lowest Q-number wins so results are stable.
 */
export async function lookupTaxonQids(ids, {
  fetchFn = (...args) => fetch(...args),
  sparqlUrl = SPARQL_URL,
  batchSize = 200,
} = {}) {
  const wanted = unique(ids.filter((id) => id != null).map(String));
  const out = new Map();
  for (const batch of chunk(wanted, batchSize)) {
    const url = `${sparqlUrl}?${new URLSearchParams({ query: buildTaxonQuery(batch), format: 'json' })}`;
    const res = await fetchFn(url, { headers: { Accept: 'application/sparql-results+json' } });
    if (!res.ok) throw new Error(`Wikidata query service returned HTTP ${res.status}`);
    const body = await res.json();
    for (const id of batch) out.set(id, null);
    for (const b of body.results?.bindings ?? []) {
      const id = b.id?.value;
      const qid = b.item?.value?.split('/').pop();
      if (!id || !/^Q\d+$/.test(qid ?? '')) continue;
      const current = out.get(id);
      if (!current || Number(qid.slice(1)) < Number(current.slice(1))) out.set(id, qid);
    }
  }
  return out;
}
