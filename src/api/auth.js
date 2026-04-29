import http from './http'

/**
 * 鉴权 — 员工胸牌扫码登录
 * 后端契约：letech_warehouse_api 模块
 */

export function login(employee_barcode) {
  return http.post('/warehouse/login', { employee_barcode })
}

export function logout() {
  return http.post('/warehouse/logout')
}
