import { onMounted, onUnmounted, ref } from 'vue'

/**
 * 当前页"刷新数据"的统一注册中心
 *
 * 解决三个独立场景的 UX，全部走同一个 refresh 函数：
 *   1. 用户主动点 🔄 按钮
 *   2. http 拦截器收到 409 → 自动触发刷新（机制 4：温和的冲突处理）
 *   3. 用户切回 tab / 解锁电脑 → focus 回页时拉最新数据
 *
 * 设计：
 *   - 全局 ref 持有当前活跃页的 refresh 函数（同一时刻只有一个页面注册）
 *   - 页面挂载时注册，卸载时清理（避免后台已离开的页面被触发）
 *   - 30 秒节流：visibility 频繁切换时不重复请求
 *
 * 用法：
 *   const { refreshNow } = usePageRefresh(loadOrder)
 *   // <RefreshButton :onRefresh="refreshNow" /> 在模板里
 */

const currentRefresh = ref(null)
const VISIBILITY_THROTTLE_MS = 30_000

export function usePageRefresh(refreshFn) {
  let lastAutoRefreshAt = 0

  // 包一层 try/catch，避免 refresh 失败把全局 listener 搞挂
  const refresh = async (reason = 'manual') => {
    try {
      await refreshFn()
    } catch (err) {
      console.error('[usePageRefresh]', reason, err)
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return
    const now = Date.now()
    if (now - lastAutoRefreshAt < VISIBILITY_THROTTLE_MS) return
    lastAutoRefreshAt = now
    refresh('visibility')
  }

  onMounted(() => {
    currentRefresh.value = refresh
    document.addEventListener('visibilitychange', onVisibilityChange)
  })
  onUnmounted(() => {
    if (currentRefresh.value === refresh) currentRefresh.value = null
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return { refreshNow: () => refresh('manual') }
}

/** 由 http.js 拦截器调用，触发当前页的刷新 */
export function triggerCurrentRefresh() {
  return currentRefresh.value?.('conflict')
}
