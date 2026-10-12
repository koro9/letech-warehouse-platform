<script setup>
import { ref, computed, onMounted } from 'vue'
import { stocktake } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'

// ── 狀態 ────────────────────────────────────────────────
const loading = ref(false)
const data = ref(null)              // kiosk_get_tasks 回傳
const zone = ref('')                // '' = 全部區
const showSkip = ref(false)         // 顯示「今日唔使點」
const counts = ref({})              // line_id -> 實點輸入(字串)
const lotChoice = ref({})           // line_id -> lot_id('' = 系統自動)
const busy = ref(null)              // 正在提交嘅 line_id
const ordersCache = ref({})         // line_id -> orders[] | 'loading'
const tomorrow = ref(null)          // 聽日預覽

const REASON_LABEL = {
  flag: '交主管未處理', moved: '確認後有郁過', changed: '確認後數量有變',
  new: '新跌到目標件數', recheck: '定期重點', skip: '今日唔使點', forced: '手動加入',
}

const lines = computed(() => data.value?.lines || [])
const zones = computed(() => data.value?.zones || [])
const funnel = computed(() => data.value?.funnel || { total: 0, due: 0, skip: 0, by_reason: {} })
const progress = computed(() => data.value?.progress || { ok: 0, moved: 0, flag: 0, todo: 0, units_moved: 0 })
const reasonChips = computed(() =>
  Object.entries(funnel.value.by_reason || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => ({ k, c, label: REASON_LABEL[k] || k })))

async function load() {
  loading.value = true
  try {
    const params = {}
    if (zone.value) params.zone = zone.value
    if (showSkip.value) params.include_skip = 1
    const res = await stocktake.getTasks(params)
    data.value = res
    for (const l of res.lines) {
      if (counts.value[l.id] === undefined) {
        counts.value[l.id] = l.counted_qty != null ? String(l.counted_qty) : ''
      }
      if (lotChoice.value[l.id] === undefined) lotChoice.value[l.id] = ''
    }
  } catch {
    showToast('載入失敗', 'error')
  } finally {
    loading.value = false
  }
}
usePageRefresh(load)
onMounted(load)

function selectZone(z) {
  zone.value = zone.value === z ? '' : z
  load()
}
function toggleSkip() {
  showSkip.value = !showSkip.value
  load()
}

// client-side 實點結果,同後端 _compute_count_result 口徑一致,純為即時按鈕顯示
function result(line) {
  const raw = counts.value[line.id]
  if (raw === '' || raw == null) return { k: 'none' }
  const c = Number(raw)
  if (Number.isNaN(c) || c < 0) return { k: 'none' }
  const oh = line.qty_on_hand, rs = line.qty_reserved
  if (Math.abs(c - oh) < 0.001) return { k: 'match' }
  if (c > oh) return { k: 'over' }
  if (c < rs - 0.001) return { k: 'lost_reserved' }
  return { k: 'short', move: Math.round((oh - c) * 100) / 100 }
}

function patchLine(line) {
  if (!line || !data.value) return
  const i = data.value.lines.findIndex(l => l.id === line.id)
  if (i >= 0) data.value.lines.splice(i, 1, line)
}

async function act(line, action) {
  const raw = counts.value[line.id]
  if (raw === '' || raw == null) { showToast('請先輸入實點數量', 'warning'); return }
  busy.value = line.id
  try {
    const payload = { line_id: line.id, action, counted_qty: Number(raw) }
    if (action === 'move' && lotChoice.value[line.id]) payload.lot_id = Number(lotChoice.value[line.id])
    const res = await stocktake.submit(payload)
    if (res.stale) {
      showToast(res.message, 'warning', 5000)
      patchLine(res.line)
      counts.value[line.id] = ''
      return
    }
    showToast(res.message || '已完成', 'success')
    patchLine(res.line)
    // 完成後把已點數量更新到重讀嘅 line(大部分情況清走,佢唔會再顯示操作)
    counts.value[line.id] = res.line?.counted_qty != null ? String(res.line.counted_qty) : ''
  } catch (e) {
    if (!e?.handledByInterceptor) {
      showToast(e?.response?.data?.message || '操作失敗', 'error')
    }
  } finally {
    busy.value = null
  }
}

async function doReset(line) {
  busy.value = line.id
  try {
    const res = await stocktake.reset(line.id)
    showToast(res.message || '已撤回', 'success')
    patchLine(res.line)
  } catch (e) {
    if (!e?.handledByInterceptor) showToast(e?.response?.data?.message || '撤回失敗', 'error')
  } finally {
    busy.value = null
  }
}

