// pages/practice/practice.js —— 小测入口：选范围、题型、题量
const store = require('../../utils/store.js');
const stats = require('../../utils/stats.js');
const filter = require('../../utils/filter.js');
const quizLib = require('../../utils/quiz.js');
const quizcheck = require('../../utils/quizcheck.js');

const CAT_KEY = 'sc_filter_cat';
const TYPES_KEY = 'sc_quiz_types';
const SIZES = [
  { label: '5 题', count: 5 },
  { label: '10 题', count: 10 },
  { label: '15 题', count: 15 },
  { label: '全部', count: 0 },
];

Page({
  data: {
    tourActive: false, tourFlow: 'practice', pageStyle: '',
    activeCat: 'all', rangeText: '全部卡片', rangeShort: '全部',
    sizes: SIZES, activeSize: 1,
    // 题型
    modeOptions: [],          // [{key,name,desc,on,available}]
    selectedModes: [],
    // 其他
    available: 0, dueCount: 0,
    history: [], bestRate: 0, avgRate: 0, totalRounds: 0,
    showPicker: false,
  },

  onLoad() {
    let saved = [];
    try { saved = wx.getStorageSync(TYPES_KEY) || []; } catch (e) { saved = []; }
    if (!Array.isArray(saved) || !saved.length) {
      saved = quizLib.ALL_MODES.slice();      // 默认全选
    }
    this.setData({ selectedModes: saved });
  },

  onShow() {
    // 首次进入这个板块时自动走一遍引导
    if (!wx.getStorageSync('sc_tour_done_practice')) this.setData({ tourActive: true, tourFlow: 'practice' });
    const jump = wx.getStorageSync(CAT_KEY);
    if (jump) { wx.removeStorageSync(CAT_KEY); this.setData({ activeCat: jump }); }
    this.load();
  },

  onPullDownRefresh() { this.load(); wx.stopPullDownRefresh(); },

  load() {
    const allNotes = store.listNotes();
    const scoped = filter.notesByCat(allNotes, this.data.activeCat);
    const withContent = scoped.filter((n) => n.content && String(n.content).trim());
    const now = Date.now();

    // 当前范围 + 当前题型下，实际能出多少题
    const usable = quizLib.makeQuiz(withContent.length >= 3 ? withContent : scoped, 0,
                                    this.data.selectedModes);

    // 各题型在当前范围内的可用性
    const sum = quizcheck.summary(scoped);
    const availSet = {};
    sum.details.forEach((d) => d.modes.forEach((m) => { availSet[m] = true; }));
    // 选择题额外要求卡片数 >= 3
    if (scoped.length < 3) delete availSet.choice;

    const modeOptions = quizLib.MODE_LABELS.map((m) => ({
      key: m.key, name: m.name, desc: m.desc,
      on: this.data.selectedModes.indexOf(m.key) >= 0,
      available: !!availSet[m.key],
    }));

    const history = store.readQuizResults().slice(0, 6).map((r) => ({
      id: r.id,
      day: stats.dayKey(r.at).slice(5),
      right: r.right || 0,
      total: r.total || 0,
      rate: r.total ? Math.round(((r.right || 0) / r.total) * 100) : 0,
      scope: r.scopeText || '全部',
    }));

    const all = store.readQuizResults();
    const rates = all.filter((r) => r.total > 0).map((r) => (r.right / r.total) * 100);
    const avg = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : 0;
    const best = rates.length ? Math.round(Math.max.apply(null, rates)) : 0;

    this.setData({
      rangeText: filter.rangeText(this.data.activeCat),
      rangeShort: filter.rangeShort(this.data.activeCat),
      available: usable.length,
      poolSize: withContent.length,
      dueCount: scoped.filter((n) => (n.dueAt || 0) <= now).length,
      modeOptions,
      history, avgRate: avg, bestRate: best, totalRounds: all.length,
    });
  },

  onOpenPicker() { this.setData({ showPicker: true }); },
  onPickCat(e) { this.setData({ activeCat: e.detail.id, showPicker: false }, () => this.load()); },
  onCatChange() { this.load(); },

  onPickSize(e) { this.setData({ activeSize: Number(e.currentTarget.dataset.idx) }); },

  /** 勾选/取消某个题型 */
  onToggleMode(e) {
    const key = e.currentTarget.dataset.key;
    let sel = this.data.selectedModes.slice();
    const i = sel.indexOf(key);
    if (i >= 0) {
      if (sel.length <= 1) { wx.showToast({ title: '至少留一种题型', icon: 'none' }); return; }
      sel.splice(i, 1);
    } else {
      sel.push(key);
    }
    // 保持固定顺序
    sel = quizLib.ALL_MODES.filter((m) => sel.indexOf(m) >= 0);
    try { wx.setStorageSync(TYPES_KEY, sel); } catch (err) { /* ignore */ }
    this.setData({ selectedModes: sel }, () => this.load());
  },

  onSelectAllModes() {
    const sel = quizLib.ALL_MODES.slice();
    try { wx.setStorageSync(TYPES_KEY, sel); } catch (err) { /* ignore */ }
    this.setData({ selectedModes: sel }, () => this.load());
  },

  onStart() {
    if (this.data.available < 1) {
      wx.showToast({ title: '当前范围内没有可出的题，换换题型或范围', icon: 'none' });
      return;
    }
    wx.setStorageSync('sc_quiz_scope', this.data.activeCat);
    wx.setStorageSync('sc_quiz_size', this.data.sizes[this.data.activeSize].count);
    wx.setStorageSync(TYPES_KEY, this.data.selectedModes);
    wx.navigateTo({ url: '/pages/quiz/quiz' });
  },

  goCapture() { wx.navigateTo({ url: '/pages/capture/capture' }); },

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
    wx.setStorageSync('sc_tour_done_practice', 1);
    this.setData({ tourActive: false, pageStyle: '' });
  },
  onRestartTour() { this.setData({ tourActive: true, tourFlow: 'practice' }); },
});
