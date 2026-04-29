<script setup>
/**
 * PO 點貨 (M3a) — 复刻 demo s3-m-counting
 *
 * 三态：
 *   1. 没有 curPO     → PO 输入页
 *   2. 有 curPO 没 curSKU → SKU 列表页（带条码扫描入口）
 *   3. 有 curSKU      → SKU 详情页（每仓库 × 每效期 数量录入 + Remarks 处理）
 *
 * Demo 规则：
 *   - 每个 SKU 默认无效期（dates: []），用 entries[''] 单值；
 *     新增第一个日期时把 '' 的值迁移到这个日期下；继续加日期则累计 entries[date]=0
 *   - 移除最后一个日期则把当前数量退回 entries['']
 *   - Combo 类型 alloc：实际要拿的数量 = whSum × multiplier
 *   - Remarks 处理：要求录入操作员姓名 + 时间戳
 *   - 扫码：barcode 命中即跳转该 SKU 详情
 */
import { computed, nextTick, reactive, ref } from 'vue'
import { showToast } from '@/composables/useToast'

const WH = ['3PL', 'WS', 'SD4']
const WH_COLOR = { '3PL': '#4A90D9', 'WS': '#E6A23C', 'SD4': '#67C23A' }

// Demo PO mock — 跟 demo 一比一
const poDb = {
  '12345': {
    po: '12345',
    items: [
      { sku: 'LT10001234', barcode: '4710001334001', name: '有機燕麥片 500g',  perBox: 10, remarks: '新貨',
        allocs: [{ id: 'LT10001234-s', type: 'single', label: '有機燕麥片 500g', warehouses: { '3PL': 100, 'WS': 60, 'SD4': 40 } }] },
      { sku: 'LT10001200', barcode: '4710001000002', name: '純天然蜂蜜 250ml', perBox: 12, remarks: 'Check',
        allocs: [
          { id: 'LT10001200-s', type: 'single', label: '純天然蜂蜜 250ml', warehouses: { '3PL': 50, 'WS': 30, 'SD4': 20 } },
          { id: 'LT10001200A',  type: 'combo',  label: 'LT10001200A', mult: 2, warehouses: { '3PL': 40 } },
        ] },
      { sku: 'LT10001206', barcode: '4710002006003', name: '日式抹茶粉 100g', perBox: 10, remarks: '',
        allocs: [{ id: 'LT10001206-s', type: 'single', label: '日式抹茶粉 100g', warehouses: { '3PL': 80, 'WS': 70, 'SD4': 50 } }] },
      { sku: 'LT10001250', barcode: '4710003050004', name: '椰子水 330ml',     perBox: 24, remarks: '',
        allocs: [{ id: 'LT10001250-s', type: 'single', label: '椰子水 330ml',  warehouses: { '3PL': 240, 'WS': 120, 'SD4': 120 } }] },
      { sku: 'LT10001210', barcode: '4710005010005', name: '綜合堅果 200g',   perBox: 10, remarks: '',
        allocs: [
          { id: 'LT10001210-s', type: 'single', label: '綜合堅果 200g', warehouses: { '3PL': 60, 'WS': 36, 'SD4': 24 } },
          { id: 'LT10001210A',  type: 'combo',  label: 'LT10001210A', mult: 3, warehouses: { '3PL': 30 } },
        ] },
    ],
  },
}

// ========== 状态 ==========
const poInput = ref('12345')
const curPO = ref(null)
const curSKU = ref(null)

// 每 SKU 的录入状态：{ dates: [], a: { [allocId]: { [wh]: { [dateKey]: qty } } } }
const pk = reactive({})
// 每 SKU 的 remarks 处理状态：{ handled, by, time }
const remarksStatus = reactive({})
// 每 SKU 是否展开"加日期"输入
const showDI = reactive({})
// 每 alloc 的 combo 横幅是否展开
const comboExpanded = reactive({})

const newDate = ref('')
const newDateEl = ref(null)

const bcInput = ref('')

// Remarks 弹窗
const rkOpen = ref(false)
const rkName = ref('')
const rkNameEl = ref(null)

