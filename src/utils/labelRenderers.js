/**
 * 5 种物理标签渲染器 — 移植自旧 label_hk.html / label_wh.html
 *
 * 职责拆分（跟数据来源对齐）：
 *
 *   barcode 类（条码标签）
 *     - 输入：product { barcode, sku, name_zh, ... } — 来自 product.template
 *     - 任何商品都能打；不依赖 master 数据
 *     - 数据源：lookup API 的 product 对象
 *
 *   food_label / health_food / special_label / ordinary_label（营养/警告类）
 *     - 输入：master_data { render_type, barcode, description, ingredients,
 *                          energy, protein, ..., cautions, ... } — 来自 le.label.item.master
 *     - render_type 决定 4 选 1
 *     - 数据源：lookup API 的 master_data 对象
 *
 * 字段命名约定：
 *   - 全部用 snake_case 英文字段名（barcode / energy / ingredients）
 *   - 不再用 Excel 字母列（data.A / data.AJ）— 跟后端 ORM 字段 1:1 对齐
 *
 * 尺寸 hardcode：
 *   - barcode 标签：100×70mm
 *   - 营养类标签：210×150mm（4 种统一尺寸）
 *   旧系统就是 hardcode；尺寸要改是代码改动，不是配置。
 */
import JsBarcode from 'jsbarcode'

// ============================================================
// 标签尺寸（mm）
// ============================================================
const BARCODE_SIZE   = { width: 100, height: 70 }
const NUTRITION_SIZE = { width: 210, height: 150 }   // 食品/保健/特殊/普通统一

// ============================================================
// barcode — 條碼標籤（用 product 数据）
// ============================================================
function renderBarcodeLabel(product) {
  const barcode = product.barcode || ''
  const sku     = product.sku || ''
  const name    = product.name_zh || ''
  const svgId   = 'bc_' + Math.random().toString(36).substring(2, 11)

  const html = `
    <div style="text-align:center; padding:2mm;">
      ${barcode ? `
        <div style="margin:2mm 0;">
          <svg id="${svgId}" width="96%" height="140"></svg>
        </div>` : ''}
      ${sku ? `<div style="font-size:32px; font-family:'Arial Narrow', sans-serif;">${esc(sku)}</div>` : ''}
      ${name ? `<div style="font-size:20px; font-weight:bold; font-family:'Arial Narrow', sans-serif;">${esc(name)}</div>` : ''}
    </div>
  `

  return {
    html,
    postRender(doc) {
      if (!barcode) return
      const svg = doc.getElementById(svgId)
      if (!svg) return
      JsBarcode(svg, barcode, {
        format: 'CODE128',
        width: 2.8,
        height: 140,
        displayValue: false,
        margin: 0,
      })
    },
  }
}

// ============================================================
// food_label — 食品營養標籤（用 master_data）
// 210×150mm 大標籤 — 上：商品；中左：營養；中右：成分；下：日期
// ============================================================
function renderFoodLabel(d) {
  if (!d) return missingDataHtml('食品營養標籤')

  let html = ''
  // 分割線
  html += `<div style="position:absolute; top:30mm; left:0; width:210mm; height:2px; background:black;"></div>`
  html += `<div style="position:absolute; top:120mm; left:0; width:210mm; height:2px; background:black;"></div>`
  html += `<div style="position:absolute; top:30mm; left:73.5mm; width:2px; height:90mm; background:black;"></div>`

  // Top — 條碼 + 名
  html += `<div style="position:absolute; top:10mm; left:6mm; width:200mm;">`
  if (d.barcode) {
    const fz = d.barcode.toString().length > 20 ? 18 : 20
    html += `<div style="font-size:${fz}px; margin-bottom:2mm;">${esc(d.barcode)}</div>`
  }
  if (d.description) {
    const len = d.description.toString().length
    let fz = 20
    if (len > 50) fz = 18
    if (len > 80) fz = 16
    if (len > 120) fz = 14
    html += `<div style="font-size:${fz}px;">${esc(d.description)}</div>`
  }
  html += `</div>`

  // 中左 — 營養成分
  html += `<div style="position:absolute; top:35mm; left:6mm; font-size:14px; font-weight:bold;">Nutrition Information</div>`
  html += `<div style="position:absolute; top:45mm; left:6mm; width:60mm; font-size:12px;">`
  const rows = [
    ['Serving Size:',       d.serving_size],
    ['Energy:',             d.energy],
    ['Protein:',            d.protein],
    ['Total fat:',          d.total_fat],
    ['- Saturated fat:',    d.sat_fat,    /*indent*/ true],
    ['- Trans fat:',        d.trans_fat,  true],
    ['Carbohydrates:',      d.carb],
    ['- Sugars:',           d.sugar,      true],
    ['Sodium:',             d.sodium],
    ['Net Content:',        d.net_content],
    ['Country Of Origin:',  d.country_of_origin],
  ]
  for (const [label, val, indent] of rows) {
    html += `<div style="display:flex; justify-content:space-between; margin-bottom:3mm;${indent ? 'padding-left:5mm;' : ''}">`
    html += `<span>${label}</span><span>${esc(val ?? '')}</span></div>`
  }
  html += `</div>`

  // 中右 — 成分
  if (d.ingredients) {
    const fz = calcFitFontSize(d.ingredients.toString(), 120 * MM_TO_PX, 80 * MM_TO_PX, 16, 8)
    html += `<div style="position:absolute; top:35mm; left:79.5mm; width:120mm; height:80mm; font-size:${fz}px;">${esc(d.ingredients)}</div>`
  }

  // 下 — 廠商 + 保質期
  // 廠商：旧 renderer 用 data.T (= Madeby_Prefix，"Manufacturer:") 是错的。
  // 新版用 madeby（真实地址），prefix 不要单独打。
  html += `<div style="position:absolute; top:125mm; left:6mm; width:120mm; height:20mm; font-size:18px;">${esc(d.madeby ?? '')}</div>`
  html += `<div style="position:absolute; top:125mm; right:6mm; text-align:right; font-size:16px;">`
  html += `<div>Best before(Date Format):</div><div>Show on package(見包裝)</div><div>此日期前最佳(Format CHI)</div>`
  html += `</div>`

  return { html }
}

