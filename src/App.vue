<script setup>
import { RouterView } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import GlobalLoading from '@/components/GlobalLoading.vue'

const auth = useAuthStore()
</script>

<template>
  <!-- bootstrap 期间显示中性 splash，避免登录态判定还没出来时 RouterView 闪一下不该出现的页面 -->
  <div
    v-if="!auth.bootstrapped"
    class="h-full flex items-center justify-center bg-gray-50 text-gray-400 text-sm"
  >
    载入中…
  </div>
  <RouterView v-else />

  <!-- 全局阻塞式 Loading，覆盖所有路由 / 业务调用 -->
  <GlobalLoading />
</template>
