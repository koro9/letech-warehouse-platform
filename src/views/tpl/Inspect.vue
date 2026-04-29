<script setup>
/**
 * 3PL 货品检测中心 — 复刻 demo s2-inspect
 *
 * 三态 SPA：
 *   brands → 选品牌 (Yummy/Anymall/HelloBear/Homey)
 *   lobby  → 任务大厅 (建立新任务 PDF 上传 / 加入协作任务 5 位码)
 *   work   → 检测工作台 (任务码 + 进度 + 扫描表)
 *
 * 扫码匹配规则（demo 原样）：
 *   1. 完全匹配 barcode
 *   2. 否则 endsWith barcode (如果只有一条匹配项)
 *   3. 否则匹配 sku
 *   4. 否则报错
 */
import { computed, nextTick, ref } from 'vue'
import { showToast } from '@/composables/useToast'
import { INSPECT_BRANDS } from './_data'

const view = ref('brands')   // 'brands' | 'lobby' | 'work'
const curBrand = ref(null)
const taskCode = ref(null)
const scanned = ref({})       // { `${brand}_${sku}`: count }

const joinCode = ref('')
const scanInput = ref('')
const scanInputEl = ref(null)
const fileInputEl = ref(null)

const brand = computed(() => curBrand.value ? INSPECT_BRANDS[curBrand.value] : null)
const totalScanned = computed(() => {
  if (!brand.value) return 0
  return brand.value.items.reduce((s, it) => s + (scanned.value[`${curBrand.value}_${it.sku}`] || 0), 0)
})

function genCode() {
  return String(Math.floor(10000 + Math.random() * 90000))
}

function openLobby(key) {
  curBrand.value = key
  view.value = 'lobby'
}

function backToBrands() {
  view.value = 'brands'
  curBrand.value = null
}

function createTask() {
  if (!fileInputEl.value?.files?.length) {
    showToast('⚠️ 請先上傳 PDF', 'warning')
    return
  }
  taskCode.value = genCode()
  view.value = 'work'
  showToast(`✅ 任務已建立！任務碼: ${taskCode.value}`, 'success')
  focusScanInput()
}

function joinTask() {
  if (!joinCode.value || joinCode.value.length < 5) {
    showToast('請輸入5位數任務碼', 'warning')
    return
  }
  taskCode.value = joinCode.value
  view.value = 'work'
  showToast(`✅ 已加入任務 ${taskCode.value}`, 'success')
  focusScanInput()
}

function leaveTask() {
  view.value = 'lobby'
}

function copyCode() {
  if (navigator.clipboard && taskCode.value) {
    navigator.clipboard.writeText(taskCode.value)
      .then(() => showToast(`✅ 已複製: ${taskCode.value}`, 'success'))
      .catch(() => showToast(`任務碼: ${taskCode.value}`, 'success'))
  } else {
    showToast(`任務碼: ${taskCode.value}`, 'success')
  }
}

function changeCode() {
  taskCode.value = null
  view.value = 'lobby'
}

function focusScanInput() {
  nextTick(() => scanInputEl.value?.focus())
}

function onScan() {
  const v = scanInput.value.trim()
  if (!v || !brand.value) return
  const items = brand.value.items
  let foundIdx = items.findIndex(it => it.bc === v)
  if (foundIdx === -1) {
    const matches = items
      .map((it, i) => ({ i, bc: it.bc }))
      .filter(x => x.bc.endsWith(v))
    if (matches.length === 1) foundIdx = matches[0].i
  }
  if (foundIdx === -1) foundIdx = items.findIndex(it => it.sku === v)

  if (foundIdx !== -1) {
    const it = items[foundIdx]
    const key = `${curBrand.value}_${it.sku}`
    scanned.value[key] = (scanned.value[key] || 0) + 1
    showToast(`✅ ${it.sku} (${scanned.value[key]}/${it.req})`, 'success')
  } else {
    showToast(`❌ 找不到: ${v}`, 'error')
  }
  scanInput.value = ''
  focusScanInput()
}

function clickBC(bc) {
  scanInput.value = bc
  focusScanInput()
}

function processItem(idx) {
  if (!brand.value) return
  const it = brand.value.items[idx]
  scanned.value[`${curBrand.value}_${it.sku}`] = it.req
  showToast(`✅ ${it.sku} 已完成`, 'success')
}

function scannedOf(sku) {
  return scanned.value[`${curBrand.value}_${sku}`] || 0
}
</script>

