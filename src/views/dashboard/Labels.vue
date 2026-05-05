<script setup>
/**
 * 商品標籤 — 出货作业中心 / Dashboard 系统
 *
 * 业务：仓库员工扫商品 barcode → 系统列出该商品配置的所有标签 →
 *      员工选数量 → 列印贴包裹（拆零 / 补打 / 食品营养标签等）
 *
 * 数据架构（路 A，跟另一个 Claude 在 Odoo 端配合）：
 *   - 标签类型 le.label.type 在 le_product 模块定义（5 种 render_type）
 *   - product.template 通过 m2m label_type_ids 关联适用的标签
 *   - barcode 类标签数据从 Odoo 拿（SKU/名/条码）
 *   - 其它 4 类（食品/保健/特殊/普通）的扩展数据沿用旧系统：
 *     员工上传 Excel → 前端 xlsx 库 parse → localStorage 缓存（不进 Odoo）
 *
 * 关键流程：
 *   1. 进页面看顶部 Excel 上传区状态（上次上传 / 数据条数）
 *   2. 扫 barcode → API GET /labels/lookup 拿商品 + 标签类型
 *   3. 前端遍历 label_types：
 *      - barcode 类 → 直接用 Odoo 数据渲染
 *      - 其它 → 从 localStorage 查 Excel 行数据
 *        - 找到 → 正常渲染
 *        - 找不到 → 标签卡片显示「⚠️ 缺營養數據」+ 列印按钮禁用
 *   4. 每张标签独立数量 + 独立列印按钮
 *   5. 列印用 window.print() + @page size 控制纸张（沿用旧系统）
 *
 * 限制：每个标签独立列印（不做"一键全打"）— 决策 7
 */
import { ref, computed, onActivated, nextTick } from 'vue'
import * as XLSX from 'xlsx'
import { labels as labelsApi } from '@/api'
import { showToast } from '@/composables/useToast'
import { renderLabel, printLabel } from '@/utils/labelRenderers'

// ============================================================
// 状态
// ============================================================
// 商品 + 标签查询
const barcodeInput = ref('')
const inputEl = ref(null)
const loading = ref(false)
const product = ref(null)        // { sku, barcode, name_zh, name_en, brand, ... }
const labelTypes = ref([])       // [{ id, code, name, render_type, size_width, size_height, needs_excel }]
const errorMsg = ref('')         // 商品没配标签 / 找不到 时显示

// 每个 label 的列印数量（key = labelType.id）
const printQty = ref({})

// 营养 Excel 缓存（沿用旧系统 localStorage 方案）
const LS_KEY_DATA = 'labelData'
const LS_KEY_TIME = 'lastUploadTime'
const excelData = ref({})              // { barcode: { A,B,F,G,...,AJ-AQ,...} }
const lastUploadTime = ref('')         // ISO string
const excelFileInputEl = ref(null)

const excelEntryCount = computed(() => Object.keys(excelData.value).length)
const hasExcelData = computed(() => excelEntryCount.value > 0)

// 最近扫过 — 快速重选
const recentBarcodes = ref([])    // 最多 5 条

// ============================================================
// 启动 / 切回页面 — 加载 localStorage 缓存
// ============================================================
function loadCache() {
  try {
    const raw = localStorage.getItem(LS_KEY_DATA)
    if (raw) excelData.value = JSON.parse(raw)
  } catch {
    excelData.value = {}
  }
  lastUploadTime.value = localStorage.getItem(LS_KEY_TIME) || ''
}

onActivated(() => {
  loadCache()
  nextTick(() => inputEl.value?.focus())
})

// ============================================================
// 营养 Excel 上传 / 清除
// ============================================================
function triggerExcelUpload() {
  excelFileInputEl.value?.click()
}

function onExcelChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = (ev) => {
    try {
      const arr = new Uint8Array(ev.target.result)
      const wb = XLSX.read(arr, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      const parsed = parseExcelRows(rows)
      excelData.value = parsed
      const ts = new Date().toISOString()
      lastUploadTime.value = ts
      localStorage.setItem(LS_KEY_DATA, JSON.stringify(parsed))
      localStorage.setItem(LS_KEY_TIME, ts)
      showToast(`✅ 已加載 ${Object.keys(parsed).length} 條營養數據`, 'success')
    } catch (err) {
      console.error(err)
      showToast(`Excel 解析失敗：${err.message}`, 'error')
    }
  }
  reader.readAsArrayBuffer(file)
  // 清掉 input value 让同一文件重新选时还能触发 change
  e.target.value = ''
}

/**
 * Excel 行数据按 barcode 索引。沿用旧系统 column letter 命名（A=barcode,
 * B=中文名, F=SKU, G=类型, AJ-AQ=营养字段...）。renderer 直接读这些列名。
 */
function parseExcelRows(rows) {
  if (!rows || rows.length < 2) return {}
  const out = {}
  // rows[0] 是表头（不要），rows[1+] 是数据
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length === 0) continue
    const barcode = row[0] ? String(row[0]).trim() : ''
    if (!barcode) continue

    // 把数组按 A B C ... AA AB ... 索引映射成对象
    const obj = {}
    row.forEach((val, idx) => {
      const key = colLetter(idx)
      if (key) obj[key] = val
    })
    out[barcode] = obj
  }
  return out
}

/** 0 -> 'A', 1 -> 'B', ..., 25 -> 'Z', 26 -> 'AA', 27 -> 'AB' ... */
function colLetter(idx) {
  if (idx < 0 || idx > 701) return null   // ZZ 之后不支持，业务用不到
  if (idx < 26) return String.fromCharCode(65 + idx)
  const a = Math.floor(idx / 26) - 1
  const b = idx % 26
  return String.fromCharCode(65 + a) + String.fromCharCode(65 + b)
}

function clearCache() {
  if (!confirm('確定清除已上傳的營養數據？清除後需要重新上傳。')) return
  excelData.value = {}
  lastUploadTime.value = ''
  localStorage.removeItem(LS_KEY_DATA)
  localStorage.removeItem(LS_KEY_TIME)
  showToast('🗑 已清除緩存', 'success')
}

