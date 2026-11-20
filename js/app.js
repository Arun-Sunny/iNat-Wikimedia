// UI for loading iNaturalist photos, choosing them, and previewing what would go to Commons.
// This build never writes to Commons: no upload, no edit. Login only reads the user's name and rights.
import { CONFIG } from './config.js';
import { pageObservations, toPhotoRecords, parseInatUser, fetchUser, profileUrl } from './lib/inat.js';
import { planRecord, pickOnePerSpecies, locationAllowed, SKIP_LABELS } from './lib/plan.js';
import { mapLicense } from './lib/license.js';
import { buildFilename } from './lib/filename.js';
import { renderWikitext } from './lib/wikitext.js';
import { buildSdc } from './lib/sdc.js';
import { CommonsApi, resolveCategories } from './lib/commons.js';
import { lookupTaxonQids } from './lib/wikidata.js';
import { sha1Hex } from './lib/hash.js';
import * as oauth from './lib/oauth.js';
import * as cache from './lib/cache.js';
import { escapeHtml, unique } from './lib/util.js';

const PAGE_SIZE = 60;
const SETTINGS_KEY = 'i2c.settings';
const TOKEN_KEY = 'i2c.token';
const PKCE_KEY = 'i2c.pkce';
const NEGATIVE_QID_TTL_MS = 30 * 24 * 3600 * 1000;

const SHORT_SKIP = {
  hidden: 'Hidden',
  'not-owner': 'Other observer',
  'no-license': 'No license',
  license: 'NC/ND license',
  'no-taxon': 'No species',
};
const QUALITY_LABEL = { research: 'Research Grade', needs_id: 'Needs ID', casual: 'Casual' };
const ITALIC_RANKS = new Set(['genus', 'subgenus', 'section', 'complex', 'species', 'hybrid', 'subspecies', 'variety', 'form']);

