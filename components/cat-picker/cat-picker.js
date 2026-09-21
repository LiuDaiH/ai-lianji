// components/cat-picker/cat-picker.js —— 类别选择面板
//
// 两种形态：
//   mode = 'pick'    选一个类别当筛选范围（中心节点 = 全部卡片）
//   mode = 'parent'  选一个类别当新类别的父级（中心节点 = （顶层类别））
//
// 两种视图：
//   发散图（默认）—— 径向布局，整棵树铺开，像 Obsidian Graph View，点节点即选中
//   列表     —— 缩进树，适合节点特别多时精确操作
const cat = require('../../utils/category.js');
const store = require('../../utils/store.js');
const obs = require('../../utils/obsidian.js');
const treeUtil = require('../../utils/tree.js');

const GRAPH_NODE_WARN = 90;      // 节点超过这个数量就建议用列表

Component({
  properties: {
    show: { type: Boolean, value: false },
    active: { type: String, value: 'all' },
    mode: { type: String, value: 'pick' },     // pick | parent
  },

  data: {
    visible: false,
    view: 'graph',
    keyword: '',
    results: [],
    hint: '',

    // 列表视图
    tree: [],
    expanded: {},
    highlightId: '',
    scrollIntoView: '',

    // 发散图
    gNodes: [], gEdges: [], gW: 0, gH: 0, gCx: 0,
    scrollLeft: 0, scrollTop: 0, graphH: 520, dense: false,

    noneCount: 0,
    totalCount: 0,
    activeName: '',

    // 编辑弹窗
    editing: false,
    editorMode: 'add',
    editorTitle: '',
    editorName: '',
    editorParentId: null,
    editorParentText: '',
    editId: '',
    parentPicking: false,
  },

  observers: {
    show(val) {
      if (val) {
        this.setData({ visible: true, keyword: '', results: [], hint: '' });
        this.autoExpand();
        this.refresh();
      } else {
        this.setData({ visible: false });
      }
    },
  },

  methods: {
    noop() {},

    /* ==================== 数据 ==================== */

    autoExpand() {
      const all = cat.list();
      const expanded = Object.assign({}, this.data.expanded);
      if (!Object.keys(expanded).length) {
        cat.childrenOf(all, null).forEach((c) => { expanded[c.id] = true; });
      }
      this.setData({ expanded });
    },

    /** 每个类别「子树」的卡片数与掌握度 */
    metrics() {
      const all = cat.list();
      const notes = store.listNotes();
      const countMap = store.countByCategory();
      const out = {};
      all.forEach((c) => {
        const ids = cat.descendants(all, c.id);
        let n = 0;
        const scoped = [];
        Object.keys(ids).forEach((k) => { n += countMap[k] || 0; });
        notes.forEach((nt) => { if (nt.categoryId && ids[nt.categoryId]) scoped.push(nt); });
        const agg = obs.aggregate(scoped);
        out[c.id] = { count: n, pct: agg.pct, tier: agg.tier };
      });
      return out;
    },

    refresh() {
      const all = cat.list();
      const countMap = store.countByCategory();
      const m = this.metrics();

      // ---------- 列表视图 ----------
      const flat = cat.flattenTree(all, this.data.expanded, (id) => (m[id] || {}).count || 0);
      flat.forEach((row) => {
        row.pct = (m[row.id] || {}).pct || 0;
        row.tier = (m[row.id] || {}).tier || 'new';
      });

      // ---------- 发散图：整棵树全部展开 ----------
      const allExpanded = {};
      all.forEach((c) => { allExpanded[c.id] = true; });
      const nested = treeUtil.buildNested(
        (pid) => cat.childrenOf(all, pid),
        allExpanded,
        (id) => m[id] || { count: 0, pct: 0, tier: 'new' }
      );
      const isParent = this.data.mode === 'parent' || this.data.parentPicking;
      const g = treeUtil.radialLayout(nested, {
        centerName: isParent ? '（顶层）' : '全部卡片',
        centerId: isParent ? '__top__' : 'all',
      });

      // 打开时把视野对准中心
      let win = { windowWidth: 375, windowHeight: 667 };
      try { win = wx.getSystemInfoSync(); } catch (e) { /* 用默认值 */ }
      const gH = Math.round(win.windowHeight * 0.52);
      const dense = g.nodes.length - 1 > GRAPH_NODE_WARN;

      this.setData({
        tree: flat,
        noneCount: countMap.__none__ || 0,
        totalCount: store.listNotes().length,
        gNodes: g.nodes, gEdges: g.edges, gW: g.width, gH: g.height, gCx: g.cx,
        graphH: gH,
        dense,
        scrollLeft: Math.max(0, Math.round(g.cx - win.windowWidth / 2)),
        scrollTop: Math.max(0, Math.round(g.cy - gH / 2)),
        activeName: this.activeNameOf(this.data.active),
      });
    },

    activeNameOf(id) {
      if (id === 'all' || !id) return '全部卡片';
      if (id === '__none__') return '未分类';
      const all = cat.list();
      return cat.pathText(all, id) || '全部卡片';
    },

    onSwitchView(e) {
      this.setData({ view: e.currentTarget.dataset.v });
    },

    /* ==================== 搜索 / 定位 ==================== */

    onSearch(e) {
      const kw = e.detail.value;
      this.setData({ keyword: kw, results: cat.search(kw), highlightId: '' });
    },

    onClearSearch() {
      this.setData({ keyword: '', results: [], highlightId: '' });
    },

    onLocate(e) {
      const id = e.currentTarget.dataset.id;
      const all = cat.list();
      const expanded = Object.assign({}, this.data.expanded);
      cat.ancestorIds(all, id).forEach((aid) => { expanded[aid] = true; });
      expanded[id] = true;
      this.setData({ expanded, keyword: '', results: [], highlightId: id, view: 'list' }, () => {
        this.refresh();
        this.setData({ scrollIntoView: 'cat-' + id });
      });
    },

    /* ==================== 选择 ==================== */

    onPick(e) {
      const id = e.currentTarget.dataset.id;
      if (this.data.mode === 'parent' || this.data.parentPicking) {
        this.chooseParent(id);
        return;
      }
      this.triggerEvent('pick', { id });
      this.setData({ visible: false });
    },

    onPickAll() {
      if (this.data.mode === 'parent' || this.data.parentPicking) { this.chooseParent(null); return; }
      this.triggerEvent('pick', { id: 'all' });
      this.setData({ visible: false });
    },

    onPickNone() {
      this.triggerEvent('pick', { id: '__none__' });
      this.setData({ visible: false });
    },

    onClose() { this.setData({ visible: false }); },

    /** 头部按钮：选父类别时是「返回」，否则是「关闭」 */
    onHeadAction() {
      if (this.data.parentPicking) this.onParentPickClose();
      else this.onClose();
    },

    /* ==================== 展开 / 收起（列表视图） ==================== */

    onToggle(e) {
      const id = e.currentTarget.dataset.id;
      const expanded = Object.assign({}, this.data.expanded);
      expanded[id] = !expanded[id];
      this.setData({ expanded }, () => this.refresh());
    },

    /* ==================== 节点操作 ==================== */

    /** 长按节点 / 点「⋯」→ 操作菜单 */
    onNodeHold(e) { this.openSheet(e.currentTarget.dataset.id); },

    onMore(e) { this.openSheet(e.currentTarget.dataset.id); },

    openSheet(id) {
      if (!id || id === 'all' || id === '__top__') { this.onAddRoot(); return; }
      const c = cat.get(id);
      if (!c) return;
      const pickLabel = this.data.mode === 'parent' ? '选它当父类别' : '选它当筛选范围';
      wx.showActionSheet({
        itemList: [pickLabel, '＋ 在这里加子类别', '✎ 重命名', '✕ 删除此类别'],
        success: (r) => {
          if (r.tapIndex === 0) {
            if (this.data.mode === 'parent') this.chooseParent(id);
            else { this.onPick({ currentTarget: { dataset: { id } } }); }
          } else if (r.tapIndex === 1) this.openEditor('add', id);
          else if (r.tapIndex === 2) this.openEditor('rename', c.parentId || null, c);
          else this.doDelete(id, c);
        },
      });
    },

    onAddRoot() { this.openEditor('add', null); },

    /* ==================== 编辑弹窗 ==================== */

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
        parentPicking: false,
      });
    },

    onEditorName(e) { this.setData({ editorName: e.detail.value }); },
    onEditorCancel() { this.setData({ editing: false }); },

    /** 打开「选父类别」—— 复用同一张发散图，中心换成「（顶层）」 */
    onOpenParentPick() { this.setData({ parentPicking: true }, () => this.refresh()); },
    onParentPickClose() { this.setData({ parentPicking: false }, () => this.refresh()); },
    onParentPickClear() { this.chooseParent(null); },

    chooseParent(id) {
      const all = cat.list();
      if (id && id === this.data.editId) {
        wx.showToast({ title: '不能挂到自己下面', icon: 'none' });
        return;
      }
      const text = id ? cat.pathText(all, id) : '（顶层类别）';
      this.setData({ editorParentId: id || null, editorParentText: text, parentPicking: false },
        () => this.refresh());
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
      } else {
        cat.rename(this.data.editId, name);
      }
      this.setData({ editing: false });
      this.refresh();
      this.triggerEvent('change');
    },

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
        confirmText: '删除',
        confirmColor: '#D93025',
        success: (r) => {
          if (!r.confirm) return;
          cat.remove(id);
          const n = store.clearCategory(ids);
          const expanded = Object.assign({}, this.data.expanded);
          delete expanded[id];
          this.setData({ expanded });
          this.refresh();
          this.triggerEvent('change');
          wx.showToast({ title: n ? n + ' 张转为未分类' : '已删除', icon: 'none' });
        },
      });
    },
  },
});
