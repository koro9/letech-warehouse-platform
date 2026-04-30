<script setup>
import { computed } from 'vue'
import { RouterView, RouterLink, useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import Toast from '@/components/Toast.vue'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

// 顶部业务系统 tab
const systems = [
  { key: 'dashboard', label: '📊 Dashboard 系統', home: { name: 'home' } },
  { key: 'tpl',       label: '🏭 3PL 倉庫平台',   home: { name: 'tpl-home' } },
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
    { name: 'inventory', label: '库存对比',   icon: '📊' },
    { name: 'recon',     label: '对账',       icon: '✅' },
    { name: 'admin',     label: '管理',       icon: '👥', requires: 'type:internal' },
  ],
  tpl: [
    { name: 'tpl-home',      label: '系統首頁',       icon: '🏠' },
    { name: 'tpl-search',    label: '智能查詢中心',   icon: '🔍' },
    { name: 'tpl-inspect',   label: '3PL 貨品檢測',   icon: '📋' },
    { name: 'tpl-yummy',     label: 'Yummy 3PL',      icon: '🍔' },
    { name: 'tpl-anymall',   label: 'Anymall 3PL',    icon: '🛍️' },
    { name: 'tpl-hellobear', label: 'Hello Bear 3PL', icon: '🐻' },
    { name: 'tpl-homey',     label: 'Homey 3PL',      icon: '🏡' },
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
          {{ currentSystem === 'tpl' ? '主選單' : currentSystem === 'receiving' ? 'PO 收貨' : currentSystem === 'query' ? '查詢工具' : 'MENU' }}
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
