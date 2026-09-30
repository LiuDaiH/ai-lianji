// pages/stats/stats.js —— 学习统计（按类别范围）+ 本页引导
const store = require('../../utils/store.js');
const catLib = require('../../utils/category.js');
const stats = require('../../utils/stats.js');
const filter = require('../../utils/filter.js');
const tours = require('../../utils/tours.js');
const obs = require('../../utils/obsidian.js');
const ai = require('../../utils/ai.js');

const CAT_KEY = 'sc_filter_cat';

Page({
  data: {
    // 学习日历（近 12 周 / 整年两种尺度共用一套模板）
    calMode: 'weeks', calYear: 0, calYears: [],
    cal: { grid: [], monthSpans: [], rowLabels: [], summary: {} },
    calPitch: 54, calCell: 44, calBig: true,
    pickedDay: null, pickedKey: '', pickedDetail: null,
    // 新增维度
    longest: 0, acc: 0, mastery: null, week: null, hours: [], peakHour: 0,
    forecast: [], cats: [],
    hardest: [], streak: 0, todayDone: 0,
    totalReviews: 0, total: 0, isEmpty: true,
    activeCat: 'all', rangeText: '全部卡片', rangeShort: '全部',
    dueCount: 0, showPicker: false,
    tourActive: false, tourFlow: 'stats', pageStyle: '',
    // AI 学习诊断
    aiOn: false, advice: '', adviceLoading: false, adviceAt: 0,
    // 设置：产品介绍弹窗模式（和「关于」页读写同一个 key）
    introMode: 'first',
  },

  onShow() {
    // 首次进入这个板块时自动走一遍引导
    if (!wx.getStorageSync('sc_tour_done_stats')) this.setData({ tourActive: true, tourFlow: 'stats' });
    this.setData({ aiOn: ai.enabled() });
    try { this.setData({ introMode: wx.getStorageSync('sc_intro_mode') || 'first' }); } catch (e) { /* ignore */ }
    const jump = wx.getStorageSync(CAT_KEY);
    if (jump) { wx.removeStorageSync(CAT_KEY); this.setData({ activeCat: jump }); }

    // 从「关于这个工具」页跳进来要跑的引导
    const pending = wx.getStorageSync('sc_tour_pending');
    if (pending) {
      wx.removeStorageSync('sc_tour_pending');
      const t = tours.get(pending);
      if (t && t.page === 'stats') {
        this.setData({ tourActive: true, tourFlow: pending });
      }
    }
    this.load();
  },

  load() {
    const allNotes = store.listNotes();
    const logs = store.readLogs();
    const scoped = filter.notesByCat(allNotes, this.data.activeCat);
    const scopedLogs = filter.logsByNotes(logs, scoped);
    const now = Date.now();

    this._scopedLogs = scopedLogs;
    const hours = stats.hourHist(scopedLogs);
    const years = stats.logYears(scopedLogs, now);

    this.setData({
      rangeText: filter.rangeText(this.data.activeCat),
      rangeShort: filter.rangeShort(this.data.activeCat),
      pickedDay: null, pickedKey: '', pickedDetail: null,
      hardest: stats.hardest(scoped, 5),
      streak: stats.streak(scopedLogs),
      longest: stats.longestStreak(scopedLogs),
      acc: stats.accuracy(scopedLogs),
      mastery: stats.mastery(scoped),
      todayDone: stats.todayCount(scopedLogs),
      totalReviews: stats.totalReviews(scopedLogs),
      total: scoped.length,
      dueCount: scoped.filter((n) => (n.dueAt || 0) <= now).length,
      week: stats.weekCompare(scopedLogs, now),
      forecast: stats.forecast(scoped, 7),
      peakHour: hours.peak,
      hours: hours.buckets.map((v, i) => ({
        h: i, pct: Math.round((v / hours.max) * 100), n: v, peak: i === hours.peak,
      })),
      cats: stats.byCategory(scoped, catLib.list(), 5),
      calYears: years,
      calYear: (this.data.calYear && years.indexOf(this.data.calYear) >= 0)
        ? this.data.calYear : years[0],
      isEmpty: allNotes.length === 0,
    }, () => this.buildCal());
  },

  /** 按当前尺度（近 12 周 / 整年）算日历网格 */
  buildCal() {
    const lgs = this._scopedLogs || [];
    const now2 = Date.now();
    if (this.data.calMode === 'year') {
      const cal2 = stats.yearCalendar(lgs, this.data.calYear || new Date(now2).getFullYear(), { now: now2 });
      this.setData({ cal: cal2, calPitch: 44, calCell: 34, calBig: false,
                     pickedDay: null, pickedKey: '', pickedDetail: null });
      return;
    }
    this.setData({ cal: stats.heatDetail(lgs, 12), calPitch: 54, calCell: 44, calBig: true,
                   pickedDay: null, pickedKey: '', pickedDetail: null });
  },

  onCalMode(e) {
    const m = e.currentTarget.dataset.m;
    if (m === this.data.calMode) return;
    this.setData({ calMode: m }, () => this.buildCal());
  },

  onPickYear(e) {
    this.setData({ calYear: Number(e.currentTarget.dataset.y) }, () => this.buildCal());
  },

  onTapDayNote(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },

  // ---------- 引导 ----------
  onTourLock(e) {
    this.setData({ pageStyle: e.detail.locked ? 'overflow: hidden;' : '' });
  },
  onPageScroll() {
    if (!this.data.tourActive) return;
    const c = this.selectComponent('#coach');
    if (c) c.relocate();
  },
  onTourClose() {
    wx.setStorageSync('sc_tour_done_stats', 1);
    this.setData({ tourActive: false, pageStyle: '' });
  },
  onRestartTour() { this.setData({ tourActive: true, tourFlow: 'stats' }); },

  // ---------- 类别 ----------
  onOpenPicker() { this.setData({ showPicker: true }); },
  onPickCat(e) { this.setData({ activeCat: e.detail.id, showPicker: false }, () => this.load()); },
  onCatChange() { this.load(); },

  onTapNote(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); },

  /** 介绍弹窗模式：每次打开 / 仅首次 / 不再显示 */
  onPickIntroMode(e) {
    const k = e.currentTarget.dataset.k;
    try { wx.setStorageSync('sc_intro_mode', k); } catch (err) { /* ignore */ }
    this.setData({ introMode: k });
    wx.showToast({
      title: k === 'always' ? '每次打开都会放介绍'
        : (k === 'never' ? '以后不再自动放介绍' : '只在第一次打开时放'),
      icon: 'none',
    });
  },

  goHelp() { wx.navigateTo({ url: '/pages/help/help' }); },
  // Obsidian 是 tabBar 页面，必须用 switchTab
  goObsidian() { wx.switchTab({ url: '/pages/obsidian/obsidian' }); },

  /** 点热力图某一格 → 显示那天练了多少 */
  onPickDay(e) {
    const d = e.currentTarget.dataset;
    if (d.future) {
      this.setData({ pickedKey: d.key, pickedDetail: null,
                     pickedDay: { md: d.md, future: true, count: 0 } });
      return;
    }
    const nameOf = (id) => { const n = store.getNote(id); return n ? n.title : ''; };
    this.setData({
      pickedKey: d.key,
      pickedDay: { md: d.md, future: false, count: Number(d.count) || 0 },
      pickedDetail: stats.dayDetail(this._scopedLogs || [], d.key, nameOf),
    });
  },

  /* ==================== AI 学习诊断 ==================== */

  /** 把当前统计范围的数据压成一段快照文本，交给模型翻译成"你现在该干什么" */
  buildSnapshot() {
    const scoped = filter.notesByCat(store.listNotes(), this.data.activeCat);
    const m = stats.mastery(scoped);
    const hard = stats.hardest(scoped, 5);
    const due = scoped.filter((n) => (n.dueAt || 0) <= Date.now()).length;

    const lines = [
      '统计范围：' + this.data.rangeShort,
      '卡片总数：' + scoped.length + '，其中未学 ' + m.new + ' 张、学习中 ' + m.learning + ' 张、已掌握 ' + m.mastered + ' 张',
      '掌握度：未学 ' + m.newPct + '% / 学习中 ' + m.learningPct + '% / 已掌握 ' + m.masteredPct + '%',
      '今天待复习：' + due + ' 张',
      '连续学习天数：' + this.data.streak + ' 天',
      '累计复习次数：' + this.data.totalReviews,
    ];
    if (hard.length) {
      lines.push('错得最多的 ' + hard.length + ' 张（标题 / 复习次数 / 错误率）：');
      hard.forEach((h) => {
        lines.push('  · ' + h.title + ' / ' + (h.reviewCount || 0) + ' 次 / '
          + Math.round((h._err || 0) * 100) + '%');
      });
    }
    return lines.join('\n');
  },

  async onAskAdvice() {
    if (this.data.adviceLoading) return;
    if (!ai.enabled()) {
      wx.showModal({
        title: 'AI 还没配置',
        content: '去「关于这个工具」页把云开发环境 ID 填上，就能让 AI 看你的数据、给出该练什么的建议。',
        confirmText: '去配置',
        success: (r) => { if (r.confirm) this.goHelp(); },
      });
      return;
    }
    const scoped = filter.notesByCat(store.listNotes(), this.data.activeCat);
    if (!scoped.length) { wx.showToast({ title: '这个范围还没有卡片', icon: 'none' }); return; }

    this.setData({ adviceLoading: true, advice: '' });
    const t = await ai.studyAdvice(this.buildSnapshot());
    if (!t) {
      this.setData({ adviceLoading: false });
      wx.showToast({ title: 'AI 没返回，待会儿再试', icon: 'none' });
      return;
    }
    this.setData({ adviceLoading: false, advice: t, adviceAt: Date.now() });
  },

  onExport() {
    const json = store.exportJSON();
    const name = '知识卡片备份_' + stats.dayKey(Date.now()) + '.json';
    try {
      const fs = wx.getFileSystemManager();
      const path = wx.env.USER_DATA_PATH + '/' + name;
      fs.writeFileSync(path, json, 'utf8');
      wx.showModal({
        title: '导出成功',
        content: '包含卡片、类别与复习记录，可发送给「文件传输助手」保存',
        confirmText: '发送',
        success: (r) => {
          if (!r.confirm) return;
          if (wx.shareFileMessage) {
            wx.shareFileMessage({ filePath: path, fileName: name,
              fail: () => wx.showToast({ title: '发送已取消', icon: 'none' }) });
          } else { wx.showToast({ title: '当前版本不支持分享文件', icon: 'none' }); }
        },
      });
    } catch (e) {
      console.error('[stats] 导出失败', e);
      wx.showToast({ title: '导出失败', icon: 'none' });
    }
  },

  onImport() {
    if (!wx.chooseMessageFile) { wx.showToast({ title: '当前版本不支持选择文件', icon: 'none' }); return; }
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['json'],
      success: (res) => {
        try {
          const text = wx.getFileSystemManager().readFileSync(res.tempFiles[0].path, 'utf8');
          const added = store.importJSON(text);
          wx.showToast({ title: '新增 ' + added + ' 张', icon: 'success' });
          this.load();
        } catch (e) {
          wx.showModal({ title: '导入失败', content: String(e.message || e), showCancel: false });
        }
      },
    });
  },

  onImportClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const text = (res.data || '').trim();
        if (text.indexOf('"notes"') < 0) { wx.showToast({ title: '剪贴板里没有备份数据', icon: 'none' }); return; }
        try {
          const added = store.importJSON(text);
          wx.showToast({ title: '新增 ' + added + ' 张', icon: 'success' });
          this.load();
        } catch (e) { wx.showToast({ title: '数据格式不对', icon: 'none' }); }
      },
    });
  },
});
