<script setup>
/**
 * 面单 — 出货作业中心 / Dashboard 系统
 *
 * 业务：仓库人员每天出库前先打面单贴包裹。一份面单 PDF 聚合了 N 张运单的面单。
 *      没打面单根本不知道要出哪些货 —— 这是出库链条最起点。
 *
 * 页面三块：
 *   1. 今日板块（按 outbound_date == TODAY）— 全量，无分页；按钮触发生成
 *   2. 明日板块（按 outbound_date == TOMORROW）— 全量，无分页；按钮触发生成
 *   3. 历史所有数据（含今天明天）— 分页加载，跟运单页同款 [上一頁][下一頁]
 *      → download_count === 0 && waybill_count > 0 时整行红色高亮
 *      （占位 label waybill_count=0 不参与红行）
 *
 * 数据来源：le.shipping.label（letech/le_warehouse/models/shipping_label.py）
 * 下载逻辑：调 /api/warehouse/shipping/labels/<id>/download → 同事务后端 +1
 *           浏览器收到 PDF 流自动触发另存
 *
 * 生成按钮（决策 1 = C）：
 *   保留板块按钮文案"今日"/"明日"，加 ⚡ 图标暗示这是个动作。
 *   点击调 POST /labels/generate，触发 le.shipping.label.action_generate_for_date()
 *   找该日期未绑定 hktv.order.item 合并 PDF → 创建新 label。
 *
 * 占位 label（决策 2 = A）：
 *   action_generate_for_date 没新数据时会创建 waybill_count=0 的占位记录。
 *   前端列表正常显示，下载按钮 disabled，文案显示"📭 暫無資料"。
 *
 * 并发锁（决策 4）：
 *   2.5s 轮询 GET /labels/generate-status — 任何用户开始生成，所有 WMS tab
 *   都看到按钮 disabled 写"生成中…（xxx）"。生成结束自动 reload 数据。
 *
 * KeepAlive：onActivated 启动数据加载 + 轮询；onDeactivated 清掉轮询定时器。
 */
import { ref, computed, onActivated, onDeactivated, watch } from 'vue'
import { shipping } from '@/api'
import { showToast } from '@/composables/useToast'

// ============================================================
// 数据状态
// ============================================================
// 用一个数组渲染今日 + 明日两个 section，避免模板重复
const SECTIONS = [
  { key: 'today',    title: '今日', emptyText: '今日尚無面單' },
  { key: 'tomorrow', title: '明日', emptyText: '明日尚無面單' },
]
// scope -> 该 scope 的 labels 数组
const sectionLabels = ref({ today: [], tomorrow: [] })
// scope -> 后端返回的目标日期（YYYY-MM-DD），用作板块标题旁的小字
const sectionDates = ref({ today: '', tomorrow: '' })
const historyLabels = ref([])

const loading = ref(false)        // 任何一个加载中
const downloadingId = ref(null)   // 正在下载的 label id（按钮 spinner）

// 历史板块分页 — 跟运单页同款
const PAGE_SIZE = 40
const historyPage = ref(1)
const historyTotal = ref(0)
const historyTotalPages = ref(0)
const hasPrev = computed(() => historyPage.value > 1)
const hasNext = computed(() => historyPage.value < historyTotalPages.value)

// 生成锁状态（来自后端 / 全用户共享）
// is_running=true 时所有用户的对应按钮都 disable
const generateStatus = ref({
  today:    { is_running: false, by_name: '', started_at: '' },
  tomorrow: { is_running: false, by_name: '', started_at: '' },
})
const localGenerating = ref({ today: false, tomorrow: false })   // 本地"按下时的瞬时态"，等轮询接管

// 自动刷新开关 — 默认开。关闭后停止轮询，节省 RPS；
// 代价：看不到别人正在生成的状态、别人生成完不会自动 reload 数据
const autoRefresh = ref(true)

// 任意 scope 是否在生成（按钮 disabled / 文案合成用）
function isScopeBusy(scope) {
  return generateStatus.value[scope].is_running || localGenerating.value[scope]
}

// ============================================================
// 列表加载
// ============================================================
async function fetchScope(scope, page = 1) {
  const params = { scope }
  if (scope === 'all') {
    params.page = page
    params.page_size = PAGE_SIZE
  }
  return shipping.listLabels(params)
}

