<script setup>
/**
 * 儀表板 — 出貨作業中心首頁
 *
 * UI 来源：用户提供的 hktvmall_local_app.py（FastAPI + 内嵌 React 单页）
 *   - 这里只 1:1 还原页面设计（Vue + Tailwind），不带爬虫触发那部分
 *   - 数据来源会从原本的爬虫 → 切到 Odoo（接口待定）
 *
 * 数据 schema（保持跟原页面一致，未来 Odoo 端按这个结构出 JSON）：
 *   {
 *     today:    { date, CONFIRMED, ACKNOWLEDGED, PICKED, TOTAL_TARGET, CANCELED },
 *     tomorrow: { 同上 },
 *     last_updated: 'YYYY-MM-DD HH:MM:SS',
 *     status_msg: string
 *   }
 *
 * 当前所有交互函数都是 stub —— 等后端就绪再接：
 *   - fetchOrderData()  → GET /api/warehouse/dashboard/hktv
 *   - submitCancel()    → POST /api/warehouse/dashboard/hktv/cancel { day, qty }
 */
import { ref, computed, onActivated } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showToast } from '@/composables/useToast'

const auth = useAuthStore()
const greeting = computed(() => auth.identity?.name || 'User')

// ============================================================
// 数据状态
// ============================================================
const data = ref(null)              // null = 未取过；{} = 取过但空；{today,...} = 有数据
const isRefreshing = ref(false)
const cancelInputs = ref({ today: '', tomorrow: '' })

// 两个分组卡片用 v-for 渲染，避免 today / tomorrow 模板重复
const SECTIONS = [
  { key: 'today',    title: '今日訂單' },
  { key: 'tomorrow', title: '明日訂單' },
]

// mock 数据（开发期填充；接入后端后此常量可删）
const MOCK_DATA = {
  today: {
    date: '2026-05-04',
    CONFIRMED: '15',
    ACKNOWLEDGED: '0',
    PICKED: '52',
    TOTAL_TARGET: '52',
    CANCELED: '0',
  },
  tomorrow: {
    date: '2026-05-05',
    CONFIRMED: '13',
    ACKNOWLEDGED: '800',
    PICKED: '61',
    TOTAL_TARGET: '861',
    CANCELED: '0',
  },
  last_updated: '2026-05-04 10:52:47',
  status_msg: '⚡ 最新狀態：自動背景更新成功！',
}

// ============================================================
// 数据获取 / 操作 — 全部 stub，后端就绪后切到真接口
// ============================================================
async function fetchOrderData() {
  if (isRefreshing.value) return
  isRefreshing.value = true
  try {
    // TODO: 接 Odoo - GET /api/warehouse/dashboard/hktv
    // const res = await dashboardApi.getHktvOrders()
    // data.value = res
    await new Promise(r => setTimeout(r, 300))   // 模拟网络
    data.value = MOCK_DATA
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '取得資料失敗', 'error')
    }
  } finally {
    isRefreshing.value = false
  }
}

async function submitCancel(dayKey) {
  const qty = parseInt(cancelInputs.value[dayKey] || 0, 10)
  if (qty <= 0) return
  try {
    // TODO: 接 Odoo - POST /api/warehouse/dashboard/hktv/cancel { day, qty }
    // 现在直接本地累加 + 给 toast
    if (data.value && data.value[dayKey]) {
      const current = parseInt(data.value[dayKey].CANCELED || '0', 10)
      data.value[dayKey].CANCELED = String(current + qty)
    }
    cancelInputs.value[dayKey] = ''
    showToast(`✅ 已記錄 ${qty} 筆取消訂單`, 'success')
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '更新失敗', 'error')
    }
  }
}

// 进入页面时拉一次。是否要自动轮询（30s）等接入 Odoo 真接口后再决定 ——
// Odoo 数据是实时的，浏览器轮询只是减少用户手动刷新的次数。先不开轮询。
onActivated(() => {
  fetchOrderData()
})

// ============================================================
// 工具
// ============================================================
function pickedPctOf(day) {
  const total = parseInt(day?.TOTAL_TARGET || '0', 10)
  const picked = parseInt(day?.PICKED || '0', 10)
  if (!total) return 0
  return Math.min(Math.round((picked / total) * 100), 100)
}

