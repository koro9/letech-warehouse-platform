<script setup>
import { useGlobalLoading } from '@/composables/useGlobalLoading'

const { visible, message } = useGlobalLoading()
</script>

<template>
  <Transition name="loading-fade">
    <div
      v-if="visible"
      class="fixed inset-0 z-[10000] flex flex-col items-center justify-center"
      style="background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(2px);"
    >
      <!-- 白色圆圈 spinner — 借 Tailwind animate-spin -->
      <div
        class="w-12 h-12 rounded-full border-4 border-white/30 border-t-white animate-spin"
        aria-hidden="true"
      ></div>
      <div
        v-if="message"
        class="mt-5 text-white text-sm font-medium tracking-wider"
      >
        {{ message }}
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.loading-fade-enter-active,
.loading-fade-leave-active {
  transition: opacity 0.2s ease;
}
.loading-fade-enter-from,
.loading-fade-leave-to {
  opacity: 0;
}
</style>
