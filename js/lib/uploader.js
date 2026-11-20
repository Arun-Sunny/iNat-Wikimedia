// Uploading one photo: duplicate check, action=upload with explicit warning handling, then
// structured data. Kept free of DOM code so it can be tested with fakes.
import { CommonsError } from './commons.js';
import { sleep } from './util.js';

const AUTH_ERRORS = /^(assertuserfailed|assertnameduserfailed|notloggedin|mwoauth-|badaccess|permissiondenied|readonly)/;

/** Errors after which continuing with the next photo is pointless: login or permission problems. */
export function isAuthError(e) {
  return e instanceof CommonsError && AUTH_ERRORS.test(e.code);
}

export function isCaptchaError(e) {
  return e instanceof CommonsError && /captcha/i.test(e.code);
}

/**
 * Turns the API's "upload" object into one outcome. Warnings are never ignored: each one is
 * mapped to an explicit decision.
 */
export function interpretUpload(upload) {
  if (upload?.captcha) return { kind: 'captcha' };
  if (upload?.result === 'Success') return { kind: 'success', filename: upload.filename };
  if (upload?.result === 'Warning') {
    const w = upload.warnings ?? {};
    const first = (v) => (Array.isArray(v) ? v[0] : v);
    if (w.duplicate) return { kind: 'duplicate', title: `File:${first(w.duplicate)}` };
    if (w['duplicate-archive']) return { kind: 'deleted-duplicate', title: `File:${first(w['duplicate-archive'])}` };
    if (w['was-deleted']) return { kind: 'was-deleted', title: `File:${first(w['was-deleted'])}` };
    if (w.exists || w['exists-normalized'] || w['page-exists']) {
      return { kind: 'name-taken', title: `File:${first(w.exists || w['exists-normalized'] || w['page-exists'])}` };
    }
    if (w.badfilename) return { kind: 'bad-filename', suggestion: first(w.badfilename) };
    return { kind: 'warning', warnings: w };
  }
  return { kind: 'unexpected', result: upload?.result ?? 'none' };
}

/**
 * Runs `fn`, waiting and retrying when Commons is lagged (maxlag), rate-limits us, the CSRF
 * token went stale, or the network drops. Anything else is thrown to the caller.
 */
export async function withRetries(fn, {
  sleepFn = sleep, signal, onWait = () => {}, refreshToken = null, maxAttempts = 6,
} = {}) {
  let tokenRefreshed = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e?.name === 'AbortError' || attempt >= maxAttempts) throw e;
      if (e instanceof CommonsError) {
        if (e.code === 'maxlag') {
          const s = Math.max(5, Math.ceil(e.retryAfter ?? e.lag ?? 5));
          onWait(`Commons servers are busy; waiting ${s} s…`);
          await sleepFn(s * 1000, signal);
          continue;
        }
        if (e.code === 'ratelimited') {
          const s = Math.min(600, 60 * attempt);
          onWait(`Commons asked us to slow down; waiting ${s} s…`);
          await sleepFn(s * 1000, signal);
          continue;
        }
        if (e.code === 'badtoken' && refreshToken && !tokenRefreshed) {
          tokenRefreshed = true;
          await refreshToken();
          continue;
        }
        throw e;
      }
      if (e instanceof TypeError) {
        const s = 15 * attempt;
        onWait(`Network problem; retrying in ${s} s…`);
        await sleepFn(s * 1000, signal);
        continue;
      }
      throw e;
    }
  }
}

const failed = (error, extra = {}) => ({ state: 'failed', error, ...extra });

/**
 * Adds structured data to an uploaded file. A failure here leaves the upload in place
 * (state "uploaded" with sdcError) so it can be retried later; login problems are thrown.
 */
