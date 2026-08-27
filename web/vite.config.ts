import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4321',
      '/media': 'http://localhost:4321',
      '/opds': 'http://localhost:4321',
      '/ws': {
        target: 'ws://localhost:4321',
        ws: true,
      },
    },
  },
})
