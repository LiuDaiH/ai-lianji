// pages/obsidian/obsidian.js —— Obsidian 知识来源导入 / 掌握度回写
const fs = require('../../utils/obsidian.js');
const cat = require('../../utils/category.js');
const store = require('../../utils/store.js');
const treeUtil = require('../../utils/tree.js');

const TMP_DIR = 'obsidian_import';
const MAX_PREVIEW_ROWS = 120;
// 存档上限：改成 8MB —— 原文现在**分片存储**（store 里按 380KB 切片），
// 不再受"单键 1MB"限制；总容量仍是 10MB，留 2MB 给卡片数据
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

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
    // 导入三步：'idle' → 'pick'（挑文件，仅多文件时）→ 'preview'（预览+导入）
    stage: 'idle',
    pick: { groups: [], onCount: 0, total: 0 },
    tagOpts: [], tagSel: {}, tagOn: 0,
    orphan: 0,
    preview: null,
    rows: [],
    opt: { folder: true, head: true },
    result: '', result2: '',
    sources: [],
    sourceStats: { files: 0, kb: 0 },
    syncStats: { files: 0, linked: 0, nodes: 0, total: 0 },
    steps: [],
    showIntro: false,
    anim: false,
  },

  onLoad() {
    // Obsidian 是 tabBar 主入口之一，如果用户是从这里冷启动的，介绍就在这儿弹
    if (store.takeIntroPending()) this.setData({ showIntro: true });
  },

  onIntroClose() { this.setData({ showIntro: false }); },

  onShow() {
    // 每次进入本页都重播 banner 的依次入场动画（先关再开，强制重播）
    this.setData({ anim: false });
    setTimeout(() => this.setData({ anim: true }), 30);
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
    this._zipCount = zipCount;
    this._skipped = skipped;

    if (!collected.length) {
      this.setData({ busy: false });
      wx.showToast({ title: skipped ? '没有可解析的 .md 文件' : '没有读到文件', icon: 'none' });
      return;
    }

    // 只有一个文件就直接进预览；多个文件先让用户挑（vault 几百个 md 不能全吞）
    if (collected.length === 1) {
      this._collected = collected;
      this.parseSelected(collected);
      return;
    }
    this._collected = collected;
    this.setData({
      busy: false,
      stage: 'pick',
      pick: this.buildPick(collected),
      result: '',
    });
  },

  /** 把读到的文件按文件夹分组，做成可勾选的清单 */
  buildPick(collected) {
    const map = {};
    const order = [];
    collected.forEach((f) => {
      const rel = String(f.relPath || '').replace(/\\/g, '/');
      const parts = rel.split('/');
      const name = parts.pop();
      const dir = parts.join('/') || '（根目录）';
      if (!map[dir]) { map[dir] = []; order.push(dir); }
      map[dir].push({ relPath: f.relPath, name, chars: (f.text || '').length, on: true });
    });
    const groups = order.map((dir) => ({
      dir,
      files: map[dir],
      on: true,
      count: map[dir].length,
    }));
    return { groups, onCount: collected.length, total: collected.length };
  },

  onPickToggle(e) {
    const { g, i } = e.currentTarget.dataset;
    const groups = this.data.pick.groups.slice();
    const gi = Number(g);
    const fi = Number(i);
    const f = groups[gi].files[fi];
    f.on = !f.on;
    groups[gi].on = groups[gi].files.every((x) => x.on);
    this.setData({ pick: this.recountPick(groups) });
  },

  onPickGroup(e) {
    const gi = Number(e.currentTarget.dataset.g);
    const groups = this.data.pick.groups.slice();
    const to = !groups[gi].files.every((x) => x.on);
    groups[gi].files.forEach((x) => { x.on = to; });
    groups[gi].on = to;
    this.setData({ pick: this.recountPick(groups) });
  },

  onPickAll() {
    const groups = this.data.pick.groups.slice();
    const to = this.data.pick.onCount < this.data.pick.total;
    groups.forEach((g) => { g.files.forEach((x) => { x.on = to; }); g.on = to; });
    this.setData({ pick: this.recountPick(groups) });
  },

  recountPick(groups) {
    let on = 0, total = 0;
    groups.forEach((g) => {
      const n = g.files.filter((x) => x.on).length;
      g.count = g.files.length;
      g.on = n === g.files.length;
      g.someOn = n > 0 && n < g.files.length;
      on += n; total += g.files.length;
    });
    return { groups, onCount: on, total };
  },

  onPickCancel() { this._collected = null; this.setData({ stage: 'idle', pick: { groups: [], onCount: 0, total: 0 } }); },

  onPickConfirm() {
    const picked = [];
    this.data.pick.groups.forEach((g) => g.files.forEach((f) => { if (f.on) picked.push(f.relPath); }));
    if (!picked.length) {
      wx.showToast({ title: '至少选一个文件', icon: 'none' });
      return;
    }
    const all = this._collected || [];
    const sel = all.filter((f) => picked.indexOf(f.relPath) >= 0);
    this.parseSelected(sel);
  },

  /** 把选中的文件解析成卡片并给出预览（原 loadFiles 的后半段） */
  parseSelected(collected) {
    if (!collected.length) return;
    wx.showLoading({ title: '解析中…', mask: true });

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
    this._collected = collected;

    // 统计「有标题但没正文」的节点 —— 这些不会出卡，要如实告诉用户
    let emptyNodes = 0;
    let headings = 0;
    parsed.files.forEach((p) => {
      emptyNodes += fs.countEmptyNodes(p.root);
      headings += fs.countHeadings(p.root);
    });

    // 标签（给"只导入带某标签的卡"用）
    const tagMap = {};
    cards.forEach((c) => (c.tags || []).forEach((t) => { tagMap[t] = (tagMap[t] || 0) + 1; }));
    const tagOpts = Object.keys(tagMap)
      .map((t) => ({ tag: t, count: tagMap[t] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 24);

    wx.hideLoading();
    this.setData({
      busy: false,
      stage: 'preview',
      tagOpts, tagSel: {}, tagOn: 0,
      orphan: 0,
      preview: {
        files: parsed.files.length,
        zips: this._zipCount || 0,
        skipped: this._skipped || 0,
        cards: cards.length,
        cats: parsed.categories.length,
        headings,
        emptyNodes,
      },
      rows: previewRows(tree, 0, [], MAX_PREVIEW_ROWS),
    });
  },

  onTagToggle(e) {
    const tag = e.currentTarget.dataset.tag;
    const sel = Object.assign({}, this.data.tagSel);
    if (sel[tag]) delete sel[tag]; else sel[tag] = true;
    this.setData({ tagSel: sel, tagOn: Object.keys(sel).length });
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

  onCancelPreview() {
    this._raw = null;
    const back = (this._collected && this._collected.length > 1) ? 'pick' : 'idle';
    this.setData({ preview: null, rows: [], stage: back, orphan: 0, tagOpts: [], tagSel: {}, tagOn: 0 });
  },

  onConfirmImport() {
    const raw = this._raw;
    if (!raw) return;
    const opt = this.data.opt;
    const tagSel = this.data.tagSel;
    const tagOn = Object.keys(tagSel).length > 0;

    // ④ 按标签筛选：选了标签就只导带这些标签的卡片
    let incoming = raw.cards;
    if (tagOn) incoming = incoming.filter((c) => (c.tags || []).some((t) => tagSel[t]));
    if (!incoming.length) {
      wx.showToast({ title: '这个标签下没有卡片', icon: 'none' });
      return;
    }

    const counters = { n: 0 };
    const prepared = incoming.map((c) => {
      const path = (opt.folder ? c.folders : []).concat(opt.head ? c.nodePath : [c.fileTitle]);
      const r = cat.ensurePath(path, counters);
      return {
        title: c.title,
        content: c.content,
        tags: c.tags || [],
        categoryId: r.id || null,
        lineNo: typeof c.lineNo === 'number' ? c.lineNo : null,
        src: { file: c.file, nodePath: c.nodePath },
      };
    });

    // ① 稳定身份匹配：同一段笔记再导一次 = 更新那张卡，而不是再长一张双胞胎
    const existing = store.listNotes();
    const m = fs.matchImport(existing, prepared);
    const res = store.patchNotes(m.updates.map((x) => ({ id: x.id, patch: x.patch })), []);
    store.addNotes(m.adds);

    // 存档原文，供回写
    let bytes = 0;
    raw.collected.forEach((f) => { bytes += (f.text || '').length; });
    const keep = raw.collected.map((f) => ({ relPath: f.relPath, text: f.text, importedAt: Date.now() }));
    let archived = false;
    if (bytes <= MAX_SOURCE_BYTES) {
      store.upsertObsidianSources(keep);
      archived = store.readObsidianSources().length > 0;      // 读回来确认真的存上了
    }

    const renamed = m.updates.filter((x) => x.renamed).length;
    // ③ 把"更新了哪几张"写出来 —— 只说数字，用户没法确认自己改的那条进来没有
    const upTitles = m.updates.slice(0, 5).map((x) => {
      const t = (store.getNote(x.id) || {}).title || '';
      return t + (x.renamed ? '（改名）' : '');
    }).filter(Boolean);
    const detail = upTitles.length
      ? '更新了：' + upTitles.join('、') + (m.updates.length > 5 ? ' 等 ' + m.updates.length + ' 张' : '')
      : '';
    // ⚠️ 用了标签筛选就别报孤儿：没被导进来的卡不是"被删了"，只是你没选
    const orphans = tagOn ? [] : m.orphans;
    this._orphans = orphans;

    this._raw = null;
    this.refreshSources();
    if (!archived && bytes <= MAX_SOURCE_BYTES) {
      // 存不上就是"回写整个失效"，必须吵出来，不能只在结果里飘一行小字
      wx.showModal({
        title: '原文没能存下来',
        content: '本地空间不够，回写功能会不可用（卡片和类别不受影响）。可以在「统计」里清理或导出备份后重试。',
        showCancel: false,
      });
    }
    this.setData({
      preview: null, rows: [], stage: 'idle', tagOpts: [], tagSel: {}, tagOn: 0,
      orphan: orphans.length,
      result2: detail,
      result: '更新 ' + m.updates.length + ' 张'
        + (renamed ? '（其中改名 ' + renamed + ' 张）' : '')
        + ' · 新增 ' + m.adds.length + ' 张'
        + ' · 未变 ' + m.keeps.length + ' 张'
        + (tagOn ? '（已按标签筛选）' : '')
        + (archived || bytes === 0 ? '' : '　⚠️ 原文未存档，回写用不了'),
    });
    wx.showToast({ title: '导入完成', icon: 'success' });
  },

  /** ④ 清理「笔记里已经删掉、卡片还留着」的孤儿 */
  onCleanOrphans() {
    const list = this._orphans || [];
    if (!list.length) return;
    const names = list.slice(0, 3).map((n) => n.title).join('、');
    wx.showModal({
      title: '清理 ' + list.length + ' 张孤儿卡？',
      content: '这些卡片对应的笔记段落已经不在这次的导入里了（可能你删了或改了）：' + names
        + (list.length > 3 ? ' 等' : '') + '。删掉后它们的复习记录也没了。',
      confirmText: '删除', confirmColor: '#D93025',
      success: (r) => {
        if (!r.confirm) return;
        store.patchNotes([], list.map((n) => n.id));
        this._orphans = [];
        this.setData({ orphan: 0, result: '已清理 ' + list.length + ' 张孤儿卡' });
        this.refreshSources();
      },
    });
  },

  /* ==================== 回写 ==================== */

  /** 每个来源文件的 study_* 字段（写进 frontmatter，装了 Dataview 就能直接查） */
  buildFileAgg() {
    const notes = store.listNotes();
    const buckets = {};
    notes.forEach((n) => {
      if (!n.src || !n.src.file) return;
      (buckets[n.src.file] = buckets[n.src.file] || []).push(n);
    });
    const out = {};
    Object.keys(buckets).forEach((f) => { out[f] = fs.frontFields(buckets[f]); });
    return out;
  },

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
    this._fileAgg = this.buildFileAgg();
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
    this._missing = [];          // ③ 累计「笔记里找不到的标题」
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
      this.finishExport();
      return;
    }
    const src = this._queue.shift();
    const marks = (this._markMap && this._markMap[src.relPath]) || {};
    const front = (this._fileAgg && this._fileAgg[src.relPath]) || null;
    const res = fs.annotate(src.text, marks, { front });
    // ③ 记下这个文件里"找不到对应标题"的那些（多半是你改过标题）
    if (res.missing && res.missing.length) {
      res.missing.forEach((k) => { this._missing.push(fs.baseName(src.relPath) + ' › ' + k); });
    }
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

  /** ③ 导出收尾：如果有些标题在笔记里对不上，明说出来 */
  finishExport() {
    const miss = this._missing || [];
    if (!miss.length) {
      wx.showToast({ title: '全部导出完成', icon: 'success' });
      this.setData({ result: '全部导出完成 · 所有标题都标注上了' });
      return;
    }
    const head = miss.slice(0, 5).join(String.fromCharCode(10));
    const more = miss.length > 5 ? '…还有 ' + (miss.length - 5) + ' 个' : '';
    wx.showModal({
      title: miss.length + ' 个标题没对上',
      content: '这些标题在你的笔记里找不到了（可能你改过标题名），所以那几段拿不到掌握度：'
        + String.fromCharCode(10) + head + String.fromCharCode(10) + more,
      showCancel: false,
      confirmText: '知道了',
      success: () => this.setData({
        result: '导出完成 · 但有 ' + miss.length + ' 个标题在笔记里找不到（改过标题名？）：「'
          + miss.slice(0, 3).join('」「') + '」' + (miss.length > 3 ? ' 等' : ''),
      }),
    });
  },
  /* ==================== 汇总报告 / 待复习清单 ==================== */

  /** 单文件出口：写盘 → 分享面板 → 面板不可用就降级剪贴板（报告与待复习清单共用） */
  shareOne(name, text, tip) {
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
      success: () => wx.showToast({ title: tip || '已发出', icon: 'success' }),
      fail: () => wx.setClipboardData({
        data: text,
        success: () => wx.showModal({
          title: '已复制到剪贴板',
          content: '分享面板不可用，「' + name + '」全文已复制，粘贴进 Obsidian 即可。',
          showCancel: false,
        }),
      }),
    });
  },

  /**
   * 生成「待复习清单.md」
   * 和上面两个导出的区别：那两份是「复习完之后写回笔记」，这一份是「复习之前告诉你该练什么」。
   * 每条都是 [[文件#标题]]，在 Obsidian 里点一下直接跳到原笔记。
   */
  onExportTodo() {
    const notes = store.listNotes();
    if (!notes.length) {
      wx.showModal({ title: '还没有卡片', content: '先导入笔记或自建几张卡片，这份清单才有内容。', showCancel: false });
      return;
    }
    const linked = notes.filter((n) => n.src && n.src.file).length;
    if (!linked) {
      wx.showModal({
        title: '没有可跳转的原笔记',
        content: '这份清单靠「每张卡的出处」生成 [[笔记#标题]] 链接。你现在的卡片都不是从 Obsidian 导入的，导出的清单会没有任何链接。先去「导入」搬一份笔记进来。',
        showCancel: false,
      });
      return;
    }
    const text = fs.dueList(notes, { days: 7 });
    const name = 'study-todo-' + new Date().toISOString().slice(0, 10) + '.md';
    this.shareOne(name, text, '清单已发出 · ' + linked + ' 张卡有出处');
  },

  /**
   * 复习提醒：导出一份 .ics，导进手机日历后由**系统**到点提醒
   *
   * 为什么不用小程序订阅消息：那需要服务端按模板发，而这个是零后端设计。
   * 日历是唯一"没服务器也会响"的路子。
   */
  onExportIcs() {
    const notes = store.listNotes();
    const soon = notes.filter((n) => n && n.title && n.dueAt && n.dueAt <= Date.now() + 7 * 86400000);
    if (!soon.length) {
      wx.showModal({
        title: '最近 7 天没有到期的卡片',
        content: '先去练几轮，有了复习计划再导出日历提醒。',
        showCancel: false,
      });
      return;
    }
    const text = fs.icsFor(notes, { days: 7 });
    this.shareOne('study-reminder.ics', text, '日历提醒已发出');
  },

  /** 看知识图谱（Obsidian 笔记之间的 [[]] 连成了什么形状） */
  onGoGraph() { wx.navigateTo({ url: '/pages/graph/graph' }); },

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
    this.shareOne(name, text, '报告已发出');
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
      '## 复习前：拿到「今天该练什么」',
      '1. 本页 →「生成待复习清单 .md」→ 发到「文件传输助手」；',
      '2. 收到后放进 vault，打开它 —— 每条都是 [[笔记#标题]]，点一下就跳到原笔记；',
      '3. 在笔记里回忆一遍，再回小程序「复习 / 小测」练一轮。',
      '',
      '## 复习后：把掌握度写回笔记',
      '1. 本页 →「导出带掌握度的 .md」；',
      '2. 每弹一次分享面板发一个文件，发到「文件传输助手」；',
      '3. 电脑上把收到的文件覆盖回 vault。',
      '',
      '写回去的东西有三样：',
      '① 每个标题下面一条 Obsidian 原生高亮块：',
      '> [!success] 掌握度 82% · 复习 5 次 · 下次 9/23  #掌握度/已掌握',
      '绿色=已掌握 / 蓝色=学习中 / 橙色=薄弱 / 灰色=未学，一眼能看出哪节没吃透。',
      '② 行尾的 #掌握度/xx 标签 —— 在 Obsidian 的「标签」面板里点一下，就能列出所有薄弱章节；',
      '③ 文件头部的 study_* 字段（掌握度 / 卡片数 / 复习次数 / 下次到期 / 更新时间），',
      '   装了 Dataview 就能直接查：',
      '   ```dataview',
      '   TABLE study_mastery AS "掌握度", study_state AS "状态"',
      '   FROM #study SORT study_mastery ASC',
      '   ```',
      '',
      '反复导出不会堆积标记：每次都会先清掉上一次写的，再重新插入。',
      '带着标注的笔记再导入一次也没问题 —— 那些标注行会被自动忽略，不会变成卡片。',
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
