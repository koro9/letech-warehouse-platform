<script setup>
/**
 * 用户管理 — 复刻 demo s1-admin
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
  <div class="p-10">
    <h2 class="text-xl font-bold mb-5">用户管理</h2>
    <button class="g-btn g-btn-teal mb-5" @click="addUser">
      <span class="text-base">＋</span> 增加用户
    </button>
    <div class="g-card overflow-hidden">
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
  </div>
</template>
