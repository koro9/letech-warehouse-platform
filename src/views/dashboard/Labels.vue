<script setup>
/**
 * 商品標籤 — 出货作业中心 / Dashboard 系统
 *
 * 业务：
 *   1. 仓库主管首次配置 / 月度更新：上傳 Excel 主數據（整表替換）
 *      → POST /api/warehouse/labels/master/upload
 *      → 後端 TRUNCATE + 批量 INSERT，事务原子，員工掃碼不會看到空表
 *
 *   2. 員工掃 barcode → API GET /labels/lookup → 拿 product + master_data
 *      → 前端固定渲染 2 張卡片：
 *         a) 條碼標籤（任何商品都打，用 product 數據）
 *         b) 營養標籤（master_data.render_type 4 选 1：食品/保健/特殊/普通）
 *      → master_data 為 null 時只顯示條碼標籤
 *
 *   3. 員工選列印份數 → 點列印 → window.print() 沿用旧系统的 @page size 控制
 *
 * 數據架構演進：
 *   - 旧版：localStorage 存 7MB Excel，每人一份，刷新可能爆配額
 *   - 现在：上傳到 le.label.item.master 表，所有員工共享，按 barcode lazy fetch
 */
import { ref, computed, onActivated, nextTick } from 'vue'
import { labels as labelsApi } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { showToast } from '@/composables/useToast'
import {
  renderBarcode, renderNutrition,
  printBarcodeLabel, printNutritionLabel,
  BARCODE_LABEL_META, nutritionLabelMeta,
} from '@/utils/labelRenderers'

const auth = useAuthStore()

// 上传权限：仅 internal 用户能上传主数据（kiosk 上传会 403）
const canUpload = computed(() => auth.isInternal)

// ============================================================
// 状态
// ============================================================
// 商品 + 主数据查询
const barcodeInput = ref('')
const inputEl = ref(null)
const loading = ref(false)
const product = ref(null)        // { sku, barcode, name_zh, name_en, brand, ... }
const masterData = ref(null)     // { render_type, barcode, ingredients, energy, ... } | null
const errorMsg = ref('')

// 每个 label 的列印数量（key: 'barcode' | render_type）
const printQty = ref({ barcode: 1, nutrition: 1 })

// 上传状态
const status = ref({
  count: 0,
  last_upload_time: '',
  last_upload_by: '',
  last_upload_file: '',
})
const uploading = ref(false)
const uploadProgress = ref(0)
const fileInputEl = ref(null)

// 最近扫过 — 快速重选
const recentBarcodes = ref([])

// ============================================================
// 标签卡片元数据
// ============================================================
const barcodeMeta = BARCODE_LABEL_META  // { code, name, size_width, size_height }

const nutritionMeta = computed(() => {
  if (!masterData.value) return null
  return nutritionLabelMeta(masterData.value.render_type)
})

// ============================================================
// 启动 / 切回页面 — 拉状态
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
// 上传 Excel — destructive overwrite
// ============================================================
function triggerUpload() {
  if (!canUpload.value) {
    showToast('僅內部員工可上傳主數據', 'error')
    return
  }
  fileInputEl.value?.click()
}

async function onFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  // 清掉 value 让同一文件重选还能触发
  e.target.value = ''

  // 决策性 confirm — 这是销毁性操作
  const currentCount = status.value.count || 0
  const msg = currentCount > 0
    ? `此操作將清空現有 ${currentCount} 條標籤主數據，並用「${file.name}」的內容替換。\n\n確定繼續嗎？`
    : `將上傳「${file.name}」作為標籤主數據。\n\n確定嗎？`
  if (!confirm(msg)) return

  uploading.value = true
  uploadProgress.value = 0
  try {
    const res = await labelsApi.uploadMaster(file, (p) => {
      uploadProgress.value = p
    })
    const breakdown = res.by_render_type || {}
    const summary = [
      `📦 ${res.total} 條`,
      `🍱 食品 ${breakdown.food_label || 0}`,
      `💊 保健 ${breakdown.health_food || 0}`,
      `⚠️ 特殊 ${breakdown.special_label || 0}`,
      `📋 普通 ${breakdown.ordinary_label || 0}`,
    ].join(' · ')
    showToast(`✅ 已替換為 ${summary}（${(res.duration_ms / 1000).toFixed(1)}s）`, 'success')
    await loadStatus()
  } catch (err) {
    if (err.handledByInterceptor) return
    const code = err.response?.data?.error
    let msg = err.response?.data?.detail || err.response?.data?.error || '上傳失敗'
    if (code === 'not_authorized') msg = '僅內部員工可上傳主數據'
    else if (code === 'upload_in_progress') msg = '⚙️ 其他用戶正在上傳，請稍後'
    else if (code === 'missing_barcode_column') msg = 'Excel 缺少 Barcode 列'
    else if (code === 'no_valid_rows') msg = 'Excel 沒有任何有效數據（Barcode 全為空）'
    else if (code === 'parse_failed') msg = 'Excel 解析失敗，請檢查文件格式'
    showToast(msg, 'error')
  } finally {
    uploading.value = false
    uploadProgress.value = 0
  }
}

