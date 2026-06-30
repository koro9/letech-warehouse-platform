<script setup>
/**
 * 商品標籤 — 出货作业中心 / Dashboard 系统
 *
 * 业务流（重写后）：
 *   1. 標籤主數據改在 Odoo 後台維護（CRUD）— Inventory → WMS → Label Master
 *      上傳 Excel 路徑保留但移出 WMS UI（後台 wizard 觸發）
 *
 *   2. 員工掃 barcode → API GET /labels/lookup → 拿 product + labels[]
 *      labels 数组按业务规则返回 1-2 张：
 *        - food_label 主标签
 *        - jelly_warning 附加警告（仅 master.has_jelly_warning=True 时）
 *        - 或单独 health_food / special / ordinary / extinguisher
 *
 *   3. 員工選列印份數 → 點「列印全部」→ 一次 print job 出 N×labels.length 张
 *      (多页通过 CSS page-break-after 控制)
 *
 * 跟旧版差异：
 *   - 去掉独立 barcode 标签卡片（旧系统 label.py 只有营养类标签，barcode 不单独）
 *   - 去掉 Excel 上传 UI（搬到 Odoo 后台维护）
 *   - 标签尺寸 70×50mm（跟旧 PDF 严格对齐，从 100×70/210×150 改）
 *   - 支持 jelly 双张连打（food + warning）
 *   - 支持 extinguisher 单张
 */
import { ref, onActivated, nextTick } from 'vue'
import { labels as labelsApi } from '@/api'
import { showToast } from '@/composables/useToast'
import {
  renderLabelEntry,
  printLabels,
  labelEntryMeta,
} from '@/utils/labelRenderers'

// ============================================================
// 状态
// ============================================================
const barcodeInput = ref('')
const inputEl = ref(null)
const loading = ref(false)
const product = ref(null)        // { sku, barcode, name_zh, name_en, brand }
const labels = ref([])           // [{ render_type, data }, ...]
const errorMsg = ref('')

// 整组打印份数（每份 = labels 数组所有张一起打）
const printQty = ref(1)
const printing = ref(false)

// 主数据状态显示
const status = ref({ count: 0, last_upload_time: '', last_upload_by: '' })

// 最近扫过 — 快速重选
const recentBarcodes = ref([])

// ============================================================
// 启动 / 切回页面
// ============================================================
async function loadStatus() {
  try {
    status.value = await labelsApi.getMasterStatus()
  } catch (err) {
    if (!err.handledByInterceptor) {
      console.warn('Failed to load label master status:', err)
    }
  }
}

