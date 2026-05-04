<script setup>
/**
 * 用户管理 — 复刻 demo s1-admin
 *
 * 注：本菜单已在 AppShell 隐藏（用户管理迁移到 Odoo 后台维护）。
 *     文件保留是因为路由仍在；如果半年内确认不用再彻底删。
 */
import { ref } from 'vue'
import { showToast } from '@/composables/useToast'

const users = ref([
  { name: 'N/A',   email: 'tommy.liu@letech.com.hk', role: 'Superuser', isYou: true },
  { name: 'ethen', email: 'ethen.li@letech.com.hk',  role: 'Superuser' },
  { name: 'janet', email: 'janet.jiang@letech.com.hk', role: 'User' },
])

function addUser() { showToast('新增用戶', 'success') }
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <h2 class="text-lg sm:text-xl font-bold mb-4 sm:mb-5">用戶管理</h2>
    <button class="g-btn g-btn-teal mb-4 sm:mb-5" @click="addUser">
      <span class="text-base">＋</span> 增加用戶
    </button>
    <!-- 桌面表格 -->
    <div class="hidden md:block g-card overflow-hidden">
      <table class="g-table">
        <thead>
          <tr>
            <th>Full name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.email">
            <td class="font-semibold">
              {{ u.name }}
              <span v-if="u.isYou" class="bg-gray-100 px-2 py-0.5 rounded text-[10px] text-gray-500 ml-1">You</span>
            </td>
            <td class="text-gray-600">{{ u.email }}</td>
            <td>{{ u.role }}</td>
            <td><span class="text-emerald-600 font-semibold">Active</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    <!-- 手机卡片列表 -->
    <div class="md:hidden space-y-2">
      <div v-for="u in users" :key="u.email" class="g-card p-3">
        <div class="flex items-start justify-between gap-2 mb-1.5">
          <div class="flex-1 min-w-0 flex items-center gap-2">
            <span class="font-semibold truncate">{{ u.name }}</span>
            <span v-if="u.isYou" class="bg-gray-100 px-1.5 py-0.5 rounded text-[10px] text-gray-500 flex-shrink-0">You</span>
          </div>
          <span class="text-emerald-600 font-semibold text-xs flex-shrink-0">● Active</span>
        </div>
        <div class="text-xs text-gray-600 break-all">{{ u.email }}</div>
        <div class="text-xs text-gray-500 mt-1">Role：<span class="text-gray-700">{{ u.role }}</span></div>
      </div>
    </div>
  </div>
</template>
