// pages/categories/categories.js —— 类别管理
// 三种视图：发散图（默认，像 Obsidian Graph）/ 横向树图 / 列表
const cat = require('../../utils/category.js');
const store = require('../../utils/store.js');
const obs = require('../../utils/obsidian.js');
const treeUtil = require('../../utils/tree.js');

Page({
  data: {
    tourActive: false, tourFlow: 'categories', pageStyle: '',
    view: 'radial',                   // radial | graph | list
    tree: [], expanded: {}, keyword: '', results: [],
    highlightId: '', noneCount: 0, totalCats: 0, maxDepth: 0,

    // 横向树图
    gNodes: [], gEdges: [], gWidth: 0, gHeight: 0,

    // 发散图
    rNodes: [], rEdges: [], rW: 0, rH: 0, rCx: 0, rScrollLeft: 0, rScrollTop: 0,
    rBoxH: 600, rDense: false,

    // 单个新建 / 改名
    editing: false, editorMode: 'add', editorTitle: '',
    editorName: '', editorParentId: null, editorParentText: '',
    editId: '', parentPickShow: false, keepOpen: false,

    // 大纲批量建树
    outlining: false, outlineText: '', outlineStat: '',
  },

  onShow() {
    // 首次进入这个板块时自动走一遍引导
    if (!wx.getStorageSync('sc_tour_done_categories')) this.setData({ tourActive: true, tourFlow: 'categories' });
    this.autoExpand();
    this.refresh();
  },

  autoExpand() {
    const all = cat.list();
    const expanded = Object.assign({}, this.data.expanded);
    if (!Object.keys(expanded).length) {
      cat.childrenOf(all, null).forEach((c) => { expanded[c.id] = true; });
    }
    this.setData({ expanded });
  },

  /* ==================== 数据刷新 ==================== */

  refresh() {
    const all = cat.list();
    const notes = store.listNotes();
    const countMap = store.countByCategory();

    const metrics = {};
    all.forEach((c) => {
      const ids = cat.descendants(all, c.id);
      const scoped = notes.filter((n) => n.categoryId && ids[n.categoryId]);
      const agg = obs.aggregate(scoped);
      metrics[c.id] = { count: scoped.length, pct: agg.pct, tier: agg.tier };
    });
    const metric = (id) => metrics[id] || { count: 0, pct: 0, tier: 'new' };

    const flat = cat.flattenTree(all, this.data.expanded, (id) => metric(id).count);
    flat.forEach((row) => { row.pct = metric(row.id).pct; row.tier = metric(row.id).tier; });

    let win = { windowWidth: 375, windowHeight: 667 };
    try { win = wx.getSystemInfoSync(); } catch (e) { /* 用默认值 */ }

    // ---------- 横向树图 ----------
    const nested = treeUtil.buildNested((pid) => cat.childrenOf(all, pid), this.data.expanded, metric);
    const g = treeUtil.layout(nested, { col: 130, row: 38, pad: 26 });
    const gEdges = g.edges.map((e) => ({
      id: e.id,
      h1l: e.x1, h1w: Math.max(2, e.midX - e.x1), y1: e.y1,
      vl: e.midX, vTop: Math.min(e.y1, e.y2), vH: Math.abs(e.y2 - e.y1),
      h2l: e.midX, h2w: Math.max(2, e.x2 - e.midX), y2: e.y2,
    }));

    // ---------- 发散图 ----------
    const r = treeUtil.radialLayout(nested, { centerName: '全部' });
    const rBoxH = Math.round(win.windowHeight * 0.5);

    this.setData({
      tree: flat,
      noneCount: countMap.__none__ || 0,
      totalCats: all.length,
      maxDepth: cat.maxDepth(all),

      gNodes: g.nodes, gEdges, gWidth: g.width, gHeight: g.height,

      rNodes: r.nodes, rEdges: r.edges, rW: r.width, rH: r.height, rCx: r.cx,
      rBoxH,
      rDense: r.nodes.length - 1 > 90,
      rScrollLeft: Math.max(0, Math.round(r.cx - win.windowWidth / 2)),
      rScrollTop: Math.max(0, Math.round(r.cy - rBoxH / 2)),
    });
  },

  onSwitchView(e) { this.setData({ view: e.currentTarget.dataset.v }); },

  /** 把发散图视野拉回中心（refresh 会重算 scrollLeft/Top） */
  onRecenter() {
    this.setData({ rScrollLeft: 0, rScrollTop: 0 }, () => this.refresh());
  },

  /* ==================== 搜索 ==================== */

  onSearch(e) {
    this.setData({ keyword: e.detail.value, results: cat.search(e.detail.value), highlightId: '' });
  },
  onClearSearch() { this.setData({ keyword: '', results: [], highlightId: '' }); },

  onLocate(e) {
    const id = e.currentTarget.dataset.id;
    const all = cat.list();
    const expanded = Object.assign({}, this.data.expanded);
    cat.ancestorIds(all, id).forEach((aid) => { expanded[aid] = true; });
    expanded[id] = true;
    this.setData({ expanded, keyword: '', results: [], highlightId: id, view: 'list' }, () => {
      this.refresh();
      wx.pageScrollTo({ selector: '#cat-' + id, duration: 320, offsetTop: -120 });
    });
  },

  /* ==================== 展开 / 收起 ==================== */

  onToggle(e) { this.toggleExpanded(e.currentTarget.dataset.id); },

  toggleExpanded(id) {
    const expanded = Object.assign({}, this.data.expanded);
    expanded[id] = !expanded[id];
    this.setData({ expanded }, () => this.refresh());
  },

  onExpandAll() {
    const expanded = {};
    cat.list().forEach((c) => { expanded[c.id] = true; });
    this.setData({ expanded }, () => this.refresh());
  },

  onCollapseAll() {
    const expanded = {};
    cat.childrenOf(cat.list(), null).forEach((c) => { expanded[c.id] = true; });
    this.setData({ expanded }, () => this.refresh());
  },

  /* ==================== 节点操作 ==================== */

  /** 发散图里点节点 = 展开/收起（跟横向树图一致） */
  onRNodeTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id === '__root__') return;
    const all = cat.list();
    if (cat.childrenOf(all, id).length) this.toggleExpanded(id);
    else this.openSheet(id);
  },

  onRNodeHold(e) {
    const id = e.currentTarget.dataset.id;
    if (id !== '__root__') this.openSheet(id);
  },

  onNodeTap(e) {
    const id = e.currentTarget.dataset.id;
    const all = cat.list();
    if (cat.childrenOf(all, id).length) this.toggleExpanded(id);
    else this.openSheet(id);
  },

  onNodeHold(e) { this.openSheet(e.currentTarget.dataset.id); },
  onMore(e) { this.openSheet(e.currentTarget.dataset.id); },

  openSheet(id) {
    const c = cat.get(id);
    if (!c) return;
    const items = ['＋ 在这里加子类别', '✎ 重命名', '→ 看它的卡片（含子类）', '✕ 删除此类别'];
    wx.showActionSheet({
      itemList: items,
      success: (r) => {
        if (r.tapIndex === 0) this.openEditor('add', id);
        else if (r.tapIndex === 1) this.openEditor('rename', c.parentId || null, c);
        else if (r.tapIndex === 2) this.onTapCat({ currentTarget: { dataset: { id } } });
        else this.doDelete(id, c);
      },
    });
  },

  onTapCat(e) {
    wx.setStorageSync('sc_filter_cat', e.currentTarget.dataset.id);
    wx.switchTab({ url: '/pages/index/index' });
  },

  onAddRoot() { this.openEditor('add', null); },

  /* ==================== 单个新建 / 改名 ==================== */

  openEditor(mode, parentId, target) {
    const all = cat.list();
    const parentText = parentId ? cat.pathText(all, parentId) : '（顶层类别）';
    this.setData({
      editing: true,
      editorMode: mode,
      editorTitle: mode === 'add'
        ? (parentId ? '在「' + parentText + '」下新建' : '新建顶层类别')
        : '重命名',
      editorName: target ? target.name : '',
      editorParentId: parentId || null,
      editorParentText: parentText,
      editId: target ? target.id : '',
      keepOpen: false,
    });
  },

  onEditorName(e) { this.setData({ editorName: e.detail.value }); },
  onToggleKeep() { this.setData({ keepOpen: !this.data.keepOpen }); },
  onEditorCancel() { this.setData({ editing: false }); },

  /** 打开发散图选父类别 */
  onOpenParentPick() { this.setData({ parentPickShow: true }); },

  onParentPicked(e) {
    this.setData({
      parentPickShow: false,
      editorParentId: e.detail.id || null,
      editorParentText: e.detail.text || '（顶层类别）',
    });
  },

  onEditorConfirm() {
    const name = (this.data.editorName || '').trim();
    if (!name) { wx.showToast({ title: '请填类别名', icon: 'none' }); return; }

    if (this.data.editorMode === 'add') {
      const item = cat.add(name, this.data.editorParentId);
      if (!item) { wx.showToast({ title: '同级已有同名类别', icon: 'none' }); return; }
      const expanded = Object.assign({}, this.data.expanded);
      if (this.data.editorParentId) expanded[this.data.editorParentId] = true;
      this.setData({ expanded });
      this.refresh();
      if (this.data.keepOpen) {
        this.setData({ editorName: '' });
        wx.showToast({ title: '已建「' + name + '」，继续', icon: 'none' });
      } else {
        this.setData({ editing: false });
        wx.showToast({ title: '已新建', icon: 'success' });
      }
    } else {
      cat.rename(this.data.editId, name);
      this.setData({ editing: false });
      this.refresh();
      wx.showToast({ title: '已改名', icon: 'success' });
    }
  },

  /* ==================== 大纲批量建树 ==================== */

  onOpenOutline() { this.setData({ outlining: true, outlineStat: '' }); },
  onOutlineInput(e) {
    const text = e.detail.value;
    const lines = this.parseOutline(text);
    const depths = lines.map((l) => l.depth + 1);
    this.setData({
      outlineText: text,
      outlineStat: lines.length
        ? '将创建 ' + lines.length + ' 个类别 · ' + Math.max.apply(null, depths) + ' 层'
        : '',
    });
  },
  onOutlineCancel() { this.setData({ outlining: false }); },

  /**
   * 解析缩进大纲
   *   ① 缩进式：用「相对缩进」判层级（Tab 或 2/4 空格都行）
   *   ② 标题式：# / ## / ### 直接用井号个数定层级
   *   两种都兼容 - / * / 1. 这类列表前缀
   * @returns [{ name, depth, path: [祖先名..., name] }]
   */
  parseOutline(text) {
    const out = [];
    const path = [];   // 当前层级链
    String(text || '').split(/\r?\n/).forEach((raw) => {
      if (!raw.trim()) return;
      const expanded = raw.replace(/\t/g, '  ');
      const indent = expanded.match(/^\s*/)[0].length;
      const body = expanded.trim();

      // ① 标题式：# / ## / ###
      const hm = body.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        const name = hm[2].replace(/\*\*/g, '').trim();
        if (!name) return;
        const depth = hm[1].length - 1;
        path.length = depth;
        const item = { name, indent, depth, path: path.map((x) => x.name).concat([name]) };
        path.push(item);
        out.push(item);
        return;
      }

      // ② 缩进式
      const name = body
        .replace(/^([-*+]|\d+[.)])\s+/, '')
        .replace(/\*\*/g, '')
        .trim();
      if (!name) return;

      while (path.length && indent <= path[path.length - 1].indent) path.pop();
      const item = { name, indent, depth: path.length,
                     path: path.map((x) => x.name).concat([name]) };
      path.push(item);
      out.push(item);
    });
    return out;
  },

  onOutlineConfirm() {
    const lines = this.parseOutline(this.data.outlineText);
    if (!lines.length) { wx.showToast({ title: '先写点内容', icon: 'none' }); return; }

    const counters = { n: 0 };
    let reused = 0;
    lines.forEach((l) => {
      const before = counters.n;
      const r = cat.ensurePath(l.path, counters);
      if (counters.n === before && r.id) reused += 1;
    });

    const expanded = Object.assign({}, this.data.expanded);
    cat.list().forEach((c) => { expanded[c.id] = true; });

    this.setData({ outlining: false, expanded, outlineText: '' }, () => this.refresh());
    wx.showModal({
      title: '建好了',
      content: '共 ' + lines.length + ' 行，新建 ' + counters.n + ' 个类别'
             + (reused ? '，' + reused + ' 个已存在（自动复用）' : ''),
      showCancel: false,
    });
  },

  /* ==================== 删除 ==================== */

  doDelete(id, c) {
    const all = cat.list();
    const kids = cat.childrenOf(all, id);
    const ids = cat.descendants(all, id);
    const countMap = store.countByCategory();
    let cardCount = 0;
    Object.keys(ids).forEach((k) => { cardCount += countMap[k] || 0; });

    wx.showModal({
      title: '删除「' + c.name + '」？',
      content: '该类别及子类下的 ' + cardCount + ' 张卡片会变成「未分类」（不会删除）。'
             + (kids.length ? '\n' + kids.length + ' 个子类别会上移一层。' : ''),
      confirmText: '删除', confirmColor: '#D93025',
      success: (r) => {
        if (!r.confirm) return;
        cat.remove(id);
        const n = store.clearCategory(ids);
        const expanded = Object.assign({}, this.data.expanded);
        delete expanded[id];
        this.setData({ expanded }, () => this.refresh());
        wx.showToast({ title: n ? n + ' 张转为未分类' : '已删除', icon: 'none' });
      },
    });
  },

  noop() {},

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
    wx.setStorageSync('sc_tour_done_categories', 1);
    this.setData({ tourActive: false, pageStyle: '' });
  },
  onRestartTour() { this.setData({ tourActive: true, tourFlow: 'categories' }); },
});
