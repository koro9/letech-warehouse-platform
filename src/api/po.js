import http from './http'

/**
 * 收貨分配 (M3b) — PO Allocation API
 *
 * 业务流：
 *   1. 员工进入 M3b → 输入 PO 单号 → getAllocation(poName)
 *      → 后端按 PO 拉所有 line + 上次分配数据 + combo 候选 + extra cols
 *   2. 员工录入分配方案（3PL / WS / 额外列 / Combo 子行）
 *   3. saveAllocation 提交 — 行级乐观锁，冲突会返 207
 *   4. 冲突 modal 让用户决定 keep 或 accept server 后再 save
 *
 * 多用户协作模型：
 *   - 行级增量 save：前端 dirty tracking 只送改了的行
 *   - 行级乐观锁：每行带 _last_modified_at（服务器 write_date）
 *   - 服务器比对：如果 server 版本更新 → 加入 conflicts 列表
 *   - PO 级 extra_cols 共享：最后写覆盖（不参与冲突检测）
 */

/**
 * 加载 PO 分配快照。
 *
 * 后端契约：GET /api/warehouse/po/<po_name>/allocation
 *
 * @param {string} poName  PO 单号（Odoo purchase.order.name）
 * @returns 200 {
 *   po_id, po_name, partner_name, date_planned, state, server_time,
 *   rows: [{ po_line_id, sku, barcode, name, qty, box_qty,
 *            remarks, counted,
 *            tpl, ws, extra, combos, combo_options,
 *            last_modified_at, last_modified_by }],
 *   extra_cols: [{ name, active }, { name, active }],
 * }
 *   403 not_authorized        非内部员工
 *   404 po_not_found
 *   422 po_state_not_allowed  PO 状态不在 allowed 范围（draft/sent/cancel）
 */
export function getAllocation(poName) {
  const safe = encodeURIComponent(poName)
  return http.get(`/warehouse/po/${safe}/allocation`)
}

/**
 * 保存分配（增量 + 行级乐观锁）。
 *
 * 后端契约：POST /api/warehouse/po/<po_name>/allocation
 * Body: {
 *   rows: [
 *     { po_line_id, tpl, ws, extra, combos,
 *       _last_modified_at }   // ← 客户端拿到这行时的 last_modified_at
 *   ],
 *   extra_cols?: [{ name, active }, ...]   // null/undefined 表示不更新
 * }
 *
 * @param {string} poName
 * @param {object} payload  { rows, extra_cols? }
 * @returns
 *   200 { ok: true, saved: [po_line_id...], server_time }
 *   207 { ok: false, saved: [...], conflicts: [
 *           { po_line_id, sku, modified_by, modified_at,
 *             server_data, your_data }
 *         ], server_time }
 *   403 not_authorized
 *   404 po_not_found
 *   400 invalid_payload / invalid_json
 *
 * 注：207 不是 axios 默认 success — 拦截器要让它通过 / 或者前端用 try/catch。
 *     调用方建议用 try/catch + 检查 err.response.status === 207 区分冲突。
 */
export function saveAllocation(poName, payload) {
  const safe = encodeURIComponent(poName)
  return http.post(`/warehouse/po/${safe}/allocation`, payload)
}

/**
 * 搜索 Odoo stock.warehouse — 给 M3b 额外列 autocomplete 用。
 *
 * 后端契约：GET /api/warehouse/warehouses?q=...
 *
 * @param {string} q  可选模糊关键字（不传则返前 20 个）
 * @returns 200 { warehouses: [{ id, name, code }, ...] }
 */
export function searchWarehouses(q = '') {
  return http.get('/warehouse/warehouses', { params: { q } })
}

// ============================================================
// PO 點貨 (M3a) — Counting
// ============================================================

/**
 * 加载 PO 點貨数据。
 *
 * 后端把 M3b 录的分配数据（le_allocation_data）重组成 allocs[].warehouses
 * 字典给前端，前端用这个驱动按仓 × 效期录入 UI。
 *
 * 后端契约：GET /api/warehouse/po/<po_name>/counting
 *
 * @returns 200 {
 *   po_id, po_name, partner_name, state, server_time,
 *   items: [
 *     { po_line_id, sku, barcode, name, perBox, qty, remarks,
 *       allocs: [
 *         { id, type, label, mult?,
 *           warehouses: { '3PL':20, 'WS':30, 'SD4':20, 'PCC':10 } }
 *       ],
 *       counting: { dates, a },
 *       remarks_handled: { handled, by, time },
 *       last_modified_at, last_modified_by }
 *   ]
 * }
 *   404 po_not_found / 422 po_state_not_allowed / 403 not_authorized
 */
