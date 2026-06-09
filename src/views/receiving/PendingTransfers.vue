<script setup>
import { ref, computed, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { po as poApi } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import RefreshButton from '@/components/RefreshButton.vue'
import { printPickList } from '@/utils/labelRenderers'

const router = useRouter()

const loading = ref(false)
const transfers = ref([])
const printingId = ref(null)  // id or name of TR currently printing pick list

// 共用 Dashboard 的 localStorage 形容
const LS_KEY = 'wh_po_dashboard_local'
function loadLocalData() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}
function getDescription(poName) {
  const data = loadLocalData()
  return (data[poName] && data[poName].description) || ''
}

async function fetchList() {
  loading.value = true
  try {
    const data = await poApi.listPendingTransfers()
    transfers.value = data.transfers || []
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast('載入待揀 TR 失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

onActivated(() => fetchList())

// Group by PO (or '補貨' bucket for replenishment TRs without a PO)
const REPLEN_KEY = '__REPLENISHMENT__'
const grouped = computed(() => {
  const map = new Map()
  for (const tr of transfers.value) {
    const key = tr.po_name || REPLEN_KEY
    if (!map.has(key)) {
      map.set(key, {
        po_name:      key === REPLEN_KEY ? '' : tr.po_name,
        is_replenishment_group: key === REPLEN_KEY,
        partner_name: tr.partner_name,
        date_planned: tr.date_planned,
        transfers:    [],
      })
    }
    map.get(key).transfers.push(tr)
  }
  // Show replenishment group first
  const result = [...map.values()]
  result.sort((a, b) => (b.is_replenishment_group ? 1 : 0) - (a.is_replenishment_group ? 1 : 0))
  return result
})

async function goToTransfer(tr) {
  if (tr.is_replenishment) {
    // Replenishment TR — navigate with tr name so Transfer.vue can look it up
    router.push({ name: 'receiving-transfer', query: { tr: tr.name } })
  } else {
    router.push({ name: 'receiving-transfer', query: { po: tr.po_name } })
  }
}

async function printPickListForTR(tr) {
  const key = tr.id || tr.name
  printingId.value = key
  try {
    // Resolve actual id (virtual pickings need to be wrapped first)
    let trId = tr.id
    if (!trId && tr.is_virtual && tr.name) {
      const res = await poApi.lookupTransferByName(tr.name)
      trId = res.transfer?.id
      fetchList()  // refresh list so wrapper shows with real id
    }
    if (!trId) { showToast('找不到 TR', 'error'); return }
    // FEFO-split labels from backend
    const res = await poApi.getTransferPicklist(trId)
    const labels = res?.labels || []
    if (!labels.length) { showToast('此 TR 沒有品項可列印', 'warning'); return }
    printPickList(labels)
  } catch (e) {
    showToast('列印揀貨單失敗', 'error')
  } finally {
    printingId.value = null
  }
}

function progressPct(stats) {
  if (!stats || !stats.total_req) return 0
  return Math.round((stats.total_pick / stats.total_req) * 100)
}

function progressColor(pct) {
  if (pct === 0) return 'bg-red-400'
  if (pct >= 100) return 'bg-emerald-400'
  return 'bg-amber-400'
}

function stateLabel(state) {
  if (state === 'local_draft') return '揀貨中'
  if (state === 'in_progress') return '揀貨中'
  if (state === 'done') return '已完成'
  if (state === 'cut') return '已截單'
  if (state === 'draft') return '待完成'
  return '待揀貨'
}

function stateBadgeClass(state) {
  if (state === 'local_draft' || state === 'in_progress')
    return 'bg-purple-50 text-purple-700'
  if (state === 'draft')
    return 'bg-amber-50 text-amber-700'
  if (state === 'done')
    return 'bg-emerald-50 text-emerald-700'
  if (state === 'cut')
    return 'bg-orange-50 text-orange-700'
  return 'bg-gray-100 text-gray-500'
}

const { isRefreshing, doRefresh } = usePageRefresh(fetchList)
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-gray-800">TR 待揀總覽</h2>
      <RefreshButton :refreshing="isRefreshing" @click="doRefresh" />
    </div>

    <!-- Stats bar -->
    <div v-if="!loading && transfers.length > 0" class="flex gap-3 text-sm">
      <span class="px-3 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">
        {{ grouped.length }} 個 PO
      </span>
      <span class="px-3 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">
        {{ transfers.length }} 張 TR
      </span>
    </div>

    <!-- Loading -->
    <div v-if="loading && transfers.length === 0" class="text-center py-12 text-gray-400">
      載入中…
    </div>

    <!-- Empty state -->
    <div v-else-if="transfers.length === 0" class="text-center py-16 text-gray-400">
      <div class="text-4xl mb-3">✅</div>
      <p class="text-base">所有 Transfer Order 已完成</p>
      <p class="text-xs mt-1">暫無待揀貨的 TR</p>
    </div>

    <!-- Grouped cards -->
    <div v-else class="space-y-4">
      <div
        v-for="group in grouped"
        :key="group.po_name || '__replen'"
        class="g-card"
        :class="group.is_replenishment_group ? 'border border-teal-200' : ''"
      >
        <!-- PO / Replenishment header -->
        <div
          class="px-4 py-3 border-b"
          :class="group.is_replenishment_group
            ? 'border-teal-100 bg-teal-50'
            : 'border-gray-100'"
        >
          <div class="flex items-center justify-between">
            <span
              class="font-mono text-sm font-bold"
              :class="group.is_replenishment_group ? 'text-teal-700' : 'text-teal-700'"
            >
              <span v-if="group.is_replenishment_group">🔄 補貨 Transfer</span>
              <span v-else>{{ group.po_name }}</span>
            </span>
            <span v-if="group.date_planned" class="text-xs text-gray-400">
              ETA {{ group.date_planned }}
            </span>
          </div>
          <div v-if="!group.is_replenishment_group && getDescription(group.po_name)" class="text-xs text-gray-500 mt-0.5 truncate">
            {{ getDescription(group.po_name) }}
          </div>
          <div v-if="group.is_replenishment_group" class="text-xs text-teal-600 mt-0.5">
            非 PO 補貨單，直接由 Odoo 調撥
          </div>
        </div>

        <!-- TR rows -->
        <div class="divide-y divide-gray-50">
          <div
            v-for="tr in group.transfers"
            :key="tr.id || tr.name"
            class="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 active:bg-gray-100 transition-colors"
            :class="[
              tr.is_replenishment ? 'border-l-4 border-teal-400' :
              tr.highlight       ? 'border-l-4 border-amber-400' : ''
            ]"
            @click="goToTransfer(tr)"
          >
            <!-- Dest badge -->
            <span
              class="flex-shrink-0 w-12 text-center text-xs font-bold px-1.5 py-1 rounded"
              :class="tr.is_replenishment ? 'bg-teal-50 text-teal-700'
                    : tr.highlight       ? 'bg-amber-50 text-amber-700'
                    : 'bg-blue-50 text-blue-700'"
            >
              {{ tr.dest_warehouse }}
            </span>

            <!-- Info + progress -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-medium text-gray-700">{{ tr.is_local_draft ? '📝' : '' }} {{ tr.name }}</span>
                <span
                  v-if="tr.is_replenishment"
                  class="text-[10px] px-1.5 py-px rounded-full font-bold bg-teal-50 text-teal-700 border border-teal-200"
                >補貨</span>
                <span
                  v-else-if="tr.parent_ref"
                  class="text-[10px] px-1.5 py-px rounded-full font-bold bg-purple-50 text-purple-700 border border-purple-200"
                >Ref: {{ tr.parent_ref }}</span>
                <span class="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                  :class="stateBadgeClass(tr.state)"
                >{{ stateLabel(tr.state) }}</span>
              </div>
              <!-- Progress bar -->
              <div class="mt-1.5 flex items-center gap-2">
                <div class="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all"
                    :class="progressColor(progressPct(tr.stats))"
                    :style="{ width: progressPct(tr.stats) + '%' }"
                  ></div>
                </div>
                <span class="text-[11px] text-gray-400 font-mono whitespace-nowrap">
                  {{ tr.stats?.total_pick || 0 }}/{{ tr.stats?.total_req || 0 }}
                </span>
              </div>
            </div>

            <!-- Print pick list button (3PL only) -->
            <button
              v-if="tr.dest_warehouse === '3PL'"
              class="flex-shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border cursor-pointer"
              style="background:#f0fdf4;color:#059669;border-color:#bbf7d0;"
              :disabled="printingId === (tr.id || tr.name)"
              @click.stop="printPickListForTR(tr)"
              title="列印揀貨單 (100×150mm)"
            >{{ printingId === (tr.id || tr.name) ? '…' : '🖨️ 揀貨單' }}</button>

            <!-- Arrow -->
            <svg class="w-4 h-4 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
