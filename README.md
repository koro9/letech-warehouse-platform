# LeTech Warehouse Platform

LeTech 仓库管理 Web 平台，覆盖**内部仓库作业**、**PO 收貨**、**智能查詢**三大业务场景。

---

## 关联仓库

| 仓库 | 用途 | 访问 |
|---|---|---|
| [koro9/letech](https://github.com/koro9/letech) | 后端： Odoo ERP系统 | 🔒 私有，需授权访问 |
| [koro9/odoo19-deploy](https://github.com/koro9/odoo19-deploy) | Odoo 19 部署脚本 / Docker compose / nginx 配置 | 公开 |

---

## 📊 Dashboard 系統 — 内部仓库员工

| 模块 | 说明 |
|---|---|
| 控制台 | 当日出库扫描 / 今日 · 明日打印件数 KPI 总览 |
| 出库扫码 | 扫订单号载入待出库清单，扫商品条码逐件核验，可选打印 |
| 面单 | 今日 / 明日面单文件分屏列表，按订单号下载 |
| 拆单 | 多订单合并面单的拆分 |
| 标签 | 商品条码 + 数量直打 |
| 运单查询 | 提货日期 / 关键字 / 运单状态 / 出库状态多条件筛选（HKTV consignment） |
| 用户管理 | 账号信息维护，角色 / 权限管理 |

---

## 📦 PO 收貨平台 — 收货员

| 模块 | 说明 |
|---|---|
| PO 點貨 | 输入 PO 载入清单 → 扫条码定位 SKU → 多仓库 / 多效期数量录入；Combo 装自动按倍数计算实拿件数；Remarks 处理需录入操作员姓名留痕 |
| 收貨分配 | 单 PO 多商品的入仓分配：3PL / WS / SD4 三个标准仓 + 最多 2 个自定义额外仓；支持 ×2 / ×3 / ×5 Combo 子行；SD4 自动结余；导出 Excel |
| Transfer Order | PO 下多张 TR 单的揀貨进度追踪；扫码定位品项；BOM 子件自动展开计算；**截單功能**：将一张 TR 拆为"已揀（第一轉）+ 剩餘（第二轉）"两张单据出貨 |

---

## 🔍 智能查詢 — 商品 / 庫存

| 模块 | 说明 |
|---|---|
| 智能查詢中心 | SKU / Barcode / 中英文名模糊搜索（直連 Odoo `product.template`）+ 按 SKU 查實時庫存（Odoo `stock.quant` 直連，按倉庫聚合） |

---

## 联系

负责人：**koro9**
