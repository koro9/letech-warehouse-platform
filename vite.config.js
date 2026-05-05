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
          // Odoo 后端 _check_csrf 会校验 Origin 跟 web.base.url 同源；
          // 浏览器从 localhost:5173 发出的 Origin 不匹配 Odoo 的 base_url
          // (一般是 localhost:8069)，会被挡 403 cross_origin_rejected。
          // 这里把 Origin 改写成 target，让 dev 里跟生产同源行为一致。
          configure: (proxy) => {
            const target = env.VITE_DEV_API_TARGET || 'http://localhost:8069'
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Origin', target)
            })
          },
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
