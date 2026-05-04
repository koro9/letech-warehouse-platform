# PWA 接入规划（letech-warehouse-platform）

> **状态**：规划中，**未实际接入**。响应式适配（2026-05-04）已完成；PWA 是下一阶段独立工作。
>
> 本文档不入业务流；只是给后续接入 PWA 的工程师 / Claude 会话留一份完整的取舍记录。

---

## 1. 目的与价值

WMS 当前是同源 SPA，已支持响应式。再做 PWA 能解锁：

| 能力 | 业务价值 |
|---|---|
| **添加到主屏（A2HS）** | 员工平板把 WMS 当 app 用，去掉浏览器地址栏、避免误关 tab |
| **离线/弱网容错** | 仓库 WiFi 信号差时，至少 SPA 壳能加载，不是白屏 |
| **后台静默更新** | 员工不需要刷新就能拿到新版本 |
| **相机扫码（BarcodeDetector）** | M3a/M3c 的「📷 開啟相機掃碼」按钮真正能用 |
| **推送通知（可选）** | 紧急 PO / 截单等场景给员工推消息 |

---

## 2. 必须先解决的部署上下文

PWA **强制要求 HTTPS / secure context**（localhost 例外）。

当前生产环境：

```
nginx → /warehouse/  (Vue dist)
       → /api/*      (Odoo)
```

**确认项（接入前必须查）**：
- [ ] 生产域名是否已上 HTTPS？走 Let's Encrypt 还是公司证书？
- [ ] `web.base.url` 是否是 `https://...`？
- [ ] iframe / 子路径 cookie 是否在 HTTPS 下仍工作（SameSite=Lax + Secure）？
- [ ] 测试环境 / staging 是否也 HTTPS？没有的话 service worker 注册会失败

> 见记忆 `feedback_deployment_context_first` —— 部署上下文锁死在写代码之前。

---

## 3. 工具选型

**推荐：[`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/)**

理由：
- 官方推荐，Vite 6 完美支持
- 自动生成 manifest + service worker
- workbox-based，离线策略丰富
- 跟现有项目零冲突（`src/api/http.js` 不需要改）

```bash
npm install -D vite-plugin-pwa
```

`vite.config.js` 增量配置：

```js
import { VitePWA } from 'vite-plugin-pwa'

export default {
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',           // 后台自动更新，不打扰用户
      includeAssets: ['favicon.ico'],       // 会被静态缓存的额外资源
      manifest: {
        name: 'LeTech Warehouse Platform',
        short_name: 'LeTech WMS',
        description: '倉庫管理系統',
        theme_color: '#6BAB9E',
        background_color: '#ffffff',
        display: 'standalone',              // 全屏 app 体验，无浏览器 chrome
        orientation: 'any',                 // 横竖屏都允许（扫码场景常横屏）
        scope: '/warehouse/',               // 跟 Vite base 一致
        start_url: '/warehouse/',
        icons: [
          { src: '/warehouse/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/warehouse/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/warehouse/pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 见 § 5 离线策略
      },
    }),
  ],
}
```

---

## 4. Manifest 关键字段说明

| 字段 | 选择 | 理由 |
|---|---|---|
| `display` | `standalone` | 像 native app，去掉地址栏；员工不会误访问其他网址 |
| `orientation` | `any` | 不锁定。横屏看 Allocation 表格更舒服，竖屏 Counting 更顺手 |
| `scope` + `start_url` | `/warehouse/` | 跟 Vite `base` 一致；点 icon 直接进登录页 |
| `theme_color` | `#6BAB9E`（teal） | 跟 demo 主色对齐；安卓状态栏会染色 |
| `background_color` | `#ffffff` | iOS splash 背景；保持简洁 |

**图标准备**（设计师配合）：

需要的尺寸（PWA 标准 + iOS 兼容）：

```
public/
├── pwa-192.png        192x192   通用
├── pwa-512.png        512x512   通用
├── pwa-512-maskable.png 512x512 可裁剪（安卓自适应图标）
├── apple-touch-icon.png 180x180 iOS A2HS
└── favicon.ico        16/32/48
```

设计提示：
- 留 10% 安全边距（maskable 会被裁掉边缘）
- 主色用 teal，背景纯白
- 图形简洁（小尺寸下能识别）

---

## 5. 离线 / 缓存策略（关键决策）

PWA 离线最大的坑：**缓存陈旧的业务数据导致用户操作失败**。

WMS 业务数据时效性极强（库存数字、出库状态、运单数据），**绝不能缓存 API 响应**。

### 推荐策略

| 资源类型 | 策略 | 原因 |
|---|---|---|
| **HTML / JS / CSS / 字体** | `StaleWhileRevalidate` | 离线能加载老版本，在线时后台拉新 |
| **`/api/*`** | `NetworkOnly`（不缓存） | 业务数据必须实时；缓存 = 数据撒谎 |
| **图片 / icon** | `CacheFirst`（30 天 TTL） | 静态资源，缓存换流量 |
| **页面 navigation** | `NetworkFirst`（5s timeout 后回 cache） | 在线优先，离线兜底 |

`vite-plugin-pwa` 配置示例：

```js
workbox: {
  navigateFallback: '/warehouse/index.html',
  runtimeCaching: [
    {
      // API 请求一律不缓存 — 让 axios 拦截器自己处理离线
      urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
      handler: 'NetworkOnly',
    },
    {
      urlPattern: /\.(?:png|jpg|jpeg|svg|webp)$/,
      handler: 'CacheFirst',
      options: {
        cacheName: 'images',
        expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
      },
    },
  ],
}
```

### 离线 UX 兜底

API 失败时，前端 axios 拦截器需要识别"网络断开"vs"5xx"，分别 toast：

