<script setup>
/**
 * 面单 — 复刻 demo s1-shipping
 * 双栏（今日 / 明日）面单文件列表，支持下载
 *
 * 注：demo 里有 🔄 按钮，但只是 toast 装饰；实际面单一旦生成就不变（PDF 文件），
 *    没有"被别人改了"的并发场景，所以不接 usePageRefresh 也不放刷新按钮
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
  <div class="p-10">
    <div class="grid grid-cols-2 gap-8">
      <!-- 今日 -->
      <div>
        <div class="flex items-center gap-3 mb-5">
          <button class="g-btn g-btn-teal" style="padding: 10px 36px;">今日</button>
        </div>
        <div class="g-card overflow-hidden">
          <table class="g-table">
            <thead>
              <tr>
                <th>文件名</th>
                <th class="text-center">订单</th>
                <th>时间</th>
                <th class="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in todayFiles" :key="r.n">
                <td class="font-mono text-xs">{{ r.n }}</td>
                <td class="text-center font-semibold">{{ r.o }}</td>
                <td class="text-xs text-gray-500">{{ r.t }}</td>
                <td class="text-center">
                  <button class="g-btn g-btn-teal" style="padding:5px 20px;font-size:12px" @click="download">下载</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 明日 -->
      <div>
        <div class="flex items-center gap-3 mb-5">
          <button class="g-btn g-btn-teal" style="padding: 10px 36px;">明日</button>
        </div>
        <div class="g-card overflow-hidden">
          <table class="g-table">
            <thead>
              <tr>
                <th>文件名</th>
                <th class="text-center">订单</th>
                <th>时间</th>
                <th class="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in tomorrowFiles" :key="r.n">
                <td class="font-mono text-xs">{{ r.n }}</td>
                <td class="text-center font-semibold">{{ r.o }}</td>
                <td class="text-xs text-gray-500">{{ r.t }}</td>
                <td class="text-center">
                  <button class="g-btn g-btn-teal" style="padding:5px 20px;font-size:12px" @click="download">下载</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