async function doForce(line) {
  busy.value = line.id
  try {
    const res = await stocktake.force(line.id)
    showToast(res.message || '已加入', 'success')
    patchLine(res.line)
  } catch (e) {
    if (!e?.handledByInterceptor) showToast(e?.response?.data?.message || '加入失敗', 'error')
  } finally {
    busy.value = null
  }
}

async function toggleOrders(line) {
  if (ordersCache.value[line.id] && ordersCache.value[line.id] !== 'closed') {
    ordersCache.value[line.id] = 'closed'
    return
  }
  ordersCache.value[line.id] = 'loading'
  try {
    const res = await stocktake.getOrders(line.id)
    ordersCache.value[line.id] = res.orders || []
  } catch {
    ordersCache.value[line.id] = []
    showToast('載入銷售單失敗', 'error')
  }
}

async function loadTomorrow() {
  try {
    tomorrow.value = await stocktake.previewTomorrow()
  } catch {
    showToast('預覽失敗', 'error')
  }
}

const STATE_STYLE = {
  todo: 'bg-amber-50 text-amber-700 border-amber-200',
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  moved: 'bg-violet-50 text-violet-700 border-violet-200',
  flag: 'bg-rose-50 text-rose-700 border-rose-200',
  resolved: 'bg-gray-100 text-gray-500 border-gray-200',
  skip: 'bg-gray-50 text-gray-400 border-gray-200',
  missed: 'bg-gray-100 text-gray-400 border-gray-200',
}
function n(v) { return v == null ? '' : v }
</script>

