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
import { computed, nextTick, reactive, ref, onMounted, onBeforeUnmount } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { po as poApi } from '@/api'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'

// ============================================================
// 状态
// ============================================================
const view = ref('search')           // 'search' | 'trlist' | 'trdetail' | 'item'
const loading = ref(false)
const saving = ref(false)
const cutting = ref(false)

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
const conflictModal = reactive({
  open: false,
  modified_by: '',
  modified_at: '',
  server_data: null,
})

// ============================================================
// 计算
// ============================================================
const filteredTRs = computed(() => {
  if (!trSearch.value.trim()) return trList.value
  const q = trSearch.value.toLowerCase()
  return trList.value.filter(t => (t.name || '').toLowerCase().includes(q))
})

const curGroups = computed(() => activeTransfer.value?.groups_data || [])
const curGroup = computed(() => curGroups.value[selGrp.value] || null)

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

const allTRStats = computed(() => {
  return trList.value.reduce((a, t) => {
    const s = trStats(t)
    return { rq: a.rq + s.total_req, pk: a.pk + s.total_pick, bx: a.bx + s.total_boxes }
  }, { rq: 0, pk: 0, bx: 0 })
})

const detailStats = computed(() => {
  if (!activeTransfer.value) return { rq: 0, pk: 0, bx: 0, dn: 0, total: 0 }
  const s = activeTransfer.value.stats || {}
  return {
    rq:    s.total_req   || 0,
    pk:    s.total_pick  || 0,
    bx:    s.total_boxes || 0,
    dn:    s.done_groups || 0,
    total: s.groups      || 0,
  }
})
const detailPct = computed(() =>
  detailStats.value.rq > 0 ? Math.round(detailStats.value.pk / detailStats.value.rq * 100) : 0,
)

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
    draft:       { l: '待處理', cls: 'bg-slate-100 text-slate-500' },
    in_progress: { l: '進行中', cls: 'bg-amber-100 text-amber-800' },
    done:        { l: '已完成', cls: 'bg-emerald-100 text-emerald-800' },
    cut:         { l: '已截單', cls: 'bg-orange-100 text-orange-800' },
  }
  return m[st] || m.draft
}

function isCutTr(tr) {
  return tr.state === 'cut' || !!tr.parent_transfer_id
}

