<script setup>
/**
 * 區域盤點 · 任務單
 *
 * 一张任务单 = 一个员工 + 几个货架 + 一个时段（例如 A 负责 T1–T3，1/2 下午）。
 * 「建立並開始」后这些货架立即锁定：App / WMS 不能再向它们上架、转出，直到写回。
 * 员工在 App 盘完全部货架 → 任务单变「待覆核」→ 主管在这里看明细，按「寫回」：
 * 盘到的数量由「未上架」搬到各位置，到期日不同的改登批次；之后货架解锁。
 * 这张单期间的所有操作记录都绑在单上（「操作記錄」可按任务单查）。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { zonecount } from '@/api'
import { showToast } from '@/composables/useToast'
import BatchBar from './BatchBar.vue'
import ShelfStatCards from '@/views/shelf/ShelfStatCards.vue'
import { TASK_STATES, batchId, currentBatch, errText, fmtQty } from './zoneShared'

const router = useRouter()

const tasks = ref([])
const loading = ref(false)
const shelves = ref([])
const employees = ref([])

// ── 新任务单表单 ──
const form = ref({ employeeId: '', start: '', end: '', note: '' })
const picked = ref(new Set())
const shelfFilter = ref('')
const expanded = ref(new Set())
const creating = ref(false)

async function load() {
  if (!batchId.value) { tasks.value = []; return }
  loading.value = true
  try {
    const [t, s] = await Promise.all([zonecount.getTasks(batchId.value), zonecount.getShelves(batchId.value)])
    tasks.value = t.tasks || []
    shelves.value = s.shelves || []
    if (!employees.value.length) employees.value = (await zonecount.getEmployees()).employees || []
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '載入任務單失敗'), 'error')
  } finally {
    loading.value = false
  }
}
watch(batchId, () => { picked.value = new Set(); load() }, { immediate: true })

const stats = computed(() => {
  const by = (s) => tasks.value.filter(t => t.state === s).length
  const locked = tasks.value.filter(t => t.state === 'counting' || t.state === 'submitted')
    .reduce((n, t) => n + t.shelves.length, 0)
  return [
    { label: '任務單', value: tasks.value.filter(t => t.state !== 'cancel').length, unit: '張' },
    { label: '盤點中（鎖定貨架）', value: locked, unit: '個', tone: locked ? 'warn' : 'muted' },
    { label: '待覆核', value: by('submitted'), unit: '張', tone: by('submitted') ? 'amber' : 'muted' },
    { label: '已寫回', value: by('done'), unit: '張' },
  ]
})

// ── 货架树 ──
const byParent = computed(() => {
  const m = new Map()
  for (const s of shelves.value) {
    const k = s.parent_id || 0
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(s)
  }
  return m
})
const byId = computed(() => new Map(shelves.value.map(s => [s.id, s])))

/** 祖先里有已勾选的 → 这一行已被上层覆盖 */
function coveredByParent(s) {
  let p = s.parent_id && byId.value.get(s.parent_id)
  while (p) {
    if (picked.value.has(p.id)) return true
    p = p.parent_id && byId.value.get(p.parent_id)
  }
  return false
}

/** 平铺成要显示的行：搜索时只显示命中的；否则显示第一层 + 展开的下层 */
const shelfRows = computed(() => {
  const q = shelfFilter.value.trim().toLowerCase()
  if (q) return shelves.value.filter(s => s.name.toLowerCase().includes(q) || (s.barcode || '').toLowerCase().includes(q))
  const out = []
  const walk = (pid) => {
    for (const s of byParent.value.get(pid) || []) {
      out.push(s)
      if (expanded.value.has(s.id)) walk(s.id)
    }
  }
  walk(0)
  return out
})

function toggleExpand(s) {
  const e = new Set(expanded.value)
  e.has(s.id) ? e.delete(s.id) : e.add(s.id)
  expanded.value = e
}

/** 不能选：自己 / 上层在进行中的任务单，或下层有一部分已分给别人（选上层会重叠） */
function blocked(s) {
  return s.locked || s.partly || coveredByParent(s)
}

