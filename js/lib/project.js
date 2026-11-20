// Project / campaign settings: extra Commons categories and an edit-summary hashtag.
import { sanitizeTitlePart } from './filename.js';
import { unique } from './util.js';

/**
 * Turns what a person typed into clean category names. Entries are separated by new lines or
 * semicolons (commas can occur inside category names). "Category:", "[[...]]" and a "|sortkey"
 * are removed, and characters MediaWiki forbids in titles become "-".
 */
export function parseCategories(input) {
  const names = String(input ?? '')
    .split(/[\n;]+/)
    .map((entry) => entry.trim().replace(/^\[\[\s*/, '').replace(/\s*\]\]$/, '').split('|')[0])
    .map((entry) => entry.replace(/^:?\s*category\s*:\s*/i, ''))
    .map(sanitizeTitlePart)
    .filter(Boolean)
    .map((name) => name.charAt(0).toUpperCase() + name.slice(1));
  return unique(names);
}

/** "#WLE2026", "wle2026" or " # my tag " → "#WLE2026" style hashtag, or '' if nothing usable. */
export function normalizeHashtag(input) {
  const word = String(input ?? '').trim().replace(/^#+\s*/, '').replace(/\s+/g, '');
  return /^[\p{L}\p{N}_-]+$/u.test(word) ? `#${word}` : '';
}
