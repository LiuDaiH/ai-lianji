// utils/tree.js —— 真正的「节点—连线」树形图布局引擎
//
// 为什么要自己算：小程序 WXML 不支持内联 <svg>，所以节点和连线都用绝对定位的
// view 拼出来。连线走正交折线（横 → 竖 → 横），比斜线更好画、也更像思维导图。
//
// 布局约定：
//   横向树 —— 根在最左，子节点向右展开；depth 决定 x，叶子顺序决定 y
//   父节点的 y = 首末子节点的 y 的中值（经典 tidy tree 简化版）
//
// 输出的是「像素」坐标，页面外面套一个 transform: scale() 就得到缩放能力。

function layout(topList, opts) {
  const o = Object.assign({ col: 130, row: 36, pad: 26 }, opts || {});
  const nodes = [];
  let leaf = 0;

  function place(list, depth) {
    return (list || []).map((n) => {
      const item = {
        id: n.id,
        name: n.name,
        count: n.count || 0,
        pct: n.pct || 0,
        tier: n.tier || 'new',
        depth,
        hasChildren: !!(n.children && n.children.length),
        expanded: !!n.expanded,
        children: [],
      };
      item.x = o.pad + depth * o.col;
      nodes.push(item);

      item.children = (n.expanded && n.children) ? place(n.children, depth + 1) : [];

      if (item.children.length) {
        const first = item.children[0];
        const last = item.children[item.children.length - 1];
        item.y = (first.y + last.y) / 2;
      } else {
        item.y = o.pad + leaf * o.row;
        leaf += 1;
      }
      return item;
    });
  }

  const placed = place(topList || [], 0);

  // 连线：父 → 子的正交折线
  const edges = [];
  const collect = (list) => {
    (list || []).forEach((it) => {
      it.children.forEach((c) => {
        edges.push({
          id: it.id + '_' + c.id,
          x1: it.x, y1: it.y,
          midX: it.x + o.col / 2,
          x2: c.x, y2: c.y,
        });
      });
      collect(it.children);
    });
  };
  collect(placed);

  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  return {
    nodes,
    edges,
    width: Math.round(o.pad * 2 + maxDepth * o.col + 118),
    height: Math.round(o.pad * 2 + Math.max(leaf, 1) * o.row),
    leaves: leaf,
  };
}

/**
 * 类别 + 卡片 → 嵌套树（供 layout 消费）
 * @param all      cat.list()
 * @param childrenOf (parentId) => 子类别数组
 * @param expanded  { catId: true }
 * @param metric    (catId) => { count, pct, tier }
 * @param parentId  当前父 id（递归用）
 */
function buildNested(childrenOf, expanded, metric, parentId) {
  const o = Object.assign({}, expanded || {});
  const walk = (pid) => childrenOf(pid).map((c) => {
    const m = metric ? metric(c.id) : { count: 0, pct: 0, tier: 'new' };
    const kids = walk(c.id);
    return {
      id: c.id,
      name: c.name,
      count: m.count,
      pct: m.pct,
      tier: m.tier,
      expanded: !!o[c.id],
      children: kids,
    };
  });
  return walk(parentId === undefined ? null : parentId);
}

/**
 * 径向发散布局 —— 像 Obsidian Graph View 那种从中心向外辐射的图
 *
 * 和横向树的关键区别：这里**不做折叠**，永远是整棵树的"地图"，
 * 所以进来看得见全貌，也就能直接点任意节点。
 *
 * 三个步骤：
 *   ① 叶子分角度槽位 → 父节点角度 = 首末子节点角度的中值（子节点自然聚在父节点扇区里）
 *   ② 每一环的半径：既要比内环大一截，也要保证环上最挤的两个节点不重叠
 *      （r ≥ 最小间距 ÷ 最小角间隔，这是防重叠的关键）
 *   ③ 按极坐标落点；连线是直线，用 rotate + 长度画
 */
