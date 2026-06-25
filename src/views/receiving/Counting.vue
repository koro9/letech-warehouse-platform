<script setup>
/**
 * PO 點貨 (M3a) — 接 Odoo PO 真后端
 *
 * 业务流：
 *   M3b 收貨分配 已录"按仓应收数" → M3a 员工照应收数对照清点实收
 *   ↓
 *   GET counting → 拿到 PO + items + 应收 allocs (来自 M3b 的 le_allocation_data)
 *                  + 已录的 counting (员工之前录到一半的)
 *   ↓
 *   员工按 alloc × 仓 × 效期 录入实收数 / 处理 Remarks
 *   ↓
 *   POST counting → 行级乐观锁，冲突 modal 同 M3b
 *
 * 三态 UI 保留 demo 设计：
 *   1. 没有 curPO     → PO 输入页（标题已改 "PO 點貨平台"）
 *   2. 有 curPO 没 curSKU → SKU 列表页（带条码扫描入口）
 *   3. 有 curSKU      → SKU 详情页（每仓库 × 每效期 数量录入 + Remarks 处理）
 *
 * 仓库列表（WH）改为动态 — 每个 alloc 自带 warehouses 字典，里面 keys 决定
 * 该 alloc 显示哪几个仓的录入框（main alloc 通常含 3PL/WS/SD4/额外列；
 * combo alloc 只含 3PL）。不再写死全局 WH 常量。
 */
