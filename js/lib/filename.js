// Commons file names: "<Taxon name> (iNaturalist <obs_id>-<photo_id>).<ext>"
//
// MediaWiki title rules: no # < > [ ] | { }, no control characters, no "%" followed by two hex
// digits, no "~~~", and Commons additionally forbids : / \ in file names. Underscores and runs of
// whitespace become single spaces, the first letter is capitalised, and the whole name must fit
// in 240 bytes of UTF-8.

const ILLEGAL = /[#<>[\]|{}:/\\]/g;
const MAX_BYTES = 240;
const encoder = new TextEncoder();

export function utf8Length(s) {
  return encoder.encode(s).length;
}

export function sanitizeTitlePart(value) {
  let t = String(value ?? '').normalize('NFC');
  t = t.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ');
  t = t.replace(ILLEGAL, '-');
  t = t.replace(/%/g, '-');
  t = t.replace(/~{3,}/g, '-');
  t = t.replace(/[\s_]+/g, ' ');
  t = t.replace(/^[\s.\-]+|[\s.\-]+$/g, '');
  return t;
}

export function buildFilename(rec) {
  const ext = (rec.ext || 'jpg').toLowerCase();
  const suffix = ` (iNaturalist ${rec.obsId}-${rec.photoId}).${ext}`;
  let base = sanitizeTitlePart(rec.taxonName) || 'Unidentified organism';
  while (base.length > 1 && utf8Length(base + suffix) > MAX_BYTES) {
    base = [...base].slice(0, -1).join('').trimEnd();
  }
  const name = base + suffix;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