```js
// src/api/http.js 增量
http.interceptors.response.use(
  (r) => r.data,
  (err) => {
    if (!err.response && err.message === 'Network Error') {
      showToast('離線中 — 請檢查網絡', 'error')
      err.handledByInterceptor = true
    }
    // ... 其余拦截器
    return Promise.reject(err)
  },
)
```

---

## 6. 相机扫码（M3a / M3c 的「📷 開啟相機掃碼」按钮）

当前两个文件都有 scanner 占位：

```html
<div v-if="scannerOpen">
  ...相机功能在 PWA 阶段开启...
</div>
```

PWA 阶段把它接入。**两条技术路线**：

### 路线 A：浏览器原生 [BarcodeDetector API](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector)

```js
if ('BarcodeDetector' in window) {
  const detector = new BarcodeDetector({ formats: ['code_128', 'ean_13', 'qr_code'] })
  // 配合 MediaStream 获取相机流
}
```

**优点**：零依赖、性能好、底层 OS 优化
**缺点**：iOS Safari **不支持**（截至 2026-05），Android Chrome 才有

### 路线 B：[`html5-qrcode`](https://github.com/mebjas/html5-qrcode) 库

```bash
npm install html5-qrcode
```

**优点**：iOS / Android 都支持
**缺点**：依赖 JS 解码，性能一般，bundle +50KB

### 推荐：渐进增强

```js
async function scanBarcode() {
  if ('BarcodeDetector' in window) {
    return scanNative()      // 优先原生（Android 主战场）
  }
  return scanFallback()      // 兜底 html5-qrcode（iOS）
}
```

### secure context 要求

`navigator.mediaDevices.getUserMedia` **强制 HTTPS**。再次确认 § 2 部署。

### 权限提示

第一次开相机会弹「允许 letech.com.hk 使用相机」。被拒 → 给用户清晰提示：

```
需要相機權限才能掃碼
請到瀏覽器設定 → 隱私 → 網站設定 → 相機 啟用
[改為手動輸入]
```

---

## 7. 推送通知（可选，低优先级）

业务场景：紧急 PO 进来通知收货员、截单成功通知主管等。

**实现复杂度高**：
- 需要 backend 接 `web-push` 协议（Odoo 端要写新 controller）
- VAPID 密钥管理
- 用户授权 → 拒绝就再也弹不出来

**建议**：先不做。PWA 阶段聚焦「A2HS + 离线壳 + 相机扫码」三件，推送等真有业务诉求再加。

---

## 8. iOS Safari 特殊适配

iOS 是 PWA 体验的洼地，要专门照顾。

| 问题 | 解决 |
|---|---|
| 不支持 `BarcodeDetector` | 走 § 6 路线 B 兜底 |
| 不支持 push notification（PWA 模式） | 接受现状 |
| A2HS 后状态栏样式 | `<meta name="apple-mobile-web-app-status-bar-style">`（已加） |
| splash screen 自定义 | iOS 需要在 `<head>` 列出每种尺寸的 `<link rel="apple-touch-startup-image">` —— 略麻烦，先用默认 |
| 安全区（刘海 / home bar） | 已用 `safe-pt/pb/px` utility class 处理 |
| input focus 自动缩放 | 已用 `font-size: 16px` 在移动端禁止（main.css） |

---

## 9. 服务工作者更新策略

`registerType: 'autoUpdate'` 会让 SW 自动检测更新并替换。但活跃 tab 上的旧 SW 不会立即被新 SW 接管 —— 用户感知不到更新。

**两个 UX 选择**：

**A. 静默更新（默认）**：用户下次打开应用才用新版本。简单但更新延迟长。

**B. 提示用户刷新**（更好）：

```js
import { useRegisterSW } from 'virtual:pwa-register/vue'

const { needRefresh, updateServiceWorker } = useRegisterSW({
  onRegisteredSW(swScript, registration) {
    // 注册成功
  },
})

// UI：右下角浮动提示
// "新版本已就緒，刷新生效" [刷新] [稍後]
```

**推荐方案 B**：配合 Toast 组件做个右下角浮动提示。

---

## 10. 接入步骤（落地清单）

```
[ ] § 2  确认生产 HTTPS / secure context 已就绪
[ ] § 3  npm install -D vite-plugin-pwa
[ ] § 3  vite.config.js 加 VitePWA() 配置
[ ] § 4  设计师出 5 个尺寸 icon → public/
[ ] § 5  workbox 配置：API 不缓存 + 静态资源 SWR
[ ] § 5  http.js 增量加"离线 toast"分支
[ ] § 6  M3a / M3c scanner 占位换成真实相机调用（路线 A + B 渐进增强）
[ ] § 9  做"新版本就绪"浮动提示组件
[ ] §    在 staging 跑一周看 SW 行为正常
[ ] §    Lighthouse PWA 评分 ≥ 90
[ ] §    生产部署 + 灰度（先 5 个员工试用）
```

预计工作量：**3-5 个工作日**（不含设计 icon）。

---

## 11. 已经为 PWA 做好的准备（现状）

响应式改造（2026-05-04）已经把 PWA 的"半成品"做好：

✅ `<meta viewport>` 已含 `viewport-fit=cover`（iOS 全面屏）
✅ `<meta name="apple-mobile-web-app-capable">` + `status-bar-style` 已就位
✅ `<meta name="theme-color">` 已设
✅ `safe-pt/pb/px` utility 已建好
✅ Mobile 输入框 16px 防 iOS 自动缩放
✅ 触摸目标最小 44x44 已强制
✅ 所有页面已响应式，单尺寸打包不会破布局
✅ KeepAlive + 路由 prefetch 已就位（PWA 离线 cache 第一击 friendly）

**剩下的就是把 vite-plugin-pwa 装上 + 接相机 + 做 update prompt。**
