<script setup>
/**
 * 手機上架 — 仓库员工用手机浏览器开 WMS，逐件把「未上架」的货登记到货架（Bin Location）
 *
 * 流程（一屏，手机优先）：
 *   1. 扫 / 输货架条码 → 记住「目前貨架」（URL ?loc=<id>，刷新不丢）
 *   2. 扫 / 输商品条码或 SKU → 显示未上架可上数量、本货架已有数量
 *   3. 核对到期日（有批次的商品）：未上架现有的到期日点选，对不上就填实物日期
 *   4. 输数量（支持 4x5 / 4*5+3）→ 「上架」：后端开「貨架移動」单并立即完成
 *   5. 回到第 2 步继续扫下一件；换货架再扫货架条码
 *
 * 后端沿用 POST /shelf/move（来源 = 仓库存根库位本层 = 未上架）。
 * 到期日：选中的到期日在未上架有单一批次且够数 → 传 lot_id 只搬这批；
 *        否则按先到期先出搬 + new_expiry 在货架上改登成实物到期日（件数不变，有审计）。
 * 数量不能超过未上架可上数量（数据底线，不在这里凭空加库存）。
 */
import { computed, defineAsyncComponent, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { shelf } from '@/api'
import { showToast } from '@/composables/useToast'
import { fmtQty } from './shelfRows'

const BarcodeScanner = defineAsyncComponent(() => import('@/components/BarcodeScanner.vue'))

const route = useRoute()
const router = useRouter()

// ── 目前货架 ─────────────────────────────────────────────
const bin = ref(null)            // { id, name, full_name, barcode }
const binWarehouse = ref('')     // 仓库 code
const binItems = ref([])         // 本货架（含下层）上已有的商品 [{ sku, name, on_hand }]
const binLoading = ref(false)
const binSuggestions = ref([])

// ── 当前商品 ─────────────────────────────────────────────
const product = ref(null)        // { sku, name, barcode, fefo, lot_tracked }
const rootId = ref(0)            // 未上架 = 仓库存根库位
const rootLots = ref([])         // 未上架本层的批次 [{ lot_id, name, expiry, available }]
const onBin = ref(0)             // 本货架本层已有件数
const productSuggestions = ref([])
const productLoading = ref(false)

const expiry = ref('')           // 选中的到期日（YYYY-MM-DD），'' = 未选
const customExpiry = ref(false)  // 是否手填日期
const qtyText = ref('')
const error = ref('')
const submitting = ref(false)
let idemKey = ''

const scanText = ref('')
const scanInput = ref(null)
const scannerOpen = ref(false)

const session = ref([])          // 本次已上架（只在本页，最新在前）

const step = computed(() => (!bin.value ? 'bin' : !product.value ? 'item' : 'form'))

const available = computed(() => rootLots.value.reduce((s, l) => s + l.available, 0))

// 未上架的到期日选项（同一到期日多批次合并）
const expiryOptions = computed(() => {
  const by = new Map()
  for (const l of rootLots.value) {
    const k = l.expiry || ''
    const o = by.get(k) || { expiry: k, available: 0, lots: [] }
    o.available += l.available
    o.lots.push(l)
    by.set(k, o)
  }
  return [...by.values()].sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'))
})

const needExpiry = computed(() => !!product.value?.lot_tracked)

// 数量：允许 4x5、4*5、4×5+3 这类简单算式
const qty = computed(() => {
  const s = String(qtyText.value || '').replace(/\s/g, '').replace(/[x×X]/g, '*')
  if (!s || !/^[\d.*+]+$/.test(s)) return NaN
  let total = 0
  for (const term of s.split('+')) {
    if (!term) return NaN
    let prod = 1
    for (const f of term.split('*')) {
      const n = Number(f)
      if (f === '' || !Number.isFinite(n)) return NaN
      prod *= n
    }
    total += prod
  }
  return total
})
const qtyIsExpr = computed(() => /[x×X*+]/.test(qtyText.value || ''))

// ── 扫码 / 输入 ──────────────────────────────────────────
function focusScan() {
  nextTick(() => scanInput.value?.focus())
}

function onScanSubmit() {
  const code = scanText.value.trim()
  if (!code) return
  scanText.value = ''
  handleCode(code)
}

function onCameraHit(code) {
  scannerOpen.value = false
  if (code) handleCode(code)
}

// 在「扫商品」或填表时扫到货架条码也认：先试商品，找不到再试货架（见 lookupProduct）
function handleCode(code) {
  error.value = ''
  if (step.value === 'bin') lookupBin({ q: code })
  else lookupProduct(code)
}

// ── 货架 ────────────────────────────────────────────────
async function lookupBin({ q, locationId }, { quiet = false } = {}) {
  binLoading.value = true
  binSuggestions.value = []
  try {
    const res = await shelf.getLocationStock({ q, locationId })
    if (res.tree && res.tree.id && isRoot(res)) {
      error.value = `「${res.location.full_name}」是未上架的倉庫根位置，請掃貨架或格子條碼`
      return false
    }
    bin.value = res.location
    binWarehouse.value = res.warehouse?.code || ''
    binItems.value = collectItems(res.tree)
    if (String(route.query.loc || '') !== String(res.location.id)) {
      router.replace({ query: { ...route.query, loc: res.location.id } })
    }
    resetProduct()
    return true
  } catch (err) {
    if (err.handledByInterceptor) return false
    const data = err.response?.data || {}
    if (data.error === 'location_ambiguous') {
      binSuggestions.value = data.suggestions || []
      error.value = '有多個位置符合，請點選'
    } else if (data.error === 'location_not_found') {
      binSuggestions.value = data.suggestions || []
      if (!quiet) error.value = `找不到貨架「${q || ''}」。貨架 / 格子要先在 Odoo「庫存 → 配置 → 地點」建立`
    } else if (!quiet) {
      error.value = '查詢貨架失敗，請重試'
    }
    return false
  } finally {
    binLoading.value = false
    focusScan()
  }
}

// 货架查询返回的 location 没有 parent 信息；用 full_name 判断是不是「XXX/库存」根层
function isRoot(res) {
  const parts = String(res.location?.full_name || '').split('/')
  return parts.length <= 2
}

function collectItems(tree) {
  const by = new Map()
  const walk = (node) => {
    for (const it of node?.own?.items || []) {
      const o = by.get(it.sku) || { sku: it.sku, name: it.name, on_hand: 0 }
      o.on_hand += Number(it.on_hand) || 0
      by.set(it.sku, o)
    }
    for (const c of node?.children || []) walk(c)
  }
  walk(tree)
  return [...by.values()].sort((a, b) => a.sku.localeCompare(b.sku))
}

function changeBin() {
  bin.value = null
  binItems.value = []
  resetProduct()
  error.value = ''
  const q = { ...route.query }
  delete q.loc
  router.replace({ query: q })
  focusScan()
}

async function refreshBin() {
  if (!bin.value) return
  try {
    const res = await shelf.getLocationStock({ locationId: bin.value.id })
    binItems.value = collectItems(res.tree)
  } catch { /* 刷新失败不打断作业 */ }
}

// ── 商品 ────────────────────────────────────────────────
function resetProduct() {
  product.value = null
  rootLots.value = []
  rootId.value = 0
  onBin.value = 0
  productSuggestions.value = []
  expiry.value = ''
  customExpiry.value = false
  qtyText.value = ''
  idemKey = ''
}

async function lookupProduct(q) {
  productLoading.value = true
  productSuggestions.value = []
  try {
    const res = await shelf.getProductBins(q, binWarehouse.value || undefined)
    resetProduct()
    product.value = res.product
    rootId.value = res.tree.id
    rootLots.value = (res.tree.own?.lots || [])
      .map(l => ({ ...l, available: (Number(l.on_hand) || 0) - (Number(l.reserved) || 0) }))
      .filter(l => l.available > 0)
    onBin.value = findOwn(res.tree, bin.value.id)
    // 只有一个到期日时默认选上，多个就要员工自己点（核对实物）
    const opts = expiryOptions.value
    if (opts.length === 1 && opts[0].expiry) expiry.value = opts[0].expiry
    if (!available.value) error.value = '這個商品在未上架已經沒有可上架的數量'
  } catch (err) {
    if (err.handledByInterceptor) return
    const data = err.response?.data || {}
    if (data.error === 'product_not_found') {
      // 扫到的可能是另一个货架的条码 → 直接换货架
      const switched = await lookupBin({ q }, { quiet: true })
      if (switched) { showToast(`已換到貨架 ${bin.value.name}`, 'success'); return }
      productSuggestions.value = data.suggestions || []
      error.value = productSuggestions.value.length
        ? `找不到「${q}」，是不是以下商品？`
        : `找不到商品或貨架「${q}」`
    } else {
      error.value = '查詢商品失敗，請重試'
    }
  } finally {
    productLoading.value = false
  }
}

function findOwn(node, id) {
  if (!node) return 0
  if (node.id === id) return Number(node.own?.on_hand) || 0
  for (const c of node.children || []) {
    const v = findOwn(c, id)
    if (v) return v
  }
  return 0
}

function pickExpiry(e) {
  customExpiry.value = false
  expiry.value = e
  error.value = ''
}

function useCustomExpiry() {
  customExpiry.value = true
  expiry.value = ''
}

function cancelItem() {
  resetProduct()
  error.value = ''
  focusScan()
}

// ── 上架 ────────────────────────────────────────────────
function buildPayload() {
  const body = { sku: product.value.sku, sourceLocationId: rootId.value, destLocationId: bin.value.id, qty: qty.value }
  if (!needExpiry.value) return body
  const opt = expiryOptions.value.find(o => o.expiry === expiry.value)
  if (opt && opt.lots.length === 1 && qty.value <= opt.available) {
    body.lotId = opt.lots[0].lot_id      // 实物到期日在未上架有，就搬这一批
  } else {
    body.newExpiry = expiry.value        // 先到期先出搬，再在货架上改登成实物到期日
  }
  return body
}

async function submit() {
  if (submitting.value) return
  error.value = ''
  if (needExpiry.value && !/^\d{4}-\d{2}-\d{2}$/.test(expiry.value)) {
    error.value = '請先核對到期日'
    return
  }
  if (!(qty.value > 0)) { error.value = '請輸入數量'; return }
  if (qty.value > available.value) {
    error.value = `未上架只有 ${fmtQty(available.value)} 件可上架`
    return
  }
  if (!idemKey) idemKey = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`
  submitting.value = true
  try {
    const res = await shelf.moveStock(buildPayload(), idemKey)
    session.value.unshift({
      key: idemKey, time: new Date().toTimeString().slice(0, 5),
      sku: res.sku, name: product.value.name, qty: res.qty, bin: res.dest.name,
      expiry: needExpiry.value ? expiry.value : '', picking: res.picking,
    })
    showToast(`已上架 ${res.sku} × ${fmtQty(res.qty)} → ${res.dest.name}`, 'success')
    try { navigator.vibrate && navigator.vibrate(60) } catch { /* noop */ }
    resetProduct()
    refreshBin()
    focusScan()
  } catch (err) {
    if (err.handledByInterceptor) return
    const data = err.response?.data || {}
    const msgs = {
      insufficient_qty: `未上架只有 ${fmtQty(data.available)} 件可上架（可能有同事剛上了），請改數量`,
      busy: '其他同事正在移動這個商品，請稍等再按一次',
      shelf_locked: `這個貨架正在區域盤點（${data.task || ''} ${data.employee || ''}），暫時不能上架`,
      shelf_move_type_missing: '此倉庫尚未設定「貨架移動」作業類型，請聯絡主管',
      invalid_expiry: '到期日格式不對',
      not_lot_tracked: '這個商品不按批次管理，不能登到期日',
      location_outside_warehouse: '貨架和商品不在同一個倉庫',
      move_failed: `上架失敗：${data.message || ''}`,
    }
    error.value = msgs[data.error] || data.error || '上架失敗，請重試'
    // busy 原样重试用同一个 key；其他错误改了内容算新的一次
    if (data.error !== 'busy') idemKey = ''
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  const loc = Number(route.query.loc)
  if (loc) await lookupBin({ locationId: loc }, { quiet: true })
  focusScan()
})
</script>

<template>
  <div class="max-w-xl mx-auto pb-28">
    <!-- 目前货架 -->
    <div class="g-card !p-4 mb-3">
      <div v-if="bin" class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-[#EAF4F1] text-[#2F6B5F] flex items-center justify-center text-xl flex-shrink-0">🗄️</div>
        <div class="min-w-0 flex-1">
          <div class="text-xs text-gray-400">目前貨架</div>
          <div class="text-xl font-bold text-gray-800 truncate">{{ bin.name }}</div>
          <div class="text-xs text-gray-400 truncate">{{ bin.full_name }}</div>
        </div>
        <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-3 flex-shrink-0" @click="changeBin">換貨架</button>
      </div>
      <div v-else class="text-center py-2">
        <div class="text-3xl mb-1">🗄️</div>
        <div class="text-lg font-bold text-gray-800">先掃貨架條碼</div>
        <div class="text-sm text-gray-400">掃完貨架，再逐件掃商品上架</div>
      </div>
    </div>

    <!-- 扫码输入（货架 / 商品共用） -->
    <form v-if="step !== 'form'" class="flex gap-2 mb-3" @submit.prevent="onScanSubmit">
      <input
        ref="scanInput"
        v-model="scanText"
        type="text"
        class="g-input flex-1 min-w-0 w-0 !text-base !py-3"
        :placeholder="step === 'bin' ? '貨架條碼，例如 HSD4-T1-1' : '商品條碼或 SKU'"
        autocomplete="off"
        autocapitalize="characters"
        enterkeyhint="search"
      />
      <button type="button" class="g-btn g-btn-teal !px-4 !py-3 text-lg" aria-label="相機掃碼" @click="scannerOpen = true">📷</button>
      <button type="submit" class="g-btn bg-white border border-gray-200 text-gray-700 !px-4 !py-3" :disabled="binLoading || productLoading">
        {{ binLoading || productLoading ? '…' : '確定' }}
      </button>
    </form>

    <p v-if="error && step !== 'form'" class="text-sm text-red-600 mb-3 px-1">{{ error }}</p>

    <!-- 货架候选 -->
    <div v-if="binSuggestions.length && step === 'bin'" class="g-card !p-0 mb-3 divide-y divide-gray-100 overflow-hidden">
      <button
        v-for="s in binSuggestions" :key="s.id" type="button"
        class="w-full text-left px-4 py-3 active:bg-[#EEF4F2] flex justify-between gap-2"
        @click="lookupBin({ locationId: s.id })"
      >
        <span class="text-gray-800">{{ s.full_name }}</span>
        <span v-if="s.barcode" class="font-mono text-xs text-gray-400">{{ s.barcode }}</span>
      </button>
    </div>

    <!-- 商品候选 -->
    <div v-if="productSuggestions.length && step === 'item'" class="g-card !p-0 mb-3 divide-y divide-gray-100 overflow-hidden">
      <button
        v-for="s in productSuggestions" :key="s.sku" type="button"
        class="w-full text-left px-4 py-3 active:bg-[#EEF4F2]"
        @click="lookupProduct(s.sku)"
      >
        <div class="font-mono text-sm text-gray-800">{{ s.sku }}</div>
        <div class="text-xs text-gray-500 truncate">{{ s.name }}</div>
      </button>
    </div>

    <!-- 上架表单 -->
    <div v-if="step === 'form'" class="g-card !p-4 mb-3 space-y-4">
      <div>
        <div class="font-mono text-sm text-[#2F6B5F] font-semibold">{{ product.sku }}</div>
        <div class="text-base font-bold text-gray-800 leading-snug">{{ product.name }}</div>
        <div class="flex gap-2 mt-2 text-sm">
          <span class="px-2 py-1 rounded-lg bg-emerald-50 text-emerald-800">未上架可上 <b>{{ fmtQty(available) }}</b></span>
          <span class="px-2 py-1 rounded-lg bg-gray-100 text-gray-600">本貨架已有 <b>{{ fmtQty(onBin) }}</b></span>
        </div>
      </div>

      <!-- 到期日 -->
      <div v-if="needExpiry">
        <div class="text-sm text-gray-500 mb-2">核對到期日（以實物為準）</div>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="o in expiryOptions" :key="o.expiry || 'none'" type="button"
            class="px-3 py-2 rounded-xl border text-left"
            :class="!customExpiry && expiry === o.expiry && o.expiry
              ? 'border-[#2F6B5F] bg-[#EAF4F1] text-[#2F6B5F] font-semibold'
              : 'border-gray-200 bg-white text-gray-700'"
            :disabled="!o.expiry"
            @click="pickExpiry(o.expiry)"
          >
            <div class="text-base">{{ o.expiry || '無到期日' }}</div>
            <div class="text-xs opacity-70">未上架 {{ fmtQty(o.available) }} 件</div>
          </button>
          <button
            type="button"
            class="px-3 py-2 rounded-xl border"
            :class="customExpiry ? 'border-[#2F6B5F] bg-[#EAF4F1] text-[#2F6B5F] font-semibold' : 'border-dashed border-gray-300 text-gray-500'"
            @click="useCustomExpiry"
          >
            <div class="text-base">其他日期</div>
            <div class="text-xs opacity-70">實物對不上時</div>
          </button>
        </div>
        <input v-if="customExpiry" v-model="expiry" type="date" class="g-input w-full mt-2 !text-base !py-3" />
      </div>

      <!-- 数量 -->
      <div>
        <label class="text-sm text-gray-500 mb-2 block" for="mp-qty">數量（可輸入 4x5、4x5+3）</label>
        <div class="flex items-center gap-2">
          <input
            id="mp-qty"
            v-model="qtyText"
            type="text"
            inputmode="text"
            class="g-input flex-1 min-w-0 w-0 !text-2xl !py-3 font-bold"
            placeholder="0"
            autocomplete="off"
            enterkeyhint="done"
            @keydown.enter.prevent="submit"
          />
          <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-4 !py-3" @click="qtyText = fmtQty(available)">全部</button>
        </div>
        <div v-if="qtyIsExpr" class="text-sm mt-1" :class="Number.isNaN(qty) ? 'text-red-500' : 'text-gray-500'">
          = {{ Number.isNaN(qty) ? '算式不對' : fmtQty(qty) + ' 件' }}
        </div>
      </div>

      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

      <div class="flex gap-2">
        <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-4 !py-3" :disabled="submitting" @click="cancelItem">取消</button>
        <button type="button" class="g-btn g-btn-teal flex-1 !py-3 text-base" :disabled="submitting || !available" @click="submit">
          {{ submitting ? '處理中…' : `上架${qty > 0 ? ' ' + fmtQty(qty) + ' 件' : ''}到 ${bin.name}` }}
        </button>
      </div>
    </div>

    <!-- 本次已上架 -->
    <div v-if="session.length" class="g-card !p-0 mb-3 overflow-hidden">
      <div class="px-4 py-2 text-sm font-semibold text-gray-600 bg-gray-50 border-b border-gray-100">本次已上架 {{ session.length }} 筆</div>
      <div v-for="s in session" :key="s.key" class="px-4 py-2 border-b border-gray-50 last:border-0 flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="font-mono text-sm text-gray-800">{{ s.sku }}</div>
          <div class="text-xs text-gray-400 truncate">{{ s.time }} · {{ s.bin }}<span v-if="s.expiry"> · 到期 {{ s.expiry }}</span> · {{ s.picking }}</div>
        </div>
        <div class="text-base font-bold text-[#2F6B5F]">× {{ fmtQty(s.qty) }}</div>
      </div>
    </div>

    <!-- 本货架现有商品 -->
    <div v-if="bin" class="g-card !p-0 overflow-hidden">
      <div class="px-4 py-2 text-sm font-semibold text-gray-600 bg-gray-50 border-b border-gray-100">
        {{ bin.name }} 上現有 {{ binItems.length }} 個 SKU
      </div>
      <div v-if="!binItems.length" class="px-4 py-4 text-sm text-gray-400">還沒有商品</div>
      <div v-for="it in binItems" :key="it.sku" class="px-4 py-2 border-b border-gray-50 last:border-0 flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="font-mono text-sm text-gray-800">{{ it.sku }}</div>
          <div class="text-xs text-gray-400 truncate">{{ it.name }}</div>
        </div>
        <div class="text-sm font-semibold text-gray-700">{{ fmtQty(it.on_hand) }}</div>
      </div>
    </div>

    <BarcodeScanner v-if="scannerOpen" @detected="onCameraHit" @close="scannerOpen = false; focusScan()" />
  </div>
</template>
