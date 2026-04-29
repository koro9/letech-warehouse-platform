import http from './http'

/**
 * 库存 — 智能查詢中心 + 后续库存对比/对账等会用到
 * 后端契约：letech_warehouse_api 模块（待实现）
 */

/**
 * 模糊搜索商品：SKU / Barcode / 中英文名都接受
 * 期望返回：{ products: [{ sku, barcode, name, brand?, stock? }, ...] }
 */
export function searchProducts(query) {
  return http.get('/warehouse/inventory/search', { params: { q: query } })
}
