/**
 * Auth helpers — reads the authenticated user email from either:
 *  1. Cf-Access-Authenticated-User-Email header (injected for paths directly
 *     protected by the CF Access application, e.g. /settings)
 *  2. CF_Authorization JWT cookie (set by CF Access after login, sent on every
 *     same-domain request including /api/* calls from the settings page)
 *
 * The JWT path requires env.CF_ACCESS_AUD to be set (wrangler.toml [vars]).
 */

const CERTS_URL = 'https://wahoomarine.cloudflareaccess.com/cdn-cgi/access/certs';

// Module-level key cache — survives across requests within the same isolate.
let _cachedKeys = null;
let _cacheExpiry = 0;

async function getPublicKeys() {
  if (_cachedKeys && Date.now() < _cacheExpiry) return _cachedKeys;
  const resp = await fetch(CERTS_URL);
  if (!resp.ok) throw new Error(`CF Access certs fetch failed: ${resp.status}`);
  const { keys } = await resp.json();
  _cachedKeys = await Promise.all(
    keys.map(async jwk => ({
      kid: jwk.kid,
      key: await crypto.subtle.importKey(
        'jwk', jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['verify']
      ),
    }))
  );
  _cacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
  return _cachedKeys;
}

function parseCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function validateJWT(token, aud) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header  = JSON.parse(atob(parts[0]));
    const payload = JSON.parse(atob(parts[1]));

    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) return null;

    const keys = await getPublicKeys();
    const entry = keys.find(k => k.kid === header.kid);
    if (!entry) return null;

    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig  = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const ok   = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', entry.key, sig, data);
    return ok ? (payload.email || null) : null;
  } catch {
    return null;
  }
}

export async function getUserEmail(request, env) {
  // Fast path: CF Access injects this header for directly protected paths.
  const header = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (header) return header;

  // Fallback: validate the JWT cookie that CF Access sets after login.
  const token = parseCookie(request.headers.get('Cookie'), 'CF_Authorization');
  if (!token || !env?.CF_ACCESS_AUD) return null;
  return validateJWT(token, env.CF_ACCESS_AUD);
}

export async function isAdmin(request, env) {
  const email = await getUserEmail(request, env);
  return !!(email && env?.ADMIN_EMAIL && email === env.ADMIN_EMAIL);
}
