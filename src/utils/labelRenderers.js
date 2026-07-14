/**
 * 标签渲染器 — 严格复刻旧系统 label.py 的 PDF 输出（70×50mm 热敏贴纸）
 *
 * 6 种 renderer：
 *   food_label         食品營養標籤 — generate_food_label
 *   health_food        保健食品標籤 — generate_health_food_label
 *   special_label      蟲蟲特殊標籤 — generate_special_label
 *   ordinary_label     普通標籤 — generate_ordinary_label（含动态字号）
 *   jelly_warning      果凍警告貼紙 — generate_jelly_label（粗体下划线居中 + 中英智能换行）
 *   extinguisher_label 滅火筒標籤 — generate_extinguisher_label（双语两栏 + 正则切 4 段）
 *
 * 坐标系约定：
 *   旧 ReportLab 用 bottom-left 原点；CSS 用 top-left 原点。
 *   我们用 `position: absolute; bottom: <y>mm; left: <x>mm;` 直接对应旧代码的
 *   draw_text(c, mm(x), mm(y), ...) 坐标，不做 y 翻转。
 *   字号用 pt 单位（跟 ReportLab fontSize 一致）。
 *
 * Outbound.vue 仍依赖 `printBarcodeLabel` 和 `printNutritionLabel` —— 这两个
 * 导出保留作为兼容层；内部统一走 `printLabels(labels, count)` 多页打印路径。
 */
import JsBarcode from 'jsbarcode'

// ============================================================
// 标签尺寸（mm）— 跟旧 label.py 的 pagesize=(mm(70), mm(50)) 严格一致
// ============================================================
const LABEL_W = 70
const LABEL_H = 50

// 默认字号（旧 label.py: DEFAULT_FONT_SIZE = 4，这里 pt 单位 1:1）
const DEFAULT_FZ = '4pt'
const DEFAULT_LH = '5pt'    // 旧 leading=5

// Barcode 标签尺寸（Outbound 用，跟旧版一样保持 100×70mm — 不是 70×50）
const BARCODE_W = 100
const BARCODE_H = 70

// ============================================================
// 打印用内嵌中文字体（方案 B）— 自托管「微软雅黑(msyh)」子集（~2.9MB）
//   旧系统(label.py)用 ReportLab 把 msyh.ttf 嵌进 PDF，所以任何机器都能显示中文；
//   AI 抄成 Web 客户端打印时只抄了字体「名」没抄字体「文件」→ Mac 上变空白。
//   这里把同一份 msyh 子集化(常用简繁中文+拉丁+标点，去 hinting)嵌进打印 HTML，
//   既跟旧标签字形 100% 一致，又能 Mac/Windows/Linux 任意平台打印出中文。
//   字体文件：public/fonts/LabelYaHei.woff2 → 部署后 /warehouse/fonts/...
//   打印 iframe 由 document.write 生成、无 base URL，故 @font-face 必须用「绝对 URL」。
// ============================================================
const LABEL_FONT_FAMILY = 'LabelCJK'
const LABEL_FONT_URL =
  (typeof window !== 'undefined' ? window.location.origin : '') +
  (import.meta.env.BASE_URL || '/') + 'fonts/LabelYaHei.woff2'
// 两档 @font-face:regular 走系统细体(Arial/PingFang/msyh),bold 走我们上传的 LabelYaHei
// 子集(它本身是 msyhbd 粗体,拉丁+中文都够粗)。这样细体两平台都清晰,粗体也在两平台都真粗。
const LABEL_FONT_FACE =
  `@font-face{font-family:'${LABEL_FONT_FAMILY}';font-style:normal;font-weight:400;` +
  `font-display:swap;src:local('Arial'),local('Helvetica Neue'),local('Microsoft YaHei'),local('PingFang SC');}` +
  `@font-face{font-family:'${LABEL_FONT_FAMILY}';font-style:normal;font-weight:700;` +
  `font-display:swap;src:url('${LABEL_FONT_URL}') format('woff2');}`
// 统一字体栈:LabelCJK 主家族(按 weight 分派) → 平台中文回退 → sans-serif 兜底
const LABEL_FONT_STACK =
  `'${LABEL_FONT_FAMILY}','PingFang SC','Microsoft YaHei','Hiragino Sans GB',` +
  `'Heiti SC','Noto Sans CJK SC','Noto Sans SC','Microsoft JhengHei',sans-serif`

// 打印前等内嵌字体加载完再 print()，否则字体没下载好会打成空白。
// 3s 兜底：字体加载失败也照打（回退系统字体），不卡住。
function _printWhenFontReady(doc, run) {
  let done = false
  const go = () => { if (!done) { done = true; try { run() } catch (e) { console.error(e) } } }
  try {
    if (doc && doc.fonts && doc.fonts.load) {
      Promise.all([
        doc.fonts.load(`16px '${LABEL_FONT_FAMILY}'`),
        doc.fonts.load(`bold 16px '${LABEL_FONT_FAMILY}'`),
      ]).then(() => doc.fonts.ready).then(go).catch(go)
      setTimeout(go, 3000)
    } else {
      go()
    }
  } catch (e) { go() }
}

// ============================================================
// 公共工具
// ============================================================
function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 解析 expiry_date 字段 — 旧 label.py get_expiry_date_text() 的端口
 * 输入：'2026-12-31' / 'YY-MM-DD' / 'YY-MM' / '' / null
 * 输出：{ en: '...', zh: '...' } 给 food_label 右下角用；空字串表示 fallback 到默认
 */
