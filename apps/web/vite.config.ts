import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相对路径：同一份构建产物可以放在任意子路径下（GitHub Pages、静态预览）
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  server: { port: 5173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
