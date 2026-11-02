<script setup>
/**
 * 個人中心 · 安卓 App
 *
 * 显示 PDA 用安卓 App（LeTech 倉庫）最新已发布版本：版本号、更新说明、二维码、下载按钮、
 * 首次安装步骤。数据来自后端「App 版本」（Odoo 后台 WMS → App 版本 上传 / 发布）。
 *
 * 二维码内容 = 本站域名 + 下载路径，PDA 用相机或浏览器扫码即可下载 APK。
 */
import { computed, onActivated, ref } from 'vue'
import QRCode from 'qrcode'
import { app } from '@/api'

const loading = ref(false)
const error = ref('')
const info = ref(null)
const qrDataUrl = ref('')

const latest = computed(() => info.value?.latest || null)
const downloadUrl = computed(() => (latest.value ? window.location.origin + latest.value.download_url : ''))

function fmtSize(bytes) {
  if (!bytes) return '—'
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-HK', { hour12: false })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    info.value = await app.getAppVersion()
    qrDataUrl.value = downloadUrl.value
      ? await QRCode.toDataURL(downloadUrl.value, { width: 240, margin: 1 })
      : ''
  } catch (err) {
    info.value = null
    // 后端「App 版本」尚未部署时会 404，不当成故障吓人
    error.value = err.response?.status === 404 ? '版本資訊暫時無法取得' : '載入失敗，請稍後再試'
  } finally {
    loading.value = false
  }
}

// KeepAlive 下首次挂载也会触发 onActivated，所以只挂这一个
onActivated(load)
</script>

<template>
  <div class="p-4 sm:p-6 lg:px-10 lg:py-8 max-w-4xl">
    <h2 class="text-lg sm:text-xl lg:text-2xl font-bold text-gray-800 mb-4 lg:mb-5">安卓 App</h2>

    <div v-if="loading && !info" class="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500">載入中…</div>

    <div v-else-if="error" class="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500">{{ error }}</div>

    <div v-else-if="!latest" class="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-500 leading-relaxed">
      目前還沒有發布任何版本。管理員可在 Odoo「庫存 → WMS → App 版本」上傳安裝包並勾選「已發布」。
    </div>

    <template v-else>
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-5 lg:p-6 flex flex-col sm:flex-row gap-6">
        <div class="flex-1 min-w-0 space-y-3">
          <div>
            <div class="text-sm text-gray-500">LeTech 倉庫（PDA 專用）</div>
            <div class="text-2xl lg:text-3xl font-bold text-[#2F6B5F]">v{{ latest.version_name }}</div>
          </div>
          <dl class="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-gray-500">發布時間</dt><dd class="text-gray-700">{{ fmtDate(latest.published_at) }}</dd>
            <dt class="text-gray-500">檔案大小</dt><dd class="text-gray-700">{{ fmtSize(latest.size) }}</dd>
            <dt class="text-gray-500">版本號</dt><dd class="text-gray-700 font-mono">{{ latest.version_code }}</dd>
          </dl>
          <div v-if="latest.notes" class="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-line">{{ latest.notes }}</div>
          <a :href="latest.download_url" class="g-btn g-btn-teal !px-8 inline-flex" download>下載 APK</a>
        </div>
        <div class="flex flex-col items-center gap-2 sm:w-64">
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="下載二維碼" class="w-56 h-56 border border-gray-100 rounded-lg" />
          <div class="text-xs text-gray-500 text-center">用 PDA 掃描二維碼即可下載</div>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-gray-200 p-5 lg:p-6 mt-4">
        <h3 class="font-bold text-gray-800 mb-2">第一次安裝</h3>
        <ol class="list-decimal pl-5 space-y-1 text-sm text-gray-700">
          <li>用 PDA 掃描上面的二維碼，或在 PDA 瀏覽器打開本頁按「下載 APK」</li>
          <li>下載完成後點開安裝包；如提示「不允許安裝未知應用」，按「設定」開啟允許，再返回安裝</li>
          <li>打開「LeTech 倉庫」，掃描員工胸牌登入</li>
        </ol>
        <p class="text-xs text-gray-400 mt-3">之後有新版本時，App 打開會自動提示更新，不需要再來這裡下載。</p>
      </div>
    </template>
  </div>
</template>
