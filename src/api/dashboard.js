import http from './http'

/**
 * 出货作业中心 — 仪表板 KPI
 *
 * 数据指标定义（跟后端 le_warehouse.controllers.dashboard 对齐）：
 *   - CREATED       已建立：非3PL + 当日 pickup_date + 已有运单 PDF + 还没归到 le.shipping.label
 *   - CONFIRMED     已确认：当日 le.shipping.label 的 waybill_count 之和
 *   - SHIPPED       已出货：非3PL + 当日 pickup_date + fulfillment_stage='pack'
 *   - TOTAL_TARGET  总目标：非3PL + 当日 pickup_date + 已有运单 PDF
 *
 * 进度条 = SHIPPED / TOTAL_TARGET
 *
 * 性能：后端走 search_count + read_group(sum)，1 次轮询 today+tomorrow
 *      共 8 个轻量 SQL，不读完整 record。
 */

/**
 * 获取今日 + 明日的仪表板数据。
 *
 * @returns 200 {
 *   today:    { date, CREATED, CONFIRMED, SHIPPED, TOTAL_TARGET },
 *   tomorrow: { 同上 },
 *   last_updated: 'YYYY-MM-DD HH:MM:SS' (HKT)
 * }
 */
export function getStats() {
  return http.get('/warehouse/dashboard/stats')
}
