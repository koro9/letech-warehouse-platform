import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { auth as authApi } from '@/api'

/**
 * 鉴权 Store —— 员工胸牌扫码登录
 *
 * 流程：
 *   1. 兼职员工用扫码枪扫胸牌条码
 *   2. 调 POST /api/warehouse/login → 拿 token + employee_id + name
 *   3. 存 localStorage（持久化），后续 API 自动带 token
 *   4. 操作员 ID 通过 token 由后端解析，前端只展示用
 */
export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('warehouse_token') || '')
  const employeeId = ref(Number(localStorage.getItem('employee_id')) || 0)
  const employeeName = ref(localStorage.getItem('employee_name') || '')

  const isLoggedIn = computed(() => !!token.value)

  async function login(barcode) {
    const data = await authApi.login(barcode)
    token.value = data.token
    employeeId.value = data.employee_id
    employeeName.value = data.employee_name
    localStorage.setItem('warehouse_token', data.token)
    localStorage.setItem('employee_id', String(data.employee_id))
    localStorage.setItem('employee_name', data.employee_name)
    return data
  }

  // TODO(dev-only): 临时免登 — 后端 letech_warehouse_api 上线后删除此函数 + Login.vue 的"免登入"按钮
  function devLogin() {
    token.value = 'dev-token'
    employeeId.value = 999
    employeeName.value = 'Dev'
    localStorage.setItem('warehouse_token', 'dev-token')
    localStorage.setItem('employee_id', '999')
    localStorage.setItem('employee_name', 'Dev')
  }

  function logout() {
    token.value = ''
    employeeId.value = 0
    employeeName.value = ''
    localStorage.removeItem('warehouse_token')
    localStorage.removeItem('employee_id')
    localStorage.removeItem('employee_name')
  }

  return { token, employeeId, employeeName, isLoggedIn, login, logout, devLogin }
})