function formatExpiryDate(raw) {
  if (!raw) return { en: '', zh: '' }
  let s = String(raw).trim()
  if (!s || s.toLowerCase() === 'nan') return { en: '', zh: '' }

  // 去掉 "00:00:00" 时间部分
  if (s.endsWith('00:00:00')) s = s.split(' ')[0]
  s = s.replace(/\//g, '-')

  // 模板值场景
  const upper = s.toUpperCase()
  if (upper === 'YY-MM-DD' || upper === 'YYYY-MM-DD') {
    return { en: 'YY-MM-DD', zh: '年-月-日' }
  }
  if (upper === 'YY-MM' || upper === 'YYYY-MM') {
    return { en: 'YY-MM', zh: '年-月' }
  }

  const parts = s.split('-').map(p => p.trim()).filter(Boolean)
  if (parts.length >= 3) {
    return {
      en: parts.slice(0, 3).join('-'),
      zh: `${parts[0]}年${parts[1]}月${parts[2]}日`,
    }
  }
  if (parts.length === 2) {
    return {
      en: parts.slice(0, 2).join('-'),
      zh: `${parts[0]}年${parts[1]}月`,
    }
  }
  return { en: s, zh: s }
}

/**
 * 中英智能换行 — 旧 label.py jelly 标签的中英边界自动插入 <br/>
 * 用于 jelly 警告语，让中英文各自一行（正则跟旧 python 等价）
 */
function autoWrapBilingual(text) {
  if (!text) return ''
  // 1. 中文/中文标点 后接 英文/数字 → 在中间插换行
  let out = text.replace(/([一-龥。，！？：；])\s*(?=[a-zA-Z0-9])/g, '$1<br/>')
  // 2. 英文/数字/英文标点 后接 中文 → 同样插换行
  out = out.replace(/([a-zA-Z0-9.!?:;])\s*(?=[一-龥])/g, '$1<br/>')
  return out
}

/**
 * 自动缩字号 — 给加了 .label-fit 类的元素用
 *
 * 何时调：_printBatch 在 print() 之前对 iframe 内整个 doc 跑一次。
 *
 * 逻辑：
 *   1. 读元素当前 font-size (px)
 *   2. 检查 scrollHeight/scrollWidth 是否超过 clientHeight/clientWidth
 *   3. 如果溢出，font-size 减 0.5px、line-height 同步缩，再检查
 *   4. 直到不溢出 或 font-size <= MIN_PX (≈ 3pt) 或循环达上限
 *
 * 设计要点：
 *   - **opt-in by class** —— 没加 .label-fit 的元素完全不动，不会影响其他 renderer
 *   - 元素必须有限宽 + 限高（max-height）才有意义；纯字号是按内容缩
 *   - 同步缩 line-height 维持视觉行间距比例
 */
function autofitOne(el) {
  if (!el || !el.textContent || !el.textContent.trim()) return
  const win = el.ownerDocument.defaultView
  if (!win) return
  const computed = win.getComputedStyle(el)
  let fontPx = parseFloat(computed.fontSize)
  if (!fontPx || isNaN(fontPx)) return

  const MIN_PX = 4         // ~3pt 下限，再小印不出来
  const STEP_PX = 0.5
  const MAX_ITER = 50      // 安全阀，理论上 (currentPx - 4) / 0.5 步内必收敛

  for (let i = 0; i < MAX_ITER; i++) {
    const overflowH = el.scrollHeight > el.clientHeight + 1
    const overflowW = el.scrollWidth  > el.clientWidth  + 1
    if (!overflowH && !overflowW) break
    if (fontPx <= MIN_PX) break
    fontPx -= STEP_PX
    el.style.fontSize = fontPx + 'px'
    el.style.lineHeight = (fontPx * 1.25) + 'px'
  }
}

function autofitAll(doc) {
  if (!doc) return
  const elements = doc.querySelectorAll('.label-fit')
  for (const el of elements) {
    try { autofitOne(el) } catch (_) { /* 单个失败不影响其他 */ }
  }
}

/**
 * 普通标签动态字号 — 旧 generate_ordinary_label 的逻辑端口
 * 文本越短字号越大，铺满标签
 */
function pickOrdinaryFontSize(text) {
  const len = (text || '').length
  if (len < 70)  return { fz: '20pt', lh: '20pt' }
  if (len < 200) return { fz: '14pt', lh: '14pt' }
  if (len < 400) return { fz: '8pt',  lh: '8pt'  }
  return { fz: '4pt', lh: '5pt' }
}

// ============================================================
// renderer 1: food_label — 食品營養標籤
// ============================================================
// 复刻 generate_food_label 的精确坐标：
//   分割线：mm(43) 上、mm(8.8) 下、mm(24.5) 中竖
//   上层：barcode mm(2,48), description mm(2,45)
//   中左：Nutrition + 10 行表（左对齐 label，右对齐值到 x=22.5）
//   中右：ingredients 段落 mm(26.5,38) 宽 40mm
//   下左：T (madeby_prefix) 段落 mm(2,4.8) 宽 43mm
//   下右：Best before 3 行 mm(50, 6.8/4.8/2.8)
function renderFoodLabel(d) {
  if (!d) return { html: missingHtml('食品營養標籤') }

  // Best before 格式 — 旧 label.py get_expiry_date_text 取 Expiry_Date_Format(AE),
  // fallback expiry_date(AD)。中文 sub-text 已 deprecated。
  const expiryFmt = String(d.expiry_date_format ?? d.expiry_date ?? '').trim()

  // Ingredients + Allergen(P)— 旧 generate_food_label:有致敏物就接落成分末尾
  let ingredientText = String(d.ingredients ?? '').trim()
  const allergenText = String(d.allergen ?? '').trim()
  if (allergenText && allergenText.toLowerCase() !== 'nan') {
    const sep = ingredientText && !/[.。 ]$/.test(ingredientText) ? ' ' : ''
    ingredientText = `${ingredientText}${sep}Allergen specified ingredients: ${allergenText}`
  }

  // 营养表（label, 字段值）— 跟旧 generate_food_label 严格对齐
  // Servings Per Package 在 Serving Size 上面(y=37),旧逻辑有这行
  const rows = [
    ['Servings Per Package:', d.servings_per_package, 37],
    ['Serving Size:',     d.serving_size,  35],
    ['Energy:',           d.energy,        33],
    ['Protein:',          d.protein,       31],
    ['Total fat:',        d.total_fat,     29],
    ['- Saturated fat:',  d.sat_fat,       27],
    ['- Trans fat:',      d.trans_fat,     25],
    ['Carbohydrates:',    d.carb,          23],
    ['- Sugars:',         d.sugar,         21],
    ['Sodium:',           d.sodium,        19],
    ['Net Content:',      d.net_content,   17],
    ['Country Of Origin:', d.country_of_origin, 15],
  ]

  let nutritionRows = ''
  for (const [label, val, y] of rows) {
    // 单行 flex 容器（固定宽 20.5mm = 左2mm→右22.5mm，与原坐标一致）：
    // 标签左、值右 space-between；加 .label-fit，标签或值过长时自动缩字号，
    // 杜绝两者横向重叠（如 Servings Per Package / Net Content 长值）。
    nutritionRows += `
      <div class="label-fit" style="position:absolute; bottom:${y}mm; left:2mm; width:20.5mm; overflow:hidden; white-space:nowrap; display:flex; justify-content:space-between; gap:0.8mm; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH};">
        <span style="flex:0 0 auto;">${esc(label)}</span>
        <span style="flex:0 0 auto;">${esc(val ?? '')}</span>
      </div>
    `
  }

  // Best before 两行 — 对齐旧 generate_food_label(中文 sub-text 已 deprecated):
  //   "Best before(格式):" + "Show on package",格式取 Expiry_Date_Format(AE)
  const beforeBlock = `
      <div style="position:absolute; bottom:5.5mm; left:50mm; font-size:${DEFAULT_FZ};">Best before(${esc(expiryFmt || 'Date Format')}):</div>
      <div style="position:absolute; bottom:2.5mm; left:50mm; font-size:${DEFAULT_FZ};">Show on package</div>
    `

  // 分割线（1.5px 黑线）
  const lines = `
    <div style="position:absolute; bottom:43mm; left:0; width:${LABEL_W}mm; height:1.5px; background:#000;"></div>
    <div style="position:absolute; bottom:8.8mm; left:0; width:${LABEL_W}mm; height:1.5px; background:#000;"></div>
    <div style="position:absolute; bottom:8.8mm; left:24.5mm; width:1.5px; height:${43 - 8.8}mm; background:#000;"></div>
  `

  return {
    html: `
      ${lines}
      <!-- 上层 -->
      <div style="position:absolute; bottom:48mm; left:2mm; font-size:${DEFAULT_FZ}; font-weight:bold;">${esc(d.barcode ?? '')}</div>
      <div style="position:absolute; bottom:45mm; left:2mm; font-size:${DEFAULT_FZ}; font-weight:bold;">${esc(d.description ?? '')}</div>

      <!-- 中左 — Nutrition 标题 + 10 行表 -->
      <div style="position:absolute; bottom:40mm; left:2mm; font-size:${DEFAULT_FZ}; font-weight:bold;">Nutrition Information</div>
      ${nutritionRows}

      <!-- 中右 — Ingredients 自适应段落（旧 draw_paragraph 顶部锚定 y=38，向下排；
           故用 top 定位贴顶，与左边 Nutrition 标题齐平，而非 bottom 贴底往上长） -->
      <div style="position:absolute; top:10mm; left:26.5mm; width:40mm; max-height:27.5mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word; word-break:break-word;">${esc(ingredientText)}</div>

      <!-- 下左 — Madeby_Prefix 段落 (T 列) + Storage (U 列) 在其下方，对齐旧 generate_food_label -->
      <div style="position:absolute; top:42.5mm; left:2mm; width:43mm; max-height:4mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word;">${esc(d.madeby_prefix ?? '')}</div>
      <div style="position:absolute; bottom:2.5mm; left:2mm; width:43mm; max-height:3mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word;">${esc(d.storage ?? '')}</div>

      <!-- 下右 — Best before -->
      ${beforeBlock}
    `,
  }
}

// ============================================================
// renderer 2: health_food — 保健食品標籤
// ============================================================
// 复刻 generate_health_food_label，并对长文本字段加 .label-fit 类让
// _printBatch 打印前自动缩字号（避免文字压到 Best before 区域）：
//   分割线：竖线 mm(42) 0-50；横线 mm(42 → 70, y=35)
//   左：A、B、Ingredient+I、Net Content+AU、Country+X、AS、T、Best before
//   右：Nutrition Information 标题 + Serving Size + AV/AH + 8 项营养
//
// 跟旧 PDF 的位置微调（解决 madeby_prefix 跟 Best before 垂直重叠）：
//   madeby_prefix bottom 9 → 11mm（让出 ~2mm 给 Best before line 1）
//   cautions      bottom 15 → 16mm，max-height 3 → 6mm（增高让自动缩字有空间）
//   description 加 width:38mm 限制不溢出右栏
function renderHealthFoodLabel(d) {
  if (!d) return { html: missingHtml('保健食品標籤') }

  const lines = `
    <div style="position:absolute; bottom:35mm; left:42mm; width:${LABEL_W - 42}mm; height:1.5px; background:#000;"></div>
    <div style="position:absolute; bottom:0; left:42mm; width:1.5px; height:${LABEL_H}mm; background:#000;"></div>
  `

  // 右侧营养 8 项（旧代码 fontSize=4，标题用 5pt）
  const nutriRows = [
    ['Energy',       d.energy,    29],
    ['Protein',      d.protein,   26],
    ['Total Fat',    d.total_fat, 23],
    ['Saturated',    d.sat_fat,   20],
    ['Trans Fat',    d.trans_fat, 17],
    ['Carbohydrate', d.carb,      14],
    ['Sugars',       d.sugar,     11],
    ['Sodium',       d.sodium,    8],
  ]
  let rightRows = ''
  for (const [k, v, y] of nutriRows) {
    rightRows += `
      <div style="position:absolute; bottom:${y}mm; left:44mm; font-size:${DEFAULT_FZ};">${esc(k)}: ${esc(v ?? '')}</div>
    `
  }

  return {
    html: `
      ${lines}

      <!-- 左侧产品信息 -->
      <div style="position:absolute; bottom:47mm; left:2mm; font-size:${DEFAULT_FZ}; font-weight:bold;">${esc(d.barcode ?? '')}</div>
      <!-- description: 限宽 + label-fit 自动缩字号防溢出 -->
      <div class="label-fit" style="position:absolute; bottom:42mm; left:2mm; width:38mm; max-height:4mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; font-weight:bold; word-wrap:break-word;">${esc(d.description ?? '')}</div>
      <!-- ingredient: 长文本自动缩字号 -->
      <div class="label-fit" style="position:absolute; bottom:30mm; left:2mm; width:38mm; max-height:10mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word;">Ingredient:${esc(d.ingredients ?? '')}</div>
      <div style="position:absolute; bottom:26mm; left:2mm; width:38mm; overflow:hidden; white-space:nowrap; font-size:${DEFAULT_FZ};">Net Conent:${esc(d.net_content_alt ?? '')}</div>
      <div style="position:absolute; bottom:23mm; left:2mm; width:38mm; overflow:hidden; white-space:nowrap; font-size:${DEFAULT_FZ};">Country Of Origin:${esc(d.country_of_origin ?? '')}</div>
      <!-- cautions: 加高 + label-fit -->
      <div class="label-fit" style="position:absolute; bottom:16mm; left:2mm; width:38mm; max-height:6mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word;">${esc(d.cautions ?? '')}</div>
      <!-- madeby_prefix: 位置上提 (9→11) 避免压 Best before；label-fit -->
      <div class="label-fit" style="position:absolute; bottom:11mm; left:2mm; width:38mm; max-height:4mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word;">${esc(d.madeby_prefix ?? '')}</div>

      <!-- 左下 Best before -->
      <div style="position:absolute; bottom:8mm; left:2mm; font-size:${DEFAULT_FZ};">Best before(End YY-MM):</div>
      <div style="position:absolute; bottom:6mm; left:2mm; font-size:${DEFAULT_FZ};">此日期前最佳(年月底)</div>
      <div style="position:absolute; bottom:4mm; left:2mm; font-size:${DEFAULT_FZ};">Show on package(見包裝)</div>

      <!-- 右侧 — 营养标题 + serving size -->
      <div style="position:absolute; bottom:48mm; left:44mm; font-size:5pt; font-weight:bold;">Nutrition Information</div>
      <div style="position:absolute; bottom:45mm; left:44mm; font-size:5pt;">Serving Size:</div>
      <div style="position:absolute; bottom:42mm; left:44mm; font-size:${DEFAULT_FZ};">${esc(d.instructions ?? '')}</div>
      <div style="position:absolute; bottom:32mm; left:44mm; font-size:${DEFAULT_FZ};">${esc(d.servings_per_package ?? '')}</div>

      <!-- 右侧 — 8 行营养值 -->
      ${rightRows}
    `,
  }
}

// ============================================================
// renderer 3: special_label — 蟲蟲特殊標籤
// ============================================================
// 复刻 generate_special_label：
//   字段顺序 A, B, AW (features), AS (cautions), AU (net_content_alt),
//             I (ingredients), AY (warning_text)
//   从 mm(46) 自上而下，每段后空 mm(2)，宽 mm(66)
function renderSpecialLabel(d) {
  if (!d) return { html: missingHtml('特殊標籤') }

  const fields = [
    d.barcode,
    d.description,
    d.features,
    d.cautions,
    d.net_content_alt,
    d.ingredients,
    d.warning_text,
  ]

  // 自上而下排版。字号/行高只放在容器(.label-fit)上,子块不设字号 → 继承;
  // 打印前 autofitAll 会缩容器字号到不溢出,子块跟着缩(随字数增加自动缩小,内容全保留)。
  let blocks = ''
  for (const v of fields) {
    if (!v) continue
    blocks += `<div style="margin-bottom:1.5mm; word-wrap:break-word;">${esc(v)}</div>`
  }

  return {
    html: `
      <div class="label-fit" style="position:absolute; top:3mm; left:2mm; width:66mm; max-height:45mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-break:break-word;">
        ${blocks}
      </div>
    `,
  }
}

// ============================================================
// renderer 4: ordinary_label — 普通標籤（动态字号）
// ============================================================
// 复刻 generate_ordinary_label：
//   单字段 cautions (AS)，按文本长度选 4 / 8 / 14 / 20pt 4 档字号
//   按 "．" 分段独立段落（旧代码 split）
function renderOrdinaryLabel(d) {
  if (!d) return { html: missingHtml('普通標籤') }

  const txt = d.cautions || ''
  if (!txt) {
    return { html: '<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#999; font-size:6pt;">無 Cautions 資料</div>' }
  }

  const { fz, lh } = pickOrdinaryFontSize(txt)
  const segments = String(txt).split('．')
  let blocks = ''
  for (const seg of segments) {
    if (!seg.trim()) continue
    blocks += `<div style="font-size:${fz}; line-height:${lh}; margin-bottom:0.5mm; word-wrap:break-word;">${esc(seg)}</div>`
  }

  return {
    html: `
      <div style="position:absolute; top:4mm; left:2mm; right:2mm; bottom:2mm; overflow:hidden;">
        ${blocks}
      </div>
    `,
  }
}

// ============================================================
// renderer 5: jelly_warning — 果凍警告貼紙（食品标签后第二张）
// ============================================================
// 复刻 generate_jelly_label：
//   全居中 + 粗体 + 下划线 + 中英智能换行 (autoWrapBilingual)
//   默认 fallback 文本（旧代码空时用的）
//   字号 10pt 粗体
function renderJellyWarning(d) {
  const data = d || {}
  let txt = (data.cautions || '').trim()
  if (!txt || txt.toLowerCase() === 'nan') {
    // 旧 label.py 默认文本
    txt = '注意：勿一口吞食，長者及兒童須在監護下食用。Caution: Do not swallow whole.'
  }

  // 用智能换行 + 每行加下划线
  const wrapped = autoWrapBilingual(txt)
  const lines = wrapped.split('<br/>')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => `<span style="text-decoration:underline; text-underline-offset:2px;">${esc(l)}</span>`)
    .join('<br/>')

  return {
    html: `
      <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:5mm; box-sizing:border-box;">
        <div style="text-align:center; font-size:10pt; line-height:14pt; font-weight:bold; word-wrap:break-word;">
          ${lines}
        </div>
      </div>
    `,
  }
}

