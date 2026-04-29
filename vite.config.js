import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    // 生产部署在 Odoo 同域的 /warehouse/ 下，所有内部路由 / asset 都带这个前缀；
    // dev server 直接挂在 localhost:5173/，不带前缀
    // 想自定义可以在 .env 里设 VITE_BASE_PATH
    base: env.VITE_BASE_PATH || (command === 'build' ? '/warehouse/' : '/'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      // 本地开发时把 /api 直接代理到 Odoo，避免 CORS
      proxy: {
        '/api': {
          target: env.VITE_DEV_API_TARGET || 'http://localhost:8069',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      // 拆 chunk，便于 nginx 缓存
      rollupOptions: {
        output: {
          manualChunks: {
            'vue-vendor': ['vue', 'vue-router', 'pinia'],
          },
        },
      },
    },
  }
})