function togglePick(s) {
  if (blocked(s)) return
  const p = new Set(picked.value)
  if (p.has(s.id)) p.delete(s.id)
  else {
    p.add(s.id)
    // 选了上层就去掉已选的下层（上层已经包含）
    for (const id of [...p]) {
      const x = byId.value.get(id)
      if (x && id !== s.id && (x.full_name || '').startsWith(s.full_name + '/')) p.delete(id)
    }
  }
  picked.value = p
}

const pickedList = computed(() => [...picked.value].map(id => byId.value.get(id)).filter(Boolean))

async function createTask() {
  if (!form.value.employeeId) { showToast('請選員工', 'warning'); return }
  if (!picked.value.size) { showToast('請至少選一個貨架', 'warning'); return }
  creating.value = true
  try {
    const r = await zonecount.createTask({
      batchId: batchId.value,
      employeeId: Number(form.value.employeeId),
      locationIds: [...picked.value],
      plannedStart: form.value.start,
      plannedEnd: form.value.end,
      note: form.value.note,
    })
    showToast(`已建立 ${r.task.name}：${r.task.employee.name} · ${r.task.shelves.map(s => s.name).join('、')}（貨架已鎖定）`, 'success')
    picked.value = new Set()
    form.value = { ...form.value, employeeId: '', note: '' }
    await load()
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '建立任務單失敗'), 'error')
  } finally {
    creating.value = false
  }
}

// ── 任务单明细 ──
const openId = ref(null)
const detail = ref(null)
async function toggleDetail(t) {
  if (openId.value === t.id) { openId.value = null; detail.value = null; return }
  openId.value = t.id
  detail.value = null
  try {
    detail.value = await zonecount.getTask(t.id)
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '載入明細失敗'), 'error')
  }
}

// ── 写回 / 退回 / 取消（先确认） ──
const confirming = ref(null)   // { task, op }
const acting = ref(false)
const OPS = {
  writeback: {
    title: '覆核並寫回',
    body: '盤到的數量會由「未上架」搬到各位置（自動開一張「貨架移動」單），到期日不同的改登批次；位置上原本比盤點多的會搬回「未上架」。寫回後貨架解鎖，這張單不能再改。未上架不夠搬的部分記為「多出」，只列出、不調庫存。',
    btn: '確認寫回',
    cls: 'g-btn-teal',
  },
  reopen: { title: '退回重盤', body: '任務單回到「盤點中」，員工可以在 App 繼續錄入 / 修改。貨架保持鎖定。', btn: '退回', cls: 'g-btn-amber' },
  cancel: { title: '取消任務單', body: '取消後貨架解鎖，這張單的盤點結果不算入本批次（操作記錄保留）。', btn: '確認取消', cls: 'bg-red-600 text-white' },
}

async function runOp() {
  const { task, op } = confirming.value
  acting.value = true
  try {
    const r = await zonecount.taskOp(task.id, op)
    showToast(op === 'writeback' ? `${task.name} 已寫回${r.task.pickings ? '：' + r.task.pickings : '（數量相同，不用搬）'}`
      : `${task.name} 已${OPS[op].title}`, 'success')
    confirming.value = null
    if (openId.value === task.id) { openId.value = null; detail.value = null }
    await load()
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, `${OPS[op].title}失敗`), 'error')
  } finally {
    acting.value = false
  }
}

function shelfNames(t) {
  return t.shelves.map(s => s.name).join('、')
}

function progress(t) {
  return `${t.shelf_done} / ${t.shelves.length} 貨架盤完`
}

