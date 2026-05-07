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
import { ref, reactive, computed, onActivated } from 'vue'
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
const PAGE_SIZE = 40
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

// ============================================================
// 下載面單 — 列表行末「下載/生成面單」按钮
// ============================================================
// 两种状态视觉区分：
//   - o.printed=true  → 蓝色「下載面單」（直接拉已生成的 PDF）
//   - o.printed=false → 琥珀「生成面單」（后端调 HKTV API 现生成，慢 1-3 秒）
// 用 Set 跟踪正在下载的 item id，避免用户连点重复请求。
const downloadingIds = ref(new Set())

async function downloadLabel(o) {
  if (downloadingIds.value.has(o.id)) return
  // Set 改动要用 new Set 触发响应式
  downloadingIds.value = new Set([...downloadingIds.value, o.id])
  try {
    const filename = o.waybill ? `waybill_${o.waybill}.pdf` : `waybill_${o.id}.pdf`
    await ordersApi.downloadWaybillLabel(o.id, filename)
    // 之前未生成的 → 现在后端已经写了 attachment，更新 row 状态让按钮变蓝
    if (!o.printed) {
      o.printed = true
      showToast('面單已生成並下載', 'success')
    }
  } catch (err) {
    if (!err.handledByInterceptor) {
      const detail = err.response?.data?.detail
        || err.response?.data?.error
        || '下載面單失敗'
      showToast(detail, 'error')
    }
  } finally {
    const next = new Set(downloadingIds.value)
    next.delete(o.id)
    downloadingIds.value = next
  }
}

// ============================================================
// 拆單模态 — 列表行末「拆單」按钮入口
// ============================================================
// 业务复用 Odoo 后端 hktv.split.waybill.wizard：HKTV splitWaybills API +
// 建新 hktv.order.item + 改 picking + 写日志。前端只做 UI + 校验。
const splitModalOpen = ref(false)
const splitTarget = ref(null)        // 当前选中的运单 row（用作 header 显示）
const splitItems = ref([])           // 当前运单的商品明细 + split_qty 输入
const splitLoading = ref(false)      // GET items 中
const splitSubmitting = ref(false)   // POST split 中（HKTV API 同步调，可能数秒）
const splitError = ref('')           // 加载或校验错误，整块红字显示

// 已分拆 / 剩餘 — 实时 reactive 计算
const splitTotalAll = computed(() =>
  splitItems.value.reduce((s, i) => s + (Number(i.qty) || 0), 0),
)
const splitTotalOut = computed(() =>
  splitItems.value.reduce((s, i) => s + (Number(i.split_qty) || 0), 0),
)
const splitTotalRemain = computed(() => splitTotalAll.value - splitTotalOut.value)

// 提交按钮启用条件 — 至少分拆 1 件、不能全部拆完（HKTV 规则要求原单留至少 1 件）、
// 每行 split_qty 在 [0, qty] 范围内
const canSubmitSplit = computed(() => {
  if (splitLoading.value || splitSubmitting.value) return false
  if (splitItems.value.length === 0) return false
  if (splitTotalOut.value <= 0) return false
  if (splitTotalRemain.value <= 0) return false
  return splitItems.value.every((i) => {
    const v = Number(i.split_qty)
    return Number.isFinite(v) && v >= 0 && v <= Number(i.qty)
  })
})

async function openSplit(o) {
  splitTarget.value = o
  splitModalOpen.value = true
  splitItems.value = []
  splitError.value = ''
  splitLoading.value = true
  try {
    const res = await ordersApi.getOrderItems(o.id)
    splitItems.value = (res.lines || []).map((l) => reactive({
      ...l,
      split_qty: 0,
    }))
    if (splitItems.value.length === 0) {
      splitError.value = '此運單沒有商品明細，無法分拆'
    }
  } catch (err) {
    if (!err.handledByInterceptor) {
      splitError.value = err.response?.data?.error === 'order_not_found'
        ? '找不到此運單'
        : (err.response?.data?.detail || err.response?.data?.error || '載入商品明細失敗')
    }
  } finally {
    splitLoading.value = false
  }
}

function closeSplit() {
  if (splitSubmitting.value) return  // 提交中不让关
  splitModalOpen.value = false
  splitTarget.value = null
  splitItems.value = []
  splitError.value = ''
}

