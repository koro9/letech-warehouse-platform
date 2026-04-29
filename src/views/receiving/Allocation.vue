<script setup>
/**
 * 收貨分配 (M3b) — 复刻 demo s3-m-alloc
 *
 * 流程：
 *   1. PO 入口（Demo 仅接受 12345）
 *   2. 主表格：每行展示 SKU 信息 + 3PL/WS/SD4 + 最多 2 列自定义额外仓 + Combo 子行
 *      SD4 = 总数 - 3PL - WS - 各额外列 - 各 combo 子行(qty × 倍数)
 *   3. 顶部：搜索 / 匯出 / 儲存
 *
 * Combo 子行：行后点 ➕ 弹下拉，可挂 A(×2) / B(×3) / D(×5)
 *   子行有自己的 3PL 数量字段；从主行 SD4 中扣 (子行3PL × 倍数)
 *
 * Excel 导出当前 stub 化（demo 用 xlsx CDN，本项目未加 dep）
 */
import { computed, reactive, ref } from 'vue'
import { showToast } from '@/composables/useToast'

const COMBO_OPTIONS = [
  { suffix: 'A', multiplier: 2, label: 'x2' },
  { suffix: 'B', multiplier: 3, label: 'x3' },
  { suffix: 'D', multiplier: 5, label: 'x5' },
]

// Mock 商品数据 — demo 20 行原样
const productsBase = [
  { sku: '1001', barcode: '8801234567890', name: '韓國 CW 士多啤梨夾心軟曲奇 195g',  qty: 500,  boxQty: 24, remarks: '新貨', counted: 500 },
  { sku: '1002', barcode: '4901234567891', name: '日本 Calbee 薯片 海苔鹽味 170g',    qty: 300,  boxQty: 30, remarks: '',     counted: 210 },
  { sku: '1003', barcode: '8851234567892', name: '泰國 Mama 冬蔭功即食麵 90g',         qty: 800,  boxQty: 40, remarks: '熱賣', counted: 800 },
  { sku: '1004', barcode: '4710234567893', name: '台灣 維力 炸醬麵 85g',               qty: 450,  boxQty: 30, remarks: '',     counted: 450 },
  { sku: '1005', barcode: '8801234567894', name: '韓國 農心 辛辣麵 120g',              qty: 1200, boxQty: 40, remarks: '熱賣', counted: 960 },
  { sku: '1006', barcode: '4901234567895', name: '日本 明治 草莓巧克力 46g',           qty: 200,  boxQty: 20, remarks: '新貨', counted: 200 },
  { sku: '1007', barcode: '9551234567896', name: '馬來西亞 Munchy 餅乾 300g',          qty: 350,  boxQty: 14, remarks: '',     counted: 280 },
  { sku: '1008', barcode: '8801234567897', name: '韓國 Lotte 杏仁巧克力棒 46g',        qty: 600,  boxQty: 24, remarks: '',     counted: 600 },
  { sku: '1009', barcode: '4901234567898', name: '日本 UCC 即溶咖啡 90g',              qty: 150,  boxQty: 10, remarks: '新貨', counted: 620 },
  { sku: '1010', barcode: '8851234567899', name: '泰國 大哥 花生豆 230g',              qty: 400,  boxQty: 20, remarks: '',     counted: 0   },
  { sku: '1011', barcode: '8801234567900', name: '韓國 三養 火辣雞麵 140g',            qty: 900,  boxQty: 40, remarks: '熱賣', counted: 720 },
  { sku: '1012', barcode: '4901234567901', name: '日本 龜田 柿種米菓 200g',            qty: 250,  boxQty: 12, remarks: '',     counted: 250 },
  { sku: '1013', barcode: '4710234567902', name: '台灣 義美 小泡芙 65g',               qty: 550,  boxQty: 24, remarks: '',     counted: 0   },
  { sku: '1014', barcode: '8801234567903', name: '韓國 Binggrae 香蕉牛奶 200ml',       qty: 1000, boxQty: 24, remarks: '',     counted: 800 },
  { sku: '1015', barcode: '4901234567904', name: '日本 不二家 牛奶糖 120g',            qty: 180,  boxQty: 12, remarks: '新貨', counted: 0   },
  { sku: '1016', barcode: '8801234567905', name: '韓國 海太 蜂蜜薯片 60g',             qty: 720,  boxQty: 24, remarks: '',     counted: 360 },
  { sku: '1017', barcode: '4901234567906', name: '日本 固力果 百力滋 75g',             qty: 330,  boxQty: 12, remarks: '',     counted: 0   },
  { sku: '1018', barcode: '8851234567907', name: '泰國 小老闆 海苔卷 36g',             qty: 480,  boxQty: 24, remarks: '',     counted: 480 },
  { sku: '1019', barcode: '4710234567908', name: '台灣 統一 肉燥麵 85g',               qty: 650,  boxQty: 30, remarks: '',     counted: 0   },
  { sku: '1020', barcode: '8801234567909', name: '韓國 Orion 巧克力派 360g',           qty: 280,  boxQty: 12, remarks: '',     counted: 0   },
]

