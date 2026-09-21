// utils/splitter.js —— 文本切卡（多策略 + 自定义分隔符）
//
// 为什么要有多种策略？
//   "标题 + 内容" 的结构在不同来源里差别很大：
//     · 从 PPT 复制    → 常常是「短标题行 + 长解释行」交替，没有空行
//     · 自己整理的笔记  → 常用空行分段
//     · 提纲 / 列表     → 一行一个知识点，本身就是内容
//     · 一大段连续文字  → 只能按句子拆
//   没有一种规则能通吃，所以让用户自己挑，并给出实时预览。
//
// 核心承诺：**产出卡片的内容尽量不为空**（内容为空会砍掉一半题型）。

const TITLE_MAX = 22;      // 超过这个长度就不太像"标题"
const SENTENCE_MIN = 60;   // 段落超过这个长度，考虑按句子拆

/** 一行像不像"标题"：够短、且结尾不是句末标点 */
function isTitleLike(line) {
  const s = String(line || '').trim();
  if (!s) return false;
  if (s.length > TITLE_MAX) return false;
  if (/[。！？；.!?;]$/.test(s)) return false;
  return true;
}

/** 太长的行当标题时截断 */
function shortTitle(line) {
  const s = String(line || '').trim();
  return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX) + '…' : s;
}

function cleanLine(s) {
  return String(s || '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^(\d+[.、)）]|[一二三四五六七八九十]+[、.）)])\s*/, '')
    .replace(/^[·•\-*\u2022]\s*/, '')
    .trim();
}

/** 收尾统一处理：标题空则用内容、内容空则用标题 —— 保证两边都不空 */
function finalize(cards) {
  return cards
    .map((c) => {
      let title = String(c.title || '').trim();
      let content = String(c.content || '').trim();
      if (!title && content) title = shortTitle(content);
      if (!content && title) content = title;      // 只有一行时，两边都填上
      return { title, content };
    })
    .filter((c) => c.title);
}

// ---------------------------------------------------------------- 各策略

/** 1. 一行一张卡：整行当内容，标题自动截取 */
function byLine(raw) {
  return finalize(
    String(raw).split('\n').map((l) => l.trim()).filter(Boolean)
      .map((line) => {
        const t = cleanLine(line);
        return { title: shortTitle(t), content: t };
      })
  );
}

/** 2. 标题 + 内容成对：短行当标题，紧随的长行当内容 */
function byPair(raw) {
  const lines = String(raw).split('\n').map((l) => l.trim()).filter(Boolean);
  const cards = [];
  let cur = null;
  lines.forEach((line) => {
    const t = cleanLine(line);
    if (isTitleLike(t)) {
      if (cur) cards.push(cur);
      cur = { title: t, content: '' };
    } else if (cur) {
      cur.content = cur.content ? cur.content + '\n' + t : t;
    } else {
      // 开头就是长行 → 自成一张
      cards.push({ title: shortTitle(t), content: t });
      cur = null;
    }
  });
  if (cur) cards.push(cur);
  return finalize(cards);
}

/** 3. 空行分段：段内首行当标题，其余作内容 */
function byBlank(raw) {
  const blocks = String(raw).split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  const cards = blocks.map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 1) {
      const t = cleanLine(lines[0]);
      return { title: shortTitle(t), content: t };
    }
    const head = cleanLine(lines[0]);
    if (head.length > TITLE_MAX) {
      const text = lines.map(cleanLine).join('\n');
      return { title: shortTitle(text), content: text };
    }
    return { title: head, content: lines.slice(1).map(cleanLine).join('\n') };
  });
  return finalize(cards);
}

/** 4. 按句子拆：先分段，段太长就按句末标点拆 */
function bySentence(raw) {
  const blocks = String(raw).split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  const cards = [];
  blocks.forEach((block) => {
    const flat = block.replace(/\n+/g, '');
    const n = (flat.match(/[。！？!?；;]/g) || []).length;
    if (n < 2) {
      const t = cleanLine(flat);
      cards.push({ title: shortTitle(t), content: t });
      return;
    }
    const sents = flat.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
    sents.forEach((s) => {
      const t = cleanLine(s);
      cards.push({ title: shortTitle(t), content: t });
    });
  });
  return finalize(cards);
}

/** 5. 竖线分隔：`标题 | 内容`，一行一张 */
function byPipe(raw) {
  return finalize(
    String(raw).split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const seg = line.split(/[|｜]/);
      if (seg.length > 1) {
        return { title: cleanLine(seg[0]), content: seg.slice(1).join(' | ').trim() };
      }
      const t = cleanLine(line);
      return { title: shortTitle(t), content: t };
    })
  );
}