// ============================================================
// renderer 6: extinguisher_label — 滅火筒標籤（双语两栏）
// ============================================================
// 复刻 generate_extinguisher_label：
//   1. Unicode 防雷已在后端 ingest 时处理（loader），前端不再做
//   2. 正则切 4 段：適於撲滅 / Suitable for / 使用方法 / Instructions for
//   3. 中文左栏粗体 5pt，英文右栏 4pt
//   4. bullet 缩进 (A./B./E./F. + 1./2./3.)
function renderExtinguisherLabel(d) {
  if (!d) return { html: missingHtml('滅火筒標籤') }

  const cautions = (d.cautions || '').trim() || '找不到 Cautions 資料'

  // 切 4 段
  const re = /(適於撲滅[\s\S]*?)(Suitable for[\s\S]*?)(使用方法[\s\S]*?)(Instructions for[\s\S]*)/i
  const m = cautions.match(re)

  let chFeat, enFeat, chInst, enInst
  if (m) {
    chFeat = formatBullets(m[1])
    enFeat = formatBullets(m[2])
    chInst = formatBullets(m[3])
    enInst = formatBullets(m[4])
  } else {
    chFeat = formatBullets(cautions)
    enFeat = chInst = enInst = ''
  }

  // 列宽：(70 - 4.8 - 3 - 2) / 2 = 30.1mm （margin_left=4.8 / margin_right=3 / gap=2）
  const colW = (LABEL_W - 4.8 - 3 - 2) / 2
  const styleCh = 'font-size:5pt; line-height:6pt; font-weight:bold;'
  const styleEn = 'font-size:4pt; line-height:6pt; font-weight:bold;'

  return {
    html: `
      <!-- 第一区块：火灾种类 -->
      <div style="position:absolute; top:2mm; left:4.8mm; width:${colW}mm; ${styleCh}">${chFeat}</div>
      <div style="position:absolute; top:2mm; left:${4.8 + colW + 2}mm; width:${colW}mm; ${styleEn}">${enFeat}</div>
      <!-- 第二区块：使用方法（旧代码下移留间距 mm(2)） -->
      <div style="position:absolute; top:24mm; left:4.8mm; width:${colW}mm; ${styleCh}">${chInst}</div>
      <div style="position:absolute; top:24mm; left:${4.8 + colW + 2}mm; width:${colW}mm; ${styleEn}">${enInst}</div>
    `,
  }
}

