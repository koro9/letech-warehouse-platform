import http from './http'

/**
 * 库存 — 智能查詢中心 + 后续库存对比/对账等会用到
 * 后端契约：letech_warehouse_api 模块（待实现）
 */

/**
 * 模糊搜索商品：SKU / Barcode / 中英文名都接受
 *
 * 后端契约：
 *   GET /api/warehouse/inventory/search?q=<keyword>
 *   200 →
 *     {
 *       products: [{ sku, barcode, name, name_en }, ...],   // 最多 limit 条
 *       has_more: boolean,                                   // true 表示被截断
 *       limit:    number                                     // 当前后端的 limit (40)
 *     }
 *
 * 分页策略：精准搜索用"截断提示"，不翻页（命中超过 40 = 关键字太宽，
 *   前端提示用户精化即可，参考 project_pagination_strategy 记忆）
 */
export function searchProducts(query) {
  return http.get('/warehouse/inventory/search', { params: { q: query } })
}

/**
 * 按 SKU 查实时库存（Odoo stock.quant 直连，已替代旧的 DEAR 调用）
 *
 * 后端契约：
 *   GET /api/warehouse/inventory/stock?sku=<le_code>
 *   200 →
 *     {
 *       product:  { sku, name, name_en, barcode },
 *       summary:  { on_hand, reserved, available },
 *       by_warehouse: [
 *         { warehouse_name, warehouse_code, on_hand, reserved, available },
 *         ...
 *       ]
 *     }
 *   400 { error: 'missing_sku' }
 *   404 { error: 'product_not_found' }
 */
export function getStock(sku) {
  return http.get('/warehouse/inventory/stock', { params: { sku } })
}
