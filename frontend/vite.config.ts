import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
  },
  build: {
    sourcemap: false,
    // Split heavy, rarely-changing libraries into their own chunks so a normal app deploy
    // does not invalidate the entire bundle in users' browser cache. Reduces the surface
    // for "stale chunk MIME error" after a redeploy.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor';
          }
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) {
            return 'query-vendor';
          }
          if (/[\\/]node_modules[\\/](lucide-react|sonner)[\\/]/.test(id)) {
            return 'ui-vendor';
          }
          return undefined;
        },
      },
    },
    // Avoid noisy warnings about code-split bundles being above the default 500 kB cap.
    chunkSizeWarningLimit: 1200,
  },
});
