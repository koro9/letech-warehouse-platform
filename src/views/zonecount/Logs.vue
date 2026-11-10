<script setup>
/**
 * 區域盤點 · 操作記錄
 *
 * 每一笔都留底（只加不删）：录入 / 加上 / 改成 / 撤回 / 货架盘完 / 写回…
 * 每笔都绑任务单 + 操作员工（兼职扫胸牌的人，不是共用 kiosk 帐号）+ 设备 + 原数量 → 新数量。
 * 查「谁出问题」：按任务单 / 员工 / SKU / 动作 / 日期筛。
 * URL 状态：?batch= &task= &employee= &q= &action= &from= &to= &page=
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { zonecount } from '@/api'
import { showToast } from '@/composables/useToast'
import BatchBar from './BatchBar.vue'
import { batchId, currentBatch, downloadXlsx, errText, fmtQty } from './zoneShared'

const PAGE_SIZE = 50
const ACTIONS = [
  { value: '', label: '全部動作' },
  { value: 'record,add,set', label: '錄入 / 加上 / 改成' },
  { value: 'set', label: '只看改成' },
  { value: 'undo', label: '只看撤回' },
  { value: 'shelf_done,shelf_reopen,task_submit,task_reopen', label: '盤完 / 重開 / 退回' },
  { value: 'task_start,task_cancel,writeback', label: '開單 / 取消 / 寫回' },
]
const ACTION_CLS = {
  record: 'text-gray-700', add: 'text-sky-700', set: 'text-amber-700', undo: 'text-red-600',
  writeback: 'text-emerald-700', task_cancel: 'text-red-600',
}

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const result = ref(null)
const tasks = ref([])
const employees = ref([])
const query = ref('')
const exporting = ref(false)

const cond = computed(() => ({
  task: (route.query.task || '').toString(),
  employee: (route.query.employee || '').toString(),
  q: (route.query.q || '').toString(),
  action: ACTIONS.some(a => a.value === route.query.action) ? route.query.action : '',
  from: (route.query.from || '').toString(),
  to: (route.query.to || '').toString(),
  page: Math.max(1, parseInt(route.query.page, 10) || 1),
}))

function params(c, page, pageSize) {
  return {
    batchId: batchId.value, taskId: c.task, employeeId: c.employee, q: c.q, action: c.action,
    dateFrom: c.from, dateTo: c.to, page, pageSize,
  }
}

async function load() {
  if (!batchId.value) { result.value = null; return }
  loading.value = true
  try {
    const c = cond.value
    result.value = await zonecount.getLogs(params(c, c.page, PAGE_SIZE))
    query.value = c.q
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '載入操作記錄失敗'), 'error')
  } finally {
    loading.value = false
  }
}

async function loadFilters() {
  if (!batchId.value) return
  try {
    const [t, e] = await Promise.all([zonecount.getTasks(batchId.value), zonecount.getEmployees()])
    tasks.value = t.tasks || []
    employees.value = e.employees || []
  } catch { /* 筛选下拉拿不到不影响列表 */ }
}

function setCond(patch) {
  const next = { ...cond.value, page: 1, ...patch }
  const q = { batch: batchId.value ? String(batchId.value) : undefined }
  for (const k of ['task', 'employee', 'q', 'action', 'from', 'to']) if (next[k]) q[k] = next[k]
  if (next.page > 1) q.page = String(next.page)
  router.replace({ query: q })
}

function goPage(p) {
  const total = result.value?.total_pages || 0
  if (p < 1 || p > total || p === cond.value.page) return
  setCond({ page: p })
}

watch(() => [route.fullPath, batchId.value], () => {
  if (route.name === 'zone-logs') load()
}, { immediate: true })
watch(batchId, loadFilters, { immediate: true })

const currentTask = computed(() => tasks.value.find(t => String(t.id) === cond.value.task))

