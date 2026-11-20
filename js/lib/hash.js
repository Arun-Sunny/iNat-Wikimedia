// SHA-1 of file bytes, as Commons stores it (lowercase hex). Needs a secure context (https or localhost).
export async function sha1Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-1', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
