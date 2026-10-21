/**
 * 倉庫作業中心 — 把后端返回的库位树「拍平」成分组列表的行
 *
 * 两个页面（商品位置 / 貨架查詢）都用 Odoo 式多层分组列表展示：
 *   group 行 = 分组（板、带下层的位置），显示合计，可收合
 *   leaf  行 = 明细（格子 / 商品）
 *   sub   行 = 明细下再展开一层（批次），默认收起
 *
 * 行结构：
 *   { key, kind, depth, label, mono, tags, qty: {on_hand, reserved, available},
 *     expiry, parents: [key...], locationId, sku, collapsible, startCollapsed, muted }
 * 某行的任一 parents 被收合时，这一行不显示（逻辑在 ShelfGroupedTable 里）
 */

// 标签配色（Tailwind 类名，ShelfGroupedTable 统一加基础尺寸）
const TAG = {
  warn: 'bg-amber-100 text-amber-800',
  multi: 'bg-violet-100 text-violet-800',
  else: 'bg-gray-100 text-gray-600 border border-gray-200 hover:border-teal hover:text-teal',
  empty: 'border border-dashed border-gray-300 text-gray-400 !font-medium',
  plain: 'text-gray-400 !font-medium !px-0',
}

export function fmtQty(n) {
  const v = Number(n) || 0
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(2).replace(/\.?0+$/, '')
}

// 分组表默认的库存栏（ShelfGroupedTable 的 columns 默认值）
// 列定义：{ key, label, align, width, mobileHidden, value(row), cls(row) }
export const STOCK_COLUMNS = [
  { key: 'on_hand', label: '在庫', width: 'w-20 lg:w-24', value: r => fmtQty(r.qty?.on_hand) },
  { key: 'reserved', label: '已預留', width: 'w-24', mobileHidden: true,
    value: r => fmtQty(r.qty?.reserved), cls: r => (r.qty?.reserved ? 'text-amber-600' : 'text-gray-300') },
  { key: 'available', label: '可轉', width: 'w-20 lg:w-24',
    value: r => fmtQty(r.qty?.available),
    cls: r => (r.kind !== 'sub' && r.qty?.available > 0 ? 'text-emerald-700' : '') },
  { key: 'expiry', label: '最早到期', align: 'left', width: 'w-32', mobileHidden: true,
    value: r => r.expiry || '—', cls: () => 'text-xs lg:text-[13px] text-gray-500 font-normal' },
]

/**
 * 行尾操作按钮（ShelfGroupedTable withActions 模式用）
 *   上架 = 来源是未上架（库存根库位本层）；轉出 = 来源是某个板 / 格子本层
 *   只有可转数量 > 0 才给按钮；sku / name 在按商品显示的行上才需要
 */
function moveAction(kind, sourceId, sourceLabel, available, extra = {}) {
  if (!(Number(available) > 0)) return null
  return {
    label: kind === 'putaway' ? '上架' : '轉出',
    tone: kind === 'putaway' ? 'amber' : 'teal',
    kind, sourceId, sourceLabel, available: Number(available), ...extra,
  }
}

function hasQty(q) {
  return !!q && ((Number(q.on_hand) || 0) !== 0 || (Number(q.reserved) || 0) !== 0)
}

function qtyOf(q) {
  return { on_hand: q?.on_hand || 0, reserved: q?.reserved || 0, available: q?.available || 0 }
}

