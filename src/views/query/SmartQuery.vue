<script setup>
/**
 * 智能查詢中心
 *
 * 两个核心能力：
 *   1. 商品搜索：调 Odoo 后端 /api/warehouse/inventory/search，按 SKU/Barcode/中英文名 模糊搜
 *   2. 庫存查詢：调 Odoo 后端 /api/warehouse/inventory/stock，直连 stock.quant 实时数据
 *      → 替代了之前的 DEAR API 直连方案，凭据/CORS 代理/设置弹窗都不再需要
 */
import { ref } from 'vue'
import { inventory } from '@/api'
import { useGlobalLoading } from '@/composables/useGlobalLoading'
import { showToast } from '@/composables/useToast'

// ===== 商品搜索 =====
const searchQuery = ref('')
const searchResults = ref(null)   // null = 未搜过；[] = 没结果；[...] = 结果
const searchHasMore = ref(false)  // 后端结果是否被截断（命中 > SEARCH_LIMIT）
const searching = ref(false)

// ===== 庫存查詢 =====
const invSku = ref('')
const invLoading = ref(false)
const invError = ref(null)        // { msg }
const invResult = ref(null)       // { product, summary, by_warehouse }

// ============================================================
// 商品搜索
// ============================================================
function clearSearch() {
  searchQuery.value = ''
  searchResults.value = null
  searchHasMore.value = false
}

async function doSearch() {
  const q = searchQuery.value.trim()
  if (!q) return
  searching.value = true
  try {
    const res = await inventory.searchProducts(q)
    if (Array.isArray(res)) {
      searchResults.value = res
      searchHasMore.value = false
    } else {
      searchResults.value = res.products || []
      searchHasMore.value = !!res.has_more
    }
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '搜尋失敗', 'error')
    }
    searchResults.value = []
    searchHasMore.value = false
  } finally {
    searching.value = false
  }
}

function searchUrlOf(item) {
  return item.searchUrl && item.searchUrl !== '#'
    ? item.searchUrl
    : `https://www.hktvmall.com/hktv/zh/search_a?keyword=${encodeURIComponent(item.name || '')}`
}

function fillInvAndSearch(sku) {
  invSku.value = sku
  doInventory()
}

// ============================================================
// 庫存查詢 — 直连 Odoo
// ============================================================
function clearInv() {
  invSku.value = ''
  invResult.value = null
  invError.value = null
}

async function doInventory() {
  const sku = invSku.value.trim()
  if (!sku) return
  invLoading.value = true
  invError.value = null
  invResult.value = null
  try {
    await useGlobalLoading().run(async () => {
      invResult.value = await inventory.getStock(sku)
    }, '查詢庫存中...')
  } catch (err) {
    if (err.handledByInterceptor) {
      // 拦截器已经弹 toast（403 / 409），UI 不再叠红框提示
    } else {
      const code = err.response?.data?.error
      let msg = err.message || '查詢失敗'
      if (code === 'product_not_found') msg = '找不到此 SKU 對應的商品'
      else if (code === 'missing_sku') msg = '請輸入 SKU'
      else if (err.response?.data?.error) msg = err.response.data.error
      invError.value = { msg }
    }
  } finally {
    invLoading.value = false
  }
}

