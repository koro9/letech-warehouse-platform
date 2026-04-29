<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const barcode = ref('')
const error = ref('')
const loading = ref(false)
const inputEl = ref(null)

onMounted(async () => {
  await nextTick()
  inputEl.value?.focus()
})

// TODO(dev-only): 后端就绪后删除此函数 + 模板里的"免登入"按钮
function devSkipLogin() {
  auth.devLogin()
  router.replace({ name: 'home' })
}

async function onSubmit() {
  if (!barcode.value.trim()) return
  loading.value = true
  error.value = ''
  try {
    await auth.login(barcode.value.trim())
    const redirect = route.query.redirect || { name: 'home' }
    router.replace(redirect)
  } catch (err) {
    error.value = err.response?.data?.error || '员工编号无效，请联系主管'
    barcode.value = ''
    inputEl.value?.focus()
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="h-full flex flex-col items-center justify-center bg-gray-50 px-6">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <div class="text-3xl mb-2">📦</div>
        <h1 class="text-2xl font-light text-gray-800">LeTech Warehouse</h1>
        <p class="text-sm text-gray-400 mt-1">扫描胸牌条码登录</p>
      </div>

      <form @submit.prevent="onSubmit" class="g-card p-6 space-y-4">
        <input
          ref="inputEl"
          v-model="barcode"
          type="text"
          class="g-input w-full text-center text-lg font-mono tracking-wider"
          placeholder="EMP-XXXX"
          autocomplete="off"
          :disabled="loading"
        />
        <button type="submit" class="g-btn g-btn-teal w-full py-3" :disabled="loading">
          <span v-if="loading">登录中...</span>
          <span v-else>登 录</span>
        </button>
        <p v-if="error" class="text-sm text-red-500 text-center">{{ error }}</p>
      </form>

      <!-- TODO(dev-only): 后端 letech_warehouse_api 上线后整段删除 -->
      <button
        type="button"
        class="w-full mt-3 py-2 text-xs text-amber-700 border border-dashed border-amber-300 rounded-lg bg-amber-50 hover:bg-amber-100 transition-colors"
        @click="devSkipLogin"
      >
        🚧 免登入（开发用，正式上线移除）
      </button>

      <p class="text-center text-xs text-gray-400 mt-6">
        v{{ '0.1.0' }} · 不知道编号？联系主管
      </p>
    </div>
  </div>
</template>
