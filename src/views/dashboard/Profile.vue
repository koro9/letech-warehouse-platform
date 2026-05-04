<script setup>
/**
 * 个人信息（只读展示）
 *
 * 来源：useAuthStore — 后端 /whoami 拿到的当前登录身份
 *
 * 为什么是只读：
 *   员工资料 / 用户管理一律走 Odoo 后台。这里只是给员工一个"我现在是用谁的身份
 *   登入"的确认面板，不做任何编辑。两类身份字段不同：
 *
 *     internal (Odoo 内部用户)
 *       name / login / user_id / role / avatar
 *
 *     parttime (兼职仓库员工)
 *       name / operator_id / role
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

// 类型 → 展示文案
const typeLabel = computed(() => auth.isInternal ? 'Odoo 內部用戶' : '倉庫員工')
const typeBadge = computed(() => auth.isInternal
  ? 'bg-blue-50 text-blue-700 border-blue-200'
  : 'bg-amber-50 text-amber-700 border-amber-200')

// 身份字段以 identity 为准；avatar 仅 internal 有
const ident = computed(() => auth.identity || {})
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10 max-w-2xl mx-auto sm:mx-0">
    <h2 class="text-lg sm:text-xl font-bold mb-4 sm:mb-6">個人資訊</h2>

    <div class="g-card p-4 sm:p-6">
      <!-- 头像 + 名字：手机竖向，大屏横向 -->
      <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-5 mb-5 sm:mb-6 pb-5 sm:pb-6 border-b border-gray-100">
        <!-- 头像：internal 用 Odoo 头像，parttime 用首字母占位 -->
        <img
          v-if="auth.isInternal && ident.avatar"
          :src="ident.avatar"
          alt="avatar"
          class="w-20 h-20 sm:w-16 sm:h-16 rounded-full object-cover bg-gray-100 flex-shrink-0"
        />
        <div
          v-else
          class="w-20 h-20 sm:w-16 sm:h-16 rounded-full bg-gradient-to-br from-teal-400 to-teal-600 text-white flex items-center justify-center text-3xl sm:text-2xl font-semibold flex-shrink-0"
        >
          {{ (ident.name || '?').charAt(0).toUpperCase() }}
        </div>

        <div class="flex-1 text-center sm:text-left min-w-0">
          <div class="text-lg font-semibold text-gray-800 truncate">{{ ident.name || '—' }}</div>
          <span
            class="inline-block mt-2 px-2.5 py-0.5 text-xs rounded border"
            :class="typeBadge"
          >{{ typeLabel }}</span>
        </div>
      </div>

      <!-- 字段列表：手机上 dt 小字标题在上，dd 内容在下；大屏并排 -->
      <dl class="space-y-3 sm:space-y-3 text-sm">
        <div v-if="auth.isInternal" class="flex flex-col sm:flex-row sm:items-baseline">
          <dt class="text-xs sm:text-sm text-gray-400 sm:w-24 sm:flex-shrink-0 mb-0.5 sm:mb-0">登入帳號</dt>
          <dd class="text-gray-700 font-mono break-all">{{ ident.login || '—' }}</dd>
        </div>
        <div v-if="auth.isInternal" class="flex flex-col sm:flex-row sm:items-baseline">
          <dt class="text-xs sm:text-sm text-gray-400 sm:w-24 sm:flex-shrink-0 mb-0.5 sm:mb-0">User ID</dt>
          <dd class="text-gray-700 font-mono">{{ ident.user_id || '—' }}</dd>
        </div>
        <div v-if="auth.isParttime" class="flex flex-col sm:flex-row sm:items-baseline">
          <dt class="text-xs sm:text-sm text-gray-400 sm:w-24 sm:flex-shrink-0 mb-0.5 sm:mb-0">Operator ID</dt>
          <dd class="text-gray-700 font-mono">{{ ident.operator_id || '—' }}</dd>
        </div>
        <div class="flex flex-col sm:flex-row sm:items-baseline">
          <dt class="text-xs sm:text-sm text-gray-400 sm:w-24 sm:flex-shrink-0 mb-0.5 sm:mb-0">角色</dt>
          <dd class="text-gray-700">{{ ident.role || '—' }}</dd>
        </div>
      </dl>

      <div class="mt-5 sm:mt-6 pt-5 sm:pt-6 border-t border-gray-100 text-xs text-gray-400 leading-relaxed">
        員工資料 / 帳號 / 角色維護請聯絡 Odoo 後台管理員，本頁面僅供確認當前登入身份。
      </div>
    </div>
  </div>
</template>