// 状态
const entered = ref(false)
const poInput = ref('12345')
const currentPO = ref('')
const search = ref('')

const rows = reactive(
  productsBase.map(p => ({ ...p, tpl: '', ws: '', extra: ['', ''], combos: [] })),
)
const extraCols = reactive([
  { name: '', active: false },
  { name: '', active: false },
])

const openMenuIdx = ref(null)

// ========== 计算 ==========
const activeExtraCols = computed(() =>
  extraCols.map((c, i) => ({ ...c, index: i })).filter(c => c.active),
)
const canAddCol = computed(() => extraCols.some(c => !c.active))

const filteredRows = computed(() => {
  if (!search.value.trim()) return rows
  const q = search.value.toLowerCase()
  return rows.filter(
    r => r.sku.includes(q) || r.barcode.includes(q) || r.name.toLowerCase().includes(q),
  )
})

function calcSD4(r) {
  let used = (parseInt(r.tpl) || 0) + (parseInt(r.ws) || 0)
  extraCols.forEach((c, i) => {
    if (c.active) used += parseInt(r.extra[i]) || 0
  })
  const comboUsed = r.combos.reduce((s, c) => s + (parseInt(c.tpl) || 0) * c.multiplier, 0)
  return r.qty - used - comboUsed
}

function calcTotalBoxes(r) {
  const b = parseInt(r.boxQty)
  return (!b || b <= 0) ? '—' : Math.ceil(r.qty / b)
}

function calcTplBoxes(r) {
  const t = parseInt(r.tpl) || 0, b = parseInt(r.boxQty) || 0
  if (!t || !b) return ''
  return `(${parseFloat((t / b).toFixed(4))}箱)`
}

function sd4Class(v) {
  if (v < 0)  return 'bg-red-100 text-red-700'
  if (v === 0) return 'bg-green-100 text-green-700'
  return 'bg-gray-100 text-gray-700'
}

// 合计行
const footerStats = computed(() => {
  let tQ = 0, tCo = 0, tT = 0, tW = 0, tS = 0
  const tE = extraCols.map(() => 0)
  filteredRows.value.forEach(r => {
    tQ += r.qty
    tCo += r.counted || 0
    tT += parseInt(r.tpl) || 0
    r.combos.forEach(c => { tT += (parseInt(c.tpl) || 0) * c.multiplier })
    tW += parseInt(r.ws) || 0
    tS += calcSD4(r)
    extraCols.forEach((c, i) => { if (c.active) tE[i] += parseInt(r.extra[i]) || 0 })
  })
  return { tQ, tCo, tT, tW, tS, tE }
})

// ========== 操作 ==========
function enterPO() {
  const v = poInput.value.trim()
  if (!v) { showToast('請輸入PO', 'warning'); return }
  if (v !== '12345') { showToast('找不到此 PO', 'error'); return }
  currentPO.value = v
  entered.value = true
}

function backToEntry() { entered.value = false }

function addCol() {
  const i = extraCols.findIndex(c => !c.active)
  if (i !== -1) extraCols[i].active = true
}

function rmCol(i) { extraCols[i].active = false }

function toggleMenu(ri) {
  openMenuIdx.value = openMenuIdx.value === ri ? null : ri
}

function addCombo(ri, opt) {
  const r = rows[ri]
  if (r.combos.some(c => c.suffix === opt.suffix)) return
  r.combos.push({
    suffix: opt.suffix,
    multiplier: opt.multiplier,
    label: opt.label,
    sku: r.sku + opt.suffix,
    name: r.name + ' ' + opt.label,
    tpl: '',
  })
  openMenuIdx.value = null
}

function rmCombo(ri, ci) {
  rows[ri].combos.splice(ci, 1)
}

function comboHas(ri, suffix) {
  return rows[ri].combos.some(c => c.suffix === suffix)
}