// ============================================================
// 商品位置：树 → 行
// ============================================================
export function productRows(tree) {
  const rows = []
  if (!tree) return rows

  function pushLeaf(node, depth, parents, label, opts = {}) {
    const key = `l${node.id}${opts.suffix || ''}`
    const lots = (node.own?.lots || []).filter(l => l.name)
    rows.push({
      key, kind: 'leaf', depth, label, parents,
      tags: opts.tags || [],
      qty: qtyOf(node.own),
      expiry: node.own?.earliest_expiry,
      locationId: opts.noLink ? null : node.id,
      collapsible: lots.length > 0,
      startCollapsed: true,
      action: moveAction(opts.noLink ? 'putaway' : 'transfer', node.id,
                         opts.noLink ? '未上架' : label, node.own?.available),
    })
    lots.forEach((lot, i) => rows.push({
      key: `${key}-lot${i}`, kind: 'sub', depth: depth + 1,
      label: `批次 ${lot.name}`, parents: [...parents, key],
      qty: { on_hand: lot.on_hand, reserved: lot.reserved, available: lot.on_hand - lot.reserved },
      expiry: lot.expiry,
    }))
  }

  function walk(node, depth, parents, isRoot) {
    const key = `n${node.id}`
    if (isRoot) {
      rows.push({
        key, kind: 'group', depth, label: node.full_name, parents,
        qty: qtyOf(node.total), expiry: node.total?.earliest_expiry,
        collapsible: true, locationId: node.id,
      })
      const inner = [...parents, key]
      if (hasQty(node.own)) {
        // 根库位本层 = 未上架
        pushLeaf(node, depth + 1, inner, '未上架', {
          suffix: 'u', noLink: true, tags: [{ text: '庫存本層', cls: TAG.warn }],
        })
      }
      node.children.forEach(c => walk(c, depth + 1, inner, false))
      return
    }
    if (node.children.length) {
      rows.push({
        key, kind: 'group', depth, label: node.name, parents,
        qty: qtyOf(node.total), expiry: node.total?.earliest_expiry,
        collapsible: true, locationId: node.id,
      })
      const inner = [...parents, key]
      if (hasQty(node.own)) pushLeaf(node, depth + 1, inner, `${node.name}（本層）`, { suffix: 'o' })
      node.children.forEach(c => walk(c, depth + 1, inner, false))
      return
    }
    pushLeaf(node, depth, parents, node.name)
  }

  walk(tree, 0, [], true)
  return rows
}

// ============================================================
// 貨架查詢：树 → 行
// ============================================================
function itemTags(sku, products, isShelf) {
  const meta = products?.[sku]
  const tags = []
  if (!meta) return tags
  if (isShelf && meta.multi > 1) tags.push({ text: `本板 ${meta.multi} 處`, cls: TAG.multi })
  if (meta.elsewhere > 0) tags.push({ text: `他處 +${fmtQty(meta.elsewhere)}`, cls: TAG.else, sku })
  return tags
}

/** 按位置分组：位置是分组，商品是明细；空位置也列出 */
export function locationRowsByLocation(tree, products) {
  const rows = []
  if (!tree) return rows
  const isShelf = tree.children.length > 0

  function itemRows(items, depth, parents, node) {
    items.forEach(it => rows.push({
      key: `${parents[parents.length - 1]}-${it.sku}`, kind: 'leaf', depth, parents,
      label: it.name, mono: it.sku, sku: it.sku,
      tags: itemTags(it.sku, products, isShelf),
      qty: qtyOf(it), expiry: it.earliest_expiry,
      action: moveAction('transfer', node.id, node.name, it.available, { sku: it.sku, name: it.name }),
    }))
  }

  function walk(node, depth, parents) {
    const key = `n${node.id}`
    const empty = !hasQty(node.total)
    rows.push({
      key, kind: 'group', depth, parents,
      label: depth === 0 ? node.full_name : node.name,
      tags: empty ? [{ text: '空', cls: TAG.empty }]
        : [{ text: `${node.total.sku_count} 個 SKU`, cls: TAG.plain }],
      qty: qtyOf(node.total),
      collapsible: !empty, locationId: depth === 0 ? null : node.id,
      muted: empty,
    })
    const inner = [...parents, key]
    const items = node.own?.items || []
    if (items.length) {
      if (node.children.length) {
        // 既有本层商品又有下层：本层单独成一组，避免和下层分组混在一起
        const okey = `o${node.id}`
        rows.push({
          key: okey, kind: 'group', depth: depth + 1, parents: inner,
          label: `${node.name}（本層）`, qty: qtyOf(node.own), collapsible: true,
        })
        itemRows(items, depth + 2, [...inner, okey], node)
      } else {
        itemRows(items, depth + 1, inner, node)
      }
    }
    node.children.forEach(c => walk(c, depth + 1, inner))
  }

  walk(tree, 0, [])
  return rows
}

