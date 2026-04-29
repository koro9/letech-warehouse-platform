import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { auth as authApi } from '@/api'

/**
 * 鉴权 Store —— 区分两类用户
 *
 *   internal (Odoo 内部用户)
 *     - 从 Odoo 菜单跳过来，已有 Odoo session cookie
 *     - API 调用自动带 cookie，后端按 cookie 识别
 *     - 登出 = 跳 Odoo /web/session/logout 真踢 session
 *
 *   parttime (兼职员工)
 *     - 在 /login 扫胸牌
 *     - 后端发 JWT（有效期约 10 小时 = 一个班次）
 *     - JWT 存 localStorage，axios 自动加 Authorization
 *     - 登出 = 通知后端 + 清本地 → 跳 /login（适配多人轮流用同一台机器）
 *
 * 真实身份永远以后端 /whoami 为准，不在前端判断。
 */

const ODOO_LOGIN_URL  = '/web/login?redirect=%2Fwarehouse%2F'
const ODOO_LOGOUT_URL = '/web/session/logout?redirect=%2Fwarehouse%2F'

const LS_TOKEN     = 'warehouse_token'
const LS_DEV_IDENT = 'wh_dev_identity'    // 仅 devLogin 使用

export const useAuthStore = defineStore('auth', () => {
  const type        = ref(null)    // 'internal' | 'parttime' | null
  const identity    = ref(null)    // { name, user_id?, operator_id?, role?, avatar? }
  const token       = ref(localStorage.getItem(LS_TOKEN) || '')
  const bootstrapped = ref(false)  // bootstrap 是否完成（防止 router 提前判定）

  const isLoggedIn  = computed(() => type.value !== null)
  const isInternal  = computed(() => type.value === 'internal')
  const isParttime  = computed(() => type.value === 'parttime')

  /**
   * 启动时 / 刷新时调用：拿后端识别身份
   * 失败 → 清状态（视为未登录）
   */
  async function bootstrap() {
    try {
      const data = await authApi.whoami()
      type.value = data.type
      identity.value = {
        name:        data.name,
        user_id:     data.user_id,
        operator_id: data.operator_id,
        role:        data.role,
        avatar:      data.avatar,
      }
    } catch {
      // 后端 401 / 后端未就绪 — 看是否有 dev 持久化身份
      const dev = loadDevIdentity()
      if (dev) {
        type.value = dev.type
        identity.value = dev.identity
        if (dev.type === 'parttime' && !token.value) {
          token.value = 'dev-token'
          localStorage.setItem(LS_TOKEN, 'dev-token')
        }
      } else {
        resetState()
      }
    } finally {
      bootstrapped.value = true
    }
  }

  /** 兼职员工：扫胸牌登录 */
  async function loginByBadge(barcode) {
    const data = await authApi.loginByBadge(barcode)
    token.value = data.token
    localStorage.setItem(LS_TOKEN, data.token)
    // 拿到 token 之后立即 bootstrap 同步 identity（也避免后端两套接口数据形状不一致）
    await bootstrap()
  }

  /** 内部用户：跳 Odoo 登录页（登完 redirect 回 /warehouse/）*/
  function loginByOdoo() {
    window.location.href = ODOO_LOGIN_URL
  }

  /** 登出：按 type 走不同路径 */
  async function logout() {
    if (isInternal.value) {
      // 真踢 Odoo session（清前端是顺带的，跳转后整个页面会重载）
      resetState()
      window.location.href = ODOO_LOGOUT_URL
      return
    }
    if (isParttime.value) {
      try { await authApi.logout() } catch { /* best-effort */ }
      resetState()
      window.location.href = '/login'
      return
    }
    resetState()
    window.location.href = '/login'
  }

  /**
   * 权限 / 类型 gate（路由 meta.requires + 模板里 v-if 都用这个）
   * 用法：
   *   canAccess('type:internal')         只有内部用户能进
   *   canAccess('role:warehouse_admin')  Odoo 后期定义的用户组
   *   canAccess('any')                   只要登录就行
   */
  function canAccess(rule) {
    if (!isLoggedIn.value) return false
    if (!rule || rule === 'any') return true
    const [kind, value] = String(rule).split(':')
    if (kind === 'type') return type.value === value
    if (kind === 'role') return identity.value?.role === value
    return true
  }

  function resetState() {
    type.value = null
    identity.value = null
    token.value = ''
    localStorage.removeItem(LS_TOKEN)
    localStorage.removeItem(LS_DEV_IDENT)
    // 清掉旧版本可能残留的 key
    localStorage.removeItem('employee_id')
    localStorage.removeItem('employee_name')
  }

  // ============================================================
  // TODO(dev-only): 后端 /whoami 上线后删除以下 dev 模拟逻辑 +
  //                  Login.vue 里两个 dev 按钮
  // ============================================================
  function devLoginInternal() {
    type.value = 'internal'
    identity.value = { name: 'Tommy (Dev)', user_id: 1, role: 'warehouse_admin' }
    persistDevIdentity()
  }
  function devLoginParttime() {
    type.value = 'parttime'
    identity.value = { name: 'Lily (Dev)', operator_id: 999, role: 'staff' }
    token.value = 'dev-token'
    localStorage.setItem(LS_TOKEN, 'dev-token')
    persistDevIdentity()
  }
  function persistDevIdentity() {
    localStorage.setItem(LS_DEV_IDENT, JSON.stringify({
      type: type.value, identity: identity.value,
    }))
  }
  function loadDevIdentity() {
    try {
      const raw = localStorage.getItem(LS_DEV_IDENT)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  return {
    // 状态
    type, identity, token, bootstrapped,
    // 派生
    isLoggedIn, isInternal, isParttime,
    // 操作
    bootstrap, loginByBadge, loginByOdoo, logout, canAccess,
    // dev-only
    devLoginInternal, devLoginParttime,
  }
})