// ---------- storage helpers (never throw) ----------
function storage(kind) {
  try {
    return window[kind] ?? null;
  } catch {
    return null;
  }
}
function readJson(kind, key) {
  try {
    const raw = storage(kind)?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeJson(kind, key, value) {
  try {
    const s = storage(kind);
    if (!s) return;
    if (value == null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked or full; the session keeps working
  }
}

function defaultSettings() {
  return {
    env: CONFIG.defaultEnvironment,
    clientIdOverride: '',
    inatUser: CONFIG.inatUser || '',
    inatName: '',
    inatObsCount: null,
    ownWork: false,
    authorName: CONFIG.author?.name || '',
    authorUrl: CONFIG.author?.url || '',
    minQuality: CONFIG.minQuality,
    requireTaxon: CONFIG.requireTaxon,
    fallbackCategory: CONFIG.fallbackCategory,
    extraCategory: CONFIG.extraCategory,
    includeLicenseReview: CONFIG.includeLicenseReview,
    batchSize: CONFIG.batchSize,
    uploadLimit: CONFIG.uploadLimit,
    uploadDelaySec: CONFIG.uploadDelaySec,
  };
}

// ---------- state ----------
const state = {
  settings: { ...defaultSettings(), ...(readJson('localStorage', SETTINGS_KEY) ?? {}) },
  records: [],
  byKey: new Map(),
  plan: new Map(),
  selected: new Set(),
  status: new Map(),
  filters: { text: '', show: 'eligible' },
  shown: PAGE_SIZE,
  auth: null,
  user: null,
  loadAbort: null,
  previewAbort: null,
  reviewKeys: [],
  reviewInfo: new Map(),
  lastFetch: null,
};

const $ = (id) => document.getElementById(id);
let els;

// ---------- environment ----------
function envKey() {
  return CONFIG.environments[state.settings.env] ? state.settings.env : CONFIG.defaultEnvironment;
}
function env() {
  return CONFIG.environments[envKey()];
}
function clientId() {
  return (state.settings.clientIdOverride || '').trim() || env().clientId || '';
}
function commonsApi({ auth = false } = {}) {
  return new CommonsApi({
    apiUrl: env().commonsApi,
    userAgent: CONFIG.userAgent,
    accessToken: auth ? state.auth?.accessToken ?? null : null,
  });
}
// ---------- iNaturalist account ----------
const account = () => state.settings.inatUser || '';
const creditName = () => state.settings.authorName || state.settings.inatName || account();
const creditUrl = () => state.settings.authorUrl || (account() ? profileUrl(account()) : '');

function fileUrl(title) {
  return env().commonsWiki + encodeURIComponent(title.replace(/ /g, '_'));
}

// ---------- records and planning ----------
function setRecords(records) {
  records.sort((a, b) => b.obsId - a.obsId || a.position - b.position);
  state.records = records;
  state.byKey = new Map(records.map((r) => [r.key, r]));
  replan();
}

function replan() {
  const opts = {
    userLogin: account(),
    minQuality: state.settings.minQuality,
    requireTaxon: state.settings.requireTaxon,
  };
  state.plan = new Map(state.records.map((r) => [r.key, planRecord(r, opts)]));
  for (const key of [...state.selected]) if (!isSelectable(key)) state.selected.delete(key);
}

const isEligible = (key) => state.plan.get(key)?.eligible === true;
const onCommons = (key) => ['duplicate', 'uploaded', 'sdc_done'].includes(state.status.get(key)?.state);
const isSelectable = (key) => isEligible(key) && !onCommons(key);

let saveSelectionTimer;
function saveSelection() {
  clearTimeout(saveSelectionTimer);
  saveSelectionTimer = setTimeout(() => cache.put('meta', [...state.selected], 'selected'), 300);
}

// ---------- notices ----------
let noticeTimer;
function notify(message, kind = 'info') {
  clearTimeout(noticeTimer);
  els.noticeText.textContent = message;
  els.notice.className = `notice ${kind === 'info' ? '' : kind}`.trim();
  els.notice.hidden = false;
  if (kind === 'info') noticeTimer = setTimeout(() => (els.notice.hidden = true), 8000);
}

function errorMessage(e) {
  return e?.message || String(e);
}

// ---------- OAuth ----------
async function startLogin() {
  const id = clientId();
  if (!id) {
    notify('Login isn\'t set up yet: the OAuth client ID is missing. Follow "Register the Wikimedia login" in the README, then put the ID in config.js or in Settings.', 'warn');
    return;
  }
  const verifier = oauth.randomString(48);
  const st = oauth.randomString(16);
  const challenge = await oauth.pkceChallenge(verifier);
  writeJson('sessionStorage', PKCE_KEY, { verifier, state: st, envKey: envKey() });
  location.assign(oauth.buildAuthorizeUrl({
    restBase: env().oauthRest,
    clientId: id,
    redirectUri: oauth.redirectUriFor(location),
    state: st,
    challenge,
  }));
}

async function finishLoginIfRedirected() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  const redirectUri = oauth.redirectUriFor(location);
  history.replaceState(null, '', redirectUri + location.hash);
  const saved = readJson('sessionStorage', PKCE_KEY);
  writeJson('sessionStorage', PKCE_KEY, null);

  if (params.has('error')) {
    notify(`Login was cancelled or refused (${params.get('error_description') || params.get('error')}).`, 'warn');
    return;
  }
  if (!saved || saved.state !== params.get('state')) {
    notify('Login failed because the response did not match this browser tab. Please try again.', 'error');
    return;
  }
  const savedEnv = CONFIG.environments[saved.envKey];
  if (!savedEnv) return;
  try {
    const token = await oauth.exchangeCode({
      restBase: savedEnv.oauthRest,
      clientId: (state.settings.clientIdOverride || '').trim() || savedEnv.clientId,
      code: params.get('code'),
      redirectUri,
      verifier: saved.verifier,
    });
    const auth = { ...token, envKey: saved.envKey };
    writeJson('sessionStorage', TOKEN_KEY, auth);
  } catch (e) {
    notify(errorMessage(e), 'error');
  }
}

function restoreLogin() {
  const auth = readJson('sessionStorage', TOKEN_KEY);
  if (auth && auth.envKey === envKey() && auth.expiresAt > Date.now() + 60_000) state.auth = auth;
  else state.auth = null;
}

function logout(message) {
  writeJson('sessionStorage', TOKEN_KEY, null);
  state.auth = null;
  state.user = null;
  renderAccount();
  renderReview();
  if (message) notify(message, 'warn');
}

async function loadUser() {
  if (!state.auth) return;
  renderAccount();
  try {
    const info = await commonsApi({ auth: true }).userInfo();
    if (!info || info.anon) {
      logout('Commons did not accept the login. Please log in again.');
      return;
    }
    state.user = { name: info.name, canUpload: (info.rights ?? []).includes('upload') };
    if (!state.user.canUpload) {
      notify(`${info.name} is logged in, but Commons doesn't allow this account to upload yet.`, 'warn');
    }
  } catch (e) {
    logout(`Couldn't confirm your Commons login (${errorMessage(e)}). Please log in again.`);
    return;
  }
  renderAccount();
  renderReview();
}

// ---------- loading from iNaturalist ----------
async function loadObservations({ reloadAll = false } = {}) {
  if (state.loadAbort) return;
  const userLogin = account();
  if (!userLogin) {
    notify('Enter an iNaturalist profile link or username first.', 'warn');
    els.inatInput.focus();
    return;
  }
  const ctrl = new AbortController();
  state.loadAbort = ctrl;
  renderLoad();

  let kept = state.records;
  let idAbove = 0;
  if (reloadAll) kept = [];
  else idAbove = kept.reduce((max, r) => Math.max(max, r.obsId), 0);

  const fresh = [];
  let observations = 0;
  let total = null;
  setProgress(0, null, 0);
  try {
    for await (const page of pageObservations({ userLogin, idAbove, signal: ctrl.signal })) {
      if (total == null) total = page.remaining;
      observations += page.results.length;
      const recs = page.results.flatMap(toPhotoRecords);
      fresh.push(...recs);
      setProgress(observations, total, fresh.length);
      setRecords([...kept, ...fresh]);
      renderChoose();
    }
    if (reloadAll) await cache.clear('records');
    await cache.putMany('records', fresh);
    state.lastFetch = Date.now();
    await cache.put('meta', state.lastFetch, 'lastFetch');
    notify(observations
      ? `Loaded ${observations.toLocaleString()} observations with ${fresh.length.toLocaleString()} photos.`
      : 'No new observations since the last load.');
  } catch (e) {
    if (e?.name === 'AbortError') {
      await cache.putMany('records', fresh);
      notify(`Stopped. ${fresh.length.toLocaleString()} new photos were kept; "Load photos" continues from there.`);
    } else {
      await cache.putMany('records', fresh);
      notify(`Loading from iNaturalist failed: ${errorMessage(e)}`, 'error');
    }
  } finally {
    state.loadAbort = null;
    els.loadProgress.hidden = true;
    renderAll();
  }
}

function setProgress(done, total, photos) {
  els.loadProgress.hidden = false;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 4;
  els.loadBar.style.width = `${pct}%`;
  els.loadText.textContent = total == null
    ? 'Contacting iNaturalist…'
    : `${done.toLocaleString()} of ${total.toLocaleString()} observations · ${photos.toLocaleString()} photos (about 1 page per second)`;
}

// ---------- rendering ----------
function renderAll() {
  renderAccount();
  renderLoad();
  renderChoose();
  renderReview();
}

function renderAccount() {
  els.envBadge.hidden = envKey() === 'production';
  if (state.auth && state.user) {
    els.account.innerHTML = `<span class="who" title="Logged in to ${escapeHtml(env().label)}">${escapeHtml(state.user.name)}</span>
      <button type="button" class="btn small ghost" data-action="logout">Log out</button>`;
  } else if (state.auth) {
    els.account.innerHTML = '<span class="muted">Signing in…</span>';
  } else {
    els.account.innerHTML = '<button type="button" class="btn small primary" data-action="login"><span class="long">Log in with Wikimedia</span><span class="short">Log in</span></button>';
  }
}

function loadEstimate(count) {
  if (!count) return '';
  const seconds = Math.ceil(count / 200) * 2; // one page of 200 about every 2 seconds
  return seconds < 90 ? ' Loading takes about a minute.' : ` Loading takes about ${Math.round(seconds / 60)} minutes.`;
}

function renderLoad() {
  const loading = Boolean(state.loadAbort);
  const login = account();
  if (document.activeElement !== els.inatInput) els.inatInput.value = login;
  els.inatInput.disabled = loading;
  els.useAccountBtn.disabled = loading;
  els.ownWorkRow.hidden = !login;
  els.ownWorkCheck.checked = Boolean(state.settings.ownWork);

  if (!login) {
    els.inatLine.textContent = 'Paste the link to your iNaturalist profile (or type your username), then press "Use this account".';
  } else {
    const who = state.settings.inatName ? `${state.settings.inatName} (${login})` : login;
    const total = state.settings.inatObsCount;
    let line = `Account: <a href="${escapeHtml(profileUrl(login))}" rel="noopener">${escapeHtml(who)}</a>`;
    line += total != null ? `, ${total.toLocaleString()} observations on iNaturalist.` : '.';
    if (state.records.length) {
      const obsCount = new Set(state.records.map((r) => r.obsId)).size;
      line += ` ${obsCount.toLocaleString()} observations and ${state.records.length.toLocaleString()} photos are saved in this browser`;
      line += state.lastFetch ? `, last checked ${new Date(state.lastFetch).toLocaleString()}.` : '.';
    } else {
      line += ` Nothing loaded yet.${loadEstimate(total)}`;
    }
    els.inatLine.innerHTML = line;
  }
  els.loadBtn.textContent = state.records.length ? 'Check for new photos' : 'Load photos';
  els.loadBtn.disabled = loading || !login;
  els.reloadBtn.hidden = loading || !state.records.length;
  els.stopLoadBtn.hidden = !loading;
}

/** Forgets everything loaded for the previous account. Upload statuses stay: they're per photo. */
async function resetAccountData() {
  state.records = [];
  state.byKey = new Map();
  state.plan = new Map();
  state.selected.clear();
  state.reviewKeys = [];
  state.reviewInfo.clear();
  state.lastFetch = null;
  await cache.clear('records');
  await cache.put('meta', [], 'selected');
  await cache.put('meta', null, 'lastFetch');
}

async function useAccount(raw) {
  if (state.loadAbort) return;
  const wanted = parseInatUser(raw);
  if (!wanted) {
    notify('That doesn\'t look like an iNaturalist profile link or username. Example: https://www.inaturalist.org/people/yourname', 'warn');
    return;
  }
  els.useAccountBtn.disabled = true;
  els.useAccountBtn.textContent = 'Checking…';
  try {
    const user = await fetchUser(wanted);
    if (!user) {
      notify(`iNaturalist has no account called "${wanted}".`, 'warn');
      return;
    }
    const changed = user.login.toLowerCase() !== account().toLowerCase();
    if (changed) await resetAccountData();
    state.settings = {
      ...state.settings,
      inatUser: user.login,
      inatName: user.name,
      inatObsCount: user.observationsCount,
      // A different person: drop the old credit overrides and the own-work confirmation.
      ...(changed ? { ownWork: false, authorName: '', authorUrl: '' } : {}),
    };
    writeJson('localStorage', SETTINGS_KEY, state.settings);
    replan();
    els.inatInput.value = user.login;
    renderAll();
    const count = user.observationsCount != null ? `${user.observationsCount.toLocaleString()} observations` : 'account found';
    notify(changed
      ? `Using ${user.name || user.login} (${user.login}): ${count}. Press "Load photos".`
      : `Account details refreshed: ${count}.`);
  } catch (e) {
    notify(`Couldn't reach iNaturalist: ${errorMessage(e)}`, 'error');
  } finally {
    els.useAccountBtn.textContent = 'Use this account';
    els.useAccountBtn.disabled = Boolean(state.loadAbort);
  }
}

function counts() {
  const c = { total: state.records.length, eligible: 0, selected: state.selected.size, onCommons: 0, skipped: 0, reasons: new Map() };
  for (const r of state.records) {
    const p = state.plan.get(r.key);
    if (onCommons(r.key)) c.onCommons++;
    if (p?.eligible) {
      if (!onCommons(r.key)) c.eligible++;
    } else {
      c.skipped++;
      const label = p.reason === 'quality' ? `Quality grade: ${QUALITY_LABEL[p.detail] ?? p.detail ?? 'none'}`
        : p.reason === 'license' ? `License: ${p.detail}`
          : SKIP_LABELS[p.reason] ?? p.reason;
      c.reasons.set(label, (c.reasons.get(label) ?? 0) + 1);
    }
  }
  return c;
}

function renderSummary() {
  if (!state.records.length) {
    els.summary.innerHTML = '<p class="muted">Load photos first.</p>';
    return;
  }
  const c = counts();
  const reasons = [...c.reasons.entries()].sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `<li>${escapeHtml(label)}: ${n.toLocaleString()}</li>`).join('');
  els.summary.innerHTML = `
    <div class="stat"><b>${c.total.toLocaleString()}</b><span>photos</span></div>
    <div class="stat accent"><b>${c.eligible.toLocaleString()}</b><span>can upload</span></div>
    <div class="stat"><b>${c.selected.toLocaleString()}</b><span>selected</span></div>
    <div class="stat"><b>${c.onCommons.toLocaleString()}</b><span>already on Commons</span></div>
    <div class="stat"><b>${c.skipped.toLocaleString()}</b><span>can't upload</span></div>
    ${reasons ? `<details class="skip-reasons"><summary>Why some photos can't be uploaded</summary><ul>${reasons}</ul></details>` : ''}`;
}

function visibleRecords() {
  const q = state.filters.text.trim().toLowerCase();
  const show = state.filters.show;
  return state.records.filter((r) => {
    const eligible = isEligible(r.key);
    if (show === 'eligible' && (!eligible || onCommons(r.key))) return false;
    if (show === 'skipped' && eligible) return false;
    if (show === 'selected' && !state.selected.has(r.key)) return false;
    if (show === 'oncommons' && !onCommons(r.key)) return false;
    if (q && !`${r.taxonName ?? ''} ${r.commonName ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function nameHtml(r) {
  const name = escapeHtml(r.taxonName ?? 'Unidentified');
  return ITALIC_RANKS.has(r.taxonRank) ? `<i>${name}</i>` : name;
}

const INFO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';

function tileHtml(r) {
  const p = state.plan.get(r.key);
  const selected = state.selected.has(r.key);
  const done = onCommons(r.key);
  const selectable = isSelectable(r.key);
  const cls = ['tile', selected && 'is-selected', !p.eligible && 'is-skipped', done && 'is-done'].filter(Boolean).join(' ');
  let badge = '';
  if (done) badge = '<span class="badge badge-done">On Commons</span>';
  else if (!p.eligible) {
    const text = p.reason === 'quality' ? QUALITY_LABEL[p.detail] ?? 'Low quality' : SHORT_SKIP[p.reason] ?? 'Skipped';
    badge = `<span class="badge">${escapeHtml(text)}</span>`;
  } else if (r.qualityGrade !== 'research') badge = `<span class="badge">${escapeHtml(QUALITY_LABEL[r.qualityGrade] ?? '')}</span>`;
  const title = r.taxonName ?? 'Unidentified';
  const sub = [r.commonName, r.observedOn].filter(Boolean).join(' · ');
  const label = `${selected ? 'Deselect' : 'Select'} ${title}${r.observedOn ? `, ${r.observedOn}` : ''}`;
  return `<li class="${cls}" data-key="${r.key}">
    <button type="button" class="tile-hit" data-action="toggle" aria-pressed="${selected}" aria-label="${escapeHtml(label)}"${selectable ? '' : ' disabled'}>
      <img src="${escapeHtml(r.thumbUrl)}" alt="" loading="lazy" decoding="async" width="240" height="240">
      <span class="check" aria-hidden="true"></span>${badge}
    </button>
    <div class="tile-meta">
      <div class="tile-text"><span class="tile-name">${nameHtml(r)}</span><span class="tile-sub">${escapeHtml(sub)}</span></div>
      <button type="button" class="tile-info" data-action="details" aria-label="Details for ${escapeHtml(title)}">${INFO_ICON}</button>
    </div>
  </li>`;
}

function renderGrid() {
  const list = visibleRecords();
  const slice = list.slice(0, state.shown);
  els.grid.innerHTML = slice.map(tileHtml).join('');
  els.moreBtn.hidden = list.length <= slice.length;
  els.moreBtn.textContent = `Show more (${(list.length - slice.length).toLocaleString()} left)`;
  els.gridCount.textContent = state.records.length
    ? `Showing ${slice.length.toLocaleString()} of ${list.length.toLocaleString()} photos. Tap a photo to select it.`
    : '';
}

function renderSelectionBar() {
  const n = state.selected.size;
  els.selectionBar.hidden = n === 0;
  els.selectionCount.textContent = `${n.toLocaleString()} selected`;
}

function renderChoose() {
  renderSummary();
  renderGrid();
  renderSelectionBar();
}

function updateTile(key) {
  const li = els.grid.querySelector(`li[data-key="${CSS.escape(key)}"]`);
  const r = state.byKey.get(key);
  if (li && r) li.outerHTML = tileHtml(r);
}

function toggleSelection(key) {
  if (!isSelectable(key)) return;
  if (state.selected.has(key)) state.selected.delete(key);
  else state.selected.add(key);
  updateTile(key);
  els.grid.querySelector(`li[data-key="${CSS.escape(key)}"] .tile-hit`)?.focus();
  renderSummary();
  renderSelectionBar();
  renderReviewIntro();
  saveSelection();
}

// ---------- review (dry run) ----------
function wikitextContext(info) {
  return {
    authorName: creditName(),
    authorUrl: creditUrl(),
    commonsUser: state.user?.name ?? null,
    categories: [info?.category, state.settings.extraCategory].map((c) => (c || '').trim()).filter(Boolean),
    includeLicenseReview: state.settings.includeLicenseReview,
  };
}

function sdcContext(info) {
  return {
    authorName: creditName(),
    authorUrl: creditUrl(),
    commonsUser: state.user?.name ?? null,
    depictsQid: info?.qid ?? null,
  };
}

function renderReviewIntro() {
  const n = state.selected.size;
  const login = state.user ? '' : ' Log in first if you want the preview to include your Commons username.';
  const own = state.settings.ownWork ? '' : ' Uploading will need the "These are my own photos" box in step 1 ticked.';
  els.reviewIntro.textContent = n
    ? `${n.toLocaleString()} photos selected. "Check & preview" downloads up to ${state.settings.batchSize} of them at a time, checks that Commons doesn't already have them, and shows the exact file name, description page and structured data that would be sent.${login}${own}`
    : 'Select photos in step 2, then check them here before anything is uploaded.';
  els.previewBtn.disabled = n === 0 || Boolean(state.previewAbort);
}

function statusPill(key) {
  const s = state.status.get(key);
  const info = state.reviewInfo.get(key);
  const pills = [];
  if (!s) pills.push('<span class="pill">Not checked yet</span>');
  else if (s.state === 'duplicate') {
    pills.push(`<span class="pill done">Already on Commons</span> <a class="small" href="${escapeHtml(fileUrl(s.commonsTitle))}" rel="noopener">${escapeHtml(s.commonsTitle)}</a>`);
  } else if (s.state === 'deduped') pills.push('<span class="pill ok">Not on Commons yet</span>');
  if (info?.nameTaken && s?.state !== 'duplicate') pills.push('<span class="pill bad">File name already used</span>');
  return pills.join(' ');
}

function locationFact(r) {
  if (r.lat == null) return 'none recorded';
  if (!locationAllowed(r)) return 'left out (location is hidden on iNaturalist)';
  return r.accuracy ? `included (accurate to about ${Math.round(r.accuracy).toLocaleString()} m)` : 'included';
}

function reviewItemHtml(key) {
  const r = state.byKey.get(key);
  const info = state.reviewInfo.get(key) ?? {};
  const license = mapLicense(r.licenseCode);
  const depicts = !env().structuredData
    ? 'skipped on the test site'
    : info.qid
      ? `<a href="https://www.wikidata.org/wiki/${info.qid}" rel="noopener">${info.qid}</a>`
      : 'no Wikidata item for this species, so "depicts" is left out';
  const category = info.category
    ? `${escapeHtml(info.category)}${info.isFallback ? ' <span class="pill warn">fallback</span>' : ''}`
    : '<span class="pill warn">none</span>';
  return `<li class="review-item" data-key="${key}">
    <img src="${escapeHtml(r.thumbUrl)}" alt="" loading="lazy" width="72" height="72">
    <div class="ri-body">
      <p class="ri-name">${escapeHtml(info.filename ?? buildFilename(r))}</p>
      <div class="ri-status">${statusPill(key)}</div>
      <ul class="facts">
        <li><b>Category:</b> ${category}</li>
        <li><b>Depicts:</b> ${depicts}</li>
        <li><b>Location:</b> ${escapeHtml(locationFact(r))}</li>
        <li><b>License:</b> ${escapeHtml(license?.label ?? r.licenseCode ?? 'none')} · <a href="${escapeHtml(r.uri)}" rel="noopener">observation</a></li>
      </ul>
      <details class="code" data-kind="wikitext"><summary>Description page (wikitext)</summary><pre></pre></details>
      ${env().structuredData ? '<details class="code" data-kind="sdc"><summary>Structured data</summary><pre></pre></details>' : ''}
    </div>
  </li>`;
}

function fillCode(details, key) {
  const r = state.byKey.get(key);
  const info = state.reviewInfo.get(key);
  const pre = details.querySelector('pre');
  try {
    pre.textContent = details.dataset.kind === 'sdc'
      ? JSON.stringify(buildSdc(r, sdcContext(info)), null, 2)
      : renderWikitext(r, wikitextContext(info));
  } catch (e) {
    pre.textContent = errorMessage(e);
  }
}

function renderReview() {
  renderReviewIntro();
  const keys = state.reviewKeys.filter((k) => state.byKey.has(k));
  els.reviewList.innerHTML = keys.map(reviewItemHtml).join('');
}

function updateReviewItem(key) {
  const li = els.reviewList.querySelector(`li[data-key="${CSS.escape(key)}"]`);
  if (li) li.querySelector('.ri-status').innerHTML = statusPill(key);
}

async function taxonQids(ids) {
  const wanted = unique(ids.filter((id) => id != null).map(String));
  const cached = await cache.getMany('taxa', wanted);
  const result = new Map();
  const missing = [];
  for (const id of wanted) {
    const hit = cached.get(id);
    if (hit && (hit.qid || Date.now() - hit.at < NEGATIVE_QID_TTL_MS)) result.set(id, hit.qid);
    else missing.push(id);
  }
  if (missing.length) {
    const found = await lookupTaxonQids(missing, { sparqlUrl: CONFIG.wikidataSparql });
    const now = Date.now();
    await cache.putMany('taxa', [...found.entries()].map(([id, qid]) => [id, { qid, at: now }]));
    for (const [id, qid] of found) result.set(id, qid);
  }
  return result;
}

/** Category, Wikidata item and file-name check for a set of records. Read-only. */
async function gatherInfo(records) {
  const api = commonsApi();
  setReviewStatus('Looking up categories on Commons…');
  const cats = await resolveCategories(records, api, state.settings.fallbackCategory.trim());
  let qids = new Map();
  if (env().structuredData) {
    setReviewStatus('Looking up species on Wikidata…');
    qids = await taxonQids(records.map((r) => r.taxonId));
  }
  setReviewStatus('Checking file names on Commons…');
  const names = new Map(records.map((r) => [r.key, buildFilename(r)]));
  const taken = await api.pagesExist([...names.values()].map((n) => `File:${n}`));
  for (const r of records) {
    const filename = names.get(r.key);
    state.reviewInfo.set(r.key, {
      ...cats.get(r.key),
      qid: r.taxonId != null ? qids.get(String(r.taxonId)) ?? null : null,
      filename,
      nameTaken: taken.get(`File:${filename}`) === true,
    });
  }
}

function setReviewStatus(text) {
  els.reviewStatus.textContent = text;
}

async function checkAndPreview() {
  if (state.previewAbort) return;
  const records = state.records.filter((r) => state.selected.has(r.key));
  if (!records.length) return;
  const ctrl = new AbortController();
  state.previewAbort = ctrl;
  els.stopPreviewBtn.hidden = false;
  renderReviewIntro();
  try {
    await gatherInfo(records);
    state.reviewKeys = records.map((r) => r.key);
    renderReview();

    const api = commonsApi();
    const todo = records.filter((r) => !state.status.has(r.key)).slice(0, Math.max(1, Number(state.settings.batchSize) || 25));
    let checked = 0;
    let dupes = 0;
    for (const r of todo) {
      if (ctrl.signal.aborted) break;
      setReviewStatus(`Checking for duplicates: ${checked + 1} of ${todo.length} (${r.taxonName ?? 'photo'} ${r.photoId})…`);
      const res = await fetch(r.originalUrl, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Couldn't download photo ${r.photoId} from iNaturalist (HTTP ${res.status})`);
      const sha1 = await sha1Hex(await res.arrayBuffer());
      const matches = await api.findBySha1(sha1);
      const status = matches.length
        ? { key: r.key, state: 'duplicate', sha1, commonsTitle: matches[0], at: Date.now() }
        : { key: r.key, state: 'deduped', sha1, commonsTitle: null, at: Date.now() };
      state.status.set(r.key, status);
      await cache.put('status', status);
      if (status.state === 'duplicate') {
        dupes++;
        state.selected.delete(r.key);
      }
      checked++;
      updateReviewItem(r.key);
    }
    const remaining = records.filter((r) => !state.status.has(r.key)).length;
    let msg = `Checked ${checked} photo${checked === 1 ? '' : 's'}`;
    if (dupes) msg += `; ${dupes} already on Commons and removed from the selection`;
    msg += remaining ? `. ${remaining.toLocaleString()} still to check: press "Check & preview" again.` : '. Every selected photo has been checked.';
    setReviewStatus(msg);
  } catch (e) {
    setReviewStatus(e?.name === 'AbortError' ? 'Stopped.' : '');
    if (e?.name !== 'AbortError') notify(`Preview failed: ${errorMessage(e)}`, 'error');
  } finally {
    state.previewAbort = null;
    els.stopPreviewBtn.hidden = true;
    saveSelection();
    renderReviewIntro();
    renderSummary();
    renderGrid();
    renderSelectionBar();
  }
}

// ---------- details dialog ----------
async function openDetails(key) {
  const r = state.byKey.get(key);
  if (!r) return;
  const p = state.plan.get(key);
  const license = mapLicense(r.licenseCode);
  els.detailsTitle.innerHTML = nameHtml(r);
  const status = p.eligible
    ? onCommons(key) ? 'Already on Commons' : 'Can be uploaded'
    : `Can't be uploaded: ${p.reason === 'quality' ? `quality grade is ${QUALITY_LABEL[p.detail] ?? p.detail}` : SKIP_LABELS[p.reason] ?? p.reason}`;
  els.detailsContent.innerHTML = `
    <img class="details-photo" src="${escapeHtml(r.mediumUrl)}" alt="">
    <ul class="facts">
      <li><b>${escapeHtml(status)}</b></li>
      ${r.commonName ? `<li><b>Common name:</b> ${escapeHtml(r.commonName)}</li>` : ''}
      <li><b>Observed:</b> ${escapeHtml(r.observedOn ?? 'unknown')} · ${escapeHtml(QUALITY_LABEL[r.qualityGrade] ?? r.qualityGrade ?? '')}</li>
      <li><b>License on iNaturalist:</b> ${escapeHtml(license?.label ?? r.licenseCode ?? 'none (all rights reserved)')}</li>
      <li><b>Location:</b> ${escapeHtml(locationFact(r))}</li>
      <li><a href="${escapeHtml(r.uri)}" rel="noopener">Open the observation on iNaturalist</a></li>
    </ul>
    <div id="detailsPreview">${p.eligible ? '<p class="muted small">Preparing preview…</p>' : ''}</div>`;
  if (!els.detailsDialog.open) els.detailsDialog.showModal();
  if (!p.eligible) return;
  try {
    if (!state.reviewInfo.has(key)) {
      await gatherInfo([r]);
      setReviewStatus('');
    }
    const info = state.reviewInfo.get(key);
    const box = $('detailsPreview');
    if (!box) return;
    box.innerHTML = `<ul class="facts">
        <li><b>File name:</b> ${escapeHtml(info.filename)}${info.nameTaken ? ' <span class="pill bad">already used</span>' : ''}</li>
      </ul>
      <details class="code" data-kind="wikitext" open><summary>Description page (wikitext)</summary><pre></pre></details>
      ${env().structuredData ? '<details class="code" data-kind="sdc"><summary>Structured data</summary><pre></pre></details>' : ''}`;
    for (const d of box.querySelectorAll('details.code')) fillCode(d, key);
  } catch (e) {
    const box = $('detailsPreview');
    if (box) box.innerHTML = `<p class="small">Couldn't prepare the preview: ${escapeHtml(errorMessage(e))}</p>`;
  }
}

// ---------- settings ----------
function fillSettingsForm(settings) {
  const f = els.settingsForm;
  els.envSelect.innerHTML = Object.entries(CONFIG.environments)
    .map(([k, e]) => `<option value="${k}">${escapeHtml(e.label)}</option>`).join('');
  for (const [name, value] of Object.entries(settings)) {
    const input = f.elements.namedItem(name);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  }
  if (!CONFIG.environments[settings.env]) f.elements.namedItem('env').value = CONFIG.defaultEnvironment;
  f.elements.namedItem('authorName').placeholder = state.settings.inatName || account() || 'Name from iNaturalist';
  f.elements.namedItem('authorUrl').placeholder = account() ? profileUrl(account()) : 'Profile link from iNaturalist';
  els.callbackUrl.textContent = oauth.redirectUriFor(location);
}

function openSettings() {
  fillSettingsForm(state.settings);
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
}

function saveSettings() {
  const f = els.settingsForm;
  const next = { ...state.settings };
  for (const name of Object.keys(defaultSettings())) {
    const input = f.elements.namedItem(name);
    if (!input) continue;
    if (input.type === 'checkbox') next[name] = input.checked;
    else if (input.type === 'number') next[name] = Number(input.value) || defaultSettings()[name];
    else next[name] = input.value.trim();
  }
  const envChanged = next.env !== state.settings.env;
  state.settings = next;
  writeJson('localStorage', SETTINGS_KEY, next);
  if (envChanged) {
    state.reviewInfo.clear();
    restoreLogin();
    state.user = null;
    if (state.auth) loadUser();
  }
  replan();
  renderAll();
}

// ---------- events ----------
function bindEvents() {
  els.account.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'login') startLogin().catch((err) => notify(errorMessage(err), 'error'));
    if (action === 'logout') logout();
  });
  els.noticeClose.addEventListener('click', () => (els.notice.hidden = true));
  els.accountForm.addEventListener('submit', (e) => {
    e.preventDefault();
    useAccount(els.inatInput.value);
  });
  els.ownWorkCheck.addEventListener('change', () => {
    state.settings = { ...state.settings, ownWork: els.ownWorkCheck.checked };
    writeJson('localStorage', SETTINGS_KEY, state.settings);
    renderReviewIntro();
  });
  els.loadBtn.addEventListener('click', () => loadObservations());
  els.reloadBtn.addEventListener('click', () => loadObservations({ reloadAll: true }));
  els.stopLoadBtn.addEventListener('click', () => state.loadAbort?.abort());

  let searchTimer;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.text = els.searchInput.value;
      state.shown = PAGE_SIZE;
      renderGrid();
    }, 200);
  });
  els.showSelect.addEventListener('change', () => {
    state.filters.show = els.showSelect.value;
    state.shown = PAGE_SIZE;
    renderGrid();
  });
  els.moreBtn.addEventListener('click', () => {
    state.shown += PAGE_SIZE * 2;
    renderGrid();
  });

  els.grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    const key = btn?.closest('li[data-key]')?.dataset.key;
    if (!key) return;
    if (btn.dataset.action === 'toggle') toggleSelection(key);
    if (btn.dataset.action === 'details') openDetails(key);
  });

  els.pickBestBtn.addEventListener('click', () => {
    const covered = new Set(state.records.filter((r) => onCommons(r.key)).map((r) => r.taxonId));
    const picks = pickOnePerSpecies(state.records, (r) => isSelectable(r.key) && !covered.has(r.taxonId));
    const before = state.selected.size;
    for (const r of picks) state.selected.add(r.key);
    const added = state.selected.size - before;
    notify(`Added ${added.toLocaleString()} photos: the most-faved photo of each species not yet on Commons.`);
    saveSelection();
    renderChoose();
    renderReviewIntro();
  });
  els.selectShownBtn.addEventListener('click', () => {
    for (const r of visibleRecords()) if (isSelectable(r.key)) state.selected.add(r.key);
    saveSelection();
    renderChoose();
    renderReviewIntro();
  });
  els.clearBtn.addEventListener('click', () => {
    state.selected.clear();
    saveSelection();
    renderChoose();
    renderReviewIntro();
  });

  els.previewBtn.addEventListener('click', () => checkAndPreview());
  els.stopPreviewBtn.addEventListener('click', () => state.previewAbort?.abort());
  els.reviewList.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName !== 'DETAILS' || !d.open) return;
    const key = d.closest('li[data-key]')?.dataset.key;
    if (key) fillCode(d, key);
  }, true);

  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsForm.addEventListener('submit', (e) => {
    if (e.submitter?.value === 'save') saveSettings();
  });
  // Puts the defaults in the form; they take effect when the user presses Save.
  els.resetSettingsBtn.addEventListener('click', () => fillSettingsForm(defaultSettings()));
  els.detailsClose.addEventListener('click', () => els.detailsDialog.close());
  for (const dialog of [els.detailsDialog, els.settingsDialog]) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = document.querySelector(btn.dataset.copy)?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    } catch {
      notify('Copy failed. Select the text and copy it by hand.', 'warn');
    }
  });
}

