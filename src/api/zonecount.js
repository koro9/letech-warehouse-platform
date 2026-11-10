import http from './http'

/**
 * 區域盤點（年底大盤點）— 電腦版（主管）
 * 后端：le_warehouse/controllers/zone_count.py；模型说明见 le_warehouse/models/zone_count.py
 *
 * 一张任务单 = 一个员工 + 几个货架 + 一个时段。员工用 PDA 盘点（App「區域盤點」），
 * 主管在这里开单、看进度、覆核写回、查结果和操作记录。
 */

/** 批次列表 → { batches: [{ id, name, state, warehouse: { code, name }, note, closed_at, create_date }] } */
export function getBatches() {
  return http.get('/warehouse/zonecount/batches')
}

/** 新批次 → { batch } */
export function createBatch({ name, warehouse, note } = {}) {
  return http.post('/warehouse/zonecount/batch', { name, warehouse, note })
}

/** 结束 / 重开批次（op = close | reopen） */
export function batchOp(batchId, op) {
  return http.post(`/warehouse/zonecount/batch/${batchId}/${op}`, {})
}

/**
 * 盘点总览
 * → { batch, stats: { task_count, task_by_state, location_count, locked_shelf_count, done_shelf_count,
 *                     counted_sku, counted_qty, over_qty, over_sku, unshelved_qty, unshelved_sku, log_count },
 *     employees: [{ name, records, changes, undos }], tasks: [task] }
 */
export function getOverview(batchId) {
  return http.get('/warehouse/zonecount/overview', { params: { batch_id: batchId } })
}

/**
 * 可分配的货架（库存树里所有位置，按 parent_id 组树）
 * → { root, shelves: [{ id, name, full_name, barcode, parent_id, depth, child_count, on_hand,
 *                       assigned: { task, task_id, state, employee } | null, locked, partly }] }
 */
export function getShelves(batchId) {
  return http.get('/warehouse/zonecount/shelves', { params: { batch_id: batchId } })
}

/** 可分配的员工（WMS 启用的） → { employees: [{ id, name }] } */
export function getEmployees() {
  return http.get('/warehouse/zonecount/employees')
}

/**
 * 任务单列表 → { tasks: [{ id, name, state, employee, planned_start, planned_end, shelves: [...],
 *                          shelf_done, sku_count, qty, line_count, over_qty, log_count, log_counts, ... }] }
 */
export function getTasks(batchId, state) {
  return http.get('/warehouse/zonecount/tasks', { params: { batch_id: batchId, ...(state ? { state } : {}) } })
}

/** 任务单明细 → { task, shelves: [{ shelf, locations: [{ name, lines: [{ sku, name, expiry, qty }] }] }] } */
export function getTask(taskId) {
  return http.get(`/warehouse/zonecount/task/${taskId}`)
}

/**
 * 建立并开始（货架立即锁定）
 *   planned_start / planned_end: 'YYYY-MM-DDTHH:MM'（香港时间，datetime-local 的值）
 */
export function createTask({ batchId, employeeId, locationIds, plannedStart, plannedEnd, note }) {
  return http.post('/warehouse/zonecount/task', {
    batch_id: batchId,
    employee_id: employeeId,
    location_ids: locationIds,
    planned_start: plannedStart || '',
    planned_end: plannedEnd || '',
    note: note || '',
  })
}

/** 任务单操作：op = writeback（覆核写回）| reopen（退回重盘）| cancel → { task } */
export function taskOp(taskId, op, note) {
  return http.post(`/warehouse/zonecount/task/${taskId}/${op}`, { note: note || '' })
}

/**
 * 盘点结果（按 SKU）
 *   filter: all | diff | over | expiry | unshelved | uncounted
 * → { summary: { sku, counted, on_hand, over, unshelved },
 *     rows: [{ sku, name, barcode, on_hand, unshelved, counted, written, over, diff, expiry_changed,
 *              locations: [{ location, location_full, expiry, expiry_changed, qty, over, task, task_id, state, employee }] }],
 *     page, page_size, total, total_pages, has_more }
 */
export function getResults({ batchId, q, filter, page, pageSize } = {}) {
  return http.get('/warehouse/zonecount/results', {
    params: { batch_id: batchId, q: q || undefined, filter: filter || undefined, page, page_size: pageSize },
  })
}

/**
 * 操作记录
 *   action: 逗号分隔（record,add,set,undo,shelf_done,shelf_reopen,task_start,task_submit,task_reopen,task_cancel,writeback）
 *   date_from / date_to: 'YYYY-MM-DD'（香港时间）
 * → { logs: [{ id, time, action, action_label, task: { id, name }, employee, user, device,
 *              sku, name, location, location_full, shelf, expiry, qty_before, qty_after, note }],
 *     page, page_size, total, total_pages, has_more }
 */
export function getLogs({ batchId, taskId, employeeId, q, action, dateFrom, dateTo, page, pageSize } = {}) {
  return http.get('/warehouse/zonecount/logs', {
    params: {
      batch_id: batchId || undefined,
      task_id: taskId || undefined,
      employee_id: employeeId || undefined,
      q: q || undefined,
      action: action || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      page,
      page_size: pageSize,
    },
  })
}