// ============================================================
// 加载 PO + TR list
// ============================================================
async function searchPO() {
  const v = poInput.value.trim()
  if (!v) { showToast('請輸入 PO Number', 'error'); return }
  loading.value = true
  try {
    const res = await poApi.listTransfers(v)
    curPO.value = res.po_name
    poInfo.partner_name = res.partner_name || ''
    poInfo.state = res.state || ''
    trList.value = res.transfers || []
    view.value = 'trlist'
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 404) {
      showToast(`❌ 找不到 PO「${v}」`, 'error')
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

async function generateTRs() {
  if (!curPO.value) return
  loading.value = true
  try {
    const res = await poApi.generateTransfers(curPO.value)
    trList.value = res.transfers || []
    showToast(`✅ 已生成 ${res.count} 張 Transfer Order`, 'success')
  } catch (err) {
    if (err.handledByInterceptor) return
    const status = err.response?.status
    const data = err.response?.data || {}
    if (status === 409) {
      showToast(data.detail || '已生成過，請刷新查看', 'warning')
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
  } catch {
    /* 静默 */
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
    trSearch.value = ''
  }
}

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
// 扫码定位品项
// ============================================================
function scanBC() {
  const q = bcQuery.value.trim()
  if (!q) { showToast('請輸入 Barcode 或 SKU', 'warning'); return }
  const idx = curGroups.value.findIndex(g =>
    (g.items || []).some(i => i.barcode === q || i.sku === q)
  )
  if (idx !== -1) {
    bcError.value = ''
    bcQuery.value = ''
    showToast(`✓ 找到: ${curGroups.value[idx].displayName}`, 'success')
    setTimeout(() => { selGrp.value = idx; view.value = 'item' }, 400)
  } else {
    bcError.value = `Barcode「${q}」不存在於此單據`
    bcQuery.value = ''
  }
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
      showToast('✅ 已儲存', 'success')
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
// 截單
// ============================================================
function handleCut() {
  if (!activeTransfer.value) return
  let anyPicked = false, anyRemaining = false
  ;(activeTransfer.value.groups_data || []).forEach(g =>
    (g.items || []).forEach(i => {
      const pick = parseInt(i.pickQty) || 0
      const req = parseInt(i.reqQty) || 0
      if (pick > 0) anyPicked = true
      if (req - pick > 0) anyRemaining = true
    }),
  )
  if (!anyPicked)    { showToast('尚未揀貨，無法截單', 'warning'); return }
  if (!anyRemaining) { showToast('已全部揀完，無需截單', 'warning'); return }
  if (dirty.value && !confirm('當前 TR 有未儲存的修改，建議先儲存再截單。是否繼續截單？')) return
  showCutModal.value = true
}

function closeCutModal() { showCutModal.value = false }

async function executeCut() {
  if (cutting.value || !activeTransfer.value) return
  // 截前先 save 当前的 pickQty（如果 dirty）
  if (dirty.value) {
    await saveTR({ silent: true })
    if (dirty.value) {
      // save 失败（比如冲突）— 不继续
      showCutModal.value = false
      return
    }
  }
  cutting.value = true
  try {
    const res = await poApi.cutTransfer(activeTransfer.value.id)
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
// 扫码相机（占位）
// ============================================================
function openScanner()  { scannerOpen.value = true }
function closeScanner() { scannerOpen.value = false }

// ============================================================
// 导出 — stub（沿用 demo 行为，等业务确认要不要做）
// ============================================================
function exportTR() {
  showToast('✓ 匯出功能待實作', 'info')
}
function exportAllTR() {
  showToast('✓ 匯出功能待實作', 'info')
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

onMounted(() => {
  window.addEventListener('beforeunload', _onBeforeUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', _onBeforeUnload)
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
          <label class="block text-[11px] font-bold tracking-widest mb-3" style="color:rgba(196,181,253,.7);">PO NUMBER</label>
          <input
            v-model="poInput"
            @keydown.enter="searchPO"
            class="w-full px-5 py-4 rounded-2xl text-white text-xl font-bold text-center outline-none mb-4"
            style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);"
            placeholder="輸入 PO Number..."
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
        <button
          class="flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-xs font-bold cursor-pointer"
          style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
          @click="refreshNow"
        >🔄 刷新</button>
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
            :key="tr.id"
            class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden cursor-pointer transition-all hover:-translate-y-px"
            @click="openTR(tr.id)"
          >
            <div class="px-5 py-4">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-3">
                  <div
                    class="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow"
                    :style="{ background: trStats(tr).done_groups === trStats(tr).groups && trStats(tr).groups > 0
                      ? 'linear-gradient(135deg,#34d399,#059669)'
                      : trStats(tr).total_pick > 0
                        ? 'linear-gradient(135deg,#818cf8,#7c3aed)'
                        : 'linear-gradient(135deg,#d1d5db,#9ca3af)' }"
                  >🚚</div>
                  <div>
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-bold text-[15px] text-slate-800">{{ tr.name }}</span>
                      <span
                        v-if="isCutTr(tr)"
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
                    :class="progressClass(trStats(tr).total_req > 0 ? Math.round(trStats(tr).total_pick / trStats(tr).total_req * 100) : 0)"
                    :style="{ width: (trStats(tr).total_req > 0 ? Math.min(Math.round(trStats(tr).total_pick / trStats(tr).total_req * 100), 100) : 0) + '%' }"
                  ></div>
                </div>
                <span
                  class="text-xs font-bold"
                  :style="{ color: (trStats(tr).total_req > 0 ? Math.round(trStats(tr).total_pick / trStats(tr).total_req * 100) : 0) >= 100 ? '#059669' : '#64748b' }"
                >{{ trStats(tr).total_req > 0 ? Math.round(trStats(tr).total_pick / trStats(tr).total_req * 100) : 0 }}%</span>
              </div>
            </div>
          </div>
          <div v-if="!filteredTRs.length" class="text-center text-slate-400 py-12 text-sm">沒有符合的單據</div>
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
      <button
        class="px-3 py-2 rounded-xl text-white cursor-pointer"
        style="background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);"
        @click="refreshNow"
      >🔄</button>
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

    <!-- 已截单提示 -->
    <div v-if="activeTransfer?.state === 'cut'" class="bg-orange-50 border-b border-orange-200 px-4 py-3 text-xs font-semibold text-orange-700">
      ⚠️ 此 TR 已截單，已鎖定不可修改。剩餘部分請去新建的「第二轉」TR 處理。
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
              v-if="(g.items || []).some(i => i.is_bom)"
              class="shrink-0 text-[10px] px-1.5 py-px rounded-md font-bold border"
              style="background:linear-gradient(90deg,#fed7aa,#fce7f3);color:#c2410c;border-color:#fdba74;"
            >BOM</span>
          </div>
          <div class="text-[11px] text-slate-400 truncate">{{ g.displaySku }}{{ g.labelType ? ' · ' + g.labelType : '' }}</div>
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
      </div>
    </div>

    <!-- 底部操作 -->
    <div class="flex-shrink-0 bg-white border-t border-gray-200 px-4 sm:px-5 py-4 flex flex-col gap-3 safe-pb">
      <button
        v-if="activeTransfer?.state !== 'cut' && activeTransfer?.state !== 'done'"
        class="w-full py-3.5 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
        style="border:2px solid #fbbf24;background:linear-gradient(90deg,#fffbeb,#fff7ed);color:#b45309;"
        :disabled="cutting"
        @click="handleCut"
      >✂️ 截單 — 拆分為兩轉出貨</button>
      <div class="flex gap-3">
        <button
          class="flex-1 py-4 rounded-2xl font-bold text-[15px] cursor-pointer flex items-center justify-center gap-2 bg-transparent"
          style="border:2px solid #6366f1;color:#4f46e5;"
          @click="exportTR"
        >⬇ 匯出 Excel</button>
        <button
          class="flex-1 py-4 text-white border-0 rounded-2xl font-bold text-[15px] cursor-pointer disabled:opacity-50"
          style="background:linear-gradient(90deg,#4f46e5,#7c3aed);box-shadow:0 8px 24px rgba(79,70,229,.2);"
          :disabled="saving || activeTransfer?.state === 'cut' || activeTransfer?.state === 'done'"
          @click="saveTR({ afterSave: 'back' })"
        >{{ saving ? '⏳' : '💾 儲存單據' }}</button>
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
        :class="(parseInt(item.pickQty)||0) > (parseInt(item.reqQty)||0)
          ? 'bg-red-50 border-red-200'
          : (parseInt(item.pickQty)||0) >= (parseInt(item.reqQty)||0) && (parseInt(item.reqQty)||0) > 0
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-white border-slate-100'"
      >
        <div class="mb-4">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="font-bold text-sm text-slate-800">{{ item.sku }}</span>
            <span
              v-if="item.is_bom"
              class="text-[11px] px-2 py-0.5 rounded-xl font-bold border"
              style="background:linear-gradient(90deg,#fed7aa,#fce7f3);color:#c2410c;border-color:#fdba74;"
            >Repack ×{{ item.multiplier }}</span>
            <span v-if="(parseInt(item.pickQty)||0) >= (parseInt(item.reqQty)||0) && (parseInt(item.reqQty)||0) > 0 && (parseInt(item.pickQty)||0) <= (parseInt(item.reqQty)||0)">
              <div class="inline-flex w-5 h-5 rounded-full bg-emerald-500 items-center justify-center text-white text-[10px]">✓</div>
            </span>
            <span v-if="(parseInt(item.pickQty)||0) > (parseInt(item.reqQty)||0)" class="text-red-600 text-[11px] font-black bg-red-100 px-2 py-0.5 rounded-xl">超揀!</span>
          </div>
          <div class="text-xs text-slate-400">{{ item.name }}</div>
          <div
            v-if="item.is_bom"
            class="text-xs font-bold mt-1.5 inline-block px-2 py-0.5 rounded-md"
            style="background:#fff7ed;color:#ea580c;"
          >需揀單件: {{ (parseInt(item.reqQty)||0) * (parseInt(item.multiplier)||1) }}</div>
        </div>

        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">需求</label>
            <div class="h-12 flex items-center justify-center bg-slate-50 rounded-xl border border-slate-200 text-lg font-black text-slate-800">{{ item.reqQty }}</div>
          </div>
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">揀貨</label>
            <input
              :value="(parseInt(item.pickQty)||0) === 0 ? '' : item.pickQty"
              type="number"
              inputmode="numeric"
              placeholder="0"
              class="w-full h-12 text-center text-lg font-black rounded-xl outline-none border-2"
              :class="(parseInt(item.pickQty)||0) > (parseInt(item.reqQty)||0)
                ? 'border-red-300 bg-red-50 text-red-600'
                : (parseInt(item.pickQty)||0) >= (parseInt(item.reqQty)||0) && (parseInt(item.reqQty)||0) > 0
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-600'
                  : 'border-slate-200 bg-white text-slate-800'"
              :disabled="activeTransfer?.state === 'cut' || activeTransfer?.state === 'done'"
              @input="updItem(item, 'pickQty', $event.target.value)"
            />
          </div>
          <div class="flex-1">
            <label class="block text-[10px] text-slate-400 font-bold mb-1.5 tracking-widest">箱數</label>
            <input
              :value="(parseInt(item.boxes)||0) === 0 ? '' : item.boxes"
              type="number"
              inputmode="numeric"
              placeholder="0"
              class="w-full h-12 text-center text-lg font-black rounded-xl outline-none border-2 border-slate-200 bg-white text-slate-800"
              :disabled="activeTransfer?.state === 'cut' || activeTransfer?.state === 'done'"
              @input="updItem(item, 'boxes', $event.target.value)"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 底部操作 — saveItem 实际不写后端，回 trdetail 让用户多个 group 录完一起 save -->
    <div class="flex-shrink-0 flex border-t border-gray-200 bg-white safe-pb">
      <button class="flex-1 py-4 bg-slate-50 border-0 text-slate-500 font-bold text-[15px] cursor-pointer" @click="goBack">取消</button>
      <button class="flex-1 py-4 text-white border-0 font-bold text-[15px] cursor-pointer" style="background:linear-gradient(90deg,#4f46e5,#7c3aed);" @click="saveItem">
        確認返回（待儲存）
      </button>
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
