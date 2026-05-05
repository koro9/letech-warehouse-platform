<script setup>
/**
 * 出库扫码 — 方案 B（前端累加 + 一次性 validate）
 *
 * 业务流：
 *   1. 扫运单号 → GET /api/warehouse/outbound/<code>（tracking_id 优先 + origin 兜底）
 *   2. 显示该单 SKU 清单 + 需求数量
 *   3. 逐件扫商品条码 → 纯前端累加（无 API）
 *      前端实时校验：找不到 SKU / 超量 → toast 拦截
 *   4. 扫满 totalScanned === totalRequired → 自动调 validate(force=false)
 *      → 后端写 stock.move.quantity + button_validate
 *      → Odoo 现有 hook 推 hktv.order.item.fulfillment_stage='pack'
 *      → 前端 toast「✅ 出庫完成」+ reset + focus 运单号 input（等下一单）
 *   5. 强制出库 → validate(force=true) — 少扫的走 Odoo backorder
 *   6. 重置 → 纯前端清空（方案 B：后端本来没记录 quantity，不用清）
 *
 * 响应式：
 *   - 桌面：横向输入栏 + 大表格
 *   - 平板：输入栏 wrap，表格部分列保留
 *   - 手机：输入框纵向堆叠 + 卡片视图（每个 SKU 一张卡，进度条 + 数字）
 */
import { ref, computed, nextTick } from 'vue'
import { outbound, labels as labelsApi } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import RefreshButton from '@/components/RefreshButton.vue'
import { printBarcodeLabel, printNutritionLabel } from '@/utils/labelRenderers'

// ============================================================
// 状态
// ============================================================
const orderInput = ref('')
const skuInput = ref('')
const printAfterScan = ref(false)   // 是否列印 toggle — 开启时扫一件自动 print
const items = ref([])
const orderNumber = ref('')      // 显示用：tracking_id（员工扫的运单号）
const pickingId = ref(null)      // 关键：validate 时用
const subOrderNumber = ref('')   // 显示用：HKTV 子订单号
const loading = ref(false)
const validating = ref(false)    // 防 validate 期间重复触发

const orderInputEl = ref(null)
const skuInputEl = ref(null)

// 列印缓存 — 跟旧系统一致：员工手动点 [🖨️] 列印按钮
// 关键设计：scanSku 时背景预热 lookup（不打印），员工后续点按钮时 cache 已命中，
// 同步 window.open() → user gesture 链完整，浏览器不会拦 popup
//
// key = 商品 barcode (le_barcode)
// value = 'loading' | { product, master_data } | undefined (未预热)
const labelCache = new Map()

const totalRequired = computed(() => items.value.reduce((s, i) => s + i.required, 0))
const totalScanned  = computed(() => items.value.reduce((s, i) => s + i.scanned,  0))

// ============================================================
// 加载订单 — 扫运单号触发
// ============================================================
async function loadOrder() {
  const code = orderInput.value.trim()
  if (!code) return
  loading.value = true
  try {
    const data = await outbound.getOutboundOrder(code)
    pickingId.value      = data.picking_id
    orderNumber.value    = data.tracking_id || data.code || code
    subOrderNumber.value = data.sub_order_number || ''
    // 方案 B：scanned 永远从 0 开始（前端控制进度，后端没累加）
    items.value = data.items.map((it) => ({
      sku: it.sku,
      name: it.name,
      barcode: it.barcode,
      barcode2: it.barcode2 || '',
      required: it.required_qty,
      scanned: 0,
    }))
    await nextTick()
    skuInputEl.value?.focus()
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '訂單不存在或不可出庫', 'error')
    }
    items.value = []
    pickingId.value = null
  } finally {
    loading.value = false
  }
}

// 注册到全局刷新 slot：手动 🔄、409 冲突、focus 回页都触发
async function refreshOrder() {
  if (!pickingId.value) return  // 没载入订单时刷新无意义
  // 重新加载会清掉已扫进度（方案 B）—— 用户主动点刷新就是想要最新数据
  if (orderInput.value.trim()) {
    await loadOrder()
  }
}
const { refreshNow } = usePageRefresh(refreshOrder)

