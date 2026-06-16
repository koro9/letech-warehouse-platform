<!--
  BarcodeScanner — 全屏相機掃碼組件(WMS 通用)

  用法:
    <BarcodeScanner v-if="scannerOpen" @detected="onCode" @close="closeScanner" />
    onCode(code) { bcQuery.value = code; closeScanner(); scanBC() }

  能力:
    - 調起設備相機(優先後置 environment),顯示取景 + 聚焦框 + 掃描線
    - 用 @zxing 解碼零售條碼(EAN-13/8、UPC-A/E、Code128/39、ITF),命中即 emit
    - 命中後震動回饋 + 自動停止相機,emit('detected', code)
    - 錯誤兜底:非 HTTPS / 權限被拒 / 無相機 → 明確提示 + 「改為手動輸入」

  注意:瀏覽器相機 API 只在 Secure Context(HTTPS 或 localhost)可用。
-->
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { DecodeHintType, BarcodeFormat } from '@zxing/library'

const emit = defineEmits(['detected', 'close'])

const videoEl = ref(null)
const errMsg = ref('')
let reader = null
let controls = null
let done = false   // 命中或關閉後只處理一次

// 只認零售/物流常見一維碼,縮小範圍提速提準
const hints = new Map()
hints.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
])

function onHit(text) {
  if (done) return
  done = true
  try { navigator.vibrate && navigator.vibrate(120) } catch (e) { /* noop */ }
  stop()
  emit('detected', String(text || '').trim())
}

function stop() {
  try { controls && controls.stop() } catch (e) { /* noop */ }
  controls = null
  // 保險:停掉所有 video track,釋放相機
  try {
    const s = videoEl.value && videoEl.value.srcObject
    if (s && s.getTracks) s.getTracks().forEach(t => t.stop())
  } catch (e) { /* noop */ }
}

async function start() {
  if (!window.isSecureContext) {
    errMsg.value = '相機需要 HTTPS 連線。請改用 https:// 的網址開啟本系統。'
    return
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    errMsg.value = '此瀏覽器不支援相機掃碼,請改用手動輸入。'
    return
  }
  try {
    reader = new BrowserMultiFormatReader(hints)
    controls = await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } } },
      videoEl.value,
      (result) => { if (result) onHit(result.getText()) },
    )
  } catch (e) {
    const name = e && e.name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      errMsg.value = '相機權限被拒絕,請在瀏覽器允許使用相機後重試。'
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      errMsg.value = '找不到可用的相機裝置。'
    } else {
      errMsg.value = '相機啟動失敗:' + (e && e.message ? e.message : '未知錯誤')
    }
  }
}

onMounted(start)
onBeforeUnmount(() => { done = true; stop() })
</script>

<template>
  <div class="fixed inset-0 z-[300] flex flex-col bg-black">
    <!-- 頂部 -->
    <div class="flex items-center px-4 py-3 text-white" style="background:rgba(0,0,0,.85);">
      <button class="p-2 bg-transparent border-0 text-white text-2xl cursor-pointer leading-none"
              @click="emit('close')">✕</button>
      <div class="flex-1 text-center font-bold">掃描條碼</div>
      <div class="w-10"></div>
    </div>

    <!-- 取景區 -->
    <div class="relative flex-1 overflow-hidden">
      <video v-show="!errMsg" ref="videoEl"
             class="absolute inset-0 w-full h-full object-cover"
             autoplay playsinline muted></video>

      <!-- 聚焦框(僅在相機正常時顯示)-->
      <div v-if="!errMsg" class="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div class="scan-box relative" style="width:78%;max-width:520px;aspect-ratio:5/3;">
          <span class="corner tl"></span><span class="corner tr"></span>
          <span class="corner bl"></span><span class="corner br"></span>
          <div class="scan-line"></div>
        </div>
      </div>

      <!-- 提示 / 錯誤 -->
      <div v-if="!errMsg"
           class="absolute left-0 right-0 bottom-8 text-center text-white/85 text-sm px-6">
        將條碼對準框內,自動識別
      </div>
      <div v-else
           class="absolute inset-0 flex flex-col items-center justify-center text-center text-white px-8">
        <div class="text-4xl mb-3">📷</div>
        <div class="text-sm leading-relaxed">{{ errMsg }}</div>
        <a class="text-blue-300 cursor-pointer underline mt-4" @click="emit('close')">改為手動輸入</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scan-box { box-shadow: 0 0 0 9999px rgba(0,0,0,.45); border-radius: 12px; }
.corner { position: absolute; width: 26px; height: 26px; border: 3px solid #f97316; }
.corner.tl { top: -2px; left: -2px;  border-right: 0; border-bottom: 0; border-top-left-radius: 10px; }
.corner.tr { top: -2px; right: -2px; border-left: 0;  border-bottom: 0; border-top-right-radius: 10px; }
.corner.bl { bottom: -2px; left: -2px;  border-right: 0; border-top: 0; border-bottom-left-radius: 10px; }
.corner.br { bottom: -2px; right: -2px; border-left: 0;  border-top: 0; border-bottom-right-radius: 10px; }
.scan-line {
  position: absolute; left: 6%; right: 6%; height: 2px;
  background: linear-gradient(90deg, transparent, #f97316, transparent);
  box-shadow: 0 0 8px #f97316;
  animation: scanmove 2s ease-in-out infinite;
}
@keyframes scanmove {
  0%   { top: 8%;  opacity: .4; }
  50%  { top: 90%; opacity: 1; }
  100% { top: 8%;  opacity: .4; }
}
</style>
