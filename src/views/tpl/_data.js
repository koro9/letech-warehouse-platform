/**
 * TPL 平台共享 mock 数据 — 抄自 demo
 * 后续接 Odoo 后端时这些应从 API 取，现阶段保持本地以匹配 demo 行为
 */

// 智能查询中心：本地资料库 5 条样本（demo 里也是 5 条）
export const LOCAL_DB = [
  { sku: 'LT10009829', barcode: '4710001334001', name: '有機燕麥片 500g',     nameEn: 'Organic Oat 500g',         brand: 'Yummy',      stock: 320 },
  { sku: 'LT10009830', barcode: '4710001334002', name: '天然蜂蜜 250ml',      nameEn: 'Natural Honey 250ml',      brand: 'Yummy',      stock: 150 },
  { sku: 'LT10009831', barcode: '4710002006003', name: '日式抹茶粉 100g',     nameEn: 'Japanese Matcha 100g',     brand: 'Anymall',    stock: 85  },
  { sku: 'LT10009832', barcode: '4710003050004', name: '椰子水 330ml',         nameEn: 'Coconut Water 330ml',      brand: 'Hello Bear', stock: 1200 },
  { sku: 'LT10009833', barcode: '4710005010005', name: '綜合堅果 200g',       nameEn: 'Mixed Nuts 200g',          brand: 'Homey',      stock: 450 },
]

// 4 个品牌 PDF 解析结果（mock）
export const BRAND_PARSED = {
  yummy: {
    parsed: 155,
    dups: [
      { id: 'YUM-102673', count: 2, pages: '20, 22' },
      { id: 'HAC-112011', count: 2, pages: '82, 84' },
      { id: 'KAM-112001', count: 2, pages: '124, 126' },
    ],
    items: [
      { sku: 'SANS-103261', name: '台灣 三叔公 牛軋餅 140g - 原味', bc: '4713072173645', date: '2026-09-13', qty: 5, act: 'nodata' },
      { sku: 'AGV-111262',  name: '台灣 愛之味 AGV 寒天檸檬愛玉冰 340g', bc: '4710626256410', date: '2027-08-28', qty: 5, act: 'print' },
      { sku: 'MNG-112343',  name: '台灣 森永 Hi-Chew 嗨啾 袋裝軟糖 85g',  bc: '4710035230391', date: '2026-12-18', qty: 6, act: 'print' },
    ],
  },
  anymall: {
    parsed: 182,
    dups: [],
    items: [
      { sku: 'T06-000461', name: 'SADOER維他命C甘油120ml',          bc: 'T06-000461', qty: 5,  act: 'print' },
      { sku: 'T05-000337', name: '【1000ml】加厚玻璃密封罐',          bc: 'T05-000337', qty: 10, act: 'print' },
      { sku: 'T05-000341', name: '【100張】圓形氣炸鍋紙 16cm',        bc: 'T05-000341', qty: 20, act: 'print' },
    ],
  },
  hellobear: {
    parsed: 85,
    dups: [],
    items: [
      { sku: 'BITA-102270A', name: '日本 Bitatto Okuchi 除菌漱口水 檸檬味 x2', bc: '45623846031179A', qty: 10, act: 'print',   hl: 1 },
      { sku: 'DAR-101357',   name: '日本 Dariya Salon De Pro 染髮洗頭水 250ml', bc: '4904651124398',   qty: 6,  act: 'noprint' },
      { sku: 'KAO-101069',   name: '日本 KAO 花王 Biore 卸妝潔面棉 44枚',       bc: '4901301280442',   qty: 6,  act: 'noprint' },
    ],
  },
  homey: {
    parsed: 106,
    dups: [],
    items: [
      { sku: 'AKIR-111786', name: '台灣 Akira 御衣坊 純水濕紙巾80抽',     bc: '4711409734408',  qty: 6,  tag: '普通Label',   act: 'normal' },
      { sku: 'LT10014725',  name: '台灣 康朵 防蟑蟑螂噴劑 500ml',          bc: '4712847921375',  qty: 7,  tag: '蟲蟲Label',   act: 'print', hl: 1 },
      { sku: 'LT10005786',  name: '台灣 極淨 香氛吸濕掛袋 小蒼蘭 x5',       bc: '4710898810129D', qty: 30, tag: 'Repack Label', act: 'print', hl: 1 },
    ],
  },
}

// 4 个品牌检测任务（带 5 位任务码）
export const INSPECT_BRANDS = {
  anymall: {
    name: 'Anymall', icon: '🛍️', color: '#6B9F5B', code: '82144', total: 1642,
    items: [
      { sku: 'T06-000461', name: 'SADOER維他命C甘油120ml',                  bc: 'T06-000461', req: 5 },
      { sku: 'T06-000488', name: '日式防滑靜音拖鞋 淺綠條紋 36-37',           bc: 'T06-000488', req: 2 },
      { sku: 'T05-000439', name: '【20pcs/包】一次性抽取式抹布（灰色）',      bc: '6974332512521', req: 2 },
    ],
  },
  hellobear: {
    name: 'Hello Bear', icon: '🐻', color: '#5B8EC9', code: '59914', total: 665,
    items: [
      { sku: 'BITA-102270A', name: '日本 Bitatto 除菌漱口水 x2',           bc: '45623846031179A', req: 10, tag: 'special' },
      { sku: 'DAR-101357',   name: '日本 Dariya 染髮洗頭水 250ml',          bc: '4904651124398',  req: 6 },
    ],
  },
  yummy: {
    name: 'Yummy', icon: '🍔', color: '#E6A23C', code: '49195', total: 1100,
    items: [
      { sku: 'SANS-103261', name: '台灣 三叔公 牛軋餅 140g',         bc: '4713072173645', req: 5 },
      { sku: 'AGV-111262',  name: '台灣 愛之味 寒天檸檬愛玉冰',      bc: '4710626256410', req: 5 },
    ],
  },
  homey: {
    name: 'Homey', icon: '🏡', color: '#D4667E', code: '42309', total: 1001,
    items: [
      { sku: 'AKIR-111786', name: '台灣 Akira 純水濕紙巾80抽',  bc: '4711409734408', req: 6 },
      { sku: 'LT10014725',  name: '台灣 康朵 防蟑噴劑 500ml',    bc: '4712847921375', req: 7 },
    ],
  },
}

// 各品牌页配置 — Yummy/Anymall/HelloBear/Homey 共享 BrandPage 时按这个传 props
export const BRAND_PAGE_CONFIG = {
  yummy:     { icon: '🍔', title: 'Yummy 3PL 系統',     subtitle: '上傳 HKTVmall Yummy Delivery Note 進行解析與列印', btnClass: 'g-btn-green',  hasDb: true,  showDate: true,  showTag: false },
  anymall:   { icon: '🛍️', title: 'Anymall 3PL 系統',   subtitle: '上傳 Anymall Delivery Note 進行極速解析',          btnClass: 'g-btn-green',  hasDb: false, showDate: false, showTag: false },
  hellobear: { icon: '🐻', title: 'Hello Bear 3PL 系統', subtitle: '上傳 Hello Bear Delivery Note 進行解析',           btnClass: 'g-btn-purple', hasDb: true,  showDate: false, showTag: false },
  homey:     { icon: '🏡', title: 'Homey 3PL 系統',     subtitle: '上傳 Homey Delivery Note 進行解析',                btnClass: 'g-btn-teal',   hasDb: true,  showDate: false, showTag: true  },
}
