<script setup>
/**
 * DraftManagement — 3PL Draft 管理
 *
 * 給 office staff 管理 3PL local draft TR 裏面的品項。
 * 主要用途：移除未到貨 / 有問題的品項。
 *
 * 列出所有 local_draft 狀態的 TR（含完整 groups_data），
 * 按 PO 分組展示，每個品項有「移除」按鈕。
 */
import { ref, computed, onActivated } from 'vue'
import { po as poApi } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import RefreshButton from '@/components/RefreshButton.vue'

const loading = ref(false)
const drafts = ref([])

// 展開狀態：key = tr.id
const expanded = ref(new Set())

// 移除操作
const removing = ref(null)           // po_line_id being removed
const confirmRemove = ref(null)      // { trId, trName, item } 待確認

async function fetchDrafts() {
  loading.value = true
  try {
    const data = await poApi.listDraftTransfers()
    drafts.value = data.drafts || []
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast('載入 Draft 列表失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

onActivated(() => fetchDrafts())

// Group by PO
const grouped = computed(() => {
  const map = new Map()
  for (const tr of drafts.value) {
    const key = tr.po_name
    if (!map.has(key)) {
      map.set(key, {
        po_name: tr.po_name,
        partner_name: tr.partner_name,
        transfers: [],
      })
    }
    map.get(key).transfers.push(tr)
  }
  return [...map.values()]
})

const totalItems = computed(() => {
  let count = 0
  for (const tr of drafts.value) {
    for (const g of (tr.groups_data || [])) {
      count += (g.items || []).length
    }
  }
  return count
})

function toggleExpand(trId) {
  if (expanded.value.has(trId)) {
    expanded.value.delete(trId)
  } else {
    expanded.value.add(trId)
  }
  // Force reactivity
  expanded.value = new Set(expanded.value)
}

function flatItems(tr) {
  const items = []
  for (const g of (tr.groups_data || [])) {
    for (const item of (g.items || [])) {
      items.push({
        ...item,
        groupName: g.displayName || g.sku || '',
        groupSku: g.displaySku || '',
      })
    }
  }
  return items
}

function askRemove(trId, trName, item) {
  confirmRemove.value = { trId, trName, item }
}

function cancelRemove() {
  confirmRemove.value = null
}

async function doRemove() {
  if (!confirmRemove.value || removing.value) return
  const { trId, item } = confirmRemove.value
  removing.value = item.po_line_id
  try {
    await poApi.removeDraftItem(trId, { po_line_id: item.po_line_id })
    showToast(`已移除 ${item.sku || item.name}`, 'success')
    confirmRemove.value = null
    await fetchDrafts()
  } catch (err) {
    if (!err.handledByInterceptor) {
      const data = err.response?.data || {}
      showToast(data.detail || data.error || '移除失敗', 'error')
    }
  } finally {
    removing.value = null
  }
}

const { isRefreshing, doRefresh } = usePageRefresh(fetchDrafts)
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-gray-800">3PL Draft 管理</h2>
      <RefreshButton :refreshing="isRefreshing" @click="doRefresh" />
    </div>

    <!-- Stats bar -->
    <div v-if="!loading && drafts.length > 0" class="flex gap-3 text-sm">
      <span class="px-3 py-1 rounded-full bg-purple-50 text-purple-700 font-medium">
        {{ drafts.length }} 張 Draft
      </span>
      <span class="px-3 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">
        {{ totalItems }} 個品項
      </span>
    </div>

    <!-- Loading -->
    <div v-if="loading && drafts.length === 0" class="text-center py-12 text-gray-400">
      載入中...
    </div>

    <!-- Empty state -->
    <div v-else-if="drafts.length === 0" class="text-center py-16 text-gray-400">
      <div class="text-4xl mb-3">📝</div>
      <p class="text-base">目前沒有 3PL Draft</p>
      <p class="text-xs mt-1">所有 3PL 分配已截單完成或尚未生成</p>
    </div>

    <!-- Grouped cards -->
    <div v-else class="space-y-4">
      <div
        v-for="group in grouped"
        :key="group.po_name"
        class="g-card"
      >
        <!-- PO header -->
        <div class="px-4 py-3 border-b border-gray-100 bg-purple-50/40">
          <div class="flex items-center justify-between">
            <span class="font-mono text-sm font-bold text-purple-700">{{ group.po_name }}</span>
            <span v-if="group.partner_name" class="text-xs text-gray-400">{{ group.partner_name }}</span>
          </div>
        </div>

        <!-- TR rows -->
        <div class="divide-y divide-gray-50">
          <div
            v-for="tr in group.transfers"
            :key="tr.id"
          >
            <!-- TR summary row -->
            <div
              class="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 active:bg-gray-100 transition-colors"
              @click="toggleExpand(tr.id)"
            >
              <span class="flex-shrink-0 text-lg">{{ expanded.has(tr.id) ? '▾' : '▸' }}</span>
              <span class="flex-shrink-0 w-20 text-center text-xs font-bold px-1.5 py-1 rounded bg-purple-50 text-purple-700">
                📝 {{ tr.name }}
              </span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-gray-700">→ {{ tr.dest_warehouse }}</span>
                  <span class="text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-purple-50 text-purple-700">
                    揀貨中
                  </span>
                </div>
                <div class="text-[11px] text-gray-400 mt-0.5">
                  {{ flatItems(tr).length }} 個品項 · {{ (tr.stats?.total_req || 0) }} 件
                </div>
              </div>
            </div>

            <!-- Expanded items -->
            <div v-if="expanded.has(tr.id)" class="bg-gray-50/60">
              <div
                v-for="item in flatItems(tr)"
                :key="`${tr.id}_${item.po_line_id}`"
                class="px-4 py-3 flex items-center gap-3 border-t border-gray-100"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-semibold text-gray-700">{{ item.sku }}</span>
                    <span
                      v-if="item.is_bom"
                      class="text-[10px] px-1.5 py-px rounded font-bold"
                      style="background:linear-gradient(90deg,#fed7aa,#fce7f3);color:#c2410c;"
                    >BOM</span>
                  </div>
                  <div class="text-xs text-gray-400 mt-0.5 truncate">{{ item.name }}</div>
                  <div class="flex gap-3 mt-1 text-[11px] text-gray-500">
                    <span>需求: <strong class="text-gray-700">{{ item.reqQty }}</strong></span>
                    <span>已揀: <strong :class="(parseInt(item.pickQty)||0) > 0 ? 'text-emerald-600' : 'text-gray-300'">{{ item.pickQty || 0 }}</strong></span>
                  </div>
                </div>
                <button
                  class="flex-shrink-0 px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors disabled:opacity-50"
                  style="border:1px solid #fca5a5;background:#fef2f2;color:#dc2626;"
                  :disabled="removing === item.po_line_id"
                  @click.stop="askRemove(tr.id, tr.name, item)"
                >{{ removing === item.po_line_id ? '...' : '移除' }}</button>
              </div>
              <div v-if="flatItems(tr).length === 0" class="px-4 py-6 text-center text-sm text-gray-400">
                此 Draft 沒有品項
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 移除確認 Modal -->
  <div v-if="confirmRemove" class="fixed inset-0 z-[200] flex items-center justify-center" @click.self="cancelRemove">
    <div class="absolute inset-0 bg-black/50" @click="cancelRemove"></div>
    <div class="relative w-full max-w-sm mx-4 bg-white rounded-2xl shadow-2xl overflow-hidden">
      <div class="px-5 pt-5 pb-3">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg" style="background:linear-gradient(135deg,#f87171,#dc2626);">🗑</div>
          <div>
            <h2 class="text-base font-bold text-gray-800">確認移除</h2>
            <p class="text-xs text-gray-400">Draft: {{ confirmRemove.trName }}</p>
          </div>
        </div>
        <div class="rounded-xl bg-red-50 border border-red-200 px-4 py-3 mb-3">
          <div class="text-sm font-bold text-gray-700">{{ confirmRemove.item.sku }}</div>
          <div class="text-xs text-gray-500 mt-0.5">{{ confirmRemove.item.name }}</div>
          <div class="text-xs text-gray-500 mt-1">需求: {{ confirmRemove.item.reqQty }}</div>
        </div>
        <p class="text-xs text-gray-500">移除後此品項將不再包含在此 Draft 的截單出貨中。</p>
      </div>
      <div class="px-5 py-4 border-t border-gray-100 flex gap-3">
        <button
          class="flex-1 py-2.5 bg-transparent rounded-xl font-bold text-sm cursor-pointer"
          style="border:2px solid #e2e8f0;color:#64748b;"
          :disabled="removing"
          @click="cancelRemove"
        >取消</button>
        <button
          class="flex-1 py-2.5 text-white border-0 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
          style="background:linear-gradient(90deg,#ef4444,#dc2626);"
          :disabled="removing"
          @click="doRemove"
        >{{ removing ? '移除中...' : '確認移除' }}</button>
      </div>
    </div>
  </div>
</template>
