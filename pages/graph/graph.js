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
const SHEET_CAP = 120;             // 类别抽屉一次最多列多少条
const CARD_LIST_MAX = 80;          // 卡片清单一次渲染多少条（有搜索，不必全渲染）
const ROW_H = 52;                  // 抽屉里一行的估算高度（px，用来算列表高度）
const SHEET_LIST_MAX = 198;        // ⚠️ 抽屉别盖满画布 —— 上限压到 ~200px，上面始终留得下图
const POP_MS = 260;                // 点击回弹时长

const LEVEL_TEXT = { new: '未学', learning: '学习中', mastered: '已掌握' };
const KEY_LAYOUT = 'sc_graph_layout';   // 力导向结果缓存（大图不用每次重算）

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
    canUndo: false,                // 刚重排过 → 显示「撤销」
    // 全屏搜索（类别 + 卡片一起搜）
    search: { show: false, kw: '', cats: [], notes: [], catTotal: 0, noteTotal: 0, catMore: 0, noteMore: 0 },
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
          // 深色模式：canvas 是自己画的，得按主题换一套颜色
          try {
            const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
            this.dark = (info.theme === 'dark');
          } catch (e) { this.dark = false; }
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

  build(sig, force) {
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
      this.nodes = []; this.edges = []; this._idx = {}; this.blobs = [];
      this._focus = null;
      this.setData({ stats: s, empty: all.length === 0, trimmed: 0, shown: 0, focus: null });
      this.closeSheet();
      this.draw();
      return;
    }

    const g = link.buildGraph(notes, cats);
    const playEnter = !this._enterDone;
    this._enterDone = true;
    this.nodes = g.nodes.map((n, i) => Object.assign(n, { x: 0, y: 0, _a: 1, _g: 1, _i: i }));
    this.edges = g.edges;

    // 掌握度百分比挂在节点上：精读档要写「标题 + 75%」，每帧去查表太浪费
    const info = {};
    all.forEach((n) => {
      const a = n.alpha || 1;
      const b = n.beta || 1;
      info[n.id] = { pct: Math.round((a / (a + b)) * 100), reviews: n.reviewCount || 0 };
    });
    this.nodes.forEach((n) => {
      if (n.type !== 'note') return;
      const i = info[n.rawId] || {};
      n.pct = i.pct || 0;
      n.reviews = i.reviews || 0;
    });

    // ⚠️ 大图布局很贵（力导向 O(n²)）。**复用上次算好的坐标**，进页面秒开；
    //    「重排」才强制重算（force = true）
    const reused = !force && this.loadLayout();
    if (!reused) {
      const out = graphLib.layout(g, this.W, this.H, {});
      out.nodes.forEach((n, i) => { this.nodes[i].x = n.x; this.nodes[i].y = n.y; });
      this.center = out.center;
      this.saveLayout();
    }
    // 扇区与环半径：坐标无关，缓存命中时也要补上（否则画不出「地盘扇形」）
    graphLib.annotateSectors(this.nodes, this.center);
    if (playEnter && !reused) {
      this.nodes.forEach((n) => { n._g = 0; });
      this._enterT0 = Date.now();
    } else {
      this._enterT0 = null;
    }

    // 聚合圈：把「卡片多的大类别」收成一个带数字的圈，缩到最远时靠它显示全貌
    this.blobs = graphLib.blobsOf(this.nodes);
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

  /** 当前该用哪一档（密度判据用的是"上一次绘制时屏上有几个节点"，零额外开销） */
  lod() { return graphLib.lodOf(this.view.scale, this._visible, this.W * this.H); },

  labelTextOf() { return graphLib.lodText(this.lod()); },

  /* ---------- 布局缓存（大图秒开的关键） ---------- */

  loadLayout() {
    try {
      const c = wx.getStorageSync(KEY_LAYOUT);
      if (!c || c.sig !== this._sig || !c.pos) return false;
      this.center = c.center || null;
      this._manual = c.manual || {};
      let hit = 0;
      this.nodes.forEach((n) => {
        const p = c.pos[n.id];
        if (!p) return;
        n.x = p[0]; n.y = p[1]; hit += 1;
      });
      // ⚠️ 手动拖过的位置优先级最高 —— 否则你摆好的版下次进页面就复原了
      this.applyManual();
      return hit === this.nodes.length;
    } catch (e) { return false; }
  },

  /** 把手动位置盖到节点上 */
  applyManual() {
    const m = this._manual || {};
    this.nodes.forEach((n) => {
      const p = m[n.id];
      if (p) { n.x = p[0]; n.y = p[1]; }
    });
  },

  /** 记一个手动位置（拖动结束时调用，不是每帧） */
  saveManual(id, x, y) {
    if (!this._manual) this._manual = {};
    this._manual[id] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    try {
      const c = wx.getStorageSync(KEY_LAYOUT) || {};
      c.sig = this._sig;
      c.manual = this._manual;
      wx.setStorageSync(KEY_LAYOUT, c);
    } catch (e) { /* 存不下就算了 */ }
  },

  /** 重排后手摆的位置作废 */
  clearManual() {
    this._manual = {};
    try {
      const c = wx.getStorageSync(KEY_LAYOUT) || {};
      c.manual = {};
      wx.setStorageSync(KEY_LAYOUT, c);
    } catch (e) { /* ignore */ }
  },

  saveLayout() {
    try {
      const pos = {};
      this.nodes.forEach((n) => { pos[n.id] = [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10]; });
      wx.setStorageSync(KEY_LAYOUT, { sig: this._sig, at: Date.now(), pos, center: this.center });
    } catch (e) { /* 存不下就算了，下次重算 */ }
  },

  onToggleFilter() {
    this.setData({ onlyLinked: !this.data.onlyLinked }, () => this.build());
  },

  onRelayout() {
    wx.showLoading({ title: '重新排布中' });
    // 重排前留一份快照 —— 手摆的位置是劳动成果，不能一按就没
    this._undo = {
      pos: this.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
      view: { scale: this.view.scale, tx: this.view.tx, ty: this.view.ty },
    };
    setTimeout(() => {
      this.build(undefined, true);      // force：不吃缓存，重算一遍
      this.clearManual();               // 新布局 = 手摆的位置作废
      wx.hideLoading();
      this.setData({ canUndo: true });
      if (this._undoTimer) clearTimeout(this._undoTimer);
      this._undoTimer = setTimeout(() => this.setData({ canUndo: false }), 8000);
    }, 30);
  },

  /** 撤销这次重排 */
  onUndoLayout() {
    const u = this._undo;
    if (!u) return;
    const byId = {};
    this.nodes.forEach((n) => { byId[n.id] = n; });
    u.pos.forEach((p) => { const n = byId[p.id]; if (n) { n.x = p.x; n.y = p.y; } });
    this.viewTarget = u.view;
    this._undo = null;
    this.setData({ canUndo: false });
    this.play();
    wx.showToast({ title: '已还原到重排前', icon: 'none' });
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

  /* ---------- 全屏搜索：一个框同时搜类别和卡片 ---------- */

  onOpenSearch() {
    const allCats = cat.list();
    const notes = store.listNotes();
    const catIds = {};
    const counts = {};
    allCats.forEach((c) => { catIds[c.id] = true; });
    notes.forEach((n) => {
      const cid = (n.categoryId && catIds[n.categoryId]) ? n.categoryId : '__none__';
      counts[cid] = (counts[cid] || 0) + 1;
    });
    const pathText = (c) => cat.pathText ? cat.pathText(allCats, c.id) : c.name;
    this._searchCats = allCats.map((c) => ({
      id: c.id, name: c.name, count: counts[c.id] || 0,
      // 带上完整路径，搜「深度学习/过拟合」也能命中
      path: String(pathText(c) || c.name),
    }));
    if (counts.__none__) this._searchCats.push({ id: '__none__', name: '未分类', count: counts.__none__, path: '未分类' });

    const names = {};
    allCats.forEach((c) => { names[c.id] = c.name; });
    this._searchNotes = notes.filter((n) => n && n.title).map((n) => {
      const lv = link.masteryLevel(n);
      return {
        id: n.id, title: n.title, level: lv,
        meta: (LEVEL_TEXT[lv] || '') + ' · 练过 ' + (n.reviewCount || 0) + ' 次'
              + (names[n.categoryId] ? ' · ' + names[n.categoryId] : ''),
      };
    });

    this.setData({ 'search.show': true });
    this.runSearch('');
  },

  onSearchInput(e) { this.runSearch(e.detail.value); },

  onCloseSearch() { this.setData({ 'search.show': false }); },

  /** 一个关键词，两组结果：类别 + 卡片 */
  runSearch(kw) {
    const q = String(kw || '').trim().toLowerCase();
    const hit = (txt) => !q || String(txt || '').toLowerCase().indexOf(q) >= 0;

    const catsAll = this._searchCats || [];
    const notesAll = this._searchNotes || [];
    const cats = catsAll.filter((c) => hit(c.name) || hit(c.path));
    const notes = notesAll.filter((n) => hit(n.title) || hit(n.meta));

    const CAP = 60;
    this.setData({
      'search.kw': kw,
      'search.cats': cats.slice(0, CAP),
      'search.notes': notes.slice(0, CAP),
      'search.catTotal': cats.length,
      'search.noteTotal': notes.length,
      'search.catMore': Math.max(0, cats.length - CAP),
      'search.noteMore': Math.max(0, notes.length - CAP),
    });
  },

  /** 搜索结果里点类别 → 聚焦；点卡片 → 图上定位 */
  onPickSearchCat(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ 'search.show': false, 'sheet.show': false });
    if (id === '__none__') { wx.showToast({ title: '「未分类」不能聚焦', icon: 'none' }); return; }
    this.setFocus(id);
    this.play();
  },

  onPickSearchNote(e) {
    this.setData({ 'search.show': false });
    this.locateNote(e.currentTarget.dataset.id);
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
    const DK = this.dark;
    const BG = DK ? '#141821' : '#FBFCFE';
    const HALO = DK ? 'rgba(20,24,33,.92)' : 'rgba(251,252,254,.92)';
    const LBL = DK ? 'rgba(214,222,236,.94)' : 'rgba(70,78,96,.92)';
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    if (!this.nodes.length) {
      ctx.fillStyle = DK ? '#6E7789' : '#A8AEBC';
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
    const visOf = (n) => (typeof n._a === 'number' ? n._a : 1) * (typeof n._g === 'number' ? n._g : 1);
    const cull = (x, y) => graphLib.inView(x, y, this.view, W, H, 30);

    // 先数「屏上有几个节点」→ 按密度定档（大图适配后自动进"圈层"，而不是一团毛球）
    let vis = 0;
    for (let i = 0; i < this.nodes.length; i += 1) {
      const n = this.nodes[i];
      if (cull(n.x, n.y)) vis += 1;
    }
    this._visible = vis;
    const lod = this.lod();                       // 语义缩放档位：0 类别层 1 卡片点 2 短标题 3 精读

    // LOD 0：卡片多的大类别已经被收进「圈」里，个体不再画
    const blobOf = {};
    if (lod === 0) (this.blobs || []).forEach((b) => { blobOf[b.rawId] = b; });
    const hiddenByBlob = (n) => lod === 0 && (n.type === 'cat' ? !!blobOf[n.rawId] : !!blobOf[n.cat]);

    // ---- 顶级类别的地盘扇形 ----
    // 一个顶级类别 = 一整瓣（含它的子类）。子类永远落在父类这一瓣里，
    // 所以「谁继承谁」是**看出来的**，不用去追虚线。
    const ctr = this.center;
    if (ctr) {
      const TINT = DK
        ? ['rgba(108,143,247,.16)', 'rgba(79,209,165,.16)', 'rgba(251,191,36,.16)',
           'rgba(160,130,240,.16)', 'rgba(80,190,200,.16)']
        : ['rgba(59,111,245,.11)', 'rgba(52,168,83,.11)', 'rgba(240,133,31,.11)',
           'rgba(124,91,217,.11)', 'rgba(31,151,171,.11)'];
      let ti = 0;
      this.nodes.forEach((n) => {
        if (n.type !== 'cat' || !n.sec) return;
        if (n.sec.depth !== 0) return;                       // 只给顶级类别画地盘
        const hot = this.data.focus && this.data.focus.id === n.rawId;
        const R = (n.ring || 0) + 26;
        ctx.beginPath();
        ctx.moveTo(ctr.x, ctr.y);
        ctx.arc(ctr.x, ctr.y, R, n.sec.start, n.sec.end);
        ctx.closePath();
        ctx.fillStyle = hot ? (DK ? 'rgba(108,143,247,.26)' : 'rgba(59,111,245,.20)') : TINT[ti % TINT.length];
        ctx.fill();
        // 外弧再描一道：扇形的边界靠自己"显形"，而不是只靠底色
        ctx.beginPath();
        ctx.arc(ctr.x, ctr.y, R, n.sec.start, n.sec.end);
        ctx.lineWidth = hot ? 2 : 1.2;
        ctx.strokeStyle = hot ? '#3B6FF5' : (DK ? 'rgba(140,160,200,.45)' : 'rgba(120,140,180,.40)');
        ctx.stroke();
        ti += 1;
      });

      // 同心环参考线：**一圈 = 一级类别**。顶级在最外圈、子类往里一层，
      // 层级不靠猜 —— 看它在哪一圈就行。
      const ringBuckets = {};
      this.nodes.forEach((n) => {
        if (n.type !== 'cat' || !n.sec) return;
        const d = Math.min(2, n.sec.depth || 0);
        (ringBuckets[d] = ringBuckets[d] || []).push(n.ring || 0);
      });
      const ringR = Object.keys(ringBuckets).map((d) => {
        const arr = ringBuckets[d];
        return arr.reduce((a, b) => a + b, 0) / arr.length;
      });
      ringR.forEach((r, i) => {
        if (!(r > 6)) return;
        ctx.beginPath();
        ctx.arc(ctr.x, ctr.y, r, 0, Math.PI * 2);
        ctx.setLineDash([3, 7]);
        ctx.lineWidth = i === 0 ? 1.4 : 1;
        ctx.strokeStyle = DK ? 'rgba(130,150,190,.34)' : 'rgba(150,164,192,.42)';
        ctx.stroke();
        ctx.setLineDash([]);
      });
      // 圆心一个小点：环和扇形都是从这儿发散的，让人看懂"同心"这件事
      ctx.beginPath();
      ctx.arc(ctr.x, ctr.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = DK ? 'rgba(160,178,214,.65)' : 'rgba(140,156,186,.65)';
      ctx.fill();
    }

    // ---- 边 ----
    // 选中某张卡时，它的关联边加粗高亮，其余降一档，关系一眼可见
    this.edges.forEach((e) => {
      // 缩到最远只剩类别层级线：圈内部的连线画了也只是噪音
      if (lod === 0 && e.kind !== 'tree') return;
      const a = idx[e.a], b = idx[e.b];
      if (!a || !b) return;
      if (hiddenByBlob(a) || hiddenByBlob(b)) return;
      const alpha = Math.min(visOf(a), visOf(b), 1);
      if (alpha < 0.08) return;
      if (!cull(a.x, a.y) && !cull(b.x, b.y)) return;      // 两端都在视口外 → 不画
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
        // 类别父子：**实线 + 箭头指向子类**（父在外圈、子在内圈，线是向内的一条）
        ctx.strokeStyle = DK ? 'rgba(170,188,222,' + (0.75 * alpha) + ')'
                             : 'rgba(110,124,148,' + (0.8 * alpha) + ')';
        ctx.lineWidth = 1.7;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = 'rgba(195,204,219,' + (0.55 * alpha) + ')';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // ---- 父子箭头：让"谁是子类"不用靠猜 ----
    this.edges.forEach((e) => {
      if (e.kind !== 'tree') return;
      const a = idx[e.a], b = idx[e.b];
      if (!a || !b || !a.sec || !b.sec) return;
      const da = a.sec.depth || 0;
      const db = b.sec.depth || 0;
      if (da === db) return;
      const child = da > db ? a : b;
      const parent = da > db ? b : a;
      if (hiddenByBlob(child) || hiddenByBlob(parent)) return;
      if (!cull(child.x, child.y) && !cull(parent.x, parent.y)) return;
      const ang = Math.atan2(child.y - parent.y, child.x - parent.x);
      const tipR = graphLib.radiusOf(child) + 2.5;
      const tx = child.x - Math.cos(ang) * tipR;
      const ty = child.y - Math.sin(ang) * tipR;
      const size = 4.6;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - Math.cos(ang - 0.42) * size, ty - Math.sin(ang - 0.42) * size);
      ctx.lineTo(tx - Math.cos(ang + 0.42) * size, ty - Math.sin(ang + 0.42) * size);
      ctx.closePath();
      ctx.fillStyle = DK ? 'rgba(170,188,222,.9)' : 'rgba(110,124,148,.95)';
      ctx.fill();
    });

    // ---- 节点 ----
    this.nodes.forEach((n) => {
      if (hiddenByBlob(n)) return;
      if (!cull(n.x, n.y)) return;
      const a = visOf(n);
      if (a < 0.08) return;
      const enter = 0.32 + 0.68 * (typeof n._g === 'number' ? n._g : 1);
      const pressed = this.pressed === n;
      const sel = selId === n.id;
      let r = graphLib.radiusOf(n) * enter;
      if (pressed) r *= 1.3;
      else if (sel) r *= 1.2;
      if (this.pop && this.pop.node === n) {
        const k = Math.min(1, (Date.now() - this.pop.t0) / POP_MS);
        r *= 1 + 0.26 * Math.sin(Math.PI * k);
      }

      ctx.globalAlpha = a;

      if (sel || pressed) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4.5, 0, Math.PI * 2);
        ctx.fillStyle = n.type === 'cat' ? 'rgba(43,58,85,.16)' : 'rgba(240,133,31,.18)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      if (n.type === 'cat') {
        ctx.fillStyle = DK ? '#8FA6D8' : '#2B3A55';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = DK ? 'rgba(143,166,216,.35)' : 'rgba(43,58,85,.22)';
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

    // ---- 聚合圈（LOD 0）----
    if (lod === 0) {
      (this.blobs || []).forEach((b) => {
        if (!cull(b.x, b.y)) return;
        const hot = this.data.focus && this.data.focus.id === b.rawId;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = hot ? 'rgba(59,111,245,.14)' : 'rgba(43,58,85,.09)';
        ctx.fill();
        ctx.lineWidth = hot ? 2.2 : 1.6;
        ctx.strokeStyle = hot ? '#3B6FF5' : '#2B3A55';
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.textAlign = 'center';
        ctx.fillStyle = DK ? '#C6D2EA' : '#2B3A55';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(String(b.count), b.x, b.y + 1);
        ctx.font = 'bold 11px sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = HALO;
        const lb = String(b.label || '').slice(0, 8);
        ctx.strokeText(lb, b.x, b.y + b.r + 13);
        ctx.fillText(lb, b.x, b.y + b.r + 13);
      });
    }

    // ---- 点击脉冲：一圈向外扩散的波 ----
    if (this.pulse && typeof this.pulse.node.x === 'number') {
      const p2 = this.pulse.node;
      const k = Math.max(0, Math.min(1, (Date.now() - p2.t0) / 380));
      const r0 = graphLib.radiusOf(p2) + 2;
      ctx.globalAlpha = (1 - k) * 0.5;
      ctx.beginPath();
      ctx.arc(p2.x, p2.y, r0 + k * 20, 0, Math.PI * 2);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = p2.type === 'cat' ? (DK ? '#9FB4DE' : '#2B3A55') : '#F0851F';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---- 标签：档位越高写得越全 ----
    const noteChars = lod >= 3 ? 10 : 6;
    ctx.textAlign = 'center';
    this.nodes.forEach((n) => {
      if (hiddenByBlob(n)) return;
      if (!cull(n.x, n.y)) return;
      const a = visOf(n);
      if (a < 0.5) return;
      const isSel = selId === n.id || this.pressed === n;
      // LOD 0/1 不给卡片写字（写了就是一坨）；选中/按下的那个例外
      if (n.type === 'note' && lod <= 1 && !isSel) return;
      const r = graphLib.radiusOf(n) * (0.32 + 0.68 * (typeof n._g === 'number' ? n._g : 1));
      const txt = String(n.label || '').slice(0, n.type === 'cat' ? 9 : noteChars);
      if (!txt) return;

      ctx.font = n.type === 'cat' ? 'bold 11px sans-serif' : '9px sans-serif';
      ctx.fillStyle = n.type === 'cat' ? (DK ? '#B9C7E6' : '#2B3A55') : LBL;
      ctx.lineWidth = 3;
      ctx.strokeStyle = HALO;
      ctx.globalAlpha = a;
      const ty = n.y + r + (n.type === 'cat' ? 13 : 10);
      ctx.strokeText(txt, n.x, ty);
      ctx.fillText(txt, n.x, ty);

      // 精读档再多给一行掌握度
      if (lod >= 3 && n.type === 'note') {
        ctx.font = '9px sans-serif';
        ctx.fillStyle = n.reviews > 0 ? 'rgba(59,111,245,.92)' : 'rgba(150,156,168,.95)';
        const sub = n.reviews > 0 ? n.pct + '%' : '未学';
        ctx.strokeText(sub, n.x, ty + 11);
        ctx.fillText(sub, n.x, ty + 11);
      }
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

  /**
   * 命中检测：LOD 0 时优先命中的是「聚合圈」（它才是那个档位下你看到的东西）
   */
  hitAt(p) {
    if (this.lod() === 0 && (this.blobs || []).length) {
      let best = null;
      let bestD = Infinity;
      this.blobs.forEach((b) => {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d <= Math.max(20, b.r) + 6 && d < bestD) { bestD = d; best = b; }
      });
      if (best) {
        return { id: 'c:' + best.rawId, rawId: best.rawId, type: 'cat',
                 label: best.label, x: best.x, y: best.y, blob: true };
      }
    }
    return graphLib.hitTest(this.nodes, p.x, p.y, 22);
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
    const hit = this.hitAt(p);
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

    if (moved) {
      // 拖动结束才存（每帧都写 storage 会卡）
      if (node) this.saveManual(node.id, node.x, node.y);
      this.draw();
      return;
    }

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
      // 缩到最远（LOD 0，画面里是带数字的圈）时，点它就是「展开这一块」——
      // 这就是语义缩放该有的交互：点粗的，看细的
      if (this.lod() === 0) {
        this.hideSheet();
        this.setFocus(node.rawId);
        wx.showToast({ title: '展开「' + node.label + '」', icon: 'none' });
        this.play();
        return;
      }
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
    this._cardAll = null;
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
