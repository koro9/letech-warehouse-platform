<script setup>
/**
 * 3PL 倉庫平台 系統首頁 — 复刻 demo s2-home
 * 卡片网格，点击进入对应子模块
 */
import { useRouter } from 'vue-router'

const router = useRouter()

const services = [
  { icon: '🔍', label: '智能查詢',     name: 'tpl-search' },
  { icon: '📋', label: '貨品檢測',     name: 'tpl-inspect' },
  { icon: '🍔', label: 'Yummy 3PL',    name: 'tpl-yummy' },
  { icon: '🛍️', label: 'Anymall 3PL',  name: 'tpl-anymall' },
  { icon: '🐻', label: 'Hello Bear 3PL', name: 'tpl-hellobear' },
  { icon: '🏡', label: 'Homey 3PL',    name: 'tpl-homey' },
]
</script>

<template>
  <div class="text-center py-16 px-5">
    <div class="text-6xl mb-4">🏭</div>
    <h1 class="text-3xl font-bold text-slate-800 mb-2">3PL 倉庫平台</h1>
    <p class="text-sm text-slate-400 mb-10">歡迎使用 LeTech 3PL 倉庫管理系統</p>

    <div class="grid grid-cols-3 gap-5 max-w-2xl mx-auto">
      <div
        v-for="s in services"
        :key="s.name"
        class="g-card p-6 text-center cursor-pointer hover:-translate-y-px transition-transform"
        @click="router.push({ name: s.name })"
      >
        <div class="text-3xl mb-2">{{ s.icon }}</div>
        <div class="text-sm font-semibold">{{ s.label }}</div>
      </div>
    </div>
  </div>
</template>