import { computed, nextTick, reactive, ref, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { onBeforeRouteLeave } from 'vue-router'
import { po as poApi } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import RefreshButton from '@/components/RefreshButton.vue'
// 按需異步加載:zxing 解碼庫(~113KB gzip)只在真正打開相機時才下載
const BarcodeScanner = defineAsyncComponent(() => import('@/components/BarcodeScanner.vue'))

// 仓库色板 — 已知仓位用预定义色，新仓位（额外列名）fallback 灰色
const WH_COLOR = { '3PL': '#4A90D9', 'WS': '#E6A23C', 'SD4': '#67C23A' }
function whColor(w) { return WH_COLOR[w] || '#6b7280' }

// ============================================================
// 状态
// ============================================================
const loading = ref(false)
const saving = ref(false)
const poInput = ref('')
const curPO = ref(null)         // { po, items[] } 来自 API
const curSKU = ref(null)         // 当前打开的 SKU 字符串

// 每 SKU 的录入状态：{ dates: [], a: { [allocId]: { [wh]: { [dateKey]: qty } } } }
const pk = reactive({})
// 每 SKU 的 remarks 处理状态：{ handled, by, time }
const remarksStatus = reactive({})
// 每 SKU 的服务端 last_modified_at（用于乐观锁）+ last_modified_by
const lineMeta = reactive({})    // { [sku]: { po_line_id, last_modified_at, last_modified_by } }
// dirty tracking — 哪些 SKU 改过了
const dirtySkus = reactive(new Set())

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

// 冲突 modal（跟 M3b 同款）
const conflictModal = reactive({
  open: false,
  conflicts: [],
  resolutions: {},
})

// ============================================================
// 工具：仓库 keys 来自 alloc.warehouses（动态）
// ============================================================
function whKeysOf(alloc) {
  if (!alloc || !alloc.warehouses) return []
  return Object.keys(alloc.warehouses)
}

function whSum(alloc) {
  if (!alloc || !alloc.warehouses) return 0
  return Object.values(alloc.warehouses).reduce((s, v) => s + (parseInt(v) || 0), 0)
}

function whQty(sku, allocId, wh) {
  const e = pk[sku]?.a?.[allocId]?.[wh]
  if (!e) return 0
  return Object.values(e).reduce((s, v) => s + (parseInt(v) || 0), 0)
}

function whPk(sku, allocId, alloc) {
  return whKeysOf(alloc).reduce((s, w) => s + whQty(sku, allocId, w), 0)
}

function itemUnits(it) {
  return it.allocs.reduce(
    (s, a) => s + whSum(a) * (a.type === 'combo' ? (a.mult || 1) : 1), 0,
  )
}

function itemPkU(it) {
  return it.allocs.reduce(
    (s, a) => s + whPk(it.sku, a.id, a) * (a.type === 'combo' ? (a.mult || 1) : 1), 0,
  )
}

function fmtDate(d) { return `${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}` }

function fmtTime(d) {
  const h = d.getHours(), m = d.getMinutes()
  return `${h<10?'0':''}${h}:${m<10?'0':''}${m}`
}

function statusOfItem(it) {
  const tu = itemUnits(it), pu = itemPkU(it)
  if (pu === 0) return { label: '待點貨', cls: 'text-amber-600 bg-amber-50' }
  if (pu >= tu) {
    // 點完了 — 但數量是否吻合？
    if (pu !== tu) return { label: '需核實', cls: 'text-red-600 bg-red-50' }
    return { label: '已完成', cls: 'text-green-600 bg-green-50' }
  }
  return { label: '進行中', cls: 'text-amber-600 bg-amber-50' }
}

// ============================================================
// 计算
// ============================================================
const curItem = computed(() =>
  curPO.value && curSKU.value ? curPO.value.items.find(i => i.sku === curSKU.value) : null,
)

// 标签类型徽章 — 让点货员一眼知道要贴啥标签
// 规则：ordinary_label 不显示（普通的不需要特别提醒）；其他 4 类显示；
//      has_jelly_warning 单独显示一个紫色「果凍警告」徽章
const _LABEL_TYPE_BADGES = {
  food_label:         { label: '食品',     style: 'background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;' },
  health_food:        { label: '保健食品', style: 'background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;' },
  special_label:      { label: '蟲蟲特殊', style: 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;' },
  extinguisher_label: { label: '滅火筒',   style: 'background:#fff1f2;color:#be123c;border:1px solid #fecdd3;' },
  // ordinary_label  故意不放 — 普通的不标
}
const labelTypeBadges = computed(() => {
  const it = curItem.value
  if (!it) return []
  const badges = []
  const t = it.label_render_type
  if (t && _LABEL_TYPE_BADGES[t]) badges.push(_LABEL_TYPE_BADGES[t])
  if (it.has_jelly_warning) {
    badges.push({ label: '果凍警告', style: 'background:#f5f3ff;color:#7c3aed;border:1px solid #ddd6fe;' })
  }
  return badges
})
const curPk = computed(() => curSKU.value ? pk[curSKU.value] : null)
const hasDates = computed(() => (curPk.value?.dates.length || 0) > 0)

// FEFO 商品标记 — 来自后端 item.is_fefo（产品类别 Goods(FEFO)），
// 这类商品必须填到期日才能正确 FEFO 出库
const isFefoItem = computed(() => !!curItem.value?.is_fefo)

// FEFO 强制校验 — 在 save / 返回 动作开头调用
// 规则：当前打开的 SKU 若是 FEFO 商品，且已录了数量（总量 > 0）但没填到期日，
//      → 阻止动作并提示。没录数量 / 没打开 SKU / 已填到期日 → 放行。
// 返回 true = 通过（可继续）；false = 拦截（调用方应 return）
function fefoGateOk() {
  const it = curItem.value
  const d = curPk.value
  if (!it || !d || !it.is_fefo) return true
  // 已填到期日 → 直接放行
  if ((d.dates?.length || 0) > 0) return true
  // dates 为空：累加 a 里所有数量，判断有没有录入量
  let total = 0
  const a = d.a || {}
  for (const allocId in a) {
    const whs = a[allocId] || {}
    for (const w in whs) {
      const entries = whs[w] || {}
      for (const k in entries) total += parseInt(entries[k]) || 0
    }
  }
  if (total > 0) {
    showToast('FEFO 商品必須先填到期日才能保存/返回', 'warning')
    return false
  }
  return true
}

const detailStats = computed(() => {
  const it = curItem.value
  if (!it) return null
  const tu = itemUnits(it)
  const perBox = parseInt(it.perBox) || 0
  return {
    tu,
    tb: perBox > 0 ? Math.floor(tu / perBox) : 0,
    br: perBox > 0 ? tu % perBox : tu,
  }
})

// ============================================================
// 加载 PO
// ============================================================
async function loadPO(opts = {}) {
  // silent: 自动刷新轮询用 — 不闪 loading、不弹失败 toast(避免每 10s 打扰)
  const silent = opts && opts.silent === true
  const v = poInput.value.trim()
  if (!v) { if (!silent) showToast('請輸入 PO 單號', 'warning'); return }
  if (!silent) loading.value = true
  try {
    const res = await poApi.getCounting(v)
    // 重置本地状态
    Object.keys(pk).forEach(k => delete pk[k])
    Object.keys(remarksStatus).forEach(k => delete remarksStatus[k])
    Object.keys(showDI).forEach(k => delete showDI[k])
    Object.keys(comboExpanded).forEach(k => delete comboExpanded[k])
    Object.keys(lineMeta).forEach(k => delete lineMeta[k])
    dirtySkus.clear()

    // 填充 curPO
    curPO.value = {
      po: res.po_name,
      partner_name: res.partner_name,
      state: res.state,
      items: res.items || [],
    }

    // 初始化每 SKU 的 pk / remarksStatus / lineMeta
    res.items.forEach(it => {
      // pk: 从后端 counting 拿，或者用空默认
      const counting = it.counting || { dates: [], a: {} }
      pk[it.sku] = {
        dates: Array.isArray(counting.dates) ? counting.dates.slice() : [],
        a: {},
      }
      // 为每个 alloc × 仓 × 效期 准备 entries
      it.allocs.forEach(al => {
        pk[it.sku].a[al.id] = {}
        whKeysOf(al).forEach(w => {
          // 应收 > 0 才显示输入；应收 0 的（如 main alloc 在 M3b 没分这仓）跳过
          if ((al.warehouses[w] || 0) > 0) {
            // 如果后端有现成数据 → 用后端的；否则按 dates 状态初始化空 entries
            const fromBe = counting.a?.[al.id]?.[w]
            if (fromBe && typeof fromBe === 'object') {
              pk[it.sku].a[al.id][w] = { ...fromBe }
            } else {
              if (pk[it.sku].dates.length === 0) {
                pk[it.sku].a[al.id][w] = { '': 0 }
              } else {
                const init = {}
                pk[it.sku].dates.forEach(dt => { init[dt] = 0 })
                pk[it.sku].a[al.id][w] = init
              }
            }
          }
        })
      })

      // Remarks 处理状态
      remarksStatus[it.sku] = it.remarks_handled || { handled: false, by: '', time: '' }

      // 行 meta（乐观锁用）
      lineMeta[it.sku] = {
        po_line_id:       it.po_line_id,
        last_modified_at: it.last_modified_at,
        last_modified_by: it.last_modified_by,
      }
    })
  } catch (err) {
    if (err.handledByInterceptor) return
    if (silent) return   // 静默轮询失败不打扰用户
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 404) {
      showToast(`❌ 找不到 PO「${v}」`, 'error')
    } else if (status === 422) {
      showToast(`⚠️ ${data.detail || `此 PO 狀態（${data.state}）不允許進入點貨`}`, 'warning')
    } else if (status === 403) {
      showToast(`⚠️ ${data.detail || '此功能僅限內部員工'}`, 'error')
    } else {
      showToast(data.error || '載入失敗', 'error')
    }
  } finally {
    if (!silent) loading.value = false
  }
}

function backToPO() {
  if (!fefoGateOk()) return   // FEFO 商品录了量没填到期日 → 拦截
  if (dirtySkus.size > 0
      && !confirm(`有 ${dirtySkus.size} 項未儲存的修改，確定離開？`)) {
    return
  }
  curPO.value = null
  curSKU.value = null
}

function backToList() {
  if (!fefoGateOk()) return   // FEFO 商品录了量没填到期日 → 拦截
  curSKU.value = null
}

async function refreshData() {
  if (!curPO.value) return
  if (dirtySkus.size > 0
      && !confirm(`有 ${dirtySkus.size} 項未儲存的修改，刷新會丟失。確定？`)) {
    return
  }
  poInput.value = curPO.value.po
  await loadPO()
  showToast('✅ 已刷新', 'success')
}
const { refreshNow } = usePageRefresh(refreshData)

// ============================================================
// 自動刷新開關（WMS 通用滑動開關，SKU 列表頁每 10s 拉最新進度）
// 安全：只在「SKU 列表頁 + 無未存改動」時靜默刷新，不闪 loading、不冲掉輸入；
//       在詳情頁或有 dirty 時自動跳過該輪。
// ============================================================
const autoRefresh = ref(true)
let _pollTimer = null
const COUNTING_POLL_MS = 10000

async function _pollCounting() {
  if (!autoRefresh.value) return
  if (!curPO.value || curSKU.value) return   // 只在 SKU 列表頁輪詢
  if (dirtySkus.size > 0) return              // 有未存改動 → 跳過，避免冲掉
  await loadPO({ silent: true })
}
function startCountingPoll() {
  if (_pollTimer) return
  _pollTimer = setInterval(_pollCounting, COUNTING_POLL_MS)
}
function stopCountingPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
}
watch(autoRefresh, (v) => {
  if (v) { startCountingPoll(); _pollCounting() }   // 打開即刻刷一次,不用等 10s
  else stopCountingPoll()
})

