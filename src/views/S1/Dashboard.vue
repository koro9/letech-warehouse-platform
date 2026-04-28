<script setup>
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

// TODO: 接入 /api/warehouse/dashboard
const stats = [
  { label: '扫描出库', current: 87, total: 199 },
  { label: '今日打印', current: 448, total: 456 },
  { label: '明日打印', current: 745, total: 782 },
]
</script>

<template>
  <div class="p-10">
    <div class="mb-8">
      <h2 class="text-2xl font-light text-gray-800">
        Hi, {{ auth.employeeName }} 👋🏼
      </h2>
      <p class="text-sm text-gray-400 mt-0.5">Welcome back!</p>
    </div>

    <div class="grid grid-cols-3 gap-5 max-w-4xl">
      <div v-for="s in stats" :key="s.label" class="g-card p-7">
        <div class="text-base font-bold mb-3">{{ s.label }}</div>
        <div class="text-3xl font-light">
          {{ s.current }}<span class="text-gray-300">/</span>{{ s.total }}
        </div>
      </div>
    </div>
  </div>
</template>