// 扫码相机弹窗（视觉占位 — 真机相机能力放后续 PWA 阶段）
const scannerOpen = ref(false)

// ========== 计算 ==========
const curItem = computed(() =>
  curPO.value && curSKU.value ? curPO.value.items.find(i => i.sku === curSKU.value) : null,
)
const curPk = computed(() => curSKU.value ? pk[curSKU.value] : null)
const hasDates = computed(() => (curPk.value?.dates.length || 0) > 0)

// 用于 SKU 详情的统计
const detailStats = computed(() => {
  const it = curItem.value
  if (!it) return null
  const tu = itemUnits(it)
  return { tu, tb: Math.floor(tu / it.perBox), br: tu % it.perBox }
})

// ========== 工具 ==========
function whSum(alloc) { return WH.reduce((s, w) => s + (alloc.warehouses[w] || 0), 0) }

function whQty(sku, allocId, wh) {
  const e = pk[sku]?.a?.[allocId]?.[wh]
  if (!e) return 0
  return Object.values(e).reduce((s, v) => s + (parseInt(v) || 0), 0)
}

function whPk(sku, allocId) {
  return WH.reduce((s, w) => s + whQty(sku, allocId, w), 0)
}

function itemUnits(it) {
  return it.allocs.reduce((s, a) => s + whSum(a) * (a.type === 'combo' ? a.mult : 1), 0)
}

function itemPkU(it) {
  return it.allocs.reduce((s, a) => s + whPk(it.sku, a.id) * (a.type === 'combo' ? a.mult : 1), 0)
}

function fmtDate(d) { return `${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}` }

function fmtTime(d) {
  const h = d.getHours(), m = d.getMinutes()
  return `${h<10?'0':''}${h}:${m<10?'0':''}${m}`
}

function statusOfItem(it) {
  const tu = itemUnits(it), pu = itemPkU(it)
  if (pu === 0) return { label: '待點貨', cls: 'text-amber-600 bg-amber-50' }
  if (pu >= tu) return { label: '已完成', cls: 'text-green-600 bg-green-50' }
  return { label: '進行中', cls: 'text-amber-600 bg-amber-50' }
}

// ========== 加载 PO ==========
function loadPO() {
  const v = poInput.value.trim()
  if (!v) { showToast('請輸入PO', 'warning'); return }
  const p = poDb[v]
  if (!p) { showToast('找不到', 'error'); return }
  curPO.value = p
  // 初始化 pk 结构（如尚未初始化）
  p.items.forEach(it => {
    if (!pk[it.sku]) {
      pk[it.sku] = { dates: [], a: {} }
      it.allocs.forEach(al => {
        pk[it.sku].a[al.id] = {}
        WH.forEach(w => {
          if ((al.warehouses[w] || 0) > 0) {
            pk[it.sku].a[al.id][w] = { '': 0 }
          }
        })
      })
    }
    if (it.remarks && !remarksStatus[it.sku]) {
      remarksStatus[it.sku] = { handled: false, by: '', time: '' }
    }
  })
}

function backToPO()   { curPO.value = null; curSKU.value = null }
function backToList() { curSKU.value = null }

function openSKU(sku) {
  curSKU.value = sku
  if (typeof showDI[sku] === 'undefined') showDI[sku] = false
}

// ========== 扫码 ==========
function scanBC() {
  const v = bcInput.value.trim()
  if (!v || !curPO.value) return
  const f = curPO.value.items.find(it => it.barcode === v)
  if (f) {
    bcInput.value = ''
    showToast(`✅ ${f.name}`, 'success')
    setTimeout(() => { curSKU.value = f.sku }, 350)
  } else {
    showToast('❌ 找不到', 'error')
  }
}

function openScanner()  { scannerOpen.value = true }
function closeScanner() { scannerOpen.value = false }

// ========== 日期 ==========
function toggleDateInput() {
  const sku = curSKU.value
  showDI[sku] = !showDI[sku]
  if (showDI[sku]) nextTick(() => newDateEl.value?.focus())
}