/** 按商品分组：商品是分组，它在本范围内的各个位置是明细 */
export function locationRowsBySku(tree, products) {
  const rows = []
  if (!tree) return rows
  const isShelf = tree.children.length > 0
  const rootName = tree.full_name
  const bySku = new Map()

  function collect(node) {
    for (const it of node.own?.items || []) {
      if (!bySku.has(it.sku)) bySku.set(it.sku, { name: it.name, places: [] })
      const rel = node.full_name === rootName
        ? `${node.name}（本層）`
        : node.full_name.slice(rootName.length + 1).replaceAll('/', ' / ')
      bySku.get(it.sku).places.push({ node, it, rel })
    }
    node.children.forEach(collect)
  }
  collect(tree)

  const skus = [...bySku.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (const sku of skus) {
    const { name, places } = bySku.get(sku)
    const total = places.reduce((acc, p) => ({
      on_hand: acc.on_hand + p.it.on_hand,
      reserved: acc.reserved + p.it.reserved,
      available: acc.available + p.it.available,
    }), { on_hand: 0, reserved: 0, available: 0 })
    const expiry = places.map(p => p.it.earliest_expiry).filter(Boolean).sort()[0]
    const key = `s${sku}`
    rows.push({
      key, kind: 'group', depth: 0, parents: [],
      label: name, mono: sku, sku,
      tags: itemTags(sku, products, isShelf),
      qty: total, expiry, collapsible: true,
    })
    places
      .sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }))
      .forEach(p => rows.push({
        key: `${key}-${p.node.id}`, kind: 'leaf', depth: 1, parents: [key],
        label: p.rel, locationId: p.node.id === tree.id ? null : p.node.id,
        qty: qtyOf(p.it), expiry: p.it.earliest_expiry,
        action: moveAction('transfer', p.node.id, p.rel, p.it.available, { sku, name }),
      }))
  }
  return rows
}

// ============================================================
// 货架结构：整个仓库存树 → 行（只有位置，不带商品明细）
// ============================================================
/**
 * 行额外带 cells: { sub, sku } 给结构页的「下層位置」「SKU 數」两栏
 * 根库位本层 = 未上架；带下层又有本层货的位置，本层单独成一行「（本層）」
 */
export function structureRows(tree) {
  const rows = []
  if (!tree) return rows

  function walk(node, depth, parents, isRoot) {
    const key = `n${node.id}`
    const t = node.total
    const empty = !hasQty(t)
    const hasKids = node.children.length > 0
    rows.push({
      key, kind: hasKids ? 'group' : 'leaf', depth, parents,
      label: isRoot ? node.full_name : node.name,
      // 根库位不给链接：点了会把几千个未上架 SKU 一起拉出来
      locationId: isRoot ? null : node.id,
      tags: empty && !isRoot ? [{ text: '空', cls: TAG.empty }] : [],
      qty: qtyOf(t),
      cells: { sub: t.location_count, sku: t.sku_count },
      collapsible: hasKids,
      muted: empty && !isRoot,
    })
    const inner = [...parents, key]
    if (hasQty(node.own) && (isRoot || hasKids)) {
      rows.push({
        key: `o${node.id}`, kind: 'leaf', depth: depth + 1, parents: inner,
        label: isRoot ? '未上架' : `${node.name}（本層）`,
        tags: isRoot ? [{ text: '庫存本層', cls: TAG.warn }] : [],
        qty: qtyOf(node.own),
        cells: { sub: null, sku: node.own.sku_count },
      })
    }
    node.children.forEach(c => walk(c, depth + 1, inner, false))
  }

  walk(tree, 0, [], true)
  return rows
}
