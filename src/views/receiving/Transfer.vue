<script setup>
/**
 * Transfer Order (M3c) — 接 Odoo 真后端
 *
 * 业务流：
 *   M3b/M3a 完成后 → 进 M3c → 输入 PO → 没 TR 时点「生成 TR」→
 *   后端基于 le_allocation_data 派生每仓一张 TR → 员工揀貨 / 截單
 *
 * 四态 UI（保留 demo 设计）：
 *   search   → PO 输入页（紫色渐变背景）
 *   trlist   → TR 列表（带统计 + 进度条 + 没数据时显示"生成 TR"按钮）
 *   trdetail → 单个 TR 详情（扫码 + 品项分组 + 截單）
 *   item     → 单个品项分组的揀貨/箱數编辑
 *
 * 多用户协作（TR 级乐观锁）：
 *   - dirty tracking 跟踪当前 TR 是否改了
 *   - save 时带 _last_modified_at 给后端比对
 *   - 冲突 → 弹 modal 让用户选 keep / accept
 *
 * 截單（cut）：
 *   后端拆 TR 成"已揀部分"+"剩餘部分"两张，原 TR 锁定 (state=cut)。
 *   员工要继续揀 → 去 trlist 找新建的"第二轉" TR。
 */
import { computed, nextTick, reactive, ref, watch, onMounted, onActivated, onBeforeUnmount, onDeactivated, defineAsyncComponent } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { po as poApi, labels as labelsApi } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import { printLabels, printPickList, printRepackLabels } from '@/utils/labelRenderers'
import { printToBartender } from '@/utils/bartenderPrint'
import * as XLSX from 'xlsx'
// 按需異步加載:zxing 解碼庫(~113KB gzip)只在真正打開相機時才下載
const BarcodeScanner = defineAsyncComponent(() => import('@/components/BarcodeScanner.vue'))

// ============================================================
// 状态
// ============================================================
const view = ref('search')           // 'search' | 'trlist' | 'trdetail' | 'item'
const loading = ref(false)
const saving = ref(false)
const cutting = ref(false)
const completing = ref(false)
const showCompleteModal = ref(false)
const printingPicklist = ref(false)

// PO 级
const poInput = ref('')
const curPO = ref(null)              // PO name 字符串
const poInfo = reactive({             // PO 元信息
  partner_name: '',
  state:        '',
})
const trSearch = ref('')

// TR 列表（trlist 视图）
const trList = ref([])                // TransferSummary[]
const uncoveredLines = ref([])        // 未覆蓋行（後端返回）
const incomingState = ref('none')    // 入庫狀態: 'none' | 'pending' | 'partial' | 'done'
const receiving = ref(false)
const showReceiveModal = ref(false)
const receiveResult = ref(null)

// 当前 TR 详情（trdetail / item 视图）
const activeTransfer = ref(null)      // 完整 TR { id, name, state, groups_data, ... }
const selGrp = ref(null)               // 当前打开的 group index
const dirty = ref(false)              // activeTransfer 是否被改过

// 扫码 / 错误
const bcQuery = ref('')
const bcError = ref('')
const bcInputEl = ref(null)

// Modal
const showCutModal = ref(false)
const scannerOpen = ref(false)
// 掃碼配對到多個 SKU（base + repack/BOM）時嘅選擇 modal
const skuChoiceModal = reactive({
  open: false,
  scannedBarcode: '',
  matches: [],   // [{ gi, ii, item, matchType: 'exact'|'bom' }]
})
const conflictModal = reactive({
  open: false,
  modified_by: '',
  modified_at: '',
  server_data: null,
})

// ============================================================
// 计算
// ============================================================
const sortedTRs = computed(() => {
  // 'cut' local drafts are fully processed — hide them.
  // Their real TRs (TR-XXXXX with Ref: badge) remain visible as the audit trail.
  return [...trList.value]
    .filter(t => t.state !== 'cut')
    .sort((a, b) => {
      const aLocal = a.state === 'local_draft' || a.state === 'in_progress' ? 0 : 1
      const bLocal = b.state === 'local_draft' || b.state === 'in_progress' ? 0 : 1
      return aLocal - bLocal
    })
})
const filteredTRs = computed(() => {
  if (!trSearch.value.trim()) return sortedTRs.value
  const q = trSearch.value.toLowerCase()
  return sortedTRs.value.filter(t => (t.name || '').toLowerCase().includes(q))
})

const curGroups = computed(() => activeTransfer.value?.groups_data || [])
const curGroup = computed(() => curGroups.value[selGrp.value] || null)

// ── 到期日提醒水印 ─────────────────────────────────────────────
// item 视图空白处印一个灰色大字水印「請檢查日期:DD/MM/YYYY」,提醒工人核对
// 实物到期日。日期来源同标签(picklist FEFO 端点),保证一致。按 TR 缓存,
// 拉一次即可;某品项跨多批次会列出多个日期。
const picklistLabels = ref([])         // 当前 TR 的 picklist labels [{sku,barcode,expDate}]
const picklistTrId = ref(null)         // picklistLabels 对应的 TR id(缓存键)

async function ensureItemExpiry() {
  const trId = activeTransfer.value?.id
  if (!trId) return
  if (picklistTrId.value === trId) return   // 已拉过该 TR
  try {
    const res = await poApi.getTransferPicklist(trId)
    picklistLabels.value = res?.labels || []
    picklistTrId.value = trId
  } catch (e) {
    // 水印是锦上添花,拉失败静默(不影响揀貨)
    picklistLabels.value = []
    picklistTrId.value = trId
  }
}

const curGroupExpDates = computed(() => {
  const g = curGroup.value
  if (!g) return []
  const skus = new Set((g.items || []).map(i => i.sku).filter(Boolean))
  const barcodes = new Set((g.items || []).map(i => i.barcode).filter(Boolean))
  const dates = []
  for (const l of picklistLabels.value) {
    if (!l.expDate) continue
    if (skus.has(l.sku) || (l.barcode && barcodes.has(l.barcode))) {
      if (!dates.includes(l.expDate)) dates.push(l.expDate)
    }
  }
  return dates
})

// 进入 item 视图时按需拉到期日(覆盖 openItem + 扫码直跳 item 两条入口)
watch(view, (v) => { if (v === 'item') ensureItemExpiry() })

function groupStatus(g) {
  const items = g?.items || []
  const tr = items.reduce((s, i) => s + (parseInt(i.reqQty) || 0), 0)
  const tp = items.reduce((s, i) => s + (parseInt(i.pickQty) || 0), 0)
  if (items.some(i => (parseInt(i.pickQty) || 0) > (parseInt(i.reqQty) || 0))) return 'over'
  if (tp === 0) return 'pending'
  if (tp >= tr) return 'done'
  return 'partial'
}

function trStats(tr) {
  // 后端已经返了 stats，直接用
  return tr.stats || { groups: 0, total_req: 0, total_pick: 0, total_boxes: 0, done_groups: 0 }
}
// Bug2 fix: done TR 顯示 100%，避免 non-3PL 完成後 pickQty=0 導致 0% 的視覺問題
function trPct(tr) {
  if (tr.state === 'done') return 100
  const s = trStats(tr)
  return s.total_req > 0 ? Math.round(s.total_pick / s.total_req * 100) : 0
}

const allTRStats = computed(() => {
  // Exclude 'cut' local drafts — their items are already counted in the real TRs they spawned.
  return trList.value.filter(t => t.state !== 'cut').reduce((a, t) => {
    const s = trStats(t)
    return { rq: a.rq + s.total_req, pk: a.pk + s.total_pick, bx: a.bx + s.total_boxes }
  }, { rq: 0, pk: 0, bx: 0 })
})

// 未覆蓋行
const hasUncovered = computed(() => uncoveredLines.value.length > 0)

const detailStats = computed(() => {
  if (!activeTransfer.value) return { rq: 0, pk: 0, bx: 0, dn: 0, total: 0 }
  const s = activeTransfer.value.stats || {}
  // Bug1 fix: rq 用 server stats（穩定），pk/bx/dn 從 live groups_data 即時計算
  const rq    = s.total_req || 0
  const total = s.groups    || 0
  let pk = 0, bx = 0, dn = 0
  for (const g of (activeTransfer.value.groups_data || [])) {
    let gPk = 0, gRq = 0
    for (const i of (g.items || [])) {
      const p = parseInt(i.pickQty) || 0
      const r = parseInt(i.reqQty)  || 0
      pk += p
      bx += parseInt(i.boxes) || 0
      gPk += p
      gRq += r
    }
    if (gRq > 0 && gPk >= gRq) dn++
  }
  return { rq, pk, bx, dn, total }
})
const detailPct = computed(() =>
  detailStats.value.rq > 0 ? Math.round(detailStats.value.pk / detailStats.value.rq * 100) : 0,
)

// ── 3PL vs 非 3PL 模式判断 ──
const isLocalDraft = computed(() => {
  const st = activeTransfer.value?.state
  return st === 'local_draft' || st === 'in_progress'
})
const isReadyToComplete = computed(() => {
  const st = activeTransfer.value?.state
  return st === 'draft' && activeTransfer.value?.has_picking
})
const isCompleted = computed(() => activeTransfer.value?.state === 'done')
// 3PL local_draft：全部 reqQty > 0 的品項都已 pickQty >= reqQty
const isFullyPicked = computed(() => {
  if (!activeTransfer.value || !isLocalDraft.value) return false
  const groups = activeTransfer.value.groups_data || []
  if (groups.length === 0) return false
  let hasItems = false
  for (const g of groups) {
    for (const i of (g.items || [])) {
      const req = parseInt(i.reqQty) || 0
      const pick = parseInt(i.pickQty) || 0
      if (req > 0) {
        hasItems = true
        if (pick < req) return false
      }
    }
  }
  return hasItems
})
// 3PL 點貨：逐件檢查。countingReady = 全部已點, anyCounted = 至少一件已點
const countingReady = computed(() => activeTransfer.value?.counting_ready !== false)
const anyCounted = computed(() => activeTransfer.value?.any_counted !== false)
// 非 3PL 或 done/cut → 整張鎖（不可編輯）
const isLocked = computed(() => {
  const st = activeTransfer.value?.state
  if (st === 'done' || st === 'cut') return true
  return false
})
// 逐件鎖 — 3PL local draft 中未點貨的 item
function isItemLocked(item) {
  if (isLocked.value) return true
  if (isReadyToComplete.value) return true   // 非 3PL 全部 read-only
  if (isLocalDraft.value && !item.item_counted) return true
  return false
}

const groupStatsCur = computed(() => {
  const g = curGroup.value
  if (!g) return { gR: 0, gP: 0, pct: 0 }
  const gR = (g.items || []).reduce((a, i) => a + (parseInt(i.reqQty) || 0), 0)
  const gP = (g.items || []).reduce((a, i) => a + (parseInt(i.pickQty) || 0), 0)
  const pct = gR > 0 ? Math.min(Math.round(gP / gR * 100), 100) : 0
  return { gR, gP, pct }
})

// 截單预览
const cutPreview = computed(() => {
  const tr = activeTransfer.value
  if (!tr) return { first: [], second: [], ft: 0, st: 0, nid: '' }
  const first = [], second = []
  let ft = 0, st = 0
  ;(tr.groups_data || []).forEach(g => {
    ;(g.items || []).forEach(i => {
      const req = parseInt(i.reqQty) || 0
      const pick = parseInt(i.pickQty) || 0
      if (pick > 0) { first.push({ name: i.name, sku: i.sku, qty: pick, orig: req }); ft += pick }
      const rm = req - pick
      if (rm > 0)   { second.push({ name: i.name, sku: i.sku, qty: rm, orig: req }); st += rm }
    })
  })
  return { first, second, ft, st, nid: '(後端自動生成)' }
})

// ============================================================
// Helpers
// ============================================================
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

