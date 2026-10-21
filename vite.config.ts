import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Every project is its own page. To add one, make a folder with an index.html
// in it and list it here, then add a link to it on the homepage (index.html).
export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        scanner: resolve(import.meta.dirname, 'scanner/index.html'),
      },
    },
  },
});
