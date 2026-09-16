import http from './http'

/**
 * 出库扫码流程 — 方案 B（前端累加 + 一次性 validate）
 *
 * 业务流：
 *   1. 员工扫运单号 (tracking_id) → getOutboundOrder(code)
 *      后端按 tracking_id 找 hktv.order.item，fallback origin → 返 picking + items
 *   2. 员工逐件扫商品条码 → 纯前端累加（不调 API）
 *      前端实时校验：not_in_order / over_quantity → toast 拦截
 *   3. 扫满 totalScanned === totalRequired → 自动 validateOutbound(picking_id, ..., false)
 *      或员工点强制出库 → validateOutbound(picking_id, ..., true)
 *
 * 后端 validate 端点会：
 *   - 写 stock.move.quantity
 *   - 调 picking.button_validate() → 触发 le_stock_mrp 现有 hook
 *     自动推 hktv.order.item.fulfillment_stage='pack'
 */

/**
 * 按运单号 / 子订单号查出库单。
 *
 * @param {string} code  扫码内容（运单号 tracking_id 优先，子订单号兜底）
 * @returns 200 { code, picking_id, tracking_id, sub_order_number, state, items }
 *   items: [{ sku, name, barcode, barcode2, barcodes[], required_qty }]
 *   404 订单不存在
 */
export function getOutboundOrder(code) {
  return http.get(`/warehouse/outbound/${code}`)
}

/**
 * 一次性提交所有 quantity + 触发 picking.button_validate()。
 *
 * @param {number} pickingId
 * @param {Array<{sku, qty}>} quantities  每个 SKU 的扫码数量（前端累加结果）
 * @param {boolean} force  false=必须扫满才让过；true=少扫也强制 validate（走 backorder）
 * @returns 200 { success: true, picking_state }
 *   400 over_quantity / not_complete / picking_already_done / validate_failed
 */
export function validateOutbound(pickingId, quantities, force = false) {
  return http.post(
    `/warehouse/outbound/${pickingId}/validate`,
    { quantities, force },
  )
}

/**
 * 把扫到的码解析成这张单上的哪一行 —— 匹配在后端做，查两道表。
 *
 * 为什么不在前端比（Koro 2026-09-15 定「后端应该查两道，也就是这两个表」）：
 *   items 里只塞得下 barcode / barcode2 两个字段，但一个 SKU 实测最多挂 4 个
 *   附加条码（le.product.barcode 表）。前端比就必然漏。而且口径散在两处，
 *   Odoo 那边改了这边不知道。
 *
 * 后端查两道：
 *   ① 主表 product.template.le_code / le_barcode / default_code + product.barcode
 *   ② 附表 le.product.barcode（一个 SKU 任意条）
 * 母件和组件都认 —— 仓库的货不一定已组装。
 *
 * 前端仍保留本地快速匹配（barcode / barcode2 / sku）；那是这个接口的子集，
 * 命中就不用发请求，只有本地落空才走这里。
 *
 * @param {number} pickingId
 * @param {string} code  扫到的原始字符串
 * @returns 200 { found: true, sku, matched_sku, matched_by: 'main'|'extra',
 *                is_component, qty_per }
 *          sku 一律是母件 —— validate 只认母件数量
 *   404 { found: false }  此单无此码
 */
export function resolveScan(pickingId, code) {
  return http.get(`/warehouse/outbound/${pickingId}/scan`, { params: { code } })
}
