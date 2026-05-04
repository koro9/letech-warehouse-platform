<script setup>
/**
 * 面单 — 复刻 demo s1-shipping
 * 双栏（今日 / 明日）面单文件列表，支持下载
 *
 * 注：demo 里有 🔄 按钮，但只是 toast 装饰；实际面单一旦生成就不变（PDF 文件），
 *    没有"被别人改了"的并发场景，所以不接 usePageRefresh 也不放刷新按钮
 *
 * 响应式：手机 1 列堆叠（先今日后明日）；md+ 2 列并排
 */
import { ref } from 'vue'
import { showToast } from '@/composables/useToast'

const todayFiles = ref([
  { n: '20260420120949.pdf', o: 1,  t: '2026-04-20 12:08' },
  { n: '20260420114756.pdf', o: 6,  t: '2026-04-20 11:46' },
  { n: '20260420103524.pdf', o: 13, t: '2026-04-20 10:34' },
])
const tomorrowFiles = ref([
  { n: '20260420101911.pdf', o: 34,  t: '2026-04-20 10:17' },
  { n: '20260420100024.pdf', o: 717, t: '2026-04-20 09:56' },
])

function download() { showToast('下載中', 'success') }
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
      <!-- 今日 -->
      <section>
        <div class="flex items-center gap-3 mb-4 sm:mb-5">
          <button class="g-btn g-btn-teal" style="padding: 10px 36px;">今日</button>
        </div>
        <!-- 桌面：表格 -->
        <div class="hidden md:block g-card overflow-hidden">
          <table class="g-table">
            <thead>
              <tr>
                <th>文件名</th>
                <th class="text-center">訂單</th>
                <th>時間</th>
                <th class="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in todayFiles" :key="r.n">
                <td class="font-mono text-xs">{{ r.n }}</td>
                <td class="text-center font-semibold">{{ r.o }}</td>
                <td class="text-xs text-gray-500">{{ r.t }}</td>
                <td class="text-center">
                  <button class="g-btn g-btn-teal" style="padding:5px 20px;font-size:12px" @click="download">下載</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 手机：卡片列表 -->
        <div class="md:hidden space-y-2">
          <div v-for="r in todayFiles" :key="r.n" class="g-card p-3">
            <div class="flex items-start justify-between gap-3 mb-2">
              <div class="flex-1 min-w-0">
                <div class="font-mono text-xs text-gray-700 break-all">{{ r.n }}</div>
                <div class="text-xs text-gray-400 mt-1">{{ r.t }}</div>
              </div>
              <button class="g-btn g-btn-teal flex-shrink-0" style="padding:6px 16px;font-size:12px" @click="download">下載</button>
            </div>
            <div class="text-xs text-gray-500">訂單數：<span class="font-semibold text-gray-800">{{ r.o }}</span></div>
          </div>
        </div>
      </section>

      <!-- 明日 -->
      <section>
        <div class="flex items-center gap-3 mb-4 sm:mb-5">
          <button class="g-btn g-btn-teal" style="padding: 10px 36px;">明日</button>
        </div>
        <!-- 桌面：表格 -->
        <div class="hidden md:block g-card overflow-hidden">
          <table class="g-table">
            <thead>
              <tr>
                <th>文件名</th>
                <th class="text-center">訂單</th>
                <th>時間</th>
                <th class="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in tomorrowFiles" :key="r.n">
                <td class="font-mono text-xs">{{ r.n }}</td>
                <td class="text-center font-semibold">{{ r.o }}</td>
                <td class="text-xs text-gray-500">{{ r.t }}</td>
                <td class="text-center">
                  <button class="g-btn g-btn-teal" style="padding:5px 20px;font-size:12px" @click="download">下載</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 手机：卡片列表 -->
        <div class="md:hidden space-y-2">
          <div v-for="r in tomorrowFiles" :key="r.n" class="g-card p-3">
            <div class="flex items-start justify-between gap-3 mb-2">
              <div class="flex-1 min-w-0">
                <div class="font-mono text-xs text-gray-700 break-all">{{ r.n }}</div>
                <div class="text-xs text-gray-400 mt-1">{{ r.t }}</div>
              </div>
              <button class="g-btn g-btn-teal flex-shrink-0" style="padding:6px 16px;font-size:12px" @click="download">下載</button>
            </div>
            <div class="text-xs text-gray-500">訂單數：<span class="font-semibold text-gray-800">{{ r.o }}</span></div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
