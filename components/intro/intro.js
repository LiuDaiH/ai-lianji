// components/intro/intro.js —— 产品介绍（全屏 5 屏动画）
// 默认每次打开小程序都放一遍（由 app.onLaunch 放旗子 + 首页触发），
// 用户可以在最后一屏取消勾选「每次打开都显示」。
// ============================================================
//  两套产品介绍内容 —— 按 AI 是否可用二选一
//  ★ 非 AI 版不能只改正文、却留着"AI 学习引擎""AI 不给答案"这些视觉元素，
//    那是"描述与实际不符"，审核会打回。所以文案和视觉元素一起换。
// ============================================================

const SLIDES_AI = [
  {
    tag: '这是什么',
    title: '把讲义变成会考你的卡片',
    desc: '粘一段讲义进来，自动切成一张张知识点卡片。到该复习的时候，它会用 5 种方式考你，答对就把下次复习往后推。',
  },
  {
    tag: '★ 核心创新点 ①',
    title: 'AI 学习引擎，贯穿全流程',
    desc: '切卡 · 判分 · 提示 · 错因诊断 · 学习诊断，五处都有 AI。但 AI 只负责「整理」和「批改」，答题必须你自己来。',
    hot: true,
  },
  {
    tag: '★ 核心创新点 ②',
    title: 'Obsidian 笔记双向同步',
    desc: '别的软件把你锁在它自己的数据库里。这个不一样 —— 你的笔记还在原来的 vault 里，学完只多出一行掌握度。',
    hot: true,
  },
  {
    tag: '第一步 · 录入',
    title: '粘贴或导入，自动切卡',
    desc: '从 Obsidian 导入 .md 或整个 vault 的 zip，按「文件夹 → 标题层级」自动建出类别树；格式再乱也能交给 AI 切成卡片。',
  },
  {
    tag: '第二步 · 复习',
    title: '5 种题型按熟练度换',
    desc: '生的内容用翻转卡片和选择题，熟了换成填空题和默写题。卡住时 AI 给方向，答错了 AI 告诉你错在哪。',
  },
  {
    tag: '第三步 · 看进步',
    title: '掌握度写回笔记，看得见',
    desc: '每个标题下面会多一条 Obsidian 高亮块：绿色已掌握、橙色薄弱。AI 还会读你的数据，告诉你现在该练什么。',
  },
];

const SLIDES_PLAIN = [
  {
    tag: '这是什么',
    title: '把讲义变成会考你的卡片',
    desc: '粘一段讲义进来，自动切成一张张知识点卡片。到该复习的时候，它会用 5 种方式考你，答对就把下次复习往后推。',
  },
  {
    tag: '★ 核心创新点 ①',
    title: '乱格式讲义，一键变卡片',
    desc: 'PPT 复制的一坨、编号错位的笔记都能识别：自动判断结构、切出独立可考的知识点，切得不对还能手动调。',
    hot: true,
  },
  {
    tag: '★ 核心创新点 ②',
    title: 'Obsidian 笔记双向同步',
    desc: '别的软件把你锁在它自己的数据库里。这个不一样 —— 你的笔记还在原来的 vault 里，学完只多出一行掌握度。',
    hot: true,
  },
  {
    tag: '第一步 · 录入',
    title: '粘贴或导入，自动切卡',
    desc: '从 Obsidian 导入 .md 或整个 vault 的 zip，按「文件夹 → 标题层级」自动建出类别树；也可以直接粘一段讲义。',
  },
  {
    tag: '第二步 · 复习',
    title: '5 种题型按熟练度换',
    desc: '生的内容用翻转卡片和选择题，熟了换成填空题和默写题。卡住时能要个提示，答错会告诉你错在哪一类。',
  },
  {
    tag: '第三步 · 看进步',
    title: '掌握度写回笔记，看得见',
    desc: '每个标题下面会多一条 Obsidian 高亮块：绿色已掌握、橙色薄弱。统计页还会告诉你最该补哪 5 张。',
  },
];

const AI_CORE = 'AI';
const PLAIN_CORE = '自动';
const AI_BOUNDARY = 'AI 不给答案 · 回忆必须你自己完成';
const PLAIN_BOUNDARY = '只做整理和判分 · 回忆必须你自己完成';

const AI_CHIPS = ['智能切卡', '语义判分', '分层提示', '错因诊断', '学习诊断'];
const PLAIN_CHIPS = ['结构识别', '自动切卡', '收益排序', '掌握度回写', '难点分析'];

Component({
  properties: {
    show: { type: Boolean, value: false },
    closable: { type: Boolean, value: true },
  },

  data: {
    brand: require('../../utils/brand.js'),
    aiOn: false,          // 非 AI 版会把主打 AI 的那一屏换成通用文案
    visible: false,
    slide: 0,
    always: true,       // 「每次打开都显示」勾选状态
    slides: SLIDES_PLAIN,          // 初始给非 AI 版（安全），applyAiSlide() 按开关换
    introCore: PLAIN_CORE,
    introChips: PLAIN_CHIPS,
    introBoundary: PLAIN_BOUNDARY,

    heatDemo: [0, 1, 0, 2, 3, 1, 0, 1, 2, 0, 3, 2, 0, 1, 1, 2, 0, 3, 1, 0, 0, 2, 1, 0,
               1, 0, 2, 3, 1, 0, 1, 1, 0, 2, 0, 1, 3, 2, 1, 0, 1, 0, 2, 1, 0, 3, 1, 0],
  },

  observers: {
    show(val) {
      if (val) {
        let always = true;
        try { always = wx.getStorageSync('sc_intro_always') !== 0; } catch (e) { always = true; }
        this.applyAiSlide();                 // ← 按 AI 是否可用换整套产品介绍内容
        this.setData({ visible: true, slide: 0, always });
      } else {
        this.setData({ visible: false });
      }
    },
  },

  methods: {
    /**
     * 按 AI 是否可用切换【整套】产品介绍内容（文案 + 视觉元素一起换）
     * 漏换任何一处都会变成"描述与实际不符"，审核会打回。
     */
    applyAiSlide() {
      const on = require('../../utils/ai.js').enabled();
      this.setData({
        aiOn: on,
        slides: on ? SLIDES_AI : SLIDES_PLAIN,
        introCore: on ? AI_CORE : PLAIN_CORE,
        introChips: on ? AI_CHIPS : PLAIN_CHIPS,
        introBoundary: on ? AI_BOUNDARY : PLAIN_BOUNDARY,
      });
    },

    noop() {},
    onSwiper(e) { this.setData({ slide: e.detail.current }); },
    onDot(e) { this.setData({ slide: Number(e.currentTarget.dataset.i) }); },

    onToggleAlways() { this.setData({ always: !this.data.always }); },

    onNext() {
      const n = this.data.slide + 1;
      if (n >= this.data.slides.length) { this.finish(); return; }
      this.setData({ slide: n });
    },

    onSkip() { this.finish(); },

    finish() {
      try { wx.setStorageSync('sc_intro_always', this.data.always ? 1 : 0); } catch (e) { /* ignore */ }
      this.setData({ visible: false });
      this.triggerEvent('close', { always: this.data.always });
    },
  },
});
