import { defineConfig } from 'vite';

// Relative base: the build must work from any nested path (e.g. hopinto.fun serves /r/<release>/index.html).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
