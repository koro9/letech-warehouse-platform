import http from './http'

/**
 * 商品标签 — Dashboard 系统下「標籤」页
 *
 * 数据架构：
 *   - 标签类型 (le.label.type) 在 le_product 模块定义
 *   - product.template 通过 m2m label_type_ids 关联适用标签
 *   - barcode 类标签数据全在 Odoo（SKU/名/条码）
 *   - 其它 4 类（食品/保健/特殊/普通）的扩展数据沿用旧系统：
 *     前端 Excel 上传 → localStorage 缓存（不进 Odoo）
 *
 * 前端 5 种 renderer 跟后端 render_type 字段一一对应：
 *   barcode / food_label / health_food / special_label / ordinary_label
 */

/**
 * 按 barcode 查商品 + 适用标签类型清单。
 *
 * 后端契约：
 *   GET /api/warehouse/labels/lookup?barcode=XXX
 *
 *   200 → {
 *     product: {
 *       id, sku, barcode, name_zh, name_en, brand, category
 *     },
 *     label_types: [
 *       {
 *         id, code, name, render_type,
 *         size_width, size_height, needs_excel
 *       }
 *     ]
 *   }
 *   400 missing_barcode
 *   404 product_not_found
 *   422 product_has_no_labels   ← 商品没配 label_type_ids
 *                                  响应里也带 product 让前端展示是哪个商品
 */
export function lookupByBarcode(barcode) {
  return http.get('/warehouse/labels/lookup', { params: { barcode } })
}
