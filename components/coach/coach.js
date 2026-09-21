// components/coach/coach.js —— 交互式分步引导（健壮版 v2）
//
// 关键设计：两条路都能推进，绝不卡住
//   ① 用户点了高亮位置的真实控件 → 页面调 notify('action') → 前进
//   ② 用户直接点气泡上的按钮       → 也前进（兜底，不依赖页面回调）
//
// 定位：
//   boundingClientRect 返回的 top/left 已是「相对视口」，与 position:fixed 同坐标系，
//   **不做任何 scrollTop 换算**。
//   查不到元素 → 降级为居中气泡（不跳过、不退出）。
const tours = require('../../utils/tours.js');

Component({
  properties: {
    active: { type: Boolean, value: false },
    flow: { type: String, value: '' },
  },

  data: {
    debug: false,     // 设为 true 会在 console 输出定位坐标（仅供排查，不显示给用户）
    visible: false,
    steps: [],
    step: 0,
    cur: null,
    noHole: false,
    hole: { top: 0, left: 0, width: 0, height: 0 },
    tipTop: false,
    tipStyle: '',
    ready: false,
    screenW: 0,
    screenH: 0,
  },

  observers: {
    'active, flow': function (active, flow) {
      if (active && flow) this.start();
      else if (!active) this.setData({ visible: false });
    },
  },

  methods: {
    noop() {},

    start() {
      const tour = tours.get(this.data.flow);
      if (!tour || !tour.steps.length) {
        this.setData({ visible: false });
        this.triggerEvent('close', { flow: this.data.flow });
        return;
      }
      this.setData({
        visible: true, steps: tour.steps, step: 0, ready: false, noHole: false,
      }, () => this.locate());
    },

    getScreen() {
      try {
        const i = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        // 老接口返回 screenWidth，新接口返回 windowWidth，都兜一下
        return {
          w: i.windowWidth || i.screenWidth || 375,
          h: i.windowHeight || i.screenHeight || 667,
        };
      } catch (e) {
        return { w: 375, h: 667 };
      }
    },

    locate() {
      const s = this.data.steps[this.data.step];
      if (!s) { this.finish(); return; }

      const sc = this.getScreen();
      this.setData({ screenW: sc.w, screenH: sc.h });

      const fallback = (why) => {
        this.setData({
          cur: s,
          noHole: true,
          tipStyle: 'top:50%;transform:translateY(-50%)',
          ready: true,
        });
        console.warn('[coach] 未定位到 ' + s.target + ' — ' + why);
      };

      try {
        const q = wx.createSelectorQuery();
        q.select(s.target).boundingClientRect();
        q.exec((res) => {
          const r = res && res[0];
          if (!r || !r.width || !r.height) {
            fallback('元素不存在或尺寸为 0');
            return;
          }

          const pad = 8;
          // 夹到屏幕范围内，避免出现负宽高导致遮罩铺错
          const left = Math.max(0, Math.min(sc.w - 1, r.left - pad));
          const top = Math.max(0, Math.min(sc.h - 1, r.top - pad));
          const width = Math.max(1, Math.min(sc.w - left, r.width + pad * 2));
          const height = Math.max(1, Math.min(sc.h - top, r.height + pad * 2));

          const below = top + height;
          const spaceBelow = sc.h - below;
          const tipTop = spaceBelow < 260;

          this.setData({
            cur: s,
            noHole: false,
            hole: { top, left, width, height },
            tipTop,
            ready: true,
            tipStyle: tipTop
              ? 'bottom:' + Math.max(16, sc.h - top + 14) + 'px'
              : 'top:' + Math.min(Math.max(0, sc.h - 230), below + 14) + 'px',
          });
          if (this.data.debug) {
            console.log('[coach] ' + s.target + ' 原始 top:' + Math.round(r.top)
              + ' left:' + Math.round(r.left) + ' ' + Math.round(r.width)
              + '×' + Math.round(r.height) + ' | 屏幕 ' + sc.w + '×' + sc.h);
          }
        });
      } catch (e) {
        fallback('查询异常 ' + (e && e.message ? e.message : ''));
      }
    },

    relocate() {
      if (!this.data.visible || !this.data.ready || this.data.noHole) return;
      const now = Date.now();
      if (now - (this._last || 0) < 80) return;
      this._last = now;
      this.locate();
    },

    /** 页面在关键事件里调用（点了真实控件时） */
    notify(action) {
      if (!this.data.visible || !this.data.cur || this.data.noHole) return;
      if (this.data.cur.action && this.data.cur.action === action) this.next();
    },

    /** 气泡按钮：两条路都走这条路 —— 不依赖页面回调，保证不卡住 */
    onAdvance() {
      this.next();
    },

    next() {
      const n = this.data.step + 1;
      if (n >= this.data.steps.length) { this.finish(); return; }
      this.setData({ step: n, ready: false, noHole: false }, () => this.locate());
    },

    prev() {
      if (this.data.step <= 0) return;
      this.setData({ step: this.data.step - 1, ready: false, noHole: false },
        () => this.locate());
    },

    onMaskTap() {
      wx.showToast({ title: '请点高亮的位置', icon: 'none', duration: 900 });
    },

    skip() { this.finish(); },

    finish() {
      this.setData({ visible: false, ready: false, cur: null });
      this.triggerEvent('close', { flow: this.data.flow });
    },
  },
});
