import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

/**
 * 路由组织：
 *   - 登录：/login
 *   - AppShell 套壳，路由 meta.system 决定顶部 tab 与侧边栏
 *   - meta.requires 用于权限 gate（参见 auth.canAccess）：
 *       'type:internal' / 'role:warehouse_admin' / 'any' / 不设
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
      // 用户管理只给内部用户（兼职员工不应能看），Odoo 那边角色定好后改成 'role:warehouse_admin'
      { path: 'admin',      name: 'admin',     component: () => import('@/views/dashboard/Admin.vue'),     meta: { system: 'dashboard', requires: 'type:internal' } },

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

      // ===== 智能查詢（直连 Odoo 庫存） =====
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

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // 首次进任何路由前，先让后端识别身份
  if (!auth.bootstrapped) {
    await auth.bootstrap()
  }

  // 公共页面（如 /login）
  if (to.meta.public) {
    if (to.name === 'login' && auth.isLoggedIn) return { name: 'home' }
    return true
  }

  // 受保护路由：需要登录
  if (!auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  // 受保护路由：需要特定角色 / 类型
  if (to.meta.requires && !auth.canAccess(to.meta.requires)) {
    return { name: 'home' }
  }
})

export default router
