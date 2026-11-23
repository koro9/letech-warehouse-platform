<script setup>
/**
 * 倉庫作業中心 · 貨架管理 — 在 WMS 里建 / 改 / 删板、格子（= Odoo 子库位），手机也能用
 *
 *   - 列表：整个仓库存树（默认 HSD4），一层层展开；每行 名称 · 条码 · 在库 / SKU 数
 *   - 顶部搜索框 + 📷 相机扫码：按名称 / 条码过滤，扫到条码直接打开该位置的操作
 *   - 「＋ 新增貨架」建在 XXX/庫存 下；每个位置的「⋯」：新增下層格子 / 編輯 / 刪除 / 查看貨架 / 手機上架
 *   - 新增支持「批量」：前缀 + 起止编号，一次建 T1-1 ~ T1-20
 *   - 条码建议 = <仓库代码>-<名称里的英数>，例如 T1板 → HSD4-T1、T1-1 → HSD4-T1-1（可改）
 *
 * 后端守底线：同层不重名、条码全公司不重复、只能删空位置（无货 / 无下层 / 不在盘点中）。
 */
import { computed, defineAsyncComponent, onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import { shelf } from '@/api'
import { showToast } from '@/composables/useToast'
import { fmtQty } from './shelfRows'

const BarcodeScanner = defineAsyncComponent(() => import('@/components/BarcodeScanner.vue'))

const router = useRouter()

const loading = ref(false)
const result = ref(null)
const collapsed = ref(new Set())   // 收起的位置 id
const search = ref('')
const scannerOpen = ref(false)

const whCode = computed(() => result.value?.warehouse?.code || '')
const root = computed(() => result.value?.tree || null)

async function load() {
  loading.value = true
  try {
    result.value = await shelf.getStructure()
  } catch (err) {
    if (!err.handledByInterceptor) showToast('載入貨架失敗', 'error')
  } finally {
    loading.value = false
  }
}
onActivated(load)

// ── 列表（拍平成行，带深度） ─────────────────────────────
const rows = computed(() => {
  const out = []
  const q = search.value.trim().toLowerCase()
  const match = (n) => n.name.toLowerCase().includes(q) || (n.barcode || '').toLowerCase().includes(q)
  // 搜索时：命中的位置及其祖先都显示，全部展开
  const keep = (n) => !q || match(n) || n.children.some(keep)
  const walk = (node, depth, parent) => {
    for (const c of node.children) {
      if (!keep(c)) continue
      out.push({ node: c, depth, parent, hit: q && match(c) })
      if (c.children.length && (q || !collapsed.value.has(c.id))) walk(c, depth + 1, c)
    }
  }
  if (root.value) walk(root.value, 0, root.value)
  return out
})

function toggle(id) {
  const s = new Set(collapsed.value)
  s.has(id) ? s.delete(id) : s.add(id)
  collapsed.value = s
}

function findNode(pred, node = root.value, parent = null) {
  if (!node) return null
  if (node !== root.value && pred(node)) return { node, parent }
  for (const c of node.children) {
    const r = findNode(pred, c, node)
    if (r) return r
  }
  return null
}

function onScan(code) {
  scannerOpen.value = false
  if (!code) return
  const hit = findNode(n => (n.barcode || '').toUpperCase() === code.toUpperCase())
  if (hit) { search.value = ''; openActions(hit.node, hit.parent) }
  else { search.value = code; showToast(`找不到條碼「${code}」的位置`, 'error') }
}

// ── 条码建议 ───────────────────────────────────────────
function suggestBarcode(name) {
  const ascii = String(name || '').normalize('NFKC').replace(/\s+/g, '-').replace(/[^\x21-\x7e]/g, '').replace(/^-+|-+$/g, '')
  return ascii ? `${whCode.value}-${ascii}`.toUpperCase() : ''
}

// ── 操作选单 ───────────────────────────────────────────
const actionFor = ref(null)        // { node, parent }
function openActions(node, parent) { actionFor.value = { node, parent } }
function closeActions() { actionFor.value = null }

function hasStock(n) { return (n.total?.on_hand || 0) > 0 || (n.total?.reserved || 0) > 0 }

// ── 新增 ───────────────────────────────────────────────
const createFor = ref(null)        // 上层 node
const mode = ref('single')         // single | batch
const fName = ref('')
const fBarcode = ref('')
const barcodeTouched = ref(false)
const bPrefix = ref('')
const bFrom = ref(1)
const bTo = ref(5)
const bBarcode = ref(true)
const formError = ref('')
const saving = ref(false)
let idemKey = ''

function newKey() { return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}` }

function openCreate(parent) {
  closeActions()
  createFor.value = parent
  const isRoot = parent === root.value
  mode.value = isRoot ? 'single' : 'batch'
  fName.value = ''
  fBarcode.value = ''
  barcodeTouched.value = false
  // 在 T1板 下建格子：前缀默认 T1-
  bPrefix.value = isRoot ? '' : `${String(parent.name).replace(/[板架]$/, '')}-`
  // 接着现有编号往下：已有 T1-1 ~ T1-7 就从 T1-8 开始
  const esc = bPrefix.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nums = parent.children
    .map(c => (new RegExp(`^${esc}(\\d+)$`, 'i').exec(c.name) || [])[1])
    .filter(Boolean).map(Number)
  bFrom.value = nums.length ? Math.max(...nums) + 1 : 1
  bTo.value = bFrom.value + 4
  bBarcode.value = true
  formError.value = ''
  idemKey = newKey()
}

function onNameInput() {
  if (!barcodeTouched.value) fBarcode.value = suggestBarcode(fName.value)
}

const batchItems = computed(() => {
  const from = Number(bFrom.value)
  const to = Number(bTo.value)
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from >= 200) return []
  const items = []
  for (let i = from; i <= to; i++) {
    const name = `${bPrefix.value}${i}`
    items.push({ name, barcode: bBarcode.value ? suggestBarcode(name) : '' })
  }
  return items
})

const ERR = {
  invalid_name: d => `名稱「${d.name || ''}」不可用（不能空白、不能有「/」）`,
  invalid_barcode: d => `條碼「${d.barcode || ''}」只能用英文、數字和符號，不能有空格或中文`,
  duplicate_in_request: d => `「${d.value}」重複了`,
  name_taken: d => `同一層已經有「${d.name}」`,
  barcode_taken: d => `條碼「${d.barcode}」已被 ${d.location?.full_name || '其他位置'}${d.location && d.location.active === false ? '（已刪除）' : ''} 使用`,
  too_many_items: d => `一次最多建 ${d.max} 個`,
  location_not_found: () => '找不到這個位置，請重新整理',
  location_outside_warehouse: () => '位置不在倉庫庫存範圍內',
  root_location: () => '倉庫的「庫存」根位置不能修改',
  has_stock: d => `上面還有 ${fmtQty(d.qty)} 件貨，要先轉走才能刪除`,
  has_children: d => `下面還有 ${d.count} 個位置，要先刪除下層`,
  has_open_moves: d => `還有 ${d.count} 筆未完成的調撥用到這個位置`,
  shelf_locked: d => `正在區域盤點（${d.task || ''} ${d.employee || ''}），不能刪除`,
}
function errText(err, fallback) {
  const d = err.response?.data || {}
  if (err.response?.status === 403) return '沒有權限修改貨架，請聯絡主管'
  return ERR[d.error] ? ERR[d.error](d) : (d.error || fallback)
}

async function submitCreate() {
  if (saving.value) return
  formError.value = ''
  const items = mode.value === 'single'
    ? [{ name: fName.value.trim(), barcode: fBarcode.value.trim() }]
    : batchItems.value
  if (!items.length || !items[0].name) {
    formError.value = mode.value === 'single' ? '請輸入名稱' : '編號範圍不對（最多一次 200 個）'
    return
  }
  saving.value = true
  try {
    const res = await shelf.createLocations(createFor.value.id, items, idemKey)
    const n = res.created.length
    showToast(n === 1 ? `已新增 ${res.created[0].full_name}` : `已新增 ${n} 個位置`, 'success')
    const parentId = createFor.value.id
    createFor.value = null
    await load()
    const s = new Set(collapsed.value); s.delete(parentId); collapsed.value = s
  } catch (err) {
    if (err.handledByInterceptor) return
    formError.value = errText(err, '新增失敗，請重試')
    idemKey = newKey()
  } finally {
    saving.value = false
  }
}

// ── 编辑 ───────────────────────────────────────────────
const editFor = ref(null)
const eName = ref('')
const eBarcode = ref('')

function openEdit(node) {
  closeActions()
  editFor.value = node
  eName.value = node.name
  eBarcode.value = node.barcode || ''
  formError.value = ''
}

async function submitEdit() {
  if (saving.value) return
  formError.value = ''
  saving.value = true
  try {
    const res = await shelf.updateLocation(editFor.value.id, { name: eName.value.trim(), barcode: eBarcode.value.trim() })
    showToast(`已更新 ${res.location.full_name}`, 'success')
    editFor.value = null
    await load()
  } catch (err) {
    if (err.handledByInterceptor) return
    formError.value = errText(err, '更新失敗，請重試')
  } finally {
    saving.value = false
  }
}

// ── 删除 ───────────────────────────────────────────────
const deleteFor = ref(null)
function openDelete(node) {
  closeActions()
  deleteFor.value = node
  formError.value = ''
}
async function submitDelete() {
  if (saving.value) return
  formError.value = ''
  saving.value = true
  try {
    await shelf.archiveLocation(deleteFor.value.id)
    showToast(`已刪除 ${deleteFor.value.full_name}`, 'success')
    deleteFor.value = null
    await load()
  } catch (err) {
    if (err.handledByInterceptor) return
    formError.value = errText(err, '刪除失敗，請重試')
  } finally {
    saving.value = false
  }
}

function goLocation(node) {
  closeActions()
  router.push({ name: 'shelf-location', query: { location_id: node.id } })
}
function goPutaway(node) {
  closeActions()
  router.push({ name: 'shelf-putaway', query: { loc: node.id } })
}
</script>

<template>
  <div class="p-3 sm:p-6 lg:px-10 lg:py-8 max-w-3xl pb-24">
    <div class="flex items-center justify-between gap-3 mb-3">
      <div class="min-w-0">
        <h2 class="text-lg sm:text-xl lg:text-2xl font-bold text-gray-800">貨架管理</h2>
        <div v-if="result" class="text-xs sm:text-sm text-gray-500 truncate">
          {{ root.full_name }} · {{ result.summary.location_count }} 個板／格子
        </div>
      </div>
      <button type="button" class="g-btn g-btn-teal !px-4 !py-2 flex-shrink-0" :disabled="!root" @click="openCreate(root)">＋ 新增貨架</button>
    </div>

    <!-- 搜索 / 扫码 -->
    <div class="flex gap-2 mb-3">
      <input v-model="search" type="search" class="g-input flex-1 min-w-0 w-0 !text-base !py-2.5" placeholder="搜尋名稱或條碼" autocomplete="off" />
      <button type="button" class="g-btn bg-white border border-gray-200 !px-3 text-lg" aria-label="相機掃碼" @click="scannerOpen = true">📷</button>
      <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-3" :disabled="loading" aria-label="重新整理" @click="load">⟳</button>
    </div>

    <div v-if="loading && !result" class="g-card text-sm text-gray-500">載入中…</div>

    <div v-else-if="root && !root.children.length" class="g-card text-sm text-gray-500 leading-relaxed">
      {{ root.full_name }} 下還沒有貨架。按右上角「＋ 新增貨架」開始，例如先建「T1板」，再在它下面批量建 T1-1 ~ T1-7。
    </div>

    <div v-else-if="root" class="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div v-if="!rows.length" class="px-4 py-6 text-sm text-gray-400">找不到符合「{{ search }}」的位置</div>
      <div
        v-for="r in rows" :key="r.node.id"
        class="flex items-center gap-2 border-b border-gray-100 last:border-0 pr-2 min-h-[56px]"
        :class="r.hit ? 'bg-amber-50' : ''"
        :style="{ paddingLeft: `${8 + r.depth * 20}px` }"
      >
        <button
          type="button"
          class="w-8 h-8 flex items-center justify-center text-gray-400 flex-shrink-0 rounded"
          :class="r.node.children.length ? 'active:bg-gray-100' : 'invisible'"
          :aria-label="collapsed.has(r.node.id) ? '展開' : '收起'"
          @click="toggle(r.node.id)"
        >{{ collapsed.has(r.node.id) && !search ? '▸' : '▾' }}</button>
        <button type="button" class="min-w-0 flex-1 text-left py-2" @click="openActions(r.node, r.parent)">
          <div class="flex items-baseline gap-2 min-w-0">
            <span class="font-semibold text-gray-800 truncate" :class="r.depth === 0 ? 'text-base' : 'text-[15px]'">{{ r.node.name }}</span>
            <span v-if="r.node.children.length" class="text-xs text-gray-400 flex-shrink-0">{{ r.node.children.length }} 格</span>
          </div>
          <div class="text-xs truncate" :class="r.node.barcode ? 'font-mono text-gray-500' : 'text-amber-600'">
            {{ r.node.barcode || '未設條碼' }}
          </div>
        </button>
        <div class="text-right flex-shrink-0 w-16">
          <div class="text-sm font-semibold" :class="hasStock(r.node) ? 'text-gray-800' : 'text-gray-300'">{{ fmtQty(r.node.total.on_hand) }}</div>
          <div class="text-[11px] text-gray-400">{{ r.node.total.sku_count }} SKU</div>
        </div>
        <button type="button" class="w-9 h-9 flex items-center justify-center text-gray-500 rounded-lg active:bg-gray-100 flex-shrink-0 text-lg" aria-label="操作" @click="openActions(r.node, r.parent)">⋯</button>
      </div>
    </div>

    <p v-if="root && root.children.length" class="text-xs text-gray-400 mt-3 leading-relaxed">
      點位置可新增下層格子、改名稱或條碼、刪除。只有空的位置（沒貨、沒下層）可以刪除。
    </p>

    <!-- 操作选单（手机底部弹出） -->
    <div v-if="actionFor" class="fixed inset-0 z-[200] bg-black/40 flex items-end md:items-center justify-center" @click.self="closeActions">
      <div class="bg-white w-full md:max-w-sm rounded-t-2xl md:rounded-2xl shadow-2xl safe-pb overflow-hidden">
        <div class="px-5 pt-4 pb-3 border-b border-gray-100">
          <div class="text-lg font-bold text-gray-800">{{ actionFor.node.name }}</div>
          <div class="text-xs text-gray-500">{{ actionFor.node.full_name }}</div>
          <div class="text-xs mt-1" :class="actionFor.node.barcode ? 'font-mono text-gray-500' : 'text-amber-600'">{{ actionFor.node.barcode || '未設條碼' }}</div>
        </div>
        <div class="divide-y divide-gray-100">
          <button type="button" class="w-full text-left px-5 py-3.5 active:bg-gray-50" @click="openCreate(actionFor.node)">＋ 在下面新增格子</button>
          <button type="button" class="w-full text-left px-5 py-3.5 active:bg-gray-50" @click="openEdit(actionFor.node)">✏️ 改名稱 / 條碼</button>
          <button type="button" class="w-full text-left px-5 py-3.5 active:bg-gray-50" @click="goPutaway(actionFor.node)">📱 在這裡上架商品</button>
          <button type="button" class="w-full text-left px-5 py-3.5 active:bg-gray-50" @click="goLocation(actionFor.node)">🗄️ 查看貨架上的商品</button>
          <button
            type="button" class="w-full text-left px-5 py-3.5 active:bg-gray-50"
            :class="hasStock(actionFor.node) || actionFor.node.children.length ? 'text-gray-300' : 'text-red-600'"
            :disabled="hasStock(actionFor.node) || actionFor.node.children.length > 0"
            @click="openDelete(actionFor.node)"
          >
            🗑 刪除
            <span v-if="hasStock(actionFor.node)" class="text-xs">（上面有貨）</span>
            <span v-else-if="actionFor.node.children.length" class="text-xs">（下面還有位置）</span>
          </button>
          <button type="button" class="w-full text-center px-5 py-3.5 text-gray-500 active:bg-gray-50" @click="closeActions">取消</button>
        </div>
      </div>
    </div>

    <!-- 新增 -->
    <div v-if="createFor" class="fixed inset-0 z-[200] bg-black/40 flex items-end md:items-center justify-center" @click.self="createFor = null">
      <form class="bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl shadow-2xl safe-pb max-h-[90vh] overflow-y-auto" @submit.prevent="submitCreate">
        <div class="px-5 pt-4 pb-3 border-b border-gray-100">
          <div class="text-lg font-bold text-gray-800">新增{{ createFor === root ? '貨架' : '格子' }}</div>
          <div class="text-xs text-gray-500">建在：{{ createFor.full_name }}</div>
        </div>
        <div class="px-5 py-4 space-y-4">
          <div class="grid grid-cols-2 bg-gray-100 rounded-xl p-1 text-sm">
            <button type="button" class="py-2 rounded-lg" :class="mode === 'single' ? 'bg-white shadow font-semibold text-gray-800' : 'text-gray-500'" @click="mode = 'single'">單個</button>
            <button type="button" class="py-2 rounded-lg" :class="mode === 'batch' ? 'bg-white shadow font-semibold text-gray-800' : 'text-gray-500'" @click="mode = 'batch'">批量（編號）</button>
          </div>

          <template v-if="mode === 'single'">
            <div>
              <label class="block text-sm text-gray-500 mb-1" for="sm-name">名稱</label>
              <input id="sm-name" v-model="fName" type="text" class="g-input w-full !text-base !py-2.5" placeholder="例如 T1板 或 T1-1" autocomplete="off" @input="onNameInput" />
            </div>
            <div>
              <label class="block text-sm text-gray-500 mb-1" for="sm-bc">條碼（貼在貨架上、掃碼用）</label>
              <input id="sm-bc" v-model="fBarcode" type="text" class="g-input w-full !text-base !py-2.5 font-mono" placeholder="例如 HSD4-T1-1" autocomplete="off" autocapitalize="characters" @input="barcodeTouched = true" />
              <div class="text-xs text-gray-400 mt-1">只能用英文、數字、「-」等符號；可以留空，之後再補</div>
            </div>
          </template>

          <template v-else>
            <div class="grid grid-cols-3 gap-2">
              <div>
                <label class="block text-sm text-gray-500 mb-1" for="sm-prefix">前綴</label>
                <input id="sm-prefix" v-model="bPrefix" type="text" class="g-input w-full !text-base !py-2.5" placeholder="T1-" autocomplete="off" />
              </div>
              <div>
                <label class="block text-sm text-gray-500 mb-1" for="sm-from">從</label>
                <input id="sm-from" v-model.number="bFrom" type="number" inputmode="numeric" min="0" class="g-input w-full !text-base !py-2.5" />
              </div>
              <div>
                <label class="block text-sm text-gray-500 mb-1" for="sm-to">到</label>
                <input id="sm-to" v-model.number="bTo" type="number" inputmode="numeric" min="0" class="g-input w-full !text-base !py-2.5" />
              </div>
            </div>
            <label class="flex items-center gap-2 text-sm text-gray-600">
              <input v-model="bBarcode" type="checkbox" class="w-4 h-4" /> 自動產生條碼（{{ suggestBarcode(`${bPrefix}${bFrom}`) || '—' }}）
            </label>
            <div class="bg-gray-50 rounded-xl px-3 py-2 text-sm">
              <div class="text-gray-500 mb-1">將建立 {{ batchItems.length }} 個：</div>
              <div class="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                <span v-for="it in batchItems" :key="it.name" class="px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-700">{{ it.name }}</span>
                <span v-if="!batchItems.length" class="text-red-500">編號範圍不對（最多一次 200 個）</span>
              </div>
            </div>
          </template>

          <p v-if="formError" class="text-sm text-red-600">{{ formError }}</p>
        </div>
        <div class="px-5 pb-4 flex gap-2">
          <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-5 !py-2.5" :disabled="saving" @click="createFor = null">取消</button>
          <button type="submit" class="g-btn g-btn-teal flex-1 !py-2.5" :disabled="saving">
            {{ saving ? '處理中…' : mode === 'single' ? '新增' : `新增 ${batchItems.length} 個` }}
          </button>
        </div>
      </form>
    </div>

    <!-- 编辑 -->
    <div v-if="editFor" class="fixed inset-0 z-[200] bg-black/40 flex items-end md:items-center justify-center" @click.self="editFor = null">
      <form class="bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl shadow-2xl safe-pb" @submit.prevent="submitEdit">
        <div class="px-5 pt-4 pb-3 border-b border-gray-100">
          <div class="text-lg font-bold text-gray-800">改名稱 / 條碼</div>
          <div class="text-xs text-gray-500">{{ editFor.full_name }}</div>
        </div>
        <div class="px-5 py-4 space-y-4">
          <div>
            <label class="block text-sm text-gray-500 mb-1" for="se-name">名稱</label>
            <input id="se-name" v-model="eName" type="text" class="g-input w-full !text-base !py-2.5" autocomplete="off" />
          </div>
          <div>
            <label class="block text-sm text-gray-500 mb-1" for="se-bc">條碼</label>
            <div class="flex gap-2">
              <input id="se-bc" v-model="eBarcode" type="text" class="g-input flex-1 min-w-0 w-0 !text-base !py-2.5 font-mono" autocomplete="off" autocapitalize="characters" />
              <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-3 text-sm" @click="eBarcode = suggestBarcode(eName)">建議</button>
            </div>
          </div>
          <p class="text-xs text-gray-400">改名稱不會動到上面的貨；已印好的條碼標籤改了條碼要重新貼。</p>
          <p v-if="formError" class="text-sm text-red-600">{{ formError }}</p>
        </div>
        <div class="px-5 pb-4 flex gap-2">
          <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-5 !py-2.5" :disabled="saving" @click="editFor = null">取消</button>
          <button type="submit" class="g-btn g-btn-teal flex-1 !py-2.5" :disabled="saving">{{ saving ? '處理中…' : '儲存' }}</button>
        </div>
      </form>
    </div>

    <!-- 删除 -->
    <div v-if="deleteFor" class="fixed inset-0 z-[200] bg-black/40 flex items-end md:items-center justify-center" @click.self="deleteFor = null">
      <div class="bg-white w-full md:max-w-sm rounded-t-2xl md:rounded-2xl shadow-2xl safe-pb">
        <div class="px-5 py-5 space-y-3">
          <div class="text-lg font-bold text-gray-800">刪除 {{ deleteFor.name }}？</div>
          <p class="text-sm text-gray-500">{{ deleteFor.full_name }} 會從貨架清單移除（Odoo 裡是封存，過去的調撥記錄仍然保留）。</p>
          <p v-if="formError" class="text-sm text-red-600">{{ formError }}</p>
        </div>
        <div class="px-5 pb-4 flex gap-2">
          <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 flex-1 !py-2.5" :disabled="saving" @click="deleteFor = null">取消</button>
          <button type="button" class="g-btn flex-1 !py-2.5 bg-red-600 text-white" :disabled="saving" @click="submitDelete">{{ saving ? '處理中…' : '刪除' }}</button>
        </div>
      </div>
    </div>

    <BarcodeScanner v-if="scannerOpen" @detected="onScan" @close="scannerOpen = false" />
  </div>
</template>