function openSKU(sku) {
  curSKU.value = sku
  if (typeof showDI[sku] === 'undefined') showDI[sku] = false
}

// ============================================================
// 扫码
// ============================================================
function scanBC() {
  const v = bcInput.value.trim()
  if (!v || !curPO.value) return
  const items = curPO.value.items || []
  // 1) 精確:barcode 或 sku 完全相等(扫码枪扫整条 / 输入完整 SKU)
  let hits = items.filter(it => it.barcode === v || it.sku === v)
  // 2) 退回「關鍵字部分匹配」:输入 78900 命中 12345678900;≥3 字才模糊,避免命中一堆
  if (!hits.length && v.length >= 3) {
    hits = items.filter(it =>
      (it.barcode || '').includes(v) || (it.sku || '').includes(v))
  }
  if (hits.length === 1) {
    const f = hits[0]
    bcInput.value = ''
    showToast(`✅ ${f.name}`, 'success')
    setTimeout(() => { curSKU.value = f.sku }, 350)
  } else if (hits.length > 1) {
    showToast(`找到 ${hits.length} 個匹配,請輸入更完整的條碼`, 'warning')
  } else {
    showToast('❌ 找不到', 'error')
  }
}

function openScanner()  { scannerOpen.value = true }
function closeScanner() { scannerOpen.value = false }
// 相機掃到條碼 → 填入查詢框並查詢
function onScanDetected(code) {
  bcInput.value = code
  closeScanner()
  scanBC()
}

