import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: 'web',
  plugins: [
    {
      name: 'sonner-csp-nonce',
      enforce: 'pre',
      transform(code, id) {
        if (!/sonner[\\/]dist[\\/]index\.mjs$/.test(id)) return
        // Sonner 在模块加载时注入样式，必须先使用当前页面的受信任 nonce。
        const marker = "style.type = 'text/css'"
        if (!code.includes(marker)) throw new Error('Sonner 样式入口已变化，请检查 CSP 兼容处理')
        return code.replace(
          marker,
          `${marker}\n  style.nonce = document.querySelector('meta[name="csp-nonce"]')?.content || ''`,
        )
      },
    },
    react(),
    tailwindcss(),
  ],
  optimizeDeps: { exclude: ['sonner'] },
  resolve: { alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) } },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8080', '/install': 'http://127.0.0.1:8080' } },
})
