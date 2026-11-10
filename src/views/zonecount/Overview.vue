<script setup>
/**
 * 區域盤點 · 盤點總覽
 *
 * 一个批次的整体进度：任务单状态、已盘 SKU / 件数、未上架还剩多少、写回时多出多少，
 * 每张任务单一行进度、每个员工的录入 / 改数 / 撤回次数（查谁出问题先看这里）。
 *
 * 差异口径（不做全仓快照）：
 *   写回时「未上架」不够搬 → 多出（盘多了 / 系统少）
 *   全部盘完后还剩在「未上架」→ 系统有、没人找到
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { zonecount } from '@/api'
import { showToast } from '@/composables/useToast'
import BatchBar from './BatchBar.vue'
import ShelfStatCards from '@/views/shelf/ShelfStatCards.vue'
import { TASK_STATES, batchId, currentBatch, errText, fmtQty, loadBatches } from './zoneShared'

const router = useRouter()
const data = ref(null)
const loading = ref(false)

async function load() {
  if (!batchId.value) { data.value = null; return }
  loading.value = true
  try {
    data.value = await zonecount.getOverview(batchId.value)
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '載入總覽失敗'), 'error')
  } finally {
    loading.value = false
  }
}
watch(batchId, load, { immediate: true })

const st = computed(() => data.value?.stats)
const cards = computed(() => {
  const s = st.value
  if (!s) return []
  const by = s.task_by_state || {}
  return [
    { label: '任務單（盤點中 / 待覆核 / 已寫回）', value: `${by.counting || 0} / ${by.submitted || 0} / ${by.done || 0}` },
    { label: '鎖定中的貨架', value: s.locked_shelf_count, unit: '個', tone: s.locked_shelf_count ? 'warn' : 'muted' },
    { label: '已盤 SKU', value: s.counted_sku, unit: '個' },
    { label: '已盤件數', value: s.counted_qty, unit: '件' },
  ]
})
const cards2 = computed(() => {
  const s = st.value
  if (!s) return []
  return [
    { label: '未上架（系統有、還沒盤到）', value: s.unshelved_qty, unit: '件', tone: 'amber' },
    { label: '未上架 SKU', value: s.unshelved_sku, unit: '個', tone: 'amber' },
    { label: '多出（寫回時未上架不夠）', value: s.over_qty, unit: '件', tone: s.over_qty ? 'warn' : 'muted' },
    { label: '操作記錄', value: s.log_count, unit: '筆' },
  ]
})

const closing = ref(false)
async function toggleBatch() {
  const b = currentBatch.value
  if (!b) return
  const op = b.state === 'open' ? 'close' : 'reopen'
  if (op === 'close' && !window.confirm(`結束「${b.name}」？結束後不能再開任務單（可以再重開）。`)) return
  closing.value = true
  try {
    await zonecount.batchOp(b.id, op)
    await loadBatches(b.id)
    showToast(op === 'close' ? '批次已結束' : '批次已重開', 'success')
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '操作失敗'), 'error')
  } finally {
    closing.value = false
  }
}

function go(name, query = {}) {
  router.push({ name, query: { batch: String(batchId.value), ...query } })
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-[1400px]">
    <BatchBar title="盤點總覽" subtitle="各任務單進度、已盤 / 未盤、差異。數量差異只列出，不自動調整庫存。" />

    <template v-if="currentBatch && data">
      <ShelfStatCards :stats="cards" />
      <ShelfStatCards :stats="cards2" />

      <div class="flex gap-2 flex-wrap mb-5">
        <button type="button" class="g-btn g-btn-teal !px-5" @click="go('zone-tasks')">任務單 · 分貨架</button>
        <button type="button" class="g-btn bg-white border border-gray-200 text-gray-700 !px-5" @click="go('zone-results', { filter: 'diff' })">看差異</button>
        <button type="button" class="g-btn bg-white border border-gray-200 text-gray-700 !px-5" @click="go('zone-results', { filter: 'uncounted' })">看未盤到的 SKU</button>
        <button type="button" class="g-btn bg-white border border-gray-200 text-gray-500 !px-5 ml-auto" :disabled="closing" @click="toggleBatch">
          {{ currentBatch.state === 'open' ? '結束批次' : '重開批次' }}
        </button>
      </div>

      <div class="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" :class="{ 'opacity-60': loading }">
          <div class="px-4 py-3 font-bold text-gray-800 border-b border-gray-100">各任務單</div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm border-collapse min-w-[640px]">
              <thead>
                <tr class="bg-[#EAF4F1] text-[#2F6B5F] text-xs">
                  <th class="text-left font-bold px-4 py-2.5">任務單</th>
                  <th class="text-left font-bold px-4 py-2.5">員工</th>
                  <th class="text-left font-bold px-4 py-2.5">貨架</th>
                  <th class="text-left font-bold px-4 py-2.5">狀態</th>
                  <th class="text-left font-bold px-4 py-2.5 w-40">進度</th>
                  <th class="text-right font-bold px-4 py-2.5">SKU / 件</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="t in data.tasks" :key="t.id" class="border-t border-gray-100 hover:bg-slate-50 cursor-pointer"
                    @click="go('zone-logs', { task: String(t.id) })">
                  <td class="px-4 py-2.5 font-bold whitespace-nowrap">{{ t.name }}</td>
                  <td class="px-4 py-2.5 whitespace-nowrap">{{ t.employee.name }}</td>
                  <td class="px-4 py-2.5 font-mono">{{ t.shelves.map(s => s.name).join('、') }}</td>
                  <td class="px-4 py-2.5"><span class="text-xs font-bold rounded-full px-2.5 py-1 whitespace-nowrap" :class="TASK_STATES[t.state]?.cls">{{ TASK_STATES[t.state]?.label }}</span></td>
                  <td class="px-4 py-2.5">
                    <div class="h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div class="h-full bg-teal" :style="{ width: `${t.shelves.length ? (t.shelf_done / t.shelves.length) * 100 : 0}%` }"></div>
                    </div>
                    <div class="text-xs text-gray-400 mt-1">{{ t.shelf_done }} / {{ t.shelves.length }} 貨架</div>
                  </td>
                  <td class="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{{ t.sku_count }} / {{ fmtQty(t.qty) }}</td>
                </tr>
                <tr v-if="!data.tasks.length">
                  <td colspan="6" class="px-4 py-8 text-center text-gray-400">還沒有任務單，到「任務單」開第一張。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div class="px-4 py-3 font-bold text-gray-800 border-b border-gray-100">各員工操作</div>
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="bg-[#EAF4F1] text-[#2F6B5F] text-xs">
                <th class="text-left font-bold px-4 py-2.5">員工</th>
                <th class="text-right font-bold px-4 py-2.5">錄入</th>
                <th class="text-right font-bold px-4 py-2.5">改數</th>
                <th class="text-right font-bold px-4 py-2.5">撤回</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in data.employees" :key="e.name" class="border-t border-gray-100">
                <td class="px-4 py-2.5">{{ e.name }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums">{{ e.records }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums" :class="e.changes ? 'text-amber-700 font-semibold' : 'text-gray-300'">{{ e.changes }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums" :class="e.undos ? 'text-amber-700 font-semibold' : 'text-gray-300'">{{ e.undos }}</td>
              </tr>
              <tr v-if="!data.employees.length">
                <td colspan="4" class="px-4 py-8 text-center text-gray-400">還沒有操作。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p class="text-xs lg:text-sm text-gray-400 mt-4 leading-relaxed">
        差異怎麼看：每張任務單寫回時，盤到的數量由「未上架」搬到貨架；未上架不夠搬 = <b>多出</b>（盤多了 / 系統少）。
        全部任務單寫回後，還留在「未上架」的 = <b>系統有、沒人找到</b>。盤點期間照常出貨不影響：出貨扣的是實際庫存。
        盤點期間新收的貨請先不要上架。
      </p>
    </template>
  </div>
</template>
