<script setup>
/**
 * 儀表板 — 出貨作業中心首頁
 *
 * 数据 schema（后端 le_warehouse.controllers.dashboard）：
 *   {
 *     today:    { date, CREATED, CONFIRMED, SHIPPED, TOTAL_TARGET },
 *     tomorrow: { 同上 },
 *     last_updated: 'YYYY-MM-DD HH:MM:SS' (HKT)
 *   }
 *
 * KPI 含义（跟后端定义对齐）：
 *   📝 已建立    CREATED       — 非3PL + 当日 pickup_date + 已有运单 PDF + 还没生成面单
 *   ⏳ 已確認    CONFIRMED     — 当日 le.shipping.label 的 waybill_count 之和
 *   📦 已出貨/總目標
 *      SHIPPED               — 非3PL + 当日 pickup_date + fulfillment_stage='pack'
 *      TOTAL_TARGET           — 非3PL + 当日 pickup_date + 已有运单 PDF（已建立 + 已确认）
 *      进度条 = SHIPPED / TOTAL_TARGET
 *
 * 自动刷新：默认开 60s 轮询，可关。跟 Shipping 页同款滑动开关 + 脉冲点。
 *   关闭后停掉定时器，节省 RPS；用户点「🔄 重新整理」也能手动刷。
 *
 * KeepAlive：onActivated 启动定时器；onDeactivated 清掉防止后台空跑。
 */
import { ref, computed, onActivated, onDeactivated, watch } from 'vue'
import { dashboard as dashboardApi } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { showToast } from '@/composables/useToast'

const auth = useAuthStore()
const greeting = computed(() => auth.identity?.name || 'User')

// ============================================================
// 数据状态
// ============================================================
const data = ref(null)              // null = 未取过；{today, tomorrow, last_updated}
const isRefreshing = ref(false)

// 两个分组卡片用 v-for 渲染
const SECTIONS = [
  { key: 'today',    title: '今日訂單' },
  { key: 'tomorrow', title: '明日訂單' },
]

// ============================================================
// 自动刷新（默认开，60s 一次；跟 Shipping 页同款滑动开关）
// ============================================================
const autoRefresh = ref(true)
const POLL_INTERVAL_MS = 60_000   // 60 秒
let pollTimer = null

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(fetchOrderData, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

watch(autoRefresh, (val) => {
  if (val) startPolling()
  else stopPolling()
})

// ============================================================
// 数据获取
// ============================================================
async function fetchOrderData() {
  if (isRefreshing.value) return  // 防双触发
  isRefreshing.value = true
  try {
    data.value = await dashboardApi.getStats()
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '取得資料失敗', 'error')
    }
  } finally {
    isRefreshing.value = false
  }
}

// ============================================================
// 进入 / 离开页面
// ============================================================
onActivated(() => {
  fetchOrderData()
  if (autoRefresh.value) startPolling()
})

onDeactivated(() => {
  stopPolling()
})

// ============================================================
// 工具
// ============================================================
function pickedPctOf(day) {
  const total = parseInt(day?.TOTAL_TARGET || '0', 10)
  const picked = parseInt(day?.SHIPPED || '0', 10)
  if (!total) return 0
  return Math.min(Math.round((picked / total) * 100), 100)
}

