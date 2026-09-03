/**
 * Constant-time-ish string comparison. Avoids leaking the secret's
 * length/content via early-exit timing. Deliberately avoids Node-only
 * crypto APIs (e.g. `node:crypto`'s timingSafeEqual) so callers stay
 * portable between Cloudflare Workers and Node.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length, 1);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
