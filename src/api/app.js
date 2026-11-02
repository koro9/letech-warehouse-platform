import http from './http'

/**
 * 安卓 App（LeTech 倉庫）版本信息 —— 后端 le_warehouse/controllers/app_release.py
 *
 *   GET /api/warehouse/app/version
 *   200 → {
 *     package,                     'hk.com.letech.wms'
 *     latest: { id, version_code, version_name, notes, size, sha256, published_at,
 *               download_url } | null,   download_url 是站内相对路径
 *     min_supported_code, update_available, force_update
 *   }
 *   不需要登录（PDA 上的 App 登录前就要检查更新）
 */
export function getAppVersion() {
  return http.get('/warehouse/app/version')
}
