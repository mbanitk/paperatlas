import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const gatewayPort = process.env.PAPERATLAS_GATEWAY_PORT || '8100'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.PAPERATLAS_WEB_PORT || 5173),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${gatewayPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
})