// ============================================================
// health_food — 保健食品標籤（用 master_data）
// 210×150mm — 左：商品+成分+底部信息；右：營養
// ============================================================
function renderHealthFoodLabel(d) {
  if (!d) return missingDataHtml('保健食品標籤')

  const leftWidth  = 126   // 60% of 210
  const rightWidth = 84    // 40%
  const rightTopH  = 45    // 30% of 150

  let html = ''
  // 分割線
  html += `<div style="position:absolute; top:0; left:${leftWidth}mm; width:2px; height:150mm; background:black;"></div>`
  html += `<div style="position:absolute; top:${rightTopH}mm; left:${leftWidth}mm; width:${rightWidth}mm; height:2px; background:black;"></div>`

  // 左 — 商品信息 + 成分 + 底部
  html += `<div style="position:absolute; top:10mm; left:6mm; width:${leftWidth - 12}mm;">`
  if (d.barcode) {
    const fz = d.barcode.toString().length > 20 ? 16 : 18
    html += `<div style="font-size:${fz}px; font-weight:bold; margin-bottom:1mm;">${esc(d.barcode)}</div>`
  }
  if (d.description) {
    const len = d.description.toString().length
    let fz = 18
    if (len > 50) fz = 16
    if (len > 80) fz = 14
    if (len > 120) fz = 12
    html += `<div style="font-size:${fz}px; font-weight:bold; margin-bottom:4mm;">${esc(d.description)}</div>`
  }
  if (d.ingredients) {
    const fz = calcFitFontSize(d.ingredients.toString(), (leftWidth - 12) * MM_TO_PX, 40 * MM_TO_PX, 18, 12)
    html += `<div style="font-size:${fz}px; margin-bottom:3mm;">`
    html += `<div style="font-weight:bold; margin-bottom:1mm;">Ingredient:</div>`
    html += `<div style="word-wrap:break-word;">${esc(d.ingredients)}</div>`
    html += `</div>`
  }
  // 底部信息（小字）
  const sFz = 14
  if (d.net_content_alt)
    html += `<div style="font-size:${sFz}px; margin-bottom:1mm;">Net Content: ${esc(d.net_content_alt)}</div>`
  if (d.country_of_origin)
    html += `<div style="font-size:${sFz}px; margin-bottom:1mm;">Country Of Origin: ${esc(d.country_of_origin)}</div>`
  if (d.cautions)
    html += `<div style="font-size:${sFz}px; margin-bottom:1mm; word-wrap:break-word;">${esc(d.cautions)}</div>`
  if (d.madeby)
    html += `<div style="font-size:${sFz}px; margin-bottom:1mm; word-wrap:break-word;">${esc(d.madeby)}</div>`
  html += `<div style="font-size:${sFz}px; margin-bottom:0.5mm;">Best before(End YY-MM):</div>`
  html += `<div style="font-size:${sFz}px; margin-bottom:0.5mm;">Show on package(見包裝)</div>`
  html += `<div style="font-size:${sFz}px;">此日期前最佳(年月底)</div>`
  html += `</div>`

  // 右 — 營養（Serving Size + 8 项）
  html += `<div style="position:absolute; top:10mm; left:${leftWidth + 6}mm; width:${rightWidth - 12}mm;">`
  html += `<div style="font-size:14px; font-weight:bold; margin-bottom:6mm;">Nutrition Information</div>`
  if (d.instructions) {
    html += `<div style="font-size:14px; margin-bottom:6mm;">Serving Size:</div>`
    html += `<div style="font-size:14px; margin-bottom:12mm;">${esc(d.instructions)}</div>`
  }
  if (d.servings_per_package)
    html += `<div style="font-size:14px; margin-bottom:8mm;">${esc(d.servings_per_package)}</div>`

  const nFz = 14
  const rows2 = [
    ['Energy',       d.energy],
    ['Protein',      d.protein],
    ['Total Fat',    d.total_fat],
    ['Saturated',    d.sat_fat],
    ['Trans Fat',    d.trans_fat],
    ['Carbohydrate', d.carb],
    ['Sugars',       d.sugar],
    ['Sodium',       d.sodium],
  ]
  for (const [k, v] of rows2) {
    if (v) html += `<div style="font-size:${nFz}px; margin-bottom:4mm;">${k}: ${esc(v)}</div>`
  }
  html += `</div>`

  return { html }
}

