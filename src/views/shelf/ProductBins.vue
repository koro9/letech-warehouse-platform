<script setup>
/**
 * 倉庫作業中心 / 智能查詢 · 商品位置（两个菜单入口，同一个页面）
 *
 * 入口：从 SKU 开始 —— 扫商品 → 看它在仓库存树里的分布（Odoo 式多层分组列表）
 *   HSD4/庫存（合计）
 *     未上架（库存根库位本层）
 *     T1板（合计）
 *       T1板（本層）
 *       T1-1   ▸ 批次
 *
 * 只列有这个 SKU 的分支；没货的板不出现，避免一面墙的空格子。
 * 第一期只读：上架 / 轉出 / 移除 等操作下一步再加。
 *
 * URL 状态：?q=<SKU>&warehouse=<code>，方便从貨架查詢跳过来、也能分享链接
 */
import { computed, onActivated, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { shelf } from '@/api'
import { showToast } from '@/composables/useToast'
import ShelfGroupedTable from './ShelfGroupedTable.vue'
import ShelfStatCards from './ShelfStatCards.vue'
import { productRows } from './shelfRows'

const route = useRoute()
const router = useRouter()
const PRODUCT_ROUTES = ['shelf-product', 'query-product']

const query = ref('')
const loading = ref(false)
const error = ref(null)      // { msg, suggestions }
const result = ref(null)
const rows = ref([])
const inputEl = ref(null)

async function load(q, warehouse) {
  q = (q || '').trim()
  if (!q) return
  loading.value = true
  error.value = null
  try {
    const res = await shelf.getProductBins(q, warehouse)
    result.value = res
    rows.value = productRows(res.tree)
    query.value = ''
  } catch (err) {
    result.value = null
    rows.value = []
    if (!err.handledByInterceptor) {
      const data = err.response?.data || {}
      const msgs = {
        product_not_found: `找不到「${q}」對應的商品`,
        warehouse_not_found: '找不到倉庫',
        missing_query: '請輸入 SKU 或掃條碼',
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

// 提交只改 URL，真正查询由下面的 watch 统一触发 —— 这样从别页跳进来也走同一条路
function submit(q = query.value) {
  q = (q || '').trim()
  if (!q) return
  const warehouse = result.value?.warehouse?.code || route.query.warehouse
  if (route.query.q === q) load(q, warehouse)
  else router.replace({ query: { q, ...(warehouse ? { warehouse } : {}) } })
}

watch(
  () => [route.name, route.query.q, route.query.warehouse],
  ([name, q, warehouse]) => {
    // 两个入口（倉庫作業中心 / 智能查詢）是同一个页面
    if (PRODUCT_ROUTES.includes(name) && q) load(q, warehouse)
  },
  { immediate: true },
)

onActivated(focusInput)

const stats = computed(() => {
  const sm = result.value?.summary
  if (!sm) return []
  return [
    { label: '在庫', value: sm.on_hand, unit: '件' },
    { label: '已預留', value: sm.reserved, unit: '件', tone: 'amber' },
    { label: '可轉', value: sm.available, unit: '件' },
    // 有未上架的货才高亮提醒；全部上架完就是普通卡片
    { label: '未上架', value: sm.unshelved, unit: '件', tone: sm.unshelved > 0 ? 'warn' : 'muted' },
  ]
})

function openLocation(id) {
  router.push({ name: 'shelf-location', query: { location_id: id } })
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-[1400px]">
    <h2 class="text-lg sm:text-xl lg:text-2xl font-bold text-gray-800 mb-4 lg:mb-5">商品位置</h2>

    <form class="flex gap-2 sm:gap-3 mb-5" @submit.prevent="submit()">
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        class="g-input flex-1 min-w-0 lg:!py-3"
        placeholder="掃商品條碼或輸入 SKU，按 Enter 查詢"
        autocomplete="off"
        :disabled="loading"
      />
      <button type="submit" class="g-btn g-btn-teal !px-6 lg:!px-10" :disabled="loading || !query.trim()">查詢</button>
    </form>

    <!-- 查不到 -->
    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 mb-5 text-sm">
      <p class="text-red-700 font-semibold">{{ error.msg }}</p>
      <div v-if="error.suggestions.length" class="mt-2">
        <p class="text-gray-600 mb-1">是不是要找：</p>
        <ul class="space-y-1">
          <li v-for="s in error.suggestions" :key="s.sku">
            <button type="button" class="font-mono text-[#2F6B5F] hover:underline" @click="submit(s.sku)">{{ s.sku }}</button>
            <span class="text-gray-600 ml-2">{{ s.name }}</span>
          </li>
        </ul>
      </div>
    </div>

    <template v-if="result">
      <!-- 商品资讯 -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 lg:px-5 lg:py-4 mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <div class="text-base lg:text-lg font-bold text-gray-800">{{ result.product.name }}</div>
          <div class="font-mono text-xs lg:text-sm text-gray-500 mt-0.5">
            {{ result.product.sku }}<template v-if="result.product.barcode"> · 條碼 {{ result.product.barcode }}</template>
          </div>
        </div>
        <span class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-sm font-bold rounded-lg px-3 py-1">{{ result.warehouse.code }}</span>
      </div>

      <ShelfStatCards :stats="stats" />

      <div v-if="!result.summary.on_hand && !result.summary.reserved"
           class="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500">
        此商品在 {{ result.warehouse.code }} 沒有庫存。
      </div>
      <ShelfGroupedTable
        v-else
        :rows="rows"
        label-title="位置"
        @open-location="openLocation"
      />
      <p class="text-xs lg:text-sm text-gray-400 mt-3">
        位置數量為實際在庫，並非可用數量。點分組可收合；點格子前的 ▸ 展開批次；點位置名稱可查看該位置上的所有商品。
      </p>
    </template>

    <div v-else-if="!error && !loading" class="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500 leading-relaxed">
      掃商品條碼或輸入 SKU，查看該商品在各板／格子的數量、批次和到期日。
    </div>
  </div>
</template>
