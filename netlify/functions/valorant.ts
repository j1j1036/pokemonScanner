/**
 * Server-side proxy for the Valorant tracker (valorant/index.html).
 *
 * The page asks for /api/valorant/<path>; this adds our HenrikDev API key and
 * forwards the request to https://api.henrikdev.xyz/valorant/<path>. The key only
 * ever exists here on the server, so visitors can't copy it out of the page.
 *
 * On Netlify this file runs as a Netlify Function. During `npm run dev`,
 * vite.config.ts calls proxyValorant() directly, so both behave the same.
 */

// Netlify provides `process.env`; declared here so this file needs no Node type package
declare const process: { env: Record<string, string | undefined> };

const UPSTREAM = 'https://api.henrikdev.xyz/valorant/';

// Only these requests are forwarded, so nobody can use our key for anything else.
// [^/]+ is one piece of the URL, e.g. a Riot ID name or tag.
const REGION = '(na|eu|ap|kr|latam|br)';
const ALLOWED_PATHS = [
  /^v2\/account\/[^/]+\/[^/]+$/,
  new RegExp(`^v3/mmr/${REGION}/(pc|console)/[^/]+/[^/]+$`),
  new RegExp(`^v2/mmr-history/${REGION}/(pc|console)/[^/]+/[^/]+$`),
  new RegExp(`^v4/matches/${REGION}/(pc|console)/[^/]+/[^/]+$`),
  /^v1\/store-featured$/,
];
const ALLOWED_QUERY = ['size', 'mode', 'start'];

// Same shape as the API's own errors, so the page handles both the same way
function errorResponse(status: number, message: string): Response {
  return Response.json({ errors: [{ message, status }] }, { status });
}

export async function proxyValorant(request: Request, apiKey: string | undefined): Promise<Response> {
  if (request.method !== 'GET') return errorResponse(405, 'Only GET requests are allowed');
  if (!apiKey) return errorResponse(500, 'The server has no HENRIK_API_KEY set (see .env.example)');

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/valorant\//, '');
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) return errorResponse(404, 'Unknown endpoint');

  const upstream = new URL(UPSTREAM + path);
  for (const key of ALLOWED_QUERY) {
    const value = url.searchParams.get(key);
    if (value) upstream.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(upstream, { headers: { Authorization: apiKey } });
  } catch {
    return errorResponse(502, "Couldn't reach the HenrikDev API");
  }

  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (response.ok) {
    // Let Netlify's CDN reuse an answer for 2 minutes, so looking up the same
    // player again (or many visitors loading the store) doesn't use up our rate limit
    headers.set('Cache-Control', 'public, max-age=60');
    headers.set('Netlify-CDN-Cache-Control', 'public, s-maxage=120');
    headers.set('Netlify-Vary', 'query');
  }
  // On 429 (rate limited) this says how many seconds to wait
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) headers.set('Retry-After', retryAfter);

  return new Response(await response.text(), { status: response.status, headers });
}

export default (request: Request) => proxyValorant(request, process.env.HENRIK_API_KEY);

// Tell Netlify to run this function for every /api/valorant/... request
export const config = { path: '/api/valorant/*' };
