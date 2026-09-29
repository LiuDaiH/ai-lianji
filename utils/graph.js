// utils/graph.js —— 知识图谱布局（力导向 + 扇区分配）
//
// 思路：**坐标在 JS 里算好，canvas 只负责画。**
// 这样布局逻辑可以单独测试（不依赖渲染环境），也便于调参。
//
// 四种力 / 约束：
//   ① 斥力：所有节点两两排斥，避免重叠（远处忽略，省性能）
//   ② 弹簧：有边的节点互相吸引；「链接边」比「归属边」拉得更紧
//   ③ 向心力：卡片被拉向它所属的类别节点 —— 这是"类别作为骨架"的实现
//   ④ **扇区分配**：每个类别占多大角度，由它的卡片数决定 ——
//      卡片多的类别占更大的扇区，天然铺开。
//      这是治「某个节点下面东西太多、挤成一团乱麻」的关键：
//      光靠斥力是挤不开的，因为画布就只有那么大。
//
// 性能：斥力是 O(n²)。n=150 时 150²×220 迭代 ≈ 495 万次，JS 约 120ms 可接受。
// 超过 MAX_NOTES 先裁剪（页面负责提示用户）。

const MAX_NOTES = 150;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** 裁剪：卡片太多时，优先保留「链接多、复习次数多」的卡片 */
function trimNotes(notes, linksPerNote) {
  if (notes.length <= MAX_NOTES) return notes;
  const scored = notes.map((n) => ({
    n,
    s: (linksPerNote[n.id] || 0) * 3 + (n.reviewCount || 0),
  }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, MAX_NOTES).map((x) => x.n);
}

/**
 * 按「卡片数」给每个类别分配角度扇区
 *
 * 为什么需要它：类别节点原本是**均分一圈**的，于是一个装着 60 张卡的类别
 * 和一个装着 2 张卡的类别拿到同样宽的角度 —— 前者必然挤成一团。
 * 改成按卡片数比例分配：大类别占大扇区，卡片铺得开，一眼能数清。
 *
 * ⚠️ 键名用 `rawId`（= 真实的类别 id），因为卡片节点上的 `cat` 字段存的是 rawId。
 *    如果用图谱节点 id（带 `c:` 前缀）去数，会一个都数不到 —— 计数全 0，
 *    扇区退化成"每个类别一样宽"，看起来"改了个寂寞"。
 *
 * @param catList 类别节点 [{ id, rawId?, ... }]
 * @param notes   卡片节点（需带 cat 字段，值 = 类别 rawId）
 * @returns { [rawId]: { start, end, mid, span, count } }  弧度，从正上方开始顺时针
 */
function sectors(catList, notes, opts) {
  const o = opts || {};
  const minSpan = clamp(Number(o.minSpan) || 0.44, 0, Math.PI * 2);

  const counts = {};
  (notes || []).forEach((n) => {
    if (!n) return;
    const cid = n.cat || '__none__';
    counts[cid] = (counts[cid] || 0) + 1;
  });

  const list = (catList || []).map((c) => {
    const key = c.rawId || c.id;
    return { id: key, count: counts[key] || 0 };
  });
  if (!list.length) return {};

  const total = list.reduce((s, x) => s + x.count, 0) || 1;
  const free = Math.PI * 2 - minSpan * list.length;      // 扣掉最小扇区后剩多少可分配
  const raw = list.map((x) => minSpan + (free > 0 ? free * (x.count / total) : 0));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const k = (Math.PI * 2) / sum;                         // 归一化回整圆，防止溢出

  const out = {};
  let ang = -Math.PI / 2;                                // 从正上方开始
  list.forEach((x, i) => {
    const span = raw[i] * k;
    out[x.id] = { start: ang, end: ang + span, mid: ang + span / 2, span, count: x.count };
    ang += span;
  });
  return out;
}

/**
 * 计算布局
 * @param {{nodes: Array, edges: Array}} graph
 * @param {number} W 画布宽（逻辑像素）
 * @param {number} H 画布高
 * @param {Object} opts 调参
 * @returns {{nodes, edges, box}}
 */
function layout(graph, W, H, opts) {
  const o = opts || {};
  const ITER = o.iter || 220;
  const REP = o.repulsion || 6800;
  const SPRING = o.spring || 0.05;
  const SPRING_LEN = o.springLen || 70;
  const CENTER = o.center || 0.02;
  const WEDGE = o.wedge || 0.05;       // 扇区约束力（只纠角度，不改半径）
  const DAMP = 0.82;
  const MAXV = 14;
  const FAR2 = 46000;          // 超过这个距离平方就忽略斥力

  const nodes = graph.nodes.map((n) => Object.assign({}, n, { x: 0, y: 0, vx: 0, vy: 0, fixed: false }));
  const idx = {};
  nodes.forEach((n, i) => { idx[n.id] = i; });

  const cx = W / 2;
  const cy = H / 2;

  const cats = nodes.filter((n) => n.type === 'cat');
  const notes = nodes.filter((n) => n.type === 'note');

  // ---- 类别节点：环形排布，角度按卡片数分配（大类别占大扇区），并固定 ----
  const sec = sectors(cats, notes);
  const secOf = (cat) => sec[cat.rawId || cat.id] || sec[cat.id] || null;
  const baseR = Math.min(W, H) * 0.32;
  cats.forEach((c) => {
    const s = secOf(c) || { mid: 0, count: 0 };
    // 大类别稍微往外站一点，给扇区里的卡片留出弧长
    const R = baseR * (1 + Math.min(0.34, (s.count || 0) / 260));
    c.x = cx + Math.cos(s.mid) * R;
    c.y = cy + Math.sin(s.mid) * R;
    c.fixed = true;
  });

  // ---- 卡片节点：初始散布在「自己类别的那一瓣」里 ----
  notes.forEach((n) => {
    const c = nodes[idx['c:' + n.cat]];
    const s = sec[n.cat] || { start: 0, span: Math.PI * 2, count: 0 };
    const a = s.start + Math.random() * Math.max(0.25, s.span);
    const r = 22 + Math.random() * (34 + Math.min(96, (s.count || 0) * 3));
    n.x = (c ? c.x : cx) + Math.cos(a) * r;
    n.y = (c ? c.y : cy) + Math.sin(a) * r;
  });

  // ---- 迭代 ----
  for (let it = 0; it < ITER; it += 1) {
    const cool = 1 - (it / ITER) * 0.72;      // 逐渐冷却

    // ① 斥力
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      if (a.fixed) continue;
      for (let j = 0; j < nodes.length; j += 1) {
        if (i === j) continue;
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > FAR2) continue;
        if (d2 < 1) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const f = (REP / d2) * cool * 0.012;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
      }
    }

    // ② 弹簧
    for (let k = 0; k < graph.edges.length; k += 1) {
      const e = graph.edges[k];
      const a = nodes[idx[e.a]];
      const b = nodes[idx[e.b]];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      let target = SPRING_LEN;
      let stiff = SPRING;
      if (e.kind === 'belong') { target = SPRING_LEN * 0.85; stiff = SPRING * 0.9; }
      else if (e.kind === 'link') { target = SPRING_LEN * 0.62; stiff = SPRING * 1.7; }
      else if (e.kind === 'tree') { target = SPRING_LEN * 1.5; stiff = SPRING * 0.5; }
      const f = (d - target) * stiff * cool;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }

    // ③ 类别向心力
    for (let k = 0; k < notes.length; k += 1) {
      const n = notes[k];
      const c = nodes[idx['c:' + n.cat]];
      if (!c) continue;
      n.vx += (c.x - n.x) * CENTER * cool;
      n.vy += (c.y - n.y) * CENTER * cool;
    }

    // ④ 扇区约束：**窄扇区的类别最容易被大邻居挤出自己的地盘**
    //    （实测：一个大类别 + 一个小类别时，小类别的卡片只有 1/4 留在自己那一瓣）
    //    这里只纠「角度」不动「半径」—— 把卡片轻轻拉向自己扇区的中线。
    for (let k = 0; k < notes.length; k += 1) {
      const n = notes[k];
      const s = sec[n.cat];
      if (!s || s.span >= Math.PI * 0.75) continue;      // 宽扇区不用管
      const c = nodes[idx['c:' + n.cat]];
      if (!c) continue;
      const dx = n.x - c.x;
      const dy = n.y - c.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const tx = c.x + Math.cos(s.mid) * d;
      const ty = c.y + Math.sin(s.mid) * d;
      n.vx += (tx - n.x) * WEDGE * cool;
      n.vy += (ty - n.y) * WEDGE * cool;
    }

    // 积分 + 阻尼 + 限速
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      if (n.fixed) continue;
      n.vx *= DAMP;
      n.vy *= DAMP;
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > MAXV) { n.vx = (n.vx / sp) * MAXV; n.vy = (n.vy / sp) * MAXV; }
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  // ---- 归一化到画布（留边距）----
  const b = bounds(nodes);
  const pad = 30;
  const spanX = Math.max(1, b.maxX - b.minX);
  const spanY = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);

  nodes.forEach((n) => {
    n.x = pad + (n.x - b.minX) * scale;
    n.y = pad + (n.y - b.minY) * scale;
  });

  return { nodes, edges: graph.edges, box: bounds(nodes) };
}

