<script setup>
/**
 * 智能查詢中心 — 复刻 /Users/liu/Code/智能查詢/智能查詢.html
 *
 * 两个核心能力：
 *   1. 商品搜索：调 Odoo 后端 /api/warehouse/inventory/search，按 SKU/Barcode/中英文名 模糊搜
 *      （原型用 Excel 上传到内存的方案已废弃，资料源全部 Odoo）
 *   2. DEAR API 即时库存查询：Product + ProductAvailability，按 HKTV SD4 location 过滤
 *      按 批號+效期 分组合计 SOH/Allocated/Available
 *
 * DEAR 凭据存 localStorage（用户自填），通过 ⚙️ 设置弹窗维护
 *
 * ⚠️ 上线时建议改为 Odoo 后端代理 DEAR，前端零暴露凭据
 */
import { ref } from 'vue'
import { dear, inventory } from '@/api'
import { useDearCredentials } from '@/composables/useDearCredentials'
import { showToast } from '@/composables/useToast'

const TARGET_LOCATION = 'HKTV SD4'

// ===== 商品搜索 =====
const searchQuery = ref('')
const searchResults = ref(null)   // null = 未搜过；[] = 没结果；[...] = 结果
const searching = ref(false)

// ===== DEAR 库存查询 =====
const invSku = ref('')
const invLoading = ref(false)
const invError = ref(null)        // { msg, requiresUnlock?: bool }
const invResult = ref(null)

// ===== 凭据设置弹窗 =====
const { accountId, appKey, save: saveDearCreds } = useDearCredentials()
const settingsOpen = ref(false)
const formAccountId = ref('')
const formAppKey = ref('')

// ============================================================
// 商品搜索 — 走 Odoo 后端
// ============================================================
function clearSearch() {
  searchQuery.value = ''
  searchResults.value = null
}