function saveData() {
  const mismatch = rows.filter(r => r.counted !== r.qty).length
  showToast(mismatch ? `✅ 已儲存（${mismatch} 項現點不符）` : '✅ 已儲存', 'success')
}

function exportExcel() {
  // demo 用 xlsx CDN；本项目暂未加 dep，stub 占位
  showToast('✅ 已匯出（dep 未集成，模拟成功）', 'success')
}

function rowIndex(row) { return rows.indexOf(row) }
</script>

<template>
  <!-- ===== 入口 ===== -->
  <div v-if="!entered" class="m3b-entry h-full">
    <div class="bg-white rounded-2xl shadow-lg border border-gray-200 w-full max-w-sm overflow-hidden">
      <div class="px-8 pt-8 pb-5 text-center">
        <div class="text-5xl mb-3">📦</div>
        <h1 class="text-xl font-bold">收貨分配系統</h1>
        <p class="text-xs text-slate-400 mt-1">Receiving &amp; Distribution</p>
      </div>
      <div class="px-8 pb-8">
        <label class="block text-xs font-semibold text-slate-500 mb-1.5">PO Number</label>
        <input
          v-model="poInput"
          @keydown.enter="enterPO"
          class="g-input w-full text-center font-semibold font-mono mb-3"
          style="font-size:16px;"
          placeholder="請輸入 PO Number"
        />
        <button class="g-btn g-btn-blue w-full" style="padding:12px;" @click="enterPO">進入</button>
        <p class="text-center text-xs text-gray-300 mt-4">Demo — 輸入 12345</p>
      </div>
    </div>
  </div>

  <!-- ===== 主表 ===== -->
  <div v-else class="m3b flex flex-col h-full overflow-hidden">
    <!-- 顶部栏 -->
    <div class="bg-white border-b border-gray-200 px-5 py-3.5 flex-shrink-0">
      <div class="flex items-center justify-between flex-wrap gap-2.5">
        <div class="flex items-center gap-2.5">
          <button class="bg-transparent border-0 cursor-pointer text-slate-400 text-lg" @click="backToEntry">‹</button>
          <h1 class="text-base font-bold">收貨分配</h1>
          <span class="text-[11px] font-bold py-0.5 px-2.5 rounded-md" style="background:#dbeafe;color:#1d4ed8;">PO: {{ currentPO }}</span>
          <span class="text-xs text-slate-400">共 {{ rows.length }} 項</span>
        </div>
        <div class="flex items-center gap-2">
          <input
            v-model="search"
            class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg outline-none w-52"
            placeholder="搜尋 SKU / 名稱"
          />
          <button class="bg-emerald-600 text-white text-xs font-semibold px-4 py-1.5 rounded-lg border-0 cursor-pointer" @click="exportExcel">⬇ 匯出</button>
          <button class="bg-blue-600 text-white text-xs font-semibold px-4 py-1.5 rounded-lg border-0 cursor-pointer" @click="saveData">💾 儲存</button>
        </div>
      </div>
    </div>

    <!-- 表格 -->
    <div class="flex-1 overflow-auto p-4">
      <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div class="overflow-auto" style="max-height: calc(100vh - 220px);">
          <table class="w-full text-left text-xs border-collapse">
            <thead class="sticky top-0 z-10">
              <tr class="border-b-2 border-gray-200" style="background:#f9fafb;">
                <th class="px-2.5 py-2 text-center text-[11px] font-semibold text-gray-500">總數</th>
                <th class="px-2.5 py-2 text-center text-[11px]" style="color:#0d9488;background:#f0fdfa;">現點</th>
                <th class="px-2.5 py-2 text-center text-[11px] text-gray-500">箱入</th>
                <th class="px-2.5 py-2 text-center text-[11px] text-gray-500">總箱數</th>
                <th class="px-2.5 py-2 text-[11px] text-gray-500">Remarks</th>
                <th class="px-2.5 py-2 text-[11px] text-gray-500">Barcode</th>
                <th class="px-2.5 py-2 text-[11px] text-gray-500">SKU</th>
                <th class="px-2.5 py-2 text-[11px] text-gray-500">Name</th>
                <th class="px-2.5 py-2 text-center text-[11px]" style="color:#1d4ed8;background:#eff6ff;">3PL</th>
                <th class="px-2.5 py-2 text-center text-[11px]" style="color:#065f46;background:#ecfdf5;">WS</th>
                <th class="px-2.5 py-2 text-center text-[11px]" style="color:#5b21b6;background:#f5f3ff;">SD4</th>
                <th v-for="c in activeExtraCols" :key="c.index" class="px-1.5 py-2 text-center" style="background:#fffbeb;">
                  <input
                    v-model="extraCols[c.index].name"
                    placeholder="欄位名"
                    class="w-14 px-1 py-px text-[10px] text-center border rounded font-bold"
                    style="border-color:#fbbf24;color:#92400e;"
                  />
                  <button class="border-0 cursor-pointer text-gray-400 text-xs ml-0.5 bg-transparent" @click="rmCol(c.index)">✕</button>
                </th>
                <th v-if="canAddCol" class="px-1.5 py-2 text-center">
                  <button class="w-6 h-6 rounded-md text-white border-0 cursor-pointer text-sm" style="background:#f59e0b;" @click="addCol">+</button>
                </th>
                <th class="px-2.5 py-2 text-center text-[11px] text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in filteredRows" :key="row.sku">
                <tr class="border-b border-gray-100">
                  <td class="px-2.5 py-2 text-center font-semibold">{{ row.qty }}</td>
                  <td class="px-2.5 py-2 text-center" style="background:rgba(240,253,250,.4);">
                    <span class="text-xs font-bold" :class="row.counted === row.qty ? 'text-gray-800' : 'text-red-600'">{{ row.counted }}</span>
                  </td>
                  <td class="px-2.5 py-2 text-center text-xs text-gray-500">{{ row.boxQty || '—' }}</td>
                  <td class="px-2.5 py-2 text-center text-xs font-semibold" :class="calcTotalBoxes(row) === '—' ? 'text-gray-300' : 'text-gray-700'">{{ calcTotalBoxes(row) }}</td>
                  <td class="px-2.5 py-2 text-center text-xs text-gray-500">{{ row.remarks || '—' }}</td>
                  <td class="px-2.5 py-2 font-mono text-[11px] text-gray-500">{{ row.barcode }}</td>
                  <td class="px-2.5 py-2 font-mono text-[11px] font-bold">{{ row.sku }}</td>
                  <td class="px-2.5 py-2 text-xs max-w-[160px] truncate">{{ row.name }}</td>

                  <!-- 3PL -->
                  <td class="px-1.5 py-2 text-center" style="background:rgba(239,246,255,.4);">
                    <div class="flex items-center justify-center gap-0.5">
                      <input
                        v-model="row.tpl"
                        type="number"
                        min="0"
                        placeholder="0"
                        class="w-14 p-1 border rounded text-center text-xs font-semibold"
                        style="border-color:#bfdbfe;"
                      />
                      <span class="text-[10px] whitespace-nowrap" style="color:#93c5fd;">{{ calcTplBoxes(row) }}</span>
                    </div>
                  </td>

                  <!-- WS -->
                  <td class="px-1.5 py-2 text-center" style="background:rgba(236,253,245,.4);">
                    <input
                      v-model="row.ws"
                      type="number"
                      min="0"
                      placeholder="0"
                      class="w-14 p-1 border rounded text-center text-xs font-semibold"
                      style="border-color:#a7f3d0;"
                    />
                  </td>

                  <!-- SD4 (computed) -->
                  <td class="px-1.5 py-2 text-center" style="background:rgba(245,243,255,.4);">
                    <span class="inline-block min-w-[2rem] px-2 py-0.5 rounded-full text-xs font-bold" :class="sd4Class(calcSD4(row))">
                      {{ calcSD4(row) }}
                    </span>
                  </td>

                  <!-- 额外列 -->
                  <td v-for="c in activeExtraCols" :key="c.index" class="px-1 py-2 text-center" style="background:rgba(255,251,235,.4);">
                    <input
                      v-model="row.extra[c.index]"
                      type="number"
                      min="0"
                      placeholder="0"
                      class="w-14 p-1 border rounded text-center text-xs font-semibold"
                      style="border-color:#fcd34d;"
                    />
                  </td>
                  <td v-if="canAddCol"></td>

                  <!-- 操作 -->
                  <td class="px-2.5 py-2 text-center relative">
                    <button class="w-6 h-6 rounded-md text-white border-0 cursor-pointer text-xs" style="background:#2563eb;" @click="toggleMenu(rowIndex(row))">+</button>
                    <!-- combo 下拉菜单 -->
                    <div
                      v-if="openMenuIdx === rowIndex(row)"
                      class="absolute right-2 top-9 z-20 bg-white border border-gray-200 rounded-lg shadow-xl w-64 overflow-hidden"
                    >
                      <div class="px-3 py-2 text-[11px] font-bold text-gray-400" style="background:#f9fafb;border-bottom:1px solid #f3f4f6;">
                        選擇組合裝
                      </div>
                      <button
                        v-for="opt in COMBO_OPTIONS"
                        :key="opt.suffix"
                        class="flex justify-between items-center w-full px-3 py-2 text-left text-xs border-0 cursor-pointer bg-white hover:bg-gray-50"
                        :disabled="comboHas(rowIndex(row), opt.suffix)"
                        :class="comboHas(rowIndex(row), opt.suffix) ? 'opacity-40 cursor-not-allowed' : ''"
                        @click="addCombo(rowIndex(row), opt)"
                      >
                        <span>{{ row.sku + opt.suffix }} {{ opt.label }}</span>
                        <span v-if="comboHas(rowIndex(row), opt.suffix)" class="text-emerald-600">✓</span>
                      </button>
                    </div>
                  </td>
                </tr>

                <!-- combo 子行 -->
                <tr v-for="(c, ci) in row.combos" :key="c.sku" class="border-b border-gray-50" style="background:linear-gradient(90deg,#eff6ff,transparent);">
                  <td class="px-2.5 py-1.5 text-gray-300">—</td>
                  <td class="px-2.5 py-1.5 text-gray-300">—</td>
                  <td class="px-2.5 py-1.5 text-gray-300">—</td>
                  <td class="px-2.5 py-1.5 text-gray-300">—</td>
                  <td class="px-2.5 py-1.5 text-gray-300">—</td>
                  <td class="px-2.5 py-1.5 text-gray-300">—</td>
                  <td class="px-2.5 py-1.5">
                    <span class="text-[11px] text-blue-500">↳</span>
                    <span class="font-mono text-[11px] font-bold ml-1" style="color:#2563eb;">{{ c.sku }}</span>
                  </td>
                  <td class="px-2.5 py-1.5 text-[11px] text-gray-500">{{ c.name }}</td>
                  <td class="px-1.5 py-1.5 text-center" style="background:rgba(239,246,255,.4);">
                    <input
                      v-model="c.tpl"
                      type="number"
                      min="0"
                      placeholder="0"
                      class="w-14 p-1 border rounded text-center text-xs font-semibold"
                      style="border-color:#bfdbfe;"
                    />
                  </td>
                  <td class="px-1.5 py-1.5 text-gray-300 text-center">—</td>
                  <td class="px-1.5 py-1.5 text-gray-300 text-center">—</td>
                  <td v-for="ec in activeExtraCols" :key="ec.index" class="px-1 py-1.5 text-gray-300 text-center">—</td>
                  <td v-if="canAddCol"></td>
                  <td class="px-2.5 py-1.5 text-center">
                    <button class="border-0 cursor-pointer text-red-400 text-sm bg-transparent" @click="rmCombo(rowIndex(row), ci)">✕</button>
                  </td>
                </tr>
              </template>
            </tbody>
            <tfoot class="sticky bottom-0 z-10">
              <tr class="font-semibold text-xs" style="background:#f3f4f6;border-top:2px solid #d1d5db;">
                <td class="px-2.5 py-2 text-center">{{ footerStats.tQ }}</td>
                <td class="px-2.5 py-2 text-center" style="background:#f0fdfa;">
                  <span class="font-bold" :class="footerStats.tCo === footerStats.tQ ? 'text-gray-800' : 'text-red-600'">{{ footerStats.tCo }}</span>
                </td>
                <td></td><td></td><td></td><td></td>
                <td class="px-2.5 py-2">合計</td>
                <td></td>
                <td class="px-2.5 py-2 text-center" style="color:#1d4ed8;background:#eff6ff;">{{ footerStats.tT }}</td>
                <td class="px-2.5 py-2 text-center" style="color:#065f46;background:#ecfdf5;">{{ footerStats.tW }}</td>
                <td class="px-2.5 py-2 text-center" style="background:#f5f3ff;">
                  <span class="inline-block min-w-[2rem] px-2 py-0.5 rounded-full text-xs font-bold" :class="sd4Class(footerStats.tS)">{{ footerStats.tS }}</span>
                </td>
                <td v-for="c in activeExtraCols" :key="c.index" class="px-1 py-2 text-center" style="background:#fffbeb;color:#92400e;">{{ footerStats.tE[c.index] }}</td>
                <td v-if="canAddCol"></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
