import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // SDKs have few dependencies, so they are bundled. plugin-vite leaves out electron and the Node built-ins
      external: [],
    },
  },
});
