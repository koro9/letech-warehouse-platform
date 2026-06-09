<script setup>
import { ref, computed, onActivated, onDeactivated, watch } from 'vue'
import { useRouter } from 'vue-router'
import { po as poApi } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { showToast } from '@/composables/useToast'
import { usePageRefresh } from '@/composables/usePageRefresh'
import RefreshButton from '@/components/RefreshButton.vue'

const auth = useAuthStore()
const router = useRouter()

const LS_KEY = 'wh_po_dashboard_local'

const tab = ref('pending')
const loading = ref(false)
const poList = ref([])

// localStorage 暫存：{ [poName]: { description: '', actualDate: '' } }
const localData = ref(loadLocalData())

function loadLocalData() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}')
  } catch { return {} }
}

function saveLocalData() {
  localStorage.setItem(LS_KEY, JSON.stringify(localData.value))
}

function getLocal(poName) {
  if (!localData.value[poName]) {
    localData.value[poName] = { description: '', actualDate: '' }
  }
  return localData.value[poName]
}

// 隱藏 supplier：parttime 用戶睇唔到
const hideSupplier = computed(() => auth.isParttime)

async function fetchList() {
  loading.value = true
  try {
    const data = await poApi.listPOs(tab.value)
    poList.value = data.pos || []
  } catch (err) {
    if (!err.handledByInterceptor) {
      showToast('載入 PO 列表失敗', 'error')
    }
  } finally {
    loading.value = false
  }
}

watch(tab, () => fetchList())

// KeepAlive support
onActivated(() => fetchList())

// 點擊 PO 行跳去 counting 頁
function goToCounting(po) {
  router.push({ name: 'receiving-counting', query: { po: po.po_name } })
}

// 點擊跳去 allocation 頁（必須先填形容）
function goToAllocation(po) {
  const desc = (getLocal(po.po_name).description || '').trim()
  if (!desc) {
    showToast('請先填寫「形容」再進入分配', 'warning')
    return
  }
  router.push({ name: 'receiving-alloc', query: { po: po.po_name } })
}

// Refresh
const { isRefreshing, doRefresh } = usePageRefresh(fetchList)

// 燈號 class
function statusClass(status) {
  if (status === 'green') return 'bg-emerald-400'
  if (status === 'orange') return 'bg-amber-400'
  return 'bg-red-400'
}

function statusText(status) {
  if (status === 'green') return '已點齊'
  if (status === 'orange') return '點貨中'
  return '未開始'
}

// 進度文字
function progressText(po) {
  return `${po.counted_lines} / ${po.line_count}`
}
</script>

<template>
  <div class="space-y-4">
    <!-- 頂部標題 + 刷新 -->
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-gray-800">PO 收貨總覽</h2>
      <RefreshButton :refreshing="isRefreshing" @click="doRefresh" />
    </div>

    <!-- Tab 切換 -->
    <div class="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
      <button
        v-for="t in [{ key: 'pending', label: '待收貨' }, { key: 'completed', label: '已完成' }]"
        :key="t.key"
        class="px-4 py-1.5 rounded-md text-sm font-medium transition-colors"
        :class="tab === t.key
          ? 'bg-white text-teal-700 shadow-sm'
          : 'text-gray-500 hover:text-gray-700'"
        @click="tab = t.key"
      >
        {{ t.label }}
        <span
          v-if="!loading"
          class="ml-1 text-xs opacity-60"
        >({{ t.key === tab ? poList.length : '…' }})</span>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading && poList.length === 0" class="text-center py-12 text-gray-400">
      載入中…
    </div>

    <!-- 空狀態 -->
    <div v-else-if="poList.length === 0" class="text-center py-12 text-gray-400">
      <div class="text-3xl mb-2">{{ tab === 'pending' ? '📦' : '✅' }}</div>
      <p>{{ tab === 'pending' ? '暫無待收 PO' : '暫無已完成 PO' }}</p>
    </div>

    <!-- PO 列表 -->
    <div v-else class="g-card overflow-x-auto">
      <table class="g-table w-full">
        <thead>
          <tr>
            <th class="text-left whitespace-nowrap">PO No.</th>
            <th v-if="!hideSupplier" class="text-left">Supplier</th>
            <th class="text-left" style="min-width:100px">形容</th>
            <th class="text-left whitespace-nowrap">ETA</th>
            <th class="text-left whitespace-nowrap">收貨日期</th>
            <th class="text-center whitespace-nowrap">進度</th>
            <th class="text-center whitespace-nowrap">狀態</th>
            <th class="text-right whitespace-nowrap">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="po in poList"
            :key="po.po_id"
            class="cursor-pointer"
            @click="goToCounting(po)"
          >
            <!-- PO No -->
            <td class="font-mono text-sm font-semibold text-teal-700 whitespace-nowrap">
              {{ po.po_name }}
            </td>

            <!-- Supplier -->
            <td v-if="!hideSupplier" class="text-sm max-w-[180px] truncate">
              {{ po.partner_name || '—' }}
            </td>

            <!-- 形容 (editable, localStorage) -->
            <td @click.stop>
              <input
                v-model="getLocal(po.po_name).description"
                type="text"
                class="g-input w-full text-xs py-1 px-2"
                placeholder="備註…"
                @input="saveLocalData()"
              />
            </td>

            <!-- ETA -->
            <td class="text-sm whitespace-nowrap">
              {{ po.date_planned || '—' }}
            </td>

            <!-- 實際收貨時間 (editable, localStorage) -->
            <td @click.stop>
              <input
                v-model="getLocal(po.po_name).actualDate"
                type="date"
                class="g-input text-sm py-1 px-2"
                @input="saveLocalData()"
              />
            </td>

            <!-- 進度 -->
            <td class="text-center text-xs text-gray-500 whitespace-nowrap">
              {{ progressText(po) }}
            </td>

            <!-- 燈號 -->
            <td class="text-center whitespace-nowrap">
              <span
                class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white"
                :class="statusClass(po.counting_status)"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-white/50"></span>
                {{ statusText(po.counting_status) }}
              </span>
            </td>

            <!-- 操作 -->
            <td class="text-right whitespace-nowrap" @click.stop>
              <button
                class="text-xs text-teal-600 hover:text-teal-800 font-medium mr-2"
                @click="goToCounting(po)"
              >點貨</button>
              <button
                class="text-xs text-blue-600 hover:text-blue-800 font-medium"
                @click="goToAllocation(po)"
              >分配</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
