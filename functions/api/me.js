/**
 * GET /api/me — returns the current authenticated user info.
 * Used by the settings page to show the logged-in email and admin status.
 */
import { getUserEmail, isAdmin } from '../lib/auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const email = getUserEmail(request);
  return Response.json({
    email,
    isAdmin: isAdmin(request, env),
  });
}
