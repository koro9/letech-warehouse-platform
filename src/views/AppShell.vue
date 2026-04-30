<script setup>
import { computed, onMounted } from 'vue'
import { RouterView, RouterLink, useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import Toast from '@/components/Toast.vue'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

// ============================================================
// 路由 chunk 预热
// ============================================================
//
// 痛点：每个 view 都是 () => import()，第一次访问要现下载 chunk，肉眼可感的延迟。
//
// 策略：AppShell 挂载后等浏览器空闲，一次性把所有路由 chunk 拉到浏览器缓存里。
//   后续切菜单全是缓存命中，瞬间渲染，配合 router 的 200ms loading 阈值
//   → 首屏后切换零等待感。
//
// 代价：首屏后会多下 50-80 KB（gzip 后约 20-30 KB）的 view chunk。在 idle 时段
//   进行，不阻塞主线程，用户无感。
//
// 选择直接列在这里而不是从 router.getRoutes() 反推，是因为：
//   1. 显式列表更易审 —— 加了新页面记得加这里，不会忘
//   2. router config 里 component 是 lazy 工厂，调用一次会触发实际 import，
//      在 router init 阶段反推会重复触发
//   3. 维护成本可控 —— 路由不常增减
function prefetchViews() {
  const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500))

  schedule(() => {
    // 用 allSettled 把单个 chunk 加载失败吞掉 —— 后续真访问对应路由时
    // 懒加载会自动重试，不影响主功能
    Promise.allSettled([
      // Dashboard
      import('@/views/dashboard/Dashboard.vue'),
      import('@/views/dashboard/Outbound.vue'),
      import('@/views/dashboard/Shipping.vue'),
      import('@/views/dashboard/Split.vue'),
      import('@/views/dashboard/Labels.vue'),
      import('@/views/dashboard/Orders.vue'),
      import('@/views/dashboard/Inventory.vue'),
      import('@/views/dashboard/Admin.vue'),
      // Receiving
      import('@/views/receiving/Counting.vue'),
      import('@/views/receiving/Allocation.vue'),
      import('@/views/receiving/Transfer.vue'),
      // Query
      import('@/views/query/SmartQuery.vue'),
    ])
  })
}

onMounted(prefetchViews)

// 顶部业务系统 tab
const systems = [
  { key: 'dashboard', label: '📊 Dashboard 系統', home: { name: 'home' } },
  { key: 'receiving', label: '📦 PO 收貨平台',   home: { name: 'receiving-counting' } },
  { key: 'query',     label: '🔍 智能查詢',       home: { name: 'query-home' } },
]

// 每个系统的侧边栏项 — 跟 demo 顺序对齐
// disabled: true 表示页面尚未实现（点击不路由）
// requires: 权限 gate，传给 auth.canAccess —— 不满足时整个项隐藏
const sidebars = {
  dashboard: [
    { name: 'home',      label: '控制台',     icon: '🏠' },
    { name: 'outbound',  label: '出库',       icon: '📤' },
    { name: 'shipping',  label: '面单',       icon: '🖨️' },
    { name: 'split',     label: '拆單',       icon: '✂️' },
    { name: 'labels',    label: '标签',       icon: '🏷️' },
    { name: 'orders',    label: '運單',       icon: '📋' },
    // 库存对比暂时隐藏（路由和组件保留，未来恢复时把这行解开即可）
    // { name: 'inventory', label: '庫存對比',   icon: '📊' },
    { name: 'admin',     label: '管理',       icon: '👥', requires: 'type:internal' },
  ],
  receiving: [
    { name: 'receiving-counting', label: 'PO 點貨',        icon: '📦' },
    { name: 'receiving-alloc',    label: '收貨分配',       icon: '📋' },
    { name: 'receiving-transfer', label: 'Transfer Order', icon: '🚚' },
  ],
  query: [
    { name: 'query-home', label: '智能查詢中心', icon: '🔍' },
  ],
}

const currentSystem = computed(() => route.meta?.system || 'dashboard')
const navItems = computed(() =>
  (sidebars[currentSystem.value] || []).filter(
    item => !item.requires || auth.canAccess(item.requires),
  ),
)

function switchSystem(sys) {
  router.push(sys.home)
}

// auth.logout() 内部按 type 决定走 Odoo /web/session/logout 还是 /login，
// 它会自己 window.location.href 跳转，不需要 router.push
function handleLogout() {
  auth.logout()
}
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- 顶栏 -->
    <header class="h-14 bg-white border-b border-gray-200 px-6 flex items-center flex-shrink-0 shadow-sm z-50">
      <div class="flex items-baseline gap-1 mr-10">
        <span class="text-2xl font-light italic text-gray-700 tracking-wide">LeTech</span>
        <span class="text-[10px] text-gray-400 tracking-widest">make·professional</span>
      </div>

      <div class="flex gap-1">
        <button
          v-for="sys in systems"
          :key="sys.key"
          class="sys-tab"
          :class="{ active: currentSystem === sys.key }"
          @click="switchSystem(sys)"
        >
          {{ sys.label }}
        </button>
      </div>

      <!-- 用户徽标：按身份类型显示不同样式 -->
      <button
        class="ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors"
        :class="auth.isInternal
          ? 'bg-blue-500 text-white hover:bg-blue-600'
          : 'bg-teal text-white hover:bg-teal/90'"
        :title="auth.isInternal ? '点击登出（仅退出 Vue 系统，Odoo session 保留）' : '点击登出（清除登录态，下个员工接班）'"
        @click="handleLogout"
      >
        <span v-if="auth.isInternal">🏢</span>
        <span v-else>🔖</span>
        <span>{{ auth.identity?.name || 'User' }}</span>
        <span class="opacity-60 text-[10px]">·</span>
        <span class="opacity-80">{{ auth.isInternal ? 'Odoo' : '倉庫' }}</span>
        <span class="opacity-70 ml-1">登出</span>
      </button>
    </header>

    <!-- 主体 -->
    <div class="flex-1 flex overflow-hidden">
      <!-- 侧边栏 -->
      <nav class="bg-white border-r border-gray-200 flex flex-col flex-shrink-0 overflow-y-auto pt-2"
           style="width: 200px;">
        <div class="text-[11px] font-bold text-gray-300 px-5 pt-4 pb-2 tracking-widest">
          {{ currentSystem === 'receiving' ? 'PO 收貨' : currentSystem === 'query' ? '查詢工具' : 'MENU' }}
        </div>
        <template v-for="item in navItems" :key="item.name">
          <RouterLink
            v-if="!item.disabled"
            :to="{ name: item.name }"
            class="sb-nav"
            :class="{ active: route.name === item.name }"
          >
            <span class="ni">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </RouterLink>
          <button v-else class="sb-nav opacity-30 cursor-not-allowed" disabled>
            <span class="ni">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </button>
        </template>
      </nav>

      <!-- 内容区 -->
      <!-- KeepAlive 缓存已访问过的页面实例，切换菜单不重建 reactive 树
           :max=10 LRU 上限，超过自动销毁最旧的；user 输入态也跟着保留 -->
      <main class="flex-1 overflow-y-auto bg-gray-100">
        <RouterView v-slot="{ Component }">
          <KeepAlive :max="10">
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </main>
    </div>

    <Toast />
  </div>
</template>