const lastUploadDisplay = computed(() => {
  if (!status.value.last_upload_time) return '從未上傳'
  return status.value.last_upload_time
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
  masterData.value = null
  try {
    const res = await labelsApi.lookupByBarcode(bc)
    product.value = res.product
    masterData.value = res.master_data || null
    printQty.value = { barcode: 1, nutrition: 1 }

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
  masterData.value = null
  printQty.value = { barcode: 1, nutrition: 1 }
  errorMsg.value = ''
  barcodeInput.value = ''
  nextTick(() => inputEl.value?.focus())
}

// ============================================================
// 列印 — 调 renderers 模块
// ============================================================
const barcodePreviewHtml = computed(() => {
  if (!product.value) return ''
  return renderBarcode(product.value).html
})

const nutritionPreviewHtml = computed(() => {
  if (!masterData.value) return ''
  return renderNutrition(masterData.value).html
})

function doPrintBarcode() {
  if (!product.value) return
  const qty = Math.max(1, parseInt(printQty.value.barcode) || 1)
  printBarcodeLabel(product.value, qty)
}

function doPrintNutrition() {
  if (!masterData.value) return
  const qty = Math.max(1, parseInt(printQty.value.nutrition) || 1)
  printNutritionLabel(masterData.value, qty)
}

function spinQty(key, delta) {
  const cur = parseInt(printQty.value[key]) || 1
  printQty.value[key] = Math.max(1, cur + delta)
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
            <div class="text-sm font-bold text-gray-800">標籤主數據</div>
            <div class="text-xs text-gray-500 mt-0.5">
              <span v-if="status.count > 0">
                共 <span class="font-semibold text-blue-600">{{ status.count }}</span> 條
                ｜ {{ lastUploadDisplay }}
                <span v-if="status.last_upload_by" class="text-gray-400">· {{ status.last_upload_by }}</span>
                <span v-if="status.last_upload_file" class="text-gray-400 hidden sm:inline">· {{ status.last_upload_file }}</span>
              </span>
              <span v-else class="text-amber-600">尚未上傳 — 員工掃碼後僅能列印條碼標籤</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <input
            ref="fileInputEl"
            type="file"
            accept=".xlsx,.xlsm"
            class="hidden"
            @change="onFileChange"
          />
          <button
            class="g-btn g-btn-blue"
            style="padding:8px 18px;font-size:13px;"
            :disabled="!canUpload || uploading"
            :title="canUpload ? '' : '僅內部員工可上傳'"
            @click="triggerUpload"
          >
            <span v-if="uploading">⬆️ 上傳中… {{ uploadProgress }}%</span>
            <span v-else-if="status.count > 0">🔄 重新上傳</span>
            <span v-else>📂 上傳 Excel</span>
          </button>
        </div>
      </div>
      <!-- 上传进度条 -->
      <div v-if="uploading" class="mt-3 h-1 bg-blue-100 rounded-full overflow-hidden">
        <div class="h-full bg-blue-500 transition-all duration-300" :style="{ width: uploadProgress + '%' }"></div>
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
      <button v-if="product || errorMsg" class="g-btn g-btn-pink flex-shrink-0"
              style="padding:11px 18px;height:48px;" @click="reset">
        重置
      </button>
    </div>

    <!-- 错误 -->
    <div v-if="errorMsg" class="g-card p-5 sm:p-6 mb-5 border-l-4 border-red-400 bg-red-50">
      <div class="flex items-start gap-3">
        <span class="text-xl">⚠️</span>
        <div class="flex-1">
          <div class="text-sm font-bold text-red-700 mb-1">{{ errorMsg }}</div>
        </div>
      </div>
    </div>

    <!-- ========== 商品 + 标签卡片 ========== -->
    <div v-if="product">
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
        <div v-if="!masterData" class="mt-3 text-xs text-amber-600 flex items-center gap-1">
          <span>⚠️</span>
          <span>此商品在主數據中無記錄，僅可列印條碼標籤</span>
        </div>
      </div>

      <!-- 2 张固定卡片：barcode + nutrition (如有) -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">

        <!-- 卡片 1：條碼標籤（永远显示）-->
        <div class="g-card overflow-hidden">
          <div class="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
            <div>
              <div class="text-sm font-bold text-gray-800">{{ barcodeMeta.name }}</div>
              <div class="text-xs text-gray-400 mt-0.5">
                {{ barcodeMeta.size_width }}×{{ barcodeMeta.size_height }}mm · barcode
              </div>
            </div>
          </div>
          <!-- 預覽 -->
          <div class="p-3 bg-white">
            <div class="border border-dashed border-gray-200 rounded p-2 overflow-hidden bg-gray-50"
                 style="max-height:300px;">
              <div v-html="barcodePreviewHtml"
                   style="position:relative; transform:scale(0.4); transform-origin:top left; width:250%;"></div>
            </div>
          </div>
          <!-- 数量 + 列印 -->
          <div class="px-4 py-3 border-t border-gray-100 flex items-center justify-between flex-wrap gap-3">
            <div class="g-spinner">
              <input :value="printQty.barcode" type="number" min="1"
                     @input="printQty.barcode = parseInt($event.target.value) || 1" />
              <div class="sp-btns">
                <button @click="spinQty('barcode', 1)" type="button">▲</button>
                <button @click="spinQty('barcode', -1)" type="button">▼</button>
              </div>
            </div>
            <button class="g-btn g-btn-pink" style="padding:8px 22px;font-size:13px;" @click="doPrintBarcode">
              🖨️ 列印
            </button>
          </div>
        </div>

        <!-- 卡片 2：營養標籤（master_data 存在时才显示）-->
        <div v-if="masterData && nutritionMeta" class="g-card overflow-hidden">
          <div class="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
            <div>
              <div class="text-sm font-bold text-gray-800">{{ nutritionMeta.name }}</div>
              <div class="text-xs text-gray-400 mt-0.5">
                {{ nutritionMeta.size_width }}×{{ nutritionMeta.size_height }}mm · {{ masterData.render_type }}
              </div>
            </div>
            <span class="text-[10px] px-2 py-0.5 rounded font-bold"
                  style="background:#ecfdf5;color:#047857;">✓ 主數據齊備</span>
          </div>
          <div class="p-3 bg-white">
            <div class="border border-dashed border-gray-200 rounded p-2 overflow-hidden bg-gray-50"
                 style="max-height:300px;">
              <div v-html="nutritionPreviewHtml"
                   style="position:relative; transform:scale(0.4); transform-origin:top left; width:250%;"></div>
            </div>
          </div>
          <div class="px-4 py-3 border-t border-gray-100 flex items-center justify-between flex-wrap gap-3">
            <div class="g-spinner">
              <input :value="printQty.nutrition" type="number" min="1"
                     @input="printQty.nutrition = parseInt($event.target.value) || 1" />
              <div class="sp-btns">
                <button @click="spinQty('nutrition', 1)" type="button">▲</button>
                <button @click="spinQty('nutrition', -1)" type="button">▼</button>
              </div>
            </div>
            <button class="g-btn g-btn-pink" style="padding:8px 22px;font-size:13px;" @click="doPrintNutrition">
              🖨️ 列印
            </button>
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
@media (max-width: 767px) {
  .g-input {
    width: 100% !important;
  }
}
</style>
