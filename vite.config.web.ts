import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const rootDir = resolve(__dirname)

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(rootDir, 'src/renderer/src'),
      '@': resolve(rootDir, 'src/renderer/src')
    }
  },
  build: {
    outDir: resolve(rootDir, 'dist/webui'),
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
})
