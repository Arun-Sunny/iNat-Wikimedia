// Small helpers shared by the app and the tests. No DOM access here.

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? abortError());
      },
      { once: true },
    );
  });
}

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function unique(items) {
  return [...new Set(items)];
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Formats a coordinate with at most 6 decimals (about 0.1 m), without trailing zeros. */
export function formatCoord(n) {
  return String(Number(Number(n).toFixed(6)));
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
