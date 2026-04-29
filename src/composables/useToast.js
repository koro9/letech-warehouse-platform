import { ref } from 'vue'

/**
 * 全局 toast — 替代 demo 里的 showToast()
 * 用法：
 *   import { showToast } from '@/composables/useToast'
 *   showToast('已儲存', 'success')   // type: success | error | warning
 */

const current = ref(null)
let timer = null

export function showToast(message, type = 'success') {
  current.value = { message, type }
  clearTimeout(timer)
  timer = setTimeout(() => { current.value = null }, 2200)
}

export function useToast() {
  return { current }
}
