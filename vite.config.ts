import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import type { Connect, Plugin } from 'vite';
import { proxyValorant } from './netlify/functions/valorant';

// On Netlify, /api/valorant/... is answered by netlify/functions/valorant.ts.
// This makes `npm run dev` and `npm run preview` answer it the same way,
// using the API key from the .env file.
function valorantApi(apiKey: string | undefined): Plugin {
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith('/api/valorant/')) return next();
    const response = await proxyValorant(new Request(`http://localhost${req.url}`, { method: req.method }), apiKey);
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
    plugins: [valorantApi(env.HENRIK_API_KEY)],
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