async function confirmSplit() {
  if (!canSubmitSplit.value) return
  splitSubmitting.value = true
  try {
    const splits = splitItems.value
      .filter((i) => Number(i.split_qty) > 0)
      .map((i) => ({ line_id: i.line_id, split_qty: Number(i.split_qty) }))
    const res = await ordersApi.splitOrder(splitTarget.value.id, splits)
    showToast(`拆單成功！新運單號：${res.new_waybill || '—'}`, 'success')
    splitModalOpen.value = false
    splitTarget.value = null
    splitItems.value = []
    splitError.value = ''
    load()  // 刷新列表显示新拆出来的行
  } catch (err) {
    if (!err.handledByInterceptor) {
      const detail = err.response?.data?.detail
        || err.response?.data?.error
        || '拆單失敗'
      showToast(detail, 'error')
    }
  } finally {
    splitSubmitting.value = false
  }
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <!-- 顶部筛选行：手机日期 + 关键字纵向，按钮整行；md+ 横向 -->
    <div class="space-y-3 md:space-y-0 md:flex md:items-center md:gap-3 md:flex-wrap mb-3 md:mb-4">
      <!-- 日期范围 -->
      <div class="flex items-center gap-2 md:gap-3 flex-wrap">
        <span class="text-sm text-gray-500 flex-shrink-0">提貨日期</span>
        <input v-model="dateFrom" type="date" class="g-input flex-1 md:flex-none" style="width:auto;min-width:140px;max-width:180px;height:40px;" />
        <span class="text-gray-400">~</span>
        <input v-model="dateTo" type="date" class="g-input flex-1 md:flex-none" style="width:auto;min-width:140px;max-width:180px;height:40px;" />
      </div>
      <!-- 关键字 + 搜索 -->
      <div class="flex items-center gap-2 md:gap-3">
        <input
          v-model="orderQuery"
          class="g-input flex-1 md:flex-none"
          style="width:100%;min-width:0;max-width:220px;height:40px;"
          placeholder="運單號 / 訂單號"
          autocomplete="off"
          @keyup.enter="search"
        />
        <button class="g-btn g-btn-teal flex-shrink-0" style="padding:8px 24px;height:40px;"
                :disabled="loading" @click="search">
          {{ loading ? '查詢中…' : '搜尋' }}
        </button>
      </div>
    </div>

    <!-- chip：运单状态 -->
    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <span class="text-xs sm:text-sm text-gray-500 mr-1 w-full sm:w-16 sm:inline-block">運單狀態</span>
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

    <!-- chip：出库状态 -->
    <div class="flex items-center gap-2 mb-5 sm:mb-6 flex-wrap">
      <span class="text-xs sm:text-sm text-gray-500 mr-1 w-full sm:w-16 sm:inline-block">出庫狀態</span>
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

    <!-- 桌面：表格视图 -->
    <div class="hidden md:block g-card overflow-hidden">
      <table class="g-table">
        <thead>
          <tr>
            <th>運單號</th>
            <th>訂單號</th>
            <th>運單狀態</th>
            <th class="hidden lg:table-cell">訂單日期</th>
            <th>提貨日期</th>
            <th>出庫</th>
            <th>面單</th>
            <th class="text-center">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loading && rows.length === 0">
            <td :colspan="8" class="text-center text-gray-400 py-10">沒有符合條件的運單</td>
          </tr>
          <tr v-for="o in rows" :key="o.id">
            <td class="font-semibold">{{ o.waybill || '—' }}</td>
            <td class="font-mono text-[11px]">{{ o.order_no }}</td>
            <td>
              <span v-if="o.status" class="g-badge" style="background:#f0f9ff;color:#0369a1;">
                {{ o.status }}
              </span>
            </td>
            <td class="hidden lg:table-cell text-xs text-gray-600">{{ o.order_date }}</td>
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
            <td class="text-center">
              <div class="inline-flex items-center gap-1.5">
                <!-- 下載 / 生成面單 — 两种状态视觉区分 -->
                <button class="g-row-btn"
                        :class="o.printed ? 'g-row-btn-blue' : 'g-row-btn-amber'"
                        :disabled="downloadingIds.has(o.id)"
                        :title="o.printed ? '下載已生成的面單 PDF' : '調 HKTV API 生成並下載面單'"
                        @click="downloadLabel(o)">
                  <span v-if="downloadingIds.has(o.id)"
                        class="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
                  <span v-else class="text-[10px]">{{ o.printed ? '📥' : '⚡' }}</span>
                  <span>{{ downloadingIds.has(o.id)
                            ? '處理中…'
                            : (o.printed ? '下載面單' : '生成面單') }}</span>
                </button>
                <!-- 拆單 -->
                <button class="g-row-btn g-row-btn-teal" @click="openSplit(o)">
                  <span class="text-[10px]">✂</span>
                  <span>拆單</span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 手机：卡片视图 -->
    <div class="md:hidden">
      <div v-if="!loading && rows.length === 0" class="g-card p-10 text-center text-gray-400 text-sm">
        沒有符合條件的運單
      </div>
      <div v-else class="space-y-2">
        <div v-for="o in rows" :key="o.id" class="g-card p-3">
          <!-- 第一行：运单号 + 运单状态徽章 -->
          <div class="flex items-start justify-between gap-2 mb-1.5">
            <div class="font-semibold text-sm text-gray-800 flex-1 min-w-0 truncate">
              {{ o.waybill || '—' }}
            </div>
            <span v-if="o.status" class="g-badge flex-shrink-0" style="background:#f0f9ff;color:#0369a1;">
              {{ o.status }}
            </span>
          </div>
          <!-- 订单号 -->
          <div class="font-mono text-[11px] text-gray-500 mb-2 break-all">{{ o.order_no }}</div>
          <!-- 日期网格 -->
          <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600 mb-2">
            <div><span class="text-gray-400">訂單日期：</span>{{ o.order_date || '—' }}</div>
            <div><span class="text-gray-400">提貨日期：</span>{{ o.pickup_date || '—' }}</div>
          </div>
          <!-- 状态徽章组 -->
          <div class="flex items-center gap-1.5 flex-wrap mb-2">
            <span class="text-[11px] text-gray-400">出庫</span>
            <span v-if="o.outbound_stage" class="g-badge" :style="outboundStyle(o.outbound_stage)">
              {{ o.outbound_label }}
            </span>
            <span v-else class="g-badge" style="background:#f3f4f6;color:#9ca3af;">—</span>
            <span class="text-[11px] text-gray-400 ml-2">面單</span>
            <span v-if="o.printed" class="g-badge" style="background:#ecfdf5;color:#047857;">已列印</span>
            <span v-else class="g-badge" style="background:#f3f4f6;color:#9ca3af;">未列印</span>
          </div>
          <!-- 操作按钮组 -->
          <div class="flex items-center gap-2 flex-wrap">
            <button class="g-row-btn flex-shrink-0"
                    :class="o.printed ? 'g-row-btn-blue' : 'g-row-btn-amber'"
                    :disabled="downloadingIds.has(o.id)"
                    @click="downloadLabel(o)">
              <span v-if="downloadingIds.has(o.id)"
                    class="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
              <span v-else class="text-[10px]">{{ o.printed ? '📥' : '⚡' }}</span>
              <span>{{ downloadingIds.has(o.id)
                        ? '處理中…'
                        : (o.printed ? '下載面單' : '生成面單') }}</span>
            </button>
            <button class="g-row-btn g-row-btn-teal flex-shrink-0" @click="openSplit(o)">
              <span class="text-[10px]">✂</span>
              <span>拆單</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 分页栏：第 X / Y 頁 · 共 Z 條 [上一頁] [下一頁] -->
    <!-- 手机：信息和按钮上下两行；md+ 同行 -->
    <div v-if="total > 0" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-5 sm:mt-6 text-sm">
      <div class="text-gray-500 text-center sm:text-left">
        第 <span class="text-gray-700 font-medium">{{ currentPage }}</span>
        / <span class="text-gray-700 font-medium">{{ totalPages }}</span> 頁
        <span class="mx-2 text-gray-300">·</span>
        共 <span class="text-gray-700 font-medium">{{ total }}</span> 條
      </div>
      <div class="flex items-center justify-center gap-2">
        <button
          class="flex-1 sm:flex-none px-4 py-2 rounded border border-gray-200 text-gray-600 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!hasPrev || loading"
          @click="goToPage(currentPage - 1)"
        >上一頁</button>
        <button
          class="flex-1 sm:flex-none px-4 py-2 rounded border border-gray-200 text-gray-600 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!hasNext || loading"
          @click="goToPage(currentPage + 1)"
        >下一頁</button>
      </div>
    </div>

    <!-- ========================================================== -->
    <!-- 拆單模态对话框                                              -->
    <!-- 复用 Odoo 后端 hktv.split.waybill.wizard 业务逻辑          -->
    <!-- 视觉参考 HKTV Merchant 后台拆單弹窗，但去掉图片列、加内部   -->
    <!-- SKU / 品牌列让信息更密集                                    -->
    <!-- ========================================================== -->
    <div
      v-if="splitModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      style="background:rgba(15,23,42,0.55);"
      @click.self="closeSplit"
    >
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] overflow-hidden flex flex-col">
        <!-- 头 -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <div class="text-lg font-bold text-gray-800">分拆運單</div>
            <div class="text-xs text-gray-500 mt-1.5">
              運單編號:
              <span class="font-mono font-semibold text-gray-700">{{ splitTarget?.waybill || '—' }}</span>
              <span class="mx-2 text-gray-300">·</span>
              訂單編號:
              <span class="font-mono text-gray-600">{{ splitTarget?.order_no || '—' }}</span>
            </div>
          </div>
          <button
            class="text-gray-400 hover:text-gray-600 text-2xl leading-none px-2 disabled:opacity-30"
            :disabled="splitSubmitting"
            @click="closeSplit"
          >&times;</button>
        </div>

        <!-- 提示信息（HKTV 拆單规则）-->
        <div class="mx-6 mt-4 p-3.5 rounded-lg text-xs leading-relaxed text-amber-900"
             style="background:#fffbeb;border:1px solid #fde68a;">
          請在需要分拆出來的商品欄輸入分拆的數量，然後按「確定」，系統會生成一張新的運單並具獨立的運單編號。
          <span class="font-bold">請注意一旦分拆了新的運單，將無法復原。</span>
        </div>

        <!-- 主体 -->
        <div class="px-6 py-4 overflow-y-auto flex-1">
          <!-- loading -->
          <div v-if="splitLoading" class="text-center text-gray-400 py-16 text-sm">
            <span class="inline-block w-4 h-4 border-2 border-gray-300 border-t-teal rounded-full animate-spin mr-2 align-middle"></span>
            載入商品明細…
          </div>

          <!-- 错误 -->
          <div v-else-if="splitError"
               class="text-center text-rose-600 py-12 text-sm"
               style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">
            {{ splitError }}
          </div>

          <!-- 表格 -->
          <template v-else>
            <table class="g-table">
              <thead>
                <tr>
                  <th style="width:180px;">SKU</th>
                  <th>商品名稱</th>
                  <th style="width:120px;text-align:right;">原本數量</th>
                  <th style="width:180px;text-align:right;">分拆數量</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in splitItems" :key="item.line_id">
                  <td class="font-mono text-xs font-semibold text-gray-700">
                    {{ item.sku || '—' }}
                  </td>
                  <td>
                    <div class="text-sm text-gray-800 leading-snug">
                      {{ item.product_name || '—' }}
                    </div>
                    <div v-if="item.brand" class="text-[11px] text-gray-400 mt-0.5">
                      {{ item.brand }}
                    </div>
                  </td>
                  <td class="text-right">
                    <span class="font-bold text-gray-700">{{ item.qty }}</span>
                  </td>
                  <td class="text-right">
                    <input
                      v-model.number="item.split_qty"
                      type="number"
                      min="0"
                      :max="item.qty"
                      :disabled="splitSubmitting"
                      class="g-input"
                      style="width:140px;text-align:right;padding:7px 12px;height:38px;font-size:13px;font-weight:600;"
                    />
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- 实时统计 -->
            <div class="mt-4 flex items-center justify-end gap-4 text-xs">
              <div class="text-gray-500">
                已分拆:
                <span class="font-bold text-teal-700 ml-1"
                      :style="splitTotalOut > 0 ? 'color:#0f766e;' : 'color:#9ca3af;'">
                  {{ splitTotalOut }}
                </span>
                件
              </div>
              <div class="text-gray-300">|</div>
              <div class="text-gray-500">
                原運單剩餘:
                <span class="font-bold ml-1"
                      :style="splitTotalRemain > 0 ? 'color:#374151;' : 'color:#dc2626;'">
                  {{ splitTotalRemain }}
                </span>
                件
              </div>
              <div v-if="splitTotalRemain <= 0 && splitTotalOut > 0"
                   class="text-rose-600 font-semibold">
                ⚠ 必須保留至少 1 件在原運單
              </div>
            </div>
          </template>
        </div>

        <!-- 底部按钮 -->
        <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button
            class="g-btn"
            style="background:#f3f4f6;color:#4b5563;padding:10px 28px;"
            :disabled="splitSubmitting"
            @click="closeSplit"
          >取 消</button>
          <button
            class="g-btn g-btn-teal"
            style="padding:10px 28px;"
            :disabled="!canSubmitSplit"
            @click="confirmSplit"
          >
            <span v-if="splitSubmitting" class="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin mr-1.5 align-middle"></span>
            {{ splitSubmitting ? '處理中…' : '確 定' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
