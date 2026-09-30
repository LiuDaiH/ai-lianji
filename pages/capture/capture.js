// pages/capture/capture.js —— 录入：解析策略 + 实时预览 + 出题能力诊断
const splitter = require('../../utils/splitter.js');
const store = require('../../utils/store.js');
const cat = require('../../utils/category.js');
const quizcheck = require('../../utils/quizcheck.js');
const ai = require('../../utils/ai.js');

const PREVIEW_N = 3;

// 第 8 种解析方式：AI 智能切卡（异步，走云开发 AI+；失败自动降级到本地规则）
const AI_STRATEGY = {
  key: 'ai',
  name: '🤖 AI 智能切卡',
  desc: '用大模型读懂乱格式讲义，切成结构化卡片（需配置云开发）',
};

Page({
  data: {
    raw: '', stage: 'input', cards: [],
    // AI 解析方式只在 AI 版里出现（提交审核版自动只剩本地 7 种）
    strategies: ai.FEATURES.length
      ? splitter.STRATEGIES.concat([AI_STRATEGY])
      : splitter.STRATEGIES,
    strategyIndex: 0, strategyKey: 'smart',
    aiOn: false, aiBusy: false,      // AI 切卡状态
    cardSep: '', kvSep: '',
    preview: [], info: { total: 0, empty: 0, noAnswer: 0, withAnswer: 0 },
    pickedName: '', moreCount: 0,
    // 出题能力诊断
    modesBrief: '', modesBadge: 'ok', modesWeak: 0, modesTotal: 0,
    catOptions: [{ id: null, label: '未分类' }], catIndex: 0, catLabel: '未分类',
    tourActive: false, tourFlow: 'capture', pageStyle: '',
  },

  onLoad() {
    this.loadCats();
    this.checkClipboard();
    this.setData({ aiOn: ai.enabled() });
    if (!wx.getStorageSync('sc_tour_done_capture')) this.setData({ tourActive: true });
  },

  onShow() {
    this.loadCats();
    this.setData({ aiOn: ai.enabled() });
    const pending = wx.getStorageSync('sc_tour_pending');
    if (pending === 'capture') {
      wx.removeStorageSync('sc_tour_pending');
      this.setData({ tourActive: true, tourFlow: 'capture' });
    }
  },

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
  onTourClose() { wx.setStorageSync('sc_tour_done_capture', 1); this.setData({ tourActive: false, pageStyle: '' }); },
  onRestartTour() { this.setData({ tourActive: true, tourFlow: 'capture' }); },

  /** 这一页也能去 Obsidian 导入 —— 两条路都是「往里加内容」，别让人来回找 */
  goObsidianImport() { wx.switchTab({ url: '/pages/obsidian/obsidian' }); },

  loadCats() {
    const all = cat.list();
    this.setData({
      catOptions: [{ id: null, label: '未分类' }].concat(
        all.map((c) => ({ id: c.id, label: cat.pathText(all, c.id) }))),
    });
  },

  onPickCat(e) {
    const idx = Number(e.detail.value);
    this.setData({ catIndex: idx, catLabel: this.data.catOptions[idx].label });
  },

  checkClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const text = (res.data || '').trim();
        if (text.length < 10 || text === this.data.raw) return;
        wx.showModal({
          title: '检测到剪贴板内容',
          content: text.slice(0, 60) + (text.length > 60 ? '…' : ''),
          confirmText: '导入', cancelText: '不用',
          success: (r) => { if (r.confirm) { this.setData({ raw: text }); this.doPreview(); } },
        });
      },
      // 隐私指引未配置 / 用户未授权时这里会失败 —— 静默跳过即可，
      // 用户仍可以手动点「粘贴」或直接手输，功能不受影响
      fail: (e) => { console.warn('[capture] 读取剪贴板失败（可能未配置隐私指引）', e); },
    });
  },

  onPaste() {
    wx.getClipboardData({
      success: (res) => {
        const text = (res.data || '').trim();
        if (!text) { wx.showToast({ title: '剪贴板是空的', icon: 'none' }); return; }
        this.setData({ raw: text });
        this.doPreview();
      },
      fail: () => {
        wx.showToast({ title: '读不到剪贴板，请手动长按输入框粘贴', icon: 'none' });
      },
    });
  },

  onInput(e) {
    this.setData({ raw: e.detail.value });
    this.schedulePreview();
  },

  onPickStrategy(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData({ strategyIndex: idx, strategyKey: this.data.strategies[idx].key });
    this.doPreview();
  },

  onCardSep(e) { this.setData({ cardSep: e.detail.value }); this.schedulePreview(); },
  onKvSep(e) { this.setData({ kvSep: e.detail.value }); this.schedulePreview(); },

  schedulePreview() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.doPreview(), 450);
  },

  doPreview() {
    const raw = (this.data.raw || '').trim();
    if (!raw) {
      this.setData({ preview: [], info: { total: 0, empty: 0, noAnswer: 0, withAnswer: 0 },
                     pickedName: '', moreCount: 0, modesBrief: '' });
      return;
    }
    // AI 切卡是异步的，单独走一条路
    if (this.data.strategyKey === 'ai') { this.doAiPreview(raw); return; }

    this.renderPreview(splitter.split(raw, this.data.strategyKey,
      { cardSep: this.data.cardSep, kvSep: this.data.kvSep }));
  },

  /** 统一渲染预览 —— 本地规则切分和 AI 切分共用同一套统计/诊断 */
  renderPreview(cards) {
    const info = splitter.inspect(cards);
    const usedKey = cards._picked || this.data.strategyKey;
    const used = this.data.strategies.filter((s) => s.key === usedKey)[0];

    // 整套卡片能出哪些题型（含"再多录几张就能出选择题"这类提示）
    const sum = quizcheck.summary(cards);
    const optionCards = cards.map((c, i) => Object.assign({}, c, {
      _i: i + 1,
      _modes: sum.details[i] ? sum.details[i].modeNames.join(' / ') : '',
      _level: sum.details[i] ? sum.details[i].level : 'ok',
    }));

    this.setData({
      preview: optionCards.slice(0, PREVIEW_N),
      moreCount: Math.max(0, cards.length - PREVIEW_N),
      info,
      pickedName: used ? used.name : '',
      modesBrief: sum.modeNames.length ? sum.modeNames.join(' / ') : '（还出不了题）',
      modesWeak: sum.weak,
      modesTotal: sum.total,
    });
  },

  /** AI 智能切卡：异步调云开发大模型；任何失败都退回本地「智能识别」 */
  async doAiPreview(raw) {
    // 提示文案一定要给，否则真机上"闪一下什么都没发生"
    if (!ai.enabled()) {
      this.fallbackFromAi('AI 未配置，已用本地智能识别');
      return;
    }
    this.setData({ aiBusy: true });
    wx.showLoading({ title: 'AI 正在读…', mask: false });
    let cards = null;
    try {
      cards = await ai.splitCards(raw);
    } catch (e) {
      console.warn('[capture] AI 切卡异常', e);
    }
    wx.hideLoading();
    this.setData({ aiBusy: false });
    if (!cards || !cards.length) {
      // 区分「调用失败」和「切不出来」，给的建议不一样
      const info = ai.envInfo();
      const why = info.hasAI ? 'AI 没切出来' : 'AI 当前不可用';
      this.fallbackFromAi(why + '，已改用本地智能识别');
      return;
    }
    this.renderPreview(cards);
  },

  /** 降级：切回本地「智能识别」，保证功能永远可用 */
  fallbackFromAi(msg) {
    const idx = this.data.strategies.findIndex((s) => s.key === 'smart');
    this.setData({ strategyIndex: idx < 0 ? 0 : idx, strategyKey: 'smart' });
    if (msg) wx.showToast({ title: msg, icon: 'none' });
    this.doPreview();
  },

  async onSplit() {
    const raw = (this.data.raw || '').trim();
    if (raw.length < 2) { wx.showToast({ title: '内容太短了', icon: 'none' }); return; }

    let cards;
    if (this.data.strategyKey === 'ai') {
      if (!ai.enabled()) {
        this.fallbackFromAi('还没配置云开发，已改用本地智能识别');
        wx.showModal({
          title: 'AI 切卡需要先配置',
          content: '去「关于这个工具」页填入云开发环境 ID 即可开启；没配置也能正常用，本地有 7 种规则切分方式。',
          confirmText: '知道了', showCancel: false,
        });
        return;
      }
      wx.showLoading({ title: 'AI 正在读你的讲义…', mask: true });
      try { cards = await ai.splitCards(raw); } catch (e) { console.warn(e); cards = null; }
      wx.hideLoading();
      if (!cards || !cards.length) {
        this.fallbackFromAi('AI 没切出来，已改用本地智能识别');
        return;
      }
    } else {
      cards = splitter.split(raw, this.data.strategyKey,
        { cardSep: this.data.cardSep, kvSep: this.data.kvSep });
    }
    if (!cards.length) { wx.showToast({ title: '没切出内容，检查一下格式', icon: 'none' }); return; }
    // 每张卡附带诊断，编辑时就能看到
    const sum = quizcheck.summary(cards);
    const withDiag = cards.map((c, i) => {
      const d = sum.details[i] || { modes: [], modeNames: [], tips: [], level: 'ok', levelText: '' };
      return Object.assign({}, c, {
        _modes: d.modeNames.join(' / '),
        _level: d.level,
        _tips: d.tips,
        _levelText: d.levelText,
      });
    });
    this.setData({ cards: withDiag, stage: 'edit' });
    this.notifyCoach('split');
  },

  onBack() { this.setData({ stage: 'input' }); },

  goHelp() { wx.navigateTo({ url: '/pages/help/help' }); },

  _refreshCardDiag() {
    // 内容被改动后，重新算这张卡的出题能力
    const sum = quizcheck.summary(this.data.cards);
    const cards = this.data.cards.map((c, i) => {
      const d = sum.details[i] || { modeNames: [], tips: [], level: 'ok', levelText: '' };
      return Object.assign({}, c, {
        _modes: d.modeNames.join(' / '),
        _level: d.level,
        _tips: d.tips,
        _levelText: d.levelText,
      });
    });
    this.setData({ cards });
  },

  onCardTitle(e) {
    this.setData({ ['cards[' + e.currentTarget.dataset.idx + '].title']: e.detail.value });
    this.scheduleDiag();
  },
  onCardContent(e) {
    this.setData({ ['cards[' + e.currentTarget.dataset.idx + '].content']: e.detail.value });
    this.scheduleDiag();
  },
  scheduleDiag() {
    if (this._dt) clearTimeout(this._dt);
    this._dt = setTimeout(() => this._refreshCardDiag(), 500);
  },

  onDelCard(e) {
    const cards = this.data.cards.slice();
    cards.splice(e.currentTarget.dataset.idx, 1);
    this.setData({ cards }, () => this._refreshCardDiag());
  },
  onMergeUp(e) {
    const i = e.currentTarget.dataset.idx;
    if (i <= 0) return;
    const cards = this.data.cards.slice();
    cards[i - 1].content = [cards[i - 1].content, cards[i].title, cards[i].content]
      .filter(Boolean).join('\n');
    cards.splice(i, 1);
    this.setData({ cards }, () => this._refreshCardDiag());
  },
  onAddBlank() {
    this.setData({ cards: this.data.cards.concat([{ title: '', content: '' }]) },
      () => this._refreshCardDiag());
  },

  onSave() {
    const cards = this.data.cards
      .map((c) => ({ title: (c.title || '').trim(), content: (c.content || '').trim() }))
      .filter((c) => c.title);
    if (!cards.length) { wx.showToast({ title: '没有可保存的内容', icon: 'none' }); return; }

    const noAnswer = cards.filter((c) => !c.content || c.content === c.title).length;
    if (noAnswer > 0) {
      wx.showModal({
        title: '有 ' + noAnswer + ' 张出不了好题',
        content: '这些卡片"问题"和"答案"是同一句（或没内容），只能出选择题/填空题，'
               + '判断题和默写题用不了。建议给它们补一句解释。',
        confirmText: '仍然保存', cancelText: '回去补',
        success: (r) => { if (r.confirm) this.doSave(cards); },
      });
      return;
    }
    this.doSave(cards);
  },

  doSave(cards) {
    const catId = this.data.catOptions[this.data.catIndex].id || null;
    store.addNotes(cards.map((c) => Object.assign({}, c, { categoryId: catId })));
    this.notifyCoach('save');
    wx.showToast({ title: '已保存 ' + cards.length + ' 张', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 700);
  },
});
