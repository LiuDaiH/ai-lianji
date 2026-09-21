// utils/brand.js —— 品牌信息的唯一来源
//
// 想换名字 / 标语 / logo，只改这一个地方（页面、产品介绍、关于页都读它）。
//
// ★ 标语和描述有【两套】，按 features.AI 自动切换 ——
//   因为提交审核版里不能宣传 AI 功能（那是"描述与实际不符"）。
//   由 tools/toggle-ai.py 控制，不用手改。
//
// 命名规则备忘（腾讯客服原文）：
//   名称 4~30 个字符，1 个中文字 = 2 个字符 → 中文最少 2 个字
//   同一主体下公众号/小程序可同名，但不得与【不同主体】的公众号重名
//   境内账号每个自然年只能改 2 次名称，改名前务必先在公众平台注册页实测唯一性
//   简称 4~10 个字符、可以重名，会显示在客户端任务栏
//
// ⚠️ 名称里带 "AI" 但提交版没有 AI 功能 —— 审核标准里"名称需与功能强关联"这条，
//    主要防的是抢注热门词（比如叫「京东购物」实际是记账工具）。
//    「AI 链记」是自创词，且"链记"部分（双向链接 + 笔记）与功能相符，
//    风险较低。如果要更稳，可改成「链记」「链知」等不含 AI 的名字。

const FEATURES = require('./features.js');

// AI 版文案
const BRAND_AI = {
  TAGLINE: 'AI 学习引擎 · 掌握度写回 Obsidian',
  DESC: 'AI 负责整理和批改，你负责回忆。笔记不搬家，掌握度写回 Obsidian。',
};

// 提交审核版文案（不提 AI）
const BRAND_PLAIN = {
  TAGLINE: '讲义变成卡片 · 掌握度写回 Obsidian',
  DESC: '讲义粘进来自动切成知识点卡片，按收益排序复习，掌握度写回你的笔记。',
};

const brand = {
  NAME: 'AI 链记',
  NAME_TIGHT: 'AI链记',
  NAME_EN: 'AI Lianji',
  LOGO: '/images/logo/logo-256.png',
  LOGO_ROUND: '/images/logo/logo-round-256.png',
  VERSION: '1.0.0',
};

module.exports = Object.assign({}, brand, FEATURES.AI ? BRAND_AI : BRAND_PLAIN);
