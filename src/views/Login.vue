<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useGlobalLoading } from '@/composables/useGlobalLoading'

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

// 兼职员工：扫胸牌条码
async function onSubmit() {
  if (!barcode.value.trim()) return
  loading.value = true
  error.value = ''
  try {
    await useGlobalLoading().run(
      () => auth.loginByBadge(barcode.value.trim()),
      '登入中...',
    )
    const redirect = route.query.redirect || { name: 'home' }
    router.replace(redirect)
  } catch (err) {
    // 401/403/409 已被 http.js 拦截器以 toast 显示了，本地不再重复提示
    if (!err.handledByInterceptor) {
      error.value = err.response?.data?.error || '员工编号无效，请联系主管'
    }
    barcode.value = ''
    inputEl.value?.focus()
  } finally {
    loading.value = false
  }
}

// 内部 Odoo 用户：
//   - 浏览器已有 Odoo cookie → 直接 claim 进系统
//   - 没 cookie → loginByOdoo 内部跳到 Odoo /web/login（页面会卸载，遮罩自然消失）
async function onOdooLogin() {
  await useGlobalLoading().run(() => auth.loginByOdoo(), '登入中...')
  if (auth.isLoggedIn) {
    const redirect = route.query.redirect || { name: 'home' }
    router.replace(redirect)
  }
}
</script>

<template>
  <div class="h-full flex flex-col items-center justify-center bg-gray-50 px-6">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <div class="text-3xl mb-2">📦</div>
        <h1 class="text-2xl font-light text-gray-800">LeTech Warehouse</h1>
        <p class="text-sm text-gray-400 mt-1">兼职员工扫胸牌登录</p>
      </div>

      <!-- 兼职员工：扫胸牌 -->
      <form @submit.prevent="onSubmit" class="g-card p-6 space-y-4">
        <input
          ref="inputEl"
          v-model="barcode"
          type="text"
          class="g-input w-full text-center text-lg font-mono tracking-wider"
          placeholder="WMSXXXXXXXX"
          autocomplete="off"
          :disabled="loading"
        />
        <button type="submit" class="g-btn g-btn-teal w-full py-3" :disabled="loading">
          <span v-if="loading">登录中...</span>
          <span v-else>登 录</span>
        </button>
        <p v-if="error" class="text-sm text-red-500 text-center">{{ error }}</p>
      </form>

      <!-- 分隔 -->
      <div class="flex items-center gap-3 my-5 text-xs text-gray-400">
        <div class="flex-1 h-px bg-gray-200"></div>
        <span>或</span>
        <div class="flex-1 h-px bg-gray-200"></div>
      </div>

      <!-- 内部 Odoo 用户：claim 当前 Odoo session，没有就跳 Odoo 登录 -->
      <button
        type="button"
        class="w-full py-3 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm font-semibold hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
        @click="onOdooLogin"
      >
        🏢 使用 Odoo 账号登录
      </button>
      <p class="text-center text-[11px] text-gray-400 mt-2">
        通常内部员工从 Odoo 菜单进入此系统，不需要走这里
      </p>

      <p class="text-center text-xs text-gray-400 mt-6">
        v{{ '0.1.0' }} · 不知道编号？联系主管
      </p>
    </div>
  </div>
</template>