// ============================================================
// 扫商品条码 — 纯前端累加（方案 B）
// ============================================================
async function scanSku() {
  const code = skuInput.value.trim()
  if (!code || !pickingId.value) return
  // 防 validate 进行中的双触发
  if (validating.value) {
    skuInput.value = ''
    return
  }

  const item = items.value.find(
    (i) => i.barcode === code || i.barcode2 === code || i.sku === code
  )
  if (!item) {
    showToast(`❌ 此訂單無 ${code}`, 'error')
    skuInput.value = ''
    skuInputEl.value?.focus()
    return
  }
  if (item.scanned >= item.required) {
    showToast(`⚠️ ${item.sku} 已掃滿`, 'warning')
    skuInput.value = ''
    return
  }

  // 纯前端累加 — 不调 API，反应即时
  item.scanned += 1
  skuInput.value = ''
  skuInputEl.value?.focus()

  // 背景预热标签数据（不打印，不阻塞）— 员工后续点 [🖨️] 时 cache 命中
  preloadLabel(item)

  // toggle 开启 → 自动列印（iframe 方案不受 popup 拦截，可异步触发）
  if (printAfterScan.value) {
    autoPrintLabelForItem(item)
  }

  // 扫满整单 → 自动 validate（force=false 严格扫满）
  if (totalScanned.value === totalRequired.value && totalRequired.value > 0) {
    await doValidate(false)
  }
}

/** 自动列印 — toggle 开启时 scanSku 调
 *  iframe 不受 popup blocker 限制，可以 await 后再 print。
 *  跟手动按钮 printLabelForItem 共用 cache，避免重复请求。
 */
async function autoPrintLabelForItem(item) {
  const bc = item.barcode
  if (!bc) return  // 商品没条码就别打了
  let cached = labelCache.get(bc)
  // cache 命中（含 loading sentinel）— 等 loading 完成或直接用
  if (cached === 'loading') {
    // 等 preloadLabel 那次请求完成（最简单：轮询，一般 ~30-100ms 就好）
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 50))
      cached = labelCache.get(bc)
      if (cached !== 'loading') break
    }
  }
  if (!cached || cached === 'loading') {
    showToast(`${item.sku} 標籤資料載入超時`, 'warning')
    return
  }
  if (!cached.product && !cached.master_data) {
    showToast(`找不到 ${item.sku} 的標籤資料`, 'warning')
    return
  }
  if (cached.product) {
    printBarcodeLabel(cached.product, 1)
  }
  if (cached.master_data) {
    printNutritionLabel(cached.master_data, 1)
  }
}

// ============================================================
// 列印 — A 方案：手动按钮触发（跟旧系统一致）
// ============================================================
// 关键时序：
//   1. scanSku 累加成功 → preloadLabel(item) 背景 lookup（fire-and-forget）
//   2. 员工想打标签 → 点表格行的 [🖨️] 按钮 → click 是 user gesture
//   3. printLabelForItem 同步从 cache 读 → 同步调 window.open + print()
//   → user gesture 链完整，浏览器不拦 popup
//
// 罕见 race：员工扫完立刻点按钮，lookup 还没回来 → toast 提示稍后重试

/** 背景预热（不打印）— scanSku 调，结果塞 cache */
function preloadLabel(item) {
  const bc = item.barcode
  if (!bc) return
  if (labelCache.has(bc)) return  // 已预热 / 加载中 / 已知失败 — 都不重发
  labelCache.set(bc, 'loading')   // sentinel
  labelsApi.lookupByBarcode(bc)
    .then(res => {
      labelCache.set(bc, {
        product:     res.product,
        master_data: res.master_data || null,
      })
    })
    .catch(err => {
      if (err.handledByInterceptor) {
        labelCache.delete(bc)
        return
      }
      const code = err.response?.data?.error
      if (code === 'product_not_found') {
        // 找不到 — 缓存空结果防重试，按按钮时 toast 提示
        labelCache.set(bc, { product: null, master_data: null })
      } else {
        labelCache.delete(bc)  // 其他错误清掉，下次按按钮可重试
      }
    })
}

/** 员工手动点 [🖨️] 按钮 — 同步 click 触发 */
function printLabelForItem(item) {
  const bc = item.barcode
  if (!bc) {
    showToast(`此商品無條碼`, 'warning')
    return
  }
  const cached = labelCache.get(bc)
  if (!cached || cached === 'loading') {
    // 罕见 — 员工扫完瞬间就点
    showToast('資料載入中，請稍後重試', 'warning')
    // 没预热过的话现在补一发
    if (!cached) preloadLabel(item)
    return
  }
  if (!cached.product && !cached.master_data) {
    showToast(`找不到 ${item.sku} 的標籤資料`, 'error')
    return
  }
  // 同步 click → 同步 window.open，user gesture 链完整
  if (cached.product) {
    printBarcodeLabel(cached.product, 1)
  }
  if (cached.master_data) {
    printNutritionLabel(cached.master_data, 1)
  }
}