function addDate() {
  const v = newDate.value.replace(/[^0-9]/g, '')
  if (v.length !== 8) { showToast('⚠️ 請輸入8位日期', 'warning'); return }
  const sku = curSKU.value
  const d = pk[sku]
  if (d.dates.includes(v)) { showToast('⚠️ 已存在', 'warning'); return }
  const isFirst = d.dates.length === 0
  d.dates.push(v)
  curItem.value.allocs.forEach(al => {
    WH.forEach(w => {
      const entries = d.a[al.id]?.[w]
      if (!entries) return
      if (isFirst) {
        const old = entries[''] || 0
        delete entries['']
        entries[v] = old
      } else {
        entries[v] = 0
      }
    })
  })
  newDate.value = ''
  showDI[sku] = false
  showToast(`✅ 已新增 ${fmtDate(v)}`, 'success')
}

function removeDate(idx) {
  const sku = curSKU.value
  const d = pk[sku]
  const removed = d.dates.splice(idx, 1)[0]
  curItem.value.allocs.forEach(al => {
    WH.forEach(w => {
      const entries = d.a[al.id]?.[w]
      if (!entries) return
      const removedQty = entries[removed] || 0
      delete entries[removed]
      if (d.dates.length === 0) entries[''] = removedQty
    })
  })
}

// ========== Combo 横幅 ==========
function toggleCombo(allocId) {
  comboExpanded[allocId] = !comboExpanded[allocId]
}

// ========== Remarks 弹窗 ==========
function openRkModal() {
  rkName.value = ''
  rkOpen.value = true
  nextTick(() => rkNameEl.value?.focus())
}
function closeRkModal() { rkOpen.value = false }
function confirmRemark() {
  const name = rkName.value.trim()
  if (!name) { showToast('⚠️ 請輸入姓名', 'warning'); return }
  remarksStatus[curSKU.value] = { handled: true, by: name, time: fmtTime(new Date()) }
  rkOpen.value = false
  showToast('✅ 已標記', 'success')
}
function undoRemark() {
  remarksStatus[curSKU.value] = { handled: false, by: '', time: '' }
  showToast('↩️ 已撤銷', 'success')
}

// ========== 保存 ==========
function saveDetail() {
  showToast('✅ 已儲存', 'success')
  setTimeout(() => { curSKU.value = null }, 600)
}

// ========== 单元格状态 ==========
function inputClass(qty, req) {
  if (!qty) return ''
  return qty === req ? 'iok' : 'ibad'
}

function whTotalDisplay(allocId, wh, req) {
  const v = whQty(curSKU.value, allocId, wh)
  let cls = ''
  if (v > 0) {
    if (v === req) cls = 'text-green-600 bg-green-50'
    else if (v > req) cls = 'text-red-600 bg-red-50'
    else cls = 'text-amber-600 bg-amber-50'
  }
  return { value: `${v}/${req}`, cls }
}

function allocRemaining(it, alloc) {
  const aT = whSum(alloc)
  const aP = whPk(it.sku, alloc.id)
  const aR = aT - aP
  let cls = 'text-amber-600'
  if (aR === 0) cls = 'text-green-600'
  else if (aR < 0) cls = 'text-red-600'
  return { remaining: aR, cls }
}
</script>

