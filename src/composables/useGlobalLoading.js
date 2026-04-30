import { ref } from 'vue'

/**
 * 全局阻塞式 Loading 遮罩
 *
 * 用法：
 *
 *   const loading = useGlobalLoading()
 *
 *   // 手动控制（适合需要在跳转/卸载场景里 *不* hide 的情况，如登出）
 *   loading.show('登出中...')
 *   try {
 *     await api.something()
 *     window.location.href = '/login'   // 不 hide，让遮罩持续到新页面加载
 *   } catch (e) {
 *     loading.hide()
 *     throw e
 *   }
 *
 *   // 自动控制（推荐，try/finally 自带）
 *   await loading.run(async () => {
 *     await api.something()
 *   }, '處理中...')
 *
 * 嵌套调用：用 depth 计数器，所有调用都 hide 后才真正消失，
 * 避免"A 还在请求时 B 完成把遮罩关了"的 UX 错位
 */

const visible = ref(false)
const message = ref('')
let depth = 0

export function useGlobalLoading() {
  function show(msg = '') {
    depth++
    if (msg) message.value = msg
    visible.value = true
  }

  function hide() {
    depth = Math.max(0, depth - 1)
    if (depth === 0) {
      visible.value = false
      message.value = ''
    }
  }

  async function run(asyncFn, msg = '') {
    show(msg)
    try {
      return await asyncFn()
    } finally {
      hide()
    }
  }

  return { visible, message, show, hide, run }
}