// ============================================================
// Dirty tracking
// ============================================================
function markDirty(sku) {
  if (sku) dirtySkus.add(sku)
}

function onPkInput(sku) {
  markDirty(sku)
}

// ============================================================
// 日期
// ============================================================
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
    whKeysOf(al).forEach(w => {
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
  markDirty(sku)
  showToast(`✅ 已新增 ${fmtDate(v)}`, 'success')
}

function removeDate(idx) {
  const sku = curSKU.value
  const d = pk[sku]
  const removed = d.dates.splice(idx, 1)[0]
  curItem.value.allocs.forEach(al => {
    whKeysOf(al).forEach(w => {
      const entries = d.a[al.id]?.[w]
      if (!entries) return
      const removedQty = entries[removed] || 0
      delete entries[removed]
      if (d.dates.length === 0) entries[''] = removedQty
    })
  })
  markDirty(sku)
}

// ============================================================
// Combo 横幅
// ============================================================
function toggleCombo(allocId) {
  comboExpanded[allocId] = !comboExpanded[allocId]
}

// ============================================================
// Remarks 弹窗
// ============================================================
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
  markDirty(curSKU.value)
  rkOpen.value = false
  showToast('✅ 已標記', 'success')
}
function undoRemark() {
  remarksStatus[curSKU.value] = { handled: false, by: '', time: '' }
  markDirty(curSKU.value)
  showToast('↩️ 已撤銷', 'success')
}

