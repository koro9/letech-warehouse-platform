<script setup>
/**
 * 倉庫作業中心 · 未上架清單
 *
 * 列出库存根库位本层（= 还没放上任何板 / 格子）仍有在库的 SKU。
 * 主要给主管跟进上架进度：试点时切「已開始上架」只看已经上了一部分的那批 SKU，
 * 看它们还剩多少没上。
 *
 * 数据量大（HSD4 几千个 SKU）：后端分页（page / page_size，与运单列表同约定），
 * 搜索、筛选、排序都在后端做；前端每次切页 / 改条件都重新拉一页（替换不追加）。
 * URL 状态：?q= &scope= &sort= &page=，切走再回来、分享链接都能还原。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { shelf } from '@/api'
import { showToast } from '@/composables/useToast'
import ShelfStatCards from './ShelfStatCards.vue'
import { fmtQty } from './shelfRows'

const PAGE_SIZE = 50
const SCOPES = [
  { value: 'all', label: '全部' },
  { value: 'started', label: '已開始上架' },
]
const SORTS = [
  { value: 'qty_desc', label: '未上架數量 多 → 少' },
  { value: 'qty_asc', label: '未上架數量 少 → 多' },
  { value: 'sku', label: 'SKU' },
]

const route = useRoute()
const router = useRouter()

const query = ref('')
const loading = ref(false)
const result = ref(null)

// 当前条件全部来自 URL，页面只负责改 URL
const cond = computed(() => ({
  q: (route.query.q || '').toString(),
  scope: SCOPES.some(s => s.value === route.query.scope) ? route.query.scope : 'all',
  sort: SORTS.some(s => s.value === route.query.sort) ? route.query.sort : 'qty_desc',
  page: Math.max(1, parseInt(route.query.page, 10) || 1),
}))

const stats = computed(() => {
  const sm = result.value?.summary
  if (!sm) return []
  return [
    { label: '未上架', value: sm.unshelved_qty, unit: '件', tone: sm.unshelved_qty > 0 ? 'warn' : 'muted' },
    { label: '未上架 SKU', value: sm.unshelved_sku_count, unit: '個' },
    { label: '已上架', value: sm.shelved_qty, unit: '件' },
    { label: '已開始上架 SKU', value: sm.started_sku_count, unit: '個' },
  ]
})

const rangeText = computed(() => {
  const r = result.value
  if (!r?.total) return ''
  const from = (r.page - 1) * r.page_size + 1
  const to = from + r.products.length - 1
  return `第 ${from}–${to} 筆，共 ${r.total} 筆`
})

async function load() {
  loading.value = true
  try {
    const c = cond.value
    result.value = await shelf.getUnshelved({
      q: c.q, scope: c.scope, sort: c.sort, page: c.page, pageSize: PAGE_SIZE,
    })
    query.value = c.q
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error === 'warehouse_not_found' ? '找不到倉庫' : '載入未上架清單失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

function setCond(patch) {
  // 改搜索 / 筛选 / 排序都回到第 1 页；只翻页时保留其他条件
  const next = { ...cond.value, page: 1, ...patch }
  const q = {}
  if (next.q) q.q = next.q
  if (next.scope !== 'all') q.scope = next.scope
  if (next.sort !== 'qty_desc') q.sort = next.sort
  if (next.page > 1) q.page = String(next.page)
  router.replace({ query: q })
}

function submitSearch() {
  setCond({ q: query.value.trim() })
}

function clearSearch() {
  query.value = ''
  setCond({ q: '' })
}

function goPage(p) {
  const total = result.value?.total_pages || 0
  if (p < 1 || p > total || p === cond.value.page) return
  setCond({ page: p })
}

function openProduct(sku) {
  router.push({ name: 'shelf-product', query: { q: sku } })
}

// URL 一变就重新拉。从别的菜单切回来 fullPath 也会变，所以同样会刷新一次
// （上架在 Odoo 那边随时发生）；KeepAlive 停用期间 watch 仍在，不必再挂 onActivated
watch(() => route.fullPath, () => {
  if (route.name === 'shelf-unshelved') load()
}, { immediate: true })
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-[1400px]">
    <div class="flex items-center justify-between gap-3 mb-4 lg:mb-5">
      <h2 class="text-lg sm:text-xl lg:text-2xl font-bold text-gray-800">未上架清單</h2>
      <span v-if="result" class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-sm font-bold rounded-lg px-3 py-1">{{ result.warehouse.code }}</span>
    </div>

    <form class="flex gap-2 sm:gap-3 mb-4" @submit.prevent="submitSearch">
      <input
        v-model="query"
        type="text"
        class="g-input flex-1 min-w-0 lg:!py-3"
        placeholder="搜尋 SKU、商品名稱或條碼，按 Enter 查詢"
        autocomplete="off"
      />
      <button type="submit" class="g-btn g-btn-teal !px-6 lg:!px-10" :disabled="loading">查詢</button>
      <button
        v-if="cond.q"
        type="button"
        class="g-btn bg-white border border-gray-200 text-gray-600 !px-5"
        @click="clearSearch"
      >清除</button>
    </form>

    <ShelfStatCards v-if="result" :stats="stats" />

    <!-- 筛选 + 排序 -->
    <div class="flex items-center justify-between gap-3 flex-wrap mb-2">
      <div class="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm bg-white" role="group" aria-label="篩選">
        <button
          v-for="(s, i) in SCOPES"
          :key="s.value"
          type="button"
          class="px-4 py-1.5"
          :class="[
            i > 0 ? 'border-l border-gray-200' : '',
            cond.scope === s.value ? 'bg-teal text-white font-semibold' : 'text-gray-600 hover:bg-gray-50',
          ]"
          @click="setCond({ scope: s.value })"
        >{{ s.label }}</button>
      </div>
      <label class="flex items-center gap-2 text-sm text-gray-500">
        排序
        <select
          :value="cond.sort"
          class="border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700"
          @change="setCond({ sort: $event.target.value })"
        >
          <option v-for="s in SORTS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </label>
    </div>

    <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" :class="{ 'opacity-60': loading }">
      <div class="overflow-x-auto">
        <table class="w-full text-sm lg:text-[15px] border-collapse">
          <thead>
            <tr class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-[13px]">
              <th class="text-left font-bold px-4 py-3">SKU / 商品</th>
              <th class="text-right font-bold px-4 py-3 w-24">未上架</th>
              <th class="text-right font-bold px-4 py-3 w-24 hidden md:table-cell">已預留</th>
              <th class="text-right font-bold px-4 py-3 w-24 hidden md:table-cell">可轉</th>
              <th class="text-right font-bold px-4 py-3 w-24">已上架</th>
              <th class="text-right font-bold px-4 py-3 w-24 hidden sm:table-cell">合計在庫</th>
              <th class="text-left font-bold px-4 py-3 w-32 hidden lg:table-cell">最早到期</th>
              <th class="px-4 py-3 w-28"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in result?.products || []" :key="p.sku" class="border-t border-gray-100 hover:bg-slate-50">
              <td class="px-4 py-2.5">
                <div class="font-mono text-gray-800">{{ p.sku }}</div>
                <div class="text-xs lg:text-sm text-gray-500 mt-0.5">{{ p.name }}</div>
              </td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-amber-800">{{ fmtQty(p.unshelved) }}</td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums hidden md:table-cell"
                  :class="p.reserved ? 'text-amber-600' : 'text-gray-300'">{{ fmtQty(p.reserved) }}</td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums hidden md:table-cell">{{ fmtQty(p.available) }}</td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums"
                  :class="p.shelved ? 'text-emerald-700' : 'text-gray-300'">{{ fmtQty(p.shelved) }}</td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums hidden sm:table-cell">{{ fmtQty(p.total) }}</td>
              <td class="px-4 py-2.5 font-mono text-xs lg:text-[13px] text-gray-500 hidden lg:table-cell">{{ p.earliest_expiry || '—' }}</td>
              <td class="px-4 py-2 text-right">
                <button type="button" class="g-row-btn g-row-btn-teal whitespace-nowrap" @click="openProduct(p.sku)">查看位置 ›</button>
              </td>
            </tr>
            <tr v-if="result && !result.products.length">
              <td colspan="8" class="px-4 py-10 text-center text-gray-400">
                {{ cond.q || cond.scope !== 'all' ? '沒有符合條件的商品。' : '所有商品都已上架。' }}
              </td>
            </tr>
            <tr v-if="!result && loading">
              <td colspan="8" class="px-4 py-10 text-center text-gray-400">載入中…</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="result?.total" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 text-sm">
      <div class="text-gray-500">
        {{ rangeText }} · 第 <span class="text-gray-700 font-medium">{{ result.page }}</span> / {{ result.total_pages }} 頁
      </div>
      <div class="flex items-center gap-2">
        <button type="button" class="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40"
                :disabled="loading || result.page <= 1" @click="goPage(1)">第一頁</button>
        <button type="button" class="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40"
                :disabled="loading || result.page <= 1" @click="goPage(result.page - 1)">‹ 上一頁</button>
        <button type="button" class="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40"
                :disabled="loading || result.page >= result.total_pages" @click="goPage(result.page + 1)">下一頁 ›</button>
        <button type="button" class="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40"
                :disabled="loading || result.page >= result.total_pages" @click="goPage(result.total_pages)">最後一頁</button>
      </div>
    </div>

    <p class="text-xs lg:text-sm text-gray-400 mt-3 leading-relaxed">
      未上架 = 仍放在庫存本層、未放入任何板／格子的數量。上架請在 Odoo 操作；按「查看位置」看該商品目前的分佈。
    </p>
  </div>
</template>
