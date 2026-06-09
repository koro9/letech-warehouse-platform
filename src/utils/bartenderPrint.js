/**
 * Bartender / TSC TE310 直接列印整合
 *
 * 用法：
 *   1. 倉庫 PC 裝 BarTender Integration Builder（或 Bartender Cloud Print Portal）
 *   2. 配置一個 HTTP listener（例：http://localhost:5500/print）接收 JSON：
 *        POST /print
 *        Body: {
 *          printer:  'TSC TE310',
 *          template: 'pick_list_100x150'  | 'repack_label_70x50' | 'label_master',
 *          labels:   [{ sku, name, barcode, qty, expDate?, lotRef? }, ...]
 *        }
 *      Bartender 配置上對 template 拉返自己嘅 BTW file，map 欄位 → 印
 *      output → TSC TE310
 *   3. 員工喺前端設定打開 Bartender 模式 → 全部 label 不彈 dialog，直接出機
 *
 * 失敗時自動 fallback 去瀏覽器 iframe 列印（保證唔會中斷工作）。
 *
 * 設定存 localStorage（key: wh_bartender_config）：
 *   { enabled, endpoint, printer, timeout }
 */

const BT_CONFIG_KEY = 'wh_bartender_config'

const DEFAULT_CONFIG = {
  enabled:  false,
  endpoint: 'http://localhost:5500/print',
  printer:  'TSC TE310',
  timeout:  2500,           // ms — 比 default fetch 短，免員工等
}

/** 攞當前配置（merged with defaults） */
export function getConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(BT_CONFIG_KEY) || '{}') }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 寫入配置（局部 merge） */
export function saveConfig(partial) {
  const current = getConfig()
  const merged  = { ...current, ...partial }
  localStorage.setItem(BT_CONFIG_KEY, JSON.stringify(merged))
  return merged
}

/** Bartender 是否啟用（純 config check，唔做 network call） */
export function isEnabled() {
  return !!getConfig().enabled
}

/**
 * Ping Bartender endpoint 看是否在線（短 timeout）。
 * 結果會 cache 5 秒，避免每次 print 都 ping 一次。
 */
let _availCache = { ts: 0, ok: false }
export async function isAvailable() {
  const cfg = getConfig()
  if (!cfg.enabled) return false
  const now = Date.now()
  if (now - _availCache.ts < 5000) return _availCache.ok
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1500)
    // 用 HEAD 比 GET 更輕量；若 endpoint 唔支援 HEAD，可改 GET /status
    const url = cfg.endpoint.replace(/\/print\/?$/, '/status')
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, mode: 'cors' })
    clearTimeout(t)
    _availCache = { ts: now, ok: res.ok }
    return res.ok
  } catch {
    _availCache = { ts: now, ok: false }
    return false
  }
}

/**
 * 提交一批 label 去 Bartender 印。
 *
 * @param {Array} labels   label data array
 * @param {Object} opts    { template, printer, copies }
 *                         template: 'pick_list_100x150' | 'repack_label_70x50' | 'label_master'
 *                         copies: 每張 label 印多少份（default 1）
 * @returns {Promise<boolean>}  true = 成功送去 Bartender；false = 失敗（caller 應該 fallback）
 */
export async function printToBartender(labels, opts = {}) {
  const cfg = getConfig()
  if (!cfg.enabled || !labels?.length) return false

  const payload = {
    printer:  opts.printer  || cfg.printer,
    template: opts.template || 'pick_list_100x150',
    copies:   parseInt(opts.copies) || 1,
    labels,
  }

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), cfg.timeout)
    const res = await fetch(cfg.endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  ctrl.signal,
      mode:    'cors',
    })
    clearTimeout(t)
    // Bartender 通常 200 OK 就算成功；body 可能係 {ok:true, jobId:'...'}
    return res.ok
  } catch (e) {
    console.warn('[bartender] print failed:', e?.message || e)
    return false
  }
}
