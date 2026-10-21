<script setup>
/**
 * 上架 / 轉出 弹窗（倉庫作業中心三个页面共用）
 *
 * 流程（照仓库需求 PDF）：选目标位置 → 填数量 → 确认（是 / 否）→ 完成
 *   上架：来源 = 未上架（库存根库位本层）
 *   轉出：来源 = 某个板 / 格子本层
 * 后端开一张「貨架移動」单（HSD4/BIN/…）并立即完成；来源锁定本层，不会去下层格子拿货。
 *
 * props.move = { kind: 'putaway'|'transfer', sku, name, sourceId, sourceLabel, available }
 * emits: close / done(result)
 *
 * 防重复：进入确认步骤时生成一个 Idempotency-Key，同一次确认的重试都用它，
 * 后端只会执行一次（连按「是」、网络重发都不会多搬）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { shelf } from '@/api'
import { showToast } from '@/composables/useToast'
import { fmtQty } from './shelfRows'

const props = defineProps({
  move: { type: Object, default: null },
})
const emit = defineEmits(['close', 'done'])

const step = ref('form')          // 'form' | 'confirm'
const targetQuery = ref('')
const candidates = ref([])
const searching = ref(false)
const target = ref(null)          // { id, name, full_name, barcode }
const qty = ref('')
const error = ref('')
const submitting = ref(false)
const idemKey = ref('')
const targetInput = ref(null)

const title = computed(() => (props.move?.kind === 'putaway' ? '上架' : '轉出'))
const qtyNum = computed(() => Number(qty.value))
const left = computed(() => (props.move ? props.move.available - qtyNum.value : 0))

// 打开时重置
watch(() => props.move, (m) => {
  if (!m) return
  step.value = 'form'
  targetQuery.value = ''
  candidates.value = []
  target.value = null
  qty.value = String(m.available)
  error.value = ''
  submitting.value = false
  idemKey.value = ''
  nextTick(() => targetInput.value?.focus())
  searchTargets('')
}, { immediate: true })

let searchSeq = 0
async function searchTargets(q) {
  const seq = ++searchSeq
  searching.value = true
  try {
    const res = await shelf.getTargetLocations(q)
    if (seq !== searchSeq) return
    // 来源位置本身不能当目标
    candidates.value = (res.locations || []).filter(l => l.id !== props.move?.sourceId)
    // 扫码：条码精确命中就直接选上
    const exact = candidates.value.find(l => l.barcode && l.barcode.toUpperCase() === q.trim().toUpperCase())
    if (q && exact) pickTarget(exact)
  } catch (err) {
    if (!err.handledByInterceptor) showToast('查詢位置失敗', 'error')
  } finally {
    if (seq === searchSeq) searching.value = false
  }
}

function pickTarget(loc) {
  target.value = loc
  targetQuery.value = loc.full_name
  error.value = ''
}

// 手输时 250ms 防抖；扫码枪输入很快，最后的 Enter 会立即查（见模板 keydown.enter）
let inputTimer = null
function onTargetInput() {
  target.value = null
  clearTimeout(inputTimer)
  inputTimer = setTimeout(() => searchTargets(targetQuery.value.trim()), 250)
}

function toConfirm() {
  error.value = ''
  if (!target.value) { error.value = '請選擇目標位置'; return }
  if (!(qtyNum.value > 0)) { error.value = '數量必須大於 0'; return }
  if (qtyNum.value > props.move.available) {
    error.value = `最多只能${title.value} ${fmtQty(props.move.available)} 件`
    return
  }
  idemKey.value = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`
  step.value = 'confirm'
}

async function submit() {
  if (submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    const res = await shelf.moveStock({
      sku: props.move.sku,
      sourceLocationId: props.move.sourceId,
      destLocationId: target.value.id,
      qty: qtyNum.value,
    }, idemKey.value)
    showToast(`已完成 ${res.picking}：${props.move.sku} × ${fmtQty(res.qty)} → ${res.dest.name}`, 'success')
    emit('done', res)
  } catch (err) {
    if (err.handledByInterceptor) return
    const data = err.response?.data || {}
    const msgs = {
      insufficient_qty: `可${title.value}數量不足（目前只有 ${fmtQty(data.available)} 件），請重新整理後再試`,
      same_location: '來源和目標不能是同一個位置',
      location_outside_warehouse: '目標位置不在同一個倉庫',
      shelf_move_type_missing: '此倉庫尚未設定「貨架移動」作業類型，請聯絡主管',
      busy: '其他同事正在移動這個商品，請稍後再試',
      move_failed: `移動失敗：${data.message || ''}`,
    }
    error.value = msgs[data.error] || data.error || '移動失敗，請重試'
    // 业务错误回到表单改数量 / 位置；换新 key，修改后的提交算新的一次
    if (data.error !== 'busy') step.value = 'form'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="move" class="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4" @click.self="emit('close')">
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" role="dialog" :aria-label="title">
      <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div class="min-w-0">
          <div class="text-lg font-bold text-gray-800">{{ title }}</div>
          <div class="text-sm text-gray-500 truncate">
            <span class="font-mono">{{ move.sku }}</span><span v-if="move.name"> · {{ move.name }}</span>
          </div>
        </div>
        <button type="button" class="g-icon-btn" aria-label="關閉" @click="emit('close')">✕</button>
      </div>

      <!-- 表单 -->
      <form v-if="step === 'form'" class="px-5 py-4 space-y-4" @submit.prevent="toConfirm">
        <div class="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
          <span class="text-gray-500">來源</span>
          <span class="font-semibold text-gray-800">{{ move.sourceLabel }} · 可{{ title }} {{ fmtQty(move.available) }} 件</span>
        </div>

        <div>
          <label class="block text-sm text-gray-500 mb-1" for="shelf-move-target">目標位置（掃碼或輸入）</label>
          <input
            id="shelf-move-target"
            ref="targetInput"
            v-model="targetQuery"
            type="text"
            class="g-input w-full"
            placeholder="例如 HSD4-T1-1 或 T1-1"
            autocomplete="off"
            @input="onTargetInput"
            @keydown.enter.prevent="searchTargets(targetQuery.trim())"
          />
          <div v-if="!target" class="mt-2 max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100">
            <button
              v-for="loc in candidates"
              :key="loc.id"
              type="button"
              class="w-full text-left px-3 py-2 hover:bg-[#EEF4F2] flex items-center justify-between gap-2"
              @click="pickTarget(loc)"
            >
              <span class="text-gray-800">{{ loc.full_name }}</span>
              <span v-if="loc.barcode" class="font-mono text-xs text-gray-400">{{ loc.barcode }}</span>
            </button>
            <div v-if="!searching && !candidates.length" class="px-3 py-3 text-sm text-gray-400">
              找不到位置。板／格子請先在 Odoo「庫存 → 配置 → 地點」建立。
            </div>
          </div>
          <div v-else class="mt-2 text-sm text-emerald-700">✓ 已選：{{ target.full_name }}</div>
        </div>

        <div>
          <label class="block text-sm text-gray-500 mb-1" for="shelf-move-qty">數量</label>
          <input id="shelf-move-qty" v-model="qty" type="number" min="0" step="any" class="g-input w-40" />
          <span class="text-sm text-gray-400 ml-2">最多 {{ fmtQty(move.available) }} 件</span>
        </div>

        <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

        <div class="flex justify-end gap-2 pt-1">
          <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-5" @click="emit('close')">取消</button>
          <button type="submit" class="g-btn g-btn-teal !px-6">下一步</button>
        </div>
      </form>

      <!-- 确认 -->
      <div v-else class="px-5 py-5 space-y-4">
        <p class="text-base text-gray-800 leading-relaxed">
          由 <b>{{ move.sourceLabel }}</b> {{ title }} <b class="text-[#2F6B5F]">{{ fmtQty(qtyNum) }} 件</b>
          到 <b>{{ target.full_name }}</b>？
        </p>
        <p class="text-sm text-gray-500">{{ move.sourceLabel }} 將剩 {{ fmtQty(left) }} 件可轉。系統會自動開一張「貨架移動」單並完成。</p>
        <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-5" :disabled="submitting" @click="step = 'form'">否，返回</button>
          <button type="button" class="g-btn g-btn-teal !px-6" :disabled="submitting" @click="submit">
            {{ submitting ? '處理中…' : '是，確認' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
