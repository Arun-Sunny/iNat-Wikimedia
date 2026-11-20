// Decides which photos can go to Commons, and with what location data.
import { mapLicense } from './license.js';

export const QUALITY_RANK = { casual: 0, needs_id: 1, research: 2 };

export const SKIP_LABELS = {
  hidden: 'Hidden on iNaturalist',
  'not-owner': 'Observed by someone else',
  'no-license': 'No license (all rights reserved)',
  license: 'License not allowed on Commons',
  quality: 'Below the minimum quality grade',
  'no-taxon': 'No species identified',
};

const skip = (reason, detail = null) => ({ eligible: false, reason, detail });

/**
 * Marks one photo record eligible or skipped, with a reason code from SKIP_LABELS.
 * Order matters: the first rule that fails is the reason shown.
 */
export function planRecord(rec, { userLogin = null, minQuality = 'research', requireTaxon = true } = {}) {
  if (rec.hidden) return skip('hidden');
  if (userLogin && rec.observer && rec.observer.toLowerCase() !== userLogin.toLowerCase()) {
    return skip('not-owner', rec.observer);
  }
  if (!rec.licenseCode) return skip('no-license');
  if (!mapLicense(rec.licenseCode)) return skip('license', rec.licenseCode);
  const have = QUALITY_RANK[rec.qualityGrade] ?? -1;
  const need = QUALITY_RANK[minQuality] ?? QUALITY_RANK.research;
  if (have < need) return skip('quality', rec.qualityGrade);
  if (requireTaxon && !rec.taxonName) return skip('no-taxon');
  return { eligible: true, reason: null, detail: null };
}

const HIDDEN_GEOPRIVACY = new Set(['obscured', 'private']);

/**
 * Coordinates are published only when iNaturalist shows them precisely. Obscured or private
 * observations (set by the observer or forced by a threatened taxon) are still uploaded,
 * but without coordinates or place name.
 */
export function locationAllowed(rec) {
  if (rec.lat == null || rec.lng == null) return false;
  if (rec.obscured) return false;
  if (HIDDEN_GEOPRIVACY.has(rec.geoprivacy) || HIDDEN_GEOPRIVACY.has(rec.taxonGeoprivacy)) return false;
  return true;
}

/** Higher is better: most faves, best quality grade, first photo of its observation, most pixels, newest. */
function score(r) {
  return [
    r.faves ?? 0,
    QUALITY_RANK[r.qualityGrade] ?? -1,
    -(r.position ?? 0),
    (r.width ?? 0) * (r.height ?? 0),
    r.obsId ?? 0,
  ];
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Picks one photo per taxon from the records `isEligible` accepts. */
export function pickOnePerSpecies(records, isEligible = () => true) {
  const best = new Map();
  for (const r of records) {
    if (r.taxonId == null || !isEligible(r)) continue;
    const current = best.get(r.taxonId);
    if (!current || compareScores(score(r), score(current)) > 0) best.set(r.taxonId, r);
  }
  return [...best.values()];
}
