import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/studio/',
  server: {
    proxy: Object.fromEntries(['/API', '/View', '/Output'].map(path => [path, {
      target: 'http://127.0.0.1:7801', changeOrigin: true, ws: true,
    }])),
  },
});