function trStateBadge(st) {
  const m = {
    local_draft: { l: '揀貨中', cls: 'bg-purple-100 text-purple-800' },
    draft:       { l: '待完成', cls: 'bg-slate-100 text-slate-500' },
    in_progress: { l: '揀貨中', cls: 'bg-purple-100 text-purple-800' },
    done:        { l: '已完成', cls: 'bg-emerald-100 text-emerald-800' },
    cut:         { l: '已截單', cls: 'bg-orange-100 text-orange-800' },
  }
  return m[st] || m.draft
}

function isCutTr(tr) {
  // Only "second-round" REAL TRs that were spawned from a cutoff (have a parent).
  // Do NOT flag the original local draft that reaches state='cut' — those are hidden from the list anyway.
  return !!tr.parent_transfer_id
}

// ============================================================
// 加载 PO + TR list
// ============================================================
// 纯名称:从 displayName(= "[SKU] 名称")去掉前面的 "[SKU] " 前缀。
// 没有方括号前缀的(display_name 无 code)则原样返回。供品项列灰色行显示全名。
function pureName(g) {
  const dn = (g && g.displayName) || ''
  return dn.replace(/^\[[^\]]*\]\s*/, '') || dn
}

// Detect whether input is a PO name (starts P + digits) or a TR/picking name
function _looksLikePO(v) {
  // PO 命名多样:Odoo 默认序列 Pxxxxx、从 Dear 导入的 PO-xxxx、以及 NY-/KB-/COT- 等原始单号。
  // 旧正则 /^P\d/ 只认 Pxxxxx,导致带前缀/异格式的 PO(生产 401 个里 400 个)被误判成 TR。
  // 策略:除非看起来是 TR(TR-xxxx)或 Odoo 库存 picking(含 '/',如 WH/IN/...),否则一律当 PO。
  return !/^TR-/i.test(v) && !v.includes('/')
}

async function searchPO() {
  const v = poInput.value.trim()
  if (!v) { showToast('請輸入 PO / TR Number', 'error'); return }
  if (_looksLikePO(v)) {
    await _loadByPO(v)
  } else {
    await _loadByTRName(v)
  }
}