/** 包围盒 */
function bounds(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  (nodes || []).forEach((n) => {
    if (!n) return;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  });
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/**
 * 算出一个能把 nodes 完整装进画布的视图（居中 + 等比缩放）
 * 用途：聚焦到某个类别后自动放大、以及「适配」按钮
 * @returns { scale, tx, ty }
 */
function fitView(nodes, W, H, opts) {
  const o = opts || {};
  const pad = typeof o.pad === 'number' ? o.pad : 34;
  const minS = typeof o.minScale === 'number' ? o.minScale : 0.6;
  const maxS = typeof o.maxScale === 'number' ? o.maxScale : 2.6;
  const b = bounds(nodes);
  const spanX = Math.max(24, b.maxX - b.minX);
  const spanY = Math.max(24, b.maxY - b.minY);
  const scale = clamp(Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY), minS, maxS);
  const mx = (b.minX + b.maxX) / 2;
  const my = (b.minY + b.maxY) / 2;
  return { scale, tx: W / 2 - mx * scale, ty: H / 2 - my * scale };
}

/**
 * 标签显示档位 —— 密度自适应，避免"糊成一片字"
 *   0 = 只显示类别标签（缩小看图时，画字只会更乱）
 *   1 = 类别 + 选中/聚焦节点的标签
 *   2 = 全部卡片标题
 */
