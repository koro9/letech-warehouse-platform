import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('@/views/AppShell.vue'),
    children: [
      {
        path: '',
        name: 'home',
        component: () => import('@/views/S1/Dashboard.vue'),
      },
      {
        path: 'outbound',
        name: 'outbound',
        component: () => import('@/views/S1/Outbound.vue'),
      },
      // 未来加更多页面：面单 / 拆单 / 标签 / 订单 / S2 / S3
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL || '/'),
  routes,
})

// 全局守卫：未登录跳 /login
router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!to.meta.public && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.name === 'login' && auth.isLoggedIn) {
    return { name: 'home' }
  }
})

export default router
