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

// 历史板块过滤
//   historyDateFilter   日历搜索 — 出库日期精确匹配；空字符串 = 不过滤
//   historyUnprintedOnly  按钮 — 只看未列印（download_count=0 + 排除占位）
const historyDateFilter = ref('')
const historyUnprintedOnly = ref(false)

// localGenerating: 本地按下按钮的瞬时态（防双击）— HTTP 响应回来即清
// 真正的"还在处理中"判断走 sectionLabels 里 status='processing' 的 label
const localGenerating = ref({ today: false, tomorrow: false })

// 自动刷新开关 — 默认开。关闭后停止 5s 轮询；用户手动点按钮仍可用
const autoRefresh = ref(true)

// 任意 scope 是否有 processing 状态的 label（按钮 disabled / 文案合成用）
// 数据来自 sectionLabels — listLabels 端点已经返回 status / progress
function isScopeBusy(scope) {
  if (localGenerating.value[scope]) return true
  return sectionLabels.value[scope].some(l => l.status === 'processing')
}

// 拿到该 scope 当前 processing 中的 label（取最新一个）
function getProcessingLabel(scope) {
  return sectionLabels.value[scope].find(l => l.status === 'processing')
}

// ============================================================
// 列表加载
// ============================================================
async function fetchScope(scope, page = 1) {
  const params = { scope }
  if (scope === 'all') {
    params.page = page
    params.page_size = PAGE_SIZE
    // 历史板块过滤：仅 scope=all 才传，today/tomorrow 不需要
    if (historyDateFilter.value) {
      params.outbound_date = historyDateFilter.value
    }
    if (historyUnprintedOnly.value) {
      params.only_unprinted = 1
    }
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

// 翻页（带边界保护）— 用户点上一页/下一页时调
async function loadHistoryPage(p) {
  if (p < 1 || p > historyTotalPages.value || p === historyPage.value) return
  historyPage.value = p
  await reloadHistory()
}

// 重新加载历史板块（不带边界保护）— 用户改筛选条件时调
async function reloadHistory() {
  try {
    const all = await fetchScope('all', historyPage.value)
    historyLabels.value = all.labels || []
    historyTotal.value = all.total || 0
    historyTotalPages.value = all.total_pages || 0
    if (all.page) historyPage.value = all.page
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '載入失敗', 'error')
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
      // 同日已有 processing 中的 label / 同事务撞 advisory lock
      const msg = res.detail || '其他用戶正在生成中'
      showToast(`⚙️ ${msg}`, 'warning')
    } else if (res.status === 'placeholder') {
      // 没有待生成的 items — 创建了占位 label 作为信号
      showToast('📭 暫無新運單面單（已記錄占位）', 'warning')
    } else if (res.status === 'queued') {
      // 已创建 placeholder label + 投递 queue_job 异步抓 PDF
      const n = res.label?.waybill_count || 0
      showToast(`⏳ 已排程：${n} 張運單，後台處理中…`, 'success')
    } else {
      showToast('生成完成但回應異常', 'error')
    }
    // 不管哪个分支都立刻 reload — 让员工立刻看到新 record（含 processing 状态）
    await loadAll()
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '生成失敗', 'error')
    }
  } finally {
    localGenerating.value[scope] = false
  }
}

// ============================================================
// 5s 轮询 — 直接 loadAll 全量刷新
// ============================================================
// 改造后的设计：processing 状态在 le.shipping.label 上（带 progress 字段），
// 必须重拉 listLabels 才能看到进度变化和 status 翻转，所以 5s 直接 loadAll。
// loadAll 内部有 if (loading.value) return 自带去重保护，无需额外锁。
// 当用户没操作时 5s 自动看到别人 / 自己 job 跑出来的最新 progress / 完成态。
let pollTimer = null
const POLL_INTERVAL_MS = 5000

