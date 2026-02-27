import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        build: resolve(__dirname, 'build.html'),
        dashboard: resolve(__dirname, 'dashboard.html')
      }
    }
  },
  define: {
    'process.env': {}
  }
});
