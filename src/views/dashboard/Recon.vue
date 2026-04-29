<script setup>
/**
 * 对账 — 复刻 demo s1-recon
 * 跟 Inventory 同形：上传 + 历史表
 */
import { ref } from 'vue'
import { showToast } from '@/composables/useToast'

const history = ref([
  { start: '2025-10-28 10:26', end: '2025-10-28 10:37' },
])

function recon() { showToast('對賬中...', 'success') }
function download() { showToast('下載中', 'success') }
</script>

<template>
  <div class="p-10">
    <div class="grid gap-8 items-start" style="grid-template-columns:1fr 1.2fr;">
      <div>
        <button class="g-btn g-btn-teal w-full" style="padding:14px;margin-bottom:18px;" @click="recon">
          对账单
        </button>
        <div class="g-card p-7 text-center text-gray-400 cursor-pointer text-sm border-2 border-dashed border-gray-300">
          <div class="text-2xl mb-1.5">📤</div>
          Upload file
        </div>
      </div>

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
