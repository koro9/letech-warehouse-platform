<script setup>
/**
 * 倉庫作業中心顶部的数字卡片（照仓库需求 PDF 的「先给结论再给明细」）
 *
 * stats: [{ label, value, unit?, tone? }]
 *   tone: 'teal'（默认）| 'amber'（已预留）| 'warn'（未上架等需要注意，整卡变黄）| 'muted'
 */
import { fmtQty } from './shelfRows'

defineProps({
  stats: { type: Array, required: true },
})

const valueColor = {
  teal: 'text-[#2F6B5F]',
  amber: 'text-amber-600',
  warn: 'text-amber-800',
  muted: 'text-gray-400',
}
</script>

<template>
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
    <div
      v-for="s in stats"
      :key="s.label"
      class="rounded-xl border px-4 py-3 lg:px-5 lg:py-4"
      :class="s.tone === 'warn' ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200 shadow-sm'"
    >
      <div class="text-xs lg:text-sm" :class="s.tone === 'warn' ? 'text-amber-800' : 'text-gray-500'">{{ s.label }}</div>
      <div class="mt-1 text-2xl lg:text-3xl font-semibold tabular-nums" :class="valueColor[s.tone || 'teal']">
        {{ typeof s.value === 'number' ? fmtQty(s.value) : s.value }}<span
          v-if="s.unit" class="text-sm font-normal text-gray-400 ml-1">{{ s.unit }}</span>
      </div>
    </div>
  </div>
</template>