/** 6. 自定义分隔符 */
function byCustom(raw, opts) {
  const o = opts || {};
  const cardSep = (o.cardSep || '').trim();
  const kvSep = (o.kvSep || '').trim();

  const chunks = cardSep
    ? String(raw).split(cardSep)
    : String(raw).split('\n');

  const cards = chunks.map((chunk) => {
    const c = String(chunk).trim();
    if (!c) return null;
    if (kvSep) {
      const i = c.indexOf(kvSep);
      if (i > 0) {
        return { title: cleanLine(c.slice(0, i)), content: c.slice(i + kvSep.length).trim() };
      }
    }
    const t = cleanLine(c);
    return { title: shortTitle(t), content: t };
  }).filter(Boolean);

  return finalize(cards);
}

// ---------------------------------------------------------------- 智能识别

/**
 * 智能识别 —— 用「输入的结构信号」判断，而不是给结果打分
 *
 * 为什么不用打分：我先试过用"内容独立度 / 均长"给各策略打分，
 * 结果 blank 会把"多个知识点用换行分隔"的输入当成一整段（只切出 1 张卡），
 * 却因为"卡片内容很长"而拿到高分 —— 明显切错反而胜出。
 * 改成按结构信号判断后，六种典型输入全部命中正确策略。
 */
function smart(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const blocks = text.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  const titleLikeN = lines.filter(isTitleLike).length;
  const pipeN = lines.filter((l) => /[|｜]/.test(l)).length;
  const avgLen = lines.reduce((a, l) => a + l.length, 0) / lines.length;

  // ① 有空行分段 → 段内首行当标题
  if (blocks.length >= 2) return run(text, 'blank');

  // ② 多数行带竖线 → 竖线分隔
  if (pipeN / lines.length >= 0.6) return run(text, 'pipe');

  // ③ 只有一行、且不止一句 → 按句子拆
  const sentN = (text.match(/[。！？!?；;]/g) || []).length;
  if (lines.length === 1 && sentN >= 2) return run(text, 'sentence');

  // ④ 短行与长行交替（有短行、但并非全是短行）→ 标题+内容成对
  if (lines.length >= 2 && titleLikeN >= 1 && titleLikeN < lines.length) {
    return run(text, 'pair');
  }

  // ⑤ 大多数行都短（条目型）→ 一行一张
  if (titleLikeN / lines.length >= 0.6) return run(text, 'line');

  // ⑥ 没有短行、且是多行 → 每行本身就是一条知识点
  if (titleLikeN === 0 && lines.length >= 2) return run(text, 'line');

  return run(text, 'blank');
}

function run(raw, key, opts) {
  let cards;
  switch (key) {
    case 'line': cards = byLine(raw); break;
    case 'pair': cards = byPair(raw); break;
    case 'sentence': cards = bySentence(raw); break;
    case 'pipe': cards = byPipe(raw); break;
    case 'custom': cards = byCustom(raw, opts); break;
    case 'blank':
    default: cards = byBlank(raw); break;
  }
  // 记录实际用了哪个策略 —— 界面会显示"系统判断为：xxx"
  cards._picked = key;
  return cards;
}

/** 统一入口 */
function split(raw, strategy, opts) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  if (!strategy || strategy === 'smart') return smart(text);
  return run(text, strategy, opts);
}

/** 兼容旧调用 */
function splitToCards(raw) {
  return split(raw, 'smart');
}

const STRATEGIES = [
  { key: 'smart',    name: '智能识别',  desc: '自动挑最合适的一种（推荐）' },
  { key: 'pair',     name: '标题+内容', desc: '短行当标题、紧随的长行当内容' },
  { key: 'blank',    name: '空行分段',  desc: '空行之间算一条，首行当标题' },
  { key: 'line',     name: '一行一张',  desc: '每行一张卡，整行作为内容' },
  { key: 'sentence', name: '按句子拆',  desc: '长段落按句号拆成多张' },
  { key: 'pipe',     name: '竖线分隔',  desc: '「标题 | 内容」，一行一张' },
  { key: 'custom',   name: '自定义',    desc: '自己指定两个分隔符' },
];

/**
 * 预览统计
 *   empty     内容完全为空（正常不该出现）
 *   noAnswer  内容 === 标题，即"没有独立答案"（只给了问题没给答案）
 *   withAnswer 有独立答案 —— 这部分卡片能出全部 5 种题型
 */
function inspect(cards) {
  const total = cards.length;
  const empty = cards.filter((c) => !c.content).length;
  const noAnswer = cards.filter((c) => c.content && c.content === c.title).length;
  const avg = total
    ? Math.round(cards.reduce((s, c) => s + c.title.length + (c.content || '').length, 0) / total)
    : 0;
  return { total, empty, noAnswer, withAnswer: total - empty - noAnswer, avg };
}

module.exports = { split, splitToCards, STRATEGIES, inspect, TITLE_MAX, SENTENCE_MIN };