function labelTier(scale, nodeCount) {
  const n = nodeCount || 0;
  if (n <= 30) return 2;                 // 图本来就小，直接全给
  if (scale < 0.8) return 0;
  if (n <= 55 || scale >= 1.35) return 2;
  return 1;
}

/**
 * 命中检测：找出离 (x, y) 最近的节点（用于拖拽 / 点击）
 * @returns {Object|null}
 */
function hitTest(nodes, x, y, radius) {
  const r = radius || 18;
  let best = null;
  let bestD = r * r;
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    const dx = n.x - x;
    const dy = n.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) { bestD = d2; best = n; }
  }
  return best;
}

/** 某个节点的关联邻居（只取卡片之间的 link 边）→ [{id, dir: 'out'|'in'}] */
function neighborsOf(edges, nodeId) {
  const out = [];
  const seen = {};
  (edges || []).forEach((e) => {
    if (!e || e.kind !== 'link') return;
    let id = null, dir = '';
    if (e.a === nodeId) { id = e.b; dir = 'out'; }
    else if (e.b === nodeId) { id = e.a; dir = 'in'; }
    if (id && !seen[id]) { seen[id] = true; out.push({ id, dir }); }
  });
  return out;
}

/** 节点半径 —— 类别节点按它装了多少张卡变大（一眼看出哪里是重灾区） */
function radiusOf(node) {
  if (node.type === 'cat') return 9 + Math.min(7, Math.sqrt(node.count || 0) * 1.6);
  if (node.level === 'mastered') return 6.5;
  if (node.level === 'learning') return 6;
  return 5.2;
}

const LEVEL_COLOR = {
  new: '#C2CAD8',          // 未学：灰
  learning: '#3B6FF5',     // 学习中：蓝
  mastered: '#34A853',     // 已掌握：绿
};

module.exports = {
  layout, sectors, bounds, fitView, labelTier,
  hitTest, neighborsOf, radiusOf, LEVEL_COLOR, MAX_NOTES, trimNotes, clamp,
};