async function loadAll() {
  if (loading.value) return
  loading.value = true
  try {
    // 并行拉三个 scope 减少首屏等待
    const [today, tomorrow, all] = await Promise.all([
      fetchScope('today'),
      fetchScope('tomorrow'),
      fetchScope('all', historyPage.value),
    ])
    sectionLabels.value = {
      today:    today.labels || [],
      tomorrow: tomorrow.labels || [],
    }
    sectionDates.value = {
      today:    today.target_date || '',
      tomorrow: tomorrow.target_date || '',
    }
    historyLabels.value = all.labels || []
    historyTotal.value = all.total || 0
    historyTotalPages.value = all.total_pages || 0
    if (all.page) historyPage.value = all.page
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '載入失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

async function loadHistoryPage(p) {
  if (p < 1 || p > historyTotalPages.value || p === historyPage.value) return
  historyPage.value = p
  try {
    const all = await fetchScope('all', p)
    historyLabels.value = all.labels || []
    historyTotal.value = all.total || 0
    historyTotalPages.value = all.total_pages || 0
    if (all.page) historyPage.value = all.page
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '翻頁失敗', 'error')
    }
  }
}

// ============================================================
// 下载（每次会让后端 download_count + 1）
// ============================================================
async function downloadLabel(label) {
  if (downloadingId.value === label.id) return
  // 占位 label 没文件，前端 button disabled，理论不会调到这；做兜底
  if (!label.has_attachment) {
    showToast('此記錄無 PDF 可下載', 'warning')
    return
  }
  downloadingId.value = label.id
  try {
    await shipping.downloadLabel(label.id, label.file_name)
    showToast('✅ 已下載', 'success')
    // download_count +1 了，三块全部 reload 让 UI 同步
    await loadAll()
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '下載失敗', 'error')
    }
  } finally {
    downloadingId.value = null
  }
}

// ============================================================
// 生成（决策 4：跨用户串行）
// ============================================================
async function generateScope(scope) {
  if (isScopeBusy(scope)) return
  // 立即更新本地 UI（不等轮询），按钮立马灰掉防双击
  localGenerating.value[scope] = true
  try {
    const res = await shipping.generateLabel(scope)
    if (res.status === 'busy') {
      // 后端同时撞锁：别人比我抢先一步
      showToast(`⚙️ ${res.by_name || '其他用戶'} 正在生成中…`, 'warning')
      // generateStatus 由下次轮询自动更新；这里强制刷一次让 UI 立即生效
      pollStatus()
    } else if (res.status === 'completed') {
      const label = res.label || {}
      if (label.waybill_count === 0) {
        showToast('📭 暫無新運單面單（已記錄占位）', 'warning')
      } else {
        showToast(`✅ 已生成 ${label.waybill_count} 張運單面單`, 'success')
      }
      // 数据有变，立刻 reload
      await loadAll()
    } else {
      showToast('生成完成但回應異常', 'error')
    }
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '生成失敗', 'error')
    }
  } finally {
    localGenerating.value[scope] = false
    // 生成完后立刻拉一次状态，确保 UI 跟最新一致
    pollStatus()
  }
}

// ============================================================
// 生成状态轮询（让所有 tab / 所有用户看到一致的"正在生成"）
// 注：每次轮询只拿 lock 状态，**不**重拉三块业务数据。
//     只有检测到"running → idle"翻转（说明有人刚生成完）才触发 loadAll()。
//     用户可手动关闭（autoRefresh=false）节省 RPS。
// ============================================================
let pollTimer = null
const POLL_INTERVAL_MS = 5000

async function pollStatus() {
  try {
    const res = await shipping.getGenerateStatus()
    const prev = generateStatus.value
    generateStatus.value = {
      today:    res.today    || { is_running: false },
      tomorrow: res.tomorrow || { is_running: false },
    }
    // 检测 running -> idle 翻转：自动 reload 数据（别人刚生成完）
    // 只检查别人触发的（本地 localGenerating 自己生成完会主动 reload）
    if (prev.today.is_running && !generateStatus.value.today.is_running && !localGenerating.value.today) {
      loadAll()
    }
    if (prev.tomorrow.is_running && !generateStatus.value.tomorrow.is_running && !localGenerating.value.tomorrow) {
      loadAll()
    }
  } catch {
    // 轮询失败静默；不打扰用户
  }
}

