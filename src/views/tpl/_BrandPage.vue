<script setup>
/**
 * 4 个 3PL 品牌 PDF 解析页的共用骨架（demo s2-yummy / s2-anymall / s2-hellobear / s2-homey）
 *
 * Props.brand：'yummy' | 'anymall' | 'hellobear' | 'homey'
 *   → 从 _data.js 读取 BRAND_PAGE_CONFIG[brand] 决定 UI 变体
 *   → 解析后从 BRAND_PARSED[brand] 渲染结果（mock）
 */
import { ref } from 'vue'
import { showToast } from '@/composables/useToast'
import { BRAND_PARSED, BRAND_PAGE_CONFIG } from './_data'

const props = defineProps({
  brand: { type: String, required: true },
})

const config = BRAND_PAGE_CONFIG[props.brand]

const fileInputEl = ref(null)
const parsing = ref(false)
const result = ref(null)

function parsePDF() {
  if (!fileInputEl.value?.files?.length) {
    showToast('⚠️ 請先上傳 PDF 檔案', 'warning')
    return
  }
  parsing.value = true
  result.value = null
  // demo 这里是模拟 1.2 秒延迟，按 mock 数据返回
  setTimeout(() => {
    result.value = BRAND_PARSED[props.brand]
    parsing.value = false
    showToast(`✅ 解析完成！${result.value.parsed} 筆`, 'success')
  }, 1200)
}

function actLabel(act) {
  // print/nodata/noprint/normal — 按 demo 同义
  return { print: '🖨️ 打印', nodata: '無資料', noprint: '無需打印', normal: '普通Label' }[act] || act
}

function tagClass(tag) {
  if (tag === '蟲蟲Label')   return 's2-tag-bug'
  if (tag === 'Repack Label') return 's2-tag-repack'
  return 's2-tag-normal'
}
</script>

<template>
  <div class="p-10">
    <!-- 标题 -->
    <div class="flex items-center gap-3 mb-1.5">
      <span class="text-3xl">{{ config.icon }}</span>
      <h1 class="text-2xl font-bold">{{ config.title }}</h1>
    </div>
    <p class="text-slate-400 text-xs mb-7">{{ config.subtitle }}</p>

    <!-- 上传区 + 可选数据库面板 -->
    <div
      class="grid gap-7 items-start"
      :style="config.hasDb ? 'grid-template-columns:1fr 320px;' : ''"
    >
      <div class="s2-section" :style="!config.hasDb ? 'max-width:900px;' : ''">
        <div class="mb-4">
          <input ref="fileInputEl" type="file" accept=".pdf" class="text-xs" />
        </div>
        <button
          class="g-btn"
          :class="config.btnClass"
          style="padding:12px 32px;font-size:15px;"
          :disabled="parsing"
          @click="parsePDF"
        >
          <span v-if="parsing">⏳ 解析中...</span>
          <span v-else>📄 開始解析 PDF</span>
        </button>
      </div>

      <div v-if="config.hasDb" class="s2-db-panel">
        <div class="text-[15px] font-bold mb-4">⚙️ 3PL 主資料庫</div>
        <div class="s2-file-info">
          <div class="text-xs font-bold text-emerald-700">✅ data.xlsx · 8,084 筆</div>
        </div>
        <input type="file" class="text-xs mb-3.5" />
        <button class="g-btn g-btn-blue w-full" style="padding:12px;" @click="showToast('已更新', 'success')">
          確認更新
        </button>
      </div>
    </div>

    <!-- 解析结果 -->
    <div v-if="result" class="s2-result">
      <div class="s2-summary-grid">
        <div class="s2-summary-card">
          <h3 class="text-base font-bold mb-3.5">📊 處理摘要</h3>
          <div class="text-sm">
            有效解析: <strong class="text-lg">{{ result.parsed }}</strong>
          </div>
        </div>
        <div class="s2-summary-card">
          <h3 class="text-base font-bold mb-3.5">⚠️ 重複檢測</h3>
          <div v-if="result.dups.length">
            <div class="s2-dup-alert">
              <strong style="color:#C53030;">❗ {{ result.dups.length }} 筆重複！</strong>
            </div>
            <table class="s2-dup-table">
              <thead>
                <tr><th>商品編號</th><th>次數</th><th>頁數</th></tr>
              </thead>
              <tbody>
                <tr v-for="dp in result.dups" :key="dp.id">
                  <td class="font-mono font-semibold">{{ dp.id }}</td>
                  <td class="text-center">{{ dp.count }}</td>
                  <td class="text-gray-600">{{ dp.pages }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="s2-dup-ok">✅ 未發現重複</div>
        </div>
      </div>

      <div class="g-card overflow-hidden">
        <table class="s2-label-table">
          <thead>
            <tr>
              <th>#</th>
              <th>商品編號</th>
              <th>商品名稱</th>
              <th>條碼</th>
              <th v-if="config.showDate">日期</th>
              <th class="text-center">數量</th>
              <th v-if="config.showTag" class="text-center">標籤</th>
              <th class="text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, i) in result.items" :key="it.sku" :class="it.hl ? 'hl-yellow' : ''">
              <td class="text-center text-gray-400">{{ i + 1 }}</td>
              <td class="font-bold">{{ it.sku }}</td>
              <td>{{ it.name }}</td>
              <td class="font-mono text-xs text-gray-600">{{ it.bc }}</td>
              <td v-if="config.showDate" class="text-xs text-gray-600">{{ it.date || '' }}</td>
              <td class="text-center font-bold">{{ it.qty }}</td>
              <td v-if="config.showTag" class="text-center">
                <span :class="tagClass(it.tag)">{{ it.tag }}</span>
              </td>
              <td class="text-center">
                <button v-if="it.act === 'print'"  class="s2-act-print"  @click="showToast('🖨️ 打印中', 'success')">{{ actLabel(it.act) }}</button>
                <span  v-else-if="it.act === 'nodata'" class="s2-act-nodata">{{ actLabel(it.act) }}</span>
                <span  v-else-if="it.act === 'noprint'" class="s2-act-noprint">{{ actLabel(it.act) }}</span>
                <span  v-else class="s2-act-normal">{{ actLabel(it.act) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
