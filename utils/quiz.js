// utils/quiz.js —— 自动出题（纯文本处理，不调用任何模型）
//
// 五种题型：
//   flip   翻转卡片：给标题回忆内容，可要提示，自评记得/忘了
//   choice 选择题  ：给内容，从其他卡片抽干扰项，选出正确标题
//   judge  判断题  ：给"标题+内容"，有 50% 概率把内容换成别的卡的，判断配对对不对
//   blank  填空题  ：挖掉内容里的术语，填回来
//   recall 默写题  ：给标题，自己打字写出内容，按关键词命中率判分

const ALL_MODES = ['flip', 'choice', 'judge', 'blank', 'recall'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function hasContent(note) {
  return !!(note && note.content && String(note.content).trim());
}

/** 找内容里的"术语"候选（用于挖空与关键词） */
function findTerms(content) {
  const c = String(content || '');
  const out = [];
  (c.match(/【([^】]{2,12})】/g) || []).forEach((m) => out.push(m.slice(1, -1)));
  (c.match(/\*\*([^*]{2,12})\*\*/g) || []).forEach((m) => out.push(m.slice(2, -2)));
  (c.match(/[「“"]([^」”"]{2,12})[」”"]/g) || []).forEach((m) => out.push(m.slice(1, -1)));
  (c.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || []).forEach((m) => out.push(m));
  (c.match(/\d+(\.\d+)?\s?(天|小时|分钟|秒|%|倍|次|个|字)/g) || []).forEach((m) => out.push(m.trim()));
  return Array.from(new Set(out.filter((t) => t && t.length >= 2 && t.length < c.length)));
}

/** 抽取关键词（用于默写题判分） */
function extractKeywords(content) {
  const c = String(content || '');
  const terms = findTerms(c);
  if (terms.length >= 4) return terms.slice(0, 8);
  const segs = c.split(/[，。；、！？,.;!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 8);
  return Array.from(new Set(terms.concat(segs))).slice(0, 8);
}

// ---------------- 各题型生成 ----------------

function makeFlip(note) {
  const content = note.content || '';
  const hints = [];
  if (content) {
    const kw = extractKeywords(content);
    if (kw.length) {
      hints.push('提示：包含 ' + kw.length + ' 个关键点，第一个以「' + kw[0].slice(0, 1) + '」开头');
    }
    if (content.length > 6) {
      hints.push('提示：前半句是「' + content.slice(0, Math.min(12, Math.ceil(content.length / 2))) + '…」');
    }
  }
  return { type: 'flip', noteId: note.id, stem: note.title, content, hints };
}

function makeChoice(note, allNotes) {
  const others = allNotes.filter((n) => n.id !== note.id && n.title && n.title !== note.title);
  if (others.length < 2) return null;
  const wrong = shuffle(others).slice(0, 3).map((n) => n.title);
  const stem = hasContent(note) ? note.content.slice(0, 80) : note.title;
  return {
    type: 'choice', noteId: note.id, stem,
    options: shuffle([note.title].concat(wrong)), answer: note.title,
  };
}

function makeJudge(note, allNotes) {
  if (!hasContent(note)) return null;
  const others = allNotes.filter((n) => n.id !== note.id && hasContent(n));
  const canSwap = others.length >= 1;
  const doSwap = canSwap && Math.random() < 0.5;
  const shown = doSwap ? pick(others).content : note.content;
  return { type: 'judge', noteId: note.id, stem: note.title,
           text: String(shown).slice(0, 90), answer: !doSwap };
}

function makeBlank(note) {
  if (!hasContent(note)) return null;
  const terms = findTerms(note.content);
  if (!terms.length) return null;
  const p = shuffle(terms)[0];
  return { type: 'blank', noteId: note.id, stem: note.title,
           text: String(note.content).replace(p, '______'), answer: p };
}

function makeRecall(note) {
  if (!hasContent(note)) return null;
  const keywords = extractKeywords(note.content);
  if (!keywords.length) return null;
  return { type: 'recall', noteId: note.id, stem: note.title, keywords, answer: note.content };
}

/** 默写判分：返回 0~1 的命中率 */
function scoreRecall(input, keywords) {
  const t = String(input || '').trim().toLowerCase();
  if (!t || !keywords || !keywords.length) return 0;
  const hit = keywords.filter((k) => t.indexOf(String(k).toLowerCase()) >= 0).length;
  return hit / keywords.length;
}

/**
 * 这张卡「按熟练度推荐」考哪些题型（现有设计：先认脸、再上难度）
 * 注意：这只是「推荐顺序」，不是「限制」。用户在设置里显式选中的题型优先。
 */
function modesFor(note) {
  const n = note.reviewCount || 0;
  const a = note.alpha || 1;
  const b = note.beta || 1;
  const errRate = b / (a + b);

  let list;
  if (n === 0) list = ['flip', 'choice', 'flip', 'judge'];
  else if (n <= 2 || errRate > 0.5) list = ['choice', 'judge', 'flip', 'choice'];
  else list = ['blank', 'recall', 'judge', 'choice'];

  if (!hasContent(note)) list = ['choice', 'flip'];
  return Array.from(new Set(list));
}

/**
 * 这张卡「技术上」能出哪些题 —— 只看内容，不看熟练度。
 * 用途：用户在设置里显式选了题型时，不该被"新卡不给填空题"这类规则挡住。
 */
function capableModes(note) {
  const out = ['flip', 'choice'];              // 有标题就能出
  if (hasContent(note)) {
    out.push('judge');
    if (findTerms(note.content).length >= 1) out.push('blank');
    if (extractKeywords(note.content).length >= 2) out.push('recall');
  }
  // 选择题需要至少 3 张卡才有干扰项（在 makeQuiz 里用实际候选池再校验）
  return out;
}

function pickMode(note) { return pick(modesFor(note)); }

/** 按题型生成题目，失败则逐级退回 */
function buildQuestion(mode, note, allNotes) {
  const order = [mode, 'choice', 'flip'];
  for (let i = 0; i < order.length; i += 1) {
    const m = order[i];
    let q = null;
    if (m === 'choice') q = makeChoice(note, allNotes);
    else if (m === 'judge') q = makeJudge(note, allNotes);
    else if (m === 'blank') q = makeBlank(note);
    else if (m === 'recall') q = makeRecall(note);
    else if (m === 'flip') q = makeFlip(note);
    if (q) return q;
  }
  return null;
}

/**
 * 生成一套题
 * @param {Array} notes  候选卡片
 * @param {number} count 题量（0/undefined = 全部）
 * @param {Array} allowed 允许的题型（空/不传 = 五种都可用）
 */
function makeQuiz(notes, count, allowed) {
  const allow = (Array.isArray(allowed) && allowed.length) ? allowed : ALL_MODES;
  const all = (notes || []).filter((n) => n && n.title);
  if (!all.length) return [];

  const picked = (typeof count === 'number' && count > 0) ? all.slice(0, count) : all;

  const used = {};
  const out = [];

  picked.forEach((n) => {
    // ① 先看这张卡「技术上」能出什么，并对齐用户的选择
    const capable = capableModes(n).filter((m) => allow.indexOf(m) >= 0);
    if (!capable.length) return;                 // 这张卡在所选题型下确实出不了

    // ② 在可行的题型里，优先用「熟练度推荐」的（推荐为空说明用户选的题型
    //    不在推荐范围里 —— 那就尊重用户的选择，按 capable 的顺序来）
    const pref = modesFor(n).filter((m) => capable.indexOf(m) >= 0);
    const cands = pref.length ? pref : capable;

    // ③ 选本轮用得最少的，保证同一轮题型有变化
    let mode = cands[0];
    let best = used[mode] || 0;
    cands.forEach((m) => {
      const c = used[m] || 0;
      if (c < best) { best = c; mode = m; }
    });

    const q = buildQuestion(mode, n, all);
    if (!q) return;
    if (allow.indexOf(q.type) < 0) return;       // 退回出来的题型若不在允许范围，跳过
    used[q.type] = (used[q.type] || 0) + 1;
    out.push(q);
  });

  return out;
}

const MODE_LABELS = [
  { key: 'flip',   name: '翻转卡片', desc: '给标题回忆内容' },
  { key: 'choice', name: '选择题',   desc: '从别的卡里抽干扰项' },
  { key: 'judge',  name: '判断题',   desc: '判断配对对不对' },
  { key: 'blank',  name: '填空题',   desc: '挖掉关键词填回来' },
  { key: 'recall', name: '默写题',   desc: '自己写出来，最难' },
];

module.exports = {
  makeQuiz, buildQuestion, pickMode, modesFor, capableModes, MODE_LABELS, ALL_MODES,
  makeFlip, makeChoice, makeJudge, makeBlank, makeRecall,
  scoreRecall, findTerms, extractKeywords, hasContent, shuffle,
};