async function doSearch() {
  const q = searchQuery.value.trim()
  if (!q) return
  searching.value = true
  try {
    const res = await inventory.searchProducts(q)
    const list = Array.isArray(res) ? res : (res.products || [])
    searchResults.value = list.slice(0, 200)
  } catch (err) {
    showToast(err.response?.data?.error || '搜索失败（后端待接入）', 'error')
    searchResults.value = []
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
// 3. DEAR 库存查询
// ============================================================
function clearInv() {
  invSku.value = ''
  invResult.value = null
  invError.value = null
}

async function doInventory() {
  const sku = invSku.value.trim()
  if (!sku) return
  if (!accountId.value || !appKey.value) {
    invError.value = { msg: '請先設定 DEAR API 金鑰' }
    openSettings()
    return
  }
  invLoading.value = true
  invError.value = null
  invResult.value = null
  try {
    // Step 1: Product info
    const productRes = await dear.getProduct(sku)
    const products = productRes.Products || []
    if (products.length === 0) throw new Error('在 DEAR 中找不到對應的商品 (SKU 錯誤)')
    const p = products[0]

    // Step 2: Availability
    const availRes = await dear.getAvailability(sku)
    const invList = availRes.ProductAvailabilityList
      || (Array.isArray(availRes) ? availRes : [])

    invResult.value = {
      product: {
        Name: p.Name || '-',
        SKU:  p.SKU || '-',
        UPC:  String(p.Barcode || p.UPC || p.AdditionalAttribute1 || '-').trim(),
        Components: p.Components || [],
      },
      main: processInventory(invList),
    }
  } catch (err) {
    if (err.code === 'CORS_UNLOCK_REQUIRED') {
      invError.value = { msg: '跨域代理需要授權', requiresUnlock: true }
    } else {
      invError.value = { msg: err.message || '查詢失敗' }
    }
  } finally {
    invLoading.value = false
  }
}

// 把 ProductAvailability 列表 → 按 HKTV SD4 过滤 → 按批号+效期分组
function processInventory(list) {
  if (!Array.isArray(list)) list = []
  const filtered = list.filter(item => {
    if (!item.Location || item.Location.trim().toUpperCase() !== TARGET_LOCATION.toUpperCase()) return false
    const empty = (item.OnHand||0)===0 && (item.Allocated||0)===0 && (item.OnOrder||0)===0 && (item.Available||0)===0
    return !empty
  })

  let tSOH = 0, tAlloc = 0, tAvail = 0
  const grouped = {}

  filtered.forEach(item => {
    tSOH   += item.OnHand || 0
    tAlloc += item.Allocated || 0
    tAvail += item.Available || 0

    const batch = item.Batch || '-'
    let expiryStr = ''
    if (item.ExpiryDate) {
      const d = new Date(item.ExpiryDate)
      if (!isNaN(d.getTime())) {
        expiryStr = `(${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()})`
      }
    }
    const key = `${batch}_${expiryStr}`
    if (!grouped[key]) grouped[key] = { Batch: batch, ExpiryStr: expiryStr, SOH: 0, Avail: 0, OnOrder: 0, Allocated: 0 }
    grouped[key].SOH       += item.OnHand    || 0
    grouped[key].Avail     += item.Available || 0
    grouped[key].OnOrder   += item.OnOrder   || 0
    grouped[key].Allocated += item.Allocated || 0
  })

  const rows = Object.values(grouped).filter(r =>
    r.SOH !== 0 || r.Avail !== 0 || r.OnOrder !== 0 || r.Allocated !== 0,
  )
  return { hasData: filtered.length > 0, tSOH, tAlloc, tAvail, rows }
}

// ============================================================
// 4. 设置弹窗
// ============================================================
function openSettings() {
  formAccountId.value = accountId.value
  formAppKey.value    = appKey.value
  settingsOpen.value  = true
}

function closeSettings() { settingsOpen.value = false }

function saveSettings() {
  saveDearCreds(formAccountId.value, formAppKey.value)
  settingsOpen.value = false
  // 如果之前是因缺凭据失败，清掉错误提示
  if (invError.value && invError.value.msg.includes('API 金鑰')) {
    invError.value = null
  }
  showToast('✅ 已儲存', 'success')
}
</script>

<template>
  <div class="max-w-5xl mx-auto px-5 py-10">
    <!-- 顶部 -->
    <div class="text-center mb-8">
      <h2 class="text-3xl font-extrabold text-slate-900">🔍 智能查詢中心</h2>
      <p class="text-slate-500 text-base mt-2">本地解析 Excel / 直連 DEAR 庫存</p>
    </div>

    <div class="flex flex-col gap-9">
      <!-- 商品搜索（数据来源：Odoo 后端） -->
      <div class="g-card p-6">
        <div class="flex items-center gap-3 mb-5">
          <div class="bg-blue-50 p-2.5 rounded-xl flex items-center justify-center text-xl">📚</div>
          <h3 class="text-slate-800 text-xl font-bold">商品搜尋</h3>
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

          <div
            v-else
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

      <!-- 下层：DEAR 即时库存 -->
      <div class="g-card p-6">
        <div class="flex items-center gap-3 mb-5">
          <div class="bg-emerald-50 p-2.5 rounded-xl flex items-center justify-center text-xl">📦</div>
          <h3 class="text-emerald-900 text-xl font-bold">DEAR 即時庫存查詢</h3>
          <button
            type="button"
            class="ml-auto bg-slate-100 text-slate-600 border border-slate-300 py-1.5 px-3 rounded-lg text-sm font-bold hover:bg-slate-200 flex items-center gap-1 cursor-pointer"
            @click="openSettings"
          >⚙️ <span class="hidden sm:inline">API 設定</span></button>
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
          >{{ invLoading ? '⏳ 連線中...' : '📦 查詢庫存' }}</button>
        </form>

        <!-- 占位 / 错误 / 结果 三选一 -->
        <div
          v-if="!invResult && !invError"
          class="text-center text-slate-400 p-5 bg-slate-50 rounded-2xl border border-dashed border-slate-300"
        >請輸入 SKU 或從上方搜尋結果點擊「查庫存」帶入資料。</div>

        <div
          v-if="invError"
          class="p-4 rounded-xl font-bold border bg-red-50 text-red-600 border-red-200 mb-4"
        >
          ❌ 查詢失敗：{{ invError.msg }}
          <div
            v-if="invError.requiresUnlock"
            class="text-[13px] mt-2 text-red-800 font-normal bg-red-50 p-4 rounded-xl border-2 border-red-200"
          >
            <strong class="text-red-900 text-sm">⚠️ 瀏覽器跨域安全限制 (CORS)</strong><br/>
            DEAR API 官方禁止前端直連，本系統用代理伺服器中轉，但需要你手動授權一次：<br/><br/>
            <a
              href="https://cors-anywhere.herokuapp.com/corsdemo"
              target="_blank"
              class="inline-block bg-red-600 text-white font-bold py-2 px-4 rounded-lg text-[13px] no-underline hover:bg-red-700"
            >🔓 點擊此處前往授權解鎖</a><br/>
            <span class="text-xs text-red-600 mt-2.5 block leading-relaxed">
              <strong>步驟：</strong>
              1. 點擊上方按鈕開啟新分頁
              2. 點擊 <strong>「Request temporary access to the demo server」</strong>
              3. 看到綠色成功提示後，回到本頁面重新查詢
            </span>
          </div>
        </div>

        <div v-if="invResult" class="mt-5">
          <!-- 商品信息 -->
          <div class="bg-slate-50 p-4 rounded-2xl border border-slate-200 mb-5 flex flex-wrap gap-4 items-center">
            <div class="flex-1 min-w-[200px]">
              <div class="text-lg font-black text-slate-900 mb-1.5 leading-snug">{{ invResult.product.Name }}</div>
              <span
                v-if="invResult.product.Components.length"
                class="text-xs bg-green-100 text-green-800 py-1 px-2 rounded-md border border-green-200 inline-block"
              >📦 組合/多件裝商品</span>
            </div>
            <div class="flex gap-2.5 flex-wrap">
              <div class="bg-white py-2 px-3 rounded-xl border border-slate-200">
                <div class="text-[11px] text-slate-500 font-bold">SKU</div>
                <div class="text-sm font-bold text-blue-500 font-mono">{{ invResult.product.SKU }}</div>
              </div>
              <div class="bg-white py-2 px-3 rounded-xl border border-slate-200">
                <div class="text-[11px] text-slate-500 font-bold">Barcode</div>
                <div class="text-sm font-bold text-emerald-500 font-mono">{{ invResult.product.UPC }}</div>
              </div>
            </div>
          </div>

          <h4 class="text-slate-900 font-bold text-base mb-3">
            <template v-if="invResult.main.hasData">📍 主商品 {{ TARGET_LOCATION }} 庫存</template>
            <template v-else>⚠️ 主商品在 {{ TARGET_LOCATION }} 無實體庫存</template>
          </h4>

          <div
            v-if="invResult.main.hasData"
            class="rounded-2xl border border-slate-200 overflow-hidden mb-6 shadow-sm"
          >
            <!-- 总览 -->
            <div class="p-4 bg-slate-100 flex flex-wrap gap-4 items-center border-b border-slate-200">
              <div class="flex-1 text-center">
                <div class="text-[11px] text-slate-500 font-bold">總 SOH</div>
                <div class="text-2xl font-black text-slate-700">{{ invResult.main.tSOH }}</div>
              </div>
              <div class="flex-1 text-center border-x border-slate-300">
                <div class="text-[11px] text-slate-500 font-bold">Allocated</div>
                <div class="text-2xl font-black text-slate-500">{{ invResult.main.tAlloc }}</div>
              </div>
              <div class="flex-1 text-center">
                <div class="text-[11px] text-slate-500 font-bold">Available</div>
                <div
                  class="text-2xl font-black"
                  :class="invResult.main.tAvail > 0 ? 'text-green-600' : 'text-red-600'"
                >{{ invResult.main.tAvail }}</div>
              </div>
            </div>
            <!-- 表格 -->
            <div class="overflow-x-auto">
              <table class="w-full min-w-[350px] border-collapse text-left text-sm">
                <thead>
                  <tr class="bg-white text-slate-600 border-b-2 border-slate-200">
                    <th class="p-3">批號 / 效期</th>
                    <th class="p-3 text-right">SOH</th>
                    <th class="p-3 text-right">AVAIL</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(row, idx) in invResult.main.rows"
                    :key="row.Batch + row.ExpiryStr"
                    :class="['border-b border-slate-100', idx % 2 === 0 ? 'bg-white' : 'bg-slate-50']"
                  >
                    <td class="p-3 font-mono font-semibold text-slate-800">
                      {{ row.Batch }}
                      <br v-if="row.ExpiryStr" />
                      <span v-if="row.ExpiryStr" class="text-slate-500 text-xs">{{ row.ExpiryStr }}</span>
                    </td>
                    <td class="p-3 font-semibold text-right text-slate-700">{{ row.SOH }}</td>
                    <td
                      class="p-3 font-bold text-right"
                      :class="row.Avail > 0 ? 'text-green-600' : 'text-red-600'"
                    >{{ row.Avail }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 凭据设置弹窗 -->
    <div
      v-if="settingsOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      style="background:rgba(15,23,42,.5);backdrop-filter:blur(4px);"
      @click.self="closeSettings"
    >
      <div class="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl border border-slate-200">
        <h3 class="text-xl font-extrabold text-slate-900 mb-2">⚙️ DEAR API 金鑰設定</h3>
        <p class="text-[13px] text-slate-500 mb-5 leading-relaxed">
          金鑰僅儲存在你的瀏覽器 (localStorage)，前端代碼不包含任何金鑰。
          <br/>
          <span class="text-amber-700">⚠️ 上線時建議改為 Odoo 後端代理，前端零暴露</span>
        </p>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-bold text-slate-700 mb-1.5">Account ID</label>
            <input
              v-model="formAccountId"
              type="text"
              class="w-full border-2 border-slate-200 p-2.5 rounded-xl focus:border-blue-500 outline-none box-border"
              placeholder="請輸入 Account ID"
            />
          </div>
          <div>
            <label class="block text-sm font-bold text-slate-700 mb-1.5">Application Key</label>
            <input
              v-model="formAppKey"
              type="password"
              class="w-full border-2 border-slate-200 p-2.5 rounded-xl focus:border-blue-500 outline-none box-border"
              placeholder="請輸入 Application Key"
            />
          </div>
        </div>
        <div class="mt-6 flex gap-3 justify-end">
          <button
            class="px-4 py-2.5 bg-slate-100 text-slate-700 font-bold rounded-xl border border-slate-200 hover:bg-slate-200 cursor-pointer"
            @click="closeSettings"
          >取消</button>
          <button
            class="px-4 py-2.5 bg-blue-500 text-white font-bold rounded-xl border-0 hover:bg-blue-600 cursor-pointer shadow-md"
            @click="saveSettings"
          >💾 儲存並關閉</button>
        </div>
      </div>
    </div>
  </div>
</template>
