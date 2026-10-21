<script setup>
/**
 * 倉庫作業中心 · 貨架查詢
 *
 * 入口：从位置开始 —— 扫板或格子（也可输入名称）→ 这个位置连同所有下层位置上的商品
 * 查 T1板 会带出 T1板 本层、T1-1、T1-2 以及更下层；空位置也列出。
 *
 * 两种分组（同一批数据，像 Odoo 切换分组）：
 *   按位置：位置是分组，商品是明细 —— 站在货架前一格一格对
 *   按商品：商品是分组，它在本范围内的各位置是明细 —— 看同一 SKU 分散在几格
 * 标记：本板 N 處 = 同一商品在本板多个位置；他處 +X = 本范围以外同仓还有
 *
 * 第一期只读；连续上架等操作下一步再加。
 * URL 状态：?location_id=<id> 或 ?q=<条码/名称>
 */
import { computed, onActivated, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { shelf } from '@/api'
import { showToast } from '@/composables/useToast'
import ShelfGroupedTable from './ShelfGroupedTable.vue'
import ShelfMoveDialog from './ShelfMoveDialog.vue'
import ShelfStatCards from './ShelfStatCards.vue'
import { locationRowsByLocation, locationRowsBySku } from './shelfRows'

const route = useRoute()
const router = useRouter()

const query = ref('')
const loading = ref(false)
const error = ref(null)      // { msg, suggestions }
const result = ref(null)
const groupBy = ref('location')   // 'location' | 'sku'
const inputEl = ref(null)

const rows = computed(() => {
  if (!result.value) return []
  return groupBy.value === 'sku'
    ? locationRowsBySku(result.value.tree, result.value.products)
    : locationRowsByLocation(result.value.tree, result.value.products)
})

const stats = computed(() => {
  const sm = result.value?.summary
  if (!sm) return []
  return [
    { label: '合計在庫', value: sm.on_hand, unit: '件' },
    { label: 'SKU 數', value: sm.sku_count, unit: '個' },
    { label: '位置數', value: sm.location_count, unit: '個' },
    { label: '空位置', value: sm.empty_count, unit: '個', tone: 'muted' },
  ]
})

async function load({ q, locationId }) {
  if (!q && !locationId) return
  loading.value = true
  error.value = null
  try {
    result.value = await shelf.getLocationStock({ q, locationId })
    query.value = ''
  } catch (err) {
    result.value = null
    if (!err.handledByInterceptor) {
      const data = err.response?.data || {}
      const msgs = {
        location_not_found: `找不到「${q || locationId}」對應的位置`,
        location_ambiguous: `「${q}」對應多個位置，請選擇：`,
        missing_query: '請掃貨架條碼或輸入位置名稱',
      }
      error.value = { msg: msgs[data.error] || data.error || '查詢失敗', suggestions: data.suggestions || [] }
      if (!msgs[data.error]) showToast(error.value.msg, 'error')
    }
  } finally {
    loading.value = false
    focusInput()
  }
}

function focusInput() {
  setTimeout(() => inputEl.value?.focus(), 50)
}

function submit() {
  const q = query.value.trim()
  if (!q) return
  if (route.query.q === q && !route.query.location_id) load({ q })
  else router.replace({ query: { q } })
}

function openLocation(id) {
  if (String(route.query.location_id) === String(id)) load({ locationId: id })
  else router.replace({ query: { location_id: id } })
}

function openSku(sku) {
  const warehouse = result.value?.warehouse?.code
  router.push({ name: 'shelf-product', query: { q: sku, ...(warehouse ? { warehouse } : {}) } })
}

// 轉出弹窗：按位置 / 按商品两种分组的商品行都带 action（来源 = 商品所在位置）
const moving = ref(null)
function onRowAction(row) {
  if (row.action) moving.value = { ...row.action }
}
function onMoved() {
  moving.value = null
  load({ locationId: result.value.location.id })
}

watch(
  () => [route.name, route.query.q, route.query.location_id],
  ([name, q, locationId]) => {
    if (name !== 'shelf-location') return
    if (locationId) load({ locationId })
    else if (q) load({ q })
  },
  { immediate: true },
)

onActivated(focusInput)
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-[1400px]">
    <h2 class="text-lg sm:text-xl lg:text-2xl font-bold text-gray-800 mb-4 lg:mb-5">貨架查詢</h2>

    <form class="flex gap-2 sm:gap-3 mb-5" @submit.prevent="submit">
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        class="g-input flex-1 min-w-0 lg:!py-3"
        placeholder="掃貨架條碼或輸入位置名稱（如 T1板、T1-1），按 Enter 查詢"
        autocomplete="off"
        :disabled="loading"
      />
      <button type="submit" class="g-btn g-btn-teal !px-6 lg:!px-10" :disabled="loading || !query.trim()">查詢</button>
    </form>

    <!-- 查不到 / 多个候选 -->
    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 mb-5 text-sm">
      <p class="text-red-700 font-semibold">{{ error.msg }}</p>
      <ul v-if="error.suggestions.length" class="mt-2 space-y-1">
        <li v-for="s in error.suggestions" :key="s.id">
          <button type="button" class="text-[#2F6B5F] hover:underline" @click="openLocation(s.id)">{{ s.full_name }}</button>
          <span v-if="s.barcode" class="font-mono text-xs text-gray-400 ml-2">{{ s.barcode }}</span>
        </li>
      </ul>
    </div>

    <template v-if="result">
      <!-- 位置资讯 -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 lg:px-5 lg:py-4 mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <div class="text-base lg:text-lg font-bold text-gray-800">{{ result.location.full_name }}</div>
          <div v-if="result.location.barcode" class="font-mono text-xs lg:text-sm text-gray-500 mt-0.5">條碼 {{ result.location.barcode }}</div>
        </div>
        <span v-if="result.warehouse" class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-sm font-bold rounded-lg px-3 py-1">{{ result.warehouse.code }}</span>
      </div>

      <ShelfStatCards :stats="stats" />

      <!-- 分组方式 -->
      <div class="flex items-center justify-between gap-3 mb-2">
        <span class="text-xs lg:text-sm text-gray-500">分組方式</span>
        <div class="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm bg-white" role="group" aria-label="分組方式">
          <button
            type="button"
            class="px-4 py-1.5"
            :class="groupBy === 'location' ? 'bg-teal text-white font-semibold' : 'text-gray-600 hover:bg-gray-50'"
            @click="groupBy = 'location'"
          >按位置</button>
          <button
            type="button"
            class="px-4 py-1.5 border-l border-gray-200"
            :class="groupBy === 'sku' ? 'bg-teal text-white font-semibold' : 'text-gray-600 hover:bg-gray-50'"
            @click="groupBy = 'sku'"
          >按商品</button>
        </div>
      </div>

      <ShelfGroupedTable
        :rows="rows"
        :label-title="groupBy === 'sku' ? '商品 / 位置' : '位置 / 商品'"
        with-actions
        @open-location="openLocation"
        @open-sku="openSku"
        @row-action="onRowAction"
      />
      <p class="text-xs lg:text-sm text-gray-400 mt-3 leading-relaxed">
        位置數量為實際在庫，並非可用數量。
        <span class="text-violet-700">本板 N 處</span>：同一商品放在本板多個位置；
        <span class="text-gray-600">他處 +X</span>：本範圍以外同倉還有，點擊可查看該商品全部位置。
      </p>
    </template>

    <div v-else-if="!error && !loading" class="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500 leading-relaxed">
      掃板或格子條碼，查看上面有哪些商品、各有多少件。查板時會一併列出它下面所有格子。
    </div>
    <ShelfMoveDialog :move="moving" @close="moving = null" @done="onMoved" />
  </div>
</template>
