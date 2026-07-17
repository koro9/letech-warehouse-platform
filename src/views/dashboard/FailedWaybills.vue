<script setup>
/**
 * 待生成面單 — 出貨作業中心 / Dashboard 系統
 *
 * 業務：列出「某個發貨日期還沒進面單批次」的所有運單(≈ Dashboard 已建立口徑)。
 *      進入頁默認展示今日,可按日期切換到明日或往前查漏。
 *      勾選後可批量生成新面單批次(有 tracking 的會抓 PDF,沒 tracking 的
 *      會被後端 retry 自動跳過留在本頁)。
 *
 * 後端 domain(list_failed_waybills 內):
 *   shipping_label_id 為空 + 非 3PL + hktv_raw_status 不含 CANCEL
 *
 * URL 保留原 /failed-waybills 不動,只是內部語義擴大;函數名同理。
 */
import { ref, computed, onActivated, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { shipping } from '@/api'
import { showToast } from '@/composables/useToast'

const router = useRouter()

const PAGE_SIZE = 40
const items = ref([])
const total = ref(0)
const page = ref(1)
const totalPages = ref(0)
const loading = ref(false)
const retrying = ref(false)           // 批量生成中
const retryingId = ref(null)          // 單條生成中的 item id
// 發貨日期預設為今日 HKT(YYYY-MM-DD)。用戶要看歷史/明日自己切換,清空 = 全部
const pickupFilter = ref((() => {
  const now = new Date()
  const hkt = new Date(now.getTime() + (8 * 60 - now.getTimezoneOffset()) * 60000)
  return hkt.toISOString().slice(0, 10)
})())
const selected = ref(new Set())       // 勾選的 item id

const hasPrev = computed(() => page.value > 1)
const hasNext = computed(() => page.value < totalPages.value)
const selectedCount = computed(() => selected.value.size)
// 當前頁全部可見 id
const pageIds = computed(() => items.value.map(i => i.id))
const allPageSelected = computed(() =>
  pageIds.value.length > 0 && pageIds.value.every(id => selected.value.has(id)))

async function load(p = 1) {
  loading.value = true
  try {
    const params = { page: p, page_size: PAGE_SIZE }
    if (pickupFilter.value) params.pickup_date = pickupFilter.value
    const data = await shipping.listFailedWaybills(params)
    items.value = data.items || []
    total.value = data.total || 0
    page.value = data.page || 1
    totalPages.value = data.total_pages || 0
  } catch (err) {
    showToast(err.response?.data?.error || '載入失敗', 'error')
  } finally {
    loading.value = false
  }
}

function loadPage(p) {
  if (p < 1 || (totalPages.value && p > totalPages.value)) return
  load(p)
}

function applyFilter() {
  selected.value = new Set()
  load(1)
}

function clearFilter() {
  pickupFilter.value = ''
  applyFilter()
}

function toggleRow(id) {
  const s = new Set(selected.value)
  s.has(id) ? s.delete(id) : s.add(id)
  selected.value = s
}

function togglePageAll() {
  const s = new Set(selected.value)
  if (allPageSelected.value) {
    pageIds.value.forEach(id => s.delete(id))
  } else {
    pageIds.value.forEach(id => s.add(id))
  }
  selected.value = s
}

async function retry(ids, singleId = null) {
  if (!ids.length) return
  if (singleId) retryingId.value = singleId
  else retrying.value = true
  try {
    const res = await shipping.retryFailedWaybills(ids)
    showToast(
      `⚡ 已提交 ${res.count} 張運單,正在生成新面單批次…完成後到【面單】下載`,
      'success')
    selected.value = new Set()
    // 重新載入(這些 item 已綁到新批次、離開本列表)
    await load(page.value)
  } catch (err) {
    const code = err.response?.data?.error
    const msg = code === 'no_eligible'
      ? '選中的運單沒有可生成面單的項(需有 HKTV 運單號、未在批次中、非取消)'
      : (code || '生成失敗')
    showToast(msg, 'error')
  } finally {
    retrying.value = false
    retryingId.value = null
  }
}

function retrySelected() {
  retry([...selected.value])
}

let pollTimer = null
onActivated(() => {
  load(page.value)
})
onDeactivated(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
</script>

<template>
  <div class="p-4 sm:p-6 max-w-[1400px] mx-auto">
    <!-- 標題 + 返回 -->
    <div class="flex items-center justify-between mb-4 sm:mb-5 flex-wrap gap-2 pb-3 border-b border-gray-200">
      <div class="flex items-center gap-2">
        <span class="text-xl sm:text-2xl">📝</span>
        <h2 class="text-base sm:text-lg font-bold text-gray-800">待生成面單</h2>
        <span class="hidden sm:inline text-xs text-gray-400 ml-2">
          未進面單批次的運單;勾選後可批量生成新批次
        </span>
      </div>
      <button
        class="g-btn g-btn-teal"
        style="padding: 8px 18px;"
        @click="router.push({ name: 'shipping' })"
      >← 返回面單</button>
    </div>

    <!-- 工具列：日期過濾 + 批量重試 -->
    <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
      <div class="flex items-center gap-2 flex-wrap">
        <label class="text-sm text-gray-500">發貨日期</label>
        <input
          type="date"
          v-model="pickupFilter"
          class="g-input"
          style="width: 170px;"
          @change="applyFilter"
        />
        <button
          v-if="pickupFilter"
          class="text-xs text-gray-400 hover:text-gray-600 underline"
          @click="clearFilter"
        >清除</button>
        <button
          class="px-3 py-2 rounded border border-gray-200 text-gray-600 text-sm hover:border-gray-400 disabled:opacity-40"
          :disabled="loading"
          @click="load(page)"
        >🔄 刷新</button>
      </div>
      <button
        class="g-btn g-btn-amber"
        style="padding: 9px 22px;"
        :disabled="selectedCount === 0 || retrying || loading"
        @click="retrySelected"
      >
        <span v-if="retrying">⏳ 提交中…</span>
        <span v-else>⚡ 批量生成({{ selectedCount }})</span>
      </button>
    </div>

    <!-- 表格 -->
    <div class="g-card overflow-hidden">
      <table class="g-table">
        <thead>
          <tr>
            <th class="text-center" style="width: 42px;">
              <input type="checkbox" :checked="allPageSelected" @change="togglePageAll" />
            </th>
            <th>銷售訂單號</th>
            <th>HKTV運單號</th>
            <th>狀態</th>
            <th class="text-center">店鋪</th>
            <th>發貨日期</th>
            <th>狀態備註</th>
            <th class="text-center">嘗試</th>
            <th class="text-center">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loading && items.length === 0">
            <td colspan="9" class="text-center text-gray-400 py-10">
              🎉 該日期所有運單已進面單批次
            </td>
          </tr>
          <tr v-for="r in items" :key="r.id"
              :class="selected.has(r.id) ? 'bg-amber-50' : ''">
            <td class="text-center">
              <input type="checkbox" :checked="selected.has(r.id)" @change="toggleRow(r.id)" />
            </td>
            <td class="font-mono text-xs">{{ r.sub_order_number || '—' }}</td>
            <td class="font-mono text-xs">{{ r.tracking_id || '—' }}</td>
            <td class="text-xs text-gray-600">{{ r.status || '—' }}</td>
            <td class="text-center text-xs">{{ r.store_code || '—' }}</td>
            <td class="text-xs text-gray-500">{{ r.pickup_date || '—' }}</td>
            <td class="text-xs" :class="r.error ? 'text-red-600' : 'text-gray-400'" :title="r.error">
              {{ r.error || '尚未抓取 / 未生成' }}
            </td>
            <td class="text-center text-xs text-gray-500">{{ r.attempts }}</td>
            <td class="text-center">
              <button
                class="g-btn g-btn-amber"
                style="padding: 5px 14px; font-size: 12px;"
                :disabled="retryingId === r.id || retrying"
                @click="retry([r.id], r.id)"
              >
                <span v-if="retryingId === r.id">⏳</span>
                <span v-else>⚡ 生成</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分頁 -->
    <div v-if="total > 0" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-5 sm:mt-6 text-sm">
      <div class="text-gray-500 text-center sm:text-left">
        第 <span class="text-gray-700 font-medium">{{ page }}</span>
        / <span class="text-gray-700 font-medium">{{ totalPages }}</span> 頁
        <span class="mx-2 text-gray-300">·</span>
        共 <span class="text-gray-700 font-medium">{{ total }}</span> 條
        <span v-if="selectedCount" class="ml-2 text-amber-600">（已勾選 {{ selectedCount }}）</span>
      </div>
      <div class="flex items-center justify-center gap-2">
        <button
          class="flex-1 sm:flex-none px-4 py-2 rounded border border-gray-200 text-gray-600 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!hasPrev || loading"
          @click="loadPage(page - 1)"
        >上一頁</button>
        <button
          class="flex-1 sm:flex-none px-4 py-2 rounded border border-gray-200 text-gray-600 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!hasNext || loading"
          @click="loadPage(page + 1)"
        >下一頁</button>
      </div>
    </div>
  </div>
</template>
