import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'

/**
 * 当前页"刷新数据"的统一注册中心
 *
 * 解决三个独立场景的 UX，全部走同一个 refresh 函数：
 *   1. 用户主动点 🔄 按钮
 *   2. http 拦截器收到 409 → 自动触发刷新（乐观锁冲突温和处理）
 *   3. 用户切回 tab / 解锁电脑 → focus 回页时拉最新数据
 *
 * 设计：
 *   - 全局 ref 持有当前活跃页的 refresh 函数（同一时刻只有一个页面注册）
 *   - visibility 监听器只挂一次（模块级单例），监听器只触发当前 ref 指向的 refresh
 *   - 30 秒节流：visibility 频繁切换时不重复请求
 *   - 兼容 KeepAlive：activate/deactivate 时切换 slot 归属，避免冷藏的旧页面被错误触发
 *
 * 用法：
 *   const { refreshNow } = usePageRefresh(loadOrder)
 *   // <RefreshButton :onRefresh="refreshNow" /> 在模板里
 */

const currentRefresh = ref(null)
const VISIBILITY_THROTTLE_MS = 30_000

// ============== 模块级单例：visibility 监听器只挂一次 ==============
let lastAutoRefreshAt = 0
let visibilityListenerInstalled = false

function installVisibilityListenerOnce() {
  if (visibilityListenerInstalled) return
  visibilityListenerInstalled = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!currentRefresh.value) return
    const now = Date.now()
    if (now - lastAutoRefreshAt < VISIBILITY_THROTTLE_MS) return
    lastAutoRefreshAt = now
    currentRefresh.value('visibility')
  })
}

// ============== 每个页面调用 ==============
export function usePageRefresh(refreshFn) {
  installVisibilityListenerOnce()

  // 包一层 try/catch，避免 refresh 失败把全局 listener 搞挂
  const refresh = async (reason = 'manual') => {
    try {
      await refreshFn()
    } catch (err) {
      console.error('[usePageRefresh]', reason, err)
    }
  }

  // 把"我"绑到当前活跃页 slot
  function bind() {
    currentRefresh.value = refresh
  }
  // 解绑：只清当前是"我"的 slot，避免误清后续接管者
  function unbind() {
    if (currentRefresh.value === refresh) currentRefresh.value = null
  }

  // 真挂载（首次进页面） + KeepAlive 切回来 → 都要 bind
  onMounted(bind)
  onActivated(bind)
  // 切走（被 KeepAlive 冷藏） + 真销毁（被 LRU 淘汰） → 都要 unbind
  onDeactivated(unbind)
  onUnmounted(unbind)

  return { refreshNow: () => refresh('manual') }
}

/** 由 http.js 拦截器调用，触发当前页的刷新 */
export function triggerCurrentRefresh() {
  return currentRefresh.value?.('conflict')
}
