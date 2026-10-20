/**
 * 貨架管理 — 把后端返回的库位树「拍平」成分组列表的行
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

  function itemRows(items, depth, parents) {
    items.forEach(it => rows.push({
      key: `${parents[parents.length - 1]}-${it.sku}`, kind: 'leaf', depth, parents,
      label: it.name, mono: it.sku, sku: it.sku,
      tags: itemTags(it.sku, products, isShelf),
      qty: qtyOf(it), expiry: it.earliest_expiry,
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
        itemRows(items, depth + 2, [...inner, okey])
      } else {
        itemRows(items, depth + 1, inner)
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
      }))
  }
  return rows
}
