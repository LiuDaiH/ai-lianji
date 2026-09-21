// utils/ai.js —— 【提交审核版】本地实现（空壳）
//
// ⚠️ 这不是"删掉了 AI"，而是"AI 能力整体摘除但接口保留"。
//    真实实现在 ../ai-backup/ai.js，该目录未被小程序打包（packOptions.ignore）。
//
// 为什么这么做：
//   微信规定「深度合成 - AI 问答」类目只对企业/个体户开放，个人主体申请不了。
//   正式版带 AI 能力 → 审核要求补类目 → 驳回。
//   所以提交审核的包里做到「零 AI 痕迹」，同时把完整实现留在项目里。
//
// 这个空壳的设计要点：
//   · 接口签名与真实实现【完全一致】—— 页面代码一行都不用改
//   · enabled() 恒为 false → 所有挂在它上面的 AI 界面元素自动隐藏
//   · 所有业务函数返回 null → 调用方自动走本地降级路径（本来就有）
//   · 内部不引用 wx.cloud，包里不存在任何云开发 AI 调用
//
// 【恢复 AI 版】python tools/toggle-ai.py on

const FEATURES = [];                       // 能力清单为空 → 关于页的 AI 卡自动不显示

function notAvailable() { return null; }

module.exports = {
  MODEL: '',
  FEATURES,

  // 配置
  getEnv: () => '',
  setEnv: () => {},
  isOff: () => true,
  setOff: () => {},
  getUserEnv: () => '',
  hasBuiltin: () => false,
  usingBuiltin: () => false,
  status: () => ({
    off: true, userEnv: '', usingBuiltin: false, hasBuiltin: false, env: '', active: false,
  }),

  // 环境探测（界面自检用）
  envInfo: () => ({ hasCloud: false, hasExtend: false, hasAI: false, sdk: '', err: '' }),
  sdkAtLeast: () => false,

  // 可用性
  supported: () => false,
  enabled: () => false,
  ensureInit: () => false,

  // 底层
  chat: async () => null,
  pickJSON: () => null,

  // 5 个业务能力 —— 统一返回 null，调用方自动降级到本地算法
  splitCards: async () => notAvailable(),
  gradeRecall: async () => notAvailable(),
  hintFor: async () => notAvailable(),
  diagnoseWrong: async () => notAvailable(),
  studyAdvice: async () => notAvailable(),

  // 连通性自检
  ping: async () => ({
    ok: false,
    msg: '本版本不含 AI 能力（使用本地算法）。如需启用请见 ai-backup/README.md',
  }),
};