// ============================================================
// special_label — 蟲蟲特殊標籤（用 master_data）
// 210×150mm — 表格列出條碼/名稱/特性/警告/容量/成分/警告字眼，動態字號
// ============================================================
function renderSpecialLabel(d) {
  if (!d) return missingDataHtml('特殊標籤')

  let html = `<table style="width:100%; border-collapse:collapse; margin:2mm 6mm;">`

  const all = [
    d.barcode, d.description,
    d.features, d.cautions, d.net_content_alt, d.ingredients, d.warning_text,
  ]
  for (const v of all) {
    if (!v) continue
    const len = v.toString().length
    let fz = 18
    if (len > 80)  fz = 16
    if (len > 150) fz = 14
    if (len > 250) fz = 12
    if (len > 350) fz = 10
    html += `<tr><td style="width:100%; font-size:${fz}px; padding:1.5mm 0; vertical-align:top; padding-right:10mm;">${esc(v)}</td></tr>`
  }

  html += `</table>`
  return { html }
}

// ============================================================
// ordinary_label — 普通標籤（用 master_data）
// 210×150mm — 单字段 cautions 撑满，动态字号
// ============================================================
function renderOrdinaryLabel(d) {
  if (!d) return missingDataHtml('普通標籤')

  const txt = d.cautions || ''
  if (!txt) {
    return { html: `<div style="padding:10mm; text-align:center; color:#999;">無 Cautions 資料</div>` }
  }

  // 容器可用区域（210-12 wide × 150-20 high in mm）
  const fz = calcFitFontSize(
    txt.toString(),
    (210 - 12) * MM_TO_PX,
    (150 - 20) * MM_TO_PX,
    72, 8,
  )

  const html = `
    <table style="width:100%; border-collapse:collapse; margin:10mm 6mm;">
      <tr>
        <td style="width:100%; font-size:${fz}px; padding:3mm 0; vertical-align:top; padding-right:10mm;">${esc(txt)}</td>
      </tr>
    </table>
  `
  return { html }
}

// ============================================================
// 公共工具
// ============================================================
const MM_TO_PX = 3.7795275591   // CSS standard 1mm = 3.7795 px

