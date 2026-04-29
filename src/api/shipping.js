import http from './http'

/**
 * S1 面单 / 拆单 / 标签
 * 对接 letech 项目 hktv_connector 已有的面单方法
 */

export function printShippingLabel(orderNumber) {
  return http.post(`/warehouse/shipping/${orderNumber}/print`)
}

export function splitWaybill(orderNumber, splits) {
  return http.post(`/warehouse/shipping/${orderNumber}/split`, { splits })
}
