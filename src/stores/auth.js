import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { auth as authApi } from '@/api'

/**
 * 鉴权 Store —— 区分两类用户
 *
 *   internal (Odoo 内部用户)
 *     - 从 Odoo 菜单跳过来，已有 Odoo session cookie
 *     - API 调用自动带 cookie，后端按 cookie 识别
 *     - 登出 = 仅清 Vue 系统的状态，**不动 Odoo session**
 *       这样允许"Odoo 用 admin、Vue 用兼职"这种混搭场景
 *
 *   parttime (兼职员工)
 *     - 在 /login 扫胸牌
 *     - 后端发 JWT（有效期约 10 小时 = 一个班次）
 *     - JWT 存 localStorage，axios 自动加 Authorization
 *     - 登出 = 通知后端 + 清本地 → 跳 /login（适配多人轮流用同一台机器）
 *
 * 关键设计：登出后用 LS_LOGGED_OUT 标记"用户主动登出意图"
 *   - bootstrap 看到这个标记就跳过 whoami，即使浏览器还有 cookie 也不自动 claim
 *   - 直到用户在 /login 页明确点登录按钮（扫胸牌 或 "用 Odoo 身份"）才清除标记
 *
 * 真实身份永远以后端 /whoami 为准，前端不判断。
 */

// Vite base：dev = '/'，prod 构建 = '/warehouse/'（跟 Odoo 共域，不同根路径）
// 用 BASE_URL 拼绝对路径，避免硬编码 '/login' 撞到 Odoo 的根路由
const APP_BASE = import.meta.env.BASE_URL          // 比如 '/warehouse/'
const LOGIN_PATH = `${APP_BASE}login`              // '/warehouse/login'
const ODOO_LOGIN_URL = `/web/login?redirect=${encodeURIComponent(APP_BASE)}`

const LS_TOKEN      = 'warehouse_token'
const LS_LOGGED_OUT = 'wh_logged_out'    // 用户主动登出标记，bootstrap 期间短路 whoami

export const useAuthStore = defineStore('auth', () => {
  const type        = ref(null)    // 'internal' | 'parttime' | null
  const identity    = ref(null)    // { name, user_id?, operator_id?, role?, avatar? }
  const token       = ref(localStorage.getItem(LS_TOKEN) || '')
  const bootstrapped = ref(false)  // bootstrap 是否完成（防止 router 提前判定）

  const isLoggedIn  = computed(() => type.value !== null)
  const isInternal  = computed(() => type.value === 'internal')
  const isParttime  = computed(() => type.value === 'parttime')

  /**
   * 启动时 / 刷新时调用
   *   - 有"主动登出"标记 → 直接跳过 whoami，状态保持登出
   *   - 否则正常去后端 /whoami 拿身份（cookie 或 JWT 二选一识别）
   */
  async function bootstrap() {
    if (localStorage.getItem(LS_LOGGED_OUT) === '1') {
      bootstrapped.value = true
      return
    }
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
      // 后端 401 / 后端未就绪 → 视为未登录
      resetState()
    } finally {
      bootstrapped.value = true
    }
  }

  /**
   * 兼职员工：扫胸牌登录
   * 用户在 /login 主动选了"扫胸牌"路径 = 明确的 parttime 意图，
   * 直接用 /login/badge 响应里的 identity 字段，**不调 whoami** —— 否则浏览器
   * 残留的 Odoo cookie 会被后端 whoami 误识别成 internal，盖掉刚登的兼职身份。
   */
  async function loginByBadge(barcode) {
    localStorage.removeItem(LS_LOGGED_OUT)
    const data = await authApi.loginByBadge(barcode)
    token.value = data.token
    localStorage.setItem(LS_TOKEN, data.token)
    type.value = 'parttime'
    identity.value = {
      name:        data.name,
      operator_id: data.operator_id,
      role:        data.role,
      avatar:      data.avatar,
    }
    bootstrapped.value = true
  }

  /**
   * 内部用户登录：
   *   - 已有 Odoo cookie → 重跑 bootstrap 直接 claim
   *   - 没 Odoo cookie → 跳 Odoo /web/login
   *
   * 同样原理：用户主动点"使用 Odoo 账号登录" = 明确 internal 意图。
   * 先清掉残留的 parttime JWT（如果有），避免后端 whoami 见到 JWT 把人识别成 parttime。
   */
  async function loginByOdoo() {
    localStorage.removeItem(LS_LOGGED_OUT)
    token.value = ''
    localStorage.removeItem(LS_TOKEN)
    await bootstrap()
    if (isLoggedIn.value) return    // claim 成功，调用方负责跳转
    // 没 Odoo session，导到 Odoo 登录页
    window.location.href = ODOO_LOGIN_URL
  }

  /**
   * 登出 — 只关 Vue 系统这边
   *   - parttime: best-effort 通知后端把 JWT 加 denylist
   *   - internal: 不动 Odoo session（用户可能 Odoo 和 Vue 用不同账号）
   *   - 设置 LS_LOGGED_OUT 标记让下次 bootstrap 不再 claim cookie
   */
  async function logout() {
    if (isParttime.value) {
      try { await authApi.logout() } catch { /* best-effort */ }
    }
    resetState()
    localStorage.setItem(LS_LOGGED_OUT, '1')
    window.location.href = LOGIN_PATH
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

  /**
   * 清前端状态。注意：不清 LS_LOGGED_OUT 标记 —— 那个由 logout() 设置、
   * loginByBadge / loginByOdoo 清除，跟这里的 state 重置是两件事
   */
  function resetState() {
    type.value = null
    identity.value = null
    token.value = ''
    localStorage.removeItem(LS_TOKEN)
    // 清掉旧版本残留的 key（包括早期 dev 模式留下的）
    localStorage.removeItem('employee_id')
    localStorage.removeItem('employee_name')
    localStorage.removeItem('wh_dev_identity')
  }

  return {
    // 状态
    type, identity, token, bootstrapped,
    // 派生
    isLoggedIn, isInternal, isParttime,
    // 操作
    bootstrap, loginByBadge, loginByOdoo, logout, canAccess,
  }
})
