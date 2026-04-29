<script setup>
/**
 * 出库扫码 — 复刻 demo s1-outbound
 *
 * 流程：
 *   1. 扫订单号 → GET /api/warehouse/outbound/:orderNumber
 *   2. 扫商品条码 → 找到对应行 → POST scan → +1
 *   3. 全部扫完自动完成；或点"强制出库"
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
      showToast(err.response?.data?.error || '订单不存在或不可出库', 'error')
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
    showToast(`❌ 此订单无 ${code}`, 'error')
    skuInput.value = ''
    skuInputEl.value?.focus()
    return
  }
  if (item.scanned >= item.required) {
    showToast(`⚠️ ${item.sku} 已扫满`, 'warning')
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
    showToast(err.response?.data?.error || '扫码失败', 'error')
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
  if (!confirm('确定强制完成出库？未扫的 SKU 视为漏扫。')) return
  loading.value = true
  try {
    await outbound.forceCompleteOutbound(orderNumber.value)
    showToast('已强制完成', 'success')
    reset()
  } catch (err) {
    showToast(err.response?.data?.error || '操作失败', 'error')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="p-10">
    <!-- 顶部输入栏 -->
    <div class="flex items-center gap-4 mb-7 flex-wrap">
      <input
        v-model="orderInput"
        @keydown.enter="loadOrder"
        class="g-input"
        style="width: 280px; height: 46px;"
        placeholder="扫描订单号"
      />
      <input
        ref="skuInputEl"
        v-model="skuInput"
        @keydown.enter="scanSku"
        class="g-input"
        style="width: 280px; height: 46px;"
        placeholder="扫描商品条码"
        :disabled="!orderNumber"
      />
      <div class="g-toggle-wrap">
        <button class="g-toggle" :class="{ on: printAfterScan }" @click="printAfterScan = !printAfterScan" />
        <span class="text-sm text-gray-500">是否打印</span>
      </div>
      <div class="ml-auto flex items-center gap-2.5">
        <RefreshButton v-if="orderNumber" :on-refresh="refreshNow" />
        <button class="g-btn g-btn-teal" @click="reset">重制</button>
        <button class="g-btn g-btn-pink" :disabled="!orderNumber" @click="forceComplete">强制出库</button>
      </div>
    </div>

    <!-- 表格 -->
    <div class="g-card overflow-hidden">
      <table class="g-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>中文名</th>
            <th>barcode</th>
            <th>barcode2</th>
            <th class="text-center">订单数量</th>
            <th class="text-center">出库数量</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="items.length === 0">
            <td colspan="6" class="text-center py-16 text-gray-300">
              扫描订单号开始出库核验
            </td>
          </tr>
          <tr v-for="it in items" :key="it.sku">
            <td class="font-mono font-semibold">{{ it.sku }}</td>
            <td>{{ it.name }}</td>
            <td class="font-mono text-xs text-gray-500">{{ it.barcode }}</td>
            <td class="font-mono text-xs text-gray-500">{{ it.barcode2 }}</td>
            <td class="text-center font-semibold">{{ it.required }}</td>
            <td class="text-center font-bold" :class="it.scanned >= it.required ? 'text-green-600' : 'text-amber-600'">
              {{ it.scanned }}
            </td>
          </tr>
          <tr v-if="orderNumber" class="bg-gray-50 font-bold">
            <td colspan="4" class="text-right">合计</td>
            <td class="text-center">{{ totalRequired }}</td>
            <td class="text-center">{{ totalScanned }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
