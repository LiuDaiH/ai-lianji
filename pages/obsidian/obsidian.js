// pages/obsidian/obsidian.js —— Obsidian 知识来源导入 / 掌握度回写
const fs = require('../../utils/obsidian.js');
const cat = require('../../utils/category.js');
const store = require('../../utils/store.js');
const treeUtil = require('../../utils/tree.js');

const TMP_DIR = 'obsidian_import';
const MAX_PREVIEW_ROWS = 120;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;   // 存档上限 2MB，别撑爆本地存储

/** 嵌套树 → 预览用的缩进行 */
function previewRows(nodes, depth, out, limit) {
  (nodes || []).forEach((n) => {
    if (out.length < limit) out.push({ depth, name: n.name });
    previewRows(n.children, depth + 1, out, limit);
  });
  return out;
}

Page({
  data: {
    tourActive: false, tourFlow: 'obsidian', pageStyle: '',
    tab: 'in',
    busy: false,
    preview: null,
    rows: [],
    opt: { folder: true, head: true },
    result: '',
    sources: [],
    sourceStats: { files: 0, kb: 0 },
    syncStats: { files: 0, linked: 0, nodes: 0, total: 0 },
    steps: [],
    showIntro: false,
  },

  onLoad() {
    // Obsidian 是 tabBar 主入口之一，如果用户是从这里冷启动的，介绍就在这儿弹
    if (store.takeIntroPending()) this.setData({ showIntro: true });
  },

  onIntroClose() { this.setData({ showIntro: false }); },

  onShow() {
    this.refreshSources();
    // 首次进入这个板块时自动走一遍引导
    if (!wx.getStorageSync('sc_tour_done_obsidian')) this.setData({ tourActive: true, tourFlow: 'obsidian' });
  },

  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); },

  refreshSources() {
    const list = store.readObsidianSources();
    let bytes = 0;
    list.forEach((s) => { bytes += (s.text || '').length; });

    // 同步状态总览：有几个来源文件、有多少张卡记得自己的出处、能回写多少个标题
    const notes = store.listNotes();
    const linked = notes.filter((n) => n.src && n.src.file);
    const keys = {};
    linked.forEach((n) => {
      const k = n.src.file + '\u0001' + ((n.src.nodePath || []).slice(-1)[0] || '');
      keys[k] = true;
    });

    this.setData({
      sources: list.map((s) => ({
        relPath: s.relPath,
        fileName: fs.stripExt(fs.baseName(s.relPath)),
        chars: (s.text || '').length,
        importedAt: s.importedAt,
      })),
      sourceStats: { files: list.length, kb: Math.round(bytes / 1024) },
      syncStats: {
        files: list.length,
        linked: linked.length,
        nodes: Object.keys(keys).length,
        total: notes.length,
      },
    });
  },

  /* ==================== 导入 ==================== */

  onPick() {
    if (this.data.busy) return;
    wx.chooseMessageFile({
      count: 30,
      type: 'file',
      success: (res) => this.loadFiles(res.tempFiles || []),
      fail: () => {},
    });
  },

  loadFiles(picked) {
    const mgr = wx.getFileSystemManager();
    const collected = [];     // [{relPath, text}]
    const mdExt = /\.(md|markdown)$/i;
    let zipCount = 0;
    let skipped = 0;

    this.setData({ busy: true, result: '' });
    wx.showLoading({ title: '解析中…', mask: true });

    try {
      picked.forEach((f) => {
        const name = f.name || f.path || '';
        if (/\.zip$/i.test(name)) {
          zipCount += 1;
          collected.push.apply(collected, this.readZip(mgr, f.path));
        } else if (mdExt.test(name)) {
          collected.push({ relPath: fs.baseName(name), text: mgr.readFileSync(f.path, 'utf8') });
        } else {
          skipped += 1;
        }
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showModal({ title: '读取失败', content: String(e && e.message || e), showCancel: false });
      return;
    }

    wx.hideLoading();

    if (!collected.length) {
      this.setData({ busy: false });
      wx.showToast({ title: skipped ? '没有可解析的 .md 文件' : '没有读到文件', icon: 'none' });
      return;
    }

    const parsed = fs.parseVault(collected);
    const cards = [];
    parsed.files.forEach((p) => {
      const rel = String(p.file).replace(/\\/g, '/');
      const parts = rel.split('/');
      parts.pop();
      const folders = parts.filter((x) => x && x !== '.');
      p.cards.forEach((c) => {
        cards.push(Object.assign({}, c, {
          folders, fileTitle: p.fileTitle, file: p.file,
          catPath: folders.concat(c.nodePath),
        }));
      });
    });

    const tree = fs.paths2tree(cards.map((c) => c.catPath));
    this._raw = { parsed, cards, collected };

    this.setData({
      busy: false,
      preview: {
        files: parsed.files.length,
        zips: zipCount,
        skipped,
        cards: cards.length,
        cats: parsed.categories.length,
      },
      rows: previewRows(tree, 0, [], MAX_PREVIEW_ROWS),
    });
  },

  /** 解压 zip 并递归读 .md */
  readZip(mgr, zipPath) {
    const dir = wx.env.USER_DATA_PATH + '/' + TMP_DIR;
    try { mgr.rmdirSync(dir, true); } catch (e) { /* 目录不存在，忽略 */ }
    try { mgr.mkdirSync(dir, true); } catch (e) { /* ignore */ }
    mgr.unzipSync(zipPath, dir);
    const out = [];
    const walk = (cur, rel) => {
      mgr.readdirSync(cur).forEach((name) => {
        if (name === '__MACOSX' || name.charAt(0) === '.') return;
        const full = cur + '/' + name;
        const st = mgr.statSync(full);
        const relPath = rel ? rel + '/' + name : name;
        if (st.isDirectory()) walk(full, relPath);
        else if (/\.(md|markdown)$/i.test(name)) out.push({ relPath, text: mgr.readFileSync(full, 'utf8') });
      });
    };
    walk(dir, '');
    return out;
  },

  onToggleOpt(e) {
    const k = e.currentTarget.dataset.k;
    const opt = Object.assign({}, this.data.opt);
    opt[k] = !opt[k];
    this.setData({ opt });
  },

  onCancelPreview() { this._raw = null; this.setData({ preview: null, rows: [] }); },

  onConfirmImport() {
    const raw = this._raw;
    if (!raw) return;
    const opt = this.data.opt;
    const existing = store.listNotes();
    const seen = {};
    existing.forEach((n) => { seen[(n.title || '') + '\u0001' + (n.content || '')] = true; });

    const counters = { n: 0 };
    const toAdd = [];
    let dup = 0;

    raw.cards.forEach((c) => {
      const key = c.title + '\u0001' + c.content;
      if (seen[key]) { dup += 1; return; }
      seen[key] = true;
      const path = (opt.folder ? c.folders : [])
        .concat(opt.head ? c.nodePath : [c.fileTitle]);
      const r = cat.ensurePath(path, counters);
      toAdd.push({
        title: c.title,
        content: c.content,
        tags: c.tags || [],
        categoryId: r.id || null,
        src: { file: c.file, nodePath: c.nodePath },
      });
    });

    store.addNotes(toAdd);

    // 存档原文，供回写
    let bytes = 0;
    raw.collected.forEach((f) => { bytes += (f.text || '').length; });
    const keep = [];
    raw.collected.forEach((f) => {
      keep.push({ relPath: f.relPath, text: f.text, importedAt: Date.now() });
    });
    if (bytes <= MAX_SOURCE_BYTES) store.upsertObsidianSources(keep);

    this._raw = null;
    this.refreshSources();
    this.setData({
      preview: null, rows: [],
      result: '已导入 ' + toAdd.length + ' 张卡片、新建 ' + counters.n + ' 个类别'
              + (dup ? '，跳过重复 ' + dup + ' 张' : '')
              + (bytes > MAX_SOURCE_BYTES ? '（原文超过 2MB，未存档，回写请用汇总报告）' : ''),
    });
    wx.showToast({ title: '导入完成', icon: 'success' });
  },

  /* ==================== 回写 ==================== */

  /** 把卡片按「来源文件 → 标题路径」聚合，算出每个标题的掌握度 */
  buildMarkMap() {
    const notes = store.listNotes();
    const byFile = {};
    notes.forEach((n) => {
      if (!n.src || !n.src.file) return;
      const f = byFile[n.src.file] || (byFile[n.src.file] = {});
      const key = (n.src.nodePath || []).slice(-1)[0] || n.title;
      const bucket = f[key] || (f[key] = []);
      bucket.push(n);
    });

    const out = {};
    Object.keys(byFile).forEach((file) => {
      const marks = {};
      Object.keys(byFile[file]).forEach((k) => {
        const agg = fs.aggregate(byFile[file][k]);
        marks[k] = Object.assign({}, agg, {
          reviews: byFile[file][k].reduce((s, n) => s + (n.reviewCount || 0), 0),
          nextDue: byFile[file][k].reduce((min, n) => (min && n.dueAt ? Math.min(min, n.dueAt) : n.dueAt), 0),
        });
      });
      out[file] = marks;
    });
    return out;
  },

  onExportAll() {
    const sources = store.readObsidianSources();
    if (!sources.length) {
      wx.showModal({
        title: '没有可回写的原文',
        content: '回写需要导入时留下的原文存档。如果你是从剪贴板导入的，或原文超过 2MB，请改用「生成汇总报告」。',
        showCancel: false,
      });
      return;
    }
    this._markMap = this.buildMarkMap();
    const hits = sources.map((s) => {
      const m = (this._markMap[s.relPath] || {});
      const n = Object.keys(m).length;
      return { relPath: s.relPath, name: fs.baseName(s.relPath), marks: n };
    }).filter((x) => x.marks > 0);

    if (!hits.length) {
      wx.showModal({
        title: '还没有学过这些内容',
        content: '这些笔记导入后还没有产生学习记录，导出的标注会全是「尚未学习」。先去练几轮再来？',
        confirmText: '仍然导出',
        success: (r) => { if (r.confirm) this.doExport(); },
      });
      return;
    }
    this.doExport();
  },

  doExport() {
    this._queue = store.readObsidianSources().slice();
    this._done = 0;
    this._total = this._queue.length;
    wx.showModal({
      title: '逐个导出（共 ' + this._total + ' 个文件）',
      content: '小程序一次只能「发一个文件到聊天」。点确认后，每弹一次分享面板就发一个；发完自动跳到下一个。',
      confirmText: '开始',
      success: (r) => { if (r.confirm) this.exportNext(); },
    });
  },

  exportNext() {
    if (!this._queue || !this._queue.length) {
      wx.showToast({ title: '全部导出完成', icon: 'success' });
      return;
    }
    const src = this._queue.shift();
    const marks = (this._markMap && this._markMap[src.relPath]) || {};
    const res = fs.annotate(src.text, marks, {});
    const name = fs.baseName(src.relPath);
    const path = wx.env.USER_DATA_PATH + '/' + name;

    try {
      wx.getFileSystemManager().writeFileSync(path, res.text, 'utf8');
    } catch (e) {
      wx.showModal({ title: '写入失败', content: String(e && e.message || e), showCancel: false });
      return;
    }

    wx.shareFileMessage({
      filePath: path,
      fileName: name,
      success: () => {
        wx.showToast({ title: '已发出 · 标注 ' + res.hits + ' 处', icon: 'none' });
        setTimeout(() => this.exportNext(), 600);
      },
      fail: (err) => {
        if (String(err && err.errMsg || '').indexOf('cancel') >= 0) {
          this.setData({ result: '你取消了分享。剩下 ' + (this._queue.length + 1) + ' 个文件没导出，随时可以重来。' });
          return;
        }
        // 分享失败（比如基础库不支持）→ 降级：复制到剪贴板
        wx.setClipboardData({
          data: res.text,
          success: () => wx.showModal({
            title: '分享不可用，已改复制到剪贴板',
            content: '「' + name + '」的完整内容（含掌握度标注）已复制。粘贴到 Obsidian 里覆盖原文件即可。',
            showCancel: false,
            complete: () => setTimeout(() => this.exportNext(), 400),
          }),
        });
      },
    });
  },

  /* ==================== 汇总报告 ==================== */

  onExportReport() {
    const notes = store.listNotes();
    const allCats = cat.list();
    const buildMetric = (id) => {
      const ids = cat.descendants(allCats, id);
      const scoped = notes.filter((n) => n.categoryId && ids[n.categoryId]);
      return { agg: fs.aggregate(scoped), notes: scoped };
    };
    const nested = treeUtil.buildNested(
      (pid) => cat.childrenOf(allCats, pid),
      (() => { const m = {}; allCats.forEach((c) => { m[c.id] = true; }); return m; })(),
      (id) => {
        const r = buildMetric(id);
        return { count: r.notes.length, pct: r.agg.pct, tier: r.agg.tier };
      }
    );

    const decorate = (list) => (list || []).map((n) => {
      const r = buildMetric(n.id);
      return { name: n.name, agg: r.agg, children: decorate(n.children) };
    });

    const overall = fs.aggregate(notes);
    const text = fs.report(decorate(nested), overall, { title: '知识卡片掌握度报告' });
    const name = 'study-report-' + new Date().toISOString().slice(0, 10) + '.md';
    const path = wx.env.USER_DATA_PATH + '/' + name;

    try {
      wx.getFileSystemManager().writeFileSync(path, text, 'utf8');
    } catch (e) {
      wx.showModal({ title: '写入失败', content: String(e && e.message || e), showCancel: false });
      return;
    }

    wx.shareFileMessage({
      filePath: path,
      fileName: name,
      success: () => wx.showToast({ title: '报告已发出', icon: 'success' }),
      fail: () => wx.setClipboardData({
        data: text,
        success: () => wx.showModal({
          title: '已复制到剪贴板', content: '分享面板不可用，报告全文已复制，粘贴进 Obsidian 即可。',
          showCancel: false,
        }),
      }),
    });
  },

  onClearSources() {
    wx.showModal({
      title: '清空原文存档？',
      content: '只删掉用于回写的原文副本，已导入的卡片和类别不受影响。之后要回写就需要重新导入一次。',
      confirmText: '清空', confirmColor: '#D93025',
      success: (r) => { if (r.confirm) { store.clearObsidianSources(); this.refreshSources(); } },
    });
  },

  onCopyGuide() {
    const text = [
      '# 从 Obsidian 到「知识卡片」的往返流程',
      '',
      '## 导入',
      '1. 电脑上打开 Obsidian vault 文件夹；',
      '2. 把要学的 .md 发到微信「文件传输助手」（多个可以打成一个 zip）；',
      '3. 小程序 → 本页 → 「从聊天选文件」；',
      '4. 看预览的类别树，确认无误后导入。',
      '',
      '## 回写',
      '1. 小程序里用「复习 / 小测」练几轮；',
      '2. 回到本页 → 「导出带掌握度的 .md」；',
      '3. 每弹一次分享面板发一个文件，发到「文件传输助手」；',
      '4. 电脑上把收到的文件覆盖回 vault。',
      '',
      '掌握度会以 Obsidian 原生高亮块写回每个标题下面：',
      '> [!success] 掌握度 82% · 复习 5 次 · 下次 9/23',
      '',
      '绿色=已掌握 / 蓝色=学习中 / 橙色=薄弱 / 灰色=未学，一眼能看出哪节没吃透。',
      '反复导出不会堆积标记 —— 每次都会先清掉上一次的再写。',
    ].join('\n');
    wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '流程已复制', icon: 'none' }) });
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
    wx.setStorageSync('sc_tour_done_obsidian', 1);
    this.setData({ tourActive: false, pageStyle: '' });
  },
  onRestartTour() { this.setData({ tourActive: true, tourFlow: 'obsidian' }); },
});