/**
 * Bullet 格式化 — 端口 generate_extinguisher_label 的 format_bullets()
 * 中文：A.固體/B.可燃/E.帶電/F.烹調 + 1.拔出/2.離火/3.按住
 * 英文：A. Solid / B. Flammable / E. Electrical / F. Cooking + 1. Pull / 2. Stand / 3. Press
 */
function formatBullets(sec) {
  if (!sec) return ''
  let s = String(sec)
  // 中文 bullet
  s = s
    .replace('A.固體', '<br/>A. 固體')
    .replace('B.可燃', '<br/>B. 可燃')
    .replace('E.帶電', '<br/>E. 帶電')
    .replace('F.烹調', '<br/>F. 烹調')
    .replace('1.拔出', '<br/>1. 拔出')
    .replace('2.離火', '<br/>2. 離火')
    .replace('3.按住', '<br/>3. 按住')
  // 英文 bullet（兼容 1.Pull / 1. Pull 两种空格写法）
  s = s
    .replace('A. Solid', '<br/>A. Solid')
    .replace('B. Flammable', '<br/>B. Flammable')
    .replace('E. Electrical', '<br/>E. Electrical')
    .replace('F. Cooking', '<br/>F. Cooking')
    .replace(/1\.\s*Pull/, '<br/>1. Pull')
    .replace(/2\.\s*Stand/, '<br/>2. Stand')
    .replace(/3\.\s*Press/, '<br/>3. Press')
  // 标题之后接单个 <br/>（不是双换行）
  s = s
    .replace('適於撲滅以下4種初期火災:', '適於撲滅以下4種初期火災:<br/>')
    .replace(
      'Suitable for extinguishing the following 4 types of initial fires:',
      'Suitable for extinguishing the following 4 types of initial fires:<br/>',
    )
    .replace('使用方法:', '使用方法:<br/>')
    .replace('Instructions for use:', 'Instructions for use:<br/>')
  return esc(s).replace(/&lt;br\/&gt;/g, '<br/>')
}

