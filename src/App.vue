<script setup>
import { RouterView } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

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
</template>
