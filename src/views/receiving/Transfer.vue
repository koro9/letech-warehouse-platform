<script setup>
/**
 * Transfer Order (M3c) — 复刻 demo s3-m-transfer
 *
 * 四态：
 *   search   → PO 输入页（紫色渐变背景）
 *   trlist   → 该 PO 下的 TR 列表（带进度条/统计）
 *   trdetail → 单个 TR 详情（扫码 + 品项分组列表 + 截單）
 *   item     → 单个品项分组的揀貨/箱數编辑
 *
 * 关键能力：
 *   - 扫码定位品项（barcode 或 sku）
 *   - 截單：根据已揀数量把当前 TR 拆成"第一轉（已揀）+ 第二轉（剩餘）"
 *     并在 PO 列表中插入新 TR
 *   - 导出 Excel（demo 用 xlsx CDN，本项目暂未加 dep，stub 化）
 *
 * 相机扫码当前为视觉占位，等 PWA 阶段引入 html5-qrcode 或 BarcodeDetector
 */
import { computed, nextTick, reactive, ref } from 'vue'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import RefreshButton from '@/components/RefreshButton.vue'

// Mock：PO → 多个 TR
const poData = reactive({
  '12345': [
    { id: 'TR-00001', from: 'KT', to: '3PL' },
    { id: 'TR-00002', from: 'KT', to: 'SD4' },
    { id: 'TR-00003', from: 'KT', to: 'Wholesale' },
  ],
})