// ============================================================
// 数据缺失占位
// ============================================================
function missingHtml(typeName) {
  return `
    <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#a00; padding:5mm; text-align:center;">
      <div style="font-size:10pt; font-weight:bold; margin-bottom:2mm;">⚠️ 缺資料</div>
      <div style="font-size:6pt;">${esc(typeName)} 主數據缺失，請在 Odoo 後台補錄</div>
    </div>
  `
}

// ============================================================
// renderer 7: pet_food_label — 寵物糧標籤
// ============================================================
// 复刻 label.py 的 generate_pet_food_label:版式跟 food_label 完全一样,
// 只是营养项换成宠物粮粗成分(Crude Protein/Fat/Fibre + Moisture),
// 下左用 Distributor(BD)代替 Madeby_Prefix, 下右 Best before + Show on package。
// 右侧成分 = ingredients(pet food 从 AT 列读),**不拼过敏原**。
function renderPetFoodLabel(d) {
  if (!d) return { html: missingHtml('寵物糧標籤') }

  const expiryFmt = String(d.expiry_date_format ?? d.expiry_date ?? '').trim()
  const ingredientText = String(d.ingredients ?? '').trim()

  // 9 行营养表 — 对应 label.py generate_pet_food_label 里 y=37..21 的 label
  const rows = [
    ['Servings Per Package:', d.servings_per_package,  37],
    ['Serving Size:',         d.serving_size,          35],
    ['Energy:',               d.energy,                33],
    ['Crude Protein:',        d.crude_protein,         31],
    ['Crude Fat:',            d.crude_fat,             29],
    ['Crude Fibre:',          d.crude_fibre,           27],
    ['Moisture:',             d.moisture,              25],
    ['Net Content:',          d.net_content_alt,       23],
    ['Country Of Origin:',    d.country_of_origin,     21],
  ]

  let nutritionRows = ''
  for (const [label, val, y] of rows) {
    nutritionRows += `
      <div class="label-fit" style="position:absolute; bottom:${y}mm; left:2mm; width:20.5mm; overflow:hidden; white-space:nowrap; display:flex; justify-content:space-between; gap:0.8mm; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH};">
        <span style="flex:0 0 auto;">${esc(label)}</span>
        <span style="flex:0 0 auto;">${esc(val ?? '')}</span>
      </div>
    `
  }

  const beforeBlock = `
      <div style="position:absolute; bottom:5.5mm; left:50mm; font-size:${DEFAULT_FZ};">Best before(${esc(expiryFmt || 'Date Format')}):</div>
      <div style="position:absolute; bottom:2.5mm; left:50mm; font-size:${DEFAULT_FZ};">Show on package</div>
    `

  const lines = `
    <div style="position:absolute; bottom:43mm; left:0; width:${LABEL_W}mm; height:1.5px; background:#000;"></div>
    <div style="position:absolute; bottom:8.8mm; left:0; width:${LABEL_W}mm; height:1.5px; background:#000;"></div>
    <div style="position:absolute; bottom:8.8mm; left:24.5mm; width:1.5px; height:${43 - 8.8}mm; background:#000;"></div>
  `

  return {
    html: `
      ${lines}
      <!-- 上层 -->
      <div style="position:absolute; bottom:48mm; left:2mm; font-size:${DEFAULT_FZ}; font-weight:bold;">${esc(d.barcode ?? '')}</div>
      <div style="position:absolute; bottom:45mm; left:2mm; font-size:${DEFAULT_FZ}; font-weight:bold;">${esc(d.description ?? '')}</div>

      <!-- 中左 — Nutrition 标题 + 9 行营养表 -->
      <div style="position:absolute; bottom:40mm; left:2mm; font-size:${DEFAULT_FZ}; font-weight:bold;">Nutrition Information</div>
      ${nutritionRows}

      <!-- 中右 — Ingredients(AT) -->
      <div style="position:absolute; top:10mm; left:26.5mm; width:40mm; max-height:27.5mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word; word-break:break-word;">${esc(ingredientText)}</div>

      <!-- 下左 — Distributor(BD) + Storage(BE) -->
      <div style="position:absolute; top:42.5mm; left:2mm; width:46mm; max-height:4mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word;">${esc(d.distributor ?? '')}</div>
      <div style="position:absolute; bottom:2.5mm; left:2mm; width:46mm; max-height:4mm; overflow:hidden; font-size:${DEFAULT_FZ}; line-height:${DEFAULT_LH}; word-wrap:break-word;">${esc(d.storage ?? '')}</div>

      <!-- 下右 — Best before -->
      ${beforeBlock}
    `,
  }
}

