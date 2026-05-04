import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useGlobalLoading } from '@/composables/useGlobalLoading'

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
      // 库存对比暂时菜单隐藏；路由保留，未来想恢复直接放开侧边栏 nav 即可
      { path: 'inventory',  name: 'inventory', component: () => import('@/views/dashboard/Inventory.vue'), meta: { system: 'dashboard' } },
      // 个人信息（只读展示当前登入身份）— 取代了原来的 admin 菜单位置
      { path: 'profile',    name: 'profile',   component: () => import('@/views/dashboard/Profile.vue'),   meta: { system: 'dashboard' } },
      // 用户管理 Admin 已菜单隐藏（迁移到 Odoo 后台维护），路由保留
      { path: 'admin',      name: 'admin',     component: () => import('@/views/dashboard/Admin.vue'),     meta: { system: 'dashboard', requires: 'type:internal' } },

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

// ============================================================
// 路由切换 loading 遮罩
// ============================================================
//
// 痛点：每个 view 都是 () => import(...)，第一次访问要下载对应 chunk JS，
//       网速一般时肉眼可感的卡顿，用户怀疑"是不是没点中"会反复点。
//
// 设计：beforeEach 启动 200ms 倒计时，超时才显示遮罩。
//       - KeepAlive cached 的页面切换 < 50ms，timer 来不及触发，**不闪烁**
//       - 首次加载 chunk 通常 > 200ms，遮罩按时出现给用户视觉反馈
//       - 路由解析完 (afterEach) 立即清 timer 或 hide
//
// 200ms 是业界常见阈值（人感知"瞬间"的边界 100-200ms），低于这个值
// 用户不会觉得卡，所以也不需要遮罩；高于就需要反馈了。
let pendingTimer = null
let loadingShown = false

function clearRouteLoading() {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  if (loadingShown) {
    useGlobalLoading().hide()
    loadingShown = false
  }
}

router.beforeEach(() => {
  // 用户连点：上一次导航还没结束就开始新的导航。先把上次的 loading 状态清掉，
  // 避免 useGlobalLoading 的 depth 计数累加导致 hide 一次后遮罩还在
  clearRouteLoading()
  pendingTimer = setTimeout(() => {
    useGlobalLoading().show()
    loadingShown = true
    pendingTimer = null
  }, 200)
})

router.afterEach(clearRouteLoading)
// chunk 加载失败 / 导航被中断也要清，否则遮罩会卡住
router.onError(clearRouteLoading)

// ============================================================
// 路由权限守卫
// ============================================================
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
