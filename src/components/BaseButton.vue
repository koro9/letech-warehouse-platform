<script setup>
defineProps({
  variant: {
    type: String,
    default: 'teal', // teal | pink | green | blue
  },
  loading: Boolean,
  disabled: Boolean,
})
</script>

<template>
  <button
    :class="['g-btn', `g-btn-${variant}`, { 'opacity-50 cursor-not-allowed': disabled || loading }]"
    :disabled="disabled || loading"
  >
    <span v-if="loading" class="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
    <slot />
  </button>
</template>
