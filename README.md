# LeTech Warehouse Platform

LeTech 仓库管理 Web 平台 — Vue 3 前端，对接 letech Odoo 后端。

覆盖：
- **S1** 内部仓库作业（出库扫码、面单、拆单、标签、订单、对账）
- **S2** 3PL 商家自助查询门户（Yummy、Anymall、Hello Bear、Homey ...）
- **S3** PO 收货平台（PO 點貨、收貨分配、Transfer Order）

> 配套 Odoo 后端项目: [letech](https://github.com/koro9/letech)
> 部署脚本: [odoo19-deploy](https://github.com/koro9/odoo19-deploy)

---

## 🛠️ 技术栈

| 项 | 选型 | 说明 |
|---|---|---|
| 框架 | Vue 3 (Composition API) | 响应式数据 + OWL 风格组件 |
| 构建 | Vite 6 | 极速冷启动 + HMR |
| 路由 | Vue Router 4 | SPA 路由 |
| 状态 | Pinia | 轻量、TS 友好 |
| HTTP | Axios | 拦截器统一鉴权 + 错误处理 |
| 样式 | Tailwind CSS 3 | utility-first，对齐 demo 风格 |
| 部署 | nginx 静态资源 | 同 Odoo 服务器 |

---

## 🚀 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量
cp .env.example .env

# 3. 启动开发服务器（默认 http://localhost:5173）
npm run dev

# 4. 生产构建
npm run build

# 5. 本地预览构建产物
npm run preview
```

**联调注意**：Vite dev server 已配置 `/api/*` 代理到 `VITE_DEV_API_TARGET`（默认 `http://localhost:8069`），不需要改前端代码就能调本地 Odoo。

---

## 📁 项目结构

```
letech-warehouse-platform/
├── .github/
│   ├── workflows/deploy.yml      # 推送 main 自动部署到生产服务器
│   ├── CODEOWNERS                # PR 默认审核人
│   └── pull_request_template.md
├── src/
│   ├── main.js                   # Vue 入口
│   ├── App.vue                   # 根组件（仅 RouterView）
│   ├── router/index.js           # 路由 + 鉴权守卫
│   ├── stores/
│   │   └── auth.js               # 员工胸牌登录态
│   ├── utils/
│   │   └── api.js                # axios 封装 + warehouseAPI 集合
│   ├── components/               # 可复用组件
│   │   └── BaseButton.vue
│   ├── views/                    # 页面组件
│   │   ├── Login.vue             # 登录（胸牌扫码）
│   │   ├── AppShell.vue          # 主框架（顶栏 + 侧栏 + RouterView）
│   │   └── S1/
│   │       ├── Dashboard.vue     # 控制台
│   │       └── Outbound.vue      # 出库扫码（首发功能）
│   └── assets/
│       └── main.css              # 全局样式 + Tailwind 入口
├── public/                       # 静态资源（不参与构建处理）
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```

---

## 🔐 鉴权模型

**兼职员工不需要 Odoo User 账号**，但所有操作可追溯到自然人。流程：

```
1. 员工在登录页扫胸牌条码
2. 前端 POST /api/warehouse/login → 后端验证 hr.employee.barcode
3. 后端发放 JWT/Bearer token + 返回 employee_id
4. 前端存 localStorage，后续所有请求自动带 token
5. 后端解析 token 拿到 operator_id → 写入 stock.move.operator_id
```

后端契约见 letech 项目 `letech_warehouse_api` 模块。

---

## 🚢 部署

### 自动部署（推荐）

`push` 到 `main` 分支会自动触发 `.github/workflows/deploy.yml`：

1. GitHub Actions 拉代码 → `npm ci` → `npm run build`
2. 通过 SSH rsync 把 `dist/` 推到生产服务器
3. 远程执行 `nginx -s reload`

### 必须配置的 GitHub Secrets

进入 **Repo → Settings → Secrets and variables → Actions**：

| Secret | 含义 |
|---|---|
| `SSH_PRIVATE_KEY` | 部署用的 SSH 私钥（在服务器上对应 `deployer` 公钥） |
| `SERVER_HOST` | 生产服务器 IP / 域名 |
| `SERVER_USER` | 部署账号（建议 `deployer`） |
| `SERVER_DIST_PATH`（可选） | 默认 `/opt/odoo19-deploy/vue-dist/` |

### 服务器侧准备

```bash
# 创建专用部署用户
sudo useradd -m -s /bin/bash deployer
sudo mkdir -p /opt/odoo19-deploy/vue-dist
sudo chown deployer:deployer /opt/odoo19-deploy/vue-dist

# 把 GH Actions deploy key 公钥加入 deployer
sudo -u deployer mkdir -p /home/deployer/.ssh
sudo -u deployer tee /home/deployer/.ssh/authorized_keys < deploy_key.pub
chmod 600 /home/deployer/.ssh/authorized_keys

# 让 deployer 能 reload nginx 容器（不输密码）
echo "deployer ALL=(root) NOPASSWD: /usr/bin/docker compose exec nginx nginx -s reload" \
  | sudo tee /etc/sudoers.d/deployer
```

### nginx 配置（在 odoo19-deploy 项目里配）

```nginx
location /warehouse/ {
    alias /usr/share/nginx/html/warehouse/;
    try_files $uri $uri/ /warehouse/index.html;
}

location /api/ {
    proxy_pass http://odoo:8069;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

---

## 🛡️ 分支保护

`main` 是受保护分支，**不允许直接 push**。

- 任何变更走 PR
- 至少需要 1 个 approval
- 不允许 force push / 删除分支
- CI build 必须通过

详见仓库 **Settings → Branches**。

---

## 📋 开发规范

### 提交信息

```
feat(s1/outbound): 增加扫码后自动打印开关
fix(api): 401 时清除 token 后跳转登录
chore(deps): 升级 vite 6.0.7
docs(readme): 部署章节加 nginx 配置
```

### 分支命名

```
feat/<scope>-<short-desc>     新功能
fix/<scope>-<short-desc>      修 bug
chore/<scope>-<short-desc>    依赖/配置
```

### 添加新页面的标准步骤

1. 在 `src/views/SX/` 创建 `.vue` 文件
2. 在 `src/router/index.js` 加路由
3. 在 `src/views/AppShell.vue` 的 `navItems` 加菜单项
4. 在 `src/utils/api.js` 加对应 API 方法

---

## 📞 联系

负责人: **koro9**
