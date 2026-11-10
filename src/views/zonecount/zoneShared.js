/**
 * 區域盤點四个页面共用：当前批次 + 状态文字 + Excel 汇出
 *
 * 当前批次放在模块级 ref（四个子菜单切换时保持同一个批次），
 * 同时写进 URL ?batch=，分享链接 / 重新整理都能还原。
 */
import { computed, ref } from 'vue'
import { zonecount } from '@/api'

export const batches = ref([])
export const batchId = ref(null)
export const batchesLoaded = ref(false)

export const currentBatch = computed(() => batches.value.find(b => b.id === batchId.value) || null)

/** 读批次列表；preferId = URL 里的 ?batch=。没有指定就选最新一个进行中的 */
export async function loadBatches(preferId) {
  const r = await zonecount.getBatches()
  batches.value = r.batches || []
  batchesLoaded.value = true
  const want = Number(preferId) || batchId.value
  if (want && batches.value.some(b => b.id === want)) batchId.value = want
  else batchId.value = (batches.value.find(b => b.state === 'open') || batches.value[0])?.id ?? null
  return batchId.value
}

export const TASK_STATES = {
  counting: { label: '盤點中 · 鎖定', cls: 'bg-amber-100 text-amber-800' },
  submitted: { label: '待覆核', cls: 'bg-sky-100 text-sky-800' },
  done: { label: '已寫回', cls: 'bg-emerald-100 text-emerald-800' },
  cancel: { label: '已取消', cls: 'bg-gray-100 text-gray-500' },
}

export function fmtQty(v) {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** 后端错误 → 给主管看的话 */
export function errText(err, fallback = '操作失敗') {
  const d = err?.response?.data || {}
  const map = {
    batch_not_found: '找不到這個盤點批次',
    batch_closed: '批次已結束，不能再開任務單',
    employee_not_found: '請選員工',
    missing_shelves: '請至少選一個貨架',
    missing_name: '請輸入批次名稱',
    task_not_found: '找不到這張任務單',
    warehouse_not_found: '找不到倉庫',
  }
  return d.message || map[d.error] || d.error || fallback
}

/**
 * 汇出 Excel（.xlsx；xlsx 按需加载，不进首屏）
 * rows: 二维数组，第一行是表头
 */
export async function downloadXlsx(filename, rows, sheetName = '盤點') {
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = rows[0].map((_h, i) => ({
    wch: Math.min(40, Math.max(8, ...rows.slice(0, 200).map(r => String(r[i] ?? '').length + 2))),
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, filename)
}
