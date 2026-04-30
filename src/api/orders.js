import http from './http'

/**
 * 运单 — Dashboard 系统下「運單」页
 *
 * 数据主表：hktv.order.item（一条 = 一个 consignment / 一张运单 / 1:1 stock.picking）
 * 关联：sale.order 取 HKTV 子订单号
 */

/**
 * 列出运单。
 *
 * 后端契约：
 *   GET /api/warehouse/orders
 *     ?date_from=YYYY-MM-DD       过滤 pickup_date（含）
 *     ?date_to=YYYY-MM-DD         （含）
 *     ?q=...                      ilike 运单号 / 订单号
 *     ?status=A,B,C               逗号分隔多选，匹配 hktv_raw_status in [...]
 *     ?outbound_stage=a,b         逗号分隔多选，匹配 fulfillment_stage in [...]
 *     ?page=1&page_size=50        page 从 1 起算
 *
 *   200 →
 *     {
 *       orders: [
 *         {
 *           id,
 *           waybill,                 // hktv.order.item.tracking_id
 *           order_no,                // sale.order.hktv_sub_order_number（label "HKTV Order ID"）
 *           status,                  // hktv_raw_status — ACKNOWLEDGED / SHIPPED ...
 *           order_date,              // "YYYY-MM-DD HH:MM"
 *           pickup_date,             // "YYYY-MM-DD HH:MM"
 *           outbound_stage,          // hktv.order.item.fulfillment_stage — waiting/pick/pack/ship
 *           outbound_label,          // 对应 stage 的英文 label
 *           printed,                 // bool — waybill_attachment_ids 是否有附件
 *           sale_order_id
 *         }
 *       ],
 *       page, page_size, total, total_pages
 *     }
 *
 * 分页：用 Odoo 标准 search_count + search 两步法。前端按 page / total_pages
 *       渲染"第 X / Y 頁 · 共 Z 條 [上一頁] [下一頁]"。
 */
export function listOrders(params = {}) {
  return http.get('/warehouse/orders', { params })
}