export function getCounting(poName) {
  const safe = encodeURIComponent(poName)
  return http.get(`/warehouse/po/${safe}/counting`)
}

/**
 * 保存 PO 點貨录入（行级乐观锁，含冲突 207）。
 *
 * @param {string} poName
 * @param {object} payload  { rows: [{ po_line_id, counting, remarks_handled, _last_modified_at }] }
 * @returns
 *   200 { ok, saved: [...], server_time }
 *   207 { ok:false, saved, conflicts, server_time }
 *   404 po_not_found / 422 po_state_not_allowed / 403 not_authorized
 */
export function saveCounting(poName, payload) {
  const safe = encodeURIComponent(poName)
  return http.post(`/warehouse/po/${safe}/counting`, payload)
}

// ============================================================
// Transfer Order (M3c)
// ============================================================

/**
 * 列出 PO 下所有 TR 摘要。
 *
 * 后端契约：GET /api/warehouse/po/<po_name>/transfers
 *
 * @returns 200 {
 *   po_id, po_name, partner_name, state,
 *   transfers: [
 *     { id, name, source_warehouse, dest_warehouse, state,
 *       parent_transfer_id,
 *       stats: { groups, total_req, total_pick, total_boxes, done_groups,
 *                has_picked, has_remaining },
 *       last_modified_at, last_modified_by }
 *   ]
 * }
 *   404 po_not_found / 422 po_state_not_allowed / 403 not_authorized
 */
export function listTransfers(poName) {
  const safe = encodeURIComponent(poName)
  return http.get(`/warehouse/po/${safe}/transfers`)
}

/**
 * 基于 M3b 分配数据派生所有 TR（每个目的仓一张）。
 *
 * 后端契约：POST /api/warehouse/po/<po_name>/transfers/generate
 *
 * @returns 200 { transfers: [...摘要...], count }
 *   409 already_generated  PO 已经生成过 TR（去 Odoo 后台先删旧的）
 *   422 no_allocation      PO 还没录 M3b 分配方案
 *   404 po_not_found / 403 not_authorized
 */
export function generateTransfers(poName) {
  const safe = encodeURIComponent(poName)
  return http.post(`/warehouse/po/${safe}/transfers/generate`, {})
}

/**
 * 拿单张 TR 完整详情（含 groups_data）。
 *
 * 后端契约：GET /api/warehouse/transfer/<tr_id>
 *
 * @returns 200 {
 *   id, name, po_id, po_name,
 *   source_warehouse, dest_warehouse, state,
 *   parent_transfer_id, parent_transfer_name,
 *   groups_data: [...],
 *   stats: {...},
 *   last_modified_at, last_modified_by
 * }
 *   404 transfer_not_found / 403 not_authorized
 */
export function getTransfer(trId) {
  return http.get(`/warehouse/transfer/${trId}`)
}

/**
 * 保存 TR 揀貨录入（TR 级乐观锁）。
 *
 * 后端契约：POST /api/warehouse/transfer/<tr_id>
 * Body: { groups_data, _last_modified_at }
 *
 * @returns 200 { ok, transfer: {...完整...} }
 *   409 conflict { server_data, your_data, modified_by, modified_at }
 *   422 transfer_locked  TR state=cut/done 不可修改
 *   404 transfer_not_found / 403 not_authorized
 */
export function saveTransfer(trId, payload) {
  return http.post(`/warehouse/transfer/${trId}`, payload)
}

/**
 * 截單 — 拆 TR 成"已揀部分"+"剩餘部分"，原 TR 状态变 cut，
 * 返回新建的"第二轉" TR。
 *
 * 后端契约：POST /api/warehouse/transfer/<tr_id>/cut
 *
 * @returns 200 { ok, original: {...摘要...}, new_transfer: {...摘要...} }
 *   422 cannot_cut  尚未揀貨 / 已全揀完 / 已 cut
 *   404 transfer_not_found / 403 not_authorized
 */
export function cutTransfer(trId) {
  return http.post(`/warehouse/transfer/${trId}/cut`, {})
}