function esc(s) {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function calcFitFontSize(text, _wPx, _hPx, max = 18, min = 8) {
  const len = (text || '').toString().length
  if (len < 100)  return Math.min(max, 18)
  if (len < 300)  return 14
  if (len < 600)  return 12
  if (len < 1000) return 10
  return Math.max(min, 8)
}

function missingDataHtml(labelTypeName) {
  return {
    html: `
      <div style="padding:20mm; text-align:center; color:#a00;">
        <div style="font-size:24px; font-weight:bold; margin-bottom:5mm;">⚠️ 缺營養數據</div>
        <div style="font-size:16px;">此商品的「${esc(labelTypeName)}」</div>
        <div style="font-size:16px;">需要在後端上傳 Excel</div>
      </div>
    `,
  }
}

// ============================================================
// 营养类标签 4 种 renderer 派发
// ============================================================
const NUTRITION_RENDERERS = {
  food_label:     renderFoodLabel,
  health_food:    renderHealthFoodLabel,
  special_label:  renderSpecialLabel,
  ordinary_label: renderOrdinaryLabel,
}

// 4 种营养类标签的中文名（用于打印失败 / 缺数据时提示）
const NUTRITION_NAME_ZH = {
  food_label:     '食品營養標籤',
  health_food:    '保健食品標籤',
  special_label:  '特殊標籤',
  ordinary_label: '普通標籤',
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 渲染条码标签 HTML（任何商品都能打）
 *
 * @param {object} product { barcode, sku, name_zh }
 * @returns { html, postRender(doc) }
 */
export function renderBarcode(product) {
  return renderBarcodeLabel(product)
}

/**
 * 渲染营养类标签 HTML（食品/保健/特殊/普通 4 选 1）
 *
 * @param {object} masterData { render_type, barcode, description, ... }
 * @returns { html, postRender? }
 */
export function renderNutrition(masterData) {
  if (!masterData) return missingDataHtml('營養標籤')
  const fn = NUTRITION_RENDERERS[masterData.render_type]
  if (!fn) {
    return {
      html: `<div style="padding:10mm; color:#a00;">⚠️ 未知標籤類型：${esc(masterData.render_type)}</div>`,
    }
  }
  return fn(masterData)
}

/**
 * 标签元数据 — 给 UI 渲染卡片标题 / 派发尺寸用
 */
export const BARCODE_LABEL_META = {
  code: 'barcode',
  name: '條碼標籤',
  size_width:  BARCODE_SIZE.width,
  size_height: BARCODE_SIZE.height,
}

export function nutritionLabelMeta(renderType) {
  return {
    code: renderType,
    name: NUTRITION_NAME_ZH[renderType] || '營養標籤',
    size_width:  NUTRITION_SIZE.width,
    size_height: NUTRITION_SIZE.height,
  }
}

// ============================================================
// 触发打印 — 沿用旧系统的 window.open() + @page size + window.print()
// ============================================================

/**
 * 打印条码标签
 * @param {object} product
 * @param {number} count  份数
 */
export function printBarcodeLabel(product, count = 1) {
  _printBatch({
    width:  BARCODE_SIZE.width,
    height: BARCODE_SIZE.height,
    count,
    renderOne: () => renderBarcodeLabel(product),
  })
}

/**
 * 打印营养类标签
 * @param {object} masterData
 * @param {number} count
 */
export function printNutritionLabel(masterData, count = 1) {
  if (!masterData) return
  const fn = NUTRITION_RENDERERS[masterData.render_type]
  if (!fn) return
  _printBatch({
    width:  NUTRITION_SIZE.width,
    height: NUTRITION_SIZE.height,
    count,
    renderOne: () => fn(masterData),
  })
}

/**
 * 内部：用隐藏 iframe 触发列印 dialog
 *
 * 选 iframe 不选 window.open() 的关键原因：
 *   1. iframe 不受 popup blocker 限制 —— 异步链路 (await 后) 调也不会被拦
 *   2. 主页面直接弹 print dialog，不闪新 tab
 *   3. 配合 Chrome --kiosk-printing 启动标志可静默直接出纸（仓库部署）
 *
 * 多次调用：每次创建一个独立 iframe，print() 完 1 秒后自动 remove 清理。
 */
function _printBatch({ width, height, count, renderOne }) {
  const pages = []
  const postRenders = []
  for (let i = 0; i < count; i++) {
    const result = renderOne()
    if (!result) continue
    pages.push(`<div class="label-page">${result.html}</div>`)
    if (result.postRender) postRenders.push(result.postRender)
  }

  const iframe = document.createElement('iframe')
  // 隐藏但不能 display:none — 那样 print() 会失效
  iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0; opacity:0;'
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument || iframe.contentWindow.document
  doc.open()
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>列印標籤</title>
      <style>
        * { box-sizing: border-box; }
        @page { size: ${width}mm ${height}mm; margin: 0; }
        body { margin: 0; padding: 0; font-family: 'Microsoft YaHei', Arial, sans-serif; }
        .label-page {
          width: ${width}mm; height: ${height}mm;
          position: relative; overflow: hidden;
          page-break-after: always;
        }
        .label-page:last-child { page-break-after: auto; }
      </style>
    </head>
    <body>
      ${pages.join('')}
    </body>
    </html>
  `)
  doc.close()

  const triggerPrint = () => {
    // 跑 postRender (JsBarcode SVG 注入) 在打印之前
    for (const fn of postRenders) {
      try { fn(iframe.contentDocument) } catch (e) { console.error(e) }
    }
    // 给 SVG 一点点时间画完再 print
    setTimeout(() => {
      try {
        iframe.contentWindow.focus()
        iframe.contentWindow.print()
      } catch (e) {
        console.error('Print failed:', e)
      }
      // 1 秒后清理 iframe — 给 print dialog 时间打开
      // （太早 remove 会导致 dialog 取消；kiosk 模式直接出纸不需要 dialog 也安全）
      setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
      }, 1000)
    }, 50)
  }

  // doc.write 之后 readyState 通常已经是 complete，但保险起见两条路都走
  if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
    triggerPrint()
  } else {
    iframe.onload = triggerPrint
  }
}