// 数字格式化：库存通常是整数，但 Odoo Float 可能带 .0；超过 1k 加千分位
function fmtQty(n) {
  if (n == null) return '-'
  const v = Number(n)
  if (!Number.isFinite(v)) return '-'
  // 整数直接显示，否则保留 2 位小数（如 0.5 / 1.25 这种少见但可能）
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
}
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-5 py-6 sm:py-10">
    <!-- 顶部 -->
    <div class="text-center mb-6 sm:mb-8">
      <h2 class="text-xl sm:text-2xl lg:text-3xl font-extrabold text-slate-900">🔍 智能查詢中心</h2>
      <p class="text-slate-500 text-sm sm:text-base mt-2">直連 Odoo 庫存</p>
    </div>

    <div class="flex flex-col gap-6 sm:gap-9">
      <!-- 商品搜索 -->
      <div class="g-card p-4 sm:p-6">
        <div class="flex items-center gap-3 mb-4 sm:mb-5">
          <div class="bg-blue-50 p-2 sm:p-2.5 rounded-xl flex items-center justify-center text-lg sm:text-xl">📚</div>
          <h3 class="text-slate-800 text-base sm:text-xl font-bold">商品搜尋</h3>
        </div>

        <form class="flex gap-3 flex-wrap mb-5" @submit.prevent="doSearch">
          <div class="relative flex-1 min-w-[220px]">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="輸入 SKU / Barcode / 中英文名稱..."
              class="w-full py-3.5 px-4 text-base rounded-2xl border-2 border-slate-300 outline-none transition-colors focus:border-blue-500 box-border"
            />
            <button
              v-if="searchQuery"
              type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 bg-transparent border-0 text-slate-400 text-lg p-1 cursor-pointer hover:text-slate-600"
              @click="clearSearch"
            >✕</button>
          </div>
          <button
            type="submit"
            class="bg-blue-500 text-white py-3.5 px-6 text-base rounded-2xl border-0 font-bold cursor-pointer whitespace-nowrap shrink-0 transition-colors hover:bg-blue-600 disabled:bg-slate-400"
            :disabled="searching"
          >{{ searching ? '⏳ 搜尋中...' : '🔍 搜尋商品' }}</button>
        </form>

        <div v-if="searchResults !== null">
          <div
            v-if="searchResults.length === 0"
            class="font-bold p-3 rounded-xl bg-amber-50 text-amber-600 border border-amber-200"
          >⚠️ 找不到相符的商品資料</div>

          <!-- 命中超过上限的截断提示 -->
          <div
            v-if="searchHasMore"
            class="font-medium p-3 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 mb-3 text-sm"
          >
            ℹ️ 結果超過 {{ searchResults.length }} 條，僅顯示前 {{ searchResults.length }} 條。請輸入更精確的關鍵字（完整 SKU / Barcode 或更具體的名稱）。
          </div>

          <div
            v-if="searchResults.length"
            class="max-h-[350px] overflow-y-auto pr-1 flex flex-col gap-3"
          >
            <div
              v-for="item in searchResults"
              :key="item.sku + item.barcode"
              class="flex flex-wrap items-center justify-between bg-slate-50 border border-slate-200 rounded-2xl p-4 gap-4"
            >
              <div class="flex-1 min-w-[200px]">
                <div class="text-base font-extrabold text-slate-900 mb-2 leading-snug">{{ item.name }}</div>
                <div class="flex gap-3 flex-wrap text-[13px]">
                  <div class="bg-white py-1 px-2.5 rounded-md border border-slate-200">
                    <span class="text-slate-500">SKU:</span>
                    <span class="font-mono font-bold text-blue-500 ml-1">{{ item.sku }}</span>
                  </div>
                  <div class="bg-white py-1 px-2.5 rounded-md border border-slate-200">
                    <span class="text-slate-500">Barcode:</span>
                    <span class="font-mono font-bold text-emerald-500 ml-1">{{ item.barcode }}</span>
                  </div>
                </div>
              </div>
              <div class="flex gap-2.5 shrink-0 w-full sm:w-auto justify-end">
                <a
                  :href="searchUrlOf(item)"
                  target="_blank"
                  class="bg-white text-slate-600 border border-slate-300 py-2.5 px-4 rounded-xl no-underline text-sm font-bold flex items-center justify-center hover:bg-slate-50"
                >🔗 商城</a>
                <button
                  class="bg-emerald-500 text-white border-0 py-2.5 px-4 rounded-xl text-sm font-bold cursor-pointer flex items-center gap-1.5 shadow hover:bg-emerald-600"
                  @click="fillInvAndSearch(item.sku)"
                >📦 查庫存</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Odoo 即時庫存查詢 -->
      <div class="g-card p-4 sm:p-6">
        <div class="flex items-center gap-3 mb-4 sm:mb-5">
          <div class="bg-emerald-50 p-2 sm:p-2.5 rounded-xl flex items-center justify-center text-lg sm:text-xl">📦</div>
          <h3 class="text-emerald-900 text-base sm:text-xl font-bold">Odoo 即時庫存查詢</h3>
        </div>

        <form class="flex gap-3 flex-wrap mb-5" @submit.prevent="doInventory">
          <div class="relative flex-1 min-w-[220px]">
            <input
              v-model="invSku"
              type="text"
              placeholder="請輸入精確的 SKU (如: LT10009829)"
              class="w-full py-3.5 px-4 text-base rounded-2xl border-2 border-slate-300 outline-none transition-colors focus:border-emerald-500 box-border"
            />
            <button
              v-if="invSku"
              type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 bg-transparent border-0 text-slate-400 text-lg p-1 cursor-pointer hover:text-slate-600"
              @click="clearInv"
            >✕</button>
          </div>
          <button
            type="submit"
            class="bg-emerald-500 text-white py-3.5 px-6 text-base rounded-2xl border-0 font-bold cursor-pointer whitespace-nowrap shrink-0 transition-colors hover:bg-emerald-600 disabled:bg-slate-400"
            :disabled="invLoading"
          >{{ invLoading ? '⏳ 查詢中...' : '📦 查詢庫存' }}</button>
        </form>

        <!-- 占位 / 错误 / 结果 三选一 -->
        <div
          v-if="!invResult && !invError"
          class="text-center text-slate-400 p-5 bg-slate-50 rounded-2xl border border-dashed border-slate-300"
        >請輸入 SKU 或從上方搜尋結果點擊「查庫存」帶入資料。</div>

        <div
          v-if="invError"
          class="p-4 rounded-xl font-bold border bg-red-50 text-red-600 border-red-200 mb-4"
        >❌ 查詢失敗：{{ invError.msg }}</div>

        <div v-if="invResult" class="mt-5">
          <!-- 商品信息 -->
          <div class="bg-slate-50 p-4 rounded-2xl border border-slate-200 mb-5 flex flex-wrap gap-4 items-center">
            <div class="flex-1 min-w-[200px]">
              <div class="text-lg font-black text-slate-900 mb-1.5 leading-snug">{{ invResult.product.name }}</div>
              <div v-if="invResult.product.name_en" class="text-sm text-slate-500">{{ invResult.product.name_en }}</div>
            </div>
            <div class="flex gap-2.5 flex-wrap">
              <div class="bg-white py-2 px-3 rounded-xl border border-slate-200">
                <div class="text-[11px] text-slate-500 font-bold">SKU</div>
                <div class="text-sm font-bold text-blue-500 font-mono">{{ invResult.product.sku }}</div>
              </div>
              <div class="bg-white py-2 px-3 rounded-xl border border-slate-200">
                <div class="text-[11px] text-slate-500 font-bold">Barcode</div>
                <div class="text-sm font-bold text-emerald-500 font-mono">{{ invResult.product.barcode || '—' }}</div>
              </div>
            </div>
          </div>

          <!-- 总览 — 跟 Inventory > Inventory Health > All Products 列定义对齐 -->
          <!-- 手机字号缩小、padding 减半，保持 3 列 -->
          <div class="rounded-2xl border border-slate-200 overflow-hidden mb-5 shadow-sm">
            <div class="grid grid-cols-3">
              <div class="p-3 sm:p-5 text-center border-r border-slate-200">
                <div class="text-[10px] sm:text-[11px] text-slate-500 font-bold mb-1 leading-tight">On Hand<br class="sm:hidden"/><span class="sm:ml-1">總庫存</span></div>
                <div class="text-lg sm:text-2xl font-black text-slate-700">{{ fmtQty(invResult.summary.on_hand) }}</div>
              </div>
              <div class="p-3 sm:p-5 text-center border-r border-slate-200">
                <div class="text-[10px] sm:text-[11px] text-slate-500 font-bold mb-1 leading-tight">Allocated<br class="sm:hidden"/><span class="sm:ml-1">已分配</span></div>
                <div class="text-lg sm:text-2xl font-black text-amber-600">{{ fmtQty(invResult.summary.allocated) }}</div>
              </div>
              <div class="p-3 sm:p-5 text-center">
                <div class="text-[10px] sm:text-[11px] text-slate-500 font-bold mb-1 leading-tight">Available<br class="sm:hidden"/><span class="sm:ml-1">可用</span></div>
                <div
                  class="text-lg sm:text-2xl font-black"
                  :class="invResult.summary.available > 0 ? 'text-emerald-600' : 'text-red-600'"
                >{{ fmtQty(invResult.summary.available) }}</div>
              </div>
            </div>
          </div>

          <!-- 各仓库分布 -->
          <div v-if="invResult.by_warehouse?.length" class="rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
            <div class="px-4 py-3 bg-slate-50 border-b border-slate-200 font-bold text-sm text-slate-700">
              📍 各倉庫分佈
            </div>
            <div class="overflow-x-auto">
              <table class="w-full border-collapse text-sm">
                <thead>
                  <tr class="bg-white text-slate-600 border-b border-slate-200 text-[12px]">
                    <th class="p-3 text-left font-semibold">倉庫</th>
                    <th class="p-3 text-right font-semibold">On Hand</th>
                    <th class="p-3 text-right font-semibold">Reserved</th>
                    <th class="p-3 text-right font-semibold">Available</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(wh, idx) in invResult.by_warehouse"
                    :key="(wh.warehouse_code || '') + wh.warehouse_name"
                    :class="idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'"
                  >
                    <td class="p-3 font-semibold text-slate-800">
                      {{ wh.warehouse_name }}
                      <span v-if="wh.warehouse_code" class="text-xs text-slate-400 ml-1 font-mono">({{ wh.warehouse_code }})</span>
                    </td>
                    <td class="p-3 text-right font-semibold text-slate-700">{{ fmtQty(wh.on_hand) }}</td>
                    <td class="p-3 text-right font-semibold text-amber-600">{{ fmtQty(wh.reserved) }}</td>
                    <td
                      class="p-3 text-right font-bold"
                      :class="wh.available > 0 ? 'text-emerald-600' : 'text-red-600'"
                    >{{ fmtQty(wh.available) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 没库存的提示 -->
          <div
            v-else
            class="text-center text-slate-400 p-5 bg-slate-50 rounded-2xl border border-dashed border-slate-300 text-sm"
          >此商品在所有倉庫均無庫存記錄</div>
        </div>
      </div>
    </div>
  </div>
</template>