// ============================================================
// Validate — 一次性提交所有 quantity 触发 button_validate
// ============================================================
async function doValidate(force) {
  if (!pickingId.value || validating.value) return
  validating.value = true
  try {
    const quantities = items.value
      .filter(it => it.sku)
      .map(it => ({ sku: it.sku, qty: it.scanned }))

    await outbound.validateOutbound(pickingId.value, quantities, force)
    showToast('✅ 出庫完成', 'success')
    reset()
    nextTick(() => orderInputEl.value?.focus())
  } catch (err) {
    if (!err.handledByInterceptor) {
      const code = err.response?.data?.error
      let msg = err.response?.data?.detail || err.response?.data?.error || '出庫失敗'
      if (code === 'over_quantity') {
        msg = `⚠️ 超量：${err.response.data.sku} 需求 ${err.response.data.required}，提交 ${err.response.data.received}`
      } else if (code === 'not_complete') {
        msg = `⚠️ 未掃滿：剩 ${err.response.data.unscanned} 件，可點「強制出庫」`
      } else if (code === 'picking_already_done') {
        msg = '此單已完成出庫'
      }
      showToast(msg, 'error')
    }
  } finally {
    validating.value = false
  }
}

// 强制出库（不加 confirm — 决策：加快操作）
function forceComplete() {
  if (!pickingId.value) return
  doValidate(true)
}

