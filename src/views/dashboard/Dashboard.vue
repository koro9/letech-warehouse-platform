<script setup>
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const greeting = computed(() => auth.employeeName || 'tommy.liu@letech.com.hk')

// KPI 数字 — 跟 demo 一比一硬编码（后续接 API 替换）
const kpis = [
  { label: '扫描出库', current: 87,  total: 199 },
  { label: '今日打印', current: 448, total: 456 },
  { label: '明日打印', current: 745, total: 782 },
]
</script>

<template>
  <div class="p-10">
    <div class="mb-8">
      <h2 class="text-2xl font-light text-gray-700">Hi, {{ greeting }} 👋🏼</h2>
      <p class="text-gray-400 text-sm mt-0.5">Welcome back!</p>
    </div>

    <div class="grid grid-cols-3 gap-5 max-w-4xl">
      <div v-for="kpi in kpis" :key="kpi.label" class="g-card px-6 py-7">
        <div class="text-base font-bold mb-3">{{ kpi.label }}</div>
        <div class="text-3xl font-light">
          {{ kpi.current }}<span class="text-gray-300">/</span>{{ kpi.total }}
        </div>
      </div>
    </div>
  </div>
</template>