// Mock：TR → 多个品项分组（demo 数据完整搬运）
const inv = reactive({
  'TR-00001': [
    { id: 'g1', displaySku: 'LT100000', displayName: '巧克力', labelType: 'Food Standard',
      items: [
        { sku: 'LT100000',  name: '巧克力',     nameEn: 'Chocolate',          barcode: '471900010001', reqQty: 30, pickQty: 0, boxes: 0, isBom: false },
        { sku: 'LT100000A', name: '巧克力x2',   nameEn: 'Chocolate x2 Bundle', barcode: '471900010002', reqQty: 10, pickQty: 0, boxes: 0, isBom: true, multiplier: 2 },
      ] },
    { id: 'g2', displaySku: 'LT1000003', displayName: '草莓軟糖', labelType: 'Food Standard',
      items: [{ sku: 'LT1000003', name: '草莓軟糖', nameEn: 'Soft Strawberry Candy', barcode: '471900010003', reqQty: 50, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g3', displaySku: 'LT1000010', displayName: '日式抹茶粉', labelType: 'Food Premium',
      items: [{ sku: 'LT1000010', name: '日式抹茶粉 100g', nameEn: 'Japanese Matcha Powder 100g', barcode: '471900010010', reqQty: 80, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g4', displaySku: 'LT1000011', displayName: '有機燕麥片', labelType: 'Health Food',
      items: [
        { sku: 'LT1000011',  name: '有機燕麥片 500g',     nameEn: 'Organic Oatmeal 500g',           barcode: '471900010011', reqQty: 120, pickQty: 0, boxes: 0, isBom: false },
        { sku: 'LT1000011A', name: '有機燕麥片x3禮盒',    nameEn: 'Organic Oatmeal x3 Gift Set',    barcode: '471900010012', reqQty: 20,  pickQty: 0, boxes: 0, isBom: true, multiplier: 3 },
      ] },
    { id: 'g5', displaySku: 'LT1000015', displayName: '椰子水', labelType: 'Beverage',
      items: [{ sku: 'LT1000015', name: '椰子水 330ml', nameEn: 'Coconut Water 330ml', barcode: '471900010015', reqQty: 240, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g6', displaySku: 'LT1000018', displayName: '綜合堅果', labelType: 'Snack',
      items: [
        { sku: 'LT1000018',  name: '綜合堅果 200g',           nameEn: 'Mixed Nuts 200g',          barcode: '471900010018', reqQty: 60, pickQty: 0, boxes: 0, isBom: false },
        { sku: 'LT1000018A', name: '綜合堅果x5量販包',         nameEn: 'Mixed Nuts x5 Value Pack', barcode: '471900010019', reqQty: 15, pickQty: 0, boxes: 0, isBom: true, multiplier: 5 },
      ] },
    { id: 'g7', displaySku: 'LT1000020', displayName: '純天然蜂蜜', labelType: 'Health Food',
      items: [{ sku: 'LT1000020', name: '純天然蜂蜜 250ml', nameEn: 'Pure Natural Honey 250ml', barcode: '471900010020', reqQty: 45, pickQty: 0, boxes: 0, isBom: false }] },
  ],
  'TR-00002': [
    { id: 'g8',  displaySku: 'LT2000001', displayName: '辦公桌椅組', labelType: 'Heavy Furniture',
      items: [{ sku: 'LT2000001', name: '辦公桌椅組', nameEn: 'Office Desk Chair Set', barcode: '880123456789', reqQty: 5, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g9',  displaySku: 'LT2000005', displayName: 'LED檯燈', labelType: 'Electronics',
      items: [{ sku: 'LT2000005', name: 'LED護眼檯燈', nameEn: 'LED Eye-Care Desk Lamp', barcode: '880123456790', reqQty: 30, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g10', displaySku: 'LT2000008', displayName: '無線鍵盤滑鼠組', labelType: 'Electronics',
      items: [{ sku: 'LT2000008', name: '無線鍵盤滑鼠組', nameEn: 'Wireless Keyboard Mouse Combo', barcode: '880123456791', reqQty: 50, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g11', displaySku: 'LT2000012', displayName: '收納櫃三層', labelType: 'Furniture',
      items: [{ sku: 'LT2000012', name: '收納櫃三層 白色', nameEn: '3-Tier Storage Cabinet White', barcode: '880123456792', reqQty: 20, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g12', displaySku: 'LT2000015', displayName: '空氣清淨機', labelType: 'Appliance',
      items: [{ sku: 'LT2000015', name: '空氣清淨機 HEPA', nameEn: 'Air Purifier HEPA', barcode: '880123456793', reqQty: 10, pickQty: 0, boxes: 0, isBom: false }] },
  ],
  'TR-00003': [
    { id: 'g13', displaySku: 'LT3000001', displayName: '文具套裝', labelType: 'Stationery',
      items: [{ sku: 'LT3000001', name: '文具套裝', nameEn: 'Stationery Set', barcode: '690123456789', reqQty: 100, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g14', displaySku: 'LT3000005', displayName: 'A4影印紙', labelType: 'Office Supply',
      items: [{ sku: 'LT3000005', name: 'A4影印紙 80磅 500張', nameEn: 'A4 Copy Paper 80gsm 500sheets', barcode: '690123456790', reqQty: 200, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g15', displaySku: 'LT3000008', displayName: '白板筆套組', labelType: 'Stationery',
      items: [
        { sku: 'LT3000008',  name: '白板筆四色套組',  nameEn: 'Whiteboard Marker 4-Color Set', barcode: '690123456791', reqQty: 80, pickQty: 0, boxes: 0, isBom: false },
        { sku: 'LT3000008A', name: '白板筆x10量販',   nameEn: 'Whiteboard Marker x10 Bulk',    barcode: '690123456792', reqQty: 25, pickQty: 0, boxes: 0, isBom: true, multiplier: 10 },
      ] },
    { id: 'g16', displaySku: 'LT3000012', displayName: '便利貼組合包', labelType: 'Stationery',
      items: [{ sku: 'LT3000012', name: '便利貼組合包 6入', nameEn: 'Sticky Notes Combo 6-Pack', barcode: '690123456793', reqQty: 150, pickQty: 0, boxes: 0, isBom: false }] },
    { id: 'g17', displaySku: 'LT3000016', displayName: '資料夾', labelType: 'Office Supply',
      items: [{ sku: 'LT3000016', name: 'A4資料夾 透明 50入', nameEn: 'A4 Clear File Folder 50pcs', barcode: '690123456794', reqQty: 60, pickQty: 0, boxes: 0, isBom: false }] },
  ],
})

// ========== 状态 ==========
const view = ref('search')           // 'search' | 'trlist' | 'trdetail' | 'item'
const curPO = ref(null)
const selTR = ref(null)
const selGrp = ref(null)

const poInput = ref('12345')
const trSearch = ref('')
const bcQuery = ref('')
const bcError = ref('')
const bcInputEl = ref(null)

const showCutModal = ref(false)
const scannerOpen = ref(false)

// ========== 计算 ==========
const trList = computed(() => poData[curPO.value] || [])
const filteredTRs = computed(() =>
  trList.value.filter(t => t.id.toLowerCase().includes(trSearch.value.toLowerCase())),
)

const curTR = computed(() => trList.value.find(t => t.id === selTR.value))
const curGroups = computed(() => inv[selTR.value] || [])
const curGroup = computed(() => curGroups.value[selGrp.value] || null)

function groupStatus(g) {
  const tr = g.items.reduce((s, i) => s + i.reqQty, 0)
  const tp = g.items.reduce((s, i) => s + i.pickQty, 0)
  if (g.items.some(i => i.pickQty > i.reqQty)) return 'over'
  if (tp === 0) return 'pending'
  if (tp >= tr) return 'done'
  return 'partial'
}

function trStats(trId) {
  const gs = inv[trId] || []
  let rq = 0, pk = 0, bx = 0, dn = 0
  gs.forEach(g => {
    g.items.forEach(i => { rq += i.reqQty; pk += i.pickQty; bx += i.boxes })
    if (groupStatus(g) === 'done') dn++
  })
  return { rq, pk, bx, dn, total: gs.length }
}

const allTRStats = computed(() => {
  return trList.value.reduce((a, t) => {
    const s = trStats(t.id)
    return { rq: a.rq + s.rq, pk: a.pk + s.pk, bx: a.bx + s.bx }
  }, { rq: 0, pk: 0, bx: 0 })
})

const detailStats = computed(() => trStats(selTR.value))
const detailPct = computed(() => detailStats.value.rq > 0 ? Math.round(detailStats.value.pk / detailStats.value.rq * 100) : 0)

const groupStatsCur = computed(() => {
  const g = curGroup.value
  if (!g) return { gR: 0, gP: 0, pct: 0 }
  const gR = g.items.reduce((a, i) => a + i.reqQty, 0)
  const gP = g.items.reduce((a, i) => a + i.pickQty, 0)
  const pct = gR > 0 ? Math.min(Math.round(gP / gR * 100), 100) : 0
  return { gR, gP, pct }
})

// 截單预览数据
const cutPreview = computed(() => {
  const gs = inv[selTR.value] || []
  const first = [], second = []
  let ft = 0, st = 0
  gs.forEach(g => {
    g.items.forEach(i => {
      if (i.pickQty > 0) { first.push({ name: i.name, sku: i.sku, qty: i.pickQty, orig: i.reqQty }); ft += i.pickQty }
      const rm = i.reqQty - i.pickQty
      if (rm > 0)        { second.push({ name: i.name, sku: i.sku, qty: rm, orig: i.reqQty }); st += rm }
    })
  })
  // 生成下一个 TR id
  const base = (selTR.value?.match(/^(TR-\d+)/) || [])[1] || selTR.value
  let suf = 2, nid = `${base}-${suf}`
  while (trList.value.some(t => t.id === nid)) { suf++; nid = `${base}-${suf}` }
  return { first, second, ft, st, nid }
})

// ========== Helpers ==========
function statusBadge(st) {
  const m = {
    pending: { l: '待處理', cls: 'bg-slate-100 text-slate-500' },
    partial: { l: '進行中', cls: 'bg-amber-100 text-amber-800' },
    done:    { l: '已完成', cls: 'bg-emerald-100 text-emerald-800' },
    over:    { l: '超揀',   cls: 'bg-red-100 text-red-800' },
  }
  return m[st] || m.pending
}

function progressClass(pct) {
  return pct >= 100
    ? 'bg-gradient-to-r from-emerald-400 to-emerald-600'
    : 'bg-gradient-to-r from-indigo-400 to-violet-500'
}

// ========== 操作 ==========
function searchPO() {
  const v = poInput.value.trim()
  if (!v) { showToast('請輸入 PO Number', 'error'); return }
  if (poData[v]) { curPO.value = v; view.value = 'trlist' }
  else showToast('找不到此 PO，測試請輸入: 12345', 'error')
}

// 后端就绪后：trlist 刷新 = 重新拉 TR 列表 + 各 TR 进度
//                trdetail/item 刷新 = 重新拉当前 TR 的 inv 数据，保留 pickQty/boxes 输入
async function refreshData() {
  if (view.value === 'search') return
  showToast('已是最新（後端待接入）', 'success')
}
const { refreshNow } = usePageRefresh(refreshData)

function goBack() {
  closeScanner()
  bcQuery.value = ''; bcError.value = ''
  if (view.value === 'item')         { view.value = 'trdetail' }
  else if (view.value === 'trdetail') { view.value = 'trlist'; selTR.value = null }
  else if (view.value === 'trlist')   { view.value = 'search'; curPO.value = null; trSearch.value = '' }
}

function openTR(id) {
  selTR.value = id; view.value = 'trdetail'
  nextTick(() => bcInputEl.value?.focus())
}

function openItem(idx) {
  selGrp.value = idx; view.value = 'item'
}

function scanBC() {
  const q = bcQuery.value.trim()
  if (!q) { showToast('請輸入 Barcode 或 SKU', 'warning'); return }
  const idx = curGroups.value.findIndex(g => g.items.some(i => i.barcode === q || i.sku === q))
  if (idx !== -1) {
    bcError.value = ''; bcQuery.value = ''
    showToast(`✓ 找到: ${curGroups.value[idx].displayName}`, 'success')
    setTimeout(() => { selGrp.value = idx; view.value = 'item' }, 400)
  } else {
    bcError.value = `Barcode「${q}」不存在於此單據`
    bcQuery.value = ''
  }
}

function updItem(item, field, val) {
  item[field] = Math.max(0, parseInt(val) || 0)
}

function saveItem() {
  const g = curGroup.value
  if (g?.items.some(i => i.pickQty > i.reqQty)) showToast('⚠ 存在超揀項目', 'warning')
  else showToast('已儲存揀貨資料', 'success')
  view.value = 'trdetail'
}

function saveTR() {
  showToast(`${selTR.value} 已儲存`, 'success')
  setTimeout(() => { view.value = 'trlist'; selTR.value = null }, 500)
}

// ========== 截單 ==========
function handleCut() {
  const gs = inv[selTR.value] || []
  let anyPicked = false, anyRemaining = false
  gs.forEach(g => g.items.forEach(i => {
    if (i.pickQty > 0) anyPicked = true
    if (i.reqQty - i.pickQty > 0) anyRemaining = true
  }))
  if (!anyPicked)    { showToast('尚未揀貨，無法截單', 'warning'); return }
  if (!anyRemaining) { showToast('已全部揀完，無需截單', 'warning'); return }
  showCutModal.value = true
}

function closeCutModal() { showCutModal.value = false }

function executeCut() {
  const newId = cutPreview.value.nid
  const oldGs = JSON.parse(JSON.stringify(inv[selTR.value] || []))
  const trI = curTR.value
  const fg = [], sg = []
  let gc = 9000
  oldGs.forEach(g => {
    const fi = g.items.filter(i => i.pickQty > 0).map(i => ({ ...i, reqQty: i.pickQty }))
    if (fi.length > 0) fg.push({ ...g, items: fi })
    const si = g.items.filter(i => (i.reqQty - i.pickQty) > 0).map(i => ({ ...i, reqQty: i.reqQty - i.pickQty, pickQty: 0, boxes: 0 }))
    if (si.length > 0) { gc++; sg.push({ ...g, id: `g_cut_${gc}`, items: si }) }
  })
  inv[selTR.value] = fg
  inv[newId] = sg
  const list = poData[curPO.value]
  const oi = list.findIndex(t => t.id === selTR.value)
  const nt = { id: newId, from: trI.from, to: trI.to }
  if (oi !== -1) list.splice(oi + 1, 0, nt); else list.push(nt)
  closeCutModal()
  showToast(`✓ 截單成功！已產生 ${newId}`, 'success')
  setTimeout(() => { view.value = 'trlist'; selTR.value = null }, 800)
}

// ========== 扫码相机（占位） ==========
function openScanner()  { scannerOpen.value = true }
function closeScanner() { scannerOpen.value = false }

// ========== 导出 ==========
function exportTR(trId) {
  const rows = (inv[trId] || []).flatMap(g => g.items.filter(i => i.pickQty > 0 || i.boxes > 0))
  if (!rows.length) { showToast('沒有已填寫的揀貨資料', 'warning'); return }
  showToast(`✓ 已匯出 ${rows.length} 筆（dep 未集成）`, 'success')
}

function exportAllTR() {
  let total = 0
  trList.value.forEach(tr => {
    (inv[tr.id] || []).forEach(g => g.items.forEach(i => { if (i.pickQty > 0 || i.boxes > 0) total++ }))
  })
  if (!total) { showToast('所有單據都沒有資料', 'warning'); return }
  showToast(`✓ 已匯出 ${total} 筆（dep 未集成）`, 'success')
}

function isCutTr(id) { return /^TR-\d+-\d+$/.test(id) }
</script>

<template>
  <!-- ===== 状态 1：PO 搜索 ===== -->
  <div
    v-if="view === 'search'"
    class="m3c-wrap m3c-grad h-full"
    style="background: linear-gradient(135deg,#1e1b4b,#2e1065,#3b0764);"
  >
    <div class="flex-1 flex flex-col justify-center items-center p-6">
      <div class="text-center mb-8">
        <div class="m3c-float inline-block mb-4">
          <div
            class="w-20 h-20 rounded-3xl flex items-center justify-center text-white text-3xl"
            style="background:linear-gradient(135deg,#f97316,#ec4899);box-shadow:0 20px 40px rgba(249,115,22,.3);"
          >📦</div>
        </div>
        <h1 class="text-3xl font-black text-white tracking-tight">Transfer Orders</h1>
        <p class="text-sm mt-2" style="color:rgba(196,181,253,.5);">倉儲調撥揀貨系統</p>
      </div>
      <div class="w-full max-w-sm">
        <div
          class="rounded-3xl p-6 px-8"
          style="background:rgba(255,255,255,.1);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.1);box-shadow:0 25px 50px rgba(0,0,0,.25);"
        >
          <label class="block text-[11px] font-bold tracking-widest mb-3" style="color:rgba(196,181,253,.7);">PO NUMBER</label>
          <input
            v-model="poInput"
            @keydown.enter="searchPO"
            class="w-full px-5 py-4 rounded-2xl text-white text-xl font-bold text-center outline-none mb-4"
            style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);"
            placeholder="輸入 PO Number..."
          />
          <button
            class="w-full py-4 text-white border-0 rounded-2xl font-bold text-base cursor-pointer"
            style="background:linear-gradient(90deg,#f97316,#ec4899);box-shadow:0 8px 24px rgba(249,115,22,.3);"
            @click="searchPO"
          >搜尋</button>
        </div>
        <p class="text-xs text-center mt-6" style="color:rgba(139,92,246,.4);">
          Demo 請輸入: <strong style="color:rgba(196,181,253,.7);">12345</strong>
        </p>
      </div>
    </div>
  </div>

  <!-- ===== 状态 2：TR 列表 ===== -->
  <div v-else-if="view === 'trlist'" class="m3c-wrap h-full">
    <!-- 顶部 -->
    <div class="text-white px-5 py-4 flex-shrink-0" style="background:linear-gradient(90deg,#312e81,#4c1d95);">
      <div class="flex items-center gap-3 mb-4">
        <button class="bg-transparent border-0 text-white text-xl cursor-pointer p-2" @click="goBack">‹</button>
        <div class="flex-1">
          <h1 class="text-lg font-black">PO: {{ curPO }}</h1>
          <p class="text-xs mt-0.5" style="color:rgba(167,139,250,.5);">{{ trList.length }} 張調撥單</p>
        </div>
        <button
          class="flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-xs font-bold cursor-pointer"
          style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
          @click="refreshNow"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          刷新
        </button>
        <button
          class="flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-xs font-bold cursor-pointer"
          style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
          @click="exportAllTR"
        >⬇ 匯出全部</button>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div class="rounded-xl p-3 text-center" style="background:rgba(255,255,255,.1);">
          <div class="text-2xl font-black">{{ allTRStats.rq > 0 ? Math.round(allTRStats.pk / allTRStats.rq * 100) : 0 }}%</div>
          <div class="text-[11px] mt-0.5" style="color:rgba(167,139,250,.5);">總進度</div>
        </div>
        <div class="rounded-xl p-3 text-center" style="background:rgba(255,255,255,.1);">
          <div class="text-2xl font-black">{{ allTRStats.pk }}<span class="text-sm" style="color:rgba(167,139,250,.4);">/{{ allTRStats.rq }}</span></div>
          <div class="text-[11px] mt-0.5" style="color:rgba(167,139,250,.5);">揀貨數</div>
        </div>
        <div class="rounded-xl p-3 text-center" style="background:rgba(255,255,255,.1);">
          <div class="text-2xl font-black">{{ allTRStats.bx }}</div>
          <div class="text-[11px] mt-0.5" style="color:rgba(167,139,250,.5);">總箱數</div>
        </div>
      </div>
    </div>

    <!-- 搜索 -->
    <div class="px-4 py-3 bg-white border-b border-gray-100 flex-shrink-0">
      <input
        v-model="trSearch"
        class="w-full px-4 py-3 pl-9 border border-gray-200 rounded-xl text-sm font-medium outline-none"
        placeholder="🔍 搜尋 TR Number..."
      />
    </div>

    <!-- TR 卡片 -->
    <div class="flex-1 overflow-y-auto p-4">
      <div class="flex flex-col gap-3 max-w-lg mx-auto">
        <div
          v-for="tr in filteredTRs"
          :key="tr.id"
          class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden cursor-pointer transition-all hover:-translate-y-px"
          @click="openTR(tr.id)"
        >
          <div class="px-5 py-4">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-3">
                <div
                  class="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow"
                  :style="{ background: trStats(tr.id).dn === trStats(tr.id).total && trStats(tr.id).total > 0
                    ? 'linear-gradient(135deg,#34d399,#059669)'
                    : trStats(tr.id).pk > 0
                      ? 'linear-gradient(135deg,#818cf8,#7c3aed)'
                      : 'linear-gradient(135deg,#d1d5db,#9ca3af)' }"
                >🚚</div>
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-[15px] text-slate-800">{{ tr.id }}</span>
                    <span
                      v-if="isCutTr(tr.id)"
                      class="text-[11px] px-2 py-px rounded-xl font-bold border"
                      style="background:linear-gradient(90deg,#fef3c7,#fed7aa);color:#c2410c;border-color:#fdba74;"
                    >第二轉</span>
                  </div>
                  <div class="text-xs text-slate-400 font-semibold mt-0.5">{{ tr.from }} → {{ tr.to }}</div>
                </div>
              </div>
              <span
                class="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold"
                :class="(() => {
                  const s = trStats(tr.id)
                  const pct = s.rq > 0 ? Math.round(s.pk / s.rq * 100) : 0
                  const done = s.dn === s.total && s.total > 0
                  return statusBadge(done ? 'done' : pct > 0 ? 'partial' : 'pending').cls
                })()"
              >{{ (() => {
                const s = trStats(tr.id)
                const pct = s.rq > 0 ? Math.round(s.pk / s.rq * 100) : 0
                const done = s.dn === s.total && s.total > 0
                return statusBadge(done ? 'done' : pct > 0 ? 'partial' : 'pending').l
              })() }}</span>
            </div>
            <div class="flex gap-4 text-xs text-slate-500 mb-3">
              <span>品項 <strong class="text-slate-700">{{ trStats(tr.id).dn }}/{{ trStats(tr.id).total }}</strong></span>
              <span>揀貨 <strong class="text-slate-700">{{ trStats(tr.id).pk }}/{{ trStats(tr.id).rq }}</strong></span>
              <span>箱數 <strong class="text-slate-700">{{ trStats(tr.id).bx }}</strong></span>
            </div>
            <div class="flex items-center gap-3">
              <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden flex-1">
                <div
                  class="h-full rounded-full transition-[width] duration-500"
                  :class="progressClass(trStats(tr.id).rq > 0 ? Math.round(trStats(tr.id).pk / trStats(tr.id).rq * 100) : 0)"
                  :style="{ width: (trStats(tr.id).rq > 0 ? Math.min(Math.round(trStats(tr.id).pk / trStats(tr.id).rq * 100), 100) : 0) + '%' }"
                ></div>
              </div>
              <span
                class="text-xs font-bold"
                :style="{ color: (trStats(tr.id).rq > 0 ? Math.round(trStats(tr.id).pk / trStats(tr.id).rq * 100) : 0) >= 100 ? '#059669' : '#64748b' }"
              >{{ trStats(tr.id).rq > 0 ? Math.round(trStats(tr.id).pk / trStats(tr.id).rq * 100) : 0 }}%</span>
            </div>
          </div>
          <div class="border-t border-gray-50 px-4 py-2 flex justify-end" style="background:rgba(249,250,251,.5);">
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold border-0 cursor-pointer rounded-lg bg-transparent"
              style="color:#4f46e5;"
              @click.stop="exportTR(tr.id)"
            >⬇ 匯出 Excel</button>
          </div>
        </div>
        <div v-if="!filteredTRs.length" class="text-center text-slate-400 py-12 text-sm">沒有符合的單據</div>
      </div>
    </div>
  </div>

  <!-- ===== 状态 3：TR 详情 ===== -->
  <div v-else-if="view === 'trdetail'" class="m3c-wrap h-full">
    <!-- 顶部 -->
    <div class="text-white px-4 py-3 flex-shrink-0 flex items-center gap-2.5" style="background:linear-gradient(90deg,#312e81,#4c1d95);">
      <button class="bg-transparent border-0 text-white text-xl cursor-pointer p-2" @click="goBack">‹</button>
      <div class="flex-1 min-w-0">
        <h1 class="text-base font-black truncate">{{ curTR?.id }}</h1>
        <p class="text-xs" style="color:rgba(167,139,250,.5);">{{ curTR?.from }} → {{ curTR?.to }}</p>
      </div>
      <button
        class="px-3 py-2 rounded-xl text-white cursor-pointer flex items-center justify-center"
        style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
        @click="refreshNow"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
      <button
        class="px-3 py-2 rounded-xl text-white text-xs font-bold cursor-pointer"
        style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
        @click="exportTR(selTR)"
      >⬇</button>
      <div class="text-right px-3 py-1 rounded-xl" style="background:rgba(255,255,255,.1);">
        <div class="text-xl font-black leading-none" style="color:#fdba74;">{{ detailStats.bx }}</div>
        <div class="text-[11px] mt-0.5" style="color:rgba(167,139,250,.4);">箱</div>
      </div>
    </div>

    <!-- 进度 -->
    <div class="bg-white border-b border-gray-100 px-4 py-3 flex-shrink-0">
      <div class="flex justify-between text-xs text-slate-500 mb-2">
        <span>揀貨進度 <strong class="text-slate-700">{{ detailStats.pk }}/{{ detailStats.rq }}</strong></span>
        <span class="font-bold text-sm" :style="{ color: detailPct >= 100 ? '#059669' : '#4f46e5' }">{{ detailPct }}%</span>
      </div>
      <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          class="h-full rounded-full transition-[width] duration-500"
          :class="progressClass(detailPct)"
          :style="{ width: Math.min(detailPct, 100) + '%' }"
        ></div>
      </div>
    </div>

    <!-- 扫码 -->
    <div class="px-4 py-3 border-b border-gray-200 flex-shrink-0" style="background:linear-gradient(180deg,#f3f4f6,#f9fafb);">
      <button
        class="m3c-pulse w-full h-14 mb-2.5 text-white border-0 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-3"
        style="background:linear-gradient(90deg,#f97316,#ec4899);box-shadow:0 8px 24px rgba(249,115,22,.2);"
        @click="openScanner"
      >📷 開啟相機掃碼</button>
      <div class="flex gap-2">
        <input
          ref="bcInputEl"
          v-model="bcQuery"
          @keydown.enter="scanBC"
          class="flex-1 h-11 pl-10 pr-3 border border-gray-200 rounded-xl text-sm font-medium outline-none"
          placeholder="▮▮▮ 手動輸入 Barcode / SKU..."
        />
        <button class="h-11 px-4 text-white border-0 rounded-xl font-bold text-xs cursor-pointer whitespace-nowrap" style="background:#4f46e5;" @click="scanBC">🔍 查詢</button>
      </div>
      <div
        v-if="bcError"
        class="mt-2 px-3 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2"
        style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;"
      >⚠ {{ bcError }}</div>
    </div>

    <!-- 表头 -->
    <div class="flex items-center px-4 py-2 border-b border-gray-200 text-[11px] font-bold tracking-wider flex-shrink-0" style="background:rgba(241,245,249,.8);color:#94a3b8;">
      <div class="flex-1">品項</div>
      <div class="w-11 text-center">需求</div>
      <div class="w-11 text-center ml-2">揀貨</div>
      <div class="w-11 text-center ml-2">箱</div>
      <div class="w-8 text-center ml-1">狀態</div>
    </div>

    <!-- 品项列表 -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-for="(g, gi) in curGroups"
        :key="g.id"
        class="flex items-center px-4 py-3.5 border-b border-gray-100 cursor-pointer transition-colors"
        :class="groupStatus(g) === 'done' ? 'bg-emerald-50/60' : 'bg-white hover:bg-slate-50'"
        @click="openItem(gi)"
      >
        <div class="flex-1 min-w-0 pr-2">
          <div class="flex items-center gap-1.5 mb-0.5">
            <span class="font-bold text-sm text-slate-800 truncate">{{ g.displayName }}</span>
            <span
              v-if="g.items.some(i => i.isBom)"
              class="shrink-0 text-[10px] px-1.5 py-px rounded-md font-bold border"
              style="background:linear-gradient(90deg,#fed7aa,#fce7f3);color:#c2410c;border-color:#fdba74;"
            >BOM</span>
          </div>
          <div class="text-[11px] text-slate-400 truncate">{{ g.displaySku }} · {{ g.labelType }}</div>
        </div>
        <div class="w-11 text-center text-sm font-bold text-slate-700">{{ g.items.reduce((a,i) => a+i.reqQty, 0) }}</div>
        <div
          class="w-11 text-center text-sm font-bold ml-2"
          :style="{
            color: g.items.reduce((a,i) => a+i.pickQty, 0) >= g.items.reduce((a,i) => a+i.reqQty, 0) && g.items.reduce((a,i) => a+i.reqQty, 0) > 0
              ? '#059669'
              : g.items.reduce((a,i) => a+i.pickQty, 0) > 0 ? '#d97706' : '#d1d5db'
          }"
        >{{ g.items.reduce((a,i) => a+i.pickQty, 0) }}</div>
        <div class="w-11 text-center text-sm text-slate-500 ml-2">{{ g.items.reduce((a,i) => a+i.boxes, 0) }}</div>
        <div class="w-8 flex items-center justify-center ml-1">
          <div
            v-if="groupStatus(g) === 'done'"
            class="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs"
            style="background:linear-gradient(135deg,#34d399,#059669);"
          >✓</div>
          <div
            v-else-if="groupStatus(g) === 'partial'"
            class="w-7 h-7 rounded-full flex items-center justify-center"
            style="background:linear-gradient(135deg,#fcd34d,#f97316);"
          ><div class="w-2 h-2 bg-white rounded-full"></div></div>
          <div
            v-else-if="groupStatus(g) === 'over'"
            class="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-black"
            style="background:linear-gradient(135deg,#f87171,#e11d48);"
          >!</div>
          <div v-else class="w-7 h-7 rounded-full border-2 border-slate-200 bg-slate-50"></div>
        </div>
      </div>
    </div>

    <!-- 底部操作 -->
    <div class="flex-shrink-0 bg-white border-t border-gray-200 px-5 py-4 flex flex-col gap-3">
      <button
        class="w-full py-3.5 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2"
        style="border:2px solid #fbbf24;background:linear-gradient(90deg,#fffbeb,#fff7ed);color:#b45309;"
        @click="handleCut"
      >✂️ 截單 — 拆分為兩轉出貨</button>
      <div class="flex gap-3">
        <button
          class="flex-1 py-4 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2 bg-transparent"
          style="border:2px solid #6366f1;color:#4f46e5;"
          @click="exportTR(selTR)"
        >⬇ 匯出 Excel</button>
        <button
          class="flex-1 py-4 text-white border-0 rounded-2xl font-bold text-[15px] cursor-pointer"
          style="background:linear-gradient(90deg,#4f46e5,#7c3aed);box-shadow:0 8px 24px rgba(79,70,229,.2);"
          @click="saveTR"
        >儲存單據</button>
      </div>
    </div>
  </div>

  <!-- ===== 状态 4：单品项详情 ===== -->
  <div v-else-if="view === 'item'" class="m3c-wrap h-full">
    <div class="text-white px-4 py-3 flex-shrink-0 flex items-center gap-2.5" style="background:linear-gradient(90deg,#312e81,#4c1d95);">
      <button class="bg-transparent border-0 text-white text-xl cursor-pointer p-2" @click="goBack">‹</button>
      <div class="flex-1 min-w-0">
        <h1 class="text-base font-black truncate">{{ curGroup?.displayName }}</h1>
        <p class="text-xs" style="color:rgba(167,139,250,.5);">{{ curGroup?.displaySku }}</p>
      </div>
    </div>

    <div class="bg-white border-b border-gray-200 p-4 flex-shrink-0">
      <div class="flex flex-wrap gap-2 text-xs mb-3">
        <span class="bg-slate-100 px-3 py-1 rounded-lg font-mono font-bold text-slate-600">{{ curGroup?.items[0]?.barcode }}</span>
        <span class="px-3 py-1 rounded-lg font-bold border" style="background:#f5f3ff;color:#7c3aed;border-color:#e9d5ff;">{{ curGroup?.labelType }}</span>
        <span class="ml-auto px-3 py-1 rounded-lg font-bold border" style="background:linear-gradient(90deg,#eef2ff,#f5f3ff);color:#4338ca;border-color:#c7d2fe;">需求: {{ groupStatsCur.gR }}</span>
      </div>
      <div class="flex items-center gap-3">
        <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden flex-1">
          <div
            class="h-full rounded-full transition-[width] duration-500"
            :class="progressClass(groupStatsCur.pct)"
            :style="{ width: groupStatsCur.pct + '%' }"
          ></div>
        </div>
        <span class="text-xs font-bold text-slate-600 shrink-0">{{ groupStatsCur.gP }}/{{ groupStatsCur.gR }}</span>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
      <div
        v-for="(item, idx) in curGroup?.items || []"
        :key="item.sku"
        class="rounded-2xl p-5 border-2 shadow-sm transition-colors"
        :class="item.pickQty > item.reqQty
          ? 'bg-red-50 border-red-200'
          : item.pickQty >= item.reqQty && item.reqQty > 0
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-white border-slate-100'"
      >
        <div class="mb-4">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="font-bold text-sm text-slate-800">{{ item.sku }}</span>
            <span
              v-if="item.isBom"
              class="text-[11px] px-2 py-0.5 rounded-xl font-bold border"
              style="background:linear-gradient(90deg,#fed7aa,#fce7f3);color:#c2410c;border-color:#fdba74;"
            >Repack ×{{ item.multiplier }}</span>
            <span v-if="item.pickQty >= item.reqQty && item.reqQty > 0 && item.pickQty <= item.reqQty">
              <div class="inline-flex w-5 h-5 rounded-full bg-emerald-500 items-center justify-center text-white text-[10px]">✓</div>
            </span>
            <span v-if="item.pickQty > item.reqQty" class="text-red-600 text-[11px] font-black bg-red-100 px-2 py-0.5 rounded-xl">超揀!</span>
          </div>
          <div class="text-xs text-slate-400">{{ item.name }} / {{ item.nameEn }}</div>
          <div
            v-if="item.isBom"
            class="text-xs font-bold mt-1.5 inline-block px-2 py-0.5 rounded-md"
            style="background:#fff7ed;color:#ea580c;"
          >需揀單件: {{ item.reqQty * item.multiplier }}</div>
        </div>

        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">需求</label>
            <div class="h-12 flex items-center justify-center bg-slate-50 rounded-xl border border-slate-200 text-lg font-black text-slate-800">{{ item.reqQty }}</div>
          </div>
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">揀貨</label>
            <input
              :value="item.pickQty === 0 ? '' : item.pickQty"
              type="number"
              inputmode="numeric"
              placeholder="0"
              class="w-full h-12 text-center text-lg font-black rounded-xl outline-none border-2"
              :class="item.pickQty > item.reqQty
                ? 'border-red-300 bg-red-50 text-red-600'
                : item.pickQty >= item.reqQty && item.reqQty > 0
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-600'
                  : 'border-slate-200 bg-white text-slate-800'"
              @input="updItem(item, 'pickQty', $event.target.value)"
            />
          </div>
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">箱數</label>
            <input
              :value="item.boxes === 0 ? '' : item.boxes"
              type="number"
              inputmode="numeric"
              placeholder="0"
              class="w-full h-12 text-center text-lg font-black rounded-xl outline-none border-2 border-slate-200 bg-white text-slate-800"
              @input="updItem(item, 'boxes', $event.target.value)"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="flex-shrink-0 flex border-t border-gray-200 bg-white">
      <button class="flex-1 py-4 bg-slate-50 border-0 text-slate-500 font-bold text-[15px] cursor-pointer" @click="goBack">取消</button>
      <button class="flex-1 py-4 text-white border-0 font-bold text-[15px] cursor-pointer" style="background:linear-gradient(90deg,#4f46e5,#7c3aed);" @click="saveItem">確認儲存</button>
    </div>
  </div>

  <!-- 截單 Modal -->
  <div v-if="showCutModal" class="fixed inset-0 z-[200] flex items-center justify-center" @click.self="closeCutModal">
    <div class="absolute inset-0" style="background:rgba(0,0,0,.6);backdrop-filter:blur(16px);" @click="closeCutModal"></div>
    <div class="relative w-full max-w-lg mx-4 bg-white rounded-3xl shadow-2xl max-h-[90vh] overflow-hidden">
      <div class="px-5 pt-5 pb-4 border-b border-gray-100">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg" style="background:linear-gradient(135deg,#fbbf24,#f97316);">✂</div>
            <div>
              <h2 class="text-lg font-black text-slate-800">截單確認</h2>
              <p class="text-xs text-slate-400">將此單拆分為兩轉出貨</p>
            </div>
          </div>
          <button class="p-2 bg-transparent border-0 text-slate-400 text-xl cursor-pointer" @click="closeCutModal">✕</button>
        </div>
      </div>

      <div class="px-5 py-5 flex flex-col gap-4 overflow-y-auto" style="max-height:60vh;">
        <!-- 第一转 -->
        <div class="rounded-2xl border-2 overflow-hidden" style="border-color:#c7d2fe;">
          <div class="text-white px-4 py-3 flex justify-between" style="background:linear-gradient(90deg,#6366f1,#7c3aed);">
            <div>
              <div class="text-[11px] font-bold opacity-70 tracking-widest">第一轉 · 本次出貨</div>
              <div class="font-black text-[15px] mt-0.5">{{ selTR }}</div>
            </div>
            <div class="text-right">
              <div class="text-2xl font-black">{{ cutPreview.ft }}</div>
              <div class="text-[11px] opacity-70">件</div>
            </div>
          </div>
          <div v-for="i in cutPreview.first" :key="i.sku" class="px-4 py-2.5 flex items-center justify-between border-b border-gray-50">
            <div>
              <div class="text-sm font-bold text-slate-700">{{ i.name }}</div>
              <div class="text-xs text-slate-400">{{ i.sku }}</div>
            </div>
            <div class="text-right">
              <span class="text-[15px] font-black" style="color:#4f46e5;">{{ i.qty }}</span>
              <span class="text-xs text-slate-400 ml-1">/ {{ i.orig }}</span>
            </div>
          </div>
        </div>

        <!-- 分隔 -->
        <div class="flex items-center gap-3 px-2">
          <div class="flex-1 border-t-2 border-dashed border-slate-200"></div>
          <div
            class="w-10 h-10 rounded-full flex items-center justify-center text-base"
            style="background:linear-gradient(135deg,#fef3c7,#fed7aa);border:2px solid #fdba74;color:#ea580c;"
          >⇣</div>
          <div class="flex-1 border-t-2 border-dashed border-slate-200"></div>
        </div>

        <!-- 第二转 -->
        <div class="rounded-2xl border-2 overflow-hidden" style="border-color:#fde68a;">
          <div class="text-white px-4 py-3 flex justify-between" style="background:linear-gradient(90deg,#f59e0b,#f97316);">
            <div>
              <div class="text-[11px] font-bold opacity-70 tracking-widest">第二轉 · 下次出貨</div>
              <div class="font-black text-[15px] mt-0.5">{{ cutPreview.nid }} <span class="text-[11px] px-2 py-px rounded-xl ml-1" style="background:rgba(255,255,255,.2);">新建</span></div>
            </div>
            <div class="text-right">
              <div class="text-2xl font-black">{{ cutPreview.st }}</div>
              <div class="text-[11px] opacity-70">件</div>
            </div>
          </div>
          <div v-for="i in cutPreview.second" :key="i.sku" class="px-4 py-2.5 flex items-center justify-between border-b border-gray-50">
            <div>
              <div class="text-sm font-bold text-slate-700">{{ i.name }}</div>
              <div class="text-xs text-slate-400">{{ i.sku }}</div>
            </div>
            <div class="text-right">
              <span class="text-[15px] font-black" style="color:#d97706;">{{ i.qty }}</span>
              <span class="text-xs text-slate-400 ml-1">剩餘</span>
            </div>
          </div>
        </div>

        <div class="rounded-xl px-4 py-3 flex gap-2" style="background:#fef2f2;border:1px solid #fecaca;">
          <span class="shrink-0 mt-0.5" style="color:#dc2626;">⚠</span>
          <div class="text-xs font-semibold leading-relaxed" style="color:#b91c1c;">
            截單後，本單需求量將調整為已揀數量，剩餘數量會移到新的第二轉單據。此操作無法復原。
          </div>
        </div>
      </div>

      <div class="flex-shrink-0 px-5 py-4 border-t border-gray-100 flex gap-3">
        <button class="flex-1 py-3.5 bg-transparent rounded-2xl font-bold text-[15px] cursor-pointer" style="border:2px solid #e2e8f0;color:#64748b;" @click="closeCutModal">取消</button>
        <button
          class="flex-1 py-3.5 text-white border-0 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2"
          style="background:linear-gradient(90deg,#f59e0b,#f97316);box-shadow:0 8px 24px rgba(245,158,11,.2);"
          @click="executeCut"
        >✂ 確認截單</button>
      </div>
    </div>
  </div>

  <!-- 扫码相机占位 -->
  <div v-if="scannerOpen" class="fixed inset-0 z-[200] flex flex-col bg-black">
    <div class="flex items-center px-4 py-3 text-white" style="background:rgba(0,0,0,.9);">
      <button class="p-2 bg-transparent border-0 text-white text-xl cursor-pointer" @click="closeScanner">✕</button>
      <div class="flex-1 text-center font-bold">掃描條碼</div>
      <div class="w-10"></div>
    </div>
    <div class="flex-1 flex flex-col items-center justify-center text-white text-sm text-center px-6">
      相機功能在 PWA 阶段开启<br/>
      <a class="text-blue-300 cursor-pointer underline mt-2" @click="closeScanner">改為手動輸入</a>
    </div>
  </div>
</template>
