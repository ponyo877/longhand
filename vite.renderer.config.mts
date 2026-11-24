import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// フローティングバーと管理ウィンドウを 1 つの renderer（ui）から複数の HTML として出す
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(import.meta.dirname, '.vite/renderer/ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        floater: path.resolve(import.meta.dirname, 'src/renderer/floater.html'),
        management: path.resolve(import.meta.dirname, 'src/renderer/management.html'),
      },
    },
  },
});
