import axios from 'axios'
import { showToast } from '@/composables/useToast'
import { triggerCurrentRefresh } from '@/composables/usePageRefresh'

/**
 * Odoo 后端 axios 实例
 *
 * 约定：
 *   - 所有 Odoo API 走 /api/* 路径
 *   - 鉴权用 Bearer token（员工胸牌登录后由后端发放）
 *   - 401 → 自动登出 + 跳 /login
 *   - 写操作（POST/PUT/PATCH/DELETE）自动注入 Idempotency-Key 头（uuid）
 *     → 后端用此值去重，防 Wi-Fi 抖动重发导致的重复扣减
 *   - 409 Conflict → toast 提示 + 触发当前页 refresh（乐观锁冲突处理）
 *   - 响应拦截器解包 response.data，调用方直接拿业务数据
 *
 * 后续若接入其他后端系统（非 Odoo），新建独立 http 实例（如 ./xxxHttp.js），
 * 不要往这个实例里塞条件分支。
 */
const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 30000,
  // 同域 cookie 自动带（Odoo 内部用户走 session cookie 鉴权）
  // 跨域时浏览器默认不发 cookie，必须显式 withCredentials: true 才生效
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
})

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete'])

/**
 * 生成 Idempotency-Key 用的 UUID v4。
 * crypto.randomUUID() 只在 Secure Context (HTTPS / localhost) 可用，
 * 测试环境若跑在纯 HTTP 上会抛 TypeError —— 此时降级到 Math.random 实现。
 * 幂等 key 不需要密码学强度，普通 UUID v4 足够。
 */
function makeRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID() } catch { /* 走降级 */ }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('warehouse_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // 写操作幂等 key — 防网络重发导致后端重复执行
  // 调用方如需在重试时复用同一个 key（保证整段重试链条都被去重），
  // 在调用前传 config.headers['Idempotency-Key'] = <已有uuid> 即可覆盖
  if (WRITE_METHODS.has(config.method?.toLowerCase()) && !config.headers['Idempotency-Key']) {
    config.headers['Idempotency-Key'] = makeRequestId()
  }
  return config
})

http.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const status = error.response?.status

    if (status === 401) {
      // 不在这里清 store 状态（避免循环 import）；只清 JWT，跳 /login，
      // 让 auth store 在 /login 页 bootstrap 时根据后端 /whoami 决定真实状态
      // 用 BASE_URL 拼接路径：dev = /login，prod = /warehouse/login（跟 Odoo 同域不冲突）
      localStorage.removeItem('warehouse_token')
      const loginPath = `${import.meta.env.BASE_URL}login`
      if (window.location.pathname !== loginPath) {
        window.location.href = loginPath
      }
    }

    if (status === 409) {
      // 乐观锁冲突 — 别人改过这条数据
      // 不打断用户输入，只 toast + 拉最新数据
      showToast('資料已被其他人更新，已重新載入', 'warning')
      triggerCurrentRefresh()
      // 标记 error 让调用方知道已经处理过，不要重复 toast
      error.handledByInterceptor = true
    }

    return Promise.reject(error)
  }
)

export default http
