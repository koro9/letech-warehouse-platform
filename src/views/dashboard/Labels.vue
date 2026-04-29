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
function print() { showToast('打印中...', 'success') }
function configFile() { showToast('配置文件', 'success') }
</script>

<template>
  <div class="p-10">
    <div class="flex items-center gap-4">
      <input v-model="barcode" class="g-input" style="width:340px;height:46px;" placeholder="扫描商品条码" />

      <div class="g-spinner">
        <input v-model.number="qty" type="number" min="1" />
        <div class="sp-btns">
          <button @click="spin(1)">▲</button>
          <button @click="spin(-1)">▼</button>
        </div>
      </div>

      <div class="ml-auto flex gap-2.5">
        <button class="g-btn g-btn-teal" @click="reset">重制</button>
        <button class="g-btn g-btn-pink" @click="print">打印</button>
        <button class="g-btn g-btn-teal" @click="configFile">配置文件</button>
      </div>
    </div>
  </div>
</template>
