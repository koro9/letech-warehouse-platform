import http from './http'

/**
 * 倉庫作業中心 — 板 / 格子 = Odoo 子库位（stock.location），数量 = stock.quant
 * 后端：le_warehouse/controllers/shelf.py
 *
 * 两个接口都返回一棵树，节点 = 库位：
 *   { id, name, full_name, barcode, own, total, children }
 *   own   = 本层（不含下层）
 *   total = 含所有下层的合计
 */

/**
 * 货架结构：整个仓库存树的位置层级 + 每个位置的件数 / SKU 数（不带商品明细）
 *
 *   GET /api/warehouse/shelf/structure?warehouse=<code>
 *   200 → {
 *     warehouse: { code, name },
 *     summary:   { on_hand, reserved, sku_count, location_count, empty_count,
 *                  unshelved, unshelved_sku_count },
 *     tree:      根 = 库存根库位；own = 本层 { on_hand, reserved, sku_count }，
 *                total = 含下层 { on_hand, reserved, sku_count, location_count }
 *   }
 */
export function getStructure(warehouse) {
  return http.get('/warehouse/shelf/structure', {
    params: warehouse ? { warehouse } : {},
  })
}

/**
 * 从 SKU 出发：商品在某仓库存树里的分布（只含有货的分支）
 *
 *   GET /api/warehouse/shelf/product?q=<SKU/条码>&warehouse=<code>
 *   200 → {
 *     product:   { sku, name, barcode },
 *     warehouse: { code, name },
 *     summary:   { on_hand, reserved, available, earliest_expiry, unshelved },
 *     tree:      根节点 = 仓库存根库位；根的 own 就是「未上架」
 *                own: { on_hand, reserved, available, earliest_expiry,
 *                       lots: [{ name, expiry, on_hand, reserved }] }
 *   }
 *   404 product_not_found → { suggestions: [{ sku, name }] }
 */
export function getProductBins(q, warehouse) {
  return http.get('/warehouse/shelf/product', {
    params: { q, ...(warehouse ? { warehouse } : {}) },
  })
}

/**
 * 从位置出发：某个板 / 格子连同所有下层位置上的商品（空位置也列出）
 *
 *   GET /api/warehouse/shelf/location?q=<库位条码/名称>   或   ?location_id=<id>
 *   200 → {
 *     location:  { id, name, full_name, barcode },
 *     warehouse: { code, name },
 *     summary:   { on_hand, reserved, available, sku_count, location_count, empty_count },
 *     products:  { <sku>: { name, multi, elsewhere } },
 *     tree:      查询库位为根；own.items = [{ sku, name, on_hand, reserved, available, earliest_expiry }]
 *   }
 *   404 location_not_found / location_ambiguous → { suggestions: [{ id, name, full_name, barcode }] }
 */
export function getLocationStock({ q, locationId, warehouse } = {}) {
  const params = {}
  if (locationId) params.location_id = locationId
  else if (q) params.q = q
  if (warehouse) params.warehouse = warehouse
  return http.get('/warehouse/shelf/location', { params })
}
