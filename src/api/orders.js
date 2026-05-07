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
 *     ?page=1&page_size=40        page 从 1 起算
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

/**
 * 拿运单的商品明细（拆单弹窗用）
 *
 * 后端契约：
 *   GET /api/warehouse/orders/<item_id>/items
 *   200 → {
 *     item_id, waybill, consignment, total_qty,
 *     lines: [
 *       { line_id, hktv_sku, internal_sku, product_name, brand, qty }
 *     ]
 *   }
 *   404 order_not_found
 */
export function getOrderItems(itemId) {
  return http.get(`/warehouse/orders/${itemId}/items`)
}

/**
 * 拆运单 — 把指定商品的部分数量拆到一张新运单（HKTV API + 本地数据同步）
 *
 * 业务复用 Odoo 后端 hktv.split.waybill.wizard：会调 HKTV splitWaybills API、
 * 创建新 hktv.order.item、改 stock.picking、写 hktv.waybill.change 日志。
 *
 * splits: [{ line_id, split_qty }]    仅传 split_qty > 0 的行
 *
 * 后端契约：
 *   POST /api/warehouse/orders/<item_id>/split   Body: { splits: [...] }
 *   200 → { ok, new_waybill, new_consignment, new_item_id }
 *   422 split_failed (detail 字段含具体原因 — HKTV API 错 / 规则违反)
 *   404 order_not_found
 *
 * 注意：HKTV API 同步外网调用，可能数百毫秒到数秒，前端需要 spinner / 禁用按钮。
 */
export function splitOrder(itemId, splits) {
  return http.post(`/warehouse/orders/${itemId}/split`, { splits })
}

/**
 * 下載運單面單 PDF
 *
 * 後端契約：
 *   GET /api/warehouse/orders/<item_id>/waybill-label
 *     200 application/pdf  Content-Disposition: attachment
 *     422 generate_failed (含 detail：HKTV 未配置 / API 失敗 / SKU 缺失等)
 *     404 order_not_found
 *
 * 兩種狀態：
 *   - 已生成（item.waybill_attachment_ids 非空）→ 直接返回 PDF（即時）
 *   - 未生成 → 後端調 HKTV printWaybills 同步生成（1-3 秒）
 *
 * 前端不關心是哪種，調這個 API 就行 — 後端決定。
 * 響應較慢時前端應 disable 按鈕 + 顯示 spinner。
 */
export async function downloadWaybillLabel(itemId, fallbackFileName) {
  // axios 拦截器看 content-type ≠ json 时透传整个 response，blob 会落到 .data
  const blob = await http.get(`/warehouse/orders/${itemId}/waybill-label`, {
    responseType: 'blob',
  })

  // 触发浏览器另存
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fallbackFileName || `waybill_${itemId}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