// ============================================================
// renderer 总表 — 按 render_type 派发
// ============================================================
const RENDERERS = {
  food_label:         renderFoodLabel,
  health_food:        renderHealthFoodLabel,
  pet_food_label:     renderPetFoodLabel,
  special_label:      renderSpecialLabel,
  ordinary_label:     renderOrdinaryLabel,
  jelly_warning:      renderJellyWarning,
  extinguisher_label: renderExtinguisherLabel,
}

const TYPE_NAME_ZH = {
  food_label:         '食品營養標籤',
  health_food:        '保健食品標籤',
  pet_food_label:     '寵物糧標籤',
  special_label:      '特殊標籤',
  ordinary_label:     '普通標籤',
  jelly_warning:      '果凍警告貼紙',
  extinguisher_label: '滅火筒標籤',
}

// ============================================================
// 公开 API — 渲染 / 元数据
// ============================================================

/**
 * 渲染单张营养类标签（按 render_type 派发到对应 renderer）
 * @param {object} masterData { render_type, ... }
 * @returns {{ html: string, postRender?: function }}
 */
export function renderNutrition(masterData) {
  if (!masterData) return { html: missingHtml('營養標籤') }
  const fn = RENDERERS[masterData.render_type]
  if (!fn) {
    return {
      html: `<div style="padding:5mm; color:#a00; font-size:6pt;">⚠️ 未知標籤類型：${esc(masterData.render_type)}</div>`,
    }
  }
  return fn(masterData)
}

/**
 * 渲染单张标签（按 render_type / type 派发，新接口）
 * @param {object} entry { render_type, data }
 */
export function renderLabelEntry(entry) {
  if (!entry || !entry.render_type) return { html: missingHtml('標籤') }
  const fn = RENDERERS[entry.render_type]
  if (!fn) {
    return {
      html: `<div style="padding:5mm; color:#a00; font-size:6pt;">⚠️ 未知標籤類型：${esc(entry.render_type)}</div>`,
    }
  }
  return fn(entry.data || {})
}

/**
 * 营养类标签元数据（card title / 尺寸提示用）
 */
export function nutritionLabelMeta(renderType) {
  return {
    code: renderType,
    name: TYPE_NAME_ZH[renderType] || '營養標籤',
    size_width:  LABEL_W,
    size_height: LABEL_H,
  }
}

