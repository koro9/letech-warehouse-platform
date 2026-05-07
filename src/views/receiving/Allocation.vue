<script setup>
/**
 * 收貨分配 (M3b) — 接 Odoo PO 真后端
 *
 * 流程：
 *   1. PO 入口 → 输入 PO 单号 → getAllocation → 拉所有 line + 上次分配数据
 *      错误:
 *        - 404 po_not_found:        toast「找不到 PO」
 *        - 422 po_state_not_allowed: toast「狀態不允許」+ 显示具体 state
 *        - 403 not_authorized:       toast「僅限內部員工」
 *   2. 主表格：员工录入 3PL/WS/额外列/Combo 子行（UI 复刻 demo）
 *      - extra cols 输入框带 autocomplete（搜 Odoo stock.warehouse）
 *      - combo 候选来自每行 combo_options（mrp.bom 反查）
 *   3. 顶部：搜索 / 匯出 / 儲存
 *
 * 多用户协作 — 行级乐观锁：
 *   - dirtyLineIds 跟踪用户改过哪些行
 *   - save 时只送 dirty rows，每行带 _last_modified_at
 *   - 后端冲突 → 207 → 弹 modal 让用户决定 keep/accept
 *
 * Combo 子行（决策已敲定）：
 *   母件 SKU 后缀（A/B/C 等单字母）由后端 combo_options[].suffix 提供
 *   前端不写死 COMBO_OPTIONS，按行的 combo_options 动态展示候选
 *
 * Excel 导出当前 stub 化（demo 用 xlsx CDN，本项目未加 dep）
 */
import { computed, reactive, ref, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import * as XLSX from 'xlsx'
import { po as poApi } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import RefreshButton from '@/components/RefreshButton.vue'

// ============================================================
// 状态
// ============================================================
const entered = ref(false)
const poInput = ref('')
const currentPO = ref('')
const partnerName = ref('')
const datePlanned = ref('')
const poState = ref('')
const search = ref('')
const loading = ref(false)
const saving = ref(false)

// rows 改成空数组，由 API 填充。每行结构跟后端 _serialize_po_line 对齐：
//   { po_line_id, sku, barcode, name, qty, box_qty, remarks, counted,
//     tpl, ws, extra, combos, combo_options,
//     last_modified_at, last_modified_by }
const rows = reactive([])
const extraCols = reactive([
  { name: '', active: false },
  { name: '', active: false },
])

// dirty tracking — 用户改过哪些行（save 时只送这些）
const dirtyLineIds = reactive(new Set())

// 顶部 + 按钮菜单
const openMenuIdx = ref(null)

// combo 下拉菜单 — Teleport 到 body 渲染，按按钮坐标定位（避开表格 overflow 裁切）
// dropdownPos: 视口坐标（用于 position: fixed）
// dropdownPlacement: 'below' / 'above'（下方放不下时翻到上方）
const DROPDOWN_W = 288   // 跟 Tailwind w-72 对齐
const DROPDOWN_H = 240   // 估算高度（标题 + 至多 5 个候选）
const dropdownPos = ref({ top: 0, left: 0 })
const dropdownPlacement = ref('below')

// 当前 open 菜单对应的 row 数据（dropdown 渲染需要 row.combo_options）
const activeRow = computed(() => {
  if (openMenuIdx.value == null) return null
  return filteredRows.value.find(r => rowIndex(r) === openMenuIdx.value) || null
})

// ============================================================
// 表格底部 spacer — 动态高度让 tfoot 贴近 scroll 容器底部
// ============================================================
// 数据少时 thead+rows+tfoot 远小于容器 min-height，会留一大片空白在 tfoot 下面。
// 用一个 spacer 行把"剩余空间"填掉，让合計行视觉上落到底。
//
// 计算约定（粗略估值，跨浏览器/字体允许 ±5px 误差）：
//   thead + tfoot ≈ 70px 固定开销
//   每条主数据行 ≈ 38px
//   combo 子行 ≈ 30px
// 跟下面 scroll 容器的 min-height: 220px 配套调整 — 改这两个值时记得对齐。
const TABLE_MIN_H = 220
const HEAD_FOOT_H = 70
const DATA_ROW_H = 38
const COMBO_ROW_H = 30
const SPACER_MIN = 16

const spacerHeight = computed(() => {
  const rows = filteredRows.value
  if (rows.length === 0) return 0
  let consumed = HEAD_FOOT_H + rows.length * DATA_ROW_H
  for (const r of rows) {
    consumed += (r.combos?.length || 0) * COMBO_ROW_H
  }
  return Math.max(TABLE_MIN_H - consumed, SPACER_MIN)
})

// 仓库 autocomplete suggestions（最近一次搜索结果）
const whSuggestions = ref([])
const whAutocompleteIdx = ref(-1)   // 当前打开 autocomplete 的 extraCols index
let whSearchTimer = null

// 冲突 modal
const conflictModal = reactive({
  open: false,
  conflicts: [],
  // 用户对每个冲突的选择：'keep' | 'accept'
  resolutions: {},
})

// ============================================================
// 计算
// ============================================================
const activeExtraCols = computed(() =>
  extraCols.map((c, i) => ({ ...c, index: i })).filter(c => c.active),
)
const canAddCol = computed(() => extraCols.some(c => !c.active))

const filteredRows = computed(() => {
  if (!search.value.trim()) return rows
  const q = search.value.toLowerCase()
  return rows.filter(
    r => (r.sku || '').toLowerCase().includes(q)
      || (r.barcode || '').toLowerCase().includes(q)
      || (r.name || '').toLowerCase().includes(q),
  )
})

function calcSD4(r) {
  let used = (parseInt(r.tpl) || 0) + (parseInt(r.ws) || 0)
  extraCols.forEach((c, i) => {
    if (c.active) used += parseInt((r.extra && r.extra[i] && r.extra[i].qty) || 0) || 0
  })
  const comboUsed = (r.combos || []).reduce(
    (s, c) => s + (parseInt(c.tpl) || 0) * (c.multiplier || 1), 0,
  )
  return (r.qty || 0) - used - comboUsed
}

function calcTotalBoxes(r) {
  // 直接读后端 store=True compute 字段（purchase.order.line.wms_total_boxes）
  // 0 表示 box_qty 未填，UI 显示 '—'
  return r.total_boxes && r.total_boxes > 0 ? r.total_boxes : '—'
}

// 员工录入 box_qty 瞬间就显示总箱数（不等 save → 后端 recompute → 重 GET）
// box_qty 还没保存前后端 total_boxes 是旧值，前端 ceil 即时算更准
function liveTotalBoxes(r) {
  const b = parseInt(r.box_qty)
  if (!b || b <= 0) return '—'
  return Math.ceil((r.qty || 0) / b)
}

function calcTplBoxes(r) {
  const t = parseInt(r.tpl) || 0, b = parseInt(r.box_qty) || 0
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
    tQ += r.qty || 0
    tCo += (r.counted == null ? 0 : r.counted)
    tT += parseInt(r.tpl) || 0
    ;(r.combos || []).forEach(c => { tT += (parseInt(c.tpl) || 0) * (c.multiplier || 1) })
    tW += parseInt(r.ws) || 0
    tS += calcSD4(r)
    extraCols.forEach((c, i) => {
      if (c.active) tE[i] += parseInt((r.extra && r.extra[i] && r.extra[i].qty) || 0) || 0
    })
  })
  return { tQ, tCo, tT, tW, tS, tE }
})

