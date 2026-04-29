<script setup>
import { useToast } from '@/composables/useToast'
const { current } = useToast()
</script>

<template>
  <Transition name="toast">
    <div v-if="current" class="shared-toast" :class="current.type">
      {{ current.message }}
    </div>
  </Transition>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active { transition: transform .3s, opacity .3s; }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translate(-50%, 20px); }
</style>
