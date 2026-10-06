import http from './http'

/**
 * 库存 — 智能查詢中心 + 后续库存对比等会用到
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

/**
 * SKU 家族查詢：散裝 + 所有組合裝一次攤開
 *
 * 为什么要"家族"而不是单 SKU：仓务问「KUA-060019C 还有没有货」，真正要知道的
 * 是散装加上所有组合装合起来等于多少。只看一个 SKU 会误判 —— 组合装没货但散装
 * 有，其实砌得出。
 *
 * 后端契约：
 *   GET /api/warehouse/inventory/family?q=<SKU或條碼>&warehouse=<code>
 *   200 →
 *     {
 *       product:   { sku, name },
 *       base:      { sku, name } | null,        // 散装；多子件(礼盒)时为 null
 *       warehouse: { code, name },
 *       family: [{
 *         sku, name, role, ratio, is_kit, no_bom,
 *         on_hand, reserved, available, pending, pending_reserved
 *       }],
 *       summary: {
 *         on_hand_base, free_base, need_base, short_base,
 *         order_count, convertible                // convertible=false 表示不折合
 *       },
 *       pending_orders: [{
 *         order_name, shop, date_order, sku, qty, delivered, pending,
 *         reserved, picking_names, picking_state, scheduled_date, no_picking
 *       }],
 *       warnings: [string]                        // 没 BOM / 欠货提示
 *     }
 *   400 { error: 'missing_query' }
 *   404 { error: 'product_not_found', suggestions: [{ sku, name }] }
 */
export function getFamily(query, warehouse) {
  const params = { q: query }
  if (warehouse) params.warehouse = warehouse
  return http.get('/warehouse/inventory/family', { params })
}