// ============================================================
// 保存（行级乐观锁 + 冲突 modal）
// ============================================================
function buildPayloadRow(sku) {
  const meta = lineMeta[sku]
  const data = pk[sku]
  return {
    po_line_id:        meta.po_line_id,
    counting:          { dates: data.dates.slice(), a: data.a },
    remarks_handled:   remarksStatus[sku] || { handled: false, by: '', time: '' },
    _last_modified_at: meta.last_modified_at,
  }
}

async function saveAll() {
  if (saving.value) return
  if (!fefoGateOk()) return   // FEFO 商品录了量没填到期日 → 拦截，不保存
  if (dirtySkus.size === 0) {
    showToast('沒有需要儲存的修改', 'warning')
    return
  }
  saving.value = true
  let ok = false
  try {
    const dirtyRows = [...dirtySkus].map(buildPayloadRow)
    const res = await poApi.saveCounting(curPO.value.po, { rows: dirtyRows })
    if (res.ok) {
      const newTs = res.server_time
      ;(res.saved || []).forEach(id => {
        // 找到对应的 sku
        const sku = Object.keys(lineMeta).find(s => lineMeta[s].po_line_id === id)
        if (sku) {
          dirtySkus.delete(sku)
          if (newTs) lineMeta[sku].last_modified_at = newTs
        }
      })
      showToast(`✅ 已儲存 ${(res.saved || []).length} 項`, 'success')
      ok = true
    } else {
      showToast('儲存回應異常,可能其他用戶已修改。請刷新畫面', 'error')
    }
  } catch (err) {
    if (err.handledByInterceptor) {
      saving.value = false
      return
    }
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 207) {
      // 部分冲突
      ;(data.saved || []).forEach(id => {
        const sku = Object.keys(lineMeta).find(s => lineMeta[s].po_line_id === id)
        if (sku) {
          dirtySkus.delete(sku)
          if (data.server_time) lineMeta[sku].last_modified_at = data.server_time
        }
      })
      conflictModal.conflicts = data.conflicts || []
      conflictModal.resolutions = {}
      data.conflicts.forEach(c => {
        conflictModal.resolutions[c.po_line_id] = 'keep'
      })
      conflictModal.open = true
      showToast(
        `⚠️ ${data.conflicts.length} 項衝突，已保存 ${(data.saved || []).length} 項`,
        'warning',
      )
    } else if (status === 403) {
      showToast(data.detail || '無權限儲存', 'error')
    } else if (status === 404) {
      showToast('PO 不存在', 'error')
    } else if (status === 422) {
      showToast(data.detail || '此 PO 狀態不允許儲存', 'warning')
    } else {
      showToast(data.error || '儲存失敗', 'error')
    }
  } finally {
    saving.value = false
  }
  return ok
}

// 詳情頁保存:存成功(無衝突/無錯誤)後直接返回 SKU 列表
async function saveAndBack() {
  if (!fefoGateOk()) return   // FEFO 商品录了量没填到期日 → 拦截（早返回，单次提示）
  const ok = await saveAll()
  if (ok) backToList()
}

// ============================================================
// 冲突解决
// ============================================================
function pickResolution(poLineId, choice) {
  conflictModal.resolutions[poLineId] = choice
}