/**
 * 标签元数据（新接口）— 给 Labels.vue 多卡片渲染用
 */
export function labelEntryMeta(renderType) {
  return nutritionLabelMeta(renderType)
}

// ============================================================
// barcode 标签 — Outbound 用，旧 100×70 尺寸保留
// ============================================================
function renderBarcodeLabel(product) {
  const barcode = product?.barcode || ''
  const sku     = product?.sku || ''
  const name    = product?.name_zh || ''
  const svgId   = 'bc_' + Math.random().toString(36).substring(2, 11)

  const html = `
    <div style="text-align:center; padding:2mm;">
      ${barcode ? `<div style="margin:2mm 0;"><svg id="${svgId}" width="96%" height="140"></svg></div>` : ''}
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

export function renderBarcode(product) {
  return renderBarcodeLabel(product)
}

export const BARCODE_LABEL_META = {
  code: 'barcode',
  name: '條碼標籤',
  size_width:  BARCODE_W,
  size_height: BARCODE_H,
}

// ============================================================
// 打印 API
// ============================================================

/**
 * 打印多张营养类标签（新接口 — 给 Labels.vue 拿到 labels 数组后用）
 *
 * @param {Array<{ render_type, data }>} labels
 * @param {number} count 整组打几份（每份包含 labels 内所有页）
 *
 * 物理效果（举例 labels=[food, jelly], count=2）：
 *   page 1: food_label
 *   page 2: jelly_warning
 *   page 3: food_label   ← 第 2 份开始
 *   page 4: jelly_warning
 */
export function printLabels(labels, count = 1) {
  if (!labels || !labels.length) return
  _printBatch({
    width:  LABEL_W,
    height: LABEL_H,
    count,
    renderOne: () => {
      // 一份 = labels 数组里所有页拼起来
      const parts = labels.map(entry => renderLabelEntry(entry))
      return {
        // 多页拼接的特殊处理 —— 在 _printBatch 内部处理 page-break
        _multi: parts,
      }
    },
  })
}

/**
 * 打印营养类标签（旧接口 — Outbound.vue 用，单张 master_data）
 * 兼容层：内部转发到 printLabels；如果 master_data.has_jelly_warning 也会附加 jelly 页
 */
export function printNutritionLabel(masterData, count = 1) {
  if (!masterData) return
  const labels = [{ render_type: masterData.render_type, data: masterData }]
  if (masterData.has_jelly_warning) {
    labels.push({ render_type: 'jelly_warning', data: masterData })
  }
  printLabels(labels, count)
}

/**
 * 打印条码标签（Outbound 用）
 */
export function printBarcodeLabel(product, count = 1) {
  _printBatch({
    width:  BARCODE_W,
    height: BARCODE_H,
    count,
    renderOne: () => renderBarcodeLabel(product),
  })
}

// ============================================================
// 内部：用隐藏 iframe 触发列印 dialog（保持原行为）
// ============================================================
function _printBatch({ width, height, count, renderOne }) {
  const pages = []
  const postRenders = []
  for (let i = 0; i < count; i++) {
    const result = renderOne()
    if (!result) continue
    if (result._multi) {
      // 多页一份（labels 数组）— 把每页 push 进 pages
      for (const part of result._multi) {
        pages.push(`<div class="label-page">${part.html}</div>`)
        if (part.postRender) postRenders.push(part.postRender)
      }
    } else {
      pages.push(`<div class="label-page">${result.html}</div>`)
      if (result.postRender) postRenders.push(result.postRender)
    }
  }
  if (!pages.length) return

  const iframe = document.createElement('iframe')
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
        /* 强制保留 background-color / image —— 浏览器默认打印时会去掉底色省墨，
           但我们用 background:#000 的 div 画分割线，去了线就消失。
           必须用 print-color-adjust: exact（含 -webkit-前缀给老 Chromium）。 */
        * {
          box-sizing: border-box;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        ${LABEL_FONT_FACE}
        @page { size: ${width}mm ${height}mm; margin: 0; }
        html, body { margin: 0; padding: 0; font-family: ${LABEL_FONT_STACK}; }
        .label-page {
          width: ${width}mm; height: ${height}mm;
          position: relative; overflow: hidden;
          page-break-after: always;
        }
        .label-page:last-child { page-break-after: auto; }
      </style>
    </head>
    <body>${pages.join('')}</body>
    </html>
  `)
  doc.close()

  const triggerPrint = () => {
    // 先等内嵌中文字体加载完，再做 postRender / autofit / 打印
    // （autofit 要量文字宽度，必须在真实字体下量，否则字号算错）
    _printWhenFontReady(iframe.contentDocument, () => {
      // 1. 各 renderer 自己的 postRender（如 barcode SVG 注入）
      for (const fn of postRenders) {
        try { fn(iframe.contentDocument) } catch (e) { console.error(e) }
      }
      // 2. 全局 autofit — 统一处理所有 .label-fit 元素的自动缩字号
      //    这条只对加了 class 的元素生效；没标的 renderer 完全不受影响
      try { autofitAll(iframe.contentDocument) } catch (e) { console.error(e) }
      setTimeout(() => {
        try {
          iframe.contentWindow.focus()
          iframe.contentWindow.print()
        } catch (e) {
          console.error('Print failed:', e)
        }
        setTimeout(() => {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
        }, 1000)
      }, 50)
    })
  }

  if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
    triggerPrint()
  } else {
    iframe.onload = triggerPrint
  }
}

// ============================================================
// 揀貨單 & Repack 標籤 — 新增 (2026-06)
// ============================================================

/**
 * Internal: print pre-rendered label objects
 * labelResults: [{ html, postRender? }]
 */
