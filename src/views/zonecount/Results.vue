<script setup>
/**
 * 區域盤點 · 盤點結果（按 SKU）
 *
 * 每个 SKU：系统在手（仓库存树合计）、未上架剩余、已盘合计、差异（已盘 − 系统在手）、
 * 写回时多出、以及每个位置 × 到期日的数量和盘点人。
 * 筛选：有差异 / 多出 / 改了到期日 / 未上架还有 / 未盘到（仓里有货但本批次没人盘到）。
 * 汇出 Excel：按当前筛选拿全量（分页循环），生成 .xlsx。
 * URL 状态：?batch= &q= &filter= &page=
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { zonecount } from '@/api'
import { showToast } from '@/composables/useToast'
import BatchBar from './BatchBar.vue'
import ShelfStatCards from '@/views/shelf/ShelfStatCards.vue'
import { TASK_STATES, batchId, currentBatch, downloadXlsx, errText, fmtQty } from './zoneShared'

const PAGE_SIZE = 50
const FILTERS = [
  { value: 'all', label: '全部已盤' },
  { value: 'diff', label: '有差異' },
  { value: 'over', label: '多出' },
  { value: 'expiry', label: '改了到期日' },
  { value: 'unshelved', label: '未上架還有' },
  { value: 'uncounted', label: '未盤到' },
]

const route = useRoute()
const router = useRouter()
const query = ref('')
const loading = ref(false)
const result = ref(null)
const exporting = ref(false)

const cond = computed(() => ({
  q: (route.query.q || '').toString(),
  filter: FILTERS.some(f => f.value === route.query.filter) ? route.query.filter : 'all',
  page: Math.max(1, parseInt(route.query.page, 10) || 1),
}))

async function load() {
  if (!batchId.value) { result.value = null; return }
  loading.value = true
  try {
    const c = cond.value
    result.value = await zonecount.getResults({ batchId: batchId.value, q: c.q, filter: c.filter, page: c.page, pageSize: PAGE_SIZE })
    query.value = c.q
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '載入盤點結果失敗'), 'error')
  } finally {
    loading.value = false
  }
}

function setCond(patch) {
  const next = { ...cond.value, page: 1, ...patch }
  const q = { batch: batchId.value ? String(batchId.value) : undefined }
  if (next.q) q.q = next.q
  if (next.filter !== 'all') q.filter = next.filter
  if (next.page > 1) q.page = String(next.page)
  router.replace({ query: q })
}

function goPage(p) {
  const total = result.value?.total_pages || 0
  if (p < 1 || p > total || p === cond.value.page) return
  setCond({ page: p })
}

watch(() => [route.fullPath, batchId.value], () => {
  if (route.name === 'zone-results') load()
}, { immediate: true })

const stats = computed(() => {
  const s = result.value?.summary
  if (!s) return []
  return [
    { label: cond.value.filter === 'uncounted' ? '未盤到 SKU' : 'SKU', value: s.sku, unit: '個' },
    { label: '已盤合計', value: s.counted, unit: '件' },
    { label: '系統在手', value: s.on_hand, unit: '件', tone: 'muted' },
    { label: '多出（寫回時未上架不夠）', value: s.over, unit: '件', tone: s.over ? 'warn' : 'muted' },
  ]
})

const rangeText = computed(() => {
  const r = result.value
  if (!r?.total) return ''
  const from = (r.page - 1) * r.page_size + 1
  return `第 ${from}–${from + r.rows.length - 1} 筆，共 ${r.total} 筆`
})

function diffCls(d) {
  if (Math.abs(d) < 0.0001) return 'text-gray-300'
  return d > 0 ? 'text-emerald-700' : 'text-red-600'
}

function openProduct(sku) {
  router.push({ name: 'shelf-product', query: { q: sku } })
}

async function exportCsv() {
  exporting.value = true
  try {
    const c = cond.value
    const all = []
    for (let page = 1; ; page++) {
      const r = await zonecount.getResults({ batchId: batchId.value, q: c.q, filter: c.filter, page, pageSize: 2000 })
      all.push(...r.rows)
      if (!r.has_more) break
    }
    const rows = [['SKU', '商品', '條碼', '系統在手', '未上架', '已盤合計', '差異', '已寫回', '多出', '位置', '到期日', '數量', '新到期日', '任務單', '盤點人', '狀態']]
    for (const r of all) {
      const head = [r.sku, r.name, r.barcode, r.on_hand, r.unshelved, r.counted, r.diff, r.written, r.over]
      if (!r.locations?.length) rows.push([...head, '', '', '', '', '', '', ''])
      for (const l of r.locations || []) {
        rows.push([...head, l.location_full || l.location, l.expiry || '', l.qty, l.expiry_changed ? '是' : '', l.task, l.employee, TASK_STATES[l.state]?.label || l.state])
      }
    }
    const f = FILTERS.find(x => x.value === c.filter)?.label || ''
    await downloadXlsx(`區域盤點結果_${currentBatch.value?.name || ''}_${f}.xlsx`, rows, '盤點結果')
    showToast(`已匯出 ${all.length} 個 SKU`, 'success')
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '匯出失敗'), 'error')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-[1400px]">
    <BatchBar title="盤點結果" subtitle="按 SKU：已盤、系統在手、差異、位置、到期日、盤點人。數量差異只列出，不自動調整庫存。" />

    <template v-if="currentBatch">
      <form class="flex gap-2 sm:gap-3 mb-4" @submit.prevent="setCond({ q: query.trim() })">
        <input v-model="query" type="text" class="g-input flex-1 min-w-0 lg:!py-3" placeholder="搜尋 SKU、商品名稱或條碼，按 Enter 查詢" autocomplete="off" />
        <button type="submit" class="g-btn g-btn-teal !px-6 lg:!px-10" :disabled="loading">查詢</button>
        <button type="button" class="g-btn bg-white border border-gray-200 text-gray-700 !px-5" :disabled="exporting || !result?.total" @click="exportCsv">
          {{ exporting ? '匯出中…' : '匯出 Excel' }}
        </button>
      </form>

      <ShelfStatCards v-if="result" :stats="stats" />

      <div class="inline-flex flex-wrap rounded-lg border border-gray-200 overflow-hidden text-sm bg-white mb-2" role="group" aria-label="篩選">
        <button v-for="(f, i) in FILTERS" :key="f.value" type="button" class="px-4 py-1.5"
                :class="[i > 0 ? 'border-l border-gray-200' : '', cond.filter === f.value ? 'bg-teal text-white font-semibold' : 'text-gray-600 hover:bg-gray-50']"
                @click="setCond({ filter: f.value })">{{ f.label }}</button>
      </div>

      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" :class="{ 'opacity-60': loading }">
        <div class="overflow-x-auto">
          <table class="w-full text-sm lg:text-[15px] border-collapse min-w-[980px]">
            <thead>
              <tr class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-[13px]">
                <th class="text-left font-bold px-4 py-3">SKU / 商品</th>
                <th class="text-right font-bold px-4 py-3 w-24">系統在手</th>
                <th class="text-right font-bold px-4 py-3 w-24">未上架</th>
                <th class="text-right font-bold px-4 py-3 w-24">已盤合計</th>
                <th class="text-right font-bold px-4 py-3 w-20">差異</th>
                <th class="text-left font-bold px-4 py-3">位置 · 到期日 × 數量</th>
                <th class="text-left font-bold px-4 py-3 w-32">盤點人</th>
                <th class="px-4 py-3 w-28"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in result?.rows || []" :key="r.sku" class="border-t border-gray-100 hover:bg-slate-50 align-top">
                <td class="px-4 py-2.5">
                  <div class="font-mono text-gray-800">{{ r.sku }}</div>
                  <div class="text-xs lg:text-sm text-gray-500 mt-0.5">{{ r.name }}</div>
                </td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums">{{ fmtQty(r.on_hand) }}</td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums" :class="r.unshelved ? 'text-amber-800' : 'text-gray-300'">{{ fmtQty(r.unshelved) }}</td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">{{ fmtQty(r.counted) }}</td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold" :class="diffCls(r.diff)">
                  {{ r.diff > 0 ? '+' : '' }}{{ fmtQty(r.diff) }}
                  <div v-if="r.over" class="text-xs text-red-600 font-normal">多出 {{ fmtQty(r.over) }}</div>
                </td>
                <td class="px-4 py-2.5">
                  <div v-for="l in r.locations" :key="l.line_id" class="text-xs lg:text-sm font-mono whitespace-nowrap">
                    {{ l.location }}<span v-if="l.expiry" :class="l.expiry_changed ? 'text-amber-700' : 'text-gray-400'"> · {{ l.expiry }}{{ l.expiry_changed ? '（新）' : '' }}</span>
                    × <b>{{ fmtQty(l.qty) }}</b>
                    <span class="text-gray-400 font-sans ml-1.5">{{ l.task }}</span>
                    <span v-if="l.state !== 'done'" class="text-amber-700 font-sans">（未寫回）</span>
                  </div>
                  <span v-if="!r.locations.length" class="text-gray-300">—</span>
                </td>
                <td class="px-4 py-2.5 text-xs lg:text-sm text-gray-600">{{ [...new Set(r.locations.map(l => l.employee))].join('、') || '—' }}</td>
                <td class="px-4 py-2 text-right whitespace-nowrap">
                  <button type="button" class="g-row-btn g-row-btn-teal" @click="openProduct(r.sku)">查看位置 ›</button>
                </td>
              </tr>
              <tr v-if="result && !result.rows.length">
                <td colspan="8" class="px-4 py-10 text-center text-gray-400">{{ cond.q || cond.filter !== 'all' ? '沒有符合條件的商品。' : '還沒有盤點記錄。' }}</td>
              </tr>
              <tr v-if="!result && loading">
                <td colspan="8" class="px-4 py-10 text-center text-gray-400">載入中…</td>
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

      <p class="text-xs lg:text-sm text-gray-400 mt-3 leading-relaxed">
        差異 = 已盤合計 − 系統在手（盤點進行中時，還沒盤到的位置也算在系統在手裡，差異會偏負；全部寫回後才是最終結果）。
        多出 = 寫回時「未上架」不夠搬的件數。「未盤到」= 倉裡有貨但這個批次沒人盤到的 SKU。
      </p>
    </template>
  </div>
</template>
