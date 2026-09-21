// pages/review/review.js —— 今日清单 + 交互引导
const store = require('../../utils/store.js');
const scheduler = require('../../utils/scheduler.js');
const filter = require('../../utils/filter.js');
const stats = require('../../utils/stats.js');

const CAT_KEY = 'sc_filter_cat';
const TIME_PRESETS = [
  { label: '10 分钟', count: 5 },
  { label: '20 分钟', count: 10 },
  { label: '不限量', count: 0 },
];

Page({
  data: {
    queue: [], presets: TIME_PRESETS, activePreset: 1, etaMin: 0,
    activeCat: 'all', rangeText: '全部卡片', rangeShort: '全部',
    forecast: [], showPicker: false, tourActive: false, tourFlow: 'review',
  },

  onShow() {
    const jump = wx.getStorageSync(CAT_KEY);
    if (jump) { wx.removeStorageSync(CAT_KEY); this.setData({ activeCat: jump }); }
    if (!wx.getStorageSync('sc_tour_done_review')) this.setData({ tourActive: true });
    const pending = wx.getStorageSync('sc_tour_pending');
    if (pending === 'review') {
      wx.removeStorageSync('sc_tour_pending');
      this.setData({ tourActive: true, tourFlow: 'review' });
    }
    this.load();
  },

  onPullDownRefresh() { this.load(); wx.stopPullDownRefresh(); },

  notifyCoach(action) {
    const c = this.selectComponent('#coach');
    if (c) c.notify(action);
  },
  // 引导期间锁住页面滚动（配合 wxml 里的 page-meta）
  onTourLock(e) {
    this.setData({ pageStyle: e.detail.locked ? 'overflow: hidden;' : '' });
  },

  // 兜底：万一还是滚动了，重新对齐高亮框
  onPageScroll() {
    if (!this.data.tourActive) return;
    const c = this.selectComponent('#coach');
    if (c) c.relocate();
  },

  onTourClose() { wx.setStorageSync('sc_tour_done_review', 1); this.setData({ tourActive: false }); },
  onRestartTour() { this.setData({ tourActive: true, tourFlow: 'review' }); },

  load() {
    const allNotes = store.listNotes();
    const scoped = filter.notesByCat(allNotes, this.data.activeCat);
    const due = scheduler.todayQueue(scoped, this.limit());
    const forecast = stats.forecast(scoped, 5);
    const max = Math.max.apply(null, forecast.map((f) => f.count).concat([1]));

    // 收益强度：把 priority 归一到 0~100，前端画成条形，一眼看出"先练哪张"
    const now = Date.now();
    const scored = due.map((n) => scheduler.priority(n, now) || 0);
    const top = Math.max.apply(null, scored.concat([0.0001]));

    this.setData({
      rangeText: filter.rangeText(this.data.activeCat),
      rangeShort: filter.rangeShort(this.data.activeCat),
      queue: due.map((n, i) => Object.assign({}, n, {
        _reason: scheduler.reasonText(n),
        _cat: n.categoryId ? filter.rangeText(n.categoryId).replace('（含子类）', '') : '未分类',
        _heat: Math.max(12, Math.round((scored[i] / top) * 100)),
      })),
      forecast: forecast.map((f) => Object.assign({}, f, { pct: Math.round((f.count / max) * 100) })),
      etaMin: Math.max(1, Math.round(due.length * 0.8)),
    });
  },

  limit() { return this.data.presets[this.data.activePreset].count; },

  onOpenPicker() { this.setData({ showPicker: true }); },
  onPickCat(e) { this.setData({ activeCat: e.detail.id, showPicker: false }, () => this.load()); },
  onCatChange() { this.load(); },
  onPickPreset(e) { this.setData({ activePreset: Number(e.currentTarget.dataset.idx) }, () => this.load()); },

  onStart() {
    if (!this.data.queue.length) { wx.showToast({ title: '这个范围今天没有待复习的', icon: 'none' }); return; }
    this.notifyCoach('start');
    wx.setStorageSync('sc_quiz_scope', this.data.activeCat);
    wx.navigateTo({ url: '/pages/quiz/quiz' });
  },

  onTapNote(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); },
});
