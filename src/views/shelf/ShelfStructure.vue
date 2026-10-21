<script setup>
/**
 * 倉庫作業中心 · 貨架結構（本板块首页）
 *
 * 一进来就看到整个仓（默认 HSD4）的货架层级：
 *   HSD4/庫存
 *     未上架（库存根库位本层）
 *     T1板
 *       T1-1 / T1-2 …
 *     T2板 …
 * 每个位置显示 下層位置数 / SKU 数 / 在庫 / 已預留；空位置标「空」。
 * 点位置名 → 貨架查詢看上面的商品明细。
 *
 * 只读。板 / 格子的新增、修改在 Odoo 后台（库存 → 配置 → 地点）。
 */
import { computed, onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import { shelf } from '@/api'
import { showToast } from '@/composables/useToast'
import ShelfGroupedTable from './ShelfGroupedTable.vue'
import ShelfStatCards from './ShelfStatCards.vue'
import { fmtQty, structureRows } from './shelfRows'

const router = useRouter()

const loading = ref(false)
const result = ref(null)
const rows = computed(() => structureRows(result.value?.tree))

const columns = [
  { key: 'sub', label: '下層位置', width: 'w-24', mobileHidden: true,
    value: r => (r.cells?.sub ? r.cells.sub : '—'), cls: r => (r.cells?.sub ? '' : 'text-gray-300') },
  { key: 'sku', label: 'SKU 數', width: 'w-20 lg:w-24', value: r => fmtQty(r.cells?.sku) },
  { key: 'on_hand', label: '在庫', width: 'w-20 lg:w-24', value: r => fmtQty(r.qty?.on_hand) },
  { key: 'reserved', label: '已預留', width: 'w-24', mobileHidden: true,
    value: r => fmtQty(r.qty?.reserved), cls: r => (r.qty?.reserved ? 'text-amber-600' : 'text-gray-300') },
]

const stats = computed(() => {
  const sm = result.value?.summary
  if (!sm) return []
  return [
    { label: '板 / 格子', value: sm.location_count, unit: '個' },
    { label: '已上架', value: sm.on_hand - sm.unshelved, unit: '件' },
    { label: '未上架', value: sm.unshelved, unit: `件 · ${sm.unshelved_sku_count} 個 SKU`, tone: sm.unshelved > 0 ? 'warn' : 'muted' },
    { label: '空位置', value: sm.empty_count, unit: '個', tone: 'muted' },
  ]
})

async function load() {
  loading.value = true
  try {
    result.value = await shelf.getStructure()
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error === 'warehouse_not_found' ? '找不到倉庫' : '載入貨架結構失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

// 每次进入都刷新一次：结构和数量在 Odoo 那边随时会变
onActivated(load)

function openLocation(id) {
  router.push({ name: 'shelf-location', query: { location_id: id } })
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-[1400px]">
    <div class="flex items-center justify-between gap-3 mb-4 lg:mb-5">
      <h2 class="text-lg sm:text-xl lg:text-2xl font-bold text-gray-800">貨架結構</h2>
      <button type="button" class="g-btn g-btn-teal !px-5 !py-2" :disabled="loading" @click="load">
        {{ loading ? '載入中…' : '重新整理' }}
      </button>
    </div>

    <template v-if="result">
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 lg:px-5 lg:py-4 mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <div class="text-base lg:text-lg font-bold text-gray-800">{{ result.tree.full_name }}</div>
          <div class="text-xs lg:text-sm text-gray-500 mt-0.5">{{ result.warehouse.name }} · 合計在庫 {{ fmtQty(result.summary.on_hand) }} 件</div>
        </div>
        <span class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-sm font-bold rounded-lg px-3 py-1">{{ result.warehouse.code }}</span>
      </div>

      <ShelfStatCards :stats="stats" />

      <div v-if="!result.tree.children.length" class="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500 leading-relaxed">
        {{ result.warehouse.code }} 還沒有建立任何板或格子。請在 Odoo「庫存 → 配置 → 地點」於 {{ result.tree.full_name }} 下新增。
      </div>
      <template v-else>
        <ShelfGroupedTable
          :rows="rows"
          :columns="columns"
          label-title="位置"
          action-label="查看貨架"
          @open-location="openLocation"
          @row-action="row => openLocation(row.locationId)"
        />
        <p class="text-xs lg:text-sm text-gray-400 mt-3 leading-relaxed">
          按「查看貨架」查看該位置上的商品；點分組可收合。板／格子的新增、修改請在 Odoo「庫存 → 配置 → 地點」。
        </p>
      </template>
    </template>

    <div v-else-if="loading" class="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500">載入中…</div>
  </div>
</template>
