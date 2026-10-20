<script setup>
/**
 * 貨架管理共用的 Odoo 式多层分组列表
 *
 * 输入：shelfRows.js 拍平后的 rows
 * 行为：
 *   - group 行点击 → 收合 / 展开它下面所有行
 *   - leaf 行若 collapsible（有批次）→ 点 ▸ 展开 sub 行，默认收起
 *   - 位置名可点 → emit('open-location', id)；SKU 标签「他處」可点 → emit('open-sku', sku)
 * 手机上隐藏「已預留」「最早到期」两栏，只留 位置/商品、在庫、可轉
 */
import { ref, watch } from 'vue'
import { fmtQty } from './shelfRows'

const props = defineProps({
  rows: { type: Array, required: true },
  labelTitle: { type: String, default: '位置' },
})
const emit = defineEmits(['open-location', 'open-sku'])

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
  return { paddingLeft: `${12 + row.depth * 20 + (row.collapsible ? 0 : 16)}px` }
}
</script>

<template>
  <div class="g-card overflow-x-auto">
    <table class="w-full text-sm border-collapse">
      <thead>
        <tr class="text-xs text-gray-500 bg-gray-50 border-b-2 border-gray-100">
          <th class="text-left font-bold px-3 py-2.5">{{ labelTitle }}</th>
          <th class="text-right font-bold px-3 py-2.5 w-16 sm:w-20">在庫</th>
          <th class="text-right font-bold px-3 py-2.5 w-20 hidden sm:table-cell">已預留</th>
          <th class="text-right font-bold px-3 py-2.5 w-16 sm:w-20">可轉</th>
          <th class="text-left font-bold px-3 py-2.5 w-28 hidden sm:table-cell">最早到期</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.key">
          <tr
            v-if="isVisible(row)"
            class="border-b border-gray-100"
            :class="{
              'bg-gray-50 font-semibold cursor-pointer hover:bg-gray-100': row.kind === 'group',
              'hover:bg-slate-50': row.kind === 'leaf',
              'bg-white text-xs text-gray-500': row.kind === 'sub',
              'text-gray-400': row.muted,
            }"
            @click="row.kind === 'group' && toggle(row)"
          >
            <td class="py-2 pr-3" :style="indent(row)">
              <div class="flex items-center flex-wrap gap-x-1.5 gap-y-1">
                <button
                  v-if="row.collapsible"
                  type="button"
                  class="w-4 text-gray-400 text-xs flex-shrink-0"
                  :aria-label="collapsed.has(row.key) ? '展開' : '收合'"
                  @click.stop="toggle(row)"
                >{{ caret(row) }}</button>

                <button
                  v-if="row.locationId"
                  type="button"
                  class="text-left hover:text-teal hover:underline"
                  title="查看此位置的貨"
                  @click.stop="emit('open-location', row.locationId)"
                >{{ row.label }}</button>
                <span v-else>{{ row.label }}</span>

                <span v-if="row.mono" class="font-mono text-xs text-gray-400">{{ row.mono }}</span>

                <template v-for="tag in row.tags || []" :key="tag.text">
                  <button
                    v-if="tag.sku"
                    type="button"
                    class="text-[11px] font-semibold px-1.5 rounded-md whitespace-nowrap leading-relaxed"
                    :class="tag.cls"
                    title="查看此商品的全部位置"
                    @click.stop="emit('open-sku', tag.sku)"
                  >{{ tag.text }}</button>
                  <span v-else class="text-[11px] font-semibold px-1.5 rounded-md whitespace-nowrap leading-relaxed" :class="tag.cls">{{ tag.text }}</span>
                </template>
              </div>
            </td>
            <td class="px-3 py-2 text-right font-mono tabular-nums">{{ fmtQty(row.qty?.on_hand) }}</td>
            <td class="px-3 py-2 text-right font-mono tabular-nums hidden sm:table-cell"
                :class="row.qty?.reserved ? 'text-amber-600' : 'text-gray-300'">{{ fmtQty(row.qty?.reserved) }}</td>
            <td class="px-3 py-2 text-right font-mono tabular-nums"
                :class="row.kind !== 'sub' && row.qty?.available > 0 ? 'text-emerald-600' : ''">{{ fmtQty(row.qty?.available) }}</td>
            <td class="px-3 py-2 font-mono text-xs hidden sm:table-cell text-gray-500">{{ row.expiry || '—' }}</td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
