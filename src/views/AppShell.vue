<script setup>
import { RouterView, RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()

const navItems = [
  { to: { name: 'home' }, label: '控制台', icon: '🏠' },
  { to: { name: 'outbound' }, label: '出库', icon: '📤' },
  // 未来页面：面单 / 拆单 / 标签 / 订单 / 库存 / 对账 ...
]

function handleLogout() {
  auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- 顶栏 -->
    <header class="h-14 bg-white border-b border-gray-200 px-6 flex items-center flex-shrink-0 shadow-sm">
      <div class="flex items-baseline gap-1 mr-10">
        <span class="text-2xl font-light italic text-gray-700 tracking-wide">LeTech</span>
        <span class="text-[10px] text-gray-400 tracking-widest">WAREHOUSE</span>
      </div>
      <button class="ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-teal text-white text-xs font-semibold"
              @click="handleLogout">
        <span>👤</span>
        <span>{{ auth.employeeName || '未登录' }}</span>
        <span class="opacity-70">登出</span>
      </button>
    </header>

    <!-- 主体 -->
    <div class="flex-1 flex overflow-hidden">
      <!-- 侧边栏 -->
      <nav class="w-50 bg-white border-r border-gray-200 flex flex-col flex-shrink-0 overflow-y-auto pt-2"
           style="width: 200px;">
        <div class="text-[11px] font-bold text-gray-300 px-5 pt-4 pb-2 tracking-widest">
          MENU
        </div>
        <RouterLink
          v-for="item in navItems"
          :key="item.label"
          :to="item.to"
          class="flex items-center gap-3 px-5 py-3 text-sm text-gray-600 border-l-[3px] border-transparent transition-colors hover:bg-gray-50"
          active-class="!border-teal !text-teal !font-bold !bg-gradient-to-r from-teal/10 to-transparent"
        >
          <span class="w-5 text-center">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <!-- 内容区 -->
      <main class="flex-1 overflow-y-auto bg-gray-100">
        <RouterView />
      </main>
    </div>
  </div>
</template>
