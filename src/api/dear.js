import { dearFetch } from './dearHttp'

/**
 * DEAR (Cin7 Core) — 智能查詢中心使用
 * 后期改走 Odoo 后端代理时，把 dearFetch 替换成 http.get('/dear/...') 即可
 */

export function getProduct(sku) {
  return dearFetch('Product', { SKU: sku })
}

export function getAvailability(sku) {
  return dearFetch('ref/productavailability', { SKU: sku })
}
