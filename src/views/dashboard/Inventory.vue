<script setup>
/**
 * 库存对比 — 复刻 demo s1-inventory
 * 上传 file + 对比按钮 + 历史表格
 */
import { ref } from 'vue'
import { showToast } from '@/composables/useToast'

const history = ref([
  { start: '2026-01-20 11:19', end: '2026-01-20 12:00' },
])

function compare() { showToast('庫存對比中...', 'success') }
function download() { showToast('下載中', 'success') }
</script>

<template>
  <div class="p-10">
    <div class="grid gap-8 items-start" style="grid-template-columns:1fr 1.2fr;">
      <!-- 左：上传 -->
      <div>
        <button class="g-btn g-btn-teal w-full" style="padding:14px;margin-bottom:18px;" @click="compare">
          库存对比
        </button>
        <div class="g-card p-7 text-center text-gray-400 cursor-pointer text-sm border-2 border-dashed border-gray-300">
          <div class="text-2xl mb-1.5">📤</div>
          Upload file
        </div>
      </div>

      <!-- 右：历史 -->
      <div class="g-card overflow-hidden">
        <table class="g-table">
          <thead>
            <tr>
              <th>操作时间</th>
              <th>完成时间</th>
              <th class="text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in history" :key="h.start">
              <td>{{ h.start }}</td>
              <td class="text-gray-500">{{ h.end }}</td>
              <td class="text-center">
                <button class="g-btn g-btn-teal" style="padding:5px 20px;font-size:12px" @click="download">下载</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
