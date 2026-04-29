<script setup>
/**
 * 智能查询中心 — 复刻 demo s2-search
 *   左：本地资料库搜索（按 SKU/Barcode/中英文名）+ DEAR 即时库存查询
 *   右：上传专用资料库（mock 文件信息）
 *
 * 真正的 DEAR API 接入逻辑参见 智能查詢/智能查詢.html（双 CORS 代理回退、
 * 按 HKTV SD4 location 过滤、Product + ProductAvailability 两步调用）。
 * 上线时建议改为通过 Odoo 后端代理，避免在前端暴露 DEAR 凭据。
 */
import { ref } from 'vue'
import { showToast } from '@/composables/useToast'
import { LOCAL_DB } from './_data'

const localQuery  = ref('')
const localResult = ref(null)   // null = 未搜过，[] = 没结果，[...] = 有结果

const dearSku    = ref('')
const dearResult = ref(null)    // null/empty = 未查，{matched: false} = 没找到，{matched: true, ...} = 有

function localSearch() {
  const q = localQuery.value.trim().toLowerCase()
  if (!q) { showToast('請輸入關鍵字', 'warning'); return }
  localResult.value = LOCAL_DB.filter(
    r =>
      r.sku.toLowerCase().includes(q) ||
      r.barcode.includes(q) ||
      r.name.toLowerCase().includes(q),
  )
}

function fillDearAndSearch(sku) {
  dearSku.value = sku
  dearSearch()
}

function dearSearch() {
  const s = dearSku.value.trim()
  if (!s) { showToast('請輸入SKU', 'warning'); return }
  const r = LOCAL_DB.find(x => x.sku === s)
  if (!r) {
    dearResult.value = { matched: false, sku: s }
    return
  }
  // demo 里 Allocated/Available 是用 stock 比例算的 mock 值
  dearResult.value = {
    matched: true,
    sku: r.sku,
    name: r.name,
    onHand: r.stock,
    allocated: Math.floor(r.stock * 0.2),
    available: Math.ceil(r.stock * 0.8),
  }
}
</script>

<template>
  <div class="p-10">
    <div class="text-center mb-8">
      <h1 class="text-2xl font-bold">🔍 智能查詢中心</h1>
      <p class="text-slate-400 text-xs mt-1.5">先搜尋商品，再確認庫存</p>
    </div>

    <div class="grid gap-6 items-start" style="grid-template-columns:1fr 300px;">
      <!-- 左：搜索 + DEAR -->
      <div>
        <!-- 本地搜索 -->
        <div class="s2-section">
          <div class="s2-section-title">
            <span class="text-lg">📦</span> 本地資料庫搜尋
          </div>
          <div class="flex gap-3">
            <input
              v-model="localQuery"
              @keydown.enter="localSearch"
              class="g-input flex-1"
              style="height:48px;font-size:15px;"
              placeholder="輸入 SKU / Barcode / 中英文名稱..."
            />
            <button class="g-btn g-btn-blue" style="height:48px;" @click="localSearch">🔍 搜尋</button>
          </div>

          <!-- 结果 -->
          <div v-if="localResult !== null" class="mt-4">
            <div v-if="!localResult.length" class="g-card p-6 text-center text-gray-400">
              找不到「{{ localQuery }}」
            </div>
            <div v-else class="g-card overflow-hidden">
              <table class="g-table">
                <thead>
                  <tr>
                    <th>SKU</th><th>Barcode</th><th>商品名稱</th><th>品牌</th>
                    <th class="text-center">庫存</th><th class="text-center">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in localResult" :key="r.sku">
                    <td class="font-mono font-bold">{{ r.sku }}</td>
                    <td class="font-mono text-xs text-gray-600">{{ r.barcode }}</td>
                    <td>{{ r.name }}</td>
                    <td><span class="g-badge" style="background:#eff6ff;color:#1d4ed8;">{{ r.brand }}</span></td>
                    <td class="text-center font-bold">{{ r.stock }}</td>
                    <td class="text-center">
                      <button class="g-btn g-btn-emerald" style="padding:5px 14px;font-size:11px;" @click="fillDearAndSearch(r.sku)">查庫存</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- DEAR 查询 -->
        <div class="s2-section">
          <div class="s2-section-title">
            <span class="text-lg">📊</span> DEAR 即時庫存查詢
          </div>
          <div class="flex gap-3">
            <input
              v-model="dearSku"
              @keydown.enter="dearSearch"
              class="g-input flex-1"
              style="height:48px;font-size:15px;"
              placeholder="請輸入精確的 SKU"
            />
            <button class="g-btn g-btn-emerald" style="height:48px;" @click="dearSearch">📊 查詢</button>
          </div>

          <div class="mt-4">
            <div v-if="!dearResult" class="g-card p-8 text-center text-gray-400 text-xs border border-dashed">
              請輸入 SKU 或從上方搜尋結果點擊「查庫存」帶入資料。
            </div>
            <div v-else-if="!dearResult.matched" class="g-card p-6 text-center text-red-500">
              ❌ 找不到 {{ dearResult.sku }}
            </div>
            <div v-else class="g-card overflow-hidden border-2" style="border-color:#d1fae5;">
              <div class="p-4 border-b" style="background:#f0fdf4;border-color:#d1fae5;">
                <div class="font-bold text-emerald-900">✅ {{ dearResult.sku }} — {{ dearResult.name }}</div>
              </div>
              <div class="grid grid-cols-3">
                <div class="p-5 text-center border-r border-gray-100">
                  <div class="text-[11px] text-gray-500 font-semibold mb-1">On Hand</div>
                  <div class="text-3xl font-bold">{{ dearResult.onHand }}</div>
                </div>
                <div class="p-5 text-center border-r border-gray-100">
                  <div class="text-[11px] text-gray-500 font-semibold mb-1">Allocated</div>
                  <div class="text-3xl font-bold text-amber-600">{{ dearResult.allocated }}</div>
                </div>
                <div class="p-5 text-center">
                  <div class="text-[11px] text-gray-500 font-semibold mb-1">Available</div>
                  <div class="text-3xl font-bold text-emerald-600">{{ dearResult.available }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右：数据库面板 -->
      <div class="s2-db-panel">
        <div class="text-[15px] font-bold mb-4">⚙️ 搜尋專用資料庫</div>
        <div class="s2-file-info">
          <div class="text-xs font-bold text-emerald-700">✅ InventoryList_2026-04-09.csv</div>
          <div class="text-xs text-emerald-700 mt-0.5">27,612 筆資料</div>
        </div>
        <div class="mb-3.5">
          <input type="file" accept=".csv,.xlsx" class="text-xs" />
        </div>
        <button class="g-btn g-btn-blue w-full" style="padding:12px;" @click="showToast('確認更新資料庫', 'success')">
          確認更新資料庫
        </button>
      </div>
    </div>
  </div>
</template>
