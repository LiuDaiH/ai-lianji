// pages/detail/detail.js —— 卡片详情 + 掌握轨迹 + 调度解释 + 编辑 + 复习
const store = require('../../utils/store.js');
const scheduler = require('../../utils/scheduler.js');
const quizLib = require('../../utils/quiz.js');
const cat = require('../../utils/category.js');
const quizcheck = require('../../utils/quizcheck.js');

Page({
  data: {
    note: null, reason: '', editing: false,
    eTitle: '', eContent: '', highlight: '',
    catText: '未分类', catOptions: [], catIndex: 0,
    // 掌握轨迹
    track: [], trackMax: 1, trackTip: '',
    // 调度解释
    showWhy: false, why: null, whyTip: '',
    ability: null,
  },

  onLoad(options) { this.noteId = options.id; },

  onShow() {
    const note = store.getNote(this.noteId);
    const all = cat.list();
    const opts = [{ id: null, label: '未分类' }].concat(
      all.map((c) => ({ id: c.id, label: cat.pathText(all, c.id) })));
    let idx = 0;
    if (note && note.categoryId) {
      idx = opts.findIndex((o) => o.id === note.categoryId);
      if (idx < 0) idx = 0;
    }

    const logs = store.readLogs();
    const tk = note ? scheduler.intervals(note, logs) : { seq: [], max: 1 };
    const first = tk.seq[0] ? tk.seq[0].interval : 1;
    const last = tk.seq[tk.seq.length - 1] ? tk.seq[tk.seq.length - 1].interval : 1;
    let tip = '';
    if (tk.seq.length >= 2) {
      tip = last > first
        ? '间隔从 ' + first + ' 天拉长到 ' + last + ' 天 —— 记忆在巩固'
        : '间隔还没拉长 —— 多答对几次就会变长';
    } else {
      tip = '再复习几次，这里会画出间隔变化';
    }

    this.setData({
      note,
      reason: note ? scheduler.reasonText(note) : '',
      eTitle: note ? note.title : '',
      eContent: note ? note.content : '',
      highlight: note ? quizLib.extractKeywords(note.content || '').slice(0, 6).join('  ·  ') : '',
      catOptions: opts, catIndex: idx, catText: opts[idx].label,
      track: tk.seq, trackMax: tk.max, trackTip: tip,
      ability: note ? quizcheck.diagnose(note.title, note.content, store.listNotes().length) : null,
    });
  },

  // ---------- 调度解释 ----------
  onToggleWhy() {
    const show = !this.data.showWhy;
    let why = this.data.why;
    if (show && !why) {
      why = scheduler.breakdown(this.data.note);
    }
    if (show && why) {
      // 找出贡献最大的分项，给一句话总结
      const top = why.parts.slice().sort((a, b) => b.contribution - a.contribution)[0];
      why.tip = '主要是「' + top.label + '」把它的优先级推高了（贡献 ' + top.contribution + '%）';
    }
    this.setData({ showWhy: show, why });
  },

  onPickCat(e) {
    const idx = Number(e.detail.value);
    const o = this.data.catOptions[idx];
    const updated = store.updateNote(this.noteId, { categoryId: o.id });
    this.setData({ note: updated, catIndex: idx, catText: o.label });
    wx.showToast({ title: '已归类到「' + o.label + '」', icon: 'none' });
  },

  onEdit() { this.setData({ editing: true }); },
  onCancelEdit() { this.setData({ editing: false }); },
  onETitle(e) { this.setData({ eTitle: e.detail.value }); },
  onEContent(e) { this.setData({ eContent: e.detail.value }); },

  onSaveEdit() {
    const title = (this.data.eTitle || '').trim();
    if (!title) { wx.showToast({ title: '标题不能为空', icon: 'none' }); return; }
    const updated = store.updateNote(this.noteId, { title, content: (this.data.eContent || '').trim() });
    this.setData({
      note: updated, editing: false,
      highlight: quizLib.extractKeywords(updated.content || '').slice(0, 6).join('  ·  '),
    });
    if (this.data.showWhy) this.setData({ why: null }, () => this.onToggleWhy());
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  onReview(e) {
    const note = this.data.note;
    if (!note) return;
    const right = e.currentTarget.dataset.correct === 'true';
    const interval = scheduler.nextInterval(note.interval, right, 1);
    const updated = store.updateNote(this.noteId, {
      interval,
      dueAt: Date.now() + interval * scheduler.DAY,
      alpha: (note.alpha || 1) + (right ? 1 : 0),
      beta: (note.beta || 1) + (right ? 0 : 1),
      reviewCount: (note.reviewCount || 0) + 1,
      lastReviewedAt: Date.now(),
    });
    store.addLog({ noteId: this.noteId, right, interval });
    this.setData({ note: updated, reason: scheduler.reasonText(updated), why: null });
    if (this.data.showWhy) this.onToggleWhy();
    this.onShow();
    wx.showToast({ title: right ? '下次 ' + interval + ' 天后' : interval + ' 天后再来', icon: 'none' });
  },

  onDelete() {
    wx.showModal({
      title: '删除这张卡片？',
      success: (r) => {
        if (!r.confirm) return;
        store.removeNote(this.noteId);
        wx.showToast({ title: '已删除' });
        setTimeout(() => wx.navigateBack(), 600);
      },
    });
  },
});
