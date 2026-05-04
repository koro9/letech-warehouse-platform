<script setup>
/**
 * 出库扫码 — 复刻 demo s1-outbound
 *
 * 流程：
 *   1. 扫订单号 → GET /api/warehouse/outbound/:orderNumber
 *   2. 扫商品条码 → 找到对应行 → POST scan → +1
 *   3. 全部扫完自动完成；或点"强制出库"
 *
 * 响应式：
 *   - 桌面：横向输入栏 + 大表格
 *   - 平板：输入栏 wrap，表格部分列保留
 *   - 手机：输入框纵向堆叠 + 卡片视图（每个 SKU 一张卡，进度条 + 数字）
 */
import { ref, computed, nextTick } from 'vue'
import { outbound } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import RefreshButton from '@/components/RefreshButton.vue'

const orderInput = ref('')
const skuInput = ref('')
const printAfterScan = ref(false)
const items = ref([])
const orderNumber = ref('')
const loading = ref(false)

const skuInputEl = ref(null)

const totalRequired = computed(() => items.value.reduce((s, i) => s + i.required, 0))
const totalScanned = computed(() => items.value.reduce((s, i) => s + i.scanned, 0))

async function loadOrder() {
  if (!orderInput.value.trim()) return
  loading.value = true
  try {
    const data = await outbound.getOutboundOrder(orderInput.value.trim())
    orderNumber.value = data.order_number
    items.value = data.items.map((it) => ({
      sku: it.sku,
      name: it.name,
      barcode: it.barcode,
      barcode2: it.barcode2 || '',
      required: it.required_qty,
      scanned: it.scanned_qty || 0,
    }))
    await nextTick()
    skuInputEl.value?.focus()
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '訂單不存在或不可出庫', 'error')
    }
    items.value = []
  } finally {
    loading.value = false
  }
}

// 注册到全局刷新 slot：手动 🔄、409 冲突、focus 回页都触发
async function refreshOrder() {
  if (!orderNumber.value) return  // 没载入订单时刷新无意义
  await loadOrder()
}
const { refreshNow } = usePageRefresh(refreshOrder)

async function scanSku() {
  if (!skuInput.value.trim() || !orderNumber.value) return
  const code = skuInput.value.trim()
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
  try {
    await outbound.scanOutbound({
      orderNumber: orderNumber.value,
      sku: item.sku,
      qty: 1,
    })
    item.scanned += 1
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '掃碼失敗', 'error')
    }
  } finally {
    skuInput.value = ''
    skuInputEl.value?.focus()
  }
}

function reset() {
  orderInput.value = ''
  skuInput.value = ''
  items.value = []
  orderNumber.value = ''
}

async function forceComplete() {
  if (!orderNumber.value) return
  if (!confirm('確定強制完成出庫？未掃的 SKU 視為漏掃。')) return
  loading.value = true
  try {
    await outbound.forceCompleteOutbound(orderNumber.value)
    showToast('已強制完成', 'success')
    reset()
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '操作失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <!-- 顶部输入栏 + 操作按钮 -->
    <!-- 手机：纵向堆叠；md+ 横向并排 -->
    <div class="space-y-3 md:space-y-0 md:flex md:items-center md:gap-4 md:flex-wrap mb-5 sm:mb-7">
      <!-- 输入框组 -->
      <input
        v-model="orderInput"
        @keydown.enter="loadOrder"
        class="g-input w-full md:w-[280px]"
        style="height: 46px;"
        placeholder="掃描訂單號"
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
        :disabled="!orderNumber"
      />

      <!-- 是否打印 + 操作按钮组 — 手机一行装下，md+ 流式 -->
      <div class="flex items-center gap-2.5 md:gap-2.5 flex-wrap md:flex-nowrap md:ml-auto">
        <div class="g-toggle-wrap">
          <button class="g-toggle" :class="{ on: printAfterScan }" @click="printAfterScan = !printAfterScan" />
          <span class="text-sm text-gray-500">是否列印</span>
        </div>
        <RefreshButton v-if="orderNumber" :on-refresh="refreshNow" />
        <button class="g-btn g-btn-teal" @click="reset">重置</button>
        <button class="g-btn g-btn-pink" :disabled="!orderNumber" @click="forceComplete">強制出庫</button>
      </div>
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
          </tr>
        </thead>
        <tbody>
          <tr v-if="items.length === 0">
            <td :colspan="6" class="text-center py-16 text-gray-300">
              掃描訂單號開始出庫核驗
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
          </tr>
          <tr v-if="orderNumber" class="bg-gray-50 font-bold">
            <td :colspan="4" class="text-right hidden lg:table-cell">合計</td>
            <td colspan="2" class="text-right lg:hidden">合計</td>
            <td class="text-center">{{ totalRequired }}</td>
            <td class="text-center">{{ totalScanned }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 手机：卡片列表 -->
    <div class="md:hidden">
      <div v-if="items.length === 0" class="g-card p-10 text-center text-gray-300 text-sm">
        掃描訂單號開始出庫核驗
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
          <!-- barcode 信息（折叠在 details 里） -->
          <details v-if="it.barcode || it.barcode2" class="mt-2 text-xs text-gray-500">
            <summary class="cursor-pointer">條碼</summary>
            <div class="mt-1 space-y-0.5 font-mono">
              <div v-if="it.barcode" class="break-all">{{ it.barcode }}</div>
              <div v-if="it.barcode2" class="break-all opacity-70">{{ it.barcode2 }}</div>
            </div>
          </details>
        </div>
        <!-- 合计 -->
        <div v-if="orderNumber" class="g-card p-3 bg-gray-50 font-bold flex items-center justify-between">
          <span class="text-sm text-gray-700">合計</span>
          <span class="text-base">
            {{ totalScanned }}<span class="text-gray-300 mx-0.5">/</span><span class="text-gray-500">{{ totalRequired }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
