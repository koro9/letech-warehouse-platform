/**
 * 5 种物理标签的渲染器 — 移植自旧 label_hk.html / label_wh.html
 *
 * 统一接口：renderer(labelType, productData, excelRow) -> { html, postRender? }
 *
 * 输入：
 *   - labelType   { code, name, render_type, size_width, size_height, ... } 来自 Odoo
 *   - productData { sku, barcode, name_zh, name_en, brand, ... }            来自 Odoo
 *   - excelRow    { A, B, F, G, I, T, X, AE, AG-AQ, AS-AY, ... }            来自 localStorage（旧 Excel 列）
 *
 * 输出：
 *   - html        生成的 HTML 字符串，塞进打印窗口 body
 *   - postRender? (printDoc) => void
 *                 打印窗口 DOM 写入后调，让 JsBarcode 等需要 DOM 的库能注入 SVG
 *
 * 数据来源约定：
 *   - render_type='barcode'              用 productData（Odoo 来的字段）
 *   - render_type='food_label'           用 excelRow（旧系统列：A,B,AG,AJ-AQ,AE,X,I,T,G）
 *   - render_type='health_food'          用 excelRow（A,B,I,AU,X,AS,T,AV,AH,AJ-AQ,G）
 *   - render_type='special_label'        用 excelRow（A,B,AW,AS,AU,I,AY,G）
 *   - render_type='ordinary_label'       用 excelRow（AS,G）
 */
import JsBarcode from 'jsbarcode'

