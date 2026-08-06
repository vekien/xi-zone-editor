import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      'three/addons': path.resolve('node_modules/three/examples/jsm'),
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
