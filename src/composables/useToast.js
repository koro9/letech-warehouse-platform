import { ref } from 'vue'

/**
 * 全局 toast — 替代 demo 里的 showToast()
 * 用法：
 *   import { showToast } from '@/composables/useToast'
 *   showToast('已儲存', 'success')   // type: success | error | warning
 */

const current = ref(null)
let timer = null

export function showToast(message, type = 'success', duration) {
  current.value = { message, type }
  clearTimeout(timer)
  const ms = duration ?? (type === 'error' ? 5000 : 2200)
  timer = setTimeout(() => { current.value = null }, ms)
}

export function useToast() {
  return { current }
}