// ============================================================
// 加载 PO
// ============================================================
async function enterPO() {
  const v = poInput.value.trim()
  if (!v) { showToast('請輸入 PO 單號', 'warning'); return }
  loading.value = true
  try {
    const res = await poApi.getAllocation(v)
    // 填充
    currentPO.value = res.po_name
    partnerName.value = res.partner_name || ''
    datePlanned.value = res.date_planned || ''
    poState.value = res.state
    rows.splice(0, rows.length,
      ...(res.rows || []).map(r => ({
        ...r,
        // 保证字段存在，避免 v-model 出错
        tpl:    r.tpl ?? '',
        ws:     r.ws ?? '',
        extra:  Array.isArray(r.extra) && r.extra.length >= 2
                  ? r.extra
                  : [{ qty: 0 }, { qty: 0 }],
        combos: Array.isArray(r.combos) ? r.combos : [],
      })),
    )
    const ec = res.extra_cols || []
    extraCols[0] = ec[0] || { name: '', active: false }
    extraCols[1] = ec[1] || { name: '', active: false }
    dirtyLineIds.clear()
    entered.value = true
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 404) {
      showToast(`❌ 找不到 PO「${v}」`, 'error')
    } else if (status === 422) {
      showToast(`⚠️ ${data.detail || `此 PO 狀態（${data.state}）不允許進入分配`}`, 'warning')
    } else if (status === 403) {
      showToast(`⚠️ ${data.detail || '此功能僅限內部員工'}`, 'error')
    } else {
      showToast(data.error || '載入失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

function backToEntry() {
  if (dirtyLineIds.size > 0
      && !confirm(`有 ${dirtyLineIds.size} 行未儲存的修改，確定離開？`)) {
    return
  }
  entered.value = false
  rows.splice(0, rows.length)
  dirtyLineIds.clear()
}

// 顶部 🔄 刷新 — 重新拉数据，但保留用户当前的 dirty 输入会有冲突，
// 所以提示一下让用户确认
async function refreshData() {
  if (!entered.value) return
  if (dirtyLineIds.size > 0
      && !confirm(`有 ${dirtyLineIds.size} 行未儲存的修改，刷新會丟失。確定？`)) {
    return
  }
  poInput.value = currentPO.value
  await enterPO()
  showToast('✅ 已刷新', 'success')
}
const { refreshNow } = usePageRefresh(refreshData)

// ============================================================
// Dirty tracking — 把 row 的字段变化映射到 dirtyLineIds
// ============================================================
function markDirty(row) {
  if (row && row.po_line_id) dirtyLineIds.add(row.po_line_id)
}

// ============================================================
// 仓库 autocomplete
// ============================================================
function openWhAutocomplete(idx) {
  whAutocompleteIdx.value = idx
  searchWh(extraCols[idx].name)
}

function closeWhAutocomplete() {
  setTimeout(() => { whAutocompleteIdx.value = -1 }, 150)   // 给 click 留时间
}

function onWhInput(idx) {
  // 输入时 debounced 搜
  whAutocompleteIdx.value = idx
  if (whSearchTimer) clearTimeout(whSearchTimer)
  whSearchTimer = setTimeout(() => {
    searchWh(extraCols[idx].name)
  }, 200)
}

async function searchWh(q) {
  try {
    const res = await poApi.searchWarehouses(q || '')
    whSuggestions.value = res.warehouses || []
  } catch {
    whSuggestions.value = []
  }
}

function pickWh(idx, suggestion) {
  extraCols[idx].name = suggestion.code || suggestion.name
  whAutocompleteIdx.value = -1
}

// ============================================================
// Combo / extra cols
// ============================================================
function addCol() {
  const i = extraCols.findIndex(c => !c.active)
  if (i !== -1) extraCols[i].active = true
}

function rmCol(i) {
  extraCols[i].active = false
  // 清掉所有 row 的该 extra 列输入
  rows.forEach(r => {
    if (r.extra && r.extra[i]) {
      r.extra[i].qty = 0
      markDirty(r)
    }
  })
}

function toggleMenu(ri, btnEl) {
  if (openMenuIdx.value === ri) {
    openMenuIdx.value = null
    return
  }
  openMenuIdx.value = ri
  // nextTick 等 v-if 的 dropdown DOM 出来后（虽然 fixed 定位不依赖 DOM 已挂载，
  // 但保持惯例统一）。位置用按钮当前 rect 现算。
  if (btnEl) {
    nextTick(() => positionDropdown(btnEl))
  }
}

function positionDropdown(btnEl) {
  const rect = btnEl.getBoundingClientRect()
  const GAP = 4
  const PAD = 8

  // 水平：dropdown 右边缘对齐到按钮右边缘（跟原 right-2 视觉一致）
  // 视口边界夹住，避免超出右边
  let left = rect.right - DROPDOWN_W
  if (left < PAD) left = PAD
  if (left + DROPDOWN_W > window.innerWidth - PAD) {
    left = window.innerWidth - DROPDOWN_W - PAD
  }

  // 垂直：默认按钮下方；下方空间不够就翻到上方
  const spaceBelow = window.innerHeight - rect.bottom - PAD
  let top
  if (spaceBelow >= DROPDOWN_H) {
    top = rect.bottom + GAP
    dropdownPlacement.value = 'below'
  } else if (rect.top - PAD >= DROPDOWN_H) {
    top = rect.top - DROPDOWN_H - GAP
    dropdownPlacement.value = 'above'
  } else {
    // 上下都不够（小窗口）— 取较大那侧 + 让浏览器在 dropdown 内部 scroll
    if (spaceBelow >= rect.top - PAD) {
      top = rect.bottom + GAP
      dropdownPlacement.value = 'below'
    } else {
      top = PAD
      dropdownPlacement.value = 'above'
    }
  }

  dropdownPos.value = { top, left }
}

// ============================================================
// combo 菜单关闭事件 — 仅在 open 时挂监听，避免空跑
// ============================================================
function onMenuScroll() { openMenuIdx.value = null }
function onMenuResize() { openMenuIdx.value = null }
function onMenuEsc(e) { if (e.key === 'Escape') openMenuIdx.value = null }
function onMenuOutsideClick(e) {
  // 点击在按钮自身或 dropdown 内部 → 不关
  const target = e.target
  if (!target || !target.closest) return
  if (target.closest('[data-combo-trigger]') || target.closest('[data-combo-dropdown]')) return
  openMenuIdx.value = null
}

watch(openMenuIdx, (val) => {
  if (val != null) {
    // capture=true 才能监听到内部 scroll 容器（默认 bubbling 不冒泡 scroll 事件）
    window.addEventListener('scroll', onMenuScroll, true)
    window.addEventListener('resize', onMenuResize)
    window.addEventListener('keydown', onMenuEsc)
    window.addEventListener('mousedown', onMenuOutsideClick)
  } else {
    window.removeEventListener('scroll', onMenuScroll, true)
    window.removeEventListener('resize', onMenuResize)
    window.removeEventListener('keydown', onMenuEsc)
    window.removeEventListener('mousedown', onMenuOutsideClick)
  }
})

function addCombo(ri, opt) {
  const r = rows[ri]
  if (r.combos.some(c => c.sku === opt.sku)) return
  r.combos.push({
    suffix: opt.suffix,
    multiplier: opt.multiplier,
    label: opt.label,
    sku: opt.sku,
    name: opt.name,
    tpl: '',
  })
  markDirty(r)
  openMenuIdx.value = null
}

function rmCombo(ri, ci) {
  rows[ri].combos.splice(ci, 1)
  markDirty(rows[ri])
}

function comboHas(ri, sku) {
  return rows[ri].combos.some(c => c.sku === sku)
}

// ============================================================
// 保存（增量 + 行级乐观锁）
// ============================================================
async function saveData() {
  if (saving.value) return
  if (dirtyLineIds.size === 0) {
    showToast('沒有需要儲存的修改', 'warning')
    return
  }
  saving.value = true
  try {
    // 收集 dirty rows
    const dirtyRows = rows
      .filter(r => dirtyLineIds.has(r.po_line_id))
      .map(r => ({
        po_line_id: r.po_line_id,
        tpl: parseInt(r.tpl) || 0,
        ws:  parseInt(r.ws) || 0,
        extra: (r.extra || []).map(e => ({ qty: parseInt(e.qty) || 0 })),
        combos: (r.combos || []).map(c => ({
          sku: c.sku,
          suffix: c.suffix,
          multiplier: c.multiplier,
          tpl: parseInt(c.tpl) || 0,
        })),
        box_qty: parseInt(r.box_qty) || 0,
        _last_modified_at: r.last_modified_at,
      }))

    const payload = {
      rows: dirtyRows,
      extra_cols: extraCols.map(c => ({ name: c.name, active: c.active })),
    }

    const res = await poApi.saveAllocation(currentPO.value, payload)

    // 200 ok
    if (res.ok) {
      // 移除已保存的 dirty 标记 + 把行的 last_modified_at 同步到服务器最新
      // （否则员工保存后立即再改同一行 → 第二次 save 会跟"自己刚保存的版本"冲突）
      const newTs = res.server_time
      ;(res.saved || []).forEach(id => {
        dirtyLineIds.delete(id)
        const row = rows.find(r => r.po_line_id === id)
        if (row && newTs) row.last_modified_at = newTs
      })
      const n = (res.saved || []).length
      showToast(`✅ 已儲存 ${n} 行`, 'success')
    } else {
      // 不应该走到这（207 在拦截器抛错走 catch）
      showToast('儲存回應異常', 'warning')
    }
  } catch (err) {
    if (err.handledByInterceptor) {
      saving.value = false
      return
    }
    const status = err.response?.status
    const data = err.response?.data || {}
    // 207 — 部分冲突
    if (status === 207) {
      ;(data.saved || []).forEach(id => dirtyLineIds.delete(id))
      conflictModal.conflicts = data.conflicts || []
      conflictModal.resolutions = {}
      data.conflicts.forEach(c => {
        conflictModal.resolutions[c.po_line_id] = 'keep'   // 默认保留我的
      })
      conflictModal.open = true
      showToast(
        `⚠️ ${data.conflicts.length} 行有衝突，已保存 ${(data.saved || []).length} 行`,
        'warning',
      )
    } else if (status === 403) {
      showToast(data.detail || '無權限儲存', 'error')
    } else if (status === 404) {
      showToast('PO 不存在（可能已被刪除）', 'error')
    } else if (status === 422) {
      showToast(data.detail || '此 PO 狀態不允許儲存', 'warning')
    } else {
      showToast(data.error || '儲存失敗', 'error')
    }
  } finally {
    saving.value = false
  }
}

// ============================================================
// 冲突 modal — 用户选 keep/accept 后再次提交
// ============================================================
function pickResolution(poLineId, choice) {
  conflictModal.resolutions[poLineId] = choice
}

async function applyResolutions() {
  if (saving.value) return
  // 把选 'accept' 的：用 server_data 覆盖到 row + 移除 dirty
  // 把选 'keep' 的：保留我的输入，重新更新 row 的 _last_modified_at 为服务器最新时间，再 save
  const acceptIds = []
  const keepRows = []
  for (const c of conflictModal.conflicts) {
    const choice = conflictModal.resolutions[c.po_line_id]
    const row = rows.find(r => r.po_line_id === c.po_line_id)
    if (!row) continue
    if (choice === 'accept') {
      // 接受服务器版本
      Object.assign(row, {
        tpl:    c.server_data.tpl ?? '',
        ws:     c.server_data.ws ?? '',
        extra:  Array.isArray(c.server_data.extra) && c.server_data.extra.length >= 2
                  ? c.server_data.extra
                  : [{ qty: 0 }, { qty: 0 }],
        combos: Array.isArray(c.server_data.combos) ? c.server_data.combos : [],
        last_modified_at: c.modified_at,
      })
      dirtyLineIds.delete(c.po_line_id)
      acceptIds.push(c.po_line_id)
    } else {
      // 保留我的 — 把 last_modified_at 更新为服务器最新值（让下次提交不再撞）
      row.last_modified_at = c.modified_at
      keepRows.push({
        po_line_id: row.po_line_id,
        tpl: parseInt(row.tpl) || 0,
        ws:  parseInt(row.ws) || 0,
        extra: (row.extra || []).map(e => ({ qty: parseInt(e.qty) || 0 })),
        combos: (row.combos || []).map(cc => ({
          sku: cc.sku, suffix: cc.suffix, multiplier: cc.multiplier,
          tpl: parseInt(cc.tpl) || 0,
        })),
        _last_modified_at: row.last_modified_at,
      })
    }
  }

  conflictModal.open = false
  conflictModal.conflicts = []
  conflictModal.resolutions = {}

  if (keepRows.length === 0) {
    if (acceptIds.length) showToast(`已採用 ${acceptIds.length} 行的伺服器版本`, 'success')
    return
  }

  // 重新提交"保留我的"那些行
  saving.value = true
  try {
    const res = await poApi.saveAllocation(currentPO.value, { rows: keepRows })
    if (res.ok) {
      const newTs = res.server_time
      ;(res.saved || []).forEach(id => {
        dirtyLineIds.delete(id)
        const row = rows.find(r => r.po_line_id === id)
        if (row && newTs) row.last_modified_at = newTs
      })
      showToast(`✅ 已覆蓋儲存 ${(res.saved || []).length} 行`, 'success')
    }
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    if (status === 207) {
      // 又冲突 — 极少见，提示重试
      showToast('⚠️ 數據又被改了，請刷新後重試', 'error')
    } else {
      showToast(err.response?.data?.error || '儲存失敗', 'error')
    }
  } finally {
    saving.value = false
  }
}

function cancelConflictModal() {
  conflictModal.open = false
  conflictModal.conflicts = []
  conflictModal.resolutions = {}
}

// ============================================================
// 导出 Excel — 前端用 xlsx 库即时生成下载
// ============================================================
// 文件结构：
//   顶部 metadata：PO 號 / 供應商 / 計劃日期
//   表头：跟 UI 表格一致（不含"操作"列）
//   数据行：每个商品一主行 + 每个 combo 子行（缩进 ↳ 标记）
//   底部：合計行
function exportExcel() {
  if (!entered.value || rows.length === 0) {
    showToast('沒有資料可匯出', 'warning')
    return
  }

  // 取当前激活的额外列名（按显示顺序）
  const extraColIdxs = activeExtraCols.value.map(c => c.index)
  const extraColNames = extraColIdxs.map(i => extraCols[i].name || '額外仓')

  // 表头
  const header = [
    '總數', '現點', '箱入', '總箱數',
    'Remarks', 'Barcode', 'SKU', 'Name',
    '3PL', 'WS', 'SD4',
    ...extraColNames,
  ]

  // 数据行
  const dataRows = []
  rows.forEach(r => {
    // 主行
    dataRows.push([
      r.qty || 0,
      r.counted == null ? '' : r.counted,
      r.box_qty || '',
      r.total_boxes || '',
      r.remarks || '',
      r.barcode || '',
      r.sku || '',
      r.name || '',
      parseInt(r.tpl) || 0,
      parseInt(r.ws) || 0,
      calcSD4(r),
      ...extraColIdxs.map(i => parseInt(r.extra?.[i]?.qty) || 0),
    ])
    // combo 子行（缩进 + 只填 3PL）
    ;(r.combos || []).forEach(c => {
      dataRows.push([
        '', '', '', '',                     // 总数/现点/箱入/总箱数 空
        '', '',                              // Remarks/Barcode 空
        `↳ ${c.sku}`,                        // SKU 缩进
        `${c.name || ''} ${c.label || ''}`.trim(),
        parseInt(c.tpl) || 0,                // 3PL
        '', '',                              // WS / SD4 空
        ...extraColIdxs.map(() => ''),
      ])
    })
  })

  // 合计行
  const fs = footerStats.value
  const footerRow = [
    fs.tQ, fs.tCo,
    '', '', '', '',
    '合計', '',
    fs.tT, fs.tW, fs.tS,
    ...extraColIdxs.map(i => fs.tE[i] || 0),
  ]

  // 顶部 metadata
  const sheetData = [
    ['PO 號', currentPO.value],
    ['供應商', partnerName.value || '—'],
    ['計劃日期', datePlanned.value || '—'],
    [],   // 空行分隔
    header,
    ...dataRows,
    [],   // 空行
    footerRow,
  ]

  const ws = XLSX.utils.aoa_to_sheet(sheetData)

  // 列宽（粗略给点空间，让默认显示更友好）
  ws['!cols'] = [
    { wch: 8 },   // 總數
    { wch: 8 },   // 現點
    { wch: 6 },   // 箱入
    { wch: 8 },   // 總箱數
    { wch: 12 },  // Remarks
    { wch: 16 },  // Barcode
    { wch: 14 },  // SKU
    { wch: 32 },  // Name
    { wch: 8 },   // 3PL
    { wch: 8 },   // WS
    { wch: 8 },   // SD4
    ...extraColIdxs.map(() => ({ wch: 10 })),
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '收貨分配')

  // 文件名：分配_PO12345_YYYYMMDD_HHMM.xlsx
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`
  const filename = `分配_${currentPO.value}_${ts}.xlsx`

  XLSX.writeFile(wb, filename)
  showToast(`✅ 已匯出 ${rows.length} 行`, 'success')
}

function rowIndex(row) { return rows.indexOf(row) }

// ============================================================
// 路由 / 浏览器离开守卫 — dirty 时拦下让员工确认
// ============================================================
// 3 个层次：
//   1. backToEntry()   — 页面内返回按钮（已经做过 confirm）
//   2. onBeforeRouteLeave  — Vue Router 切别的页面时拦
//   3. window.beforeunload — 关浏览器 tab / 刷新页面时拦
//
// 浏览器 beforeunload 不能自定义文案（出于安全/防钓鱼），只能弹标准
// "確定要離開？資料未儲存可能丟失" 的 native 对话框

function hasDirty() {
  return entered.value && dirtyLineIds.size > 0
}

onBeforeRouteLeave((to, from, next) => {
  if (hasDirty() && !confirm(`有 ${dirtyLineIds.size} 行未儲存的修改，離開將丟失。確定？`)) {
    next(false)
  } else {
    next()
  }
})

function _onBeforeUnload(e) {
  if (!hasDirty()) return
  // 大多数现代浏览器忽略自定义 returnValue 文案，只看是否阻止默认事件
  e.preventDefault()
  e.returnValue = ''
}

onMounted(() => {
  window.addEventListener('beforeunload', _onBeforeUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', _onBeforeUnload)
  // combo 菜单 listener 清理（防菜单还开着时用户切走路由 → leak）
  // watch 在 openMenuIdx 不变的情况下不会再触发，所以这里强制 detach
  window.removeEventListener('scroll', onMenuScroll, true)
  window.removeEventListener('resize', onMenuResize)
  window.removeEventListener('keydown', onMenuEsc)
  window.removeEventListener('mousedown', onMenuOutsideClick)
})
</script>

<template>
  <!-- ===== 入口 ===== -->
  <div v-if="!entered" class="m3b-entry h-full p-4">
    <div class="bg-white rounded-2xl shadow-lg border border-gray-200 w-full max-w-sm overflow-hidden">
      <div class="px-6 sm:px-8 pt-6 sm:pt-8 pb-5 text-center">
        <div class="text-4xl sm:text-5xl mb-3">📦</div>
        <h1 class="text-lg sm:text-xl font-bold">收貨分配系統</h1>
        <p class="text-xs text-slate-400 mt-1">Receiving &amp; Distribution</p>
      </div>
      <div class="px-6 sm:px-8 pb-6 sm:pb-8">
        <label class="block text-xs font-semibold text-slate-500 mb-1.5">PO Number</label>
        <input
          v-model="poInput"
          @keydown.enter="enterPO"
          class="g-input w-full text-center font-semibold font-mono mb-3"
          style="font-size:16px;"
          placeholder="輸入 PO 單號"
          autocomplete="off"
          :disabled="loading"
        />
        <button class="g-btn g-btn-blue w-full" style="padding:12px;"
                :disabled="loading" @click="enterPO">
          {{ loading ? '載入中…' : '進入' }}
        </button>
      </div>
    </div>
  </div>

  <!-- ===== 主表 ===== -->
  <div v-else class="m3b flex flex-col h-full overflow-hidden">
    <!-- 顶部栏 -->
    <div class="bg-white border-b border-gray-200 px-3 sm:px-5 py-3 sm:py-3.5 flex-shrink-0">
      <div class="flex items-center justify-between flex-wrap gap-2.5">
        <div class="flex items-center gap-2 sm:gap-2.5 flex-wrap min-w-0">
          <button class="bg-transparent border-0 cursor-pointer text-slate-400 text-xl flex-shrink-0" @click="backToEntry" aria-label="返回">‹</button>
          <h1 class="text-sm sm:text-base font-bold">收貨分配</h1>
          <span class="text-[11px] font-bold py-0.5 px-2 sm:px-2.5 rounded-md whitespace-nowrap" style="background:#dbeafe;color:#1d4ed8;">
            PO: {{ currentPO }}
          </span>
          <span class="text-xs text-slate-400 whitespace-nowrap">共 {{ rows.length }} 項</span>
          <span v-if="dirtyLineIds.size" class="text-[11px] font-bold px-2 py-0.5 rounded whitespace-nowrap"
                style="background:#fef3c7;color:#92400e;">
            ● {{ dirtyLineIds.size }} 行未儲存
          </span>
        </div>
        <div class="flex items-center gap-2 w-full sm:w-auto">
          <input
            v-model="search"
            class="flex-1 min-w-0 sm:flex-none sm:w-52 px-3 py-1.5 text-xs border border-gray-300 rounded-lg outline-none"
            placeholder="搜尋 SKU / 名稱"
          />
          <RefreshButton :on-refresh="refreshNow" />
          <button class="bg-emerald-600 text-white text-xs font-semibold px-3 sm:px-4 py-1.5 rounded-lg border-0 cursor-pointer flex-shrink-0" @click="exportExcel">
            <span class="sm:hidden">⬇</span><span class="hidden sm:inline">⬇ 匯出</span>
          </button>
          <button class="bg-blue-600 text-white text-xs font-semibold px-3 sm:px-4 py-1.5 rounded-lg border-0 cursor-pointer flex-shrink-0 disabled:opacity-50"
                  :disabled="saving" @click="saveData">
            <span class="sm:hidden">{{ saving ? '⏳' : '💾' }}</span>
            <span class="hidden sm:inline">{{ saving ? '⏳ 儲存中…' : '💾 儲存' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 表格 -->
    <!-- min-height: 220px — 单条数据时表格容器不至于太短。combo 下拉因为已经 -->
    <!-- Teleport 到 body 渲染（见 script），不再依赖容器高度防裁切，min-height -->
    <!-- 只用作纯视觉。spacer 行配合此值让 tfoot 贴底（详见 spacerHeight）。  -->
    <div class="flex-1 overflow-auto p-3 sm:p-4">
      <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div class="overflow-auto" style="max-height: calc(100vh - 220px); min-height: 220px;">
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
                <th v-for="c in activeExtraCols" :key="c.index" class="px-1.5 py-2 text-center relative" style="background:#fffbeb;">
                  <input
                    v-model="extraCols[c.index].name"
                    placeholder="倉位名"
                    class="w-20 px-1 py-px text-[10px] text-center border rounded font-bold"
                    style="border-color:#fbbf24;color:#92400e;"
                    @focus="openWhAutocomplete(c.index)"
                    @input="onWhInput(c.index)"
                    @blur="closeWhAutocomplete"
                  />
                  <button class="border-0 cursor-pointer text-gray-400 text-xs ml-0.5 bg-transparent" @click="rmCol(c.index)">✕</button>
                  <!-- Autocomplete 下拉建议 -->
                  <div v-if="whAutocompleteIdx === c.index && whSuggestions.length"
                       class="absolute top-full left-1/2 -translate-x-1/2 z-20 bg-white border border-gray-200 rounded-lg shadow-xl w-44 mt-1 max-h-60 overflow-auto">
                    <button v-for="w in whSuggestions" :key="w.id"
                            class="block w-full px-3 py-1.5 text-left text-[11px] border-0 cursor-pointer bg-white hover:bg-amber-50"
                            @mousedown.prevent="pickWh(c.index, w)">
                      <span class="font-bold text-amber-800">{{ w.code }}</span>
                      <span class="text-gray-500 ml-1.5">{{ w.name }}</span>
                    </button>
                  </div>
                </th>
                <th v-if="canAddCol" class="px-1.5 py-2 text-center">
                  <button class="w-6 h-6 rounded-md text-white border-0 cursor-pointer text-sm" style="background:#f59e0b;" @click="addCol">+</button>
                </th>
                <th class="px-2.5 py-2 text-center text-[11px] text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in filteredRows" :key="row.po_line_id">
                <tr class="border-b border-gray-100"
                    :class="dirtyLineIds.has(row.po_line_id) ? 'bg-amber-50/40' : ''">
                  <td class="px-2.5 py-2 text-center font-semibold">{{ row.qty }}</td>
                  <td class="px-2.5 py-2 text-center" style="background:rgba(240,253,250,.4);">
                    <span v-if="row.counted == null" class="text-gray-300 text-xs">—</span>
                    <span v-else class="text-xs font-bold" :class="row.counted === row.qty ? 'text-gray-800' : 'text-red-600'">
                      {{ row.counted }}
                    </span>
                  </td>
                  <td class="px-2.5 py-2 text-center">
                    <input
                      :value="row.box_qty || ''"
                      @input="(e) => { row.box_qty = parseInt(e.target.value) || 0; markDirty(row); }"
                      type="number"
                      min="0"
                      placeholder="—"
                      class="w-12 p-1 border rounded text-center text-xs"
                      style="border-color:#e5e7eb;"
                    />
                  </td>
                  <!-- 总箱数：前端只读显示 — 后端 store=True compute 字段（=ceil(qty/box_qty)）
                       但 box_qty 改了之后后端字段还没刷新（要 save 后才刷），所以前端在
                       display 时 fallback 用前端 ceil 即时计算，让员工录入瞬间就看到 -->
                  <td class="px-2.5 py-2 text-center text-xs font-semibold" :class="liveTotalBoxes(row) === '—' ? 'text-gray-300' : 'text-gray-700'">{{ liveTotalBoxes(row) }}</td>
                  <td class="px-2.5 py-2 text-center text-xs text-gray-500">{{ row.remarks || '—' }}</td>
                  <td class="px-2.5 py-2 font-mono text-[11px] text-gray-500">{{ row.barcode }}</td>
                  <td class="px-2.5 py-2 font-mono text-[11px] font-bold">{{ row.sku }}</td>
                  <td class="px-2.5 py-2 text-xs max-w-[160px] truncate" :title="row.name">{{ row.name }}</td>

                  <!-- 3PL -->
                  <td class="px-1.5 py-2 text-center" style="background:rgba(239,246,255,.4);">
                    <div class="flex items-center justify-center gap-0.5">
                      <input
                        v-model="row.tpl"
                        @input="markDirty(row)"
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
                      @input="markDirty(row)"
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
                      :value="row.extra && row.extra[c.index] && row.extra[c.index].qty"
                      @input="(e) => { if (!row.extra[c.index]) row.extra[c.index] = { qty: 0 }; row.extra[c.index].qty = parseInt(e.target.value) || 0; markDirty(row); }"
                      type="number"
                      min="0"
                      placeholder="0"
                      class="w-14 p-1 border rounded text-center text-xs font-semibold"
                      style="border-color:#fcd34d;"
                    />
                  </td>
                  <td v-if="canAddCol"></td>

                  <!-- 操作 — combo 下拉用 Teleport 渲染到 body，避开表格 overflow 裁切；详见模板末尾 -->
                  <td class="px-2.5 py-2 text-center">
                    <button data-combo-trigger
                            class="w-6 h-6 rounded-md text-white border-0 cursor-pointer text-xs disabled:opacity-30"
                            style="background:#2563eb;"
                            :disabled="!row.combo_options || row.combo_options.length === 0"
                            :title="row.combo_options && row.combo_options.length ? '加組合裝' : '此商品無 BOM 母件'"
                            @click="(e) => toggleMenu(rowIndex(row), e.currentTarget)">+</button>
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
                  <td class="px-2.5 py-1.5 text-[11px] text-gray-500">{{ c.name }} {{ c.label }}</td>
                  <td class="px-1.5 py-1.5 text-center" style="background:rgba(239,246,255,.4);">
                    <input
                      v-model="c.tpl"
                      @input="markDirty(row)"
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
              <!-- 透明 spacer 行：动态高度填满容器剩余空间，让 tfoot 贴近底部 -->
              <!-- 高度由 spacerHeight computed 算出（见 script），跟容器 min-height 配套 -->
              <tr v-if="filteredRows.length > 0" aria-hidden="true">
                <td colspan="99"
                    :style="{
                      height: spacerHeight + 'px',
                      border: 'none',
                      padding: 0,
                      background: 'transparent',
                    }"
                ></td>
              </tr>
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

    <!-- ============================================================ -->
    <!-- 冲突 Modal — 207 响应触发                                    -->
    <!-- ============================================================ -->
    <div v-if="conflictModal.open"
         class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div class="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-200 flex items-center gap-2">
          <span class="text-2xl">⚠️</span>
          <div>
            <h2 class="text-base font-bold text-gray-800">資料衝突 — {{ conflictModal.conflicts.length }} 行被其他用戶更新</h2>
            <p class="text-xs text-gray-500 mt-0.5">請逐行選擇：保留我的修改 / 接受伺服器最新版本</p>
          </div>
        </div>

        <div class="flex-1 overflow-auto p-4 space-y-3">
          <div v-for="c in conflictModal.conflicts" :key="c.po_line_id"
               class="border border-amber-200 bg-amber-50/40 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div>
                <span class="font-mono font-bold text-sm">{{ c.sku }}</span>
                <span class="text-xs text-gray-500 ml-2">
                  {{ c.modified_by }} · {{ c.modified_at }} 修改
                </span>
              </div>
              <div class="flex gap-1">
                <button class="px-3 py-1 text-xs font-semibold rounded border"
                        :class="conflictModal.resolutions[c.po_line_id] === 'keep'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'"
                        @click="pickResolution(c.po_line_id, 'keep')">
                  保留我的
                </button>
                <button class="px-3 py-1 text-xs font-semibold rounded border"
                        :class="conflictModal.resolutions[c.po_line_id] === 'accept'
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'"
                        @click="pickResolution(c.po_line_id, 'accept')">
                  接受伺服器
                </button>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3 text-xs">
              <div class="bg-white rounded border border-gray-200 p-2">
                <div class="text-[11px] font-bold text-gray-500 mb-1">我的修改</div>
                <div>3PL: <span class="font-mono">{{ c.your_data.tpl }}</span></div>
                <div>WS: <span class="font-mono">{{ c.your_data.ws }}</span></div>
                <div v-if="(c.your_data.combos || []).length">
                  Combos: <span class="font-mono">{{ (c.your_data.combos || []).length }}</span> 行
                </div>
              </div>
              <div class="bg-white rounded border border-gray-200 p-2">
                <div class="text-[11px] font-bold text-emerald-700 mb-1">伺服器最新</div>
                <div>3PL: <span class="font-mono">{{ c.server_data.tpl ?? 0 }}</span></div>
                <div>WS: <span class="font-mono">{{ c.server_data.ws ?? 0 }}</span></div>
                <div v-if="(c.server_data.combos || []).length">
                  Combos: <span class="font-mono">{{ (c.server_data.combos || []).length }}</span> 行
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2 flex-shrink-0">
          <button class="px-4 py-2 text-xs font-semibold text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
                  @click="cancelConflictModal">取消</button>
          <button class="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
                  :disabled="saving" @click="applyResolutions">
            {{ saving ? '處理中…' : '確認' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ========================================================== -->
    <!-- combo 下拉菜单 — Teleport 到 body 渲染                       -->
    <!-- 用 position:fixed + 按钮坐标定位，跳出表格 overflow 容器    -->
    <!-- 滚动 / 缩放 / Esc / 外部点击均关闭（见 watch(openMenuIdx))  -->
    <!-- ========================================================== -->
    <Teleport to="body">
      <div
        v-if="activeRow"
        data-combo-dropdown
        class="bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden"
        :style="{
          position: 'fixed',
          top: dropdownPos.top + 'px',
          left: dropdownPos.left + 'px',
          width: '288px',
          zIndex: 60,
        }"
      >
        <div class="px-3 py-2 text-[11px] font-bold text-gray-400"
             style="background:#f9fafb;border-bottom:1px solid #f3f4f6;">
          選擇組合裝（來自 BOM）
        </div>
        <div v-if="!activeRow.combo_options || activeRow.combo_options.length === 0"
             class="px-3 py-3 text-[11px] text-gray-400 text-center">
          此商品無關聯 BOM 母件
        </div>
        <button
          v-for="opt in (activeRow.combo_options || [])"
          :key="opt.sku"
          class="flex justify-between items-center w-full px-3 py-2 text-left text-xs border-0 cursor-pointer bg-white hover:bg-gray-50 disabled:cursor-not-allowed"
          :disabled="comboHas(rowIndex(activeRow), opt.sku)"
          :class="comboHas(rowIndex(activeRow), opt.sku) ? 'opacity-40' : ''"
          @click="addCombo(rowIndex(activeRow), opt)"
        >
          <span>
            <span class="font-mono font-bold">{{ opt.sku }}</span>
            <span class="text-gray-500 ml-1">{{ opt.label }}</span>
          </span>
          <span v-if="comboHas(rowIndex(activeRow), opt.sku)" class="text-emerald-600">✓</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
