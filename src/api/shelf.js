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

/**
 * 未上架清单：库存根库位本层还有货的 SKU（还没放上任何板 / 格子），分页
 *
 *   GET /api/warehouse/shelf/unshelved?warehouse=&q=&scope=&sort=&page=&page_size=
 *     scope: all | started（只看已开始上架的 SKU）
 *     sort:  qty_desc（默认）| qty_asc | sku
 *   200 → {
 *     warehouse, summary: { unshelved_qty, unshelved_sku_count, shelved_qty, started_sku_count },
 *     products: [{ sku, name, barcode, unshelved, reserved, available, shelved, total, earliest_expiry }],
 *     page, page_size, total, total_pages, has_more
 *   }
 */
export function getUnshelved({ warehouse, q, scope, sort, page, pageSize } = {}) {
  const params = {}
  if (warehouse) params.warehouse = warehouse
  if (q) params.q = q
  if (scope) params.scope = scope
  if (sort) params.sort = sort
  if (page) params.page = page
  if (pageSize) params.page_size = pageSize
  return http.get('/warehouse/shelf/unshelved', { params })
}

/**
 * 目标位置候选（上架 / 轉出弹窗里扫码或输入）
 *   GET /api/warehouse/shelf/locations?q=&warehouse=
 *   200 → { warehouse, locations: [{ id, name, full_name, barcode }], has_more }
 *   条码精确命中排第一；q 为空列出全部板 / 格子
 */
export function getTargetLocations(q, warehouse) {
  const params = {}
  if (q) params.q = q
  if (warehouse) params.warehouse = warehouse
  return http.get('/warehouse/shelf/locations', { params })
}

/**
 * 上架 / 轉出：后台开一张「貨架移動」单（HSD4/BIN/…）并立即完成
 *   POST /api/warehouse/shelf/move
 *   body { sku, source_location_id, dest_location_id, qty }
 *   200 → { picking, sku, qty, source, dest, source_left }
 *   400 insufficient_qty（带 available）/ same_location / shelf_move_type_missing / move_failed …
 *   409 busy（同一商品有人正在移动）
 *
 * idempotencyKey：同一次确认重试时传同一个 key，后端只执行一次（防连按 / 网络重发）
 */
export function moveStock({ sku, sourceLocationId, destLocationId, qty }, idempotencyKey) {
  return http.post('/warehouse/shelf/move',
    { sku, source_location_id: sourceLocationId, dest_location_id: destLocationId, qty },
    idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined)
}
