import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pill: resolve(import.meta.dirname, 'src/pill.html'),
        hub: resolve(import.meta.dirname, 'src/hub.html'),
      },
    },
  },
});
