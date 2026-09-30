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

const MAX_NOTES = 420;          // 上限提高：靠「语义缩放 + 聚合 + 视口裁剪」扛，而不是硬砍

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
 * 层级扇区：**先把整圆分给顶级类别，再在父类的扇区里切给子类**
 *
 * 这样「继承关系」就变成了图像上的**嵌套**：子类永远落在父类那一瓣里，
 * 而且半径再往里一层。一眼能看出「子类属于谁」，不用去认虚线。
 *
 * @param catList 类别节点（需带 rawId 与 parent=父类别 id）
 * @param notes   卡片节点（需带 cat=类别 rawId）
 * @returns { [rawId]: { start, end, mid, span, depth, count } }  count = 子树卡片数
 */
function hierSectors(catList, notes, opts) {
  const o = opts || {};
  const minSpan = clamp(Number(o.minSpan) || 0.3, 0, Math.PI * 2);
  const counts = {};
  (notes || []).forEach((n) => {
    if (!n) return;
    const cid = n.cat || '__none__';
    counts[cid] = (counts[cid] || 0) + 1;
  });

  const list = (catList || []).map((c) => {
    const id = c.rawId || c.id;
    return { id, parent: c.parent || null, own: counts[id] || 0, children: [] };
  });
  if (!list.length) return {};

  const byId = {};
  list.forEach((x) => { byId[x.id] = x; });
  const roots = [];
  list.forEach((x) => {
    if (x.parent && byId[x.parent]) byId[x.parent].children.push(x);
    else roots.push(x);
  });

  const sumOf = (x) => {
    let n = x.own;
    x.children.forEach((c) => { n += sumOf(c); });
    x.sub = Math.max(1, n);
    return n;
  };
  roots.forEach(sumOf);

  const out = {};
  const place = (nodes, start, end, depth) => {
    const span = end - start;
    const total = nodes.reduce((a, x) => a + x.sub, 0) || 1;
    const free = span - minSpan * nodes.length;
    const raw = nodes.map((x) => minSpan + (free > 0 ? free * (x.sub / total) : 0));
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    const k = span / sum;
    let ang = start;
    nodes.forEach((x, i) => {
      const sp = raw[i] * k;
      out[x.id] = { start: ang, end: ang + sp, mid: ang + sp / 2, span: sp, depth, count: x.sub };
      if (x.children.length) {
        // 子类在父类扇区里再切一刀，两端各留 12% 边距，免得和邻居贴住
        const pad = sp * 0.12;
        place(x.children, ang + pad, ang + sp - pad, depth + 1);
      }
      ang += sp;
    });
  };
  place(roots, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, 0);
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
  // 迭代次数按规模自适应：n 大时少迭代几次（n=400 时 220 次就是 3500 万次运算，白等）
  const ITER = o.iter || Math.max(70, Math.min(220, Math.round(24000 / Math.max(20, graph.nodes.length))));
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

  // ---- 类别节点：角度按「子树卡片数」分配，**半径按层级往里收** ----
  //      顶级类别在最外环、它的子类在更内一环、且落在同一个角度范围里
  //      ⇒ 继承关系直接看得见（嵌套 + 同心环），不用去追虚线
  const sec = hierSectors(cats, notes);
  const secOf = (cat) => sec[cat.rawId || cat.id] || sec[cat.id] || null;
  const baseR = Math.min(W, H) * 0.37;
  cats.forEach((c) => {
    const s2 = secOf(c) || { mid: 0, count: 0, depth: 0, span: Math.PI * 2 };
    const depth = Math.min(2, s2.depth || 0);
    const R = baseR * (1 - depth * 0.28);
    c.x = cx + Math.cos(s2.mid) * R;
    c.y = cy + Math.sin(s2.mid) * R;
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

  // 圆心也跟着归一化：画「顶级类别的地盘扇形」要用它
  const center = {
    x: pad + (cx - b.minX) * scale,
    y: pad + (cy - b.minY) * scale,
  };
  return { nodes, edges: graph.edges, box: bounds(nodes), center };
}

/**
 * 把扇区信息与「环半径」挂到类别节点上，供绘制「顶级类别地盘扇形」用
 *
 * 环半径按**归一化后的真实距离**算（= 到圆心的距离），所以布局缓存命中、
 * 不跑 layout 的情况下也能正确补上。
 */
function annotateSectors(nodes, center) {
  const cats = (nodes || []).filter((n) => n && n.type === 'cat');
  const notes = (nodes || []).filter((n) => n && n.type === 'note');
  const sec = hierSectors(cats, notes);
  const c0 = center || { x: 0, y: 0 };
  cats.forEach((c) => {
    const s2 = sec[c.rawId || c.id]
      || { start: 0, end: Math.PI * 2, mid: 0, span: Math.PI * 2, depth: 0, count: 0 };
    c.sec = { start: s2.start, end: s2.end, mid: s2.mid, span: s2.span, depth: s2.depth || 0 };
    c.ring = Math.hypot(c.x - c0.x, c.y - c0.y);
  });
  return sec;
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
 * 语义缩放档位（semantic zoom）—— **同一个图，放大倍数不同，显示的信息粒度不同**
 *
 *   0  缩到最远：只画「类别 + 卡片数」的大圈，一整类卡片收成一个带数字的圈
 *   1  卡片点：能看到一张张卡，颜色 = 掌握度，但不写标题
 *   2  短标题：写 6 个字，能认出是哪个点
 *   3  精读：写长一点的标题 + 掌握度百分比，选中节点还高亮它的关联
 *
 * 这是"撑住几千张卡"的关键：靠缩放切换粒度，而不是硬砍节点。
 */
function lodOf(scale, nodeCount) {
  void nodeCount;
  const s = typeof scale === 'number' ? scale : 1;
  if (s < 0.55) return 0;
  if (s < 1.05) return 1;
  if (s < 1.75) return 2;
  return 3;
}

const LOD_TEXT = ['类别层', '卡片点', '短标题', '精读'];

/** 档位 → 中文说明（给界面角落的小字用） */
function lodText(lod) { return LOD_TEXT[lod] || LOD_TEXT[3]; }

/** 一个类别里的卡片太少就没必要聚合成圈 —— 小类别直接画点更好看也更准 */
const BLOB_MIN = 12;

/**
 * 聚合「圈」：把一个大类别里的卡片收成一个带数字的圈
 *
 * 为什么必须有它：几千张卡逐个画必然是糊的。缩小时先给你"这一块有 48 张"，
 * 想看细节就点它放大（语义缩放的自然交互）。
 *
 * @returns [{ id, rawId, x, y, r, count, level, label }]
 */
function blobsOf(nodes, opts) {
  const o = opts || {};
  const min = typeof o.min === 'number' ? o.min : BLOB_MIN;
  const catOf = {};
  const catLabel = {};
  (nodes || []).forEach((n) => {
    if (!n) return;
    if (n.type === 'cat') catLabel[n.rawId || n.id] = n.label;
  });

  const buckets = {};
  (nodes || []).forEach((n) => {
    if (!n || n.type !== 'note') return;
    const cid = n.cat || '__none__';
    (buckets[cid] = buckets[cid] || []).push(n);
  });

  const out = [];
  Object.keys(buckets).forEach((cid) => {
    const arr = buckets[cid];
    if (arr.length < min) return;
    let sx = 0, sy = 0;
    const lv = { new: 0, learning: 0, mastered: 0 };
    arr.forEach((n) => {
      sx += n.x; sy += n.y;
      lv[n.level] = (lv[n.level] || 0) + 1;
    });
    const x = sx / arr.length;
    const y = sy / arr.length;
    // 半径随张数次线性增长（sqrt），再夹在合理区间
    const r = clamp(Math.sqrt(arr.length) * 3.2 + 5, 12, 62);
    // 代表档位：取最多的那一档
    let level = 'new';
    let best = -1;
    Object.keys(lv).forEach((k) => { if (lv[k] > best) { best = lv[k]; level = k; } });
    out.push({ id: 'b:' + cid, rawId: cid, x, y, r, count: arr.length, level,
               label: catLabel[cid] || '未分类' });
  });
  out.sort((a, b) => b.count - a.count);
  return out;
}

/** 视口裁剪：这个点在当前视图里吗（带 margin，边缘不至于突然消失） */
function inView(x, y, view, W, H, margin) {
  const m = typeof margin === 'number' ? margin : 28;
  const sx = x * view.scale + view.tx;
  const sy = y * view.scale + view.ty;
  return sx >= -m && sy >= -m && sx <= W + m && sy <= H + m;
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
  layout, sectors, hierSectors, annotateSectors, bounds, fitView,
  lodOf, lodText, blobsOf, inView, BLOB_MIN,
  hitTest, neighborsOf, radiusOf, LEVEL_COLOR, MAX_NOTES, trimNotes, clamp,
};