export async function addStructuredData({ status, sdc, summary, api, getToken, refreshToken, sleepFn = sleep, signal, onStep = () => {} }) {
  try {
    onStep('Adding structured data…');
    const pageId = status.pageId ?? (await api.pageId(status.commonsTitle, { sleepFn }));
    if (!pageId) throw new Error('Could not find the new file page on Commons yet');
    await withRetries(
      () => api.editEntity({ id: `M${pageId}`, data: sdc, summary, token: getToken() }),
      { sleepFn, signal, onWait: onStep, refreshToken },
    );
    return { ...status, state: 'sdc_done', pageId, sdcError: null };
  } catch (e) {
    if (e?.name === 'AbortError' || isAuthError(e)) throw e;
    return { ...status, state: 'uploaded', sdcError: e?.message || String(e) };
  }
}

/**
 * Uploads one photo. Returns the status to store:
 *   { state: 'duplicate', commonsTitle }            already on Commons, nothing uploaded
 *   { state: 'sdc_done' | 'uploaded', commonsTitle, pageId, sdcError? }
 *   { state: 'failed', error, code? }               code 'captcha' means stop the run
 * plus `sha1` and `uploadAttempted` (whether action=upload was called, used for pacing).
 */
export async function uploadPhoto({
  rec, filename, wikitext, comment, sdc, sdcSummary,
  api, getToken, refreshToken, download, sha1Fn, sleepFn = sleep, signal, onStep = () => {},
}) {
  const retry = { sleepFn, signal, onWait: onStep, refreshToken };

  onStep('Downloading the original from iNaturalist…');
  const blob = await download(rec.originalUrl, signal);
  const sha1 = await sha1Fn(await blob.arrayBuffer());

  onStep('Checking Commons for an identical file…');
  const dupes = await withRetries(() => api.findBySha1(sha1), retry);
  if (dupes.length) return { state: 'duplicate', sha1, commonsTitle: dupes[0], uploadAttempted: false };

  let name = filename;
  let outcome;
  for (let attempt = 0; ; attempt++) {
    onStep(`Uploading ${name}…`);
    try {
      outcome = interpretUpload(await withRetries(
        () => api.upload({ filename: name, text: wikitext, comment, file: blob, token: getToken() }),
        retry,
      ));
    } catch (e) {
      if (isCaptchaError(e)) outcome = { kind: 'captcha' };
      else throw e;
    }
    // Commons may suggest a corrected name once; anything else is final.
    if (outcome.kind === 'bad-filename' && attempt === 0 && outcome.suggestion && outcome.suggestion !== name) {
      name = outcome.suggestion;
      continue;
    }
    break;
  }

  const base = { sha1, uploadAttempted: true };
  switch (outcome.kind) {
    case 'success': {
      const status = { ...base, state: 'uploaded', commonsTitle: `File:${outcome.filename || name}`, pageId: null };
      if (!sdc) return status;
      return addStructuredData({ status, sdc, summary: sdcSummary, api, getToken, refreshToken, sleepFn, signal, onStep });
    }
    case 'duplicate':
      return { ...base, state: 'duplicate', commonsTitle: outcome.title };
    case 'deleted-duplicate':
      return failed(`An identical file was deleted from Commons before (${outcome.title}), so it was not uploaded again.`, base);
    case 'was-deleted':
      return failed(`A file named ${outcome.title} was deleted from Commons before, so it was not uploaded again.`, base);
    case 'name-taken':
      return failed(`A different file already uses the name ${outcome.title}.`, base);
    case 'bad-filename':
      return failed('Commons did not accept the file name.', base);
    case 'captcha':
      return failed('Commons asked for a CAPTCHA, which it does for new accounts. Upload one file by hand on Commons, or wait until the account is "autoconfirmed" (4 days and 10 edits), then try again.', { ...base, code: 'captcha' });
    case 'warning':
      return failed(`Commons returned a warning: ${Object.keys(outcome.warnings).join(', ') || 'unknown'}.`, base);
    default:
      return failed(`Unexpected response from Commons (${outcome.result}).`, base);
  }
}
