// pages/help/help.js —— 产品介绍（动画）+ 操作引导入口
const tours = require('../../utils/tours.js');
const store = require('../../utils/store.js');
const stats = require('../../utils/stats.js');
const brand = require('../../utils/brand.js');
const ai = require('../../utils/ai.js');

Page({
  data: {
    brand,
    // AI 能力配置
    aiFeatures: ai.FEATURES,
    aiEnv: '', aiState: 'unknown', aiMsg: '', aiTesting: false,
    aiOff: false, aiUsingBuiltin: false,
    slide: 0,
    slides: [
      {
        tag: '这是什么',
        title: '把讲义变成会考你的卡片',
        desc: '粘一段讲义进来，自动切成一张张知识点卡片。到该复习的时候，它会用 5 种方式考你。',
      },
      {
        tag: '第一步 · 录入',
        title: '粘贴，自动切卡',
        desc: '一行一个知识点最省事；段落之间空一行也会自动分段。打开时还会自动检测剪贴板。',
      },
      {
        tag: '第二步 · 复习',
        title: '5 种题型，按熟练度换',
        desc: '生的内容用翻转卡片和选择题，熟了换成填空题和默写题。间隔会随表现自适应伸缩。',
      },
      {
        tag: '第三步 · 小测',
        title: '练完自动排下次',
        desc: '答对间隔拉长，答错提前复习。时间有限还能选「只练 10 分钟」，只挑最该练的几张。',
      },
      {
        tag: '第四步 · 看进步',
        title: '热力图 + 掌握度',
        desc: '连续学习天数、学习热力图、最需要补的 5 张，都在「统计」页。数据全在本机，可导出备份。',
      },
    ],
    heatDemo: [0, 1, 0, 2, 3, 1, 0, 1, 2, 0, 3, 2, 0, 1, 1, 2, 0, 3, 1, 0, 0, 2, 1, 0,
               1, 0, 2, 3, 1, 0, 1, 1, 0, 2, 0, 1, 3, 2, 1, 0, 1, 0, 2, 1, 0, 3, 1, 0],
    tours: [], totalCards: 0,
    introMode: 'first',
    hapticOn: true,
    modeOptions: [
      { key: 'first',  label: '仅首次打开时', desc: '推荐 —— 不打扰老用户' },
      { key: 'always', label: '每次打开都显示', desc: '想让新用户每次都看到时用' },
      { key: 'never',  label: '不再自动显示', desc: '需要时从本页手动打开' },
    ],
  },

  onLoad() {
    let mode = 'first';
    try { mode = wx.getStorageSync('sc_intro_mode') || 'first'; } catch (e) { mode = 'first'; }
    this.setData({ tours: tours.menu(), totalCards: store.listNotes().length, introMode: mode,
      hapticOn: require('../../utils/haptic.js').readSetting() });
  },

  onShow() {
    const st = ai.status();
    this.setData({
      aiEnv: st.userEnv,                 // ⚠️ 只显示用户自己填的，不暴露内置 ID
      aiOff: st.off,
      aiUsingBuiltin: st.usingBuiltin,
      aiState: st.off ? 'empty' : 'unknown',
      aiMsg: st.off ? '已关闭 —— 全部使用本地算法' : '',
    });
    this.setData({ totalCards: store.listNotes().length });
  },

  onSwiper(e) { this.setData({ slide: e.detail.current }); },
  onDot(e) { this.setData({ slide: Number(e.currentTarget.dataset.i) }); },

  /** 启动某个引导模块（跳到对应页面后自动开始） */
  onStartTour(e) {
    const key = e.currentTarget.dataset.key;
    const t = tours.get(key);
    if (!t) return;

    if (t.page === 'index' || t.page === 'review' || t.page === 'stats') {
      wx.setStorageSync('sc_tour_pending', key);
      if (t.page === 'stats') {
        // 统计页在同 tab 组里，用 switchTab
        wx.switchTab({ url: '/pages/stats/stats' });
      } else if (t.page === 'index') {
        wx.switchTab({ url: '/pages/index/index' });
      } else {
        wx.switchTab({ url: '/pages/review/review' });
      }
    } else {
      wx.setStorageSync('sc_tour_pending', key);
      wx.navigateTo({ url: '/pages/capture/capture' });
    }
  },

  /* ==================== AI 能力配置 ==================== */

  onAiEnvInput(e) { this.setData({ aiEnv: e.detail.value, aiState: 'unknown', aiMsg: '' }); },

  onSaveAiEnv() {
    const v = (this.data.aiEnv || '').trim();
    ai.setEnv(v);
    const st = ai.status();
    this.setData({
      aiUsingBuiltin: st.usingBuiltin,
      aiState: 'saved',
      aiMsg: v
        ? '已保存，将使用你自己填的环境'
        : (st.hasBuiltin ? '已清空，改回使用应用内置的 AI 环境' : '已清空 —— AI 能力关闭，全部退回本地算法'),
    });
    wx.showToast({ title: '已保存', icon: 'none' });
  },

  /** 一键关闭 / 开启 AI（关闭后完全走本地算法） */
  onToggleAi() {
    const next = !this.data.aiOff;
    ai.setOff(next);
    const st = ai.status();
    this.setData({
      aiOff: next,
      aiState: next ? 'empty' : 'unknown',
      aiMsg: next ? '已关闭 —— 全部使用本地算法，功能不受影响' : '',
      aiUsingBuiltin: st.usingBuiltin,
    });
    wx.showToast({ title: next ? '已关闭 AI' : '已开启 AI', icon: 'none' });
  },

  /** 清空自己填的 ID（回到内置环境） */
  onResetAiEnv() {
    ai.setEnv('');
    ai.setOff(false);
    const st = ai.status();
    this.setData({
      aiEnv: '',
      aiOff: false,
      aiUsingBuiltin: st.usingBuiltin,
      aiState: 'empty',
      aiMsg: st.hasBuiltin ? '已恢复默认（使用应用内置的 AI 环境）' : '已清空',
    });
    wx.showToast({ title: '已恢复默认', icon: 'none' });
  },

  async onTestAi() {
    if (this.data.aiTesting) return;
    (this.data.aiEnv || '').trim() && ai.setEnv(this.data.aiEnv.trim());
    this.setData({ aiTesting: true, aiMsg: '正在调用模型…' });
    const r = await ai.ping();
    this.setData({ aiTesting: false, aiState: r.ok ? 'ok' : 'fail', aiMsg: r.msg });
    wx.showToast({ title: r.ok ? 'AI 连通' : '未连通', icon: r.ok ? 'success' : 'none' });
  },

  onAiHelp() {
    wx.setClipboardData({
      data: [
        '【怎么开启 AI 能力】',
        '1. 微信开发者工具 → 顶部「云开发」→ 开通并创建环境（有免费额度）',
        '2. 云开发控制台 → AI → 生文模型 → 把需要的模型打开',
        '3. 把环境的「环境 ID」复制到本页输入框，点保存',
        '4. 点「测试连通性」，显示 AI 已连通就好了',
        '',
        '说明：',
        '· 小程序基础库需 3.15.1 及以上',
        '· API Key 由云开发托管，不落在前端，也不用配域名白名单',
        '· 环境 ID 存在手机本地，不上传任何地方',
        '· 没配置也不影响使用：AI 切卡自动降级为本地「智能识别」，',
        '  默写判分自动降级为关键词命中率',
      ].join('\n'),
      success: () => wx.showToast({ title: '开启步骤已复制', icon: 'none' }),
    });
  },

  onPickIntroMode(e) {
    const key = e.currentTarget.dataset.key;
    try { wx.setStorageSync('sc_intro_mode', key); } catch (err) { /* ignore */ }
    if (key === 'first') { try { wx.removeStorageSync('sc_intro_done'); } catch (err) { /* ignore */ } }
    this.setData({ introMode: key });
    wx.showToast({ title: '已设置', icon: 'success' });
  },

  onToggleHaptic() {
    const next = !this.data.hapticOn;
    require('../../utils/haptic.js').setEnabled(next);
    this.setData({ hapticOn: next });
    if (next) require('../../utils/haptic.js').tap();
  },

  onShowIntroNow() {
    // ⚠️ index 是 tabBar 页，必须用 switchTab；navigateTo 跳 tabBar 页会直接失败
    wx.switchTab({ url: '/pages/index/index' });
    wx.showToast({ title: '回首页可再看一次', icon: 'none' });
  },

  goCapture() { wx.navigateTo({ url: '/pages/capture/capture' }); },
  goPractice() { wx.switchTab({ url: '/pages/practice/practice' }); },

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
      console.error('[help] 导出失败', e);
      wx.showToast({ title: '导出失败', icon: 'none' });
    }
  },
});
