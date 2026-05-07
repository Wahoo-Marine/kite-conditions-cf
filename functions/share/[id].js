/**
 * GET /share/:id
 *
 * Thin share-link route that keeps a clean public URL while reusing the
 * main spot page implementation in share mode.
 */

export async function onRequestGet(context) {
  const { request, params } = context;
  const url = new URL(request.url);
  const spotId = encodeURIComponent(params.id);
  url.pathname = '/spot.html';
  url.search = `id=${spotId}&share=1`;
  return Response.redirect(url.toString(), 302);
}
