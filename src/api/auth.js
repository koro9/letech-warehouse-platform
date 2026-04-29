import http from './http'

/**
 * 鉴权 API
 *
 * 系统区分两类用户：
 *   - internal：Odoo 内部用户，从 Odoo 菜单跳过来，依赖同域 session cookie 鉴权
 *   - parttime：兼职员工，无 Odoo 账号，扫胸牌登录拿 JWT
 *
 * 两类身份统一用 /whoami 端点判定（后端按 cookie / Bearer 二选一识别）
 */

/**
 * 启动时 / 刷新时调用：根据当前的 cookie 或 JWT 让后端告诉我"我是谁"
 *
 * 后端契约（Odoo 待实现）：
 *   GET /api/warehouse/whoami
 *   200 → { type, name, user_id?, operator_id?, role?, avatar? }
 *         type: 'internal' | 'parttime'
 *         user_id 仅 internal；operator_id 仅 parttime
 *         role 由 Odoo 端的用户组 / hr.employee.wms_role 决定
 *   401 → 未登录，前端跳 /login
 */
export function whoami() {
  return http.get('/warehouse/whoami')
}

/**
 * 兼职员工扫胸牌登录
 * 后端契约：POST /api/warehouse/login/badge { employee_barcode }
 *           200 → { token, expires_in, name, operator_id, role, avatar? }
 *                 token 有效期约 10 小时；同时返回 identity 各字段，前端直接用，不再调 whoami
 *           400 → 该胸牌未在系统注册
 */
export function loginByBadge(employee_barcode) {
  return http.post('/warehouse/login/badge', { employee_barcode })
}

/**
 * 兼职员工登出 — 通知后端把 JWT 加入 denylist（best-effort）
 * 即使失败前端也会清本地状态。internal 用户登出走 Odoo `/web/session/logout`，不调此 API
 */
export function logout() {
  return http.post('/warehouse/logout')
}
