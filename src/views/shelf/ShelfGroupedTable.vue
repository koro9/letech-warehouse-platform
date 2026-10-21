<script setup>
/**
 * 倉庫作業中心共用的 Odoo 式多层分组列表
 *
 * 输入：shelfRows.js 拍平后的 rows
 * 行为：
 *   - group 行点击 → 收合 / 展开它下面所有行
 *   - leaf 行若 collapsible（有批次）→ 点 ▸ 展开 sub 行，默认收起
 *   - 位置名可点 → emit('open-location', id)；SKU 标签「他處」可点 → emit('open-sku', sku)
 * 数字栏可通过 columns 自定义（货架结构页用 下層位置 / SKU 數）；默认是库存栏：
 *   在庫 / 已預留 / 可轉 / 最早到期，手机上隐藏「已預留」「最早到期」
 */
import { ref, watch } from 'vue'
import { STOCK_COLUMNS } from './shelfRows'

const props = defineProps({
  rows: { type: Array, required: true },
  labelTitle: { type: String, default: '位置' },
  columns: { type: Array, default: () => STOCK_COLUMNS },
  // 可选的行尾按钮（如货架结构的「查看」）：只对带位置的行显示，点了 emit('row-action', row)
  // 不传就没有这一栏，其他页面不受影响
  actionLabel: { type: String, default: '' },
})

function thClass(col) {
  return [col.align === 'left' ? 'text-left' : 'text-right', col.width || '', col.mobileHidden ? 'hidden sm:table-cell' : '']
}
function tdClass(col, row) {
  return [col.align === 'left' ? 'text-left' : 'text-right', col.mobileHidden ? 'hidden sm:table-cell' : '', col.cls ? col.cls(row) : '']
}
const emit = defineEmits(['open-location', 'open-sku', 'row-action'])

const collapsed = ref(new Set())

// rows 换了（新查询 / 切换分组）→ 重置收合状态：批次默认收起，分组默认展开
watch(() => props.rows, (rows) => {
  collapsed.value = new Set(rows.filter(r => r.startCollapsed).map(r => r.key))
}, { immediate: true })

function isVisible(row) {
  return !row.parents?.some(p => collapsed.value.has(p))
}

function toggle(row) {
  if (!row.collapsible) return
  const next = new Set(collapsed.value)
  next.has(row.key) ? next.delete(row.key) : next.add(row.key)
  collapsed.value = next
}

function caret(row) {
  if (!row.collapsible) return ''
  return collapsed.value.has(row.key) ? '▸' : '▾'
}

function indent(row) {
  // 每层缩进 20px；没有箭头的行补齐箭头宽度，文字对齐
  return { paddingLeft: `${16 + row.depth * 22 + (row.collapsible ? 0 : 24)}px` }
}
</script>

<template>
  <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-sm lg:text-[15px] border-collapse">
        <thead>
          <tr class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-[13px]">
            <th class="text-left font-bold px-4 py-3">{{ labelTitle }}</th>
            <th v-for="col in columns" :key="col.key" class="font-bold px-4 py-3" :class="thClass(col)">{{ col.label }}</th>
            <th v-if="actionLabel" class="px-4 py-3 w-24"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.key">
            <tr
              v-if="isVisible(row)"
              class="border-t border-gray-100"
              :class="{
                'bg-[#F7F9F8] font-semibold text-gray-800 cursor-pointer hover:bg-[#EEF4F2]': row.kind === 'group',
                'text-gray-700 hover:bg-slate-50': row.kind === 'leaf',
                'bg-white text-xs lg:text-[13px] text-gray-500': row.kind === 'sub',
                '!text-gray-400': row.muted,
              }"
              @click="row.kind === 'group' && toggle(row)"
            >
              <td class="py-2.5 pr-4" :style="indent(row)">
                <div class="flex items-center flex-wrap gap-x-2 gap-y-1">
                  <button
                    v-if="row.collapsible"
                    type="button"
                    class="w-4 text-gray-500 text-sm leading-none flex-shrink-0 hover:text-[#2F6B5F]"
                    :aria-label="collapsed.has(row.key) ? '展開' : '收合'"
                    @click.stop="toggle(row)"
                  >{{ caret(row) }}</button>

                  <button
                    v-if="row.locationId"
                    type="button"
                    class="text-left hover:text-[#2F6B5F] hover:underline underline-offset-2"
                    title="查看此位置上的所有商品"
                    @click.stop="emit('open-location', row.locationId)"
                  >{{ row.label }}</button>
                  <span v-else>{{ row.label }}</span>

                  <span v-if="row.mono" class="font-mono text-xs text-gray-400 font-normal">{{ row.mono }}</span>

                  <template v-for="tag in row.tags || []" :key="tag.text">
                    <button
                      v-if="tag.sku"
                      type="button"
                      class="text-[11px] lg:text-xs font-semibold px-2 py-px rounded-md whitespace-nowrap"
                      :class="tag.cls"
                      title="查看此商品的全部位置"
                      @click.stop="emit('open-sku', tag.sku)"
                    >{{ tag.text }}</button>
                    <span v-else class="text-[11px] lg:text-xs font-semibold px-2 py-px rounded-md whitespace-nowrap" :class="tag.cls">{{ tag.text }}</span>
                  </template>
                </div>
              </td>
              <td v-for="col in columns" :key="col.key" class="px-4 py-2.5 font-mono tabular-nums" :class="tdClass(col, row)">{{ col.value(row) }}</td>
              <td v-if="actionLabel" class="px-4 py-2 text-right">
                <button
                  v-if="row.locationId"
                  type="button"
                  class="g-row-btn g-row-btn-teal whitespace-nowrap"
                  @click.stop="emit('row-action', row)"
                >{{ actionLabel }} ›</button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
