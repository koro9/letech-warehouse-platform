import http from './http'

/**
 * 商品标签 — 出货作业中心 / Dashboard 系统
 *
 * 数据架构（孤岛设计）:
 *   - product.template (le_product) — 商品权威信息源
 *   - le.label.item.master (le_warehouse) — Excel 上传的标签扩展数据
 *   - 两表通过共享 barcode 关联（无 FK），lookup 时按值 join
 *
 * 5 种 renderer 跟后端 render_type 对应：
 *   barcode (任何商品都打)
 *   food_label / health_food / special_label / ordinary_label (来自 master.render_type)
 */

/**
 * 按 barcode 查商品 + 营养标签 master 数据。
 *
 * 后端契约：
 *   GET /api/warehouse/labels/lookup?barcode=XXX
 *
 *   200 → {
 *     product: {
 *       id, sku, barcode, name_zh, name_en, brand, category
 *     },
 *     master_data: {                     // null = 没营养数据，前端只显示条码标签
 *       render_type: 'food_label',
 *       barcode, barcode2, description, product_no,
 *       ingredients, madeby, country_of_origin,
 *       net_content, net_content_alt,
 *       serving_size, servings_per_package, nutrition_unit,
 *       energy, protein, total_fat, sat_fat, trans_fat,
 *       carb, sugar, sodium,
 *       cautions, instructions, features, warning_text
 *     } | null
 *   }
 *   400 missing_barcode
 *   404 product_not_found     ← 主条码 + master.barcode + master.barcode2 全无命中
 */
export function lookupByBarcode(barcode) {
  return http.get('/warehouse/labels/lookup', { params: { barcode } })
}

/**
 * 上传 Excel 主数据（destructive overwrite — 整表替换）。
 *
 * 仅 internal user 可调；parttime kiosk 调会 403。
 * 上传期间拿 PG advisory lock；并发上传第二个 409 upload_in_progress。
 *
 * @param {File} file       browser File 对象 (.xlsx)
 * @param {(percent:number)=>void} onProgress  可选，0-100 上传进度回调
 *
 * @returns 200 {
 *   total, inserted, skipped_no_barcode,
 *   duration_ms,
 *   by_render_type: { food_label, health_food, special_label, ordinary_label }
 * }
 *   400 invalid_file / missing_barcode_column / parse_failed / no_valid_rows
 *   403 not_authorized
 *   409 upload_in_progress
 */
export function uploadMaster(file, onProgress) {
  const fd = new FormData()
  fd.append('file', file)
  return http.post('/warehouse/labels/master/upload', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress(evt) {
      if (!onProgress || !evt.total) return
      onProgress(Math.round((evt.loaded / evt.total) * 100))
    },
  })
}

/**
 * 主数据状态 — 给上传区显示当前 PG 里多少条 + 最近上传时间 / 用户。
 *
 * @returns 200 { count, last_upload_time, last_upload_by, last_upload_file }
 */
export function getMasterStatus() {
  return http.get('/warehouse/labels/master/status')
}