// ============================================================
// 重置 — 纯前端清空（方案 B：后端没记录扫码进度，不用清）
// ============================================================
function reset() {
  orderInput.value = ''
  skuInput.value = ''
  items.value = []
  orderNumber.value = ''
  subOrderNumber.value = ''
  pickingId.value = null
  labelCache.clear()
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <!-- 顶部输入栏 + 操作按钮 -->
    <!-- 手机：纵向堆叠；md+ 横向并排 -->
    <div class="space-y-3 md:space-y-0 md:flex md:items-center md:gap-4 md:flex-wrap mb-5 sm:mb-7">
      <!-- 输入框组 -->
      <input
        ref="orderInputEl"
        v-model="orderInput"
        @keydown.enter="loadOrder"
        class="g-input w-full md:w-[280px]"
        style="height: 46px;"
        placeholder="掃描運單號"
        autocomplete="off"
      />
      <input
        ref="skuInputEl"
        v-model="skuInput"
        @keydown.enter="scanSku"
        class="g-input w-full md:w-[280px]"
        style="height: 46px;"
        placeholder="掃描商品條碼"
        autocomplete="off"
        :disabled="!pickingId"
      />

      <!-- 是否列印 toggle + 操作按钮组 — 手机一行装下，md+ 流式 -->
      <!-- toggle 开启：扫一件自动弹列印（iframe 方案）；关闭：员工手动点行内 [🖨️] -->
      <div class="flex items-center gap-2.5 md:gap-2.5 flex-wrap md:flex-nowrap md:ml-auto">
        <div class="g-toggle-wrap">
          <button
            class="g-toggle"
            :class="{ on: printAfterScan }"
            :title="printAfterScan ? '掃一件自動彈列印對話框' : '只能手動點 [🖨️] 列印'"
            @click="printAfterScan = !printAfterScan"
          />
          <span class="text-sm text-gray-500">是否列印</span>
        </div>
        <RefreshButton v-if="pickingId" :on-refresh="refreshNow" />
        <button class="g-btn g-btn-teal" @click="reset">重置</button>
        <button class="g-btn g-btn-pink" :disabled="!pickingId || validating" @click="forceComplete">
          {{ validating ? '處理中…' : '強制出庫' }}
        </button>
      </div>
    </div>

    <!-- 当前订单元信息（小行字，方便员工核对） -->
    <div v-if="orderNumber" class="text-xs text-gray-500 mb-3 flex items-center gap-3 flex-wrap">
      <span>運單號：<span class="font-mono font-semibold text-gray-800">{{ orderNumber }}</span></span>
      <span v-if="subOrderNumber" class="text-gray-300">·</span>
      <span v-if="subOrderNumber">訂單號：<span class="font-mono">{{ subOrderNumber }}</span></span>
    </div>

    <!-- 桌面/平板：表格 -->
    <div class="hidden md:block g-card overflow-hidden">
      <table class="g-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>中文名</th>
            <th class="hidden lg:table-cell">barcode</th>
            <th class="hidden lg:table-cell">barcode2</th>
            <th class="text-center">訂單數量</th>
            <th class="text-center">出庫數量</th>
            <th class="text-center">列印</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="items.length === 0">
            <td :colspan="7" class="text-center py-16 text-gray-300">
              掃描運單號開始出庫核驗
            </td>
          </tr>
          <tr v-for="it in items" :key="it.sku">
            <td class="font-mono font-semibold">{{ it.sku }}</td>
            <td>{{ it.name }}</td>
            <td class="hidden lg:table-cell font-mono text-xs text-gray-500">{{ it.barcode }}</td>
            <td class="hidden lg:table-cell font-mono text-xs text-gray-500">{{ it.barcode2 }}</td>
            <td class="text-center font-semibold">{{ it.required }}</td>
            <td class="text-center font-bold" :class="it.scanned >= it.required ? 'text-green-600' : 'text-amber-600'">
              {{ it.scanned }}
            </td>
            <td class="text-center">
              <button
                class="g-btn g-btn-teal"
                style="padding:4px 12px;font-size:12px;"
                :disabled="it.scanned === 0"
                :title="it.scanned === 0 ? '請先掃描此商品' : '列印標籤'"
                @click="printLabelForItem(it)"
              >🖨️</button>
            </td>
          </tr>
          <tr v-if="pickingId" class="bg-gray-50 font-bold">
            <td :colspan="4" class="text-right hidden lg:table-cell">合計</td>
            <td colspan="2" class="text-right lg:hidden">合計</td>
            <td class="text-center">{{ totalRequired }}</td>
            <td class="text-center">{{ totalScanned }}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 手机：卡片列表 -->
    <div class="md:hidden">
      <div v-if="items.length === 0" class="g-card p-10 text-center text-gray-300 text-sm">
        掃描運單號開始出庫核驗
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="it in items" :key="it.sku"
          class="g-card p-3"
          :class="it.scanned >= it.required ? 'border-green-200 bg-green-50/30' : ''"
        >
          <div class="flex items-start justify-between gap-3 mb-2">
            <div class="flex-1 min-w-0">
              <div class="font-mono font-semibold text-sm text-gray-800 truncate">{{ it.sku }}</div>
              <div class="text-xs text-gray-600 mt-0.5 line-clamp-2">{{ it.name }}</div>
            </div>
            <div class="text-right flex-shrink-0">
              <div class="text-xs text-gray-400">已掃 / 需求</div>
              <div class="text-lg font-bold leading-tight" :class="it.scanned >= it.required ? 'text-green-600' : 'text-amber-600'">
                {{ it.scanned }}<span class="text-gray-300 mx-0.5">/</span><span class="text-gray-500">{{ it.required }}</span>
              </div>
            </div>
          </div>
          <!-- 进度条 -->
          <div class="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              class="h-full transition-all duration-200"
              :class="it.scanned >= it.required ? 'bg-green-500' : 'bg-amber-500'"
              :style="{ width: Math.min(100, (it.scanned / it.required) * 100) + '%' }"
            ></div>
          </div>
          <!-- 底部：barcode 折叠 + 列印按钮 -->
          <div class="mt-2 flex items-center justify-between gap-2 flex-wrap">
            <details v-if="it.barcode || it.barcode2" class="text-xs text-gray-500 flex-1 min-w-0">
              <summary class="cursor-pointer">條碼</summary>
              <div class="mt-1 space-y-0.5 font-mono">
                <div v-if="it.barcode" class="break-all">{{ it.barcode }}</div>
                <div v-if="it.barcode2" class="break-all opacity-70">{{ it.barcode2 }}</div>
              </div>
            </details>
            <button
              class="g-btn g-btn-teal flex-shrink-0"
              style="padding:5px 14px;font-size:12px;"
              :disabled="it.scanned === 0"
              @click="printLabelForItem(it)"
            >🖨️ 列印</button>
          </div>
        </div>
        <!-- 合计 -->
        <div v-if="pickingId" class="g-card p-3 bg-gray-50 font-bold flex items-center justify-between">
          <span class="text-sm text-gray-700">合計</span>
          <span class="text-base">
            {{ totalScanned }}<span class="text-gray-300 mx-0.5">/</span><span class="text-gray-500">{{ totalRequired }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