const rangeText = computed(() => {
  const r = result.value
  if (!r?.total) return ''
  const from = (r.page - 1) * r.page_size + 1
  return `第 ${from}–${from + r.logs.length - 1} 筆，共 ${r.total} 筆`
})

function qtyText(l) {
  if (['record', 'add', 'set', 'undo', 'writeback'].includes(l.action)) {
    return l.action === 'record' ? fmtQty(l.qty_after) : `${fmtQty(l.qty_before)} → ${fmtQty(l.qty_after)}`
  }
  return ''
}

async function exportCsv() {
  exporting.value = true
  try {
    const c = cond.value
    const all = []
    for (let page = 1; ; page++) {
      const r = await zonecount.getLogs(params(c, page, 2000))
      all.push(...r.logs)
      if (!r.has_more) break
    }
    const rows = [['時間', '任務單', '動作', '員工', '系統帳號', '設備', 'SKU', '商品', '位置', '到期日', '原數量', '新數量', '備註']]
    for (const l of all) {
      rows.push([l.time, l.task.name, l.action_label, l.employee, l.user, l.device, l.sku, l.name,
        l.location_full || l.shelf, l.expiry || '', l.qty_before, l.qty_after, l.note])
    }
    await downloadXlsx(`區域盤點操作記錄_${currentTask.value?.name || currentBatch.value?.name || ''}.xlsx`, rows, '操作記錄')
    showToast(`已匯出 ${all.length} 筆`, 'success')
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '匯出失敗'), 'error')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-[1400px]">
    <BatchBar title="操作記錄" subtitle="每一筆都留底、不能刪改（撤回也是新加一行）。按任務單 / 員工 / SKU 查，事後追查誰出問題。" />

    <template v-if="currentBatch">
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-3 lg:p-4 mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.3fr_1fr_auto_auto]">
        <select :value="cond.task" class="g-input" aria-label="任務單" @change="setCond({ task: $event.target.value })">
          <option value="">全部任務單</option>
          <option v-for="t in tasks" :key="t.id" :value="String(t.id)">{{ t.name }} · {{ t.employee.name }}</option>
        </select>
        <select :value="cond.employee" class="g-input" aria-label="員工" @change="setCond({ employee: $event.target.value })">
          <option value="">全部員工</option>
          <option v-for="e in employees" :key="e.id" :value="String(e.id)">{{ e.name }}</option>
        </select>
        <form class="flex gap-2" @submit.prevent="setCond({ q: query.trim() })">
          <input v-model="query" class="g-input flex-1 min-w-0" placeholder="SKU / 商品 / 位置，按 Enter" />
        </form>
        <select :value="cond.action" class="g-input" aria-label="動作" @change="setCond({ action: $event.target.value })">
          <option v-for="a in ACTIONS" :key="a.value" :value="a.value">{{ a.label }}</option>
        </select>
        <div class="flex items-center gap-1 text-sm text-gray-500">
          <input type="date" :value="cond.from" class="g-input !px-2" aria-label="開始日期" @change="setCond({ from: $event.target.value })" />
          –
          <input type="date" :value="cond.to" class="g-input !px-2" aria-label="結束日期" @change="setCond({ to: $event.target.value })" />
        </div>
        <button type="button" class="g-btn bg-white border border-gray-200 text-gray-700 !px-4" :disabled="exporting || !result?.total" @click="exportCsv">
          {{ exporting ? '匯出中…' : '匯出 Excel' }}
        </button>
      </div>

      <div v-if="currentTask" class="rounded-xl bg-[#EAF4F1] text-[#2F6B5F] px-4 py-3 mb-4 text-sm flex flex-wrap gap-x-4 gap-y-1">
        <b>{{ currentTask.name }}</b>
        <span>{{ currentTask.employee.name }}</span>
        <span>貨架 {{ currentTask.shelves.map(s => s.name).join('、') }}</span>
        <span v-if="currentTask.planned_start">{{ currentTask.planned_start }} – {{ currentTask.planned_end.slice(-5) }}</span>
        <span>{{ currentTask.sku_count }} SKU · {{ fmtQty(currentTask.qty) }} 件</span>
        <button type="button" class="underline ml-auto" @click="setCond({ task: '' })">看全部任務單</button>
      </div>

      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" :class="{ 'opacity-60': loading }">
        <div class="overflow-x-auto">
          <table class="w-full text-sm border-collapse min-w-[1000px]">
            <thead>
              <tr class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-[13px]">
                <th class="text-left font-bold px-4 py-3 w-40">時間</th>
                <th class="text-left font-bold px-4 py-3 w-28">任務單</th>
                <th class="text-left font-bold px-4 py-3 w-24">員工</th>
                <th class="text-left font-bold px-4 py-3 w-24">動作</th>
                <th class="text-left font-bold px-4 py-3">SKU / 商品</th>
                <th class="text-left font-bold px-4 py-3 w-28">位置</th>
                <th class="text-left font-bold px-4 py-3 w-28">到期日</th>
                <th class="text-right font-bold px-4 py-3 w-28">數量</th>
                <th class="text-left font-bold px-4 py-3">備註 / 設備</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in result?.logs || []" :key="l.id" class="border-t border-gray-100 hover:bg-slate-50">
                <td class="px-4 py-2 font-mono text-xs text-gray-500 whitespace-nowrap">{{ l.time }}</td>
                <td class="px-4 py-2 whitespace-nowrap">
                  <button type="button" class="text-[#2F6B5F] hover:underline" @click="setCond({ task: String(l.task.id) })">{{ l.task.name }}</button>
                </td>
                <td class="px-4 py-2 whitespace-nowrap">{{ l.employee }}</td>
                <td class="px-4 py-2 font-semibold whitespace-nowrap" :class="ACTION_CLS[l.action] || 'text-gray-500'">{{ l.action_label }}</td>
                <td class="px-4 py-2">
                  <span v-if="l.sku" class="font-mono text-gray-800">{{ l.sku }}</span>
                  <div v-if="l.name" class="text-xs text-gray-500">{{ l.name }}</div>
                </td>
                <td class="px-4 py-2 font-mono whitespace-nowrap">{{ l.location || l.shelf }}</td>
                <td class="px-4 py-2 font-mono text-xs whitespace-nowrap">{{ l.expiry || '' }}</td>
                <td class="px-4 py-2 text-right font-mono tabular-nums font-semibold whitespace-nowrap">{{ qtyText(l) }}</td>
                <td class="px-4 py-2 text-xs text-gray-500">
                  {{ l.note }}<div v-if="l.device" class="text-gray-400">{{ l.device }}</div>
                </td>
              </tr>
              <tr v-if="result && !result.logs.length">
                <td colspan="9" class="px-4 py-10 text-center text-gray-400">沒有符合條件的記錄。</td>
              </tr>
              <tr v-if="!result && loading">
                <td colspan="9" class="px-4 py-10 text-center text-gray-400">載入中…</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="result?.total" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 text-sm">
        <div class="text-gray-500">{{ rangeText }} · 第 <span class="text-gray-700 font-medium">{{ result.page }}</span> / {{ result.total_pages }} 頁</div>
        <div class="flex items-center gap-2">
          <button type="button" class="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40" :disabled="loading || result.page <= 1" @click="goPage(1)">第一頁</button>
          <button type="button" class="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40" :disabled="loading || result.page <= 1" @click="goPage(result.page - 1)">‹ 上一頁</button>
          <button type="button" class="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40" :disabled="loading || result.page >= result.total_pages" @click="goPage(result.page + 1)">下一頁 ›</button>
          <button type="button" class="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40" :disabled="loading || result.page >= result.total_pages" @click="goPage(result.total_pages)">最後一頁</button>
        </div>
      </div>
    </template>
  </div>
</template>