// ============================================================
// barcode — 條碼標籤 (label_wh.html renderBarcodeLabel 移植)
// 数据来源：Odoo (barcode/sku/name_zh)，不需 Excel
// ============================================================
function renderBarcodeLabel(_labelType, product) {
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
// food_label — 食品營養標籤 (label_hk.html renderFoodLabel 移植)
// 210×150mm 大標籤 — 上：商品；中左：營養；中右：成分；下：日期
// ============================================================
function renderFoodLabel(_labelType, _product, data) {
  if (!data) return missingDataHtml('食品營養標籤')

  let html = ''
  // 分割線
  html += `<div style="position:absolute; top:30mm; left:0; width:210mm; height:2px; background:black;"></div>`
  html += `<div style="position:absolute; top:120mm; left:0; width:210mm; height:2px; background:black;"></div>`
  html += `<div style="position:absolute; top:30mm; left:73.5mm; width:2px; height:90mm; background:black;"></div>`

  // Top — 條碼 + 名
  html += `<div style="position:absolute; top:10mm; left:6mm; width:200mm;">`
  if (data.A) {
    const fz = data.A.toString().length > 20 ? 18 : 20
    html += `<div style="font-size:${fz}px; margin-bottom:2mm;">${esc(data.A)}</div>`
  }
  if (data.B) {
    const len = data.B.toString().length
    let fz = 20
    if (len > 50) fz = 18
    if (len > 80) fz = 16
    if (len > 120) fz = 14
    html += `<div style="font-size:${fz}px;">${esc(data.B)}</div>`
  }
  html += `</div>`

  // 中左 — 營養成分（10 條）
  html += `<div style="position:absolute; top:35mm; left:6mm; font-size:14px; font-weight:bold;">Nutrition Information</div>`
  html += `<div style="position:absolute; top:45mm; left:6mm; width:60mm; font-size:12px;">`
  const rows = [
    ['Serving Size:', data.AG],
    ['Energy:',       data.AJ],
    ['Protein:',      data.AK],
    ['Total fat:',    data.AL],
    ['- Saturated fat:', data.AM, /*indent*/ true],
    ['- Trans fat:',     data.AN, true],
    ['Carbohydrates:', data.AO],
    ['- Sugars:',     data.AP, true],
    ['Sodium:',       data.AQ],
    ['Net Content:',  data.AE],
    ['Country Of Origin:', data.X],
  ]
  for (const [label, val, indent] of rows) {
    html += `<div style="display:flex; justify-content:space-between; margin-bottom:3mm;${indent ? 'padding-left:5mm;' : ''}">`
    html += `<span>${label}</span><span>${esc(val ?? '')}</span></div>`
  }
  html += `</div>`

  // 中右 — 成分（I 列）
  if (data.I) {
    const fz = calcFitFontSize(data.I.toString(), 120 * MM_TO_PX, 80 * MM_TO_PX, 16, 8)
    html += `<div style="position:absolute; top:35mm; left:79.5mm; width:120mm; height:80mm; font-size:${fz}px;">${esc(data.I)}</div>`
  }

  // 下 — 廠商 + 保質期
  html += `<div style="position:absolute; top:125mm; left:6mm; width:120mm; height:20mm; font-size:18px;">${esc(data.T ?? '')}</div>`
  html += `<div style="position:absolute; top:125mm; right:6mm; text-align:right; font-size:16px;">`
  html += `<div>Best before(Date Format):</div><div>Show on package(見包裝)</div><div>此日期前最佳(Format CHI)</div>`
  html += `</div>`

  return { html }
}

// ============================================================
// health_food — 保健食品標籤 (label_hk.html renderHealthFoodLabel 移植，简化字号计算)
// 210×150mm — 左：商品+成分+底部信息；右：營養
// ============================================================
function renderHealthFoodLabel(_labelType, _product, data) {
  if (!data) return missingDataHtml('保健食品標籤')

  const leftWidth  = 126   // 60% of 210
  const rightWidth = 84    // 40%
  const rightTopH  = 45    // 30% of 150

  let html = ''
  // 分割線
  html += `<div style="position:absolute; top:0; left:${leftWidth}mm; width:2px; height:150mm; background:black;"></div>`
  html += `<div style="position:absolute; top:${rightTopH}mm; left:${leftWidth}mm; width:${rightWidth}mm; height:2px; background:black;"></div>`

  // 左 — 商品信息 + 成分 + 底部
  html += `<div style="position:absolute; top:10mm; left:6mm; width:${leftWidth - 12}mm;">`
  if (data.A) {
    const fz = data.A.toString().length > 20 ? 16 : 18
    html += `<div style="font-size:${fz}px; font-weight:bold; margin-bottom:1mm;">${esc(data.A)}</div>`
  }
  if (data.B) {
    const len = data.B.toString().length
    let fz = 18
    if (len > 50) fz = 16
    if (len > 80) fz = 14
    if (len > 120) fz = 12
    html += `<div style="font-size:${fz}px; font-weight:bold; margin-bottom:4mm;">${esc(data.B)}</div>`
  }
  if (data.I) {
    const fz = calcFitFontSize(data.I.toString(), (leftWidth - 12) * MM_TO_PX, 40 * MM_TO_PX, 18, 12)
    html += `<div style="font-size:${fz}px; margin-bottom:3mm;">`
    html += `<div style="font-weight:bold; margin-bottom:1mm;">Ingredient:</div>`
    html += `<div style="word-wrap:break-word;">${esc(data.I)}</div>`
    html += `</div>`
  }
  // 底部信息（小字）
  const sFz = 14
  if (data.AU) html += `<div style="font-size:${sFz}px; margin-bottom:1mm;">Net Content: ${esc(data.AU)}</div>`
  if (data.X)  html += `<div style="font-size:${sFz}px; margin-bottom:1mm;">Country Of Origin: ${esc(data.X)}</div>`
  if (data.AS) html += `<div style="font-size:${sFz}px; margin-bottom:1mm; word-wrap:break-word;">${esc(data.AS)}</div>`
  if (data.T)  html += `<div style="font-size:${sFz}px; margin-bottom:1mm; word-wrap:break-word;">${esc(data.T)}</div>`
  html += `<div style="font-size:${sFz}px; margin-bottom:0.5mm;">Best before(End YY-MM):</div>`
  html += `<div style="font-size:${sFz}px; margin-bottom:0.5mm;">Show on package(見包裝)</div>`
  html += `<div style="font-size:${sFz}px;">此日期前最佳(年月底)</div>`
  html += `</div>`

  // 右 — 營養（Serving Size + 8 项）
  html += `<div style="position:absolute; top:10mm; left:${leftWidth + 6}mm; width:${rightWidth - 12}mm;">`
  html += `<div style="font-size:14px; font-weight:bold; margin-bottom:6mm;">Nutrition Information</div>`
  if (data.AV) {
    html += `<div style="font-size:14px; margin-bottom:6mm;">Serving Size:</div>`
    html += `<div style="font-size:14px; margin-bottom:12mm;">${esc(data.AV)}</div>`
  }
  if (data.AH) html += `<div style="font-size:14px; margin-bottom:8mm;">${esc(data.AH)}</div>`

  const nFz = 14
  const rows2 = [
    ['Energy', data.AJ],
    ['Protein', data.AK],
    ['Total Fat', data.AL],
    ['Saturated', data.AM],
    ['Trans Fat', data.AN],
    ['Carbohydrate', data.AO],
    ['Sugars', data.AP],
    ['Sodium', data.AQ],
  ]
  for (const [k, v] of rows2) {
    if (v) html += `<div style="font-size:${nFz}px; margin-bottom:4mm;">${k}: ${esc(v)}</div>`
  }
  html += `</div>`

  return { html }
}

// ============================================================
// special_label — 蟲蟲特殊標籤 (label_hk.html renderSpecialLabel 移植)
// 210×150mm — 簡單表格列出 A,B + AW,AS,AU,I,AY 字段，動態字號
// ============================================================
function renderSpecialLabel(_labelType, _product, data) {
  if (!data) return missingDataHtml('特殊標籤')

  let html = `<table style="width:100%; border-collapse:collapse; margin:2mm 6mm;">`

  const all = [
    data.A, data.B,
    data.AW, data.AS, data.AU, data.I, data.AY,
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
// ordinary_label — 普通标签 (label_hk.html renderOrdinaryLabel 移植)
// 210×150mm — 单字段 AS 撑满，动态字号
// ============================================================
function renderOrdinaryLabel(_labelType, _product, data) {
  if (!data) return missingDataHtml('普通標籤')

  const txt = data.AS || ''
  if (!txt) {
    return { html: `<div style="padding:10mm; text-align:center; color:#999;">無 AS 列數據</div>` }
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

/** HTML 转义防 XSS（员工上传 Excel 内容直接拼 HTML 风险） */
function esc(s) {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 把文字塞进固定容器，二分法找适合的字号（精简版 calculateFontSize）。
 * 旧代码用 DOM 测量；这里只用字符数估算 + bound — 离线足够用。
 */
function calcFitFontSize(text, _wPx, _hPx, max = 18, min = 8) {
  const len = (text || '').toString().length
  if (len < 100)  return Math.min(max, 18)
  if (len < 300)  return 14
  if (len < 600)  return 12
  if (len < 1000) return 10
  return Math.max(min, 8)
}

/** 占位 — 缺 Excel 数据时显示 */
function missingDataHtml(labelTypeName) {
  return {
    html: `
      <div style="padding:20mm; text-align:center; color:#a00;">
        <div style="font-size:24px; font-weight:bold; margin-bottom:5mm;">⚠️ 缺營養數據</div>
        <div style="font-size:16px;">此商品的「${esc(labelTypeName)}」</div>
        <div style="font-size:16px;">需要先上傳營養 Excel</div>
      </div>
    `,
  }
}

// ============================================================
// 渲染分发 + 打印
// ============================================================
const RENDERERS = {
  barcode:        renderBarcodeLabel,
  food_label:     renderFoodLabel,
  health_food:    renderHealthFoodLabel,
  special_label:  renderSpecialLabel,
  ordinary_label: renderOrdinaryLabel,
}

/**
 * 调对应 renderer 生成单张 HTML（用于页面预览 + 打印）。
 *
 * 用法：
 *   const { html, postRender } = renderLabel(labelType, product, excelRow)
 *   document.getElementById('preview').innerHTML = html
 *   postRender?.(document)
 */
export function renderLabel(labelType, product, excelRow) {
  const fn = RENDERERS[labelType.render_type]
  if (!fn) {
    return {
      html: `<div style="padding:10mm; color:#a00;">⚠️ 未知標籤類型：${esc(labelType.render_type)}</div>`,
    }
  }
  return fn(labelType, product, excelRow)
}

/**
 * 触发打印 — 沿用旧系统的 window.open() + @page size + window.print()
 *
 * 多份打印：count > 1 时复制 N 份独立页面（每份独立的 SVG ID 防冲突）。
 * 浏览器会按 @page 设的纸张尺寸吐每页。
 */
export function printLabel(labelType, product, excelRow, count = 1) {
  const w = labelType.size_width
  const h = labelType.size_height

  // 每份独立 render —— barcode SVG ID 各张随机不冲突
  const pages = []
  const postRenders = []
  for (let i = 0; i < count; i++) {
    const result = RENDERERS[labelType.render_type]?.(labelType, product, excelRow)
    if (!result) continue
    pages.push(`<div class="label-page">${result.html}</div>`)
    if (result.postRender) postRenders.push(result.postRender)
  }

  const printWindow = window.open('', '_blank')
  if (!printWindow) {
    alert('瀏覽器阻止彈出列印視窗。請允許彈窗後重試。')
    return
  }
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>列印標籤</title>
      <style>
        * { box-sizing: border-box; }
        @page { size: ${w}mm ${h}mm; margin: 0; }
        body { margin: 0; padding: 0; font-family: 'Microsoft YaHei', Arial, sans-serif; }
        .label-page {
          width: ${w}mm; height: ${h}mm;
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
  printWindow.document.close()

  printWindow.onload = () => {
    // SVG / 动态内容渲染
    for (const fn of postRenders) {
      try { fn(printWindow.document) } catch (e) { console.error(e) }
    }
    // 给 SVG 一点点时间画完
    setTimeout(() => {
      printWindow.print()
      printWindow.close()
    }, 50)
  }
}
