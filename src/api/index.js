/**
 * API 入口 — 按业务域分组导出
 *
 * 推荐用法：
 *   import { auth, outbound } from '@/api'
 *   auth.login(barcode)
 *   outbound.scanOutbound({ orderNumber, sku, qty })
 *
 * 也可直接从子模块导入：
 *   import { login } from '@/api/auth'
 *
 * 添加新业务域：
 *   1. 新建 src/api/<domain>.js（从 ./http 导入实例，导出函数）
 *   2. 在这里加一行 export
 *   3. 路由 / 函数命名跟后端 letech_warehouse_api controller 对齐
 *
 * 接入非 Odoo 后端：新建 ./xxxHttp.js 实例，对应模块从该实例导入。
 */

export * as auth from './auth'
export * as outbound from './outbound'
export * as shipping from './shipping'
export * as inventory from './inventory'
export * as orders from './orders'

export { default as http } from './http'