async function pollLabels() {
  if (!autoRefresh.value) return
  await loadAll()
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(pollLabels, POLL_INTERVAL_MS)
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

// 历史板块过滤变化 → 重置到第 1 页 + 只重新拉历史（today/tomorrow 不受影响）
watch([historyDateFilter, historyUnprintedOnly], () => {
  historyPage.value = 1
  reloadHistory()
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
// 历史表格红行规则：done + 真有 PDF 但从未下载过
//   - processing/failed 不参与红行（不是"忘记下载"，是状态问题）
//   - 占位 label（waybill_count=0）不参与红行 — 本来就没东西可打印
function isUrgent(r) {
  return r.status === 'done'
    && r.has_attachment
    && r.download_count === 0
    && r.waybill_count > 0
}

// 行状态四态分类 — 决定 UI 样式 / 文案 / 是否显示下载按钮
//   processing  → queue_job 后台抓 PDF 中（蓝底 + 进度提示）
//   failed      → 抓 / 合并失败（红底 + 失败原因）
//   ready       → 已生成 PDF（正常显示文件名 + 下载按钮）
//   placeholder → 占位记录（暫無資料；done + 没 attachment）
function rowState(r) {
  if (r.status === 'processing') return 'processing'
  if (r.status === 'failed') return 'failed'
  if (r.has_attachment) return 'ready'
  return 'placeholder'
}

// 部分失败：done + 已生成 PDF + 但 failed_reason 非空
//   说明 N 张运单中有 M 张抓取失败，没含到合并 PDF 里
//   员工要看这个角标决定是否重新生成（补抓那些缺的）
function hasPartialFailure(r) {
  return r.status === 'done' && r.has_attachment && r.failed_reason
}

// 行容器 class（背景色等）
function rowClass(r) {
  if (isUrgent(r)) return 'bg-red-50 hover:bg-red-100'
  const s = rowState(r)
  if (s === 'processing') return 'bg-blue-50'
  if (s === 'failed') return 'bg-red-50'
  if (s === 'placeholder') return 'bg-gray-50'
  return ''
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

    <!-- ========== 上半：待出庫面單（今日 + 明日） ========== -->
    <section class="mb-10 sm:mb-12">
      <!-- 板块大标题 + 简短说明 -->
      <div class="flex items-center justify-between mb-4 sm:mb-5 flex-wrap gap-2 pb-3 border-b border-gray-200">
        <div class="flex items-center gap-2">
          <span class="text-xl sm:text-2xl">📦</span>
          <h2 class="text-base sm:text-lg font-bold text-gray-800">待出庫面單</h2>
          <span class="hidden sm:inline text-xs text-gray-400 ml-2">點擊「⚡ 今日 / ⚡ 明日」按鈕生成</span>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
      <section v-for="sec in SECTIONS" :key="sec.key">
        <!-- 板块顶部按钮 — 点击触发生成 -->
        <div class="flex items-center gap-3 mb-4 sm:mb-5">
          <button
            class="g-btn g-btn-teal"
            style="padding: 10px 36px;"
            :disabled="isScopeBusy(sec.key) || loading"
            :title="isScopeBusy(sec.key)
              ? `處理中：${getProcessingLabel(sec.key)?.progress || ''}`
              : '點擊生成本日新面單'"
            @click="generateScope(sec.key)"
          >
            <span v-if="isScopeBusy(sec.key)">
              ⏳ 處理中
              <span v-if="getProcessingLabel(sec.key)?.progress" class="ml-1 text-xs opacity-80">
                ({{ getProcessingLabel(sec.key).progress }})
              </span>
            </span>
            <span v-else>⚡ {{ sec.title }}</span>
          </button>
          <span class="text-xs text-gray-400">
            {{ sectionLabels[sec.key].length }} 份
            <span v-if="sectionDates[sec.key]" class="text-gray-300">·</span>
            <span v-if="sectionDates[sec.key]">{{ sectionDates[sec.key] }}</span>
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
                :class="rowClass(r)"
              >
                <!-- 文件名列：4 态分支
                     processing → ⏳ 進度提示
                     failed     → ❌ 失敗原因
                     ready      → 真实 PDF 文件名
                     placeholder→ 📭 暫無資料 -->
                <td class="text-xs">
                  <span v-if="rowState(r) === 'processing'" class="text-blue-700 font-semibold">
                    ⏳ 處理中
                    <span v-if="r.progress" class="font-mono ml-1">({{ r.progress }})</span>
                  </span>
                  <span v-else-if="rowState(r) === 'failed'" class="text-red-700 font-semibold" :title="r.failed_reason">
                    ❌ 處理失敗
                  </span>
                  <span v-else-if="rowState(r) === 'ready'" class="font-mono">
                    {{ r.file_name }}
                    <span v-if="hasPartialFailure(r)"
                          class="ml-1 text-amber-600 cursor-help"
                          :title="r.failed_reason">⚠️</span>
                  </span>
                  <span v-else class="text-gray-400">📭 暫無資料</span>
                </td>
                <td class="text-center" :class="rowState(r) === 'ready' ? 'font-semibold' : 'text-gray-500'">
                  {{ r.waybill_count }}
                </td>
                <td class="text-xs" :class="rowState(r) === 'ready' ? 'text-gray-500' : 'text-gray-400'">
                  {{ r.operation_time }}
                </td>
                <td class="text-center">
                  <button
                    v-if="rowState(r) === 'ready'"
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
              :class="rowClass(r)"
            >
              <div class="flex items-start justify-between gap-3 mb-2">
                <div class="flex-1 min-w-0">
                  <div class="text-xs break-all">
                    <span v-if="rowState(r) === 'processing'" class="text-blue-700 font-semibold">
                      ⏳ 處理中
                      <span v-if="r.progress" class="font-mono ml-1">({{ r.progress }})</span>
                    </span>
                    <span v-else-if="rowState(r) === 'failed'" class="text-red-700 font-semibold" :title="r.failed_reason">
                      ❌ 處理失敗
                    </span>
                    <span v-else-if="rowState(r) === 'ready'" class="font-mono text-gray-700 font-semibold">
                      {{ r.file_name }}
                      <span v-if="hasPartialFailure(r)"
                            class="ml-1 text-amber-600 cursor-help"
                            :title="r.failed_reason">⚠️</span>
                    </span>
                    <span v-else class="text-gray-400">📭 暫無資料</span>
                  </div>
                  <div class="text-xs text-gray-400 mt-1">{{ r.operation_time }}</div>
                </div>
                <button
                  v-if="rowState(r) === 'ready'"
                  class="g-btn g-btn-teal flex-shrink-0"
                  style="padding:6px 16px;font-size:12px"
                  :disabled="downloadingId === r.id"
                  @click="downloadLabel(r)"
                >
                  {{ downloadingId === r.id ? '下載中…' : '下載' }}
                </button>
                <span v-else class="text-gray-300 flex-shrink-0 px-2 self-center">—</span>
              </div>
              <div class="text-xs text-gray-500">
                運單數：<span :class="rowState(r) === 'ready' ? 'font-semibold text-gray-800' : ''">{{ r.waybill_count }}</span>
              </div>
            </div>
          </div>
        </div>
        </section>
      </div>
    </section>

    <!-- ========== 下半：歷史所有數據 ========== -->
    <section>
      <!-- 板块大标题 + 搜索区 — 跟上半板块标题样式对齐 -->
      <div class="flex items-center justify-between mb-4 sm:mb-5 flex-wrap gap-3 pb-3 border-b border-gray-200">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xl sm:text-2xl">📚</span>
          <h2 class="text-base sm:text-lg font-bold text-gray-800">歷史所有數據</h2>
          <span class="hidden sm:inline text-xs text-gray-400 ml-2">紅色行 = 從未列印</span>
        </div>
        <!-- 搜索区：日历 + 未列印过滤切换 -->
        <div class="flex items-center gap-2 flex-wrap">
          <input
            v-model="historyDateFilter"
            type="date"
            class="g-input"
            style="height:36px;width:160px;padding:6px 10px;font-size:13px;"
            title="按出庫日期搜索"
          />
          <button
            v-if="historyDateFilter"
            type="button"
            class="text-xs text-gray-400 hover:text-gray-600 underline"
            @click="historyDateFilter = ''"
          >清除</button>
          <button
            type="button"
            class="px-3 py-1.5 text-xs rounded border transition-colors flex items-center gap-1"
            :class="historyUnprintedOnly
              ? 'bg-red-500 border-red-500 text-white hover:bg-red-600'
              : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'"
            :title="historyUnprintedOnly ? '點擊顯示全部' : '只看未列印的批次（排除占位）'"
            @click="historyUnprintedOnly = !historyUnprintedOnly"
          >
            <span>🚨</span>
            <span>{{ historyUnprintedOnly ? '只看未列印' : '只看未列印' }}</span>
          </button>
        </div>
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
            <tr v-for="r in historyLabels" :key="r.id" :class="rowClass(r)">
              <td class="font-semibold"
                  :class="isUrgent(r) ? 'text-red-700' : (rowState(r) === 'ready' ? '' : 'text-gray-500')">
                {{ r.outbound_date || '—' }}
              </td>
              <td class="text-xs">
                <span v-if="rowState(r) === 'processing'" class="text-blue-700 font-semibold">
                  ⏳ 處理中
                  <span v-if="r.progress" class="font-mono ml-1">({{ r.progress }})</span>
                </span>
                <span v-else-if="rowState(r) === 'failed'" class="text-red-700 font-semibold" :title="r.failed_reason">
                  ❌ 處理失敗
                </span>
                <span v-else-if="rowState(r) === 'ready'"
                      class="font-mono"
                      :class="isUrgent(r) ? 'text-red-700' : ''">
                  {{ r.file_name }}
                  <span v-if="hasPartialFailure(r)"
                        class="ml-1 text-amber-600 cursor-help"
                        :title="r.failed_reason">⚠️</span>
                </span>
                <span v-else class="text-gray-400">📭 暫無資料</span>
              </td>
              <td class="text-center"
                  :class="isUrgent(r)
                    ? 'text-red-700 font-semibold'
                    : (rowState(r) === 'ready' ? 'font-semibold' : 'text-gray-500')">
                {{ r.waybill_count }}
              </td>
              <td class="text-xs"
                  :class="isUrgent(r) ? 'text-red-600' : (rowState(r) === 'ready' ? 'text-gray-500' : 'text-gray-400')">
                {{ r.operation_time }}
              </td>
              <td class="text-center">
                <span class="g-badge"
                      :style="isUrgent(r)
                        ? 'background:#fee2e2;color:#b91c1c;'
                        : (rowState(r) === 'ready'
                           ? 'background:#ecfdf5;color:#047857;'
                           : 'background:#f3f4f6;color:#9ca3af;')">
                  {{ r.download_count }}
                </span>
              </td>
              <td class="text-center">
                <button v-if="rowState(r) === 'ready'"
                        class="g-btn g-btn-teal"
                        style="padding:5px 20px;font-size:12px"
                        :disabled="downloadingId === r.id"
                        @click="downloadLabel(r)">
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
          <div v-for="r in historyLabels" :key="r.id"
               class="g-card p-3"
               :class="[rowClass(r), isUrgent(r) ? 'border-red-200' : '']">
            <div class="flex items-start justify-between gap-3 mb-2">
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-sm"
                     :class="isUrgent(r) ? 'text-red-700' : (rowState(r) === 'ready' ? 'text-gray-800' : 'text-gray-500')">
                  📅 {{ r.outbound_date || '—' }}
                </div>
                <div class="text-xs mt-1 break-all">
                  <span v-if="rowState(r) === 'processing'" class="text-blue-700 font-semibold">
                    ⏳ 處理中
                    <span v-if="r.progress" class="font-mono ml-1">({{ r.progress }})</span>
                  </span>
                  <span v-else-if="rowState(r) === 'failed'" class="text-red-700 font-semibold" :title="r.failed_reason">
                    ❌ 處理失敗
                  </span>
                  <span v-else-if="rowState(r) === 'ready'" class="font-mono text-gray-700">
                    {{ r.file_name }}
                    <span v-if="hasPartialFailure(r)"
                          class="ml-1 text-amber-600 cursor-help"
                          :title="r.failed_reason">⚠️</span>
                  </span>
                  <span v-else class="text-gray-400">📭 暫無資料</span>
                </div>
                <div class="text-xs text-gray-400 mt-1">{{ r.operation_time }}</div>
              </div>
              <button v-if="rowState(r) === 'ready'"
                      class="g-btn g-btn-teal flex-shrink-0"
                      style="padding:6px 16px;font-size:12px"
                      :disabled="downloadingId === r.id"
                      @click="downloadLabel(r)">
                {{ downloadingId === r.id ? '下載中…' : '下載' }}
              </button>
              <span v-else class="text-gray-300 flex-shrink-0 px-2 self-center">—</span>
            </div>
            <div class="flex items-center gap-2 flex-wrap text-xs text-gray-500">
              <span>
                運單：<span :class="rowState(r) === 'ready' ? 'font-semibold text-gray-800' : ''">
                  {{ r.waybill_count }}
                </span>
              </span>
              <span class="text-gray-300">·</span>
              <span>列印次數：</span>
              <span class="g-badge"
                    :style="isUrgent(r)
                      ? 'background:#fee2e2;color:#b91c1c;'
                      : (rowState(r) === 'ready'
                         ? 'background:#ecfdf5;color:#047857;'
                         : 'background:#f3f4f6;color:#9ca3af;')">
                {{ r.download_count }}
              </span>
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
    </section>
  </div>
</template>