function hasDay(day) {
  return day && Object.keys(day).length > 0
}
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-10">
    <!-- 顶部：欢迎 + 标题 + 自动刷新开关 + 手动刷新 -->
    <div class="mb-6">
      <h2 class="text-xl sm:text-2xl font-light text-gray-700 mb-1">Hi, {{ greeting }} 👋🏼</h2>
      <p class="text-gray-400 text-xs sm:text-sm mb-5">Welcome back!</p>

      <div class="flex justify-between items-center flex-wrap gap-3">
        <h1 class="text-xl sm:text-2xl lg:text-3xl font-black text-orange-600 m-0">📊 監控儀表板</h1>
        <div class="flex items-center gap-3 flex-wrap">
          <!-- 自动刷新滑动开关（跟 Shipping 同款） -->
          <div class="g-toggle-wrap">
            <span class="text-xs sm:text-sm text-gray-500 select-none flex items-center gap-1.5">
              <span
                class="w-2 h-2 rounded-full transition-colors"
                :class="autoRefresh ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'"
              ></span>
              <span>{{ autoRefresh ? '自動刷新（每 60s）' : '已暫停刷新' }}</span>
            </span>
            <button
              class="g-toggle"
              :class="{ on: autoRefresh }"
              :aria-label="autoRefresh ? '關閉自動刷新' : '開啟自動刷新'"
              :title="autoRefresh
                ? '每 60 秒自動拉取最新數據'
                : '已停止輪詢；點開重新啟用'"
              @click="autoRefresh = !autoRefresh"
            ></button>
          </div>
        </div>
      </div>
    </div>

    <!-- 空态：没有数据 -->
    <div
      v-if="!data || !hasDay(data.today)"
      class="text-center py-16 sm:py-20 px-5 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-300 text-slate-500"
    >
      <div class="text-5xl mb-4">🤖</div>
      <h2 class="text-base sm:text-lg font-bold text-slate-900 mb-2">
        {{ isRefreshing ? '正在載入…' : '暫無數據' }}
      </h2>
      <p class="text-xs sm:text-sm">數據從 Odoo hktv.order.item / le.shipping.label 即時計算</p>
    </div>

    <!-- 数据：今日 + 明日 卡片 -->
    <div v-else>
      <template v-for="sec in SECTIONS" :key="sec.key">
        <div
          v-if="hasDay(data[sec.key])"
          class="bg-white p-5 sm:p-7 rounded-3xl border border-slate-200 shadow-sm mb-6 sm:mb-7"
        >
          <!-- 标题 + 日期 -->
          <h3 class="text-slate-900 border-b-2 border-slate-100 pb-3 mb-5 text-lg sm:text-xl font-bold flex items-center gap-2 flex-wrap">
            <span>{{ sec.title }}</span>
            <span class="text-sm text-slate-500 font-normal">📅 {{ data[sec.key].date || '--' }}</span>
          </h3>

          <!-- 3 张 KPI 卡片 -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-5 sm:mb-7">
            <!-- 已建立：还没归到面单批次的运单 -->
            <div class="bg-slate-50 p-4 sm:p-5 rounded-2xl text-center border border-slate-200"
                 title="非 3PL + 當日出庫 + 已有運單 PDF + 還沒生成面單">
              <div class="text-slate-500 text-xs sm:text-sm font-bold mb-2">📝 已建立</div>
              <div class="text-2xl sm:text-3xl text-slate-900 font-black leading-none">
                {{ data[sec.key].CREATED ?? '--' }}
              </div>
            </div>
            <!-- 已确认：当日面单的运单数总和 -->
            <div class="bg-slate-50 p-4 sm:p-5 rounded-2xl text-center border border-slate-200"
                 title="當日 le.shipping.label 的 waybill_count 之和">
              <div class="text-slate-500 text-xs sm:text-sm font-bold mb-2">⏳ 已確認</div>
              <div class="text-2xl sm:text-3xl text-slate-900 font-black leading-none">
                {{ data[sec.key].CONFIRMED ?? '--' }}
              </div>
            </div>
            <!-- 已出货 / 总目标：扫码 pack 的 / 当天所有运单 -->
            <div class="bg-blue-50 p-4 sm:p-5 rounded-2xl text-center border-2 border-blue-200 shadow-sm"
                 title="已掃碼出貨 (fulfillment_stage='pack') / 當日總運單數">
              <div class="text-blue-600 text-xs sm:text-sm font-bold mb-2">📦 已出貨 / 總目標</div>
              <div class="text-2xl sm:text-3xl text-blue-900 font-black leading-none">
                {{ data[sec.key].SHIPPED ?? '0' }} / {{ data[sec.key].TOTAL_TARGET ?? '0' }}
              </div>
            </div>
          </div>

          <!-- 出货进度条 -->
          <div class="bg-slate-50 p-4 sm:p-5 rounded-2xl border border-slate-200">
            <div class="flex justify-between text-sm sm:text-base font-bold text-slate-700 mb-3">
              <span>📦 出貨進度</span>
              <span :class="pickedPctOf(data[sec.key]) === 100 ? 'text-emerald-500' : 'text-slate-700'">
                {{ pickedPctOf(data[sec.key]) }}%
              </span>
            </div>
            <div class="w-full bg-slate-300 rounded-full h-3 sm:h-4 overflow-hidden">
              <div
                class="bg-emerald-500 h-full rounded-full transition-[width] duration-700"
                :style="{ width: pickedPctOf(data[sec.key]) + '%' }"
              ></div>
            </div>
          </div>
        </div>
      </template>

      <!-- 底部状态 -->
      <div class="text-right text-slate-500 text-xs sm:text-sm mt-5 leading-relaxed">
        🕒 最後更新時間：{{ data.last_updated || '--' }}
      </div>
    </div>
  </div>
</template>