async function applyResolutions() {
  if (saving.value) return
  const acceptIds = []
  const keepRows = []
  for (const c of conflictModal.conflicts) {
    const choice = conflictModal.resolutions[c.po_line_id]
    const sku = Object.keys(lineMeta).find(s => lineMeta[s].po_line_id === c.po_line_id)
    if (!sku) continue

    if (choice === 'accept') {
      // 接受服务器版本 — 把 server_data 还原到 pk[sku]
      const srv = c.server_data || {}
      pk[sku] = {
        dates: Array.isArray(srv.dates) ? srv.dates.slice() : [],
        a: srv.a || {},
      }
      // 如果 server_data 含 remarks_handled 也接受
      if (srv.remarks_handled) remarksStatus[sku] = srv.remarks_handled
      lineMeta[sku].last_modified_at = c.modified_at
      dirtySkus.delete(sku)
      acceptIds.push(c.po_line_id)
    } else {
      // 保留我的 — 更新 last_modified_at 准备重提
      lineMeta[sku].last_modified_at = c.modified_at
      keepRows.push(buildPayloadRow(sku))
    }
  }

  conflictModal.open = false
  conflictModal.conflicts = []
  conflictModal.resolutions = {}

  if (keepRows.length === 0) {
    if (acceptIds.length) showToast(`已採用 ${acceptIds.length} 項的伺服器版本`, 'success')
    return
  }

  saving.value = true
  try {
    const res = await poApi.saveCounting(curPO.value.po, { rows: keepRows })
    if (res.ok) {
      const newTs = res.server_time
      ;(res.saved || []).forEach(id => {
        const sku = Object.keys(lineMeta).find(s => lineMeta[s].po_line_id === id)
        if (sku) {
          dirtySkus.delete(sku)
          if (newTs) lineMeta[sku].last_modified_at = newTs
        }
      })
      showToast(`✅ 已覆蓋儲存 ${(res.saved || []).length} 項`, 'success')
    }
  } catch (err) {
    if (err.handledByInterceptor) return
    if (err.response?.status === 207) {
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
// 单元格状态
// ============================================================
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
  const aP = whPk(it.sku, alloc.id, alloc)
  const aR = aT - aP
  let cls = 'text-amber-600'
  if (aR === 0) cls = 'text-green-600'
  else if (aR < 0) cls = 'text-red-600'
  return { remaining: aR, cls }
}

// ============================================================
// 路由 / 浏览器离开守卫
// ============================================================
function hasDirty() { return curPO.value && dirtySkus.size > 0 }

onBeforeRouteLeave((to, from, next) => {
  if (hasDirty() && !confirm(`有 ${dirtySkus.size} 項未儲存的修改，離開將丟失。確定？`)) {
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

onMounted(() => {
  window.addEventListener('beforeunload', _onBeforeUnload)
  if (autoRefresh.value) startCountingPoll()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', _onBeforeUnload)
  stopCountingPoll()
})
// KeepAlive 缓存切走时停、切回时按开关恢复
onActivated(() => { if (autoRefresh.value) startCountingPoll() })
onDeactivated(stopCountingPoll)

// ============================================================
// 深链接支持 — Odoo PO form 「WMS 點貨」smart button 跳过来时
// URL 形如 /warehouse/receiving?po=P00007，自动加载该 PO
// ============================================================
// onActivated 在 KeepAlive 缓存下也会触发；onMounted 兜底首次访问。
// 用完后从 URL 清掉 query 避免刷新页面又重复触发。
const _route = useRoute()
const _router = useRouter()

async function _autoLoadFromQuery() {
  const poName = (_route.query?.po || '').toString().trim()
  if (!poName) return
  if (curPO.value && curPO.value.po === poName) return  // 已经在了
  poInput.value = poName
  // 清 query — 避免用户在页内刷新又触发一次
  _router.replace({ name: _route.name, query: {} })
  await loadPO()
}

onMounted(_autoLoadFromQuery)
onActivated(_autoLoadFromQuery)
</script>

<template>
  <!-- ===== 状态 1：PO 输入 ===== -->
  <div v-if="!curPO" class="m3a flex flex-col justify-center items-center h-full p-6 sm:p-10">
    <div class="text-4xl sm:text-5xl mb-3">📦</div>
    <h2 class="text-lg sm:text-xl font-extrabold mb-2">PO 點貨平台</h2>
    <div class="text-xs text-gray-400 mb-5 sm:mb-6">輸入 Odoo PO 單號開始點貨</div>
    <div class="w-full max-w-sm">
      <input
        v-model="poInput"
        @keydown.enter="loadPO"
        class="g-input w-full mb-3 text-center font-bold"
        style="font-size:18px;"
        placeholder="PO Number"
        autocomplete="off"
        :disabled="loading"
      />
      <button class="g-btn g-btn-teal w-full" style="padding:14px;"
              :disabled="loading" @click="loadPO">
        {{ loading ? '載入中…' : '載入 PO' }}
      </button>
    </div>
  </div>

  <!-- ===== 状态 2：SKU 清单 ===== -->
  <div v-else-if="!curSKU" class="m3a p-4 sm:p-5 overflow-y-auto h-full max-w-2xl mx-auto">
    <div class="hdr">
      <button class="hdr-back" @click="backToPO">‹</button>
      <h1>SKU 清單</h1>
      <!-- 自動刷新開關（WMS 同款滑動開關 + 脉冲點，每 10s）-->
      <div class="g-toggle-wrap" style="gap:6px;">
        <span class="flex items-center gap-1 text-[11px] text-gray-500 select-none whitespace-nowrap">
          <span class="w-2 h-2 rounded-full transition-colors"
                :class="autoRefresh ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'"></span>
          {{ autoRefresh ? '每 10s' : '已暫停' }}
        </span>
        <button class="g-toggle" :class="{ on: autoRefresh }"
                :aria-label="autoRefresh ? '關閉自動刷新' : '開啟自動刷新'"
                :title="autoRefresh ? '自動刷新已開啟（每 10 秒）；點擊暫停' : '自動刷新已暫停；點擊開啟'"
                @click="autoRefresh = !autoRefresh"></button>
      </div>
      <!-- 顶部 saveAll 按钮 — dirty > 0 才高亮 -->
      <button
        v-if="dirtySkus.size > 0"
        class="g-btn g-btn-teal"
        style="padding:7px 14px;font-size:12px;margin-left:6px;"
        :disabled="saving"
        @click="saveAll"
      >
        {{ saving ? '⏳' : `💾 儲存(${dirtySkus.size})` }}
      </button>
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
      :class="dirtySkus.has(it.sku) ? 'sku-item-dirty' : ''"
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
          <span
            v-if="dirtySkus.has(it.sku)"
            class="inline-block text-[10px] font-extrabold px-2 py-0.5 rounded-xl ml-1"
            style="background:#fef3c7;color:#92400e;"
          >● 未儲存</span>
        </div>
        <div class="text-xs text-gray-400 mt-0.5 flex gap-1.5 flex-wrap">
          <span class="bg-gray-100 px-1.5 py-px rounded">SKU: {{ it.sku }}</span>
          <span class="bg-gray-100 px-1.5 py-px rounded">箱入: {{ it.perBox || '—' }}</span>
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
  <div v-else class="m3a p-4 sm:p-5 overflow-y-auto h-full relative max-w-2xl mx-auto">
    <div class="hdr">
      <button class="hdr-back" @click="backToList">‹</button>
      <h1>{{ curItem.name }}</h1>
      <RefreshButton :on-refresh="refreshNow" />
    </div>
    <div class="flex items-center gap-2 mb-2.5 flex-wrap">
      <span class="font-mono text-xs font-bold">條碼: {{ curItem.barcode }}</span>
      <!-- FEFO 徽章 — item.is_fefo（产品类别 Goods(FEFO)）：提醒必须填到期日 -->
      <span v-if="isFefoItem"
            class="inline-block px-2 py-0.5 rounded text-[11px] font-bold whitespace-nowrap"
            style="background:#fff7ed;color:#c2410c;border:1px solid #fdba74;"
            title="FEFO 商品：必須填到期日才能保存/返回">
        ⏳ FEFO
      </span>
      <!-- 标签类型徽章 — 食品 / 保健 / 蟲蟲 / 滅火筒 + (果凍警告) -->
      <!-- 普通(ordinary_label) 故意不显示，跟用户约定 -->
      <span v-for="(b, i) in labelTypeBadges" :key="i"
            class="inline-block px-2 py-0.5 rounded text-[11px] font-bold whitespace-nowrap"
            :style="b.style">
        {{ b.label }}
      </span>
    </div>

    <!-- 摘要卡 -->
    <div class="sum-row">
      <div class="sum-card">
        <div class="text-[10px] text-gray-400">SKU</div>
        <div class="text-sm font-extrabold mt-0.5" style="color:#4A90D9;">{{ curItem.sku }}</div>
      </div>
      <div class="sum-card">
        <div class="text-[10px] text-gray-400">箱入</div>
        <div class="text-xl font-extrabold" style="color:#E6A23C;">{{ curItem.perBox || '—' }}</div>
      </div>
      <div class="sum-card">
        <div class="text-[10px] text-gray-400">總件數</div>
        <div class="text-xl font-extrabold" style="color:#4CAF50;">{{ detailStats.tu }}</div>
      </div>
      <div class="sum-card">
        <div class="text-[10px] text-gray-400">總箱數</div>
        <div class="text-xl font-extrabold" style="color:#7C4DFF;">
          <template v-if="(curItem.perBox || 0) > 0">
            {{ detailStats.tb }}<span v-if="detailStats.br > 0" class="text-xs" style="color:#E6A23C;"> 餘{{ detailStats.br }}</span>
          </template>
          <template v-else>—</template>
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
      <!-- 板 — M3b 分配人员手填,点货员只读看到(显示在有效期下方) -->
      <div v-if="curItem.board" class="date-section flex items-center gap-2">
        <span class="text-xs font-bold text-gray-600">🧱 板</span>
        <span class="text-sm font-bold" style="color:#5b21b6;">{{ curItem.board }}</span>
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
        <template v-for="w in whKeysOf(al)" :key="w">
          <div v-if="(al.warehouses[w] || 0) > 0" class="wr">
            <span class="text-sm font-bold min-w-[34px]" :style="{ color: whColor(w) }">{{ w }}</span>
            <span class="text-[15px] font-bold text-gray-300 ml-auto">{{ al.warehouses[w] }}</span>
            <span class="text-gray-300 mx-1">→</span>
            <span class="wr-pk">
              <input
                type="number"
                min="0"
                :class="inputClass(curPk.a[al.id][w][''], al.warehouses[w])"
                :value="curPk.a[al.id][w][''] || ''"
                placeholder="0"
                @input="curPk.a[al.id][w][''] = parseInt($event.target.value) || 0; onPkInput(curSKU)"
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
            <template v-for="w in whKeysOf(al)" :key="w">
              <div v-if="(al.warehouses[w] || 0) > 0" class="flex items-center gap-1.5 px-4 py-1.5 border-b border-gray-50">
                <div class="w-10 shrink-0 text-sm font-bold" :style="{ color: whColor(w) }">{{ w }}</div>
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
                    @input="curPk.a[al.id][w][dt] = parseInt($event.target.value) || 0; onPkInput(curSKU)"
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

    <!-- 產品主圖（基本信息 le_main_photo，公網 URL）；手機端自適應：撑满列宽、限高、保持比例 -->
    <div v-if="curItem.main_photo" class="card" style="padding:12px;">
      <div class="text-[11px] text-gray-400 mb-2">🖼️ 產品主圖</div>
      <img
        :src="curItem.main_photo"
        :alt="curItem.name"
        class="w-full rounded-lg object-contain bg-gray-50"
        style="max-height:300px;"
        loading="lazy"
        @error="$event.target.closest('.card').style.display='none'"
      />
    </div>

    <div class="h-18"></div>

    <!-- 保存 sticky — 全 PO save（saveAll）；詳情頁存成功後返回 SKU 列表 -->
    <div class="m3a-bot safe-pb">
      <button
        class="g-btn g-btn-teal w-full"
        style="padding:14px;"
        :disabled="saving || dirtySkus.size === 0"
        @click="saveAndBack"
      >
        <template v-if="saving">⏳ 儲存中…</template>
        <template v-else-if="dirtySkus.size === 0">💾 儲存（無變更）</template>
        <template v-else>💾 儲存全部 {{ dirtySkus.size }} 項</template>
      </button>
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
    <BarcodeScanner v-if="scannerOpen" @detected="onScanDetected" @close="closeScanner" />
  </div>

  <!-- ===== 冲突 Modal — 跨整页 ===== -->
  <div v-if="conflictModal.open"
       class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
      <div class="px-5 py-4 border-b border-gray-200 flex items-center gap-2">
        <span class="text-2xl">⚠️</span>
        <div>
          <h2 class="text-base font-bold text-gray-800">資料衝突 — {{ conflictModal.conflicts.length }} 項被其他用戶更新</h2>
          <p class="text-xs text-gray-500 mt-0.5">逐項選擇：保留我的修改 / 接受伺服器最新</p>
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
</template>

<style scoped>
/* dirty 行高亮 — 灰底 + 左侧黄边 */
.sku-item-dirty {
  background: #fffbeb !important;
  border-left: 3px solid #f59e0b !important;
}
</style>
