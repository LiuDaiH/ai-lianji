// pages/graph/graph.js —— 知识图谱（canvas 力导向 + 聚焦 / 抽屉 / 动画）
//
// 关键点：
//   ① 布局在 utils/graph.js 里算好（纯 JS），canvas 只负责画
//   ② canvas 用 type="2d"，要按 dpr 放大再 scale，否则在高清屏上糊
//   ③ 触摸坐标是**相对 canvas** 的（e.touches[0].x/y），不是相对页面
//   ④ 用「拖动阈值」区分「点击」和「拖动」
//
// 这一版补的是"看得清、点得动、有反馈"：
//   · 密度自适应：类别按卡片数分扇区（utils/graph.js），标签按缩放分档
//   · 聚焦：双击类别 → 只留这一块，其余淡出 + 自动居中放大
//   · 抽屉：点类别列出它下面的卡片、点卡片列出它的关联卡片，都能直接点进详情
//   · **反馈全部走视觉，不用震动**：按下即放大 + 外圈光晕、点击时脉冲波 + 回弹，
//     选中节点的关联边加粗高亮，视图/淡入淡出/抽屉都是平滑过渡
const store = require('../../utils/store.js');
const cat = require('../../utils/category.js');
const link = require('../../utils/link.js');
const graphLib = require('../../utils/graph.js');

const LW = 375, LH = 420;          // 逻辑尺寸（wxml 里 canvas 的尺寸与之对齐）
const DRAG_THRESHOLD = 6;
const DBL_MS = 320;                // 双击判定窗口
const MIN_SCALE = 0.45;
const MAX_SCALE = 2.8;
const SHEET_CAP = 120;             // 抽屉一次最多列多少条
const ROW_H = 52;                  // 抽屉里一行的估算高度（px，用来算列表高度）
const SHEET_LIST_MAX = 198;        // ⚠️ 抽屉别盖满画布 —— 上限压到 ~200px，上面始终留得下图
const POP_MS = 260;                // 点击回弹时长

const LEVEL_TEXT = { new: '未学', learning: '学习中', mastered: '已掌握' };

