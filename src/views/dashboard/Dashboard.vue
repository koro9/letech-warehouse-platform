<script setup>
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
// 之前用旧 API auth.employeeName（已废弃，重构后没人改这里），改成新的 identity.name
const greeting = computed(() => auth.identity?.name || 'User')

// KPI 数字 — 跟 demo 一比一硬编码（后续接 API 替换）
const kpis = [
  { label: '掃描出庫', current: 87,  total: 199 },
  { label: '今日打印', current: 448, total: 456 },
  { label: '明日打印', current: 745, total: 782 },
]
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <div class="mb-6 sm:mb-8">
      <h2 class="text-xl sm:text-2xl font-light text-gray-700">Hi, {{ greeting }} 👋🏼</h2>
      <p class="text-gray-400 text-xs sm:text-sm mt-0.5">Welcome back!</p>
    </div>

    <!-- KPI 网格：手机 1 列、平板 3 列横向并排 -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5 max-w-4xl">
      <div v-for="kpi in kpis" :key="kpi.label" class="g-card px-5 sm:px-6 py-5 sm:py-7">
        <div class="text-sm sm:text-base font-bold mb-2 sm:mb-3 text-gray-700">{{ kpi.label }}</div>
        <div class="text-2xl sm:text-3xl font-light">
          {{ kpi.current }}<span class="text-gray-300">/</span>{{ kpi.total }}
        </div>
      </div>
    </div>
  </div>
</template>