// ---------- start ----------
async function init() {
  els = Object.fromEntries([
    'account', 'envBadge', 'settingsBtn', 'notice', 'noticeText', 'noticeClose',
    'accountForm', 'inatInput', 'useAccountBtn', 'ownWorkRow', 'ownWorkCheck', 'inatLine', 'loadBtn', 'reloadBtn', 'stopLoadBtn', 'loadProgress', 'loadBar', 'loadText',
    'summary', 'searchInput', 'showSelect', 'pickBestBtn', 'selectShownBtn', 'clearBtn', 'gridCount', 'grid', 'moreBtn',
    'reviewIntro', 'previewBtn', 'stopPreviewBtn', 'uploadBtn', 'reviewStatus', 'reviewList',
    'selectionBar', 'selectionCount',
    'settingsDialog', 'settingsForm', 'envSelect', 'callbackUrl', 'resetSettingsBtn',
    'detailsDialog', 'detailsTitle', 'detailsContent', 'detailsClose',
  ].map((id) => [id, $(id)]));
  bindEvents();
  restoreLogin();
  renderAll(); // show the page at once; cached photos fill in below

  await finishLoginIfRedirected();
  restoreLogin();
  renderAccount();

  const [records, statuses, selected, lastFetch] = await Promise.all([
    cache.getAll('records'),
    cache.getAll('status'),
    cache.get('meta', 'selected'),
    cache.get('meta', 'lastFetch'),
  ]);
  for (const s of statuses) state.status.set(s.key, s);
  state.lastFetch = lastFetch ?? null;
  // Keep only photos from the current account (the cache may predate an account switch).
  const login = account().toLowerCase();
  const mine = login ? records.filter((r) => !r.observer || r.observer.toLowerCase() === login) : [];
  if (mine.length !== records.length) {
    await cache.clear('records');
    await cache.putMany('records', mine);
    if (!mine.length) state.lastFetch = null;
  }
  setRecords(mine);
  if (Array.isArray(selected)) for (const k of selected) if (isSelectable(k)) state.selected.add(k);
  renderAll();
  if (state.auth) loadUser();
}

init().catch((e) => notify(`Something went wrong while starting: ${errorMessage(e)}`, 'error'));
