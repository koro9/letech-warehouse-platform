<script setup>
/**
 * 标签 — 复刻 demo s1-labels
 * 扫商品条码 + 数量 spinner + 重制/打印/配置文件
 */
import { ref } from 'vue'
import { showToast } from '@/composables/useToast'

const barcode = ref('')
const qty = ref(1)

function spin(d) {
  qty.value = Math.max(1, qty.value + d)
}

function reset() { barcode.value = ''; qty.value = 1 }
function print() { showToast('列印中…', 'success') }
function configFile() { showToast('設定檔', 'success') }
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-10">
    <!-- 手机：纵向堆叠输入区 + 操作按钮组；md+ 横向并排 -->
    <div class="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
      <!-- 输入条形码 + 数量 spinner -->
      <div class="flex items-center gap-3 flex-wrap md:flex-nowrap">
        <input
          v-model="barcode"
          class="g-input flex-1 md:flex-none"
          style="height:46px; min-width:0;"
          :style="{ 'min-width': '0' }"
          placeholder="掃描商品條碼"
          autocomplete="off"
        />
        <div class="g-spinner flex-shrink-0">
          <input v-model.number="qty" type="number" min="1" />
          <div class="sp-btns">
            <button @click="spin(1)" type="button" aria-label="增加">▲</button>
            <button @click="spin(-1)" type="button" aria-label="減少">▼</button>
          </div>
        </div>
      </div>

      <!-- 按钮组：手机占满宽度均分；md+ 靠右 -->
      <div class="grid grid-cols-3 md:flex md:ml-auto gap-2 md:gap-2.5">
        <button class="g-btn g-btn-teal flex-1 md:flex-none" @click="reset">重置</button>
        <button class="g-btn g-btn-pink flex-1 md:flex-none" @click="print">列印</button>
        <button class="g-btn g-btn-teal flex-1 md:flex-none" @click="configFile">設定檔</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* g-input 在手机上要能伸缩；样式覆盖 inline width */
@media (max-width: 767px) {
  .g-input {
    width: 100% !important;
  }
}
</style>
