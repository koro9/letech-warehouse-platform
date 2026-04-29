import axios from 'axios'

/**
 * Odoo 后端 axios 实例
 *
 * 约定：
 *   - 所有 Odoo API 走 /api/* 路径
 *   - 鉴权用 Bearer token（员工胸牌登录后由后端发放）
 *   - 401 → 自动登出 + 跳 /login
 *   - 响应拦截器解包 response.data，调用方直接拿业务数据
 *
 * 后续若接入其他后端系统（非 Odoo），新建独立 http 实例（如 ./xxxHttp.js），
 * 不要往这个实例里塞条件分支。
 */
const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('warehouse_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

http.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('warehouse_token')
      localStorage.removeItem('employee_id')
      localStorage.removeItem('employee_name')
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export default http
