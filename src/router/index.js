import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

/**
 * 路由组织：
 *   - 登录：/login
 *   - AppShell 套壳，路由 meta.system 决定顶部 tab 与侧边栏
 *   - 三大业务系统：dashboard / tpl / receiving
 *
 * 尚未实现的页面（demo 里有但还没移植）暂不注册路由，
 * 在 AppShell 的 sidebars 配置里标 disabled:true（灰显但不可点）。
 */
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
      // ===== Dashboard 系統 =====
      { path: '',           name: 'home',      component: () => import('@/views/dashboard/Dashboard.vue'), meta: { system: 'dashboard' } },
      { path: 'outbound',   name: 'outbound',  component: () => import('@/views/dashboard/Outbound.vue'),  meta: { system: 'dashboard' } },
      { path: 'shipping',   name: 'shipping',  component: () => import('@/views/dashboard/Shipping.vue'),  meta: { system: 'dashboard' } },
      { path: 'split',      name: 'split',     component: () => import('@/views/dashboard/Split.vue'),     meta: { system: 'dashboard' } },
      { path: 'labels',     name: 'labels',    component: () => import('@/views/dashboard/Labels.vue'),    meta: { system: 'dashboard' } },
      { path: 'orders',     name: 'orders',    component: () => import('@/views/dashboard/Orders.vue'),    meta: { system: 'dashboard' } },
      { path: 'inventory',  name: 'inventory', component: () => import('@/views/dashboard/Inventory.vue'), meta: { system: 'dashboard' } },
      { path: 'recon',      name: 'recon',     component: () => import('@/views/dashboard/Recon.vue'),     meta: { system: 'dashboard' } },
      { path: 'profile',    name: 'profile',   component: () => import('@/views/dashboard/Profile.vue'),   meta: { system: 'dashboard' } },
      { path: 'admin',      name: 'admin',     component: () => import('@/views/dashboard/Admin.vue'),     meta: { system: 'dashboard' } },

      // ===== 3PL 倉庫平台 =====
      { path: 'tpl',           name: 'tpl-home',      component: () => import('@/views/tpl/Home.vue'),      meta: { system: 'tpl' } },
      { path: 'tpl/search',    name: 'tpl-search',    component: () => import('@/views/tpl/Search.vue'),    meta: { system: 'tpl' } },
      { path: 'tpl/inspect',   name: 'tpl-inspect',   component: () => import('@/views/tpl/Inspect.vue'),   meta: { system: 'tpl' } },
      { path: 'tpl/yummy',     name: 'tpl-yummy',     component: () => import('@/views/tpl/Yummy.vue'),     meta: { system: 'tpl' } },
      { path: 'tpl/anymall',   name: 'tpl-anymall',   component: () => import('@/views/tpl/Anymall.vue'),   meta: { system: 'tpl' } },
      { path: 'tpl/hellobear', name: 'tpl-hellobear', component: () => import('@/views/tpl/HelloBear.vue'), meta: { system: 'tpl' } },
      { path: 'tpl/homey',     name: 'tpl-homey',     component: () => import('@/views/tpl/Homey.vue'),     meta: { system: 'tpl' } },

      // ===== PO 收貨平台 =====
      { path: 'receiving',          name: 'receiving-counting', component: () => import('@/views/receiving/Counting.vue'),   meta: { system: 'receiving' } },
      { path: 'receiving/alloc',    name: 'receiving-alloc',    component: () => import('@/views/receiving/Allocation.vue'), meta: { system: 'receiving' } },
      { path: 'receiving/transfer', name: 'receiving-transfer', component: () => import('@/views/receiving/Transfer.vue'),   meta: { system: 'receiving' } },

      // ===== 智能查詢（DEAR 直连查询工具） =====
      { path: 'query', name: 'query-home', component: () => import('@/views/query/SmartQuery.vue'), meta: { system: 'query' } },
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
