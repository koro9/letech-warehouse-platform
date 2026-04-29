<script setup>
import { ref } from 'vue'

const props = defineProps({
  onRefresh: { type: Function, required: true },
})

const spinning = ref(false)

async function handleClick() {
  if (spinning.value) return
  spinning.value = true
  try {
    await props.onRefresh()
  } finally {
    // 至少转半圈（300ms），太快闪一下视觉反而像没生效
    setTimeout(() => { spinning.value = false }, 300)
  }
}
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center justify-center w-8 h-8 rounded-md text-gray-400 hover:text-teal hover:bg-gray-100 transition-colors disabled:opacity-50"
    :disabled="spinning"
    title="刷新最新數據"
    @click="handleClick"
  >
    <svg
      class="w-4 h-4"
      :class="{ 'animate-spin': spinning }"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  </button>
</template>
