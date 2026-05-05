import http from './http'

/**
 * 面单 — Dashboard 系统下「面單」页（出貨作業中心）
 *
 * 业务：仓库人员每天出库前打印面单贴包裹。每条记录 = 一个面单 PDF
 *      （聚合多张运单的面单合成一份），按出库日期分组展示今日 / 明日；
 *      下面是历史所有数据带分页 + 红行高亮没打过的批次。
 *
 * 后端模型：le.shipping.label（letech/le_warehouse/models/shipping_label.py）
 */

/**
 * 列出面单。
 *
 * 后端契约：
 *   GET /api/warehouse/shipping/labels?scope=today|tomorrow|all&page=&page_size=
 *
 *   scope=today / tomorrow → 不分页，全量返回
 *     200 → { scope, labels: [...], total }
 *
 *   scope=all（含历史）→ 跟运单页同款分页
 *     200 → { scope, labels, page, page_size, total, total_pages }
 *
 *   labels 元素：
 *     {
 *       id,
 *       file_name,        // PDF 文件名
 *       waybill_count,    // 包含的运单数（UI"運單"列）
 *       outbound_date,    // YYYY-MM-DD
 *       download_count,   // 下载/打印次数；0 → 历史表格红行
 *       operation_time    // YYYY-MM-DD HH:MM（= create_date）
 *     }
 */
export function listLabels(params = {}) {
  return http.get('/warehouse/shipping/labels', { params })
}

/**
 * 下载面单 PDF（同时后端 download_count + 1）。
 *
 * 关键：必须走这个端点 +1 计数，不要直接拼 ir.attachment 的 /web/content/...
 *      因为后者在 Odoo 后台预览时也会触发，跟"只有 WMS 前端点才算打印"诉求不符。
 *
 * 实现：用 axios 拿 blob，再触发浏览器下载（保留 Content-Disposition 文件名）。
 *
 * 后端契约：
 *   GET /api/warehouse/shipping/labels/<id>/download
 *     200 application/pdf with Content-Disposition: attachment
 *     404 label_not_found / attachment_not_found / attachment_empty
 */
export async function downloadLabel(labelId, fallbackFileName) {
  // axios 实例的响应拦截器默认会 unwrap response.data —— 对 JSON 没问题，
  // 但 PDF 二进制要 blob，需要 responseType: 'blob' + 自己处理整个 response 对象。
  // 拦截器看 content-type ≠ json 时会把 response 整体透传。
  const blob = await http.get(`/warehouse/shipping/labels/${labelId}/download`, {
    responseType: 'blob',
  })

  // 触发浏览器另存
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fallbackFileName || `shipping_label_${labelId}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 释放 blob URL（异步触发即可，下载已发起）
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 触发后端按 scope 生成新的面单批次。
 *
 * 后端逻辑（见 le.shipping.label.action_generate_for_date）：
 *   - 找该日期 hktv.order.item where 有 PDF + 未绑定 + 不是 3PL
 *   - 合并它们的 PDF → 新 attachment → 新 label，items.shipping_label_id = label.id
 *   - 没找到 → 创建占位 label（waybill_count=0、无 attachment）
 *
 * 并发安全：后端 PG advisory lock 串行化。同 scope 当前已有人在生成时，
 *   立刻返回 status='busy'（不等），前端 toast 提示。
 *
 * 后端契约：
 *   POST /api/warehouse/shipping/labels/generate
 *   Body: { scope: 'today' | 'tomorrow' }
 *
 *   200 → {
 *     status: 'completed' | 'busy',
 *     scope,
 *     label?:    { id, file_name, waybill_count, outbound_date, ... }   // completed 才有
 *     by_name?:    string,                                              // busy 才有
 *     started_at?: 'YYYY-MM-DD HH:MM:SS',                               // busy 才有
 *   }
 *   400 invalid_scope
 */
export function generateLabel(scope) {
  return http.post('/warehouse/shipping/labels/generate', { scope })
}

/**
 * 查询当前 today / tomorrow 是否有人在生成。前端 2.5s 轮询。
 *
 * 后端契约：
 *   GET /api/warehouse/shipping/labels/generate-status
 *
 *   200 → {
 *     today:    { is_running, by_name?, started_at? },
 *     tomorrow: { is_running, by_name?, started_at? }
 *   }
 *
 * 60 秒超时检测：后端如果 generate 进程崩溃留下僵尸状态，超时后自动视为 idle。
 */
export function getGenerateStatus() {
  return http.get('/warehouse/shipping/labels/generate-status')
}