const lastUploadDisplay = computed(() => {
  if (!lastUploadTime.value) return '從未上傳'
  try {
    return new Date(lastUploadTime.value).toLocaleString('zh-Hant', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return lastUploadTime.value
  }
})

// ============================================================
// 扫码 / 查商品
// ============================================================
async function lookup() {
  const bc = barcodeInput.value.trim()
  if (!bc) return
  loading.value = true
  errorMsg.value = ''
  product.value = null
  labelTypes.value = []
  try {
    const res = await labelsApi.lookupByBarcode(bc)
    product.value = res.product
    labelTypes.value = res.label_types || []
    // 初始化每个 label 的数量为 1
    const init = {}
    for (const lt of labelTypes.value) init[lt.id] = 1
    printQty.value = init

    // 加入最近扫过历史（去重 + 上限 5）
    const sku = res.product?.sku || bc
    recentBarcodes.value = [
      { barcode: bc, sku },
      ...recentBarcodes.value.filter(x => x.barcode !== bc),
    ].slice(0, 5)

    barcodeInput.value = ''
    nextTick(() => inputEl.value?.focus())
  } catch (err) {
    if (err.handledByInterceptor) return
    const code = err.response?.data?.error
    const respProd = err.response?.data?.product
    if (code === 'product_has_no_labels') {
      product.value = respProd
      errorMsg.value = '此商品未配置標籤類型，請聯絡主管在 Odoo 後台配置'
    } else if (code === 'product_not_found') {
      errorMsg.value = `找不到條碼 ${bc} 對應的商品`
    } else if (code === 'missing_barcode') {
      errorMsg.value = '請輸入條碼'
    } else {
      errorMsg.value = err.response?.data?.error || '查詢失敗'
    }
  } finally {
    loading.value = false
  }
}

function reuseRecent(item) {
  barcodeInput.value = item.barcode
  lookup()
}

function reset() {
  product.value = null
  labelTypes.value = []
  printQty.value = {}
  errorMsg.value = ''
  barcodeInput.value = ''
  nextTick(() => inputEl.value?.focus())
}

// ============================================================
// 列印 — 调 renderers 模块
// ============================================================
function getExcelRow(barcode) {
  return excelData.value[barcode] || null
}

function isLabelReady(labelType) {
  // barcode 类直接 OK；其它必须有 Excel 数据
  if (!labelType.needs_excel) return true
  if (!product.value) return false
  return !!getExcelRow(product.value.barcode)
}

function previewHtml(labelType) {
  if (!product.value) return ''
  const excelRow = labelType.needs_excel ? getExcelRow(product.value.barcode) : null
  const result = renderLabel(labelType, product.value, excelRow)
  return result.html
}

function doPrint(labelType) {
  if (!product.value) return
  if (!isLabelReady(labelType)) {
    showToast('缺營養數據，請先上傳 Excel', 'error')
    return
  }
  const qty = Math.max(1, parseInt(printQty.value[labelType.id]) || 1)
  const excelRow = labelType.needs_excel ? getExcelRow(product.value.barcode) : null
  printLabel(labelType, product.value, excelRow, qty)
}

function spinQty(labelTypeId, delta) {
  const cur = parseInt(printQty.value[labelTypeId]) || 1
  printQty.value[labelTypeId] = Math.max(1, cur + delta)
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10 max-w-4xl mx-auto">
    <!-- ========== 顶部：Excel 上传区 ========== -->
    <div class="g-card p-4 mb-5 sm:mb-6 bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-100">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <span class="text-2xl flex-shrink-0">📤</span>
          <div class="min-w-0">
            <div class="text-sm font-bold text-gray-800">營養數據</div>
            <div class="text-xs text-gray-500 mt-0.5">
              <span v-if="hasExcelData">
                已加載 <span class="font-semibold text-blue-600">{{ excelEntryCount }}</span> 條
                ｜ 上次上傳：{{ lastUploadDisplay }}
              </span>
              <span v-else class="text-amber-600">尚未上傳 — 食品 / 保健 / 特殊 / 普通類標籤需要先上傳</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <input
            ref="excelFileInputEl"
            type="file"
            accept=".xlsx,.xls"
            class="hidden"
            @change="onExcelChange"
          />
          <button class="g-btn g-btn-blue" style="padding:8px 18px;font-size:13px;" @click="triggerExcelUpload">
            {{ hasExcelData ? '🔄 重新上傳' : '📂 上傳 Excel' }}
          </button>
          <button
            v-if="hasExcelData"
            class="text-xs text-gray-400 hover:text-red-500 underline px-2"
            @click="clearCache"
          >🗑 清除</button>
        </div>
      </div>
    </div>

    <!-- ========== 中间：扫码输入 ========== -->
    <div class="flex items-center gap-3 mb-5 sm:mb-6 flex-wrap">
      <input
        ref="inputEl"
        v-model="barcodeInput"
        class="g-input flex-1"
        style="height:48px;min-width:0;"
        placeholder="🔍 掃描或輸入商品條碼"
        autocomplete="off"
        @keydown.enter="lookup"
      />
      <button class="g-btn g-btn-teal flex-shrink-0" style="padding:11px 24px;height:48px;"
              :disabled="loading" @click="lookup">
        {{ loading ? '查詢中…' : '查詢' }}
      </button>
      <button v-if="product || errorMsg" class="g-btn g-btn-pink flex-shrink-0" style="padding:11px 18px;height:48px;" @click="reset">
        重置
      </button>
    </div>

    <!-- 错误 / 商品没配标签 -->
    <div v-if="errorMsg" class="g-card p-5 sm:p-6 mb-5 border-l-4 border-red-400 bg-red-50">
      <div class="flex items-start gap-3">
        <span class="text-xl">⚠️</span>
        <div class="flex-1">
          <div class="text-sm font-bold text-red-700 mb-1">{{ errorMsg }}</div>
          <div v-if="product" class="text-xs text-gray-600 mt-2">
            商品：{{ product.name_zh || '—' }} · SKU {{ product.sku || '—' }}
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 商品 + 标签卡片 ========== -->
    <div v-if="product && labelTypes.length > 0">
      <!-- 商品基本信息 -->
      <div class="g-card p-4 sm:p-5 mb-5 border-l-4 border-teal-400">
        <div class="flex items-baseline gap-3 flex-wrap">
          <h2 class="text-lg sm:text-xl font-bold text-gray-800">{{ product.name_zh || '—' }}</h2>
          <span class="text-sm text-gray-500">{{ product.name_en }}</span>
        </div>
        <div class="flex items-center gap-3 text-xs text-gray-500 mt-2 flex-wrap">
          <span class="font-mono">SKU: <span class="text-blue-600 font-bold">{{ product.sku || '—' }}</span></span>
          <span class="text-gray-300">·</span>
          <span class="font-mono">Barcode: <span class="text-emerald-600 font-bold">{{ product.barcode || '—' }}</span></span>
          <span v-if="product.brand" class="text-gray-300">·</span>
          <span v-if="product.brand">{{ product.brand }}</span>
        </div>
      </div>

      <!-- 标签卡片网格 -->
      <div class="text-xs text-gray-400 mb-3">此商品有 {{ labelTypes.length }} 種標籤可列印：</div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div
          v-for="lt in labelTypes" :key="lt.id"
          class="g-card overflow-hidden"
          :class="!isLabelReady(lt) ? 'opacity-60' : ''"
        >
          <!-- 标签卡片头 -->
          <div class="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
            <div>
              <div class="text-sm font-bold text-gray-800">{{ lt.name }}</div>
              <div class="text-xs text-gray-400 mt-0.5">
                {{ lt.size_width }}×{{ lt.size_height }}mm · {{ lt.render_type }}
              </div>
            </div>
            <span v-if="lt.needs_excel" class="text-[10px] px-2 py-0.5 rounded font-bold"
                  :style="isLabelReady(lt)
                    ? 'background:#ecfdf5;color:#047857;'
                    : 'background:#fef3c7;color:#92400e;'">
              {{ isLabelReady(lt) ? '✓ 數據齊' : '⚠ 缺數據' }}
            </span>
          </div>

          <!-- 預覽（缩略） -->
          <div class="p-3 bg-white">
            <div class="border border-dashed border-gray-200 rounded p-2 overflow-hidden bg-gray-50"
                 style="max-height:300px;">
              <div v-if="isLabelReady(lt)" v-html="previewHtml(lt)"
                   style="position:relative; transform:scale(0.4); transform-origin:top left; width:250%;"></div>
              <div v-else class="text-center py-8 text-gray-400 text-sm">
                ⚠️ 缺營養數據<br/>
                <span class="text-xs">請先上傳 Excel 或此條碼不在當前 Excel 中</span>
              </div>
            </div>
          </div>

          <!-- 数量 + 列印 -->
          <div class="px-4 py-3 border-t border-gray-100 flex items-center justify-between flex-wrap gap-3">
            <div class="g-spinner">
              <input :value="printQty[lt.id] || 1" type="number" min="1"
                     @input="printQty[lt.id] = parseInt($event.target.value) || 1" />
              <div class="sp-btns">
                <button @click="spinQty(lt.id, 1)" type="button">▲</button>
                <button @click="spinQty(lt.id, -1)" type="button">▼</button>
              </div>
            </div>
            <button
              class="g-btn g-btn-pink"
              style="padding:8px 22px;font-size:13px;"
              :disabled="!isLabelReady(lt)"
              @click="doPrint(lt)"
            >🖨️ 列印</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 最近扫过 ========== -->
    <div v-if="recentBarcodes.length" class="mt-6 sm:mt-8">
      <div class="text-xs text-gray-400 mb-2">📜 最近：</div>
      <div class="flex items-center gap-2 flex-wrap">
        <button
          v-for="r in recentBarcodes" :key="r.barcode"
          class="px-3 py-1.5 text-xs rounded border bg-white border-gray-200 text-gray-600 hover:border-teal-400 hover:text-teal-600 transition-colors font-mono"
          @click="reuseRecent(r)"
        >{{ r.sku || r.barcode }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* g-input 强制可伸缩 */
@media (max-width: 767px) {
  .g-input {
    width: 100% !important;
  }
}
</style>
