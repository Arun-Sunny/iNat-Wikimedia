// File description page wikitext for an upload. Two modes:
//
// Own work (ctx.ownWork true, the default): the uploader is the photographer, so the file is
// marked {{own}} under {{self}}, with the iNaturalist observation linked as where it was first
// published. {{iNaturalistreview}} (optional) asks Commons' review bot to confirm the license on
// iNaturalist, which settles any doubt that the two accounts belong to the same person.
//
// Transfer (ctx.ownWork false): someone else uploads the photographer's openly licensed photo.
// The source is the iNaturalist observation, the author is the iNaturalist photographer, the
// license template carries their attribution, and {{iNaturalistreview}} is always added because
// Commons requires a license review for files copied from iNaturalist.
import { mapLicense, selfParam } from './license.js';
import { locationAllowed } from './plan.js';
import { formatCoord, isIsoDate } from './util.js';

const ITALIC_RANKS = new Set([
  'genus', 'genushybrid', 'subgenus', 'section', 'subsection', 'complex',
  'species', 'hybrid', 'subspecies', 'variety', 'form', 'infrahybrid',
]);

/** Neutralises characters that would start templates, links, tables or signatures. */
export function escapeWikitext(value) {
  return String(value ?? '')
    .replace(/[|{}[\]<>~=]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/'{2,}/g, (m) => '&#39;'.repeat(m.length))
    .replace(/__/g, '_&#95;');
}

export function taxonWikitext(rec) {
  if (!rec.taxonName) return 'Unidentified organism';
  const name = escapeWikitext(rec.taxonName);
  return ITALIC_RANKS.has(rec.taxonRank) ? `''${name}''` : name;
}

/** Plain-text caption, also used as the structured-data label. */
export function captionText(rec) {
  const name = rec.taxonName || 'Unidentified organism';
  return rec.commonName ? `${name} (${rec.commonName})` : name;
}

export function authorWikitext({ authorName, authorUrl, commonsUser }) {
  const link = `[${authorUrl} ${escapeWikitext(authorName)}]`;
  return commonsUser ? `${link} ([[User:${commonsUser}|${commonsUser}]])` : link;
}

/**
 * @param rec photo record from inat.toPhotoRecords
 * @param ctx { authorName, authorUrl, commonsUser, categories: string[], includeLicenseReview, ownWork }
 */
export function renderWikitext(rec, ctx) {
  const license = mapLicense(rec.licenseCode);
  if (!license) throw new Error(`License "${rec.licenseCode}" can't be uploaded to Commons`);

  const ownWork = ctx.ownWork !== false;
  const obsUrl = `https://www.inaturalist.org/observations/${rec.obsId}`;
  const photoUrl = `https://www.inaturalist.org/photos/${rec.photoId}`;
  const showLocation = locationAllowed(rec);
  const author = ownWork ? authorWikitext(ctx) : authorWikitext({ ...ctx, commonsUser: null });
  const source = ownWork
    ? `{{own}}<br />First published on iNaturalist: [${obsUrl} observation ${rec.obsId}], [${photoUrl} photo ${rec.photoId}]`
    : `[${obsUrl} iNaturalist observation ${rec.obsId}], [${photoUrl} photo ${rec.photoId}]`;
  const licenseLine = ownWork
    ? `{{self|${selfParam(license)}|author=${author}}}`
    : license.code === 'cc0' ? `{{${license.template}}}` : `{{${license.template}|1=${author}}}`;
  const licenseReview = !ownWork || ctx.includeLicenseReview !== false;

  let description = taxonWikitext(rec);
  if (rec.commonName) description += ` (${escapeWikitext(rec.commonName)})`;
  if (showLocation && rec.placeGuess) description += `, observed in ${escapeWikitext(rec.placeGuess)}`;
  description += `. [${obsUrl} iNaturalist observation ${rec.obsId}].`;

  const lines = [
    '=={{int:filedesc}}==',
    '{{Information',
    ` |description={{en|1=${description}}}`,
    ` |date=${isIsoDate(rec.observedOn) ? `{{Taken on|${rec.observedOn}}}` : ''}`,
    ` |source=${source}`,
    ` |author=${author}`,
    ' |permission=',
    ' |other versions=',
    '}}',
  ];
  if (showLocation) {
    const prec = rec.accuracy ? `|prec=${Math.max(1, Math.round(rec.accuracy))}` : '';
    lines.push(`{{Location|${formatCoord(rec.lat)}|${formatCoord(rec.lng)}${prec}}}`);
  }
  lines.push(`{{iNaturalist|${rec.obsId}}}`);
  lines.push('', '=={{int:license-header}}==', licenseLine);
  if (licenseReview) lines.push('{{iNaturalistreview}}');
  lines.push('');
  for (const category of ctx.categories ?? []) lines.push(`[[Category:${category}]]`);
  return `${lines.join('\n')}\n`;
}
