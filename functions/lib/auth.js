/**
 * Auth helpers — reads Cloudflare Access injected headers.
 * When the site is behind Cloudflare Access, every request has
 * Cf-Access-Authenticated-User-Email set to the logged-in user's email.
 */

export function getUserEmail(request) {
  return request.headers.get('Cf-Access-Authenticated-User-Email') || null;
}

export function isAdmin(request, env) {
  const email = getUserEmail(request);
  return !!(email && env.ADMIN_EMAIL && email === env.ADMIN_EMAIL);
}
