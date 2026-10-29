import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@sanctum/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
    },
  },
  define: {
    __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? 'dev'),
  },
  build: {
    outDir: 'build',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split rarely-changing vendor code into long-cached chunks so
        // day-to-day deploys only invalidate the app chunk.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          markdown: ['marked', 'dompurify'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3099',
        changeOrigin: true,
      },
      // Household mode: a companion is served at /c/<id>/ (api, ws and server-issued URLs such as /c/<id>/api/files/<id>). The page itself
      // (a navigation to /c/<id>/) stays with Vite's SPA fallback; everything else under /c goes to the backend.
      '^/c/': {
        target: 'http://127.0.0.1:3099',
        changeOrigin: true,
        ws: true,
        bypass: (req) => (/^\/c\/[^/]+\/api\//.test(req.url ?? '') ? undefined : req.headers.accept?.includes('text/html') ? '/index.html' : undefined),
      },
      '/ws': {
        target: 'ws://127.0.0.1:3099',
        ws: true,
      },
    },
  },
});