<template>
  <div class="p-3 md:p-5 max-w-3xl mx-auto">
    <!-- 標題 + 漏斗 -->
    <div class="flex items-center flex-wrap gap-2 mb-3">
      <h1 class="text-lg font-bold text-gray-800">每日盤點</h1>
      <span v-if="data" class="text-xs text-gray-500">{{ data.date }} · {{ data.source }} → {{ data.dest }} · 可用={{ data.target_available }}</span>
      <button class="ml-auto text-xs px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-600"
              @click="load">↻ 重新載入</button>
      <button class="text-xs px-3 py-1.5 rounded-lg border border-violet-200 bg-violet-50 hover:bg-violet-100 text-violet-700"
              @click="loadTomorrow">預覽聽日名單</button>
    </div>

    <!-- 進度 -->
    <div v-if="data" class="grid grid-cols-4 gap-2 mb-3">
      <div class="rounded-xl border border-gray-200 bg-white p-2 text-center">
        <div class="text-xl font-bold text-amber-600 num">{{ progress.todo }}</div>
        <div class="text-[11px] text-gray-500">未點</div>
      </div>
      <div class="rounded-xl border border-gray-200 bg-white p-2 text-center">
        <div class="text-xl font-bold text-emerald-600 num">{{ progress.ok }}</div>
        <div class="text-[11px] text-gray-500">已確認</div>
      </div>
      <div class="rounded-xl border border-gray-200 bg-white p-2 text-center">
        <div class="text-xl font-bold text-violet-600 num">{{ progress.moved }}</div>
        <div class="text-[11px] text-gray-500">已調走</div>
      </div>
      <div class="rounded-xl border border-gray-200 bg-white p-2 text-center">
        <div class="text-xl font-bold text-rose-600 num">{{ progress.flag }}</div>
        <div class="text-[11px] text-gray-500">交主管</div>
      </div>
    </div>

    <!-- 聽日預覽 -->
    <div v-if="tomorrow" class="mb-3 rounded-xl border border-violet-200 bg-violet-50 p-3 text-xs text-violet-800">
      聽日最少要點 <b class="num">{{ tomorrow.minimum }}</b> 個(今日未點 {{ tomorrow.todo_carry }} + 待主管 {{ tomorrow.flag_carry }} + 定期重點 {{ tomorrow.recheck_due }})·今日已清 {{ tomorrow.cleared_today }}
      <button class="ml-2 underline" @click="tomorrow = null">收起</button>
    </div>

    <!-- 分區 -->
    <div v-if="data" class="flex flex-wrap gap-1.5 mb-2">
      <button class="zone-chip" :class="zone === '' ? 'on' : ''" @click="selectZone('')">全部</button>
      <button v-for="z in zones" :key="z.key" class="zone-chip"
              :class="[zone === z.key ? 'on' : '', z.due && !z.todo ? 'clear' : '']"
              @click="selectZone(z.key)">
        {{ z.label }}
        <span class="ml-1 num text-[11px]" :class="z.todo ? 'text-rose-600 font-bold' : 'text-gray-400'">{{ z.todo }}/{{ z.due }}</span>
      </button>
      <button class="zone-chip ml-auto" :class="showSkip ? 'on' : ''" @click="toggleSkip">
        {{ showSkip ? '隱藏' : '顯示' }}唔使點 ({{ funnel.skip }})
      </button>
    </div>

    <!-- 原因漏斗 -->
    <div v-if="reasonChips.length" class="flex flex-wrap gap-1.5 mb-3 text-[11px]">
      <span v-for="r in reasonChips" :key="r.k" class="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
        {{ r.label }} <b class="num text-gray-700">{{ r.c }}</b>
      </span>
    </div>

    <!-- 載入中 / 空 -->
    <div v-if="loading" class="text-center text-gray-400 py-10 text-sm">載入中…</div>
    <div v-else-if="!lines.length" class="text-center text-gray-400 py-10 text-sm">冇需要點嘅 SKU 🎉</div>

    <!-- 任務卡 -->
    <div v-else class="space-y-2.5">
      <div v-for="l in lines" :key="l.id" class="rounded-2xl border border-gray-200 bg-white overflow-hidden shadow-sm">
        <div class="p-3">
          <!-- 頭:SKU + 名 + 狀態 -->
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono font-bold text-gray-800">{{ l.sku }}</span>
                <span class="text-[11px] px-1.5 py-0.5 rounded bg-teal/10 text-teal">{{ l.zone_label }}</span>
                <span v-if="l.forced" class="text-[11px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">手動加入</span>
              </div>
              <div class="text-xs text-gray-500 truncate">{{ l.name }}</div>
            </div>
            <span class="text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap" :class="STATE_STYLE[l.state]">{{ l.state_label }}</span>
          </div>

          <!-- 出單原因 -->
          <div class="mt-1.5 text-xs text-gray-600">
            {{ l.reason_text }}<span v-if="l.reason_detail" class="text-gray-400"> · {{ l.reason_detail }}</span>
          </div>
          <div v-if="l.last_move_info" class="text-[11px] text-gray-400">最後郁動:{{ l.last_move_info }}</div>

          <!-- 數量 -->
          <div class="mt-2 grid grid-cols-3 gap-2 text-center">
            <div class="rounded-lg bg-gray-50 py-1.5">
              <div class="num font-bold text-gray-800">{{ n(l.qty_on_hand) }}</div>
              <div class="text-[10px] text-gray-400">貨架應有</div>
            </div>
            <div class="rounded-lg bg-gray-50 py-1.5">
              <div class="num font-bold text-gray-800">{{ n(l.qty_reserved) }}</div>
              <div class="text-[10px] text-gray-400">預留未出</div>
            </div>
            <div class="rounded-lg bg-gray-50 py-1.5">
              <div class="num font-bold text-gray-800">{{ n(l.qty_available) }}</div>
              <div class="text-[10px] text-gray-400">可用</div>
            </div>
          </div>

          <!-- 批號 -->
          <div v-if="l.lots && l.lots.length" class="mt-2 text-[11px] text-gray-500">
            <span v-for="(lo, i) in l.lots" :key="i" class="inline-block mr-2">
              {{ lo.lot }}<span v-if="lo.expiration_date"> · 效期 {{ lo.expiration_date }}</span> · {{ n(lo.qty) }} 件
            </span>
          </div>

          <!-- 未點:實點輸入 + 動作 -->
          <template v-if="l.state === 'todo'">
            <div class="mt-3 flex items-center gap-2">
              <label class="text-xs text-gray-500 whitespace-nowrap">貨架實點</label>
              <input v-model="counts[l.id]" type="number" inputmode="decimal" min="0"
                     class="w-24 px-3 py-2 rounded-lg border border-gray-300 text-center font-mono focus:border-teal focus:outline-none"
                     placeholder="?" />
              <!-- 調走時嘅批號 -->
              <select v-if="result(l).k === 'short' && l.tracking !== 'none' && l.lots.length"
                      v-model="lotChoice[l.id]"
                      class="text-xs px-2 py-2 rounded-lg border border-gray-300 bg-white max-w-[9rem]">
                <option value="">系統自動(FEFO)</option>
                <option v-for="(lo, i) in l.lots.filter(x => x.lot)" :key="i" :value="lo.lot_id">
                  {{ lo.lot }}{{ lo.expiration_date ? ' · ' + lo.expiration_date : '' }}
                </option>
              </select>
            </div>

            <div class="mt-2.5 flex flex-wrap gap-2">
              <button v-if="result(l).k === 'match'" class="act-btn bg-emerald-600 hover:bg-emerald-700 text-white"
                      :disabled="busy === l.id" @click="act(l, 'confirm')">✓ 確認</button>
              <button v-else-if="result(l).k === 'short'" class="act-btn bg-violet-600 hover:bg-violet-700 text-white"
                      :disabled="busy === l.id" @click="act(l, 'move')">
                即時調走 {{ n(result(l).move) }} 件 → {{ data?.dest }}
              </button>
              <button v-else-if="result(l).k === 'over' || result(l).k === 'lost_reserved'"
                      class="act-btn bg-rose-600 hover:bg-rose-700 text-white"
                      :disabled="busy === l.id" @click="act(l, 'flag')">⚑ 交主管處理</button>
              <button v-else class="act-btn bg-gray-200 text-gray-400 cursor-not-allowed" disabled>✓ 確認</button>

              <button class="act-btn-ghost" @click="toggleOrders(l)">
                {{ ordersCache[l.id] && ordersCache[l.id] !== 'closed' ? '收起' : '未出貨單' }}
              </button>
              <button v-if="l.forced" class="act-btn-ghost" :disabled="busy === l.id" @click="doReset(l)">撤回</button>
            </div>
            <div v-if="result(l).k === 'over'" class="mt-1 text-[11px] text-rose-500">實點多過貨架應有,唔開單,交主管查。</div>
            <div v-else-if="result(l).k === 'lost_reserved'" class="mt-1 text-[11px] text-rose-500">實點少過預留,連答應客人嘅貨都唔見咗,交主管查。</div>
          </template>

          <!-- 已處理:顯示結果 + 撤回 -->
          <template v-else>
            <div class="mt-2 flex items-center gap-2 flex-wrap text-xs text-gray-500">
              <span v-if="l.state === 'moved'">已調走 {{ n(l.move_qty) }} 件 · {{ l.picking }}</span>
              <span v-else-if="l.state === 'flag'">⚑ {{ l.note }}</span>
              <span v-if="l.done_by">· {{ l.done_by }}</span>
              <span v-if="l.done_at" class="text-gray-400">· {{ l.done_at }}</span>
              <button v-if="(l.state === 'ok' || l.state === 'flag')" class="act-btn-ghost ml-auto"
                      :disabled="busy === l.id" @click="doReset(l)">撤回</button>
              <button v-if="l.state === 'skip' && l.reason === 'skip'" class="act-btn-ghost ml-auto"
                      :disabled="busy === l.id" @click="doForce(l)">照樣點</button>
            </div>
          </template>

          <!-- 未出貨銷售單 -->
          <div v-if="ordersCache[l.id] && ordersCache[l.id] !== 'closed'" class="mt-2 rounded-lg bg-gray-50 p-2 text-[11px]">
            <div v-if="ordersCache[l.id] === 'loading'" class="text-gray-400">載入中…</div>
            <div v-else-if="!ordersCache[l.id].length" class="text-gray-400">冇未出貨銷售單</div>
            <table v-else class="w-full">
              <thead class="text-gray-400">
                <tr><th class="text-left font-normal">訂單</th><th class="text-left font-normal">店舖</th>
                  <th class="text-right font-normal">未交</th><th class="text-right font-normal">已預留</th></tr>
              </thead>
              <tbody>
                <tr v-for="(o, i) in ordersCache[l.id]" :key="i" class="border-t border-gray-200">
                  <td class="py-0.5 font-mono">{{ o.order }}</td>
                  <td class="text-gray-500">{{ o.shop }}</td>
                  <td class="text-right num">{{ n(o.pending) }}</td>
                  <td class="text-right num">{{ n(o.reserved) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.zone-chip {
  border: 1px solid #e3e8ec; background: #fff; color: #6b7580;
  padding: 5px 10px; border-radius: 9px; font-weight: 600; font-size: 12px; white-space: nowrap;
}
.zone-chip.on { background: #6BAB9E; color: #fff; border-color: #6BAB9E; }
.zone-chip.clear { opacity: 0.55; }
.act-btn {
  padding: 9px 14px; border-radius: 10px; font-weight: 700; font-size: 14px; border: 0;
}
.act-btn:disabled { opacity: 0.55; }
.act-btn-ghost {
  padding: 9px 12px; border-radius: 10px; font-weight: 600; font-size: 13px;
  border: 1px solid #e3e8ec; background: #fff; color: #6b7580;
}
.act-btn-ghost:disabled { opacity: 0.5; }
</style>