function radialLayout(topList, opts) {
  const o = Object.assign({
    nodeW: 78,        // 节点胶囊宽
    minGapPx: 88,     // 同环相邻节点的最小弧长（略大于 nodeW 就有呼吸感）
    innerR: 74,       // 第一环半径
    ringStep: 62,     // 相邻环的最小半径差
    pad: 46,
    centerName: '',   // 中心节点文案
    centerId: '__root__',
  }, opts || {});

  const TWOPI = Math.PI * 2;

  /* ---- ① 分角度槽位 ---- */
  let leafIdx = 0;
  const assign = (list) => (list || []).map((n) => {
    const kids = n.children || [];
    if (kids.length) {
      const ks = assign(kids);
      return { n, slot: (ks[0].slot + ks[ks.length - 1].slot) / 2, kids: ks };
    }
    const s = leafIdx + 0.5;
    leafIdx += 1;
    return { n, slot: s, kids: [] };
  });
  const roots = assign(topList);
  const leaves = Math.max(leafIdx, 1);

  /* ---- ② 逐环算半径 ---- */
  // slot → 角度：减掉半格，让「第一个节点」落在正上方（单节点时也正好在顶部）
  const ang = (slot) => ((slot - 0.5) / leaves) * TWOPI - Math.PI / 2;

  const byDepth = {};
  (function collect(list, depth) {
    list.forEach((it) => {
      (byDepth[depth] || (byDepth[depth] = [])).push(ang(it.slot));
      collect(it.kids, depth + 1);
    });
  })(roots, 0);

  const radii = [];
  Object.keys(byDepth).map(Number).sort((a, b) => a - b).forEach((d) => {
    const angles = byDepth[d].slice().sort((a, b) => a - b);
    let minGap = TWOPI;
    for (let i = 1; i < angles.length; i += 1) {
      minGap = Math.min(minGap, angles[i] - angles[i - 1]);
    }
    if (angles.length > 1) minGap = Math.min(minGap, TWOPI - (angles[angles.length - 1] - angles[0]));
    const need = o.minGapPx / Math.max(minGap, 0.0001);     // 按最挤处反推半径
    const prev = d === 0 ? 0 : radii[d - 1];
    radii[d] = Math.max(d === 0 ? o.innerR : prev + o.ringStep, need);
  });

  const maxR = radii.length ? radii[radii.length - 1] : o.innerR;
  const half = Math.round(maxR + Math.max(o.nodeW, 46) / 2 + o.pad);
  const cx = half;
  const cy = half;
  const nodes = [];
  const edges = [];

  /* ---- ③ 落点 ---- */
  const place = (list, depth, parentPt) => list.forEach((it) => {
    const r = radii[depth];
    const a = ang(it.slot);
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    const node = {
      id: it.n.id,
      name: it.n.name,
      count: it.n.count || 0,
      pct: it.n.pct || 0,
      tier: it.n.tier || 'new',
      depth,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      hasChildren: !!(it.n.children && it.n.children.length),
      isCenter: false,
    };
    nodes.push(node);

    const dx = node.x - parentPt.x;
    const dy = node.y - parentPt.y;
    edges.push({
      id: parentPt.id + '_' + node.id,
      x1: parentPt.x, y1: parentPt.y,
      len: Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10,
      rot: Math.round((Math.atan2(dy, dx) * 180 / Math.PI) * 100) / 100,
    });

    place(it.kids, depth + 1, node);
  });

  const center = {
    id: o.centerId, name: o.centerName, count: 0, pct: 0, tier: 'root',
    depth: -1, x: cx, y: cy, hasChildren: !!roots.length, isCenter: true,
  };
  place(roots, 0, center);
  nodes.unshift(center);

  return {
    nodes, edges,
    width: half * 2,
    height: half * 2,
    cx, cy,
    leaves,
    rings: radii.length,
    maxR: Math.round(maxR),
  };
}

module.exports = { layout, radialLayout, buildNested };
