import axios from 'axios'

/**
 * Axios 实例 — 统一请求 Odoo 后端 API
 *
 * 后端约定：
 *   - 走 /api/* 路径
 *   - 鉴权用 Bearer token（员工胸牌登录后由后端发放）
 *   - 401 → 自动登出 + 跳 /login
 */
const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

// 请求拦截：自动带 token
http.interceptors.request.use((config) => {
  const token = localStorage.getItem('warehouse_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截：解构 data + 处理 401
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

/**
 * Warehouse API 集合
 *
 * 命名规范：业务领域 + 动作（getXxx / postXxx / scanXxx ...）
 * 后端契约见 letech 项目 letech_warehouse_api 模块
 */
export const warehouseAPI = {
  // ---- 鉴权 ----
  login: (employee_barcode) =>
    http.post('/warehouse/login', { employee_barcode }),
  logout: () => http.post('/warehouse/logout'),

  // ---- 出库 ----
  getOutboundOrder: (orderNumber) =>
    http.get(`/warehouse/outbound/${orderNumber}`),
  scanOutbound: ({ orderNumber, sku, qty }) =>
    http.post('/warehouse/outbound/scan', { orderNumber, sku, qty }),
  forceCompleteOutbound: (orderNumber) =>
    http.post(`/warehouse/outbound/${orderNumber}/force-complete`),

  // ---- 面单/拆单/标签（后续接入 hktv_connector 已有方法）----
  printShippingLabel: (orderNumber) =>
    http.post(`/warehouse/shipping/${orderNumber}/print`),
  splitWaybill: (orderNumber, splits) =>
    http.post(`/warehouse/shipping/${orderNumber}/split`, { splits }),
}

export default http