function hasDay(day) {
  return day && Object.keys(day).length > 0
}
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-10">
    <!-- 顶部：欢迎 + 标题 + 操作按钮 -->
    <div class="mb-6">
      <h2 class="text-xl sm:text-2xl font-light text-gray-700 mb-1">Hi, {{ greeting }} 👋🏼</h2>
      <p class="text-gray-400 text-xs sm:text-sm mb-5">Welcome back!</p>

      <div class="flex justify-between items-center flex-wrap gap-3">
        <h1 class="text-xl sm:text-2xl lg:text-3xl font-black text-orange-600 m-0">📊 監控儀表板</h1>
        <button
          class="bg-white text-slate-900 border border-slate-300 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl text-xs sm:text-sm font-bold cursor-pointer disabled:opacity-50 flex-shrink-0"
          :disabled="isRefreshing"
          @click="fetchOrderData"
        >
          {{ isRefreshing ? '🔄 載入中…' : '🔄 重新整理' }}
        </button>
      </div>
    </div>

    <!-- 空态：没有数据 -->
    <div
      v-if="!data || !hasDay(data.today)"
      class="text-center py-16 sm:py-20 px-5 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-300 text-slate-500"
    >
      <div class="text-5xl mb-4">🤖</div>
      <h2 class="text-base sm:text-lg font-bold text-slate-900 mb-2">等待數據傳送中…</h2>
      <p class="text-xs sm:text-sm">數據將從 Odoo 後端推送（接入中）</p>
    </div>

    <!-- 数据：今日 + 明日 卡片，用 v-for 避免重复 -->
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

          <!-- 4 张 KPI 卡片 -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5 sm:mb-7">
            <div class="bg-slate-50 p-4 sm:p-5 rounded-2xl text-center border border-slate-200">
              <div class="text-slate-500 text-xs sm:text-sm font-bold mb-2">📝 已建立</div>
              <div class="text-2xl sm:text-3xl text-slate-900 font-black leading-none">{{ data[sec.key].CONFIRMED || '--' }}</div>
            </div>
            <div class="bg-slate-50 p-4 sm:p-5 rounded-2xl text-center border border-slate-200">
              <div class="text-slate-500 text-xs sm:text-sm font-bold mb-2">⏳ 已確認</div>
              <div class="text-2xl sm:text-3xl text-slate-900 font-black leading-none">{{ data[sec.key].ACKNOWLEDGED || '--' }}</div>
            </div>
            <div class="bg-blue-50 p-4 sm:p-5 rounded-2xl text-center border-2 border-blue-200 shadow-sm">
              <div class="text-blue-600 text-xs sm:text-sm font-bold mb-2">📦 已出貨 / 總目標</div>
              <div class="text-2xl sm:text-3xl text-blue-900 font-black leading-none">
                {{ data[sec.key].PICKED || '0' }} / {{ data[sec.key].TOTAL_TARGET || '0' }}
              </div>
            </div>
            <div class="bg-red-50 p-4 sm:p-5 rounded-2xl text-center border border-red-200">
              <div class="text-red-500 text-xs sm:text-sm font-bold mb-2">❌ 已取消</div>
              <div class="text-2xl sm:text-3xl text-red-700 font-black leading-none">{{ data[sec.key].CANCELED || '0' }}</div>
            </div>
          </div>

          <!-- 出货进度条 -->
          <div class="bg-slate-50 p-4 sm:p-5 rounded-2xl border border-slate-200 mb-5">
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

          <!-- 手动记录取消 — 折叠 -->
          <details class="bg-white p-3 sm:p-5 rounded-2xl border border-dashed border-slate-300">
            <summary class="text-sm sm:text-base font-bold text-slate-900 outline-none select-none list-none flex items-center gap-2 cursor-pointer">
              <span>⚙️ 手動紀錄取消訂單</span>
              <span class="text-xs sm:text-[13px] text-blue-500 font-normal">(點擊展開 ▼)</span>
            </summary>
            <div class="mt-4 pt-4 border-t border-slate-100">
              <div class="flex gap-3 flex-wrap">
                <input
                  v-model="cancelInputs[sec.key]"
                  type="number" min="1" step="1" placeholder="請輸入數量…"
                  class="px-4 py-3 rounded-xl border-2 border-slate-300 outline-none w-full sm:w-40 text-base"
                />
                <button
                  class="bg-slate-900 text-white border-0 px-6 py-3 rounded-xl text-sm sm:text-base font-bold cursor-pointer flex-shrink-0 hover:bg-slate-800 transition-colors"
                  @click="submitCancel(sec.key)"
                >📝 記錄取消</button>
              </div>
            </div>
          </details>
        </div>
      </template>

      <!-- 底部状态 -->
      <div class="text-right text-slate-500 text-xs sm:text-sm mt-5 leading-relaxed">
        🕒 最後更新時間：{{ data.last_updated || '--' }}<br/>
        <span v-if="data.status_msg">{{ data.status_msg }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 干掉 details > summary 的默认三角箭头（Safari/Firefox） */
details > summary::-webkit-details-marker { display: none; }
details > summary { list-style: none; }
</style>
