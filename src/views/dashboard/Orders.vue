<script setup>
/**
 * 订单 — 复刻 demo s1-orders
 * 日期范围 + 订单号 + 状态筛选 + 表格
 */
import { ref } from 'vue'

const dateRange = ref('2026-04-20 ~ 2026-04-20')
const orderQuery = ref('')
const status = ref('')

const orders = ref([
  {
    waybill: '7910648802',
    orderNo: 'H260420500709',
    status: 'ACKNOWLEDGED',
    orderDate: '2026-04-20 00:31',
    pickDate: '2026-04-21 15:00',
    outbound: '',
    printed: '',
  },
])

function search() {
  // 占位：未来调 API；目前只对本地数据过滤
}
</script>

<template>
  <div class="p-10">
    <div class="flex items-center gap-3 mb-6 flex-wrap">
      <input v-model="dateRange" class="g-input" style="width:230px;height:40px;" />
      <input v-model="orderQuery" class="g-input" style="width:160px;height:40px;" placeholder="订单号" />
      <select v-model="status" class="g-input cursor-pointer text-gray-600" style="width:150px;height:40px;">
        <option value="">订单状态</option>
        <option>ACKNOWLEDGED</option>
        <option>SHIPPED</option>
      </select>
      <button class="g-btn g-btn-teal" style="padding:8px 24px;height:40px;" @click="search">搜索</button>
    </div>

    <div class="g-card overflow-hidden">
      <table class="g-table">
        <thead>
          <tr>
            <th>运单号</th>
            <th>订单号</th>
            <th>订单状态</th>
            <th>订单日期</th>
            <th>提货日期</th>
            <th>出库</th>
            <th>打印</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.waybill">
            <td class="font-semibold">{{ o.waybill }}</td>
            <td class="font-mono text-[11px]">{{ o.orderNo }}</td>
            <td>
              <span class="g-badge" style="background:#f0f9ff;color:#0369a1;">{{ o.status }}</span>
            </td>
            <td class="text-xs text-gray-600">{{ o.orderDate }}</td>
            <td class="text-xs text-gray-600">{{ o.pickDate }}</td>
            <td>{{ o.outbound }}</td>
            <td>{{ o.printed }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