async function _loadByPO(poName) {
  loading.value = true
  try {
    const res = await poApi.listTransfers(poName)
    curPO.value = res.po_name
    poInfo.partner_name = res.partner_name || ''
    poInfo.state = res.state || ''
    trList.value = res.transfers || []
    uncoveredLines.value = res.uncovered_lines || []
    incomingState.value = res.incoming_state || 'none'
    view.value = 'trlist'
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 404) {
      showToast(`❌ 找不到 PO「${poName}」`, 'error')
    } else if (status === 422) {
      showToast(`⚠️ ${data.detail || `此 PO 狀態（${data.state}）不允許操作`}`, 'warning')
    } else if (status === 403) {
      showToast(data.detail || '此功能僅限內部員工', 'error')
    } else {
      showToast(data.error || '載入失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

async function _loadByTRName(name) {
  // Direct TR or replenishment picking lookup — go straight to trdetail
  loading.value = true
  try {
    const res = await poApi.lookupTransferByName(name)
    curPO.value = res.po_name || name
    poInfo.partner_name = res.partner_name || ''
    poInfo.state = ''
    trList.value = res.transfers || []
    uncoveredLines.value = []
    incomingState.value = res.transfer?.has_picking ? 'done' : 'none'
    // Jump directly to detail (there's exactly one TR)
    if (res.transfer) {
      activeTransfer.value = res.transfer
      dirty.value = false
      view.value = 'trdetail'
    } else {
      view.value = 'trlist'
    }
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 404) {
      showToast(`❌ 找不到 TR 或 Picking「${name}」`, 'error')
    } else if (status === 422) {
      showToast(`⚠️ ${data.detail || '此 TR 無法操作'}`, 'warning')
    } else if (status === 403) {
      showToast(data.detail || '此功能僅限內部員工', 'error')
    } else {
      showToast(data.error || '載入失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

// Print pick list for a TR (all items, 100×150mm per item)
async function printPickListForTR(tr) {
  printingPicklist.value = true
  try {
    // Resolve the actual TR id (handle virtual / activeTransfer fallback)
    let trId = tr?.id
    if (!trId && tr?.is_virtual && tr?.name) {
      // Wrap virtual picking first to get a real id
      const res = await poApi.lookupTransferByName(tr.name)
      trId = res.transfer?.id
    }
    if (!trId) trId = activeTransfer.value?.id
    if (!trId) { showToast('找不到 TR', 'error'); return }
    // FEFO-split labels from backend
    const res = await poApi.getTransferPicklist(trId)
    const labels = res?.labels || []
    if (!labels.length) { showToast('沒有品項可列印', 'warning'); return }
    // 1) 先試 Bartender（如配置咗）→ 直接出機，不彈 dialog
    const okBT = await printToBartender(labels, { template: 'pick_list_100x150' })
    if (okBT) { showToast('✅ 已送去 Bartender 列印', 'success'); return }
    // 2) Fallback：瀏覽器 iframe 印（PDF dialog）
    printPickList(labels)
  } catch (e) {
    showToast('列印揀貨單失敗', 'error')
  } finally {
    printingPicklist.value = false
  }
}

// Auto-print label when worker confirms a pickQty
//   - 先試 Bartender（如配置） → 直接出 TSC TE310
//   - 失敗或未配置 → fallback 瀏覽器 iframe 印
//
//   邏輯：
//   - 條碼結尾係字母 (e.g. 64966a) → repack 標籤
//   - 同時查 Label Master → 有食品/保健 label 一齊印
//   - 兩種情況可疊加（repack 包裝盒要貼自己嘅條碼，仲要貼營養成份）
//
//   防重複：輸入後按 Enter 會 call 呢個函數；同一 item 同一 qty 連按 Enter
//   只印一次（用 _lastPrintedQty 記住）。重印按鈕會先清呢個記錄再強制重印。
const _lastPrintedQty = new Map()
async function onPickQtyBlur(item) {
  const qty = parseInt(item.pickQty) || 0
  if (qty <= 0) return
  const barcode = item.barcode || ''
  if (!barcode) return
  const printKey = `${item.po_line_id || ''}|${item.sku || ''}|${barcode}`
  if (_lastPrintedQty.get(printKey) === qty) return  // 已印過呢個 qty，唔再印
  _lastPrintedQty.set(printKey, qty)

  const isRepack = /[A-Za-z]$/.test(barcode)

  // ── 1) Repack label（如條碼結尾係字母）──
  if (isRepack) {
    const labelData = [{ barcode, name: item.name || '', sku: item.sku || '' }]
    const okBT = await printToBartender(labelData, { template: 'repack_label_70x50', copies: qty })
    if (!okBT) printRepackLabels({ barcode, name: item.name || '' }, qty)
  }

  // ── 2) Label Master（食品/保健/特殊…）── 任何 barcode 都試查
  try {
    const res = await labelsApi.lookupByBarcode(barcode)
    const lbls = res?.labels || []
    if (!lbls.length) return   // 冇 master → 已 print repack（or nothing），收工
    const okBT = await printToBartender(lbls, { template: 'label_master', copies: qty })
    if (!okBT) printLabels(lbls, qty)
  } catch (e) {
    // 404 = barcode 唔喺 master → 唔係 error，靜靜地 skip
    if (e?.response?.status !== 404) {
      console.warn('[auto-print] label lookup failed:', e?.message)
    }
  }
}

// 自動列印改為「輸入揀貨數量後按 Enter」觸發（見模板 @keydown.enter），
// 不再 debounce 邊打邊印、亦不再 @blur 失焦印 —— 避免過早/誤觸發。

// Manual reprint button — 強制重印：先清掉去重記錄，否則 onPickQtyBlur
// 會因為「呢個 qty 已印過」而 early-return，導致重印按鈕點極都冇反應。
async function reprintItemLabels(item) {
  const barcode = item.barcode || ''
  const printKey = `${item.po_line_id || ''}|${item.sku || ''}|${barcode}`
  _lastPrintedQty.delete(printKey)
  await onPickQtyBlur(item)
}

// Print label for a whole group from the trdetail list (uses first item's barcode)
async function printGroupLabel(g) {
  const item = (g.items || [])[0]
  if (!item) return
  const qty = parseInt(item.pickQty) || 0
  if (qty <= 0) { showToast('請先輸入揀貨數量', 'warning'); return }
  const barcode = item.barcode || ''
  if (!barcode) { showToast('此品項沒有 Barcode', 'warning'); return }

  const isRepack = /[A-Za-z]$/.test(barcode)
  let printed = false

  if (isRepack) {
    const labelData = [{ barcode, name: item.name || '', sku: item.sku || '' }]
    const okBT = await printToBartender(labelData, { template: 'repack_label_70x50', copies: qty })
    if (!okBT) printRepackLabels({ barcode, name: item.name || '' }, qty)
    printed = true
  }
  try {
    const res = await labelsApi.lookupByBarcode(barcode)
    const lbls = res?.labels || []
    if (lbls.length) {
      const okBT = await printToBartender(lbls, { template: 'label_master', copies: qty })
      if (!okBT) printLabels(lbls, qty)
      printed = true
    }
  } catch (e) {
    if (e?.response?.status !== 404) {
      showToast('取得標籤資料失敗', 'error')
      return
    }
  }
  if (!printed) showToast('此品項沒有標籤資料', 'warning')
}

async function generateTRs() {
  if (!curPO.value) return
  loading.value = true
  try {
    const res = await poApi.generateTransfers(curPO.value)
    // 成功生成 — 全量刷新列表（含新增 + 已有 TR）
    await reloadTRList()
    const skipped = res.skipped || []
    const count = res.count || 0
    if (skipped.length > 0) {
      showToast(`✅ 已生成 ${count} 張 TR，${skipped.length} 個 SKU 暫被跳過`, 'success')
    } else {
      showToast(`✅ 已生成 ${count} 張 Transfer Order`, 'success')
    }
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 409) {
      showToast(data.detail || '已生成過，請刷新查看', 'warning')
      await reloadTRList()
    } else if (status === 422 && data.error === 'all_skipped') {
      showToast('⚠️ 所有待處理行仍不符條件（未點貨或點貨不足），無法生成補充 TR', 'warning')
      await reloadTRList()
    } else if (status === 422) {
      showToast(data.detail || '無分配方案，請先去 M3b 收貨分配錄入', 'warning')
    } else {
      showToast(data.error || '生成失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

async function reloadTRList() {
  if (!curPO.value) return
  try {
    const res = await poApi.listTransfers(curPO.value)
    trList.value = res.transfers || []
    uncoveredLines.value = res.uncovered_lines || []
    incomingState.value = res.incoming_state || 'none'
  } catch {
    /* 静默 */
  }
}

// 「更新數據」按钮:① 先拉最新数据(防止有人在 Odoo / 别处并发改动)
//                    ② 若收貨分配后来加了新 SKU(uncovered),增量补充 TR
//                       —— 增量生成只为新 SKU 建「补充 TR」,绝不动已有 TR/进度。
async function refreshAndSyncTRs() {
  if (!curPO.value || loading.value) return
  loading.value = true
  try {
    // 从产品重新同步已有 TR 明细的 barcode/名称(改产品 barcode 后能拿到最新),
    // 只刷显示/扫码字段,不动数量/进度。静默失败不阻断后续刷新。
    try { await poApi.resyncTransfers(curPO.value) } catch (e) { /* ignore */ }
    await reloadTRList()                       // 再刷新最新列表
    if (!hasUncovered.value) {
      showToast('✅ 已刷新(barcode/名称已同步),无新增 SKU', 'success')
      return
    }
    const n = uncoveredLines.value.length       // 新增 SKU 数
    const res = await poApi.generateTransfers(curPO.value)
    await reloadTRList()
    const count = res?.count || 0
    showToast(`✅ 已同步 ${n} 个新增 SKU,新建 ${count} 张补充 TR(原有 TR 进度不变)`, 'success')
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 422 && (data.error === 'no_allocation' || data.error === 'all_skipped')) {
      await reloadTRList()
      showToast('✅ 已刷新,暂无可生成的新增 SKU', 'success')
    } else if (status === 409) {
      await reloadTRList()
      showToast(data.detail || '其他人正在生成 TR,请稍后再试', 'warning')
    } else {
      showToast(data.detail || data.error || '更新失败', 'error')
    }
  } finally {
    loading.value = false
  }
}

// ============================================================
// 进入 / 退出某 TR
// ============================================================
async function openTR(trId) {
  if (dirty.value && view.value !== 'trlist'
      && !confirm('當前 TR 有未儲存的修改，確定離開？')) {
    return
  }
  loading.value = true
  try {
    const res = await poApi.getTransfer(trId)
    activeTransfer.value = res
    dirty.value = false
    view.value = 'trdetail'
    nextTick(() => bcInputEl.value?.focus())
  } catch (err) {
    if (err.handledByInterceptor) return
    showToast(err.response?.data?.error || '載入失敗', 'error')
  } finally {
    loading.value = false
  }
}

function openItem(idx) {
  selGrp.value = idx
  view.value = 'item'
}

function goBack() {
  closeScanner()
  bcQuery.value = ''
  bcError.value = ''
  if (view.value === 'item') {
    view.value = 'trdetail'
  } else if (view.value === 'trdetail') {
    if (dirty.value && !confirm('當前 TR 有未儲存的修改，確定離開？')) return
    view.value = 'trlist'
    activeTransfer.value = null
    dirty.value = false
    reloadTRList()   // 刷新列表统计
  } else if (view.value === 'trlist') {
    view.value = 'search'
    curPO.value = null
    trList.value = []
    uncoveredLines.value = []
    incomingState.value = 'none'
    receiveResult.value = null
    trSearch.value = ''
  }
}

// item 页底部按钮:草稿态 → 真存后端(落库,断网不丢)再返回 trdetail;
// 存失败/冲突(dirty 未清 或 弹了冲突框)则留在本页,可重存。非草稿 → 直接返回。
async function saveAndBack() {
  if (isLocalDraft.value && !isLocked.value && dirty.value) {
    await saveTR({ afterSave: 'stay', silent: true })
    if (dirty.value || conflictModal.open) return   // 存失敗/衝突 → 留在本頁
    view.value = 'trdetail'
  } else {
    goBack()   // item → trdetail
  }
  focusBarcode()   // 顯式聚焦 barcode 框(多次重試),不只靠 watch
}

// ── 揀貨鍵盤流 ──────────────────────────────────────────────
// 進入 item 頁(掃完貨/選中)→ 自動聚焦第一行「揀貨」;
// 揀貨輸完 Enter → 跳「箱數」;箱數 Enter → 跳下一行「揀貨」(跳過已鎖行);最後一行收鍵盤。
const qtyEls = {}
const boxEls = {}
function _focus(el) { if (el) { try { el.focus(); el.select && el.select() } catch (e) {} } }
function focusFirstQty() {
  const items = curGroup.value?.items || []
  let i = 0
  while (i < items.length && isItemLocked(items[i])) i++
  nextTick(() => _focus(qtyEls[i]))
}
async function qtyEnter(item, idx) {
  // 先即時聚焦箱數(唔等打印,避免打印報錯/搶焦點導致聚焦落空)
  await nextTick()
  _focus(boxEls[idx])
  // 再觸發打印(容錯),打印可能重渲染 → 若焦點飄走(非落喺其它輸入框)再補聚焦一次
  try { await onPickQtyBlur(item) } catch (e) { /* 打印失敗唔影響聚焦 */ }
  await nextTick()
  const ae = document.activeElement
  if (boxEls[idx] && ae !== boxEls[idx] && (!ae || ae.tagName !== 'INPUT')) _focus(boxEls[idx])
}
// 用戶 spec:Tab=打印(按輸入數量),Enter=切換下一個輸入框。
function tabToBox(idx) { nextTick(() => _focus(boxEls[idx])) }   // Enter 用:揀貨→箱數
async function qtyPrint(item) {                                   // Tab 用:按數量打印
  try { await onPickQtyBlur(item) } catch (e) { /* 打印失敗不擋操作 */ }
}
function boxEnter(idx) {
  const items = curGroup.value?.items || []
  let n = idx + 1
  while (n < items.length && isItemLocked(items[n])) n++
  if (n < items.length) nextTick(() => _focus(qtyEls[n]))
  else nextTick(() => boxEls[idx] && boxEls[idx].blur())   // 最後一行:收鍵盤
}
// 聚焦 barcode 搜尋框 — 多次重試,避開 save 後 activeTransfer 更新導致的重渲染搶焦點
function focusBarcode() {
  ;[0, 150, 350, 600, 900].forEach(t => setTimeout(() => {
    if (view.value === 'trdetail') bcInputEl.value?.focus()
  }, t))
}
watch(view, (v) => {
  if (v === 'item') focusFirstQty()
  else if (v === 'trdetail') focusBarcode()
})

async function refreshData() {
  if (view.value === 'search') return
  if (view.value === 'trlist') {
    await reloadTRList()
    showToast('✅ 已刷新', 'success')
    return
  }
  // trdetail / item — 重拉当前 TR
  if (dirty.value && !confirm('有未儲存的修改，刷新會丟失。確定？')) return
  if (activeTransfer.value) {
    try {
      const res = await poApi.getTransfer(activeTransfer.value.id)
      activeTransfer.value = res
      dirty.value = false
      // 在 item 视图刷新时，groups_data 可能数量变了 → selGrp 可能越界
      // 安全做法：回退到 trdetail，让用户从 group 列表重新选
      if (view.value === 'item') {
        view.value = 'trdetail'
        selGrp.value = null
      }
      showToast('✅ 已刷新', 'success')
    } catch (err) {
      if (!err.handledByInterceptor) {
        showToast(err.response?.data?.error || '刷新失敗', 'error')
      }
    }
  }
}
const { refreshNow } = usePageRefresh(refreshData)

// ============================================================
// 自動刷新開關（WMS 同款滑動開關，TR 列表每 10s 拉最新進度）
// 安全：只在 TR 列表頁(view==='trlist')、無未存改動時刷新；
//       進了某 TR 詳情/有 dirty 自動跳過。reloadTRList 本身靜默(不闪 loading)。
// ============================================================
const autoRefresh = ref(true)
let _trPollTimer = null
const TR_POLL_MS = 10000

async function _pollTRList() {
  if (!autoRefresh.value) return
  if (view.value !== 'trlist') return   // 只在 TR 列表頁輪詢
  if (dirty.value) return               // 有未存改動 → 跳過
  await reloadTRList()
}
function startTRPoll() { if (!_trPollTimer) _trPollTimer = setInterval(_pollTRList, TR_POLL_MS) }
function stopTRPoll()  { if (_trPollTimer) { clearInterval(_trPollTimer); _trPollTimer = null } }
watch(autoRefresh, (v) => {
  if (v) { startTRPoll(); _pollTRList() }   // 打開即刻刷一次
  else stopTRPoll()
})

// ============================================================
// 扫码定位品项
// ============================================================
// 掃碼搜尋：支援 BOM 關聯
//   配對方式：
//   (a) exact   — item.barcode === q  OR  item.sku === q
//   (b) bom     — item.barcode === q + 單個英文字母 (e.g. q=123456, item=123456a)
//                 即係掃 base barcode 都可以揾到 repack/BOM 子件
//
//   結果：
//   - 0 match → 錯誤提示
//   - 1 match → _proceedWithMatch（跳 item view 人手錄入數量，補貨/PO 一致）
//   - 多 match → 彈 SKU choice modal 等員工揀
function scanBC() {
  const q = bcQuery.value.trim()
  if (!q) { showToast('請輸入 Barcode 或 SKU', 'warning'); return }

  const matches = []
  curGroups.value.forEach((g, gi) => {
    (g.items || []).forEach((item, ii) => {
      const bc = item.barcode || ''
      if (bc === q || item.sku === q) {
        matches.push({ gi, ii, item, matchType: 'exact' })
      } else if (bc && bc.length === q.length + 1 && bc.startsWith(q) && /[A-Za-z]$/.test(bc)) {
        matches.push({ gi, ii, item, matchType: 'bom' })
      }
    })
  })

  // 沒有精確/BOM 命中 → 退回「關鍵字部分匹配」(輸入 78900 命中 12345678900)
  // 至少 3 個字才模糊,避免短輸入命中一堆;多個命中走下面的選擇 modal
  if (!matches.length && q.length >= 3) {
    curGroups.value.forEach((g, gi) => {
      (g.items || []).forEach((item, ii) => {
        if ((item.barcode || '').includes(q) || (item.sku || '').includes(q)) {
          matches.push({ gi, ii, item, matchType: 'partial' })
        }
      })
    })
  }

  bcQuery.value = ''

  if (!matches.length) {
    bcError.value = `Barcode「${q}」不存在於此單據`
    return
  }
  bcError.value = ''

  if (matches.length === 1) {
    _proceedWithMatch(matches[0])
    return
  }

  // 多 match → 彈 modal
  skuChoiceModal.scannedBarcode = q
  skuChoiceModal.matches = matches
  skuChoiceModal.open = true
}

// 處理一個 scan 配對結果 → 一律跳去 item view 讓員工人手錄入數量
//
// 2026-09-02 Koro 定:補貨 TR 原本係「自動將 pickQty 填滿 reqQty + 觸發
// autoprint」,倉庫反映「掃 barcode 直接幫我填滿數量,而唔係進入 sku 裡面
// 嘅畫面」—— 員工要自己睇實物填數,唔應該系統代填。現改成同 PO TR 一致。
//
// 連帶影響(已知,Koro 決定接受):掃碼唔再即刻印標籤。item view 裡面
// 打印係 Tab 觸發(見模板 @keydown.tab.exact),手機無 Tab 鍵 → 手機暫時
// 唔印標籤,需要時點 item view 裡嘅「🖨️ 重印標籤」按鈕。
function _proceedWithMatch({ gi, ii, item }) {
  const g = curGroups.value[gi]
  showToast(`✓ 找到: ${g?.displayName || item.sku}`, 'success')
  setTimeout(() => { selGrp.value = gi; view.value = 'item' }, 400)
}

// SKU choice modal: 員工揀邊個 SKU
function pickSkuChoice(m) {
  skuChoiceModal.open = false
  _proceedWithMatch(m)
}
function cancelSkuChoice() {
  skuChoiceModal.open = false
  skuChoiceModal.matches = []
  skuChoiceModal.scannedBarcode = ''
}

// 顯示：item 係「原裝」定「重包」
function _itemKind(item) {
  const bc = item?.barcode || ''
  if (item?.is_bom || /[A-Za-z]$/.test(bc)) {
    const m = parseInt(item?.multiplier) || 1
    return m > 1 ? `重包 ×${m}` : '重包'
  }
  return '原裝'
}

// ============================================================
// 录入 + dirty tracking
// ============================================================
function updItem(item, field, val) {
  item[field] = Math.max(0, parseInt(val) || 0)
  dirty.value = true
}

// ============================================================
// 保存 TR（TR 级乐观锁）
// ============================================================
async function saveTR(opts = {}) {
  // opts.afterSave: 'back' | 'stay'  保存后行为
  if (saving.value || !activeTransfer.value) return
  if (!dirty.value && opts.silent !== true) {
    showToast('沒有需要儲存的修改', 'warning')
    return
  }
  saving.value = true
  try {
    const res = await poApi.saveTransfer(activeTransfer.value.id, {
      groups_data:        activeTransfer.value.groups_data,
      _last_modified_at:  activeTransfer.value.last_modified_at,
    })
    if (res.ok) {
      // 用服务器返回的最新数据更新 activeTransfer（含新 last_modified_at + state + stats）
      activeTransfer.value = res.transfer
      dirty.value = false
      if (res.warning) {
        // 儲存成功但 picking validate 失敗（庫存不足 / 未收貨）
        showToast(`❌ 已儲存，但無法完成出庫：${res.warning}`, 'error', 6000)
      } else {
        showToast('✅ 已儲存', 'success')
      }
      if (opts.afterSave === 'back') {
        view.value = 'trlist'
        activeTransfer.value = null
        await reloadTRList()
      }
    }
  } catch (err) {
    if (err.handledByInterceptor) {
      saving.value = false
      return
    }
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 409) {
      conflictModal.modified_by = data.modified_by || ''
      conflictModal.modified_at = data.modified_at || ''
      conflictModal.server_data = data.server_data || []
      conflictModal.open = true
    } else if (status === 422) {
      // TR 被别人 cut / 标 done 了 — 自动刷新让用户看到现状，并切回 trlist
      showToast(data.detail || '此 TR 已鎖定不可修改，自動返回列表', 'warning')
      // 强制清掉 dirty，避免离开守卫拦截
      dirty.value = false
      await reloadTRList()
      view.value = 'trlist'
      activeTransfer.value = null
      selGrp.value = null
    } else if (status === 404) {
      showToast('TR 不存在（可能已刪除）', 'error')
      dirty.value = false
      await reloadTRList()
      view.value = 'trlist'
      activeTransfer.value = null
      selGrp.value = null
    } else {
      showToast(data.error || '儲存失敗', 'error')
    }
  } finally {
    saving.value = false
  }
}

function saveItem() {
  // item 视图的"確認儲存"按钮 — 只回 trdetail，不立即写后端（让用户多个 group 改完一起 save）
  // 可改成按需立即 save，但跟 demo 一致先回 trdetail
  if (curGroup.value?.items.some(i => (parseInt(i.pickQty) || 0) > (parseInt(i.reqQty) || 0))) {
    showToast('⚠ 存在超揀項目', 'warning')
  }
  view.value = 'trdetail'
}

// ============================================================
// 冲突 modal
// ============================================================
async function acceptServer() {
  // 接受服务器版本 — 重新加载整个 TR（含 server 的 groups_data + 新时间戳）
  conflictModal.open = false
  await reloadAfterConflict()
  dirty.value = false
  showToast('已採用伺服器最新版本', 'success')
}

async function reloadAfterConflict() {
  if (!activeTransfer.value) return
  try {
    const res = await poApi.getTransfer(activeTransfer.value.id)
    activeTransfer.value = res
  } catch { /* ignore */ }
}

async function keepMine() {
  // 保留我的修改 — 只更新 last_modified_at 让乐观锁通过
  // 用户的 groups_data 修改保留不动
  if (!activeTransfer.value) {
    conflictModal.open = false
    return
  }
  try {
    const res = await poApi.getTransfer(activeTransfer.value.id)
    // 只同步时间戳和服务器 state（避免 UI 状态跟服务器脱节），groups_data 保留本地修改
    activeTransfer.value.last_modified_at = res.last_modified_at
    activeTransfer.value.last_modified_by = res.last_modified_by
    // state 不动 — 因为我们要覆盖服务器，state 由保存时 derive
  } catch {
    /* 拉不到时间戳就拉到 — fallback 让用户手动刷 */
  }
  conflictModal.open = false
  // dirty 保留 true，提示用户点保存
  showToast('已加載最新版本號；請點擊「儲存」覆蓋', 'warning')
}

function cancelConflict() {
  conflictModal.open = false
  conflictModal.server_data = null
}

// ============================================================
// 截單出貨（3PL local draft → 真正 Odoo TR）
// ============================================================
function handleCut() {
  if (!activeTransfer.value) return
  let anyPicked = false
  ;(activeTransfer.value.groups_data || []).forEach(g =>
    (g.items || []).forEach(i => {
      if ((parseInt(i.pickQty) || 0) > 0) anyPicked = true
    }),
  )
  if (!anyPicked) { showToast('尚未揀貨，無法截單出貨', 'warning'); return }
  if (dirty.value && !confirm('有未儲存的修改，建議先儲存。是否繼續？')) return
  showCutModal.value = true
}

function closeCutModal() { showCutModal.value = false }

async function executeCut() {
  if (cutting.value || !activeTransfer.value) return
  // 截前先 save 当前的 pickQty（如果 dirty）
  if (dirty.value) {
    await saveTR({ silent: true })
    if (dirty.value) {
      showCutModal.value = false
      return
    }
  }
  cutting.value = true
  try {
    // 3PL local_draft → cutoff endpoint
    const isLocal = activeTransfer.value.is_local_draft
    const res = isLocal
      ? await poApi.cutoffTransfer(activeTransfer.value.id)
      : await poApi.cutTransfer(activeTransfer.value.id)
    showToast(`✓ 截單成功！已產生 ${res.new_transfer.name}`, 'success')
    showCutModal.value = false
    setTimeout(() => {
      view.value = 'trlist'
      activeTransfer.value = null
      reloadTRList()
    }, 600)
  } catch (err) {
    if (err.handledByInterceptor) return
    const data = err.response?.data || {}
    showToast(data.detail || data.error || '截單失敗', 'error')
  } finally {
    cutting.value = false
  }
}

// ============================================================
// Complete（完成 Transfer — 非 3PL 或 3PL 截單後）
// ============================================================
async function doComplete() {
  if (completing.value || !activeTransfer.value) return
  // 3PL local_draft 一鍵完成前先儲存（確保 pickQty 最新）
  if (isLocalDraft.value && dirty.value) {
    await saveTR({ silent: true })
    if (dirty.value) {
      showCompleteModal.value = false
      return
    }
  }
  completing.value = true
  try {
    const res = await poApi.completeTransfer(activeTransfer.value.id)
    activeTransfer.value = res.transfer
    showCompleteModal.value = false
    const msg = isLocalDraft.value
      ? `✅ 已截單並完成出庫！(${res.transfer?.name || ''})`
      : '✅ Transfer 已完成！'
    showToast(msg, 'success')
    setTimeout(() => {
      view.value = 'trlist'
      activeTransfer.value = null
      reloadTRList()
    }, 800)
  } catch (err) {
    if (err.handledByInterceptor) return
    const data = err.response?.data || {}
    showCompleteModal.value = false
    showToast(data.detail || data.error || '完成失敗', 'error', 6000)
  } finally {
    completing.value = false
  }
}

// ============================================================
// 扫码相机（占位）
// ============================================================
function openScanner()  { scannerOpen.value = true }
function closeScanner() { scannerOpen.value = false }
// 相機掃到條碼 → 填入查詢框並查詢
function onScanDetected(code) {
  bcQuery.value = code
  closeScanner()
  scanBC()
}

// ============================================================
// 导出 — stub（沿用 demo 行为，等业务确认要不要做）
// ============================================================
// 匯出單張 TR → Excel(5 列:SKU / Barcode / 中文名 / 入倉數量 / 箱數量)
async function exportTR() {
  const tr = activeTransfer.value
  if (!tr?.id) { showToast('沒有可匯出的 TR', 'warning'); return }
  try {
    const res = await poApi.exportTransferData(tr.id)
    const lines = res.lines || []
    if (!lines.length) { showToast('此 TR 沒有明細可匯出', 'warning'); return }
    const header = ['SKU', 'Barcode', '產品名稱(中文)', '入倉數量', '箱數量']
    const rows = lines.map(l => [l.sku, l.barcode, l.name_cn, l.qty, l.boxes])
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
    ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 30 }, { wch: 10 }, { wch: 8 }]
    const wb = XLSX.utils.book_new()
    const sheetName = (tr.name || 'TR').replace(/[\\/?*[\]:]/g, '').slice(0, 31)
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
    const fname = `${res.po_name ? res.po_name + '_' : ''}${res.tr_name || tr.name || 'TR'}.xlsx`
    XLSX.writeFile(wb, fname)
    showToast('✓ 已匯出 Excel', 'success')
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast(err.response?.data?.error || '匯出失敗', 'error')
    }
  }
}
function exportAllTR() {
  showToast('✓ 匯出功能待實作', 'info')
}

// ============================================================
// 收貨入庫
// ============================================================
async function doReceive() {
  if (receiving.value || !curPO.value) return
  receiving.value = true
  try {
    const res = await poApi.receivePO(curPO.value)
    receiveResult.value = res
    showReceiveModal.value = false
    showToast(`✅ 收貨完成！${res.picking_name}`, 'success')
    await reloadTRList()
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 422 && data.error === 'already_received') {
      showToast(`此 PO 已完成收貨 (${data.picking_name})`, 'warning')
      incomingState.value = 'done'
    } else if (status === 422 && data.error === 'no_counting_data') {
      showToast(data.detail || '所有品項都未點貨', 'warning')
    } else if (status === 422) {
      showToast(data.detail || '無法收貨', 'warning')
    } else if (status === 409) {
      showToast(data.detail || '其他用戶正在收貨', 'warning')
    } else {
      showToast(data.error || data.detail || '收貨失敗', 'error')
    }
  } finally {
    receiving.value = false
    showReceiveModal.value = false
  }
}

// ============================================================
// 路由 / 浏览器离开守卫
// ============================================================
function hasDirty() { return dirty.value }

onBeforeRouteLeave((to, from, next) => {
  if (hasDirty() && !confirm('有未儲存的修改，離開將丟失。確定？')) {
    next(false)
  } else {
    next()
  }
})

function _onBeforeUnload(e) {
  if (!hasDirty()) return
  e.preventDefault()
  e.returnValue = ''
}

const _route = useRoute()
const _router = useRouter()

async function _autoLoadFromQuery() {
  const poName = (_route.query?.po || '').toString().trim()
  const trName = (_route.query?.tr || '').toString().trim()
  if (!poName && !trName) return
  if (poName && curPO.value === poName) return
  if (trName && curPO.value === trName) return
  _router.replace({ name: _route.name, query: {} })
  if (poName) {
    poInput.value = poName
    await _loadByPO(poName)
  } else {
    poInput.value = trName
    await _loadByTRName(trName)
  }
}

onMounted(() => {
  window.addEventListener('beforeunload', _onBeforeUnload)
  _autoLoadFromQuery()
  if (autoRefresh.value) startTRPoll()
})
onActivated(() => {
  _autoLoadFromQuery()
  if (autoRefresh.value) startTRPoll()
})
onDeactivated(stopTRPoll)
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', _onBeforeUnload)
  stopTRPoll()
})
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
          <label class="block text-[11px] font-bold tracking-widest mb-3" style="color:rgba(196,181,253,.7);">PO / TR Number</label>
          <input
            v-model="poInput"
            @keydown.enter="searchPO"
            class="w-full px-5 py-4 rounded-2xl text-white text-xl font-bold text-center outline-none mb-4"
            style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);"
            placeholder="輸入 PO / TR / WH/OUT/... Number..."
            :disabled="loading"
          />
          <button
            class="w-full py-4 text-white border-0 rounded-2xl font-bold text-base cursor-pointer disabled:opacity-50"
            style="background:linear-gradient(90deg,#f97316,#ec4899);box-shadow:0 8px 24px rgba(249,115,22,.3);"
            :disabled="loading"
            @click="searchPO"
          >{{ loading ? '載入中…' : '搜尋' }}</button>
        </div>
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
        <!-- 自動刷新開關（WMS 同款滑動開關 + 脉冲點，每 10s）-->
        <div class="g-toggle-wrap" style="gap:6px;">
          <span class="flex items-center gap-1 text-[11px] text-white/80 select-none whitespace-nowrap">
            <span class="w-2 h-2 rounded-full"
                  :class="autoRefresh ? 'bg-emerald-400 animate-pulse' : 'bg-white/30'"></span>
            {{ autoRefresh ? '每 10s' : '已暫停' }}
          </span>
          <button class="g-toggle" :class="{ on: autoRefresh }"
                  :aria-label="autoRefresh ? '關閉自動刷新' : '開啟自動刷新'"
                  :title="autoRefresh ? '自動刷新已開啟（每 10 秒）；點擊暫停' : '自動刷新已暫停；點擊開啟'"
                  @click="autoRefresh = !autoRefresh"></button>
        </div>
        <button
          v-if="trList.length > 0"
          class="flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-xs font-bold cursor-pointer disabled:opacity-50 relative"
          style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
          :disabled="loading"
          title="刷新最新数据;若收货分配新增了 SKU,会增量补充 TR(不影响已有进度)"
          @click="refreshAndSyncTRs"
        >🔄 {{ loading ? '更新中…' : '更新數據' }}
          <span v-if="hasUncovered"
                class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-[10px] font-black text-amber-900 flex items-center justify-center"
          >{{ uncoveredLines.length }}</span>
        </button>
        <button
          v-if="trList.length > 0"
          class="flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-xs font-bold cursor-pointer"
          style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
          @click="exportAllTR"
        >⬇ 匯出全部</button>
      </div>
      <div v-if="trList.length > 0" class="grid grid-cols-3 gap-3">
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

    <!-- 收貨狀態 -->
    <div class="px-4 pt-3 flex-shrink-0">
      <div v-if="incomingState === 'done'" class="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-sm text-emerald-700 font-semibold flex items-center gap-2">
        ✅ 已完成收貨入庫
      </div>
      <button
        v-else
        class="w-full py-3.5 text-white border-0 rounded-2xl font-bold text-sm cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
        style="background:linear-gradient(90deg,#059669,#10b981);box-shadow:0 8px 24px rgba(5,150,105,.3);"
        :disabled="receiving"
        @click="showReceiveModal = true"
      >{{ receiving ? '處理中…' : incomingState === 'partial' ? '📦 繼續收貨 (部分已收)' : '📦 收貨入庫' }}</button>
    </div>

    <!-- 没 TR：显示生成按钮 -->
    <div v-if="trList.length === 0" class="flex-1 flex items-center justify-center p-8">
      <div class="text-center max-w-md">
        <div class="text-6xl mb-4">📋</div>
        <h2 class="text-lg font-bold text-slate-700 mb-2">此 PO 尚未生成 Transfer Orders</h2>
        <p class="text-sm text-slate-500 mb-6">基於 M3b 收貨分配 的方案，每個目的倉自動生成一張 TR</p>
        <button
          class="px-8 py-4 text-white border-0 rounded-2xl font-bold text-base cursor-pointer disabled:opacity-50"
          style="background:linear-gradient(90deg,#f97316,#ec4899);box-shadow:0 8px 24px rgba(249,115,22,.3);"
          :disabled="loading"
          @click="generateTRs"
        >{{ loading ? '生成中…' : '⚡ 生成 Transfer Orders' }}</button>
        <p class="text-xs text-slate-400 mt-4">如還沒在 M3b 錄分配方案，請先去「收貨分配」</p>
      </div>
    </div>

    <template v-else>
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
            :key="tr.id || tr.name"
            class="bg-white rounded-2xl shadow-sm border overflow-hidden cursor-pointer transition-all hover:-translate-y-px"
            :class="tr.is_replenishment ? 'border-teal-200 ring-1 ring-teal-100'
                  : tr.highlight       ? 'border-amber-300 ring-1 ring-amber-200'
                  : 'border-gray-100'"
            @click="tr.id ? openTR(tr.id) : _loadByTRName(tr.name)"
          >
            <div class="px-5 py-4">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-3">
                  <div
                    class="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow"
                    :style="{ background: tr.state === 'done'
                      ? 'linear-gradient(135deg,#34d399,#059669)'
                      : tr.is_replenishment
                        ? 'linear-gradient(135deg,#5eead4,#0d9488)'
                        : tr.is_local_draft
                          ? 'linear-gradient(135deg,#a78bfa,#7c3aed)'
                          : trStats(tr).total_pick > 0
                            ? 'linear-gradient(135deg,#818cf8,#7c3aed)'
                            : 'linear-gradient(135deg,#d1d5db,#9ca3af)' }"
                  >{{ tr.is_replenishment ? '🔄' : tr.is_local_draft ? '📝' : '🚚' }}</div>
                  <div>
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-bold text-[15px] text-slate-800">{{ tr.name }}</span>
                      <span
                        v-if="tr.is_replenishment"
                        class="text-[11px] px-2 py-px rounded-xl font-bold border bg-teal-50 text-teal-700 border-teal-200"
                      >補貨</span>
                      <span
                        v-if="tr.parent_ref"
                        class="text-[11px] px-2 py-px rounded-xl font-bold border bg-purple-50 text-purple-700 border-purple-200"
                      >Ref: {{ tr.parent_ref }}</span>
                      <span
                        v-else-if="isCutTr(tr)"
                        class="text-[11px] px-2 py-px rounded-xl font-bold border"
                        style="background:linear-gradient(90deg,#fef3c7,#fed7aa);color:#c2410c;border-color:#fdba74;"
                      >第二轉</span>
                    </div>
                    <div class="text-xs text-slate-400 font-semibold mt-0.5">{{ tr.source_warehouse }} → {{ tr.dest_warehouse }}</div>
                  </div>
                </div>
                <span
                  class="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold"
                  :class="trStateBadge(tr.state).cls"
                >{{ trStateBadge(tr.state).l }}</span>
              </div>
              <div class="flex gap-4 text-xs text-slate-500 mb-3">
                <span>品項 <strong class="text-slate-700">{{ trStats(tr).done_groups }}/{{ trStats(tr).groups }}</strong></span>
                <span>揀貨 <strong class="text-slate-700">{{ trStats(tr).total_pick }}/{{ trStats(tr).total_req }}</strong></span>
                <span>箱數 <strong class="text-slate-700">{{ trStats(tr).total_boxes }}</strong></span>
              </div>
              <div class="flex items-center gap-3">
                <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden flex-1">
                  <div
                    class="h-full rounded-full transition-[width] duration-500"
                    :class="progressClass(trPct(tr))"
                    :style="{ width: Math.min(trPct(tr), 100) + '%' }"
                  ></div>
                </div>
                <span
                  class="text-xs font-bold"
                  :style="{ color: trPct(tr) >= 100 ? '#059669' : '#64748b' }"
                >{{ trPct(tr) }}%</span>
              </div>
              <!-- Print pick list button (3PL TRs only) -->
              <div v-if="tr.dest_warehouse === '3PL'" class="mt-2.5 flex justify-end" @click.stop>
                <button
                  class="px-3 py-1.5 text-[11px] font-bold rounded-lg border cursor-pointer disabled:opacity-50"
                  style="background:#f0fdf4;color:#059669;border-color:#bbf7d0;"
                  :disabled="printingPicklist"
                  @click.stop="printPickListForTR(tr)"
                  title="列印揀貨單 (100×150mm)"
                >{{ printingPicklist ? '…' : '🖨️ 揀貨單' }}</button>
              </div>
            </div>
          </div>
          <div v-if="!filteredTRs.length" class="text-center text-slate-400 py-12 text-sm">沒有符合的單據</div>

          <!-- 未覆蓋行區塊 — 補充 TR -->
          <div v-if="hasUncovered" class="mt-4 rounded-2xl border-2 border-amber-200 bg-amber-50 overflow-hidden">
            <div class="px-4 py-3 bg-amber-100/60 border-b border-amber-200 flex items-center justify-between">
              <div>
                <span class="text-sm font-bold text-amber-800">⚠️ {{ uncoveredLines.length }} 個 SKU 未加入 Transfer</span>
                <p class="text-xs text-amber-600 mt-0.5">已分配但尚未加入任何 TR</p>
              </div>
              <button
                class="px-4 py-2 text-white border-0 rounded-xl text-xs font-bold cursor-pointer disabled:opacity-50"
                style="background:linear-gradient(90deg,#f59e0b,#d97706);box-shadow:0 4px 12px rgba(245,158,11,.3);"
                :disabled="loading"
                @click="generateTRs"
              >{{ loading ? '生成中…' : `⚡ 生成補充 TR (${uncoveredLines.length})` }}</button>
            </div>
            <div class="divide-y divide-amber-100">
              <div
                v-for="line in uncoveredLines"
                :key="line.po_line_id"
                class="px-4 py-2.5 flex items-center gap-3"
              >
                <span class="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-400"></span>
                <div class="flex-1 min-w-0">
                  <span class="text-sm font-semibold text-slate-700">{{ line.sku || '—' }}</span>
                  <span class="text-xs text-slate-500 ml-2 truncate">{{ line.name }}</span>
                </div>
                <div class="text-right flex-shrink-0">
                  <div class="text-xs text-slate-500">PO {{ line.qty }}</div>
                  <div class="text-[11px] mt-0.5 text-emerald-600">✓ 可生成</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>

  <!-- ===== 状态 3：TR 详情 ===== -->
  <div v-else-if="view === 'trdetail'" class="m3c-wrap h-full">
    <!-- 顶部 -->
    <div class="text-white px-4 py-3 flex-shrink-0 flex items-center gap-2.5" style="background:linear-gradient(90deg,#312e81,#4c1d95);">
      <button class="bg-transparent border-0 text-white text-xl cursor-pointer p-2" @click="goBack">‹</button>
      <div class="flex-1 min-w-0">
        <h1 class="text-base font-black truncate">{{ activeTransfer?.name }}</h1>
        <p class="text-xs" style="color:rgba(167,139,250,.5);">
          {{ activeTransfer?.source_warehouse }} → {{ activeTransfer?.dest_warehouse }}
          <span v-if="dirty" class="ml-1 px-1.5 py-px rounded text-[10px] font-bold" style="background:#fbbf24;color:#78350f;">● 未儲存</span>
        </p>
      </div>
      <!-- 揀貨單快捷列印（3PL 模式） -->
      <button
        v-if="isLocalDraft"
        class="px-2.5 py-2 rounded-xl text-white cursor-pointer text-xs font-bold disabled:opacity-50"
        style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
        :disabled="printingPicklist"
        @click="printPickListForTR(null)"
        title="列印揀貨單 (100×150mm)"
      >{{ printingPicklist ? '…' : '🖨️' }}</button>
      <button
        class="px-3 py-2 rounded-xl text-white cursor-pointer"
        style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
        @click="refreshNow"
      >🔄</button>
      <div v-if="isLocalDraft" class="text-right px-3 py-1 rounded-xl" style="background:rgba(255,255,255,.1);">
        <div class="text-xl font-black leading-none" style="color:#fdba74;">{{ detailStats.bx }}</div>
        <div class="text-[11px] mt-0.5" style="color:rgba(167,139,250,.4);">箱</div>
      </div>
    </div>

    <!-- 进度 — 3PL 顯示揀貨進度 -->
    <div v-if="isLocalDraft" class="bg-white border-b border-gray-100 px-4 py-3 flex-shrink-0">
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

    <!-- 非 3PL：品項總數 -->
    <div v-if="!isLocalDraft && !isCompleted && activeTransfer?.state !== 'cut'" class="bg-white border-b border-gray-100 px-4 py-3 flex-shrink-0">
      <div class="text-xs text-slate-500">共 <strong class="text-slate-700">{{ detailStats.total }}</strong> 個品項，需求合計 <strong class="text-slate-700">{{ detailStats.rq }}</strong></div>
    </div>

    <!-- 已截单提示 -->
    <div v-if="activeTransfer?.state === 'cut'" class="bg-orange-50 border-b border-orange-200 px-4 py-3 text-xs font-semibold text-orange-700">
      ⚠️ 此 TR 已截單，已鎖定不可修改。剩餘部分請去新建的「第二轉」TR 處理。
    </div>

    <!-- 已完成提示 -->
    <div v-if="isCompleted" class="bg-emerald-50 border-b border-emerald-200 px-4 py-3 text-sm font-semibold text-emerald-700 flex items-center gap-2">
      ✅ 此 Transfer 已完成出庫
    </div>

    <!-- 待完成提示（非 3PL 或 3PL 截單後）-->
    <div v-if="isReadyToComplete" class="bg-blue-50 border-b border-blue-200 px-4 py-3 text-xs font-semibold text-blue-700 flex items-center gap-2">
      📋 此 Transfer 待完成出庫。確認收貨後可按底部「完成」按鈕。
    </div>

    <!-- 3PL 點貨提示：全部未點 / 部分已點 -->
    <div v-if="isLocalDraft && !countingReady" class="bg-amber-50 border-b border-amber-200 px-4 py-3 text-sm font-semibold text-amber-700 flex items-center gap-2">
      {{ anyCounted ? '⏳ 部分貨物尚未點貨，未點的品項暫時鎖定。' : '⏳ 等待點貨 — 貨物尚未完成點貨，暫時無法開始揀貨。' }}
    </div>

    <!-- 扫码（仅 3PL 揀貨模式 + 至少一件已點貨）-->
    <div v-if="isLocalDraft && anyCounted" class="px-4 py-3 border-b border-gray-200 flex-shrink-0" style="background:linear-gradient(180deg,#f3f4f6,#f9fafb);">
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

    <!-- 表头 — 3PL 揀貨模式 -->
    <div v-if="isLocalDraft" class="flex items-center px-4 py-2 border-b border-gray-200 text-[11px] font-bold tracking-wider flex-shrink-0" style="background:rgba(241,245,249,.8);color:#94a3b8;">
      <div class="flex-1">品項</div>
      <div class="w-11 text-center">需求</div>
      <div class="w-11 text-center ml-2">揀貨</div>
      <div class="w-11 text-center ml-2">箱</div>
      <div class="w-8 text-center ml-1">狀態</div>
      <div class="w-8 ml-1"></div>
    </div>
    <!-- 表头 — 非 3PL（SD4/WS/SAMPL 等）: 只有品項 + 數量 -->
    <div v-else class="flex items-center px-4 py-2 border-b border-gray-200 text-[11px] font-bold tracking-wider flex-shrink-0" style="background:rgba(241,245,249,.8);color:#94a3b8;">
      <div class="flex-1">品項</div>
      <div class="w-14 text-center">數量</div>
    </div>

    <!-- 品项列表 — 3PL 揀貨模式 -->
    <div v-if="isLocalDraft" class="flex-1 overflow-y-auto">
      <div
        v-for="(g, gi) in curGroups"
        :key="g.id"
        class="flex items-center px-4 py-3.5 border-b border-gray-100 cursor-pointer transition-colors"
        :class="[
          groupStatus(g) === 'done' ? 'bg-emerald-50/60' : 'bg-white hover:bg-slate-50',
          (g.items || []).some(i => !i.item_counted) ? 'opacity-50' : ''
        ]"
        @click="openItem(gi)"
      >
        <div class="flex-1 min-w-0 pr-2">
          <div class="flex items-center gap-1.5 mb-0.5">
            <span v-if="(g.items || []).some(i => !i.item_counted)" class="shrink-0 text-sm">🔒</span>
            <span class="font-bold text-sm text-slate-800 truncate">{{ g.displayName }}</span>
            <span
              v-if="(g.items || []).some(i => i.is_bom)"
              class="shrink-0 text-[10px] px-1.5 py-px rounded-md font-bold border"
              style="background:linear-gradient(90deg,#fed7aa,#fce7f3);color:#c2410c;border-color:#fdba74;"
            >BOM</span>
          </div>
          <div class="text-[11px] text-slate-400 break-words">{{ pureName(g) }}{{ g.labelType ? ' · ' + g.labelType : '' }}</div>
        </div>
        <div class="w-11 text-center text-sm font-bold text-slate-700">{{ (g.items || []).reduce((a,i) => a+(parseInt(i.reqQty)||0), 0) }}</div>
        <div
          class="w-11 text-center text-sm font-bold ml-2"
          :style="{
            color: (g.items || []).reduce((a,i) => a+(parseInt(i.pickQty)||0), 0) >= (g.items || []).reduce((a,i) => a+(parseInt(i.reqQty)||0), 0) && (g.items || []).reduce((a,i) => a+(parseInt(i.reqQty)||0), 0) > 0
              ? '#059669'
              : (g.items || []).reduce((a,i) => a+(parseInt(i.pickQty)||0), 0) > 0 ? '#d97706' : '#d1d5db'
          }"
        >{{ (g.items || []).reduce((a,i) => a+(parseInt(i.pickQty)||0), 0) }}</div>
        <div class="w-11 text-center text-sm text-slate-500 ml-2">{{ (g.items || []).reduce((a,i) => a+(parseInt(i.boxes)||0), 0) }}</div>
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
        <!-- 列印標籤快捷鍵：有 pickQty 時顯示 -->
        <button
          v-if="(g.items || []).some(i => (parseInt(i.pickQty)||0) > 0)"
          class="w-8 flex items-center justify-center ml-1 shrink-0 bg-transparent border-0 cursor-pointer text-base leading-none"
          title="列印標籤"
          @click.stop="printGroupLabel(g)"
        >🖨️</button>
        <div v-else class="w-8 ml-1 shrink-0"></div>
      </div>
    </div>

    <!-- 品项列表 — 非 3PL（SD4/WS/SAMPL 等）: 只讀顯示數量 -->
    <div v-else class="flex-1 overflow-y-auto">
      <div
        v-for="(g, gi) in curGroups"
        :key="g.id"
        class="flex items-center px-4 py-3.5 border-b border-gray-100 bg-white"
      >
        <div class="flex-1 min-w-0 pr-2">
          <div class="flex items-center gap-1.5 mb-0.5">
            <span class="font-bold text-sm text-slate-800 truncate">{{ g.displayName }}</span>
            <span
              v-if="(g.items || []).some(i => i.is_bom)"
              class="shrink-0 text-[10px] px-1.5 py-px rounded-md font-bold border"
              style="background:linear-gradient(90deg,#fed7aa,#fce7f3);color:#c2410c;border-color:#fdba74;"
            >BOM</span>
          </div>
          <div class="text-[11px] text-slate-400 break-words">{{ pureName(g) }}{{ g.labelType ? ' · ' + g.labelType : '' }}</div>
        </div>
        <div class="w-14 text-center text-sm font-black text-slate-700">{{ (g.items || []).reduce((a,i) => a+(parseInt(i.reqQty)||0), 0) }}</div>
      </div>
    </div>

    <!-- 底部操作 — 3PL 揀貨模式 -->
    <div v-if="isLocalDraft" class="flex-shrink-0 bg-white border-t border-gray-200 px-4 sm:px-5 py-4 flex flex-col gap-3 safe-pb">
      <!-- 全部揀完：一鍵截單並完成出庫 -->
      <button
        v-if="isFullyPicked"
        class="w-full py-3.5 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
        style="background:linear-gradient(90deg,#059669,#10b981);box-shadow:0 8px 24px rgba(5,150,105,.3);color:#fff;border:none;"
        :disabled="completing || saving"
        @click="showCompleteModal = true"
      >{{ completing ? '處理中…' : '✅ 完成出庫' }}</button>
      <!-- 截單出貨：部分出貨或強制分批 -->
      <!-- 截單出貨：只限 PO TR（補貨 TR 已有 picking，唔需要 cutoff） -->
      <button
        v-if="!activeTransfer?.is_replenishment"
        class="w-full py-3.5 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
        style="border:2px solid #fbbf24;background:linear-gradient(90deg,#fffbeb,#fff7ed);color:#b45309;"
        :disabled="cutting || !anyCounted"
        @click="handleCut"
      >✂️ 截單出貨</button>
      <div class="flex gap-3">
        <button
          class="flex-1 py-4 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2 bg-transparent"
          style="border:2px solid #6366f1;color:#4f46e5;"
          @click="exportTR"
        >⬇ 匯出 Excel</button>
        <button
          class="flex-1 py-4 text-white border-0 rounded-2xl font-bold text-[15px] cursor-pointer disabled:opacity-50"
          style="background:linear-gradient(90deg,#4f46e5,#7c3aed);box-shadow:0 8px 24px rgba(79,70,229,.2);"
          :disabled="saving || !anyCounted"
          @click="saveTR({ afterSave: 'back' })"
        >{{ saving ? '⏳' : '💾 儲存單據' }}</button>
      </div>
    </div>

    <!-- 底部操作 — 待完成模式（非 3PL 或 3PL 截單後）-->
    <div v-else-if="isReadyToComplete" class="flex-shrink-0 bg-white border-t border-gray-200 px-4 sm:px-5 py-4 flex flex-col gap-3 safe-pb">
      <button
        class="w-full py-4 text-white border-0 rounded-2xl font-bold text-[15px] cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
        style="background:linear-gradient(90deg,#059669,#10b981);box-shadow:0 8px 24px rgba(5,150,105,.3);"
        :disabled="completing"
        @click="showCompleteModal = true"
      >{{ completing ? '處理中…' : '✅ 完成出庫' }}</button>
      <button
        class="w-full py-3 rounded-2xl font-bold text-sm cursor-pointer bg-transparent flex items-center justify-center gap-2"
        style="border:2px solid #6366f1;color:#4f46e5;"
        @click="exportTR"
      >⬇ 匯出 Excel</button>
    </div>

    <!-- 底部操作 — 已完成/已截單：只有匯出 -->
    <div v-else-if="isCompleted || activeTransfer?.state === 'cut'" class="flex-shrink-0 bg-white border-t border-gray-200 px-4 sm:px-5 py-4 safe-pb">
      <button
        class="w-full py-3 rounded-2xl font-bold text-sm cursor-pointer bg-transparent flex items-center justify-center gap-2"
        style="border:2px solid #6366f1;color:#4f46e5;"
        @click="exportTR"
      >⬇ 匯出 Excel</button>
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
        <span v-if="curGroup?.labelType" class="px-3 py-1 rounded-lg font-bold border" style="background:#f5f3ff;color:#7c3aed;border-color:#e9d5ff;">{{ curGroup?.labelType }}</span>
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
        :key="`${item.sku}_${idx}`"
        class="rounded-2xl p-5 border-2 shadow-sm transition-colors"
        :class="[
          isItemLocked(item) ? 'opacity-60 bg-slate-50 border-slate-200'
            : (parseInt(item.pickQty)||0) > (parseInt(item.reqQty)||0) ? 'bg-red-50 border-red-200'
            : (parseInt(item.pickQty)||0) >= (parseInt(item.reqQty)||0) && (parseInt(item.reqQty)||0) > 0 ? 'bg-emerald-50 border-emerald-200'
            : 'bg-white border-slate-100'
        ]"
      >
        <!-- 未點貨鎖定提示 -->
        <div v-if="isLocalDraft && !item.item_counted" class="mb-3 flex items-center gap-2 text-xs font-bold text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
          🔒 此品項尚未點貨
        </div>

        <div class="mb-4">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="font-bold text-sm text-slate-800">{{ item.sku }}</span>
            <span
              v-if="item.is_bom"
              class="text-[11px] px-2 py-0.5 rounded-xl font-bold border"
              style="background:linear-gradient(90deg,#fed7aa,#fce7f3);color:#c2410c;border-color:#fdba74;"
            >Repack ×{{ item.multiplier }}</span>
            <span v-if="!isItemLocked(item) && (parseInt(item.pickQty)||0) >= (parseInt(item.reqQty)||0) && (parseInt(item.reqQty)||0) > 0 && (parseInt(item.pickQty)||0) <= (parseInt(item.reqQty)||0)">
              <div class="inline-flex w-5 h-5 rounded-full bg-emerald-500 items-center justify-center text-white text-[10px]">✓</div>
            </span>
            <span v-if="!isItemLocked(item) && (parseInt(item.pickQty)||0) > (parseInt(item.reqQty)||0)" class="text-red-600 text-[11px] font-black bg-red-100 px-2 py-0.5 rounded-xl">超揀!</span>
          </div>
          <div class="text-xs text-slate-400">{{ item.name }}</div>
          <div
            v-if="item.is_bom"
            class="text-xs font-bold mt-1.5 inline-block px-2 py-0.5 rounded-md"
            style="background:#fff7ed;color:#ea580c;"
          >需揀單件: {{ (parseInt(item.reqQty)||0) * (parseInt(item.multiplier)||1) }}</div>
        </div>

        <!-- 3PL 揀貨模式：需求 + 揀貨 + 箱數 -->
        <div v-if="isLocalDraft" class="flex gap-3">
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">需求</label>
            <div class="h-12 flex items-center justify-center bg-slate-50 rounded-xl border border-slate-200 text-lg font-black text-slate-800">{{ item.reqQty }}</div>
          </div>
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">揀貨</label>
            <input
              :ref="el => (qtyEls[idx] = el)"
              :value="(parseInt(item.pickQty)||0) === 0 ? '' : item.pickQty"
              type="number"
              inputmode="numeric"
              placeholder="0"
              class="w-full h-12 text-center text-lg font-black rounded-xl outline-none border-2"
              :class="isItemLocked(item) ? 'border-slate-200 bg-slate-100 text-slate-400'
                : (parseInt(item.pickQty)||0) > (parseInt(item.reqQty)||0) ? 'border-red-300 bg-red-50 text-red-600'
                : (parseInt(item.pickQty)||0) >= (parseInt(item.reqQty)||0) && (parseInt(item.reqQty)||0) > 0 ? 'border-emerald-300 bg-emerald-50 text-emerald-600'
                : 'border-slate-200 bg-white text-slate-800'"
              :disabled="isItemLocked(item)"
              @input="updItem(item, 'pickQty', $event.target.value)"
              @keydown.enter.prevent="tabToBox(idx)"
              @keydown.tab.exact.prevent="qtyPrint(item)"
            />
          </div>
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">箱數</label>
            <input
              :ref="el => (boxEls[idx] = el)"
              :value="(parseInt(item.boxes)||0) === 0 ? '' : item.boxes"
              type="number"
              inputmode="numeric"
              placeholder="0"
              class="w-full h-12 text-center text-lg font-black rounded-xl outline-none border-2 border-slate-200 bg-white text-slate-800"
              :disabled="isItemLocked(item)"
              @input="updItem(item, 'boxes', $event.target.value)"
              @keydown.enter="boxEnter(idx)"
              @keydown.tab.exact.prevent="boxEnter(idx)"
            />
          </div>
        </div>
        <!-- Reprint labels button — shown once pickQty > 0 -->
        <div v-if="isLocalDraft && !isItemLocked(item) && (parseInt(item.pickQty)||0) > 0" class="flex justify-end mt-2">
          <button
            class="px-3 py-1.5 text-[11px] font-bold rounded-lg border cursor-pointer"
            style="background:#f0fdf4;color:#059669;border-color:#bbf7d0;"
            @click="reprintItemLabels(item)"
            title="重新列印標籤"
          >🖨️ 重印標籤</button>
        </div>
        <!-- 非 3PL：只讀顯示數量 -->
        <div v-if="!isLocalDraft" class="flex gap-3">
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">數量</label>
            <div class="h-12 flex items-center justify-center bg-slate-50 rounded-xl border border-slate-200 text-lg font-black text-slate-800">{{ item.reqQty }}</div>
          </div>
        </div>

        <!-- 組合裝:列出組件 SKU / 名稱 / 條碼(只核對,不用填數量) -->
        <div
          v-if="item.is_bom && (item.components || []).length"
          class="mt-3 rounded-xl border-2 p-3"
          style="background:#fffbeb;border-color:#fcd34d;"
        >
          <div class="text-[11px] font-black tracking-wide mb-2" style="color:#b45309;">
            📦 此套裝包含 {{ item.components.length }} 件散裝 SKU（只需核對，不用填數量）
          </div>
          <div
            v-for="(c, ci) in item.components"
            :key="ci"
            class="py-2"
            :class="ci ? 'border-t' : ''"
            :style="ci ? 'border-color:#fde68a;' : ''"
          >
            <div class="flex items-baseline gap-2 flex-wrap">
              <span class="font-black text-slate-800 text-[15px]">{{ c.sku }}</span>
              <span class="text-[11px] font-bold px-1.5 py-0.5 rounded" style="background:#fde68a;color:#92400e;">每套 ×{{ c.qty }}</span>
              <span class="text-[11px] font-bold" style="color:#b45309;">本單共 {{ Math.round((c.qty || 0) * (parseInt(item.reqQty) || 0)) }} 件</span>
            </div>
            <div class="text-xs text-slate-600 leading-snug mt-0.5">{{ c.name }}</div>
            <div class="text-[12px] font-mono mt-0.5" style="color:#64748b;">
              {{ c.barcode || '（無條碼）' }}
            </div>
          </div>
        </div>
      </div>

      <!-- 到期日提醒水印 — 灰色大字,提醒工人核对实物到期日(日期同標籤 FEFO) -->
      <div
        v-if="curGroupExpDates.length"
        class="flex-1 flex flex-col items-center justify-center text-center select-none pointer-events-none py-8"
        style="color:#cbd5e1;"
      >
        <div class="font-black tracking-wider" style="font-size:24px;line-height:1.5;">請檢查日期</div>
        <div
          v-for="d in curGroupExpDates"
          :key="d"
          class="font-black tracking-wide"
          style="font-size:40px;line-height:1.35;"
        >{{ d }}</div>
      </div>
    </div>

    <!-- 底部操作 -->
    <div class="flex-shrink-0 flex border-t border-gray-200 bg-white safe-pb">
      <button class="flex-1 py-4 text-white border-0 font-bold text-[15px] cursor-pointer disabled:opacity-60" style="background:linear-gradient(90deg,#4f46e5,#7c3aed);" :disabled="saving" @click="saveAndBack">
        {{ isLocalDraft && !isLocked ? (saving ? '儲存中…' : '💾 儲存並返回') : '← 返回' }}
      </button>
    </div>
  </div>

  <!-- SKU 選擇 Modal — 掃碼配對到多個 SKU（base + repack）時用 -->
  <div v-if="skuChoiceModal.open" class="fixed inset-0 z-[200] flex items-center justify-center" @click.self="cancelSkuChoice">
    <div class="absolute inset-0" style="background:rgba(0,0,0,.6);backdrop-filter:blur(16px);" @click="cancelSkuChoice"></div>
    <div class="relative w-full max-w-md mx-4 bg-white rounded-3xl shadow-2xl overflow-hidden">
      <div class="px-5 pt-5 pb-4 border-b border-gray-100">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg" style="background:linear-gradient(135deg,#f97316,#ec4899);">⚠</div>
          <div>
            <h2 class="text-lg font-black text-slate-800">請揀邊個 SKU</h2>
            <p class="text-xs text-slate-400">掃描 barcode「{{ skuChoiceModal.scannedBarcode }}」配對到多個品項</p>
          </div>
        </div>
      </div>
      <div class="px-5 py-4">
        <p class="text-xs text-slate-500 mb-3">呢個 barcode 同時對應原裝 + 重包，請揀你要揀邊個：</p>
        <div class="flex flex-col gap-2.5">
          <button
            v-for="(m, mi) in skuChoiceModal.matches"
            :key="mi"
            class="text-left rounded-2xl border-2 cursor-pointer transition-all hover:-translate-y-px"
            :class="(m.item.is_bom || /[A-Za-z]$/.test(m.item.barcode || ''))
              ? 'border-orange-200 bg-orange-50 hover:border-orange-300'
              : 'border-indigo-200 bg-indigo-50 hover:border-indigo-300'"
            @click="pickSkuChoice(m)"
          >
            <div class="px-4 py-3">
              <div class="flex items-center justify-between mb-1.5">
                <span
                  class="text-[11px] font-bold px-2 py-0.5 rounded-full"
                  :class="(m.item.is_bom || /[A-Za-z]$/.test(m.item.barcode || ''))
                    ? 'bg-orange-200 text-orange-900'
                    : 'bg-indigo-200 text-indigo-900'"
                >{{ _itemKind(m.item) }}</span>
                <span class="text-xs font-mono text-slate-500">{{ m.item.barcode }}</span>
              </div>
              <div class="text-sm font-bold text-slate-800 truncate mb-0.5">{{ m.item.name }}</div>
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-mono text-slate-500">{{ m.item.sku }}</span>
                <span class="text-sm font-black text-slate-700">需 {{ m.item.reqQty }} 件</span>
              </div>
            </div>
          </button>
        </div>
      </div>
      <div class="flex-shrink-0 px-5 py-4 border-t border-gray-100">
        <button
          class="w-full py-3 bg-transparent rounded-2xl font-bold text-sm cursor-pointer"
          style="border:2px solid #e2e8f0;color:#64748b;"
          @click="cancelSkuChoice"
        >取消</button>
      </div>
    </div>
  </div>

  <!-- 截單 Modal -->
  <div v-if="showCutModal" class="fixed inset-0 z-[200] flex items-center justify-center" @click.self="closeCutModal">
    <div class="absolute inset-0" style="background:rgba(0,0,0,.6);backdrop-filter:blur(16px);" @click="closeCutModal"></div>
    <div class="relative w-full max-w-lg mx-4 bg-white rounded-3xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
      <div class="px-5 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">
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

      <div class="px-5 py-5 flex flex-col gap-4 overflow-y-auto flex-1 min-h-0" style="-webkit-overflow-scrolling:touch;">
        <!-- 第一转 -->
        <div class="rounded-2xl border-2 overflow-hidden" style="border-color:#c7d2fe;">
          <div class="text-white px-4 py-3 flex justify-between" style="background:linear-gradient(90deg,#6366f1,#7c3aed);">
            <div>
              <div class="text-[11px] font-bold opacity-70 tracking-widest">第一轉 · 本次出貨</div>
              <div class="font-black text-[15px] mt-0.5">{{ activeTransfer?.name }}</div>
            </div>
            <div class="text-right">
              <div class="text-2xl font-black">{{ cutPreview.ft }}</div>
              <div class="text-[11px] opacity-70">件</div>
            </div>
          </div>
          <div v-for="(i, idx) in cutPreview.first" :key="`f_${idx}`" class="px-4 py-2.5 flex items-center justify-between border-b border-gray-50">
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
              <div class="font-black text-[15px] mt-0.5">{{ cutPreview.nid }} <span class="text-[11px] px-2 py-px rounded-xl ml-1" style="background:rgba(255,255,255,.2);">後端自動產生</span></div>
            </div>
            <div class="text-right">
              <div class="text-2xl font-black">{{ cutPreview.st }}</div>
              <div class="text-[11px] opacity-70">件</div>
            </div>
          </div>
          <div v-for="(i, idx) in cutPreview.second" :key="`s_${idx}`" class="px-4 py-2.5 flex items-center justify-between border-b border-gray-50">
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
        <button class="flex-1 py-3.5 bg-transparent rounded-2xl font-bold text-[15px] cursor-pointer" style="border:2px solid #e2e8f0;color:#64748b;" :disabled="cutting" @click="closeCutModal">取消</button>
        <button
          class="flex-1 py-3.5 text-white border-0 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
          style="background:linear-gradient(90deg,#f59e0b,#f97316);box-shadow:0 8px 24px rgba(245,158,11,.2);"
          :disabled="cutting"
          @click="executeCut"
        >{{ cutting ? '處理中…' : '✂ 確認截單' }}</button>
      </div>
    </div>
  </div>

  <!-- 完成確認 Modal -->
  <div v-if="showCompleteModal" class="fixed inset-0 z-[200] flex items-center justify-center" @click.self="showCompleteModal = false">
    <div class="absolute inset-0" style="background:rgba(0,0,0,.6);backdrop-filter:blur(16px);" @click="showCompleteModal = false"></div>
    <div class="relative w-full max-w-md mx-4 bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] sm:max-h-[85vh]">
      <div class="px-5 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg" style="background:linear-gradient(135deg,#059669,#10b981);">✅</div>
          <div>
            <h2 class="text-lg font-black text-slate-800">確認完成</h2>
            <p class="text-xs text-slate-400">{{ activeTransfer?.name }} · {{ activeTransfer?.dest_warehouse }}</p>
          </div>
        </div>
      </div>
      <div class="px-5 py-5 flex flex-col flex-1 min-h-0 overflow-hidden">
        <p class="text-sm text-slate-700 mb-4 flex-shrink-0">
          <template v-if="isLocalDraft">確認一鍵截單並完成出庫？系統將自動截單、建立 picking 並立即完成。</template>
          <template v-else>確認完成此 Transfer？系統將驗證出庫單據（stock.picking）。</template>
        </p>
        <div class="rounded-xl bg-slate-50 border border-slate-200 divide-y divide-slate-100 overflow-y-auto flex-1 min-h-0">
          <div
            v-for="g in curGroups"
            :key="g.id"
            class="px-4 py-2.5 flex items-center justify-between"
          >
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-700 truncate">{{ g.displayName }}</div>
              <div class="text-[11px] text-slate-400 break-words">{{ pureName(g) }}</div>
            </div>
            <div class="text-sm font-black text-slate-700 shrink-0 ml-3">
              {{ (g.items || []).reduce((a,i) => a + (parseInt(i.pickQty) || parseInt(i.reqQty) || 0), 0) }}
            </div>
          </div>
        </div>
        <div class="mt-4 rounded-xl px-4 py-3 flex gap-2 flex-shrink-0" style="background:#eff6ff;border:1px solid #bfdbfe;">
          <span class="shrink-0 mt-0.5" style="color:#2563eb;">ℹ</span>
          <div class="text-xs font-semibold leading-relaxed" style="color:#1d4ed8;">
            <template v-if="isLocalDraft">此操作直接截單並完成出庫（一步到位），不會產生「第二轉」。需先完成收貨入庫。</template>
            <template v-else>需先完成收貨入庫才能完成 Transfer。完成後將無法修改。</template>
          </div>
        </div>
      </div>
      <div class="flex-shrink-0 px-5 py-4 border-t border-gray-100 flex gap-3">
        <button
          class="flex-1 py-3.5 bg-transparent rounded-2xl font-bold text-[15px] cursor-pointer"
          style="border:2px solid #e2e8f0;color:#64748b;"
          :disabled="completing"
          @click="showCompleteModal = false"
        >取消</button>
        <button
          class="flex-1 py-3.5 text-white border-0 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
          style="background:linear-gradient(90deg,#059669,#10b981);box-shadow:0 8px 24px rgba(5,150,105,.2);"
          :disabled="completing"
          @click="doComplete"
        >{{ completing ? '處理中…' : '✅ 確認完成' }}</button>
      </div>
    </div>
  </div>

  <!-- 冲突 modal -->
  <div v-if="conflictModal.open" class="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 p-4">
    <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
      <div class="px-5 py-4 border-b border-gray-200 flex items-center gap-2">
        <span class="text-2xl">⚠️</span>
        <div>
          <h2 class="text-base font-bold text-slate-800">資料衝突</h2>
          <p class="text-xs text-slate-500 mt-0.5">{{ conflictModal.modified_by }} · {{ conflictModal.modified_at }} 修改了此 TR</p>
        </div>
      </div>
      <div class="px-5 py-4 text-sm text-slate-700">
        伺服器版本比你的版本新。請選擇：
        <ul class="mt-2 space-y-1 text-xs text-slate-500">
          <li>· <strong>接受伺服器</strong>：放棄你的修改，加載最新</li>
          <li>· <strong>覆蓋我的</strong>：用你的版本覆蓋伺服器最新</li>
        </ul>
      </div>
      <div class="px-5 py-3 border-t border-gray-200 flex gap-2 justify-end">
        <button class="px-4 py-2 text-xs font-semibold text-slate-500 border border-slate-300 rounded hover:bg-slate-50" @click="cancelConflict">取消</button>
        <button class="px-4 py-2 text-xs font-semibold text-emerald-700 border border-emerald-300 rounded hover:bg-emerald-50" @click="acceptServer">接受伺服器</button>
        <button class="px-4 py-2 text-xs font-semibold text-blue-700 border border-blue-300 rounded hover:bg-blue-50" @click="keepMine">覆蓋我的</button>
      </div>
    </div>
  </div>

  <!-- 扫码相机占位 -->
  <BarcodeScanner v-if="scannerOpen" @detected="onScanDetected" @close="closeScanner" />

  <!-- 收貨確認 Modal -->
  <div v-if="showReceiveModal" class="fixed inset-0 z-[200] flex items-center justify-center" @click.self="showReceiveModal = false">
    <div class="absolute inset-0" style="background:rgba(0,0,0,.6);backdrop-filter:blur(16px);" @click="showReceiveModal = false"></div>
    <div class="relative w-full max-w-md mx-4 bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] sm:max-h-[85vh]">
      <div class="px-5 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg" style="background:linear-gradient(135deg,#059669,#10b981);">📦</div>
          <div>
            <h2 class="text-lg font-black text-slate-800">確認收貨</h2>
            <p class="text-xs text-slate-400">PO: {{ curPO }}</p>
          </div>
        </div>
      </div>
      <div class="px-5 py-5 flex-1 min-h-0 overflow-y-auto">
        <p class="text-sm text-slate-700 mb-3">將基於點貨數據驗收入庫（WH/IN → WH/Stock）：</p>
        <ul class="text-xs text-slate-500 space-y-1.5 list-none p-0">
          <li>• <strong>齊數</strong>：直接收全部</li>
          <li>• <strong>多收</strong>：只收 PO 數量，多出的自動加新 PO line（cost=0）</li>
          <li>• <strong>少收</strong>：只收實際數量，差額自動產生 Backorder</li>
          <li>• <strong>未點貨</strong>：不收，留待 Backorder</li>
        </ul>
      </div>
      <div class="px-5 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
        <button
          class="flex-1 py-3 bg-transparent rounded-2xl font-bold text-sm cursor-pointer"
          style="border:2px solid #e2e8f0;color:#64748b;"
          @click="showReceiveModal = false"
        >取消</button>
        <button
          class="flex-1 py-3 text-white border-0 rounded-2xl font-bold text-sm cursor-pointer disabled:opacity-50"
          style="background:linear-gradient(90deg,#059669,#10b981);box-shadow:0 8px 24px rgba(5,150,105,.2);"
          :disabled="receiving"
          @click="doReceive"
        >{{ receiving ? '處理中…' : '📦 確認收貨' }}</button>
      </div>
    </div>
  </div>

  <!-- 收貨結果 Modal -->
  <div v-if="receiveResult" class="fixed inset-0 z-[200] flex items-center justify-center" @click.self="receiveResult = null">
    <div class="absolute inset-0" style="background:rgba(0,0,0,.6);backdrop-filter:blur(16px);" @click="receiveResult = null"></div>
    <div class="relative w-full max-w-lg mx-4 bg-white rounded-3xl shadow-2xl max-h-[90vh] overflow-hidden">
      <div class="px-5 pt-5 pb-4 border-b border-gray-100">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg" style="background:linear-gradient(135deg,#059669,#10b981);">✅</div>
            <div>
              <h2 class="text-lg font-black text-slate-800">收貨完成</h2>
              <p class="text-xs text-slate-400">{{ receiveResult.picking_name }}</p>
            </div>
          </div>
          <button class="p-2 bg-transparent border-0 text-slate-400 text-xl cursor-pointer" @click="receiveResult = null">✕</button>
        </div>
      </div>
      <div class="px-5 py-4 overflow-y-auto" style="max-height:60vh;">
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div class="bg-emerald-50 rounded-xl p-3 text-center">
            <div class="text-2xl font-black text-emerald-700">{{ receiveResult.summary?.total_received || 0 }}</div>
            <div class="text-xs text-emerald-600 mt-0.5">已收數量</div>
          </div>
          <div class="bg-slate-50 rounded-xl p-3 text-center">
            <div class="text-2xl font-black text-slate-700">{{ receiveResult.summary?.total_expected || 0 }}</div>
            <div class="text-xs text-slate-500 mt-0.5">預期數量</div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2 mb-4">
          <span v-if="receiveResult.summary?.matched" class="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">✓ 齊數 {{ receiveResult.summary.matched }}</span>
          <span v-if="receiveResult.summary?.over" class="px-3 py-1 rounded-full text-xs font-bold bg-orange-100 text-orange-700">⊕ 多收 {{ receiveResult.summary.over }}</span>
          <span v-if="receiveResult.summary?.under" class="px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700">⊖ 少收 {{ receiveResult.summary.under }}</span>
          <span v-if="receiveResult.summary?.not_counted" class="px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-500">○ 未點 {{ receiveResult.summary.not_counted }}</span>
        </div>
        <div v-if="receiveResult.backorder_name" class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-center gap-2">
          <span class="text-amber-600">📋</span>
          <div>
            <div class="text-sm font-bold text-amber-800">已產生 Backorder</div>
            <div class="text-xs text-amber-600">{{ receiveResult.backorder_name }} — 差額待後續收貨</div>
          </div>
        </div>
        <div v-if="receiveResult.extra_lines?.length" class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4">
          <div class="text-sm font-bold text-blue-800 mb-2">📝 多收品項（已加新 PO Line, cost=0）</div>
          <div v-for="el in receiveResult.extra_lines" :key="el.po_line_id" class="text-xs text-blue-700 py-0.5">
            {{ el.sku }} — {{ el.name }} × {{ el.extra_qty }}
          </div>
        </div>
        <div class="divide-y divide-gray-100">
          <div
            v-for="line in receiveResult.lines"
            :key="line.po_line_id"
            class="py-2.5 flex items-center gap-3"
          >
            <span
              class="shrink-0 w-2 h-2 rounded-full"
              :class="{
                'bg-emerald-400': line.scenario === 'matched',
                'bg-orange-400': line.scenario === 'over',
                'bg-red-400': line.scenario === 'under',
                'bg-slate-300': line.scenario === 'not_counted',
              }"
            ></span>
            <div class="flex-1 min-w-0">
              <span class="text-sm font-semibold text-slate-700">{{ line.sku }}</span>
              <span class="text-xs text-slate-400 ml-2">{{ line.name }}</span>
            </div>
            <div class="text-right text-xs">
              <div class="font-bold" :class="{
                'text-emerald-600': line.scenario === 'matched',
                'text-orange-600': line.scenario === 'over',
                'text-red-600': line.scenario === 'under',
                'text-slate-400': line.scenario === 'not_counted',
              }">
                {{ line.received }} / {{ line.expected }}
              </div>
              <div class="text-[11px] text-slate-400">
                {{ line.scenario === 'matched' ? '✓ 齊數' : line.scenario === 'over' ? '⊕ 多收' : line.scenario === 'under' ? '⊖ 少收' : '未點貨' }}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="px-5 py-4 border-t border-gray-100">
        <button
          class="w-full py-3 text-white border-0 rounded-2xl font-bold text-sm cursor-pointer"
          style="background:linear-gradient(90deg,#4f46e5,#7c3aed);"
          @click="receiveResult = null"
        >確認</button>
      </div>
    </div>
  </div>
</template>

