import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:5000' } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/src/routes/')) return undefined;
          const routeName = id.split(/[\\/]/).pop().replace(/\.jsx$/, '');
          return `route-${routeName}`;
        },
      },
    },
  },
});
