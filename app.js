// app.js —— 全局逻辑（不依赖云开发）
App({
  globalData: {
    version: '1.0.0',
  },

  onLaunch() {
    // 首次启动时做一次存储可用性自检
    try {
      wx.setStorageSync('sc_probe', 1);
      wx.removeStorageSync('sc_probe');
    } catch (e) {
      console.error('[app] 本地存储不可用', e);
    }

    // 每次打开小程序都要放一遍产品介绍 —— 这里只放一面"旗子"，
    // 真正弹介绍的时机交给首页，避免在其它页面弹。
    try { wx.setStorageSync('sc_intro_pending', 1); } catch (e) { /* ignore */ }
  },
});
