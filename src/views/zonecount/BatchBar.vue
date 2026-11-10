<script setup>
/**
 * 區域盤點各页顶部：标题 + 当前批次选择 + 新批次
 * 批次 = 一次盘点活动（如「2027 年底盤點」，一个仓）。选中的批次写进 URL ?batch=
 */
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { zonecount } from '@/api'
import { showToast } from '@/composables/useToast'
import { batches, batchId, batchesLoaded, currentBatch, errText, loadBatches } from './zoneShared'

defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
})

const route = useRoute()
const router = useRouter()
const creating = ref(false)
const newName = ref('')
const saving = ref(false)

onMounted(async () => {
  try {
    await loadBatches(route.query.batch)
  } catch (err) {
    if (!err.handledByInterceptor) showToast('載入盤點批次失敗', 'error')
  }
})

// 批次写进 URL（保留其他查询条件）
watch(batchId, (id) => {
  if (!id || String(route.query.batch || '') === String(id)) return
  router.replace({ query: { ...route.query, batch: String(id), page: undefined } })
})

function pick(e) {
  batchId.value = Number(e.target.value) || null
}

function startCreate() {
  newName.value = `${new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0)} 年底盤點`
  creating.value = true
}

async function create() {
  const name = newName.value.trim()
  if (!name) return
  saving.value = true
  try {
    const r = await zonecount.createBatch({ name })
    await loadBatches(r.batch.id)
    creating.value = false
    showToast(`已建立批次「${name}」`, 'success')
  } catch (err) {
    if (!err.handledByInterceptor) showToast(errText(err, '建立批次失敗'), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mb-4 lg:mb-5">
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div class="min-w-0">
        <h2 class="text-lg sm:text-xl lg:text-2xl font-bold text-gray-800">{{ title }}</h2>
        <p v-if="subtitle" class="text-sm text-gray-500 mt-1 leading-relaxed">{{ subtitle }}</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <label v-if="batches.length" class="flex items-center gap-2 text-sm text-gray-500">
          批次
          <select :value="batchId" class="border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700" @change="pick">
            <option v-for="b in batches" :key="b.id" :value="b.id">
              {{ b.name }} · {{ b.warehouse.code }}{{ b.state === 'closed' ? '（已結束）' : '' }}
            </option>
          </select>
        </label>
        <span v-if="currentBatch" class="text-xs font-bold rounded-lg px-3 py-1"
              :class="currentBatch.state === 'open' ? 'bg-[#EAF4F1] text-[#2F6B5F]' : 'bg-gray-100 text-gray-500'">
          {{ currentBatch.state === 'open' ? '進行中' : '已結束' }}
        </span>
        <button v-if="!creating" type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-4 !py-1.5 text-sm"
                @click="startCreate">＋ 新批次</button>
      </div>
    </div>
    <form v-if="creating" class="mt-3 flex gap-2 flex-wrap items-center bg-white border border-gray-200 rounded-xl p-3"
          @submit.prevent="create">
      <span class="text-sm text-gray-500">新批次名稱</span>
      <input v-model="newName" class="g-input flex-1 min-w-[200px]" maxlength="60" />
      <span class="text-xs text-gray-400">倉庫：HSD4（跟登入者所在倉）</span>
      <button type="submit" class="g-btn g-btn-teal !px-5" :disabled="saving || !newName.trim()">建立</button>
      <button type="button" class="g-btn bg-white border border-gray-200 text-gray-600 !px-4" @click="creating = false">取消</button>
    </form>
    <div v-if="batchesLoaded && !batches.length && !creating"
         class="mt-3 rounded-xl border border-dashed border-gray-300 bg-white px-5 py-6 text-center text-gray-500">
      還沒有盤點批次。先按右上「＋ 新批次」建立（例如「2027 年底盤點」），再到「任務單」把貨架分給員工。
    </div>
  </div>
</template>
