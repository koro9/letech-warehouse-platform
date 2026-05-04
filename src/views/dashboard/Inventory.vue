<script setup>
/**
 * 库存对比 — 复刻 demo s1-inventory
 * 上传 file + 对比按钮 + 历史表格
 *
 * 注：本菜单当前在 AppShell 暂时隐藏，路由保留。
 */
import { ref } from 'vue'
import { showToast } from '@/composables/useToast'

const history = ref([
  { start: '2026-01-20 11:19', end: '2026-01-20 12:00' },
])

function compare() { showToast('庫存對比中…', 'success') }
function download() { showToast('下載中', 'success') }
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <!-- 手机：上传区在上、历史在下；md+ 横向并排（左 1fr 右 1.2fr） -->
    <div class="grid grid-cols-1 md:grid-cols-[1fr_1.2fr] gap-6 md:gap-8 items-start">
      <!-- 左：上传 -->
      <div>
        <button class="g-btn g-btn-teal w-full" style="padding:14px;margin-bottom:18px;" @click="compare">
          庫存對比
        </button>
        <div class="g-card p-6 sm:p-7 text-center text-gray-400 cursor-pointer text-sm border-2 border-dashed border-gray-300">
          <div class="text-2xl mb-1.5">📤</div>
          Upload file
        </div>
      </div>

      <!-- 右：历史 — 桌面表格 / 手机卡片 -->
      <div>
        <!-- 桌面表格 -->
        <div class="hidden md:block g-card overflow-hidden">
          <table class="g-table">
            <thead>
              <tr>
                <th>操作時間</th>
                <th>完成時間</th>
                <th class="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in history" :key="h.start">
                <td>{{ h.start }}</td>
                <td class="text-gray-500">{{ h.end }}</td>
                <td class="text-center">
                  <button class="g-btn g-btn-teal" style="padding:5px 20px;font-size:12px" @click="download">下載</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 手机卡片列表 -->
        <div class="md:hidden space-y-2">
          <div v-for="h in history" :key="h.start" class="g-card p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0 text-xs space-y-0.5">
                <div><span class="text-gray-400">操作：</span><span class="text-gray-700">{{ h.start }}</span></div>
                <div><span class="text-gray-400">完成：</span><span class="text-gray-700">{{ h.end }}</span></div>
              </div>
              <button class="g-btn g-btn-teal flex-shrink-0" style="padding:6px 16px;font-size:12px" @click="download">下載</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
