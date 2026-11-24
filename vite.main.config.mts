import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // SDK は依存が軽いのでバンドルに含める。electron と node 組み込みは plugin-vite が外す
      external: [],
    },
  },
});
