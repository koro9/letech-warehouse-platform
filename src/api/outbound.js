import http from './http'

/**
 * S1 出库 — 扫码出库流程
 */

export function getOutboundOrder(orderNumber) {
  return http.get(`/warehouse/outbound/${orderNumber}`)
}

export function scanOutbound({ orderNumber, sku, qty }) {
  return http.post('/warehouse/outbound/scan', { orderNumber, sku, qty })
}

export function forceCompleteOutbound(orderNumber) {
  return http.post(`/warehouse/outbound/${orderNumber}/force-complete`)
}
