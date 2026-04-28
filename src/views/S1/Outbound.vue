<script setup>
/**
 * S1 出库扫码（demo s1-outbound 的 Vue 重写）
 *
 * 流程：
 *   1. 扫订单号 → 调 GET /api/warehouse/outbound/:orderNumber → 拉 SKU 清单
 *   2. 扫商品条码 → 找到对应行 → 调 POST scan → +1
 *   3. 全部扫完 → 自动完成；或点"强制出库"
 */
import { ref, computed, nextTick } from 'vue'
import { warehouseAPI } from '@/utils/api'

const orderInput = ref('')
const skuInput = ref('')
const printAfterScan = ref(false)
const items = ref([])
const orderNumber = ref('')
const error = ref('')
const loading = ref(false)

const skuInputEl = ref(null)

const totalRequired = computed(() =>
  items.value.reduce((s, i) => s + i.required, 0)
)
const totalScanned = computed(() =>
  items.value.reduce((s, i) => s + i.scanned, 0)
)
const completed = computed(() =>
  items.value.length > 0 && totalScanned.value >= totalRequired.value
)

async function loadOrder() {
  if (!orderInput.value.trim()) return
  loading.value = true
  error.value = ''
  try {
    const data = await warehouseAPI.getOutboundOrder(orderInput.value.trim())
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
    error.value = err.response?.data?.error || '订单不存在或不可出库'
    items.value = []
  } finally {
    loading.value = false
  }
}

async function scanSku() {
  if (!skuInput.value.trim() || !orderNumber.value) return
  const code = skuInput.value.trim()
  // 先在本地 items 找匹配（条码或 SKU）
  const item = items.value.find(
    (i) => i.barcode === code || i.barcode2 === code || i.sku === code
  )
  if (!item) {
    error.value = `❌ 此订单无 ${code}`
    skuInput.value = ''
    skuInputEl.value?.focus()
    return
  }
  if (item.scanned >= item.required) {
    error.value = `⚠️ ${item.sku} 已扫满`
    skuInput.value = ''
    return
  }
  try {
    await warehouseAPI.scanOutbound({
      orderNumber: orderNumber.value,
      sku: item.sku,
      qty: 1,
    })
    item.scanned += 1
    error.value = ''
  } catch (err) {
    error.value = err.response?.data?.error || '扫码失败'
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
  error.value = ''
}

async function forceComplete() {
  if (!orderNumber.value) return
  if (!confirm('确定强制完成出库？未扫的 SKU 视为漏扫。')) return
  loading.value = true
  try {
    await warehouseAPI.forceCompleteOutbound(orderNumber.value)
    alert('已强制完成')
    reset()
  } catch (err) {
    error.value = err.response?.data?.error || '操作失败'
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
      <label class="flex items-center gap-2.5 cursor-pointer">
        <input v-model="printAfterScan" type="checkbox" class="w-4 h-4" />
        <span class="text-sm text-gray-500">扫完后自动打印</span>
      </label>
      <div class="ml-auto flex gap-2.5">
        <button class="g-btn g-btn-teal" @click="reset">重置</button>
        <button
          class="g-btn g-btn-pink"
          :disabled="!orderNumber || loading"
          @click="forceComplete"
        >
          强制出库
        </button>
      </div>
    </div>

    <!-- 错误提示 -->
    <p v-if="error" class="mb-3 text-sm text-red-500">{{ error }}</p>

    <!-- 进度条 -->
    <div v-if="orderNumber" class="mb-4 flex items-center gap-3">
      <span class="text-sm text-gray-500">订单: <span class="font-mono">{{ orderNumber }}</span></span>
      <span class="text-sm font-bold" :class="completed ? 'text-green-600' : 'text-orange-500'">
        {{ totalScanned }} / {{ totalRequired }}
      </span>
    </div>

    <!-- SKU 表 -->
    <div class="g-card overflow-hidden">
      <table class="g-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>中文名</th>
            <th>Barcode</th>
            <th>Barcode2</th>
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
          <tr
            v-for="it in items"
            :key="it.sku"
            :class="it.scanned >= it.required ? 'bg-green-50' : ''"
          >
            <td class="font-mono">{{ it.sku }}</td>
            <td>{{ it.name }}</td>
            <td class="font-mono text-xs text-gray-500">{{ it.barcode }}</td>
            <td class="font-mono text-xs text-gray-500">{{ it.barcode2 }}</td>
            <td class="text-center">{{ it.required }}</td>
            <td class="text-center">
              <span :class="it.scanned >= it.required ? 'text-green-600 font-bold' : 'text-orange-500 font-bold'">
                {{ it.scanned }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