<template>
  <!-- ===== 状态 1：选品牌 ===== -->
  <div v-if="view === 'brands'" class="text-center py-10 px-5">
    <h1 class="text-2xl font-bold">🔍 3PL 貨品檢測中心</h1>
    <p class="text-slate-400 text-xs mt-1.5 mb-10">請選擇您負責檢測的區域</p>
    <div class="flex flex-wrap justify-center gap-6">
      <button
        v-for="(b, key) in INSPECT_BRANDS"
        :key="key"
        class="s2-brand-card"
        :style="{ background: b.color }"
        @click="openLobby(key)"
      >
        {{ b.name }}
      </button>
    </div>
  </div>

  <!-- ===== 状态 2：任务大厅 ===== -->
  <div v-else-if="view === 'lobby'" class="ins-lobby">
    <div class="flex items-center gap-4 mb-2">
      <button class="ins-back-btn" @click="backToBrands">◀ 返回</button>
      <h1 class="text-2xl font-bold">{{ brand.name }} 任務大廳</h1>
    </div>
    <div class="ins-lobby-cards">
      <!-- 建新任务 -->
      <div class="ins-lobby-card">
        <div class="text-5xl mb-3">📄</div>
        <h2 class="text-lg font-bold mb-2">建立新檢測任務</h2>
        <p class="text-slate-400 text-xs mb-5">上傳 PDF 自動生成任務碼</p>
        <input ref="fileInputEl" type="file" accept=".pdf" class="text-xs" @change="createTask" />
      </div>
      <!-- 加入协作 -->
      <div class="ins-lobby-card collab">
        <div class="text-5xl mb-3">🤝</div>
        <h2 class="text-lg font-bold text-blue-500 mb-2">加入協作任務</h2>
        <p class="text-blue-500 text-xs mb-5">輸入5位數任務碼</p>
        <input
          v-model="joinCode"
          maxlength="5"
          class="g-input w-full text-center font-bold mb-3"
          style="font-size:18px;letter-spacing:8px;"
          placeholder="例如: 49201"
        />
        <button
          class="w-full py-3.5 rounded-xl text-white font-bold text-base"
          style="background:#4f6ef7;border:none;cursor:pointer;"
          @click="joinTask"
        >
          🚀 進入任務
        </button>
      </div>
    </div>
  </div>

  <!-- ===== 状态 3：工作台 ===== -->
  <div v-else-if="view === 'work'" class="ins-work">
    <div class="flex items-center gap-4 mb-4">
      <button class="ins-back-btn" @click="leaveTask">◀ 暫時離開</button>
      <span class="text-xl font-bold">{{ brand.name }}</span>
    </div>

    <div class="ins-task-box">
      <div class="flex-1">
        <div class="text-xs font-bold text-blue-500 mb-1.5">當前任務碼</div>
        <div class="ins-task-code">{{ taskCode }}</div>
      </div>
      <div class="flex gap-2.5">
        <button class="ins-copy-btn" @click="copyCode">📋 複製</button>
        <button class="ins-change-btn" @click="changeCode">🔄 換號碼</button>
      </div>
    </div>

    <div class="ins-progress">進度：{{ totalScanned }} / {{ brand.total }}</div>

    <input
      ref="scanInputEl"
      v-model="scanInput"
      @keydown.enter="onScan"
      class="ins-scan-input"
      placeholder="掃描條碼..."
    />

    <table class="ins-tbl">
      <thead>
        <tr>
          <th>商品</th>
          <th>條碼</th>
          <th class="text-center">應檢</th>
          <th class="text-center">已掃</th>
          <th class="text-center">動作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(it, i) in brand.items"
          :key="it.sku"
          :class="scannedOf(it.sku) >= it.req ? 'ins-done' : ''"
        >
          <td>
            <div class="font-bold text-sm">
              {{ it.sku }}
              <span v-if="it.tag === 'special'" class="ins-tag-special">特殊條碼</span>
            </div>
            <div class="text-xs text-slate-500 mt-0.5">{{ it.name }}</div>
          </td>
          <td>
            <span
              class="font-mono text-sm font-bold text-blue-500 cursor-pointer"
              @click="clickBC(it.bc)"
            >{{ it.bc }}</span>
          </td>
          <td class="text-center font-bold text-[15px]">{{ it.req }}</td>
          <td
            class="text-center font-bold text-[15px]"
            :style="scannedOf(it.sku) >= it.req ? 'color:#059669' : 'color:#1e293b'"
          >
            {{ scannedOf(it.sku) }}
          </td>
          <td class="text-center">
            <button class="ins-process-btn" @click="processItem(i)">👁 處理</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
