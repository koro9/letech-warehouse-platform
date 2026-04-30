<script setup>
/**
 * 运单 — Dashboard 系统下「運單」页
 *
 * 数据来源：hktv.order.item（HKTV consignment）
 *   一条 = 一个包裹 = 一张运单 = 1:1 关联一张 stock.picking
 *
 * 为什么不查 stock.picking：picking 上没有 HKTV 订单号 / ACKNOWLEDGED 等业务状态
 * 为什么不查 sale.order：拆单会 1:N，丢失单包裹粒度
 *
 * 筛选：
 *   - 日期范围 → 提货日期 (pickup_date)
 *   - 关键字   → 运单号 (tracking_id) 或 订单号 (sale.order.hktv_sub_order_number)
 *   - 运单状态 → 多选，后端 hktv_raw_status in [...]
 *   - 出库状态 → 多选，后端 fulfillment_stage in [...]
 *
 * chip 改选不会自动发请求 —— 必须按"搜尋"按钮，避免快速切 chip 时连发请求。
 * 进页面 / 切回页面 (onActivated) 会把日期重置为今天 + 状态筛选清空 + 重拉。
 *
 * 分页：Odoo 标准 search_count + search 两步法。
 *   前端用 page / page_size，每次切页或筛选都重新拉一次（替换不追加）；
 *   按"搜尋" → currentPage 重置为 1；翻页 → goToPage(p) 直接 load。
 */
import { ref, computed, onActivated } from 'vue'
import { orders as ordersApi } from '@/api'
import { showToast } from '@/composables/useToast'

// 注意：KeepAlive 缓存了 setup 实例，模块顶部的常量只算一次。
// "今天"必须每次激活时重算，否则跨日仍显示旧的日期。
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

const dateFrom = ref(todayStr())
const dateTo   = ref(todayStr())
const orderQuery = ref('')

// 运单状态多选，空数组 = 不筛选；字面值跟后端 hktv_raw_status 对齐
const STATUS_OPTIONS = ['ACKNOWLEDGED', 'SHIPPED', 'DELIVERED', 'CANCELLED']
const selectedStatuses = ref([])

// 出库状态多选，字面值跟后端 hktv.order.item.fulfillment_stage 对齐；
// label 用繁体（前端 UI 一律繁体规则）
const OUTBOUND_STAGE_OPTIONS = [
  { value: 'waiting', label: '待處理' },
  { value: 'pick',    label: '揀貨' },
  { value: 'pack',    label: '包裝' },
  { value: 'ship',    label: '已出庫' },
]
const selectedStages = ref([])

// 数据状态
const rows = ref([])
const loading = ref(false)

// 分页状态
const PAGE_SIZE = 50
const currentPage = ref(1)
const total = ref(0)
const totalPages = ref(0)

const hasPrev = computed(() => currentPage.value > 1)
const hasNext = computed(() => currentPage.value < totalPages.value)

// chip 多选通用 toggle —— 同一个函数支持运单状态 / 出库状态两组
function toggleInList(list, value) {
  const idx = list.value.indexOf(value)
  if (idx >= 0) list.value.splice(idx, 1)
  else list.value.push(value)
}

// 出库阶段徽章配色 — hktv.order.item.fulfillment_stage
//   waiting → 灰色（未开始）
//   pick    → 橙色（拣货中）
//   pack    → 蓝色（包装中）
//   ship    → 绿色（已出库）
function outboundStyle(stage) {
  switch (stage) {
    case 'ship':    return 'background:#ecfdf5;color:#047857;'
    case 'pack':    return 'background:#eff6ff;color:#1d4ed8;'
    case 'pick':    return 'background:#fff7ed;color:#c2410c;'
    case 'waiting': return 'background:#f3f4f6;color:#4b5563;'
    default:        return 'background:#f3f4f6;color:#9ca3af;'
  }
}

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    const res = await ordersApi.listOrders({
      date_from:      dateFrom.value,
      date_to:        dateTo.value,
      q:              orderQuery.value.trim(),
      status:         selectedStatuses.value.join(','),
      outbound_stage: selectedStages.value.join(','),
      page:           currentPage.value,
      page_size:      PAGE_SIZE,
    })
    rows.value = res.orders || []
    total.value = res.total || 0
    totalPages.value = res.total_pages || 0
    // 后端返回的 page 可能因 clamp 跟前端不一致，以后端为准
    if (res.page) currentPage.value = res.page
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '查詢失敗', 'error')
    }
    rows.value = []
    total.value = 0
    totalPages.value = 0
  } finally {
    loading.value = false
  }
}

// 切筛选条件 → 重置到第 1 页再查
function search() {
  currentPage.value = 1
  load()
}

function goToPage(p) {
  if (p < 1 || p > totalPages.value || p === currentPage.value) return
  currentPage.value = p
  load()
}

