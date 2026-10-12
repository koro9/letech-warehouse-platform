import http from './http'

/**
 * 每日盤點 — le.stocktake.line 嘅 Kiosk API
 * 后端契约:le_warehouse controllers/stocktake.py
 *
 * ⚠️ 冇 resolve(主管已處理)—— 按 Koro 定,销主管单只喺 Odoo 后台做。
 */

/**
 * 今日盤點名單。
 *   GET /api/warehouse/stocktake/tasks?date=&zone=&include_skip=
 *   200 → { date, source, dest, target_available, recheck_days,
 *           funnel:{total,due,skip,by_reason}, zones:[{key,label,due,todo}],
 *           progress:{ok,moved,flag,todo,units_moved}, lines:[<kiosk_dict>] }
 */
export function getTasks(params = {}) {
  return http.get('/warehouse/stocktake/tasks', { params })
}

/**
 * 某行嘅未出貨銷售單。
 *   GET /api/warehouse/stocktake/orders?line_id=
 *   200 → { orders: [{ order, shop, date_order, pending, reserved, pickings:[{name,state}] }] }
 */
export function getOrders(lineId) {
  return http.get('/warehouse/stocktake/orders', { params: { line_id: lineId } })
}

/**
 * 估聽日最少幾多個要點。
 *   GET /api/warehouse/stocktake/preview_tomorrow?date=
 */
export function previewTomorrow(date) {
  return http.get('/warehouse/stocktake/preview_tomorrow', { params: date ? { date } : {} })
}

/**
 * 提交實點結果。
 *   POST /api/warehouse/stocktake/submit
 *   body: { line_id, action:'confirm'|'move'|'flag', counted_qty, lot_id? }
 *   200 → { ok, stale?, message, picking?, line:<kiosk_dict> }
 *     stale=true 代表庫存喺出單之後變咗,要按新數再點一次。
 */
export function submit(payload) {
  return http.post('/warehouse/stocktake/submit', payload)
}

/** 「照樣點」:把今日唔使點嘅 SKU 加返入名單。 */
export function force(lineId) {
  return http.post('/warehouse/stocktake/force', { line_id: lineId })
}

/** 撤回今日「已確認」或「待主管處理」。 */
export function reset(lineId) {
  return http.post('/warehouse/stocktake/reset', { line_id: lineId })
}
