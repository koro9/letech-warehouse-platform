import { ref } from 'vue'
import { DEAR_LS_KEYS } from '@/api/dearHttp'

/**
 * DEAR 凭据 composable
 *   - 从 localStorage 读取/持久化 Account ID + Application Key
 *   - 由用户在 SmartQuery 页的⚙️设置弹窗里自行填入（demo 一致）
 *
 * ⚠️ 长期方案：DEAR 调用走 Odoo 后端代理，凭据放后端环境变量
 *    届时这个 composable 和 dearHttp 都可以删除
 */

const accountId = ref(localStorage.getItem(DEAR_LS_KEYS.accountId) || '')
const appKey    = ref(localStorage.getItem(DEAR_LS_KEYS.appKey) || '')

export function useDearCredentials() {
  function save(newAccountId, newAppKey) {
    accountId.value = (newAccountId || '').trim()
    appKey.value    = (newAppKey || '').trim()
    localStorage.setItem(DEAR_LS_KEYS.accountId, accountId.value)
    localStorage.setItem(DEAR_LS_KEYS.appKey,    appKey.value)
  }

  return { accountId, appKey, save }
}
