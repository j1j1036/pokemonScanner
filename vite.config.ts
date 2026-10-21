import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import type { Connect, Plugin } from 'vite';
import { proxyValorant } from './netlify/functions/valorant';
import { fetchShop } from './netlify/functions/valorant-shop';

// Collect the body of a POST request (Node hands it over in pieces)
async function readBody(req: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

// On Netlify, /api/valorant/... and /api/valorant-shop are answered by the
// functions in netlify/functions/. This makes `npm run dev` and `npm run preview`
// answer them the same way, using the keys from the .env file.
function valorantApi(apiKey: string | undefined, shopOwnerKey: string | undefined): Plugin {
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    let response: Response;
    if (req.url?.startsWith('/api/valorant/')) {
      response = await proxyValorant(new Request(`http://localhost${req.url}`, { method: req.method }), apiKey);
    } else if (req.url === '/api/valorant-shop') {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const ownerKey = req.headers['x-owner-key'];
      const headers = typeof ownerKey === 'string' ? { 'X-Owner-Key': ownerKey } : undefined;
      response = await fetchShop(new Request(`http://localhost${req.url}`, { method: req.method, headers, body }), shopOwnerKey);
    } else {
      return next();
    }
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(await response.text());
  };
  return {
    name: 'valorant-api',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

// Every project is its own page. To add one, make a folder with an index.html
// in it and list it here, then add a link to it on the homepage (index.html).
export default defineConfig(({ mode }) => {
  // '' = read every variable in .env, not only VITE_ ones. This stays on the
  // server side: only VITE_ variables are ever put into the page.
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    plugins: [valorantApi(env.HENRIK_API_KEY, env.SHOP_OWNER_KEY)],
    build: {
      rolldownOptions: {
        input: {
          home: resolve(import.meta.dirname, 'index.html'),
          scanner: resolve(import.meta.dirname, 'scanner/index.html'),
          valorant: resolve(import.meta.dirname, 'valorant/index.html'),
        },
      },
    },
  };
});