function _printRaw(labelResults, width, height) {
  const pages = []
  const postRenders = []
  for (const r of labelResults) {
    if (!r?.html) continue
    pages.push(`<div class="label-page">${r.html}</div>`)
    if (r.postRender) postRenders.push(r.postRender)
  }
  if (!pages.length) return

  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;'
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument || iframe.contentWindow.document
  doc.open()
  doc.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      *{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
      ${LABEL_FONT_FACE}
      @page{size:${width}mm ${height}mm;margin:0;}
      html,body{margin:0;padding:0;font-family:${LABEL_FONT_STACK};}
      .label-page{width:${width}mm;height:${height}mm;position:relative;overflow:hidden;page-break-after:always;}
      .label-page:last-child{page-break-after:auto;}
    </style></head><body>${pages.join('')}</body></html>`)
  doc.close()
  const triggerPrint = () => {
    _printWhenFontReady(doc, () => {
      for (const fn of postRenders) { try { fn(doc) } catch (e) {} }
      setTimeout(() => {
        try { iframe.contentWindow.focus(); iframe.contentWindow.print() } catch (e) {}
        setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe) }, 1000)
      }, 80)
    })
  }
  if (doc.readyState === 'complete') triggerPrint()
  else iframe.onload = triggerPrint
}

/**
 * 揀貨單標籤 (100×150mm) — 每個 (SKU × 批次) 一張
 *   item: { sku, name, qty (or reqQty), barcode, expDate?, lotRef? }
 *
 *   字體大小參考 Pick List_100×150mm.pdf 原稿：
 *     SKU 22pt 粗體 / 中文名 14pt / Exp 14pt / 數量 18pt 粗體 /
 *     barcode 90% 寬高 140 / 條碼字 11pt 粗體 / 底部 lot 15pt
 */
export function generatePickListLabel(item) {
  const svgId = `bc-pl-${Math.random().toString(36).slice(2, 8)}`
  const barcode = String(item.barcode || '')
  const qty = parseInt(item.qty) || parseInt(item.reqQty) || 0
  const expDate = item.expDate ? String(item.expDate) : ''
  const lotRef = item.lotRef ? String(item.lotRef) : ''
  const html = `
    <div style="width:100mm;height:150mm;position:relative;display:flex;flex-direction:column;align-items:center;padding:6mm 4mm 5mm;box-sizing:border-box;font-family:${LABEL_FONT_STACK};">
      <div style="font-size:22pt;font-weight:bold;text-align:center;margin-bottom:4mm;word-break:break-all;line-height:1.1;">${esc(item.sku || '')}</div>
      <div style="font-size:14pt;text-align:center;margin-bottom:2mm;line-height:1.25;">${esc(item.name || '')}</div>
      ${expDate ? `<div style="font-size:14pt;text-align:center;margin-bottom:2mm;">Exp Date: ${esc(expDate)}</div>` : ''}
      <div style="font-size:18pt;font-weight:bold;text-align:center;margin-bottom:4mm;">數量: ${qty}</div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;">
        ${barcode ? `<svg id="${svgId}" style="width:92%;"></svg>` : ''}
        <div style="font-size:11pt;text-align:center;margin-top:1.5mm;letter-spacing:1px;font-weight:bold;">*${esc(barcode)}*</div>
      </div>
      ${lotRef || expDate ? `<div style="font-size:15pt;text-align:center;margin-top:3mm;">${esc(lotRef)}${lotRef && expDate ? ' -' : ''}${esc(expDate)}</div>` : ''}
    </div>`
  const postRender = barcode ? (doc) => {
    const svg = doc.getElementById(svgId)
    if (!svg) return
    try {
      JsBarcode(svg, barcode, { format: 'CODE128', width: 2.5, height: 140, displayValue: false, margin: 2 })
    } catch (e) { console.warn('PickList barcode failed:', e) }
  } : null
  return { html, postRender }
}

/**
 * Repack 標籤 (70×50mm) — 條碼上大圖 + 條碼文字 + 中文名
 * item: { barcode, name }
 */
export function generateRepackLabel(item) {
  const svgId = `bc-rp-${Math.random().toString(36).slice(2, 8)}`
  const barcode = String(item.barcode || '')
  const html = `
    <div style="width:70mm;height:50mm;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:1mm 2mm 1.5mm;box-sizing:border-box;font-family:${LABEL_FONT_STACK};">
      <div style="flex:1;display:flex;align-items:center;justify-content:center;width:100%;">
        ${barcode ? `<svg id="${svgId}" style="width:95%;"></svg>` : ''}
      </div>
      <div style="font-size:8pt;font-weight:bold;text-align:center;letter-spacing:1px;margin:1mm 0 0.5mm;">${esc(barcode)}</div>
      <div style="font-size:6.5pt;text-align:center;line-height:1.2;max-height:10mm;overflow:hidden;">${esc(item.name || '')}</div>
    </div>`
  const postRender = barcode ? (doc) => {
    const svg = doc.getElementById(svgId)
    if (!svg) return
    try {
      JsBarcode(svg, barcode, { format: 'CODE128', width: 2, height: 55, displayValue: false, margin: 1 })
    } catch (e) { console.warn('Repack barcode failed:', e) }
  } : null
  return { html, postRender }
}

/**
 * 列印揀貨單 — 一張 TR 的所有品項，每品項一張 100×150mm label
 * items: [{ sku, name, reqQty, barcode }]
 */
export function printPickList(items) {
  if (!items?.length) return
  _printRaw(items.map(item => generatePickListLabel(item)), 100, 150)
}

/**
 * 列印 Repack 標籤 — qty 張 70×50mm repack label
 * item: { barcode, name }
 */
export function printRepackLabels(item, qty = 1) {
  const n = Math.max(1, Math.min(parseInt(qty) || 1, 500))
  // 每張 label 都要 generateRepackLabel(item) 新 instance — Array.fill() 會
  // 將同一個 {html,postRender} 放 n 份，所有 SVG 用同一個 id，
  // JsBarcode 只 render 到第一張，後面全部冇 barcode。
  _printRaw(Array.from({ length: n }, () => generateRepackLabel(item)), 70, 50)
}

