<script setup>
/**
 * 面单 — 出货作业中心 / Dashboard 系统
 *
 * 业务：仓库人员每天出库前先打面单贴包裹。一份面单 PDF 聚合了 N 张运单的面单。
 *      没打面单根本不知道要出哪些货 —— 这是出库链条最起点。
 *
 * 页面三块：
 *   1. 今日板块（按 outbound_date == TODAY）— 全量，无分页
 *   2. 明日板块（按 outbound_date == TOMORROW）— 全量，无分页
 *   3. 历史所有数据（含今天明天）— 分页加载，跟运单页同款 [上一頁][下一頁]
 *      → download_count === 0 的整行红色高亮，提示出库人员补打
 *
 * 数据来源：le.shipping.label（letech/le_warehouse/models/shipping_label.py）
 * 下载逻辑：调 /api/warehouse/shipping/labels/<id>/download → 同事务后端 +1
 *           浏览器收到 PDF 流自动触发另存
 *
 * KeepAlive：onActivated 一次性拉三块数据；下载完成后 reload 让 download_count 同步
 */
import { ref, computed, onActivated } from 'vue'
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

// ============================================================
// 数据加载
// ============================================================
async function fetchScope(scope, page = 1) {
  // 单独 fetch 一个 scope（today / tomorrow / all）
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
  downloadingId.value = label.id
  try {
    await shipping.downloadLabel(label.id, label.file_name)
    showToast('✅ 已下載', 'success')
    // download_count 在后端 +1 了，刷新一下让 UI 数字同步
    // 同一条 label 可能既出现在今日 / 明日，也在历史里 —— 三块全部 reload 最简单
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
// 进入页面 / KeepAlive 切回 → 拉数据
// ============================================================
onActivated(() => {
  historyPage.value = 1   // 切回页面时回到第一页（保持新鲜）
  loadAll()
})
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <!-- ========== 上半：今日 + 明日 ========== -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 mb-8 sm:mb-10">
      <section v-for="sec in SECTIONS" :key="sec.key">
        <div class="flex items-center gap-3 mb-4 sm:mb-5">
          <button class="g-btn g-btn-teal" style="padding: 10px 36px;">{{ sec.title }}</button>
          <span class="text-xs text-gray-400">{{ sectionLabels[sec.key].length }} 份</span>
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
              <tr v-for="r in sectionLabels[sec.key]" :key="r.id">
                <td class="font-mono text-xs">{{ r.file_name }}</td>
                <td class="text-center font-semibold">{{ r.waybill_count }}</td>
                <td class="text-xs text-gray-500">{{ r.operation_time }}</td>
                <td class="text-center">
                  <button
                    class="g-btn g-btn-teal"
                    style="padding:5px 20px;font-size:12px"
                    :disabled="downloadingId === r.id"
                    @click="downloadLabel(r)"
                  >{{ downloadingId === r.id ? '下載中…' : '下載' }}</button>
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
            <div v-for="r in sectionLabels[sec.key]" :key="r.id" class="g-card p-3">
              <div class="flex items-start justify-between gap-3 mb-2">
                <div class="flex-1 min-w-0">
                  <div class="font-mono text-xs text-gray-700 break-all">{{ r.file_name }}</div>
                  <div class="text-xs text-gray-400 mt-1">{{ r.operation_time }}</div>
                </div>
                <button
                  class="g-btn g-btn-teal flex-shrink-0"
                  style="padding:6px 16px;font-size:12px"
                  :disabled="downloadingId === r.id"
                  @click="downloadLabel(r)"
                >{{ downloadingId === r.id ? '下載中…' : '下載' }}</button>
              </div>
              <div class="text-xs text-gray-500">運單數：<span class="font-semibold text-gray-800">{{ r.waybill_count }}</span></div>
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

      <!-- 桌面：表格；download_count == 0 整行红 -->
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
              :class="r.download_count === 0 ? 'bg-red-50 hover:bg-red-100' : ''"
            >
              <td class="font-semibold" :class="r.download_count === 0 ? 'text-red-700' : ''">{{ r.outbound_date || '—' }}</td>
              <td class="font-mono text-xs" :class="r.download_count === 0 ? 'text-red-700' : ''">{{ r.file_name }}</td>
              <td class="text-center font-semibold" :class="r.download_count === 0 ? 'text-red-700' : ''">{{ r.waybill_count }}</td>
              <td class="text-xs" :class="r.download_count === 0 ? 'text-red-600' : 'text-gray-500'">{{ r.operation_time }}</td>
              <td class="text-center">
                <span
                  class="g-badge"
                  :style="r.download_count === 0
                    ? 'background:#fee2e2;color:#b91c1c;'
                    : 'background:#ecfdf5;color:#047857;'"
                >{{ r.download_count }}</span>
              </td>
              <td class="text-center">
                <button
                  class="g-btn g-btn-teal"
                  style="padding:5px 20px;font-size:12px"
                  :disabled="downloadingId === r.id"
                  @click="downloadLabel(r)"
                >{{ downloadingId === r.id ? '下載中…' : '下載' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 手机：卡片列表；download_count == 0 整张红 -->
      <div class="md:hidden">
        <div v-if="!loading && historyLabels.length === 0" class="g-card p-10 text-center text-gray-400 text-sm">
          暫無記錄
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="r in historyLabels" :key="r.id"
            class="g-card p-3"
            :class="r.download_count === 0 ? 'border-red-200 bg-red-50' : ''"
          >
            <div class="flex items-start justify-between gap-3 mb-2">
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-sm" :class="r.download_count === 0 ? 'text-red-700' : 'text-gray-800'">
                  📅 {{ r.outbound_date || '—' }}
                </div>
                <div class="font-mono text-xs text-gray-500 mt-1 break-all">{{ r.file_name }}</div>
                <div class="text-xs text-gray-400 mt-1">{{ r.operation_time }}</div>
              </div>
              <button
                class="g-btn g-btn-teal flex-shrink-0"
                style="padding:6px 16px;font-size:12px"
                :disabled="downloadingId === r.id"
                @click="downloadLabel(r)"
              >{{ downloadingId === r.id ? '下載中…' : '下載' }}</button>
            </div>
            <div class="flex items-center gap-2 flex-wrap text-xs">
              <span class="text-gray-500">運單：<span class="font-semibold text-gray-800">{{ r.waybill_count }}</span></span>
              <span class="text-gray-300">·</span>
              <span class="text-gray-500">列印次數：</span>
              <span
                class="g-badge"
                :style="r.download_count === 0
                  ? 'background:#fee2e2;color:#b91c1c;'
                  : 'background:#ecfdf5;color:#047857;'"
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
