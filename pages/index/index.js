// pages/index/index.js —— 首页：介绍/引导 + 一键开始 + 留人提示 + 类别 + 搜索
const store = require('../../utils/store.js');
const stats = require('../../utils/stats.js');
const filter = require('../../utils/filter.js');
const brand = require('../../utils/brand.js');

const CAT_KEY = 'sc_filter_cat';
const TOUR_DONE = 'sc_tour_done';
const INTRO_DONE = 'sc_intro_done';
const INTRO_MODE = 'sc_intro_mode';   // first | always | never（「关于」页里的设置）

function countUp(ctx, key, target, dur) {
  const steps = Math.max(1, Math.min(24, Math.round((dur || 600) / 40)));
  let i = 0;
  if (ctx['_' + key]) clearInterval(ctx['_' + key]);
  ctx['_' + key] = setInterval(() => {
    i += 1;
    ctx.setData({ [key]: i >= steps ? target : Math.round((target * i) / steps) });
    if (i >= steps) clearInterval(ctx['_' + key]);
  }, 40);
}

Page({
  data: {
    brand,
    notes: [], view: [], keyword: '',
    isEmpty: false, dueCount: 0,
    streak: 0, streakShow: 0, todayDone: 0,
    totalShow: 0,
    // 今日目标
    goal: 10, goalPct: 0, goalLeft: 10, goalDone: false,
    mastery: { total: 0, newPct: 0, learningPct: 0, masteredPct: 0,
               new: 0, learning: 0, mastered: 0 },
    activeCat: 'all', rangeText: '全部卡片', rangeShort: '全部',
    catPath: {}, showPicker: false,
    // 引导 / 介绍
    showIntro: false, tourActive: false, tourFlow: 'index', pageStyle: '',
    // 留人提示
    urge: '',
    justSeeded: false,
  },

  onLoad() {
    // ① 首次使用先放几张示例卡，别让用户面对空白
    const seeded = store.seedIfEmpty();
    if (seeded > 0) this.setData({ justSeeded: true });

    // ② 每次打开小程序都放一遍产品介绍
    //    旗子由 app.onLaunch 插，这里消费掉，保证一次启动只弹一次
    if (store.takeIntroPending()) { this.setData({ showIntro: true }); return; }

    // ③ 兜底：用户在「关于」页里手动设成了 always
    let mode = 'first';
    try { mode = wx.getStorageSync(INTRO_MODE) || 'first'; } catch (e) { mode = 'first'; }
    if (mode === 'always') { this.setData({ showIntro: true }); return; }

    if (!wx.getStorageSync(TOUR_DONE)) this.setData({ tourActive: true });
  },

  onShow() {
    const jump = wx.getStorageSync(CAT_KEY);
    if (jump) { wx.removeStorageSync(CAT_KEY); this.setData({ activeCat: jump }); }
    const pending = wx.getStorageSync('sc_tour_pending');
    if (pending === 'index') {
      wx.removeStorageSync('sc_tour_pending');
      this.setData({ tourActive: true, tourFlow: 'index' });
    }
    this.load();
  },

  onPullDownRefresh() { this.load(); wx.stopPullDownRefresh(); },

  load() {
    const allNotes = store.listNotes();
    const logs = store.readLogs();
    const now = Date.now();
    const scoped = filter.notesByCat(allNotes, this.data.activeCat);
    const scopedLogs = filter.logsByNotes(logs, scoped);

    const catPath = {};
    allNotes.forEach((n) => {
      if (n.categoryId) catPath[n.id] = filter.rangeText(n.categoryId).replace('（含子类）', '');
    });

    const streak = stats.streak(scopedLogs);
    const todayDone = stats.todayCount(scopedLogs);
    const dueCount = scoped.filter((n) => (n.dueAt || 0) <= now).length;

    // 今日目标：至少 10 张，最多 20 张（到期多也不吓人）
    const goal = Math.max(10, Math.min(dueCount || 0, 20));
    const goalPct = Math.min(100, Math.round((todayDone / goal) * 100));
    const goalLeft = Math.max(0, goal - todayDone);

    // 留人话术：连续记录快断了 → 最有效的挽留理由
    let urge = '';
    if (streak > 0 && todayDone === 0) {
      urge = '已连续 ' + streak + ' 天，今天练一张就能接着续上';
    } else if (streak === 0 && todayDone > 0) {
      urge = '今天开了个头，明天继续就形成连续记录了';
    }

    this.setData({
      notes: allNotes,
      isEmpty: allNotes.length === 0,
      dueCount, streak, todayDone, urge,
      goal, goalPct, goalLeft, goalDone: todayDone >= goal,
      mastery: stats.mastery(scoped),
      rangeText: filter.rangeText(this.data.activeCat),
      rangeShort: filter.rangeShort(this.data.activeCat),
      catPath,
    });

    countUp(this, 'totalShow', scoped.length, 620);
    countUp(this, 'streakShow', streak, 620);

    this.applyFilter(scoped);
  },

  // ---------- 介绍 / 引导 ----------
  onIntroClose() {
    wx.setStorageSync(INTRO_DONE, 1);
    this.setData({ showIntro: false });
    // ⚠️ 看完介绍**不再接着弹引导** —— 新用户一进来连吃两个全屏（介绍 + 引导）会懵，
    //    要先点两次"下一步"才看见界面。改成本次记一笔 pending，等下次回到首页再放
    //    （那时他已经摸过界面，引导才对得上号）。
    if (!wx.getStorageSync(TOUR_DONE)) wx.setStorageSync('sc_tour_pending', 'index');
  },

  onTourLock(e) { this.setData({ pageStyle: e.detail.locked ? 'overflow: hidden;' : '' }); },
  onPageScroll() {
    if (!this.data.tourActive) return;
    const c = this.selectComponent('#coach');
    if (c) c.relocate();
  },
  // 关闭引导时必须把 pageStyle 复位 —— 否则引导如果没走完就关掉，
  // page-meta 上的 overflow:hidden 会一直留着，整个页面滚不动
  onTourClose() {
    wx.setStorageSync(TOUR_DONE, 1);
    this.setData({ tourActive: false, pageStyle: '' });
  },
  onRestartTour() { this.setData({ tourActive: true, tourFlow: 'index' }); },
  onShowIntro() { this.setData({ showIntro: true }); },

  // ---------- 类别 ----------
  onOpenPicker() { this.setData({ showPicker: true }); },
  onPickCat(e) { this.setData({ activeCat: e.detail.id, showPicker: false }, () => this.load()); },
  onCatChange() { this.load(); },

  onSearch(e) { this.setData({ keyword: e.detail.value }, () => this.load()); },
  onClearSearch() { this.setData({ keyword: '' }, () => this.load()); },

  applyFilter(scoped) {
    const base = scoped || filter.notesByCat(this.data.notes, this.data.activeCat);
    const kw = (this.data.keyword || '').trim().toLowerCase();
    const picked = kw
      ? base.filter((n) =>
          String(n.title || '').toLowerCase().indexOf(kw) >= 0 ||
          String(n.content || '').toLowerCase().indexOf(kw) >= 0)
      : base;
    const now = Date.now();
    // 补两个展示字段：掌握等级（决定左侧色条）+ 是否到期
    const list = picked.map((n) => Object.assign({}, n, {
      _lv: stats.masteryLevel(n),
      _due: (n.dueAt || 0) <= now,
    }));
    this.setData({ view: list });
  },

  // ---------- 一键开始 ----------
  onStartLearn() {
    wx.setStorageSync('sc_quiz_scope', this.data.activeCat);
    wx.setStorageSync('sc_quiz_size', 10);
    wx.navigateTo({ url: '/pages/quiz/quiz' });
  },
  goPractice() { wx.switchTab({ url: '/pages/practice/practice' }); },
  goHelp() { wx.navigateTo({ url: '/pages/help/help' }); },
  /**
   * 「＋」= 加卡片。两条路都是加卡片，就不该藏在两个地方：
   *   ① 粘贴讲义切卡（进录入页）　② 从 Obsidian 导入 .md / zip（进 Obsidian 板块）
   * 用系统菜单问一句，比在界面上摆两个加号清楚得多。
   */
  onAddCard() {
    wx.showActionSheet({
      itemList: ['粘贴讲义 / 文字切卡', '从 Obsidian 导入 .md / zip'],
      success: (r) => {
        if (r.tapIndex === 0) this.goCapture();
        else wx.switchTab({ url: '/pages/obsidian/obsidian' });
      },
      fail: () => {},
    });
  },

  goCapture() {
    // 引导要求「用户真的点了录入入口」才前进；从菜单进也算数
    const c = this.selectComponent('#coach');
    if (c) c.notify('goCapture');
    wx.navigateTo({ url: '/pages/capture/capture' });
  },
  goReview() { wx.switchTab({ url: '/pages/review/review' }); },

  onTapNote(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); },
});
