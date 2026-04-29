/**
 * DEAR (Cin7 Core) API 直连客户端
 *
 * 注意：DEAR 官方禁止前端直连，必须经 CORS 代理。
 * 本实现按 智能查詢.html 原型一致：
 *   - 双代理回退：cors-anywhere → corsproxy.io
 *   - 当 cors-anywhere 返回 corsdemo 解锁页时，抛 CORS_UNLOCK_REQUIRED 错误
 *     → 调用方应展示"前往 https://cors-anywhere.herokuapp.com/corsdemo 一键授权"指引
 *   - 凭据从 localStorage 读取（用户在设置面板里自行填）
 *
 * ⚠️  生产部署时建议改为 Odoo 后端代理（/api/dear/*），前端零暴露凭据。
 *     届时这个文件可以删，调用切换到 import { dear } from '@/api'，src/api/dear.js
 *     底层换成主 http 实例即可。
 */

const PROXIES = [
  (url) => `https://cors-anywhere.herokuapp.com/${url}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
]

const DEAR_BASE = 'https://inventory.dearsystems.com/ExternalApi/v2'

export const DEAR_LS_KEYS = {
  accountId: 'dearAccountId',
  appKey:    'dearAppKey',
}

export async function dearFetch(endpoint, params = {}) {
  const accountId = localStorage.getItem(DEAR_LS_KEYS.accountId) || ''
  const appKey    = localStorage.getItem(DEAR_LS_KEYS.appKey) || ''

  if (!accountId || !appKey) {
    const err = new Error('DEAR_CREDENTIALS_MISSING')
    err.code = 'DEAR_CREDENTIALS_MISSING'
    throw err
  }

  const urlParams = new URLSearchParams(params).toString()
  const targetUrl = `${DEAR_BASE}/${endpoint}?${urlParams}`

  let lastError
  let requiresUnlock = false

  for (const buildProxyUrl of PROXIES) {
    const proxyUrl = buildProxyUrl(targetUrl)
    try {
      const response = await fetch(proxyUrl, {
        method: 'GET',
        headers: {
          'api-auth-accountid':      accountId,
          'api-auth-applicationkey': appKey,
          'Content-Type':            'application/json',
          'Accept':                  'application/json',
          'X-Requested-With':        'XMLHttpRequest',
        },
      })
      if (response.ok) return await response.json()
      if (response.status === 403) {
        const text = await response.text()
        if (text.includes('corsdemo')) requiresUnlock = true
      }
      lastError = new Error(`連線錯誤 (${response.status})`)
    } catch (err) {
      // 网络层错误，尝试下一个代理
      lastError = err
    }
  }

  if (requiresUnlock) {
    const err = new Error('CORS_UNLOCK_REQUIRED')
    err.code = 'CORS_UNLOCK_REQUIRED'
    throw err
  }
  throw lastError || new Error('UNKNOWN_DEAR_ERROR')
}