Page({
  data: {
    stats: { notes: 0, cats: 0, links: 0, linkedNotes: 0, unlinked: 0 },
    legend: [
      { color: '#C2CAD8', label: '未学' },
      { color: '#3B6FF5', label: '学习中' },
      { color: '#34A853', label: '已掌握' },
    ],
    onlyLinked: false,
    empty: false,
    trimmed: 0,                    // 被裁掉不画的卡片数
    shown: 0,                      // 图上实际画了多少张
    zoomPct: 100,
    labelText: '类别+卡片',
    focus: null,                   // { id, title } 当前聚焦的类别
    // 首次进页的引导
    tourActive: false, tourFlow: 'graph', pageStyle: '',
    sheet: { show: false, kind: '', rawId: '', nodeId: '', title: '', sub: '', items: [], total: 0, more: 0, focusOn: false, listH: 120 },
  },

  onLoad() {
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.viewTarget = null;
    this.nodes = [];
    this.edges = [];
    this._idx = {};
    this.dragging = null;
    this.pressed = null;
    this.selId = null;
    this.moved = false;
    this.pinch = null;
    this.pulse = null;
    this.pop = null;
    this._focus = null;
    this._lastTap = null;
    this._lastBlank = null;
    this._ready = false;
    this._playing = false;
  },

  onReady() {
    this.initCanvas().then(() => {
      this.build(this.dataSig());
      // 第一次进图谱页自动走一遍引导。
      // ⚠️ 标记要在**一开始**就写上：原来只在"走完/跳过"时才写，用户没走完 →
      //    下次进页又自动放一遍 → 整页被引导蒙层盖住，「? 怎么看」怎么点都点不开
      if (!wx.getStorageSync('sc_tour_done_graph')) {
        wx.setStorageSync('sc_tour_done_graph', 1);
        this.setData({ tourActive: true });
      }
    });
  },

  onShow() {
    if (!this._ready) return;
    // ⚠️ 从卡片详情返回时**不要重建**：重建会把聚焦状态和你看好的视角一起清掉。
    //    只有卡片数据真的变了（改了类别、练过一轮）才重排。
    const sig = this.dataSig();
    if (this._sig === sig && this.nodes.length) { this.draw(); return; }
    this.build(sig);
  },

  /** 数据指纹：卡片数 + 每张卡的 id/复习次数/类别（够灵敏，又不至于每次拼一大串） */
  dataSig() {
    const all = store.listNotes();
    let h = 0;
    all.forEach((n) => {
      const s = n.id + '|' + (n.categoryId || '') + '|' + (n.reviewCount || 0) + '|' + (n.alpha || 0) + (n.beta || 0);
      for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
    });
    return all.length + ':' + h;
  },

  onUnload() {
    this._gone = true;                 // 卸载后别再排动画帧
    this._playing = false;
    this.viewTarget = null;
    this.pulse = null;
    this.pop = null;
  },

  initCanvas() {
    return new Promise((resolve) => {
      wx.createSelectorQuery().select('#gcv')
        .fields({ node: true, size: true, rect: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) {
            wx.showToast({ title: 'canvas 初始化失败', icon: 'none' });
            resolve();
            return;
          }
          const cv = res[0].node;
          let dpr = 2;
          try {
            const i = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
            dpr = i.pixelRatio || 2;
          } catch (e) { dpr = 2; }
          // canvas 在页面里的位置 —— 触摸事件万一不给 x/y，靠它换算
          this._rect = { left: res[0].left || 0, top: res[0].top || 0 };
          this.canvas = cv;
          this.ctx = cv.getContext('2d');
          this.W = res[0].width || LW;
          this.H = res[0].height || LH;
          cv.width = this.W * dpr;
          cv.height = this.H * dpr;
          this.ctx.scale(dpr, dpr);
          this._ready = true;
          resolve();
        });
    });
  },

  /* ==================== 数据 + 布局 ==================== */

  build(sig) {
    if (!this._ready) return;
    this._sig = sig !== undefined ? sig : this.dataSig();
    const all = store.listNotes();
    const cats = cat.list();
    const s = link.summary(all, cats);

    // 一次算好每张卡的「关联度」：只看关联时要过滤、裁剪时要按它排序，两处都用得上
    const idx = link.buildIndices(all);
    const deg = {};
    all.forEach((n) => { deg[n.id] = 0; });
    all.forEach((n) => {
      link.outLinkIds(all, n, idx).forEach((t) => {
        deg[n.id] += 1;
        deg[t] = (deg[t] || 0) + 1;
      });
    });
    this._deg = deg;

    let notes = this.data.onlyLinked ? all.filter((n) => deg[n.id] > 0) : all;

    const total = notes.length;
    let trimmed = 0;
    if (total > graphLib.MAX_NOTES) {
      // 卡片太多先按「关联多 + 练得多」裁剪，否则布局会卡；抽屉里仍是全部
      notes = graphLib.trimNotes(notes, deg);
      trimmed = total - notes.length;
    }

    if (!notes.length) {
      this.nodes = []; this.edges = []; this._idx = {};
      this._focus = null;
      this.setData({ stats: s, empty: all.length === 0, trimmed: 0, shown: 0, focus: null });
      this.closeSheet();
      this.draw();
      return;
    }

    const g = link.buildGraph(notes, cats);
    const out = graphLib.layout(g, this.W, this.H, {});
    // _g = 入场进度（0→1）：打开页面时节点依次弹出，别一上来就一坨静态点
    // 入场动画只在**第一次**画出来时播；重排 / 切筛选不播（否则每次都"蹦一遍"，像卡顿）
    const playEnter = !this._enterDone;
    this._enterDone = true;
    this.nodes = out.nodes.map((n, i) => Object.assign(n, { _a: 1, _g: playEnter ? 0 : 1, _i: i }));
    this._enterT0 = playEnter ? Date.now() : null;
    this.edges = out.edges;
    this._idx = {};
    this.nodes.forEach((n) => { this._idx[n.id] = n; });

    // 换了图就退出聚焦，并把视图一次适配好
    this._focus = null;
    this.selId = null;
    const v = graphLib.fitView(this.nodes, this.W, this.H, { pad: 34 });
    this.view = v;
    this.viewTarget = null;
    this.pulse = null;
    this.pop = null;

    this.closeSheet();
    this.setData({
      stats: s, empty: false, trimmed, shown: notes.length,
      focus: null,
      zoomPct: Math.round(v.scale * 100),
      labelText: this.labelTextOf(),
    });
    this.draw();
    this.play();          // 入场动画：节点依次弹出
  },

  labelTextOf() {
    const t = graphLib.labelTier(this.view.scale, this.nodes.length);
    return t === 2 ? '类别+卡片' : (t === 1 ? '类别+选中' : '仅类别');
  },

  onToggleFilter() {
    this.setData({ onlyLinked: !this.data.onlyLinked }, () => this.build());
  },

  onRelayout() {
    wx.showLoading({ title: '重新排布中' });
    setTimeout(() => {
      this.build();
      wx.hideLoading();
    }, 30);
  },

  onFit() {
    if (!this.nodes.length) return;
    this.viewTarget = graphLib.fitView(this.nodes, this.W, this.H, { pad: 34 });
    this.play();
  },

  /* ==================== 缩放 ==================== */

  onZoom(e) {
    const d = e.currentTarget.dataset.d;
    if (d === 'fit') { this.onFit(); return; }
    this.zoomAt(this.W / 2, this.H / 2, d === 'in' ? 1.28 : 1 / 1.28);
  },

  /** 以画布上某点为锚点缩放（锚点下的内容保持不动） */
  zoomAt(x, y, k) {
    const cur = this.viewTarget || this.view;
    const s = graphLib.clamp(cur.scale * k, MIN_SCALE, MAX_SCALE);
    const gx = (x - cur.tx) / cur.scale;
    const gy = (y - cur.ty) / cur.scale;
    this.viewTarget = { scale: s, tx: x - gx * s, ty: y - gy * s };
    this.play();
  },

  /* ==================== 聚焦 ==================== */

  /** catId 为空 → 退出聚焦 */
  setFocus(catId) {
    if (catId) {
      const node = this.nodes.filter((n) => n.type === 'cat' && n.rawId === catId)[0];
      const all = cat.list();
      const ids = cat.descendants(all, catId);
      const inside = {};
      this.nodes.forEach((n) => {
        if (n.type === 'note' && ids[n.cat]) inside[n.id] = true;
      });
      this._focus = { catId, inside };
      this.setData({ focus: { id: catId, title: (node && node.label) || '类别' } });
      // 自动缩放到这一块（节点太少时不放太大，免得糊）
      const sub = this.nodes.filter((n) => (n.type === 'cat' && n.rawId === catId) || inside[n.id]);
      this.viewTarget = graphLib.fitView(sub.length >= 3 ? sub : this.nodes, this.W, this.H,
        { pad: 44, maxScale: 2.0 });
    } else {
      this._focus = null;
      this.setData({ focus: null });
      this.viewTarget = graphLib.fitView(this.nodes, this.W, this.H, { pad: 34 });
    }
    this.play();
  },

  /**
   * 工具行里的「◎ 聚焦」
   *   已经在聚焦 → 退出
   *   选中了类别 → 直接聚焦它
   *   什么都没选 → **弹出类别列表让你挑**（按钮辅助：不用先去点中那个小圆点）
   */
  onFocusTool() {
    if (this.data.focus) { this.setFocus(null); return; }
    const sel = this.selId ? this.nodes.filter((n) => n.id === this.selId)[0] : null;
    if (sel && sel.type === 'cat') {
      this.hideSheet();
      this.setFocus(sel.rawId);
      this.play();
      return;
    }
    this.showCatPick();
  },

  /** 「☰ 清单」：列出全部卡片，点一条就在图上把它居中选中 */
  onCardList() {
    const notes = store.listNotes();
    const names = {};
    cat.list().forEach((c) => { names[c.id] = c.name; });
    const list = notes.filter((n) => n && n.title)
      .slice().sort((a, b) => (a.reviewCount || 0) - (b.reviewCount || 0));
    const items = list.slice(0, SHEET_CAP).map((n) => ({
      id: n.id, title: n.title, level: link.masteryLevel(n),
      meta: (LEVEL_TEXT[link.masteryLevel(n)] || '') + ' · 练过 ' + (n.reviewCount || 0) + ' 次'
            + (names[n.categoryId] ? ' · ' + names[n.categoryId] : ''),
    }));
    this.setData({
      sheet: {
        show: true, kind: 'cards', rawId: '', nodeId: '',
        title: '全部卡片', sub: '最薄的排前面 · 点一条就在图上定位它',
        total: list.length, items, more: Math.max(0, list.length - items.length),
        focusOn: false,
        listH: Math.min(SHEET_LIST_MAX, Math.max(96, Math.max(1, items.length) * ROW_H)),
      },
    });
  },

  /** 类别列表（给「◎ 聚焦」用） */
  showCatPick() {
    const allCats = cat.list();
    const notes = store.listNotes();
    const catIds = {};
    const counts = {};
    allCats.forEach((c) => { catIds[c.id] = true; });
    notes.forEach((n) => {
      const cid = (n.categoryId && catIds[n.categoryId]) ? n.categoryId : '__none__';
      counts[cid] = (counts[cid] || 0) + 1;
    });
    const rows = allCats.map((c) => ({ id: c.id, name: c.name, count: counts[c.id] || 0 }));
    if (counts.__none__) rows.push({ id: '__none__', name: '未分类', count: counts.__none__ });
    rows.sort((a, b) => b.count - a.count);
    const items = rows.map((r) => ({
      id: 'cat:' + r.id, catId: r.id, title: r.name, level: 'cat', meta: r.count + ' 张卡片',
    }));
    this.setData({
      sheet: {
        show: true, kind: 'catpick', rawId: '', nodeId: '',
        title: '选一个类别', sub: '点它就只看这一块（卡片多的排前面）',
        total: rows.length, items, more: 0, focusOn: false,
        listH: Math.min(SHEET_LIST_MAX, Math.max(96, Math.max(1, items.length) * ROW_H)),
      },
    });
  },

  /** 把某张卡在图上居中放大并选中（按钮辅助：不用去点那个小圆点） */
  locateNote(id) {
    this.setData({ 'sheet.show': false });
    const n = this.nodes.filter((x) => x.type === 'note' && x.rawId === id)[0];
    if (!n) {
      // 被「只看关联」滤掉、或被 150 张的裁剪裁掉了 → 别让用户白点，直接打开它
      wx.showToast({ title: '这张卡没画在图上，直接打开它', icon: 'none' });
      this.openNote(id);
      return;
    }
    const now = Date.now();
    this.selId = n.id;
    this.pop = { node: n, t0: now };
    this.pulse = { node: n, t0: now };
    const k = Math.max(this.view.scale, 1.5);
    this.viewTarget = { scale: k, tx: this.W / 2 - n.x * k, ty: this.H / 2 - n.y * k };
    this.play();
  },

  onClearFocus() {
    this.setFocus(null);
  },

  onToggleFocus() {
    const s = this.data.sheet;
    if (s.kind !== 'cat') return;
    const on = this.data.focus && this.data.focus.id === s.rawId;
    this.setFocus(on ? null : s.rawId);
    this.setData({
      'sheet.focusOn': !on,
      // 用 total（真实张数），不是 items.length（列表最多只列 SHEET_CAP 条）
      'sheet.sub': (s.total || s.items.length) + ' 张卡片' + (!on ? ' · 聚焦中' : ''),
    });
  },

  /** 聚焦时：不在聚焦范围内的节点淡出 */
  alphaTarget(n) {
    const f = this._focus;
    if (!f) return 1;
    if (n.type === 'cat') return n.rawId === f.catId ? 1 : 0.16;
    return f.inside[n.id] ? 1 : 0.1;
  },

  /* ==================== 动画 ==================== */

  raf(cb) {
    const cv = this.canvas;
    if (cv && typeof cv.requestAnimationFrame === 'function') return cv.requestAnimationFrame(cb);
    return setTimeout(cb, 16);
  },

  /** 只要还有动画没跑完就一直往下画帧 */
  play() {
    if (!this._ready || this._playing) return;
    this._playing = true;
    const step = () => {
      if (this.frame()) { this._raf = this.raf(step); }
      else { this._playing = false; this._raf = null; }
    };
    this._raf = this.raf(step);
  },

  /** 走一帧：返回 true 表示还需要下一帧 */
  frame() {
    if (this._gone) return false;
    let more = false;

    // ① 淡入淡出
    for (let i = 0; i < this.nodes.length; i += 1) {
      const n = this.nodes[i];
      const t = this.alphaTarget(n);
      const cur = typeof n._a === 'number' ? n._a : 1;
      if (Math.abs(cur - t) > 0.012) { n._a = cur + (t - cur) * 0.2; more = true; }
      else n._a = t;
    }

    // ② 视图过渡
    if (this.viewTarget) {
      const v = this.view, t = this.viewTarget;
      let done = true;
      if (Math.abs(t.scale - v.scale) > 0.004) { v.scale += (t.scale - v.scale) * 0.26; done = false; }
      else v.scale = t.scale;
      if (Math.abs(t.tx - v.tx) > 0.6) { v.tx += (t.tx - v.tx) * 0.26; done = false; }
      else v.tx = t.tx;
      if (Math.abs(t.ty - v.ty) > 0.6) { v.ty += (t.ty - v.ty) * 0.26; done = false; }
      else v.ty = t.ty;
      if (done) {
        this.viewTarget = null;
        this.setData({ zoomPct: Math.round(v.scale * 100), labelText: this.labelTextOf() });
      } else more = true;
    }

    // ③ 入场：节点依次放大淡入（只播一次，短平快）
    if (this._enterT0) {
      const el = Date.now() - this._enterT0;
      let pending = false;
      for (let i = 0; i < this.nodes.length; i += 1) {
        const n = this.nodes[i];
        const delay = Math.min(i * 3, 180);              // 错峰但总时长封顶
        const k = Math.min(1, Math.max(0, (el - delay) / 300));
        n._g = 1 - Math.pow(1 - k, 3);                   // ease-out
        if (k < 1) pending = true;
      }
      if (!pending) this._enterT0 = null;
      else more = true;
    }

    // ④ 点击回弹 + 脉冲波（视觉反馈，替代震动）
    if (this.pop && (Date.now() - this.pop.t0) / POP_MS >= 1) this.pop = null;
    if (this.pop) more = true;
    if (this.pulse) {
      if ((Date.now() - this.pulse.t0) / 380 >= 1) this.pulse = null;
      else more = true;
    }

    this.draw();
    return more;
  },

  /* ==================== 绘制 ==================== */

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#FBFCFE';
    ctx.fillRect(0, 0, W, H);

    if (!this.nodes.length) {
      ctx.fillStyle = '#A8AEBC';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('还没有可展示的卡片', W / 2, H / 2);
      return;
    }

    ctx.save();
    ctx.translate(this.view.tx, this.view.ty);
    ctx.scale(this.view.scale, this.view.scale);

    const idx = this._idx;
    const selId = this.selId;
    const tier = graphLib.labelTier(this.view.scale, this.nodes.length);
    // 统一可见度 = 聚焦淡出(_a) × 入场进度(_g)
    const visOf = (n) => (typeof n._a === 'number' ? n._a : 1) * (typeof n._g === 'number' ? n._g : 1);

    // ---- 边 ----
    // 选中某张卡时，它的关联边加粗高亮，其余降一档，关系一眼可见
    const touch = {};
    if (selId && idx[selId]) {
      touch[selId] = true;
      this.edges.forEach((e) => {
        if (e.a === selId) touch[e.b] = true;
        else if (e.b === selId) touch[e.a] = true;
      });
    }

    this.edges.forEach((e) => {
      const a = idx[e.a], b = idx[e.b];
      if (!a || !b) return;
      const alpha = Math.min(visOf(a), visOf(b), 1);
      if (alpha < 0.08) return;
      const hot = selId && (e.a === selId || e.b === selId);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (hot) {
        ctx.strokeStyle = e.kind === 'link'
          ? 'rgba(59,111,245,' + (0.9 * alpha) + ')'
          : 'rgba(120,134,158,' + (0.75 * alpha) + ')';
        ctx.lineWidth = e.kind === 'link' ? 2.4 : 1.8;
        ctx.setLineDash(e.kind === 'tree' ? [5, 4] : []);
      } else if (e.kind === 'link') {
        ctx.strokeStyle = 'rgba(59,111,245,' + (0.72 * alpha) + ')';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
      } else if (e.kind === 'tree') {
        ctx.strokeStyle = 'rgba(150,160,180,' + (0.85 * alpha) + ')';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
      } else {
        ctx.strokeStyle = 'rgba(195,204,219,' + (0.55 * alpha) + ')';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // ---- 节点 ----
    this.nodes.forEach((n) => {
      const a = visOf(n);
      if (a < 0.08) return;
      const enter = 0.32 + 0.68 * (typeof n._g === 'number' ? n._g : 1);   // 入场时从小长到大
      const pressed = this.pressed === n;
      const sel = selId === n.id;
      let r = graphLib.radiusOf(n) * enter;
      if (pressed) r *= 1.3;
      else if (sel) r *= 1.2;
      // 点击回弹：先鼓一下再收回（sin 曲线，比单纯放大更"有弹性"）
      if (this.pop && this.pop.node === n) {
        const k = Math.min(1, (Date.now() - this.pop.t0) / POP_MS);
        r *= 1 + 0.26 * Math.sin(Math.PI * k);
      }

      ctx.globalAlpha = a;

      // 选中/按下的外圈光晕
      if (sel || pressed) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4.5, 0, Math.PI * 2);
        ctx.fillStyle = n.type === 'cat' ? 'rgba(43,58,85,.16)' : 'rgba(240,133,31,.18)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      if (n.type === 'cat') {
        ctx.fillStyle = '#2B3A55';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(43,58,85,.22)';
        ctx.stroke();
      } else {
        ctx.fillStyle = graphLib.LEVEL_COLOR[n.level] || '#C2CAD8';
        ctx.fill();
        if (sel || pressed) {
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#F0851F';
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    });

    // ---- 点击脉冲：一圈向外扩散的波 ----
    if (this.pulse && idx[this.pulse.node.id]) {
      const p = this.pulse.node;
      const k = Math.max(0, Math.min(1, (Date.now() - p.t0) / 380));
      const r0 = graphLib.radiusOf(p) + 2;
      ctx.globalAlpha = (1 - k) * 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r0 + k * 20, 0, Math.PI * 2);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = p.type === 'cat' ? '#2B3A55' : '#F0851F';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---- 标签（带浅色描边，压在连线/节点上也看得清）----
    ctx.textAlign = 'center';
    this.nodes.forEach((n) => {
      const a = visOf(n);
      if (a < 0.5) return;                       // 淡出 / 还没入场完的节点不写标签
      const isSel = selId === n.id || this.pressed === n;
      const show = n.type === 'cat' ? true : (tier === 2 || isSel);
      if (!show) return;
      const r = graphLib.radiusOf(n);
      const txt = String(n.label || '').slice(0, n.type === 'cat' ? 8 : 7);
      if (!txt) return;

      ctx.font = n.type === 'cat' ? 'bold 11px sans-serif' : '9px sans-serif';
      ctx.fillStyle = n.type === 'cat' ? '#2B3A55' : 'rgba(70,78,96,.92)';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(251,252,254,.92)';
      ctx.globalAlpha = a;
      const ty = n.y + r + (n.type === 'cat' ? 13 : 10);
      ctx.strokeText(txt, n.x, ty);
      ctx.fillText(txt, n.x, ty);
      ctx.globalAlpha = 1;
    });

    ctx.restore();
  },

  /* ==================== 触摸 ==================== */

  /**
   * 触摸点 → canvas 坐标系
   *
   * ⚠️ canvas 的触摸事件通常带 `touches[i].x/y`（相对 canvas 左上角），但**不是所有环境都给**。
   * 老代码直接读 `.x`，一旦拿不到就是 undefined → hitTest 永远落空 → "点了没反应"。
   * 这里做兜底：没有 x/y 就用 clientX/clientY 减去 canvas 的位置自己算。
   */
  pt(t) {
    if (t && typeof t.x === 'number' && typeof t.y === 'number') return { x: t.x, y: t.y };
    const r = this._rect || { left: 0, top: 0 };
    const cx = (t && (t.clientX != null ? t.clientX : t.pageX)) || 0;
    const cy = (t && (t.clientY != null ? t.clientY : t.pageY)) || 0;
    return { x: cx - r.left, y: cy - r.top };
  },

  ptsOf(e) {
    const out = [];
    const ts = (e && e.touches) || [];
    for (let i = 0; i < ts.length; i += 1) out.push(this.pt(ts[i]));
    return out;
  },

  toLocal(t) {
    // 触摸坐标 → 图谱坐标
    return {
      x: (t.x - this.view.tx) / this.view.scale,
      y: (t.y - this.view.ty) / this.view.scale,
    };
  },

  onTouchStart(e) {
    const ts = this.ptsOf(e);
    if (!ts.length) return;
    this.moved = false;
    if (ts.length >= 2) {
      const d = Math.hypot(ts[0].x - ts[1].x, ts[0].y - ts[1].y);
      const m = { x: (ts[0].x + ts[1].x) / 2, y: (ts[0].y + ts[1].y) / 2 };
      this.pinch = {
        d: d || 1, scale: this.view.scale, mid: m,
        // 记下中点下面是图谱里的哪个点 —— 缩放时让这个点别跑
        gx: (m.x - this.view.tx) / this.view.scale,
        gy: (m.y - this.view.ty) / this.view.scale,
      };
      this.dragging = null;
      this.pressed = null;
      this.viewTarget = null;
      this.draw();
      return;
    }
    this.pinch = null;
    const p = this.toLocal(ts[0]);
    const hit = graphLib.hitTest(this.nodes, p.x, p.y, 22);
    if (hit) {
      this.dragging = { node: hit, startX: ts[0].x, startY: ts[0].y, ox: hit.x, oy: hit.y };
      this.pressed = hit;
      this.panFrom = null;
      this.viewTarget = null;
      this.draw();                 // 手指一按就变大 —— 别等抬手才给反馈
    } else {
      this.dragging = null;
      this.pressed = null;
      this.panFrom = { x: ts[0].x, y: ts[0].y, tx: this.view.tx, ty: this.view.ty };
      this.viewTarget = null;
    }
  },

  onTouchMove(e) {
    const ts = this.ptsOf(e);
    if (!ts.length) return;
    if (ts.length >= 2 && this.pinch) {
      const d = Math.hypot(ts[0].x - ts[1].x, ts[0].y - ts[1].y);
      const m = { x: (ts[0].x + ts[1].x) / 2, y: (ts[0].y + ts[1].y) / 2 };
      const s = graphLib.clamp((this.pinch.scale * d) / this.pinch.d, MIN_SCALE, MAX_SCALE);
      // 以两指中点为锚：中点移动 = 同时平移，体验比"只缩放"自然得多
      this.view.scale = s;
      this.view.tx = m.x - this.pinch.gx * s;
      this.view.ty = m.y - this.pinch.gy * s;
      this.moved = true;
      this.draw();
      return;
    }
    if (this.dragging) {
      const dx = ts[0].x - this.dragging.startX;
      const dy = ts[0].y - this.dragging.startY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) this.moved = true;
      this.dragging.node.x = this.dragging.ox + dx / this.view.scale;
      this.dragging.node.y = this.dragging.oy + dy / this.view.scale;
      this.draw();
      return;
    }
    if (this.panFrom) {
      const dx = ts[0].x - this.panFrom.x;
      const dy = ts[0].y - this.panFrom.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) this.moved = true;
      this.view.tx = this.panFrom.tx + dx;
      this.view.ty = this.panFrom.ty + dy;
      this.draw();
    }
  },

  onTouchEnd(e) {
    const node = this.dragging && this.dragging.node;
    const onBlank = !this.dragging && !!this.panFrom;
    const moved = this.moved;
    this.pressed = null;
    this.dragging = null;
    this.panFrom = null;
    this.pinch = null;
    // 抬手时也把缩放读数刷一下（捏合过程中不 setData，免得刷爆）
    const zp = Math.round(this.view.scale * 100);
    if (zp !== this.data.zoomPct) this.setData({ zoomPct: zp, labelText: this.labelTextOf() });

    if (moved) { this.draw(); return; }

    if (node) {
      this.tapNode(node);
    } else if (onBlank) {
      // 点空白：先收起抽屉 / 退出聚焦；紧接着再点一下 = 放大
      if (this.data.sheet.show) this.closeSheet();
      else if (this.data.focus) this.setFocus(null);

      const now = Date.now();
      const ct = (e && e.changedTouches && e.changedTouches[0]) || null;
      if (this._lastBlank && now - this._lastBlank.t < DBL_MS && ct) {
        this._lastBlank = null;
        const p = this.pt(ct);
        this.zoomAt(p.x, p.y, 1.45);
      } else {
        this._lastBlank = { t: now };
        this.draw();
      }
      return;
    }
    this.draw();
  },

  /** 单击 / 双击同一个节点 */
  tapNode(node) {
    const now = Date.now();
    const last = this._lastTap;
    const dbl = !!(last && last.id === node.id && now - last.t < DBL_MS);

    // 视觉反馈三连：回弹（pop）+ 脉冲波 + 选中高亮。**不用震动。**
    this.pop = { node, t0: now };
    this.pulse = { node, t0: now };
    // 只有类别保留"选中"状态 —— 点卡片会立刻跳走，留个选中态会让「◎ 聚焦」取到卡片而误报
    if (node.type === 'cat') this.selId = node.id;

    if (dbl) {
      this._lastTap = null;
      if (node.type === 'cat') {
        const on = this.data.focus && this.data.focus.id === node.rawId;
        // ⚠️ 双击的意图是"我要看清楚这一块" —— 必须把抽屉收掉，
        //    否则它正好盖住你要看的东西，看起来就像"点了没用"
        this.hideSheet();
        this.setFocus(on ? null : node.rawId);
        wx.showToast({ title: on ? '已退出聚焦' : '只看「' + node.label + '」', icon: 'none' });
      } else {
        this.openNote(node.rawId);
      }
      this.play();
      return;
    }

    this._lastTap = { id: node.id, t: now };
    if (node.type === 'cat') {
      this.showCatSheet(node);
      this.play();
      return;
    }
    // 卡片：单击就直接进详情（关联卡片在详情页里本来就有一整块，不必再插一层抽屉）
    this.openNote(node.rawId);
  },

  /* ==================== 底部抽屉 ==================== */

  /** 只收起抽屉，保留选中（双击聚焦时用） */
  hideSheet() {
    if (this.data.sheet.show) this.setData({ 'sheet.show': false });
  },

  closeSheet() {
    this.selId = null;
    if (this.data.sheet.show) this.setData({ sheet: { show: false, kind: '', rawId: '', nodeId: '', title: '', sub: '', items: [], total: 0, more: 0, focusOn: false, listH: 120 } });
    this.draw();
  },

  /** 点类别：列出这个类别（含子类别）下的卡片 */
  showCatSheet(node) {
    const all = store.listNotes();
    const allCats = cat.list();
    const catIds = {};
    allCats.forEach((c) => { catIds[c.id] = true; });
    const ids = node.rawId === '__none__' ? { __none__: true } : cat.descendants(allCats, node.rawId);

    const inside = all.filter((n) => {
      const cid = (n.categoryId && catIds[n.categoryId]) ? n.categoryId : '__none__';
      return cid === '__none__' ? node.rawId === '__none__' : !!ids[cid];
    });
    // 没练过的 / 练得少的排前面 —— 这些才是要看的
    inside.sort((a, b) => (a.reviewCount || 0) - (b.reviewCount || 0)
      || String(a.title).localeCompare(String(b.title)));

    const items = inside.slice(0, SHEET_CAP).map((n) => ({
      id: n.id, title: n.title, level: link.masteryLevel(n),
      meta: (LEVEL_TEXT[link.masteryLevel(n)] || '') + ' · 练过 ' + (n.reviewCount || 0) + ' 次',
    }));

    const on = !!(this.data.focus && this.data.focus.id === node.rawId);
    this.setData({
      sheet: {
        show: true, kind: 'cat', rawId: node.rawId, nodeId: node.id,
        title: node.label, total: inside.length,
        sub: inside.length + ' 张卡片' + (on ? ' · 聚焦中' : ''),
        items, more: Math.max(0, inside.length - items.length), focusOn: on,
        listH: Math.min(SHEET_LIST_MAX, Math.max(96, items.length * ROW_H)),
      },
    });
  },

  onGoItem(e) {
    const id = e.currentTarget.dataset.id;
    const kind = this.data.sheet.kind;
    if (kind === 'catpick') {            // 挑类别 → 聚焦它
      this.setData({ 'sheet.show': false });
      this.setFocus(String(id).replace(/^cat:/, ''));
      this.play();
      return;
    }
    if (kind === 'cards') { this.locateNote(id); return; }   // 挑卡片 → 图上定位
    this.openNote(id);                                        // 类别抽屉里的卡片 → 进详情
  },

  /* ==================== 首次进入引导 ==================== */

  notifyCoach(action) {
    const c = this.selectComponent('#coach');
    if (c) c.notify(action);
  },

  onTourLock(e) { this.setData({ pageStyle: e.detail.locked ? 'overflow: hidden;' : '' }); },

  onPageScroll() {
    if (!this.data.tourActive) return;
    const c = this.selectComponent('#coach');
    if (c) c.relocate();
  },

  onTourClose() {
    wx.setStorageSync('sc_tour_done_graph', 1);
    this.setData({ tourActive: false, pageStyle: '' });
  },

  onRestartTour() {
    // 先关再开：引导正开着（或刚关掉）时，同值 setData 不会触发组件观察者
    this.setData({ tourActive: false });
    setTimeout(() => this.setData({ tourActive: true, tourFlow: 'graph' }), 30);
  },

  openNote(id) {
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },
});