function openLogs(t) {
  router.push({ name: 'zone-logs', query: { batch: String(batchId.value), task: String(t.id) } })
}
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-[1400px]">
    <BatchBar title="任務單 · 分貨架給員工"
              subtitle="一張任務單 = 一個員工 + 幾個貨架 + 一個時段。他這段時間的所有盤點記錄都歸入這張單；建立後貨架立即鎖定（暫停上架、轉出）。" />

    <template v-if="currentBatch">
      <ShelfStatCards :stats="stats" />

      <!-- 新任务单 -->
      <div v-if="currentBatch.state === 'open'" class="bg-white rounded-xl border border-gray-200 shadow-sm p-4 lg:p-5 mb-5">
        <div class="font-bold text-gray-800 mb-3">新任務單</div>
        <div class="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <div class="space-y-3">
            <label class="block">
              <span class="text-sm text-gray-500">員工</span>
              <select v-model="form.employeeId" class="g-input w-full mt-1">
                <option value="">請選員工</option>
                <option v-for="e in employees" :key="e.id" :value="e.id">{{ e.name }}</option>
              </select>
            </label>
            <div class="grid grid-cols-2 gap-2">
              <label class="block">
                <span class="text-sm text-gray-500">開始</span>
                <input v-model="form.start" type="datetime-local" class="g-input w-full mt-1" />
              </label>
              <label class="block">
                <span class="text-sm text-gray-500">結束</span>
                <input v-model="form.end" type="datetime-local" class="g-input w-full mt-1" />
              </label>
            </div>
            <label class="block">
              <span class="text-sm text-gray-500">備註（可不填）</span>
              <input v-model="form.note" class="g-input w-full mt-1" maxlength="100" placeholder="例如：食品區、只盤上兩層" />
            </label>
            <div class="rounded-lg bg-[#EAF4F1] px-3 py-2 text-sm text-[#2F6B5F]">
              已選 {{ pickedList.length }} 個貨架：{{ pickedList.map(s => s.name).join('、') || '—' }}
            </div>
            <button type="button" class="g-btn g-btn-teal w-full !py-3" :disabled="creating || !form.employeeId || !picked.size"
                    @click="createTask">建立並開始（鎖定貨架）</button>
          </div>

          <div>
            <div class="flex items-center gap-2 mb-2">
              <span class="text-sm text-gray-500 flex-shrink-0">貨架</span>
              <input v-model="shelfFilter" class="g-input flex-1 min-w-0" placeholder="搜尋貨架名稱 / 條碼" />
            </div>
            <div class="border border-gray-200 rounded-lg max-h-[340px] overflow-y-auto divide-y divide-gray-100">
              <div v-for="s in shelfRows" :key="s.id"
                   class="flex items-center gap-2 px-3 py-2 text-sm"
                   :class="blocked(s) && !coveredByParent(s) ? 'bg-gray-50 text-gray-400' : 'hover:bg-slate-50'"
                   :style="shelfFilter ? '' : { paddingLeft: `${12 + s.depth * 20 - 20}px` }">
                <button v-if="s.child_count && !shelfFilter" type="button" class="w-5 text-gray-400"
                        :aria-label="expanded.has(s.id) ? '收起' : '展開'" @click="toggleExpand(s)">{{ expanded.has(s.id) ? '▾' : '▸' }}</button>
                <span v-else class="w-5"></span>
                <label class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer" :class="{ 'cursor-not-allowed': blocked(s) }">
                  <input type="checkbox" :checked="picked.has(s.id) || coveredByParent(s)" :disabled="blocked(s)"
                         @change="togglePick(s)" />
                  <span class="font-mono font-semibold" :class="s.locked ? '' : 'text-gray-800'">{{ shelfFilter ? s.full_name : s.name }}</span>
                  <span v-if="s.child_count" class="text-xs text-gray-400">{{ s.child_count }} 格</span>
                </label>
                <span class="text-xs tabular-nums text-gray-400 w-20 text-right">{{ fmtQty(s.on_hand) }} 件</span>
                <span v-if="s.assigned" class="text-xs rounded px-2 py-0.5" :class="TASK_STATES[s.assigned.state]?.cls">
                  {{ s.assigned.task }} {{ s.assigned.employee }}
                </span>
                <span v-else-if="s.locked" class="text-xs rounded px-2 py-0.5 bg-amber-100 text-amber-800">上層盤點中</span>
                <span v-else-if="s.partly" class="text-xs rounded px-2 py-0.5 bg-gray-100 text-gray-500">部分已分配，請選下層</span>
              </div>
              <div v-if="!shelfRows.length" class="px-3 py-6 text-center text-gray-400 text-sm">
                {{ shelfFilter ? '沒有符合的貨架' : '這個倉還沒有貨架位置（要先在 Odoo 建好子庫位並貼條碼）' }}
              </div>
            </div>
            <p class="text-xs text-gray-400 mt-2">選上層（例如 T1）= 包含它下面所有格子；灰色 = 已在其他進行中的任務單（或下層有一部分已分出去，只能選下層）。</p>
          </div>
        </div>
      </div>

      <!-- 任务单列表 -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" :class="{ 'opacity-60': loading }">
        <div class="overflow-x-auto">
          <table class="w-full text-sm lg:text-[15px] border-collapse min-w-[980px]">
            <thead>
              <tr class="bg-[#EAF4F1] text-[#2F6B5F] text-xs lg:text-[13px]">
                <th class="text-left font-bold px-4 py-3">任務單</th>
                <th class="text-left font-bold px-4 py-3">員工</th>
                <th class="text-left font-bold px-4 py-3">貨架</th>
                <th class="text-left font-bold px-4 py-3">時段</th>
                <th class="text-left font-bold px-4 py-3">狀態</th>
                <th class="text-left font-bold px-4 py-3">進度</th>
                <th class="text-left font-bold px-4 py-3">記錄</th>
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="t in tasks" :key="t.id">
                <tr class="border-t border-gray-100 hover:bg-slate-50">
                  <td class="px-4 py-3 font-bold text-gray-800 whitespace-nowrap">{{ t.name }}</td>
                  <td class="px-4 py-3 whitespace-nowrap">{{ t.employee.name }}</td>
                  <td class="px-4 py-3 font-mono">{{ shelfNames(t) }}</td>
                  <td class="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {{ t.planned_start ? `${t.planned_start} – ${t.planned_end.slice(-5)}` : '—' }}
                  </td>
                  <td class="px-4 py-3">
                    <span class="text-xs font-bold rounded-full px-2.5 py-1 whitespace-nowrap" :class="TASK_STATES[t.state]?.cls">{{ TASK_STATES[t.state]?.label }}</span>
                  </td>
                  <td class="px-4 py-3 text-gray-600 whitespace-nowrap">{{ progress(t) }}</td>
                  <td class="px-4 py-3 text-gray-600">
                    <span class="whitespace-nowrap">{{ t.sku_count }} SKU · {{ fmtQty(t.qty) }} 件</span>
                    <div class="text-xs text-gray-400">
                      {{ t.log_count }} 筆操作<template v-if="t.log_counts?.set">（改 {{ t.log_counts.set }}）</template><template v-if="t.log_counts?.undo">（撤回 {{ t.log_counts.undo }}）</template>
                      <template v-if="t.over_qty"> · <span class="text-red-600">多出 {{ fmtQty(t.over_qty) }}</span></template>
                    </div>
                  </td>
                  <td class="px-4 py-2 text-right whitespace-nowrap">
                    <button type="button" class="g-row-btn g-row-btn-teal mr-1.5" @click="toggleDetail(t)">{{ openId === t.id ? '收起' : '明細' }}</button>
                    <button type="button" class="g-row-btn g-row-btn-teal mr-1.5" @click="openLogs(t)">記錄</button>
                    <template v-if="t.state === 'counting' || t.state === 'submitted'">
                      <button type="button" class="g-row-btn g-row-btn-amber mr-1.5" @click="confirming = { task: t, op: 'writeback' }">寫回</button>
                      <button v-if="t.state === 'submitted'" type="button" class="g-row-btn mr-1.5" @click="confirming = { task: t, op: 'reopen' }">退回</button>
                      <button type="button" class="g-row-btn text-red-600" @click="confirming = { task: t, op: 'cancel' }">取消</button>
                    </template>
                  </td>
                </tr>
                <tr v-if="openId === t.id" class="bg-slate-50">
                  <td colspan="8" class="px-4 py-4">
                    <div v-if="!detail" class="text-gray-400">載入中…</div>
                    <div v-else class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <div v-for="sd in detail.shelves" :key="sd.shelf.shelf_id" class="bg-white rounded-lg border border-gray-200 p-3">
                        <div class="flex justify-between mb-2">
                          <span class="font-bold font-mono">{{ sd.shelf.name }}</span>
                          <span class="text-xs" :class="sd.shelf.state === 'done' ? 'text-emerald-700' : 'text-amber-700'">
                            {{ sd.shelf.state === 'done' ? '已盤完' : '未盤完' }} · {{ sd.sku_count }} SKU · {{ fmtQty(sd.qty) }} 件
                          </span>
                        </div>
                        <div v-for="loc in sd.locations" :key="loc.id" class="mb-2 last:mb-0">
                          <div class="text-xs font-semibold text-gray-600">{{ loc.name }} <span v-if="!loc.lines.length" class="text-gray-400 font-normal">未盤</span></div>
                          <div v-for="ln in loc.lines" :key="ln.line_id" class="flex justify-between text-xs py-0.5">
                            <span class="font-mono truncate mr-2" :title="ln.name">
                              {{ ln.sku }}<span v-if="ln.expiry" :class="ln.expiry_changed ? 'text-amber-700' : 'text-gray-400'"> · {{ ln.expiry }}{{ ln.expiry_changed ? '（新日期）' : '' }}</span>
                            </span>
                            <span class="tabular-nums font-semibold">{{ fmtQty(ln.qty) }}<span v-if="ln.over_qty" class="text-red-600"> 多出 {{ fmtQty(ln.over_qty) }}</span></span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div v-if="detail?.task.pickings" class="text-xs text-gray-500 mt-3">
                      寫回：{{ detail.task.written_at }} · {{ detail.task.written_by }} · 調撥單 {{ detail.task.pickings }}
                    </div>
                  </td>
                </tr>
              </template>
              <tr v-if="!tasks.length && !loading">
                <td colspan="8" class="px-4 py-10 text-center text-gray-400">這個批次還沒有任務單。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-2 mt-4 text-sm">
        <div class="bg-white rounded-xl border border-gray-200 px-4 py-3 text-gray-500">
          <div class="font-bold text-gray-700 mb-1">員工按完全部「貨架盤完」之後</div>
          任務單變「待覆核」。按「明細」核對，沒問題按「寫回」；要員工重盤按「退回」。
        </div>
        <div class="bg-amber-50 rounded-xl border border-amber-200 px-4 py-3 text-amber-800">
          <div class="font-bold mb-1">鎖定期間</div>
          倉庫同事不從這些貨架揀貨、不上架。系統只擋 App / WMS 向這些貨架上架、轉出；揀貨出庫靠現場執行。
        </div>
      </div>
    </template>

    <!-- 确认弹窗 -->
    <div v-if="confirming" class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" @click.self="confirming = null">
      <div class="bg-white rounded-2xl shadow-xl max-w-md w-full p-5">
        <div class="text-lg font-bold text-gray-800">{{ OPS[confirming.op].title }} · {{ confirming.task.name }}</div>
        <div class="text-sm text-gray-500 mt-1">{{ confirming.task.employee.name }} · {{ shelfNames(confirming.task) }} · {{ confirming.task.sku_count }} SKU · {{ fmtQty(confirming.task.qty) }} 件</div>
        <p class="text-sm text-gray-700 mt-3 leading-relaxed">{{ OPS[confirming.op].body }}</p>
        <p v-if="confirming.op === 'writeback' && confirming.task.state === 'counting'" class="text-sm text-amber-700 mt-2">
          注意：員工還沒按完全部「貨架盤完」（{{ progress(confirming.task) }}）。
        </p>
        <div class="flex justify-end gap-2 mt-5">
          <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-5" :disabled="acting" @click="confirming = null">返回</button>
          <button type="button" class="g-btn !px-5" :class="OPS[confirming.op].cls" :disabled="acting" @click="runOp">
            {{ acting ? '處理中…' : OPS[confirming.op].btn }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