function startPolling() {
  if (pollTimer) return
  pollStatus()                                      // 立即查一次
  pollTimer = setInterval(pollStatus, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// 用户切换 autoRefresh 开关 → 启停轮询
watch(autoRefresh, (val) => {
  if (val) startPolling()
  else stopPolling()
})

// ============================================================
// 进入页面 / KeepAlive 切回 → 拉数据 + 启动轮询
// ============================================================
onActivated(() => {
  historyPage.value = 1   // 切回页面时回到第一页（保持新鲜）
  loadAll()
  if (autoRefresh.value) startPolling()
})

onDeactivated(() => {
  stopPolling()
})

// ============================================================
// 工具
// ============================================================
// 历史表格红行规则：未下载过 但 真有运单数据
//   占位 label（waybill_count=0）不参与红行 — 它本来就没东西可打印
function isUrgent(r) {
  return r.download_count === 0 && r.waybill_count > 0
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <!-- ========== 顶部工具栏：自動刷新開關 ========== -->
    <!--
      默认开 = 每 5 秒轮询 lock 状态 + 检测到别人生成完时自动 reload 数据
      关闭 = 停掉轮询，看不到别人正在生成 + 别人生成完后不会自动同步数据
            但本机用户自己生成 / 下载 / 翻页等所有功能仍然正常

      UI 用 .g-toggle 滑动开关（跟 Outbound 页"是否列印"同款），
      左侧用脉冲状态点替代原来的 🔄 emoji（视觉上更"仪表板"，不土）
    -->
    <div class="flex items-center justify-end mb-3 sm:mb-4">
      <div class="g-toggle-wrap">
        <span class="text-xs sm:text-sm text-gray-500 select-none flex items-center gap-1.5">
          <!-- 脉冲点：开 = 绿色脉动，关 = 灰色静止 -->
          <span
            class="w-2 h-2 rounded-full transition-colors"
            :class="autoRefresh ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'"
          ></span>
          <span>{{ autoRefresh ? '自動刷新（每 5s）' : '已暫停刷新' }}</span>
        </span>
        <button
          class="g-toggle"
          :class="{ on: autoRefresh }"
          :aria-label="autoRefresh ? '關閉自動刷新' : '開啟自動刷新'"
          :title="autoRefresh
            ? '每 5 秒同步生成狀態；別人生成完會自動載入最新數據'
            : '已停止輪詢；點開重新啟用'"
          @click="autoRefresh = !autoRefresh"
        ></button>
      </div>
    </div>

    <!-- ========== 上半：今日 + 明日 ========== -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 mb-8 sm:mb-10">
      <section v-for="sec in SECTIONS" :key="sec.key">
        <!-- 板块顶部按钮 — 点击触发生成 -->
        <div class="flex items-center gap-3 mb-4 sm:mb-5">
          <button
            class="g-btn g-btn-teal"
            style="padding: 10px 36px;"
            :disabled="isScopeBusy(sec.key) || loading"
            :title="isScopeBusy(sec.key) ? `${generateStatus[sec.key].by_name || '其他用戶'} 正在生成中` : '點擊生成本日新面單'"
            @click="generateScope(sec.key)"
          >
            <span v-if="isScopeBusy(sec.key)">⏳ 生成中…</span>
            <span v-else>⚡ {{ sec.title }}</span>
          </button>
          <span class="text-xs text-gray-400">
            {{ sectionLabels[sec.key].length }} 份
            <span v-if="sectionDates[sec.key]" class="text-gray-300">·</span>
            <span v-if="sectionDates[sec.key]">{{ sectionDates[sec.key] }}</span>
            <span
              v-if="generateStatus[sec.key].is_running && generateStatus[sec.key].by_name"
              class="ml-1 text-amber-600"
            >· {{ generateStatus[sec.key].by_name }} 處理中</span>
          </span>
        </div>

        <!-- 桌面：表格 -->
        <div class="hidden md:block g-card overflow-hidden">
          <table class="g-table">
            <thead>
              <tr>
                <th>文件名</th>
                <th class="text-center">運單</th>
                <th>時間</th>
                <th class="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!loading && !sectionLabels[sec.key].length">
                <td colspan="4" class="text-center text-gray-400 py-8 text-sm">{{ sec.emptyText }}</td>
              </tr>
              <tr
                v-for="r in sectionLabels[sec.key]" :key="r.id"
                :class="!r.has_attachment ? 'bg-gray-50' : ''"
              >
                <!-- 占位 label：整行灰底 + 文字灰；正常 label：display_name -->
                <td class="text-xs" :class="r.has_attachment ? '' : 'text-gray-400'">
                  <span v-if="r.has_attachment">{{ r.display_name || r.file_name }}</span>
                  <span v-else>📭 暫無資料</span>
                </td>
                <td class="text-center" :class="r.has_attachment ? 'font-semibold' : 'text-gray-400'">
                  {{ r.waybill_count }}
                </td>
                <td class="text-xs" :class="r.has_attachment ? 'text-gray-500' : 'text-gray-400'">
                  {{ r.operation_time }}
                </td>
                <td class="text-center">
                  <!-- 占位 label 直接不显示按钮，留 dash —— 比 disabled「無檔」按钮更干净 -->
                  <button
                    v-if="r.has_attachment"
                    class="g-btn g-btn-teal"
                    style="padding:5px 20px;font-size:12px"
                    :disabled="downloadingId === r.id"
                    @click="downloadLabel(r)"
                  >
                    {{ downloadingId === r.id ? '下載中…' : '下載' }}
                  </button>
                  <span v-else class="text-gray-300">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 手机：卡片列表 -->
        <div class="md:hidden">
          <div v-if="!loading && !sectionLabels[sec.key].length" class="g-card p-6 text-center text-gray-400 text-sm">
            {{ sec.emptyText }}
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="r in sectionLabels[sec.key]" :key="r.id"
              class="g-card p-3"
              :class="!r.has_attachment ? 'bg-gray-50' : ''"
            >
              <div class="flex items-start justify-between gap-3 mb-2">
                <div class="flex-1 min-w-0">
                  <div class="text-xs break-all" :class="r.has_attachment ? 'text-gray-700 font-semibold' : 'text-gray-400'">
                    {{ r.has_attachment ? (r.display_name || r.file_name) : '📭 暫無資料' }}
                  </div>
                  <div class="text-xs text-gray-400 mt-1">{{ r.operation_time }}</div>
                </div>
                <!-- 占位 label 不显示下载按钮 —— 留空，比灰按钮干净 -->
                <button
                  v-if="r.has_attachment"
                  class="g-btn g-btn-teal flex-shrink-0"
                  style="padding:6px 16px;font-size:12px"
                  :disabled="downloadingId === r.id"
                  @click="downloadLabel(r)"
                >
                  {{ downloadingId === r.id ? '下載中…' : '下載' }}
                </button>
                <span v-else class="text-gray-300 flex-shrink-0 px-2 self-center">—</span>
              </div>
              <div class="text-xs" :class="r.has_attachment ? 'text-gray-500' : 'text-gray-400'">
                運單數：<span :class="r.has_attachment ? 'font-semibold text-gray-800' : ''">{{ r.waybill_count }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ========== 下半：历史所有数据 ========== -->
    <div>
      <div class="flex items-center justify-between mb-4 sm:mb-5 flex-wrap gap-2">
        <h3 class="text-base sm:text-lg font-bold text-gray-700">📚 歷史所有數據</h3>
        <span class="text-xs text-gray-400">紅色行 = 從未列印，請優先處理</span>
      </div>

      <!-- 桌面：表格；isUrgent 整行红 -->
      <div class="hidden md:block g-card overflow-hidden">
        <table class="g-table">
          <thead>
            <tr>
              <th>出庫日期</th>
              <th>文件名</th>
              <th class="text-center">運單</th>
              <th>操作時間</th>
              <th class="text-center">列印次數</th>
              <th class="text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!loading && historyLabels.length === 0">
              <td colspan="6" class="text-center text-gray-400 py-10">暫無記錄</td>
            </tr>
            <tr
              v-for="r in historyLabels" :key="r.id"
              :class="isUrgent(r)
                ? 'bg-red-50 hover:bg-red-100'
                : (!r.has_attachment ? 'bg-gray-50' : '')"
            >
              <td
                class="font-semibold"
                :class="isUrgent(r) ? 'text-red-700' : (r.has_attachment ? '' : 'text-gray-400')"
              >{{ r.outbound_date || '—' }}</td>
              <td class="text-xs" :class="isUrgent(r) ? 'text-red-700' : (r.has_attachment ? '' : 'text-gray-400')">
                <span v-if="r.has_attachment">{{ r.display_name || r.file_name }}</span>
                <span v-else>📭 暫無資料</span>
              </td>
              <td
                class="text-center"
                :class="isUrgent(r)
                  ? 'text-red-700 font-semibold'
                  : (r.has_attachment ? 'font-semibold' : 'text-gray-400')"
              >{{ r.waybill_count }}</td>
              <td class="text-xs" :class="isUrgent(r) ? 'text-red-600' : (r.has_attachment ? 'text-gray-500' : 'text-gray-400')">
                {{ r.operation_time }}
              </td>
              <td class="text-center">
                <span
                  class="g-badge"
                  :style="isUrgent(r)
                    ? 'background:#fee2e2;color:#b91c1c;'
                    : (r.has_attachment
                       ? 'background:#ecfdf5;color:#047857;'
                       : 'background:#f3f4f6;color:#9ca3af;')"
                >{{ r.download_count }}</span>
              </td>
              <td class="text-center">
                <button
                  v-if="r.has_attachment"
                  class="g-btn g-btn-teal"
                  style="padding:5px 20px;font-size:12px"
                  :disabled="downloadingId === r.id"
                  @click="downloadLabel(r)"
                >
                  {{ downloadingId === r.id ? '下載中…' : '下載' }}
                </button>
                <span v-else class="text-gray-300">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 手机：卡片列表；isUrgent 整张红 -->
      <div class="md:hidden">
        <div v-if="!loading && historyLabels.length === 0" class="g-card p-10 text-center text-gray-400 text-sm">
          暫無記錄
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="r in historyLabels" :key="r.id"
            class="g-card p-3"
            :class="isUrgent(r)
              ? 'border-red-200 bg-red-50'
              : (!r.has_attachment ? 'bg-gray-50' : '')"
          >
            <div class="flex items-start justify-between gap-3 mb-2">
              <div class="flex-1 min-w-0">
                <div
                  class="font-semibold text-sm"
                  :class="isUrgent(r) ? 'text-red-700' : (r.has_attachment ? 'text-gray-800' : 'text-gray-400')"
                >
                  📅 {{ r.outbound_date || '—' }}
                </div>
                <div class="text-xs mt-1 break-all" :class="r.has_attachment ? 'text-gray-700' : 'text-gray-400'">
                  {{ r.has_attachment ? (r.display_name || r.file_name) : '📭 暫無資料' }}
                </div>
                <div class="text-xs text-gray-400 mt-1">{{ r.operation_time }}</div>
              </div>
              <button
                v-if="r.has_attachment"
                class="g-btn g-btn-teal flex-shrink-0"
                style="padding:6px 16px;font-size:12px"
                :disabled="downloadingId === r.id"
                @click="downloadLabel(r)"
              >
                {{ downloadingId === r.id ? '下載中…' : '下載' }}
              </button>
              <span v-else class="text-gray-300 flex-shrink-0 px-2 self-center">—</span>
            </div>
            <div class="flex items-center gap-2 flex-wrap text-xs" :class="!r.has_attachment ? 'text-gray-400' : ''">
              <span :class="r.has_attachment ? 'text-gray-500' : ''">
                運單：<span :class="r.has_attachment ? 'font-semibold text-gray-800' : ''">{{ r.waybill_count }}</span>
              </span>
              <span class="text-gray-300">·</span>
              <span :class="r.has_attachment ? 'text-gray-500' : ''">列印次數：</span>
              <span
                class="g-badge"
                :style="isUrgent(r)
                  ? 'background:#fee2e2;color:#b91c1c;'
                  : (r.has_attachment
                     ? 'background:#ecfdf5;color:#047857;'
                     : 'background:#f3f4f6;color:#9ca3af;')"
              >{{ r.download_count }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 分页栏（跟运单页同款） -->
      <div v-if="historyTotal > 0" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-5 sm:mt-6 text-sm">
        <div class="text-gray-500 text-center sm:text-left">
          第 <span class="text-gray-700 font-medium">{{ historyPage }}</span>
          / <span class="text-gray-700 font-medium">{{ historyTotalPages }}</span> 頁
          <span class="mx-2 text-gray-300">·</span>
          共 <span class="text-gray-700 font-medium">{{ historyTotal }}</span> 條
        </div>
        <div class="flex items-center justify-center gap-2">
          <button
            class="flex-1 sm:flex-none px-4 py-2 rounded border border-gray-200 text-gray-600 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="!hasPrev || loading"
            @click="loadHistoryPage(historyPage - 1)"
          >上一頁</button>
          <button
            class="flex-1 sm:flex-none px-4 py-2 rounded border border-gray-200 text-gray-600 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="!hasNext || loading"
            @click="loadHistoryPage(historyPage + 1)"
          >下一頁</button>
        </div>
      </div>
    </div>
  </div>
</template>