// onActivated 在带 KeepAlive 的组件里会同时覆盖"首次 mount"和"切回来"两个时机，
// 所以一个钩子搞定 —— 进页面就把日期重置为今天 + 第 1 页 + load。
// 不用单独写 onMounted，避免重复请求。
onActivated(() => {
  dateFrom.value = todayStr()
  dateTo.value = todayStr()
  selectedStatuses.value = []
  selectedStages.value = []
  currentPage.value = 1
  load()
})
</script>

<template>
  <div class="p-10">
    <div class="flex items-center gap-3 mb-4 flex-wrap">
      <span class="text-sm text-gray-500">提貨日期</span>
      <input v-model="dateFrom" type="date" class="g-input" style="width:160px;height:40px;" />
      <span class="text-gray-400">~</span>
      <input v-model="dateTo" type="date" class="g-input" style="width:160px;height:40px;" />
      <input v-model="orderQuery" class="g-input" style="width:220px;height:40px;"
             placeholder="運單號 / 訂單號" @keyup.enter="search" />
      <button class="g-btn g-btn-teal" style="padding:8px 24px;height:40px;"
              :disabled="loading" @click="search">
        {{ loading ? '查詢中…' : '搜尋' }}
      </button>
    </div>

    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <span class="text-sm text-gray-500 mr-1 w-16 inline-block">運單狀態</span>
      <button
        v-for="opt in STATUS_OPTIONS" :key="opt"
        type="button"
        class="px-3 py-1.5 text-xs rounded border transition-colors"
        :class="selectedStatuses.includes(opt)
          ? 'bg-teal-500 border-teal-500 text-white'
          : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'"
        @click="toggleInList(selectedStatuses, opt)"
      >{{ opt }}</button>
      <button
        v-if="selectedStatuses.length"
        type="button"
        class="text-xs text-gray-400 hover:text-gray-600 ml-1 underline"
        @click="selectedStatuses = []"
      >清除</button>
    </div>

    <div class="flex items-center gap-2 mb-6 flex-wrap">
      <span class="text-sm text-gray-500 mr-1 w-16 inline-block">出庫狀態</span>
      <button
        v-for="opt in OUTBOUND_STAGE_OPTIONS" :key="opt.value"
        type="button"
        class="px-3 py-1.5 text-xs rounded border transition-colors"
        :class="selectedStages.includes(opt.value)
          ? 'bg-teal-500 border-teal-500 text-white'
          : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'"
        @click="toggleInList(selectedStages, opt.value)"
      >{{ opt.label }}</button>
      <button
        v-if="selectedStages.length"
        type="button"
        class="text-xs text-gray-400 hover:text-gray-600 ml-1 underline"
        @click="selectedStages = []"
      >清除</button>
    </div>

    <div class="g-card overflow-hidden">
      <table class="g-table">
        <thead>
          <tr>
            <th>運單號</th>
            <th>訂單號</th>
            <th>運單狀態</th>
            <th>訂單日期</th>
            <th>提貨日期</th>
            <th>出庫</th>
            <th>面單</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loading && rows.length === 0">
            <td colspan="7" class="text-center text-gray-400 py-10">沒有符合條件的運單</td>
          </tr>
          <tr v-for="o in rows" :key="o.id">
            <td class="font-semibold">{{ o.waybill || '—' }}</td>
            <td class="font-mono text-[11px]">{{ o.order_no }}</td>
            <td>
              <span v-if="o.status" class="g-badge" style="background:#f0f9ff;color:#0369a1;">
                {{ o.status }}
              </span>
            </td>
            <td class="text-xs text-gray-600">{{ o.order_date }}</td>
            <td class="text-xs text-gray-600">{{ o.pickup_date }}</td>
            <td>
              <span v-if="o.outbound_stage" class="g-badge" :style="outboundStyle(o.outbound_stage)">
                {{ o.outbound_label }}
              </span>
              <span v-else class="text-gray-300">—</span>
            </td>
            <td>
              <span v-if="o.printed" class="g-badge" style="background:#ecfdf5;color:#047857;">已列印</span>
              <span v-else class="text-gray-300">未列印</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页栏：第 X / Y 頁 · 共 Z 條 [上一頁] [下一頁] -->
    <div v-if="total > 0" class="flex items-center justify-between mt-6 text-sm">
      <div class="text-gray-500">
        第 <span class="text-gray-700 font-medium">{{ currentPage }}</span>
        / <span class="text-gray-700 font-medium">{{ totalPages }}</span> 頁
        <span class="mx-2 text-gray-300">·</span>
        共 <span class="text-gray-700 font-medium">{{ total }}</span> 條
      </div>
      <div class="flex items-center gap-2">
        <button
          class="px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!hasPrev || loading"
          @click="goToPage(currentPage - 1)"
        >上一頁</button>
        <button
          class="px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!hasNext || loading"
          @click="goToPage(currentPage + 1)"
        >下一頁</button>
      </div>
    </div>
  </div>
</template>
