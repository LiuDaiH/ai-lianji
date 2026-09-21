// utils/features.js —— 功能总开关（由 tools/toggle-ai.py 维护）
//
// AI = true  → AI 版（需要「深度合成 - AI 问答」类目，只对企业/个体户开放）
// AI: false = 提交审核版（本地算法，零 AI 痕迹）

module.exports = {
  AI: false,

  // 由 toggle-ai.py 写入，用来提示当前是哪一版
  BUILD_MODE: 'submit',
};