onActivated(() => {
  loadStatus()
  nextTick(() => inputEl.value?.focus())
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
  labels.value = []
  try {
    const res = await labelsApi.lookupByBarcode(bc)
    product.value = res.product
    labels.value = res.labels || []
    printQty.value = 1

    if (!labels.value.length && product.value) {
      // 商品有但主数据空 — 提示去 Odoo 后台补
      errorMsg.value = '此商品在主數據中無記錄，無法生成標籤。請在 Odoo → Inventory → WMS → Label Master 補錄。'
    }

    // 加入最近扫过历史
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
    if (code === 'product_not_found') {
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
  labels.value = []
  printQty.value = 1
  errorMsg.value = ''
  barcodeInput.value = ''
  nextTick(() => inputEl.value?.focus())
}

// ============================================================
// 列印 — 单按钮一次出全套（labels[] × qty 张）
// ============================================================
function doPrint() {
  if (!labels.value.length) return
  const qty = Math.max(1, parseInt(printQty.value) || 1)
  printing.value = true
  try {
    printLabels(labels.value, qty)
  } catch (err) {
    console.error(err)
    showToast('列印失敗', 'error')
  } finally {
    // 列印 dialog 是异步弹的，500ms 后解锁按钮（避免连点）
    setTimeout(() => { printing.value = false }, 500)
  }
}

function spinQty(delta) {
  const cur = parseInt(printQty.value) || 1
  printQty.value = Math.max(1, cur + delta)
}

// ============================================================
// 预览渲染（缩放显示）
// ============================================================
function previewHtml(entry) {
  return renderLabelEntry(entry).html
}

function previewMeta(renderType) {
  return labelEntryMeta(renderType)
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10 max-w-4xl mx-auto">

    <!-- ========== 顶部：主數據狀態 + 後台跳轉 ========== -->
    <div class="g-card p-3 mb-5 sm:mb-6 bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-100">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <div class="flex items-center gap-2.5 min-w-0 text-xs">
          <span class="text-lg flex-shrink-0">📋</span>
          <span class="text-gray-600">
            標籤主數據共
            <span class="font-bold text-blue-600">{{ status.count }}</span>
            條
          </span>
          <span v-if="status.last_upload_time" class="text-gray-400">
            · 最後更新 {{ status.last_upload_time }}
          </span>
        </div>
        <div class="text-[11px] text-gray-500">
          維護：Odoo 後台 →
          <span class="font-mono text-blue-600">Inventory → WMS → Label Master</span>
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
        placeholder="🔍 掃描或輸入商品條碼 / SKU"
        autocomplete="off"
        @keydown.enter="lookup"
      />
      <button class="g-btn g-btn-teal flex-shrink-0" style="padding:11px 24px;height:48px;"
              :disabled="loading" @click="lookup">
        {{ loading ? '查詢中…' : '查詢' }}
      </button>
      <button v-if="product || errorMsg" class="g-btn g-btn-pink flex-shrink-0"
              style="padding:11px 18px;height:48px;" @click="reset">
        重置
      </button>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="g-card p-4 mb-5 border-l-4 border-red-400 bg-red-50">
      <div class="flex items-start gap-3">
        <span class="text-xl">⚠️</span>
        <div class="text-sm text-red-700">{{ errorMsg }}</div>
      </div>
    </div>

    <!-- ========== 商品基本信息 ========== -->
    <div v-if="product && labels.length">
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

      <!-- ========== 标签预览卡片（1-2 张）========== -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        <div
          v-for="(entry, idx) in labels"
          :key="idx"
          class="g-card overflow-hidden"
        >
          <div class="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
            <div>
              <div class="text-sm font-bold text-gray-800">
                {{ idx + 1 }}. {{ previewMeta(entry.render_type).name }}
              </div>
              <div class="text-xs text-gray-400 mt-0.5">
                70×50mm · {{ entry.render_type }}
              </div>
            </div>
            <span class="text-[10px] px-2 py-0.5 rounded font-bold"
                  style="background:#ecfdf5;color:#047857;">✓ 主數據齊備</span>
          </div>
          <!-- 預覽（70×50mm 实际尺寸，缩放 1.5 倍方便看清）-->
          <div class="p-4 bg-gray-100 flex items-center justify-center">
            <div
              class="bg-white shadow-sm relative overflow-hidden"
              style="width:105mm; height:75mm; transform-origin:top left;"
            >
              <!-- 内层包一层 70×50mm 容器，scale 1.5 → 视觉 105×75 -->
              <div
                style="width:70mm; height:50mm; position:relative; overflow:hidden; transform:scale(1.5); transform-origin:top left;"
                v-html="previewHtml(entry)"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- ========== 列印控制 ========== -->
      <div class="g-card p-4 sm:p-5 flex items-center justify-between flex-wrap gap-3">
        <div class="text-sm text-gray-600">
          每次列印 <span class="font-bold text-teal-700">{{ labels.length }}</span> 張
          <span v-if="labels.length > 1" class="text-xs text-gray-400">
            (主標籤 + 警告貼紙連續打印)
          </span>
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-500">份數</span>
            <div class="g-spinner">
              <input :value="printQty" type="number" min="1"
                     @input="printQty = parseInt($event.target.value) || 1" />
              <div class="sp-btns">
                <button @click="spinQty(1)" type="button">▲</button>
                <button @click="spinQty(-1)" type="button">▼</button>
              </div>
            </div>
          </div>
          <button class="g-btn g-btn-pink" style="padding:10px 26px;height:44px;"
                  :disabled="printing" @click="doPrint">
            <span v-if="printing">處理中…</span>
            <span v-else>🖨️ 列印全部 ({{ labels.length * printQty }} 張)</span>
          </button>
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
@media (max-width: 767px) {
  .g-input {
    width: 100% !important;
  }
}
</style>
