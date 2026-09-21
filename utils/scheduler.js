// utils/scheduler.js —— 自适应复习调度（带决策解释）
//
// 与"固定遗忘曲线"的区别：
//   传统：间隔写死 1→2→4→7→15 天，到期就全推给你。
//   本模块：① 间隔按实际表现自适应伸缩；
//           ② 每天在"时间有限"前提下，按收益给卡片排序；
//           ③ 题型也随熟练度自适应（见 quiz.modesFor）。
//
// 本文件还负责把「为什么这么排」解释出来 —— 界面会把它画成三条进度条，
// 让用户看见算法是怎么想的（可解释性）。

const DAY = 86400000;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 60;

/** 复习完一次后更新间隔 */
function nextInterval(cur, correct, elapsedRatio) {
  const base = Math.max(MIN_INTERVAL, cur || MIN_INTERVAL);
  const ratio = elapsedRatio || 1;
  let next;
  if (!correct) {
    next = base * 0.5;                 // 答错 → 砍半，尽快补
  } else if (ratio > 1.6) {
    next = base * 1.2;                 // 答对但犹豫 → 小幅拉长
  } else {
    next = base * 2;                   // 答对且干脆 → 翻倍
  }
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(next * 10) / 10));
}

/** 三个分项的权重（界面要标出来，所以提成常量） */
const WEIGHTS = { urgency: 0.5, uncertainty: 0.3, errorRate: 0.2 };

/**
 * 把优先级拆成可读的三项 —— 供「为什么现在复习它」展示
 *   urgency     时间紧迫度：逾期越久越高
 *   uncertainty 还不熟悉  ：练得越少越不确定（bandit 思想）
 *   errorRate   历史易错  ：答错占比越高越薄弱
 */
function breakdown(note, now) {
  const t = now || Date.now();
  const n = Object.assign({ interval: 1, alpha: 1, beta: 1, dueAt: t }, note);
  const interval = Math.max(MIN_INTERVAL, n.interval || MIN_INTERVAL);
  const overdueDays = Math.max(0, (t - (n.dueAt || t)) / DAY);

  const urgency = Math.min(1, overdueDays / (interval * 3));
  const alpha = n.alpha || 1;
  const beta = n.beta || 1;
  const uncertainty = 1 / (alpha + beta + 1);
  const errorRate = beta / (alpha + beta);

  const parts = [
    {
      key: 'urgency', label: '时间紧迫度', value: urgency, weight: WEIGHTS.urgency,
      detail: overdueDays > 0 ? '已逾期 ' + overdueDays.toFixed(1) + ' 天' : '还没到复习时间',
    },
    {
      key: 'uncertainty', label: '还不熟悉', value: uncertainty, weight: WEIGHTS.uncertainty,
      detail: '一共练过 ' + ((n.reviewCount || 0)) + ' 次',
    },
    {
      key: 'errorRate', label: '历史易错', value: errorRate, weight: WEIGHTS.errorRate,
      detail: '答对 ' + alpha + ' 次 / 答错 ' + beta + ' 次',
    },
  ];

  parts.forEach((p) => {
    p.pct = Math.round(p.value * 100);
    p.contribution = Math.round(p.value * p.weight * 100);  // 对总分的贡献
  });

  const total = priority(n, t);
  return { parts, total, totalPct: Math.round(total * 100), overdueDays, interval };
}

/** 今日复习优先级（0~1，越高越该练） */
function priority(note, now) {
  const t = now || Date.now();
  const interval = Math.max(MIN_INTERVAL, note.interval || MIN_INTERVAL);
  const overdueDays = Math.max(0, (t - (note.dueAt || t)) / DAY);
  const urgency = Math.min(1, overdueDays / (interval * 3));
  const alpha = note.alpha || 1;
  const beta = note.beta || 1;
  const uncertainty = 1 / (alpha + beta + 1);
  const errorRate = beta / (alpha + beta);
  return WEIGHTS.urgency * urgency + WEIGHTS.uncertainty * uncertainty + WEIGHTS.errorRate * errorRate;
}

/** 今日清单：按优先级排序 */
function todayQueue(notes, limit) {
  const now = Date.now();
  const due = notes.filter((n) => (n.dueAt || 0) <= now);
  due.sort((a, b) => priority(b, now) - priority(a, now));
  const picked = typeof limit === 'number' && limit > 0 ? due.slice(0, limit) : due;
  return picked.map((n) => Object.assign({}, n, { _priority: priority(n, now) }));
}

/** 界面上解释"这张卡为什么排前面"（简短版） */
function reasonText(note) {
  const n = Object.assign({ interval: 1, alpha: 1, beta: 1 }, note);
  const overdue = Math.max(0, Math.floor((Date.now() - (n.dueAt || Date.now())) / DAY));
  const parts = [];
  if (overdue > 0) parts.push('逾期 ' + overdue + ' 天');
  if ((n.alpha + n.beta) <= 3) parts.push('练得少');
  if (n.beta > n.alpha) parts.push('错得多');
  if (!parts.length) parts.push('按计划到期');
  return parts.join(' · ');
}

/**
 * 从复习记录里重建「间隔轨迹」—— 间隔越来越长说明记忆在巩固
 * @param {Array} logs  该卡片的复习记录（含 interval）
 */
function intervals(note, logs) {
  const mine = (logs || [])
    .filter((l) => l.noteId === note.id && typeof l.interval === 'number')
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  const seq = mine.map((l, i) => ({
    round: i + 1,
    interval: l.interval,
    right: !!l.right,
    at: l.at,
  }));
  if (!seq.length) {
    seq.push({ round: 0, interval: note.interval || 1, right: null, at: note.createdAt });
  }
  const max = Math.max.apply(null, seq.map((s) => s.interval).concat([1]));
  seq.forEach((s) => { s.pct = Math.round((s.interval / max) * 100); });
  return { seq, max };
}

module.exports = { DAY, nextInterval, priority, breakdown, WEIGHTS,
                   todayQueue, reasonText, intervals };
