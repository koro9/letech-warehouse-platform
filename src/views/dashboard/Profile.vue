<script setup>
/**
 * 个人信息 — 复刻 demo s1-profile
 */
import { useAuthStore } from '@/stores/auth'
import { showToast } from '@/composables/useToast'

const auth = useAuthStore()
const email = auth.employeeName || 'tommy.liu@letech.com.hk'

function edit() { showToast('修改成功', 'success') }
</script>

<template>
  <div class="p-10">
    <h2 class="text-xl font-bold mb-6">个人设置</h2>
    <div class="g-card max-w-md p-7">
      <div class="mb-4">
        <div class="text-xs font-bold text-gray-600 mb-1.5">Email</div>
        <div class="text-[15px]">{{ email }}</div>
      </div>
      <button class="g-btn g-btn-teal" @click="edit">修改</button>
    </div>
  </div>
</template>