<template>
  <!-- ===== 状态 1：PO 输入 ===== -->
  <div v-if="!curPO" class="m3a flex flex-col justify-center items-center h-full p-10">
    <div class="text-5xl mb-3">📦</div>
    <h2 class="text-xl font-extrabold mb-6">PO 點貨系統</h2>
    <div class="w-full max-w-sm">
      <input
        v-model="poInput"
        @keydown.enter="loadPO"
        class="g-input w-full mb-3 text-center font-bold"
        style="font-size:18px;"
        placeholder="PO Number"
      />
      <button class="g-btn g-btn-teal w-full" style="padding:14px;" @click="loadPO">
        載入 PO
      </button>
    </div>
    <div class="text-center mt-4 text-xs text-gray-300">Demo — 輸入 12345</div>
  </div>

  <!-- ===== 状态 2：SKU 清单 ===== -->
  <div v-else-if="!curSKU" class="m3a p-4 overflow-y-auto h-full">
    <div class="hdr">
      <button class="hdr-back" @click="backToPO">‹</button>
      <h1>SKU 清單</h1>
    </div>
    <div class="flex justify-between mb-2 text-xs text-gray-500 font-semibold">
      <span>PO: {{ curPO.po }}</span>
      <span>共 {{ curPO.items.length }} 項</span>
    </div>

    <!-- 扫码区 -->
    <div class="bc-section">
      <div class="text-xs font-bold mb-2" style="color:#4A90D9;">📱 掃描條碼</div>
      <div class="flex gap-2">
        <div class="flex-1 relative">
          <input
            v-model="bcInput"
            @keydown.enter="scanBC"
            class="g-input w-full font-mono"
            style="padding-right:40px;"
            placeholder="Barcode..."
          />
          <button
            class="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 border-0 rounded-lg flex items-center justify-center cursor-pointer"
            style="background:#EBF5FB;color:#4A90D9;"
            title="相機掃碼"
            @click="openScanner"
          >📷</button>
        </div>
        <button class="g-btn g-btn-teal" style="padding:10px 16px;" @click="scanBC">查詢</button>
      </div>
    </div>

    <!-- 商品清单 -->
    <div
      v-for="it in curPO.items"
      :key="it.sku"
      class="sku-item"
      @click="openSKU(it.sku)"
    >
      <div>
        <div class="font-bold text-[15px]">
          {{ it.name }}
          <span
            v-if="it.allocs.some(a => a.type === 'combo')"
            class="inline-block text-[10px] font-extrabold px-2 py-0.5 rounded-xl ml-1"
            style="background:#EDE7F6;color:#7C4DFF;"
          >📦 含COMBO</span>
        </div>
        <div class="text-xs text-gray-400 mt-0.5 flex gap-1.5 flex-wrap">
          <span class="bg-gray-100 px-1.5 py-px rounded">SKU: {{ it.sku }}</span>
          <span class="bg-gray-100 px-1.5 py-px rounded">箱入: {{ it.perBox }}</span>
          <span class="bg-gray-100 px-1.5 py-px rounded">共 {{ itemUnits(it) }} 件</span>
        </div>
      </div>
      <div class="text-right shrink-0 ml-3">
        <span class="m3a-tag" :class="statusOfItem(it).cls">{{ statusOfItem(it).label }}</span>
        <div class="text-xs text-gray-300 mt-0.5">{{ itemPkU(it) }}/{{ itemUnits(it) }}</div>
      </div>
    </div>
  </div>

  <!-- ===== 状态 3：SKU 详情 ===== -->
  <div v-else class="m3a p-4 overflow-y-auto h-full relative">
    <div class="hdr">
      <button class="hdr-back" @click="backToList">‹</button>
      <h1>{{ curItem.name }}</h1>
    </div>
    <div class="font-mono text-xs font-bold mb-2.5">條碼: {{ curItem.barcode }}</div>

    <!-- 摘要卡 -->
    <div class="sum-row">
      <div class="sum-card">
        <div class="text-[10px] text-gray-400">SKU</div>
        <div class="text-sm font-extrabold mt-0.5" style="color:#4A90D9;">{{ curItem.sku }}</div>
      </div>
      <div class="sum-card">
        <div class="text-[10px] text-gray-400">箱入</div>
        <div class="text-xl font-extrabold" style="color:#E6A23C;">{{ curItem.perBox }}</div>
      </div>
      <div class="sum-card">
        <div class="text-[10px] text-gray-400">總件數</div>
        <div class="text-xl font-extrabold" style="color:#4CAF50;">{{ detailStats.tu }}</div>
      </div>
      <div class="sum-card">
        <div class="text-[10px] text-gray-400">總箱數</div>
        <div class="text-xl font-extrabold" style="color:#7C4DFF;">
          {{ detailStats.tb }}<span v-if="detailStats.br > 0" class="text-xs" style="color:#E6A23C;"> 餘{{ detailStats.br }}</span>
        </div>
      </div>
    </div>

    <!-- Remarks -->
    <div
      v-if="curItem.remarks"
      class="remarks-card"
      :class="{ done: remarksStatus[curSKU]?.handled }"
    >
      <div class="remarks-card-header" :class="remarksStatus[curSKU]?.handled ? 'handled' : 'pending'">
        <div class="flex items-center gap-2 flex-1">
          <span class="text-xl">{{ remarksStatus[curSKU]?.handled ? '✅' : '⚠️' }}</span>
          <span
            class="text-sm font-bold"
            :style="remarksStatus[curSKU]?.handled ? 'color:#2E7D32' : 'color:#E65100'"
          >{{ curItem.remarks }}</span>
        </div>
        <button v-if="!remarksStatus[curSKU]?.handled" class="remarks-handle-btn" @click="openRkModal">
          ✋ 確認處理
        </button>
      </div>
      <div v-if="remarksStatus[curSKU]?.handled" class="remarks-handled-info">
        <span class="remarks-handled-badge">👤 {{ remarksStatus[curSKU].by }}</span>
        <span class="remarks-handled-badge">🕐 {{ remarksStatus[curSKU].time }}</span>
        <span class="remarks-undo" @click="undoRemark">撤銷</span>
      </div>
    </div>

    <!-- 日期 chips -->
    <div class="card">
      <div class="date-section" style="border-top:none;">
        <div class="text-xs font-bold text-gray-600 mb-2.5">
          📅 有效期限
          <span class="text-[11px] text-gray-300 font-normal">（選填）</span>
        </div>
        <div class="date-chips">
          <span v-if="!hasDates" class="text-xs text-gray-300">尚未新增日期</span>
          <div v-for="(dt, idx) in curPk.dates" :key="dt" class="date-chip">
            {{ fmtDate(dt) }}<span class="del" @click="removeDate(idx)">✕</span>
          </div>
          <button class="date-add" @click="toggleDateInput">+</button>
        </div>
        <div v-if="showDI[curSKU]" class="flex gap-2 mt-2.5">
          <input
            ref="newDateEl"
            v-model="newDate"
            maxlength="8"
            inputmode="numeric"
            @input="newDate = newDate.replace(/[^0-9]/g, '')"
            @keydown.enter="addDate"
            class="g-input flex-1 text-center"
            style="font-size:15px;"
            placeholder="YYYYMMDD"
          />
          <button class="g-btn g-btn-teal" style="padding:10px 18px;" @click="addDate">新增</button>
        </div>
      </div>
    </div>

    <!-- 各 alloc 的录入 -->
    <div v-for="al in curItem.allocs" :key="al.id" class="card">
      <div class="flex justify-between items-center px-4 py-3 border-b border-gray-100" style="background:#fafafa;">
        <div class="text-sm font-bold">
          <template v-if="al.type === 'combo'">
            {{ al.label }}
            <span class="px-2 py-0.5 rounded text-[10px] font-extrabold" style="background:#EDE7F6;color:#7C4DFF;">COMBO</span>
          </template>
          <template v-else>{{ curItem.name }}</template>
        </div>
        <div class="text-xs font-bold" :class="allocRemaining(curItem, al).cls">
          剩餘 {{ allocRemaining(curItem, al).remaining }}
        </div>
      </div>

      <!-- Combo 提示横幅 -->
      <template v-if="al.type === 'combo'">
        <div class="px-4 py-2 text-xs font-semibold border-b border-gray-100" style="color:#7C4DFF;background:#fcfbff;">
          🔗 {{ curItem.name }} ×{{ al.mult }}
        </div>
        <div class="border-b border-gray-100 overflow-hidden">
          <div
            class="flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none"
            style="background:linear-gradient(135deg,#F3E5F5,#EDE7F6);"
            @click="toggleCombo(al.id)"
          >
            <span class="text-base">🚨</span>
            <span class="flex-1 text-xs font-bold" style="color:#7B1FA2;">實際要拿</span>
            <span
              class="text-lg font-black px-3 py-0.5 rounded-lg border-2"
              style="background:#fff;color:#7B1FA2;border-color:#CE93D8;"
            >{{ whSum(al) * al.mult }}</span>
            <span class="text-xs font-semibold" style="color:#9C27B0;">件</span>
            <span
              class="text-sm transition-transform"
              :style="{ color:'#AB47BC', transform: comboExpanded[al.id] ? 'rotate(180deg)' : '' }"
            >▼</span>
          </div>
          <div v-if="comboExpanded[al.id]" class="px-4 py-3 border-t border-dashed" style="background:#FAFAFE;border-color:#CE93D8;">
            <div class="flex items-center justify-center gap-2 flex-wrap mb-1.5 font-extrabold">
              <span class="text-2xl" style="color:#7B1FA2;">{{ whSum(al) }}</span>
              <span style="color:#AB47BC;">×</span>
              <span class="text-2xl" style="color:#7B1FA2;">{{ al.mult }}</span>
              <span style="color:#AB47BC;">=</span>
              <span class="text-2xl px-3 py-0.5 rounded-lg border-2" style="background:#E8F5E9;color:#2E7D32;border-color:#81C784;">
                {{ whSum(al) * al.mult }}
              </span>
            </div>
            <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold" style="background:#FFF8E1;color:#E65100;border:1px solid #FFD54F;">
              ⚠️ 請拿 <strong class="mx-1">{{ whSum(al) * al.mult }} 件</strong>「{{ curItem.name }}」進行 Repack
            </div>
          </div>
        </div>
      </template>

      <!-- 无日期模式：单 input -->
      <template v-if="!hasDates">
        <template v-for="w in WH" :key="w">
          <div v-if="(al.warehouses[w] || 0) > 0" class="wr">
            <span class="text-sm font-bold min-w-[34px]" :style="{ color: WH_COLOR[w] }">{{ w }}</span>
            <span class="text-[15px] font-bold text-gray-300 ml-auto">{{ al.warehouses[w] }}</span>
            <span class="text-gray-300 mx-1">→</span>
            <span class="wr-pk">
              <input
                type="number"
                min="0"
                :class="inputClass(curPk.a[al.id][w][''], al.warehouses[w])"
                :value="curPk.a[al.id][w][''] || ''"
                placeholder="0"
                @input="curPk.a[al.id][w][''] = parseInt($event.target.value) || 0"
              />
            </span>
            <span class="w-5.5 text-center">
              <span v-if="curPk.a[al.id][w][''] > 0">
                <span v-if="curPk.a[al.id][w][''] === al.warehouses[w]" style="color:#4CAF50;">✓</span>
                <span v-else style="color:#F44336;">✗</span>
              </span>
            </span>
          </div>
        </template>
      </template>

      <!-- 日期模式：每日期一列 input -->
      <template v-else>
        <div class="overflow-x-auto pb-1">
          <div class="min-w-max">
            <!-- 日期表头 -->
            <div class="flex items-center gap-1.5 px-4 pt-2 pb-1">
              <div class="w-10 shrink-0"></div>
              <div class="w-8 shrink-0 text-center text-[11px] text-gray-500 font-semibold">需求</div>
              <div class="w-4 shrink-0"></div>
              <div
                v-for="dt in curPk.dates"
                :key="dt"
                class="shrink-0 text-center px-1 py-0.5 rounded text-[10px] font-bold"
                style="width:82px;color:#5C6BC0;background:#EDE7F6;"
              >{{ fmtDate(dt) }}</div>
              <div class="w-4 shrink-0"></div>
              <div class="w-[52px] shrink-0 text-center text-[11px] text-gray-500 font-semibold">合計</div>
              <div class="w-5.5 shrink-0"></div>
            </div>
            <!-- 各仓库 row -->
            <template v-for="w in WH" :key="w">
              <div v-if="(al.warehouses[w] || 0) > 0" class="flex items-center gap-1.5 px-4 py-1.5 border-b border-gray-50">
                <div class="w-10 shrink-0 text-sm font-bold" :style="{ color: WH_COLOR[w] }">{{ w }}</div>
                <div class="w-8 shrink-0 text-center text-[15px] font-bold text-gray-300">{{ al.warehouses[w] }}</div>
                <div class="w-4 shrink-0 text-center text-gray-300">→</div>
                <div v-for="dt in curPk.dates" :key="dt" class="shrink-0 text-center" style="width:82px;">
                  <input
                    type="number"
                    min="0"
                    inputmode="numeric"
                    :value="curPk.a[al.id][w][dt] || ''"
                    placeholder="0"
                    class="w-full py-1.5 px-1 rounded-lg font-mono font-bold text-[15px] text-center outline-none"
                    style="border:1.5px solid #e0e0e0;"
                    @input="curPk.a[al.id][w][dt] = parseInt($event.target.value) || 0"
                  />
                </div>
                <div class="w-4 shrink-0 text-center text-gray-300 font-bold">=</div>
                <div
                  class="w-[52px] shrink-0 text-center text-xs font-bold py-0.5 rounded-md"
                  :class="whTotalDisplay(al.id, w, al.warehouses[w]).cls"
                >{{ whTotalDisplay(al.id, w, al.warehouses[w]).value }}</div>
                <div class="w-5.5 shrink-0 text-center">
                  <span v-if="whQty(curSKU, al.id, w) > 0">
                    <span v-if="whQty(curSKU, al.id, w) === al.warehouses[w]" style="color:#4CAF50;">✓</span>
                    <span v-else style="color:#F44336;">✗</span>
                  </span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>

    <div class="h-18"></div>

    <!-- 保存 sticky -->
    <div class="m3a-bot">
      <button class="g-btn g-btn-teal w-full" style="padding:14px;" @click="saveDetail">💾 儲存</button>
    </div>

    <!-- Remarks 弹窗 -->
    <div v-if="rkOpen" class="rk-modal-overlay" @click.self="closeRkModal">
      <div class="rk-modal">
        <div class="px-6 pt-6 pb-4 text-center">
          <div class="text-5xl">✋</div>
          <h3 class="text-lg font-extrabold mt-2 mb-1">確認處理備註</h3>
          <p class="text-xs text-gray-500">「{{ curItem?.remarks }}」— {{ curItem?.name }}</p>
        </div>
        <div class="px-6 pb-5">
          <label class="block text-xs text-gray-500 font-semibold mb-1.5">請輸入你的姓名</label>
          <input
            ref="rkNameEl"
            v-model="rkName"
            @keydown.enter="confirmRemark"
            placeholder="例：小明"
            class="w-full px-3.5 py-3 border-2 border-gray-200 rounded-xl text-base text-center outline-none"
          />
        </div>
        <div class="flex border-t border-gray-100">
          <button class="flex-1 py-4 border-0 text-[15px] font-bold cursor-pointer bg-gray-50 text-gray-400" @click="closeRkModal">取消</button>
          <button
            class="flex-1 py-4 border-0 text-[15px] font-bold cursor-pointer text-white"
            style="background:linear-gradient(135deg,#FF9800,#F57C00);"
            @click="confirmRemark"
          >✅ 確認已處理</button>
        </div>
      </div>
    </div>

    <!-- 扫码相机弹窗（视觉占位） -->
    <div v-if="scannerOpen" class="fixed inset-0 z-[200] flex flex-col items-center justify-center" style="background:rgba(0,0,0,.92);">
      <div class="absolute top-0 left-0 right-0 p-4 flex justify-between items-center">
        <span class="text-white text-[15px] font-bold">📷 掃描條碼</span>
        <button
          class="border-0 text-white w-9 h-9 rounded-full text-xl cursor-pointer flex items-center justify-center"
          style="background:rgba(255,255,255,.15);"
          @click="closeScanner"
        >✕</button>
      </div>
      <div class="text-white/70 text-sm mt-5 text-center">
        相機功能在 PWA 阶段开启<br/>
        <a class="text-blue-300 cursor-pointer underline" @click="closeScanner">手動輸入條碼</a>
      </div>
    </div>
  </div>
</template>
