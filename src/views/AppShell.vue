<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
      import('@/views/dashboard/Profile.vue'),
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

// 顶部业务系统 tab — shortLabel 给平板紧凑布局用
const systems = [
  { key: 'dashboard', label: '📤 出貨作業中心', shortLabel: '📤 出貨', home: { name: 'home' } },
  { key: 'receiving', label: '📦 PO 收貨平台',   shortLabel: '📦 收貨', home: { name: 'receiving-alloc' } },
  { key: 'query',     label: '🔍 智能查詢',       shortLabel: '🔍 查詢', home: { name: 'query-home' } },
]

// 每个系统的侧边栏项 — 跟 demo 顺序对齐
// disabled: true 表示页面尚未实现（点击不路由）
// requires: 权限 gate，传给 auth.canAccess —— 不满足时整个项隐藏
const sidebars = {
  dashboard: [
    { name: 'home',      label: '儀表板',     icon: '📊' },
    { name: 'outbound',  label: '出庫',       icon: '📤' },
    { name: 'shipping',  label: '面單',       icon: '🖨️' },
    // 拆單菜单已下线 — 入口改在「運單」列表行末按钮触发（参见 Orders.vue）
    // 路由 /split 暂时保留但已无入口，后续需要彻底删除时一起处理
    // { name: 'split',     label: '拆單',       icon: '✂️' },
    { name: 'labels',    label: '標籤',       icon: '🏷️' },
    { name: 'orders',    label: '運單',       icon: '📋' },
    // 庫存對比暂时隐藏（路由和组件保留，未来恢复时把这行解开即可）
    // { name: 'inventory', label: '庫存對比',   icon: '📊' },
    { name: 'profile',   label: '個人資訊',   icon: '👤' },
    // 用户管理已迁移到 Odoo 后台维护；这里暂时隐藏（路由和 Admin.vue 保留，
    // 未来若 WMS 内部要做轻量用户管理，把这行解开即可）
    // { name: 'admin',     label: '管理',       icon: '👥', requires: 'type:internal' },
  ],
  receiving: [
    // 业务流：分配（plan）→ 點貨（check）→ Transfer（execute），所以收貨分配排第一位
    { name: 'receiving-alloc',    label: '收貨分配',       icon: '📋' },
    { name: 'receiving-counting', label: 'PO 點貨',        icon: '📦' },
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

const sectionTitle = computed(() => {
  if (currentSystem.value === 'receiving') return 'PO 收貨'
  if (currentSystem.value === 'query') return '查詢工具'
  return 'MENU'
})

function switchSystem(sys) {
  router.push(sys.home)
}

// auth.logout() 内部按 type 决定走 Odoo /web/session/logout 还是 /login，
// 它会自己 window.location.href 跳转，不需要 router.push
function handleLogout() {
  auth.logout()
}

// ============================================================
// 移动端抽屉菜单
// ============================================================
const drawerOpen = ref(false)

// 路由切换 → 自动关抽屉（用户点了菜单项就该关）
watch(() => route.fullPath, () => {
  drawerOpen.value = false
})

// Esc 关抽屉
function onKeydown(e) {
  if (e.key === 'Escape' && drawerOpen.value) {
    drawerOpen.value = false
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- ======== 顶栏 ======== -->
    <header
      class="h-14 bg-white border-b border-gray-200 px-3 md:px-6 flex items-center flex-shrink-0 shadow-sm z-50 safe-px"
    >
      <!-- 移动端汉堡按钮（md+ 隐藏） -->
      <button
        class="md:hidden p-2 -ml-2 mr-1 rounded-lg hover:bg-gray-100 transition-colors flex items-center justify-center"
        aria-label="打開選單"
        @click="drawerOpen = true"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>

      <!-- Logo（移动端紧凑：只显示 LeTech；md+ 显示 make·professional 副标） -->
      <div class="flex items-baseline gap-1 mr-3 md:mr-6 lg:mr-10 flex-shrink-0">
        <span class="text-xl md:text-2xl font-light italic text-gray-700 tracking-wide">LeTech</span>
        <span class="hidden md:inline text-[10px] text-gray-400 tracking-widest">make·professional</span>
      </div>

      <!-- 系统 tabs（移动端隐藏 — 在抽屉里；md 用短 label，lg 用全 label） -->
      <div class="hidden md:flex gap-1">
        <button
          v-for="sys in systems"
          :key="sys.key"
          class="sys-tab"
          :class="{ active: currentSystem === sys.key }"
          @click="switchSystem(sys)"
        >
          <span class="hidden lg:inline">{{ sys.label }}</span>
          <span class="lg:hidden">{{ sys.shortLabel }}</span>
        </button>
      </div>

      <!-- 用户徽标：移动端 < sm 只显示 emoji；sm+ 显示名字；md+ 显示完整 -->
      <button
        class="ml-auto flex items-center gap-1.5 px-2 md:px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors flex-shrink-0"
        :class="auth.isInternal
          ? 'bg-blue-500 text-white hover:bg-blue-600'
          : 'bg-teal text-white hover:bg-teal/90'"
        :title="auth.isInternal ? '點擊登出（僅退出 Vue 系統，Odoo session 保留）' : '點擊登出（清除登入態，下個員工接班）'"
        @click="handleLogout"
      >
        <span v-if="auth.isInternal">🏢</span>
        <span v-else>🔖</span>
        <span class="hidden sm:inline truncate max-w-[120px]">{{ auth.identity?.name || 'User' }}</span>
        <span class="hidden md:inline opacity-60 text-[10px]">·</span>
        <span class="hidden md:inline opacity-80">{{ auth.isInternal ? 'Odoo' : '倉庫' }}</span>
        <span class="hidden sm:inline opacity-70 ml-1">登出</span>
      </button>
    </header>

    <!-- ======== 主体 ======== -->
    <div class="flex-1 flex overflow-hidden relative">
      <!-- 桌面/平板侧边栏（移动端隐藏，由抽屉接管） -->
      <!-- md (768-1023): 64px 仅图标；lg+ (≥1024): 200px 图标+文字 -->
      <nav
        class="hidden md:flex bg-white border-r border-gray-200 flex-col flex-shrink-0 overflow-y-auto pt-2 transition-[width] duration-200"
        :class="['w-16 lg:w-[200px]']"
      >
        <div class="hidden lg:block text-[11px] font-bold text-gray-300 px-5 pt-4 pb-2 tracking-widest">
          {{ sectionTitle }}
        </div>
        <template v-for="item in navItems" :key="item.name">
          <RouterLink
            v-if="!item.disabled"
            :to="{ name: item.name }"
            class="sb-nav"
            :class="{ active: route.name === item.name }"
            :title="item.label"
          >
            <span class="ni">{{ item.icon }}</span>
            <span class="hidden lg:inline">{{ item.label }}</span>
          </RouterLink>
          <button v-else class="sb-nav opacity-30 cursor-not-allowed" :title="item.label" disabled>
            <span class="ni">{{ item.icon }}</span>
            <span class="hidden lg:inline">{{ item.label }}</span>
          </button>
        </template>
      </nav>

      <!-- 内容区 -->
      <!-- KeepAlive 缓存已访问过的页面实例，切换菜单不重建 reactive 树
           :max=10 LRU 上限，超过自动销毁最旧的；user 输入态也跟着保留 -->
      <main class="flex-1 overflow-y-auto bg-gray-100 safe-pb">
        <RouterView v-slot="{ Component }">
          <KeepAlive :max="10">
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </main>
    </div>

    <!-- ======== 移动端抽屉（md+ 隐藏） ======== -->
    <Transition name="drawer-bg">
      <div
        v-if="drawerOpen"
        class="md:hidden fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm"
        @click="drawerOpen = false"
      ></div>
    </Transition>
    <Transition name="drawer-slide">
      <nav
        v-if="drawerOpen"
        class="md:hidden fixed left-0 top-0 bottom-0 z-[61] w-[280px] max-w-[85vw] bg-white shadow-2xl flex flex-col safe-pt safe-pb"
        aria-label="主選單"
      >
        <!-- 抽屉顶部：logo + 关闭按钮 -->
        <div class="h-14 flex items-center px-5 border-b border-gray-100 flex-shrink-0">
          <span class="text-xl font-light italic text-gray-700 tracking-wide">LeTech</span>
          <button
            class="ml-auto p-2 -mr-2 rounded-lg hover:bg-gray-100 flex items-center justify-center"
            aria-label="關閉選單"
            @click="drawerOpen = false"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="6" y1="6" x2="18" y2="18"/>
              <line x1="6" y1="18" x2="18" y2="6"/>
            </svg>
          </button>
        </div>

        <!-- 系统切换区 -->
        <div class="p-3 border-b border-gray-100 flex-shrink-0">
          <div class="text-[11px] font-bold text-gray-400 px-2 pb-2 tracking-widest">系統</div>
          <button
            v-for="sys in systems"
            :key="sys.key"
            class="w-full px-3 py-2.5 mb-1 rounded-lg text-left text-sm font-semibold flex items-center transition-colors"
            :class="currentSystem === sys.key
              ? 'bg-teal text-white shadow'
              : 'text-gray-600 hover:bg-gray-50'"
            @click="switchSystem(sys)"
          >
            {{ sys.label }}
          </button>
        </div>

        <!-- 当前系统菜单 -->
        <div class="flex-1 overflow-y-auto py-2">
          <div class="text-[11px] font-bold text-gray-400 px-5 pt-2 pb-2 tracking-widest">
            {{ sectionTitle }}
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
        </div>
      </nav>
    </Transition>

    <Toast />
  </div>
</template>

<style scoped>
/* 抽屉动画 */
.drawer-bg-enter-active,
.drawer-bg-leave-active {
  transition: opacity 0.2s ease;
}
.drawer-bg-enter-from,
.drawer-bg-leave-to {
  opacity: 0;
}

.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(-100%);
}

/* 平板（md，768-1023）侧边栏窄到 64px：sb-nav 居中图标，隐藏 label */
@media (min-width: 768px) and (max-width: 1023px) {
  :deep(.sb-nav) {
    justify-content: center;
    padding: 13px 0;
    gap: 0;
  }
  :deep(.sb-nav .ni) {
    width: auto;
    font-size: 18px;
    margin: 0;
  }
}
</style>
