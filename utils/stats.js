// utils/stats.js —— 学习数据统计（纯计算，无依赖）

const DAY = 86400000;

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 时间戳 → 'YYYY-MM-DD' */
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * 掌握度分级
 *   new      没复习过
 *   mastered 复习≥3次 且 间隔≥7天 且 正确率≥70%
 *   learning 其余
 */
function masteryLevel(note) {
  const n = note.reviewCount || 0;
  if (n === 0) return 'new';
  const interval = note.interval || 1;
  const a = note.alpha || 1;
  const b = note.beta || 1;
  const acc = a / (a + b);
  if (n >= 3 && interval >= 7 && acc >= 0.7) return 'mastered';
  return 'learning';
}

function mastery(notes) {
  const out = { new: 0, learning: 0, mastered: 0, total: notes.length,
                newPct: 0, learningPct: 0, masteredPct: 0 };
  notes.forEach((n) => { out[masteryLevel(n)] += 1; });
  const t = out.total || 1;
  out.newPct = Math.round((out.new / t) * 100);
  out.learningPct = Math.round((out.learning / t) * 100);
  out.masteredPct = Math.max(0, 100 - out.newPct - out.learningPct);
  return out;
}

/**
 * 热力图（可读版）
 *
 * 光给一堆色块没人看得懂，所以除了格子，还一并算出"怎么读它"所需的一切：
 *   rowLabels  —— 左边该在哪些行标星期几
 *   monthSpans —— 哪一列属于哪个月（标在顶部）
 *   todayKey   —— 今天在哪一格
 *   isFuture   —— 本周内还没到的日子（必须和"学习了但没记录"区分开！）
 *   summary    —— 合计 / 有记录天数 / 单日最高
 */
function heatDetail(logs, weeks) {
  const W = weeks || 8;
  const counts = {};
  (logs || []).forEach((l) => {
    const k = dayKey(l.at || Date.now());
    counts[k] = (counts[k] || 0) + 1;
  });

  const now = new Date();
  const todayKey = dayKey(now.getTime());
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dow = (now.getDay() + 6) % 7;                 // 周一 = 0
  const start = new Date(now.getFullYear(), now.getMonth(),
                         now.getDate() - dow - (W - 1) * 7);

  const grid = [];
  const monthSpans = [];
  let total = 0;
  let activeDays = 0;
  let best = 0;
  let bestDay = '';
  let lastMonth = -1;
  let lastMonthCol = -99;   // 月份标签至少隔 2 列才画，否则会叠在一起

  for (let w = 0; w < W; w += 1) {
    const col = [];
    for (let d = 0; d < 7; d += 1) {
      const day = new Date(start.getFullYear(), start.getMonth(),
                           start.getDate() + w * 7 + d);
      const k = dayKey(day.getTime());
      const c = counts[k] || 0;
      const isFuture = day.getTime() > todayMid;
      const cell = {
        key: k,
        count: c,
        // level -1 = 还没到的日子，渲染成虚线空框，不能跟"没学习"混为一谈
        level: isFuture ? -1 : (c === 0 ? 0 : (c < 5 ? 1 : (c < 15 ? 2 : 3))),
        isToday: k === todayKey,
        isFuture,
        md: (day.getMonth() + 1) + '月' + day.getDate() + '日',
      };
      col.push(cell);
      if (!isFuture) {
        total += c;
        if (c > 0) activeDays += 1;
        if (c > best) { best = c; bestDay = cell.md; }
      }
      // 月份刻度：换月才画，且和上一个标签至少隔 2 列（不然两个标签会重叠）
      if (d === 0 && day.getMonth() !== lastMonth) {
        lastMonth = day.getMonth();
        if (w - lastMonthCol >= 2) {
          monthSpans.push({ col: w, text: (day.getMonth() + 1) + '月' });
          lastMonthCol = w;
        }
      }
    }
    grid.push(col);
  }

  return {
    weeks: W,
    grid,
    monthSpans,
    todayKey,
    // 只标 一/三/五/日 四行 —— 和 GitHub 一个做法，标满 7 行太挤
    rowLabels: [
      { row: 0, text: '一' },
      { row: 2, text: '三' },
      { row: 4, text: '五' },
      { row: 6, text: '日' },
    ],
    summary: { total, activeDays, best, bestDay },
  };
}

/** 星期刻度行（一/三/五/日）—— 热力图和年历共用 */
const ROW_LABELS = [
  { row: 0, text: '一' },
  { row: 2, text: '三' },
  { row: 4, text: '五' },
  { row: 6, text: '日' },
];

/** 练了多少次 → 色阶（0-4）。年历和热力图共用同一套档位，颜色才可比 */
function heatLevel(n) {
  if (!n) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  if (n <= 9) return 3;
  return 4;
}

/** 周一为第一天的时间戳（用于算「这一周」的边界） */
function startOfWeek(ts) {
  const d = new Date(ts);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 有记录的年份（倒序），永远带上今年 */
function logYears(logs, now) {
  const set = {};
  set[new Date(now || Date.now()).getFullYear()] = true;
  (logs || []).forEach((l) => { if (l && l.at) set[new Date(l.at).getFullYear()] = true; });
  return Object.keys(set).map(Number).sort((a, b) => b - a);
}

/**
 * 年历：整年 53 列 × 7 天（GitHub 那种），可以整年横着滑
 * 返回形状和 heatDetail 完全一致（grid / monthSpans / rowLabels），页面一套模板就能渲染两种尺度
 */
function yearCalendar(logs, year, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const y = year || new Date(now).getFullYear();
  const todayKey = dayKey(now);

  const counts = {};
  (logs || []).forEach((l) => {
    const ts = l.at || 0;
    if (new Date(ts).getFullYear() !== y) return;
    const k = dayKey(ts);
    counts[k] = (counts[k] || 0) + 1;
  });

  const start = new Date(y, 0, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(y, 11, 31);
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));

  const grid = [];
  const monthSpans = [];
  const cur = new Date(start.getTime());
  let col = 0;
  let lastMonth = -1;
  while (cur <= end) {
    const colDays = [];
    for (let r = 0; r < 7; r += 1) {
      const ts = cur.getTime();
      const inYear = cur.getFullYear() === y;
      const k = dayKey(ts);
      const n = inYear ? (counts[k] || 0) : 0;
      colDays.push({
        key: k,
        md: (cur.getMonth() + 1) + '/' + cur.getDate(),
        count: n,
        level: inYear ? heatLevel(n) : -1,
        inYear, isToday: k === todayKey, isFuture: ts > now,
      });
      cur.setDate(cur.getDate() + 1);
    }
    const firstIn = colDays.filter((d) => d.inYear)[0];
    if (firstIn) {
      const m = Number(firstIn.key.slice(5, 7));
      if (m !== lastMonth) { monthSpans.push({ col, text: m + '月' }); lastMonth = m; }
    }
    grid.push(colDays);
    col += 1;
  }

  let total = 0, activeDays = 0, best = 0, bestDay = '';
  Object.keys(counts).forEach((k) => {
    total += counts[k]; activeDays += 1;
    if (counts[k] > best) { best = counts[k]; bestDay = k; }
  });
  return {
    year: y, grid, cols: grid.length, monthSpans, rowLabels: ROW_LABELS,
    summary: { total, activeDays, best, bestDay },
  };
}

/** 最长连续学习天数（历史纪录） */
function longestStreak(logs) {
  const days = Array.from(new Set((logs || []).map((l) => dayKey(l.at || 0)))).sort();
  let best = 0, run = 0, prev = null;
  days.forEach((k) => {
    const t = new Date(k + 'T00:00:00').getTime();
    run = (prev !== null && t - prev === DAY) ? run + 1 : 1;
    prev = t;
    if (run > best) best = run;
  });
  return best;
}

/** 本周 vs 上周（复习次数 / 答对率） */
function weekCompare(logs, now) {
  const t = now || Date.now();
  const w0 = startOfWeek(t);
  const agg = (from, to) => {
    const hit = (logs || []).filter((l) => (l.at || 0) >= from && (l.at || 0) < to);
    const right = hit.filter((l) => l.right).length;
    return { n: hit.length, right, acc: hit.length ? Math.round((right / hit.length) * 100) : 0 };
  };
  const cur = agg(w0, w0 + 7 * DAY);
  const prev = agg(w0 - 7 * DAY, w0);
  return { cur, prev, delta: cur.n - prev.n };
}

/** 学习时段分布（一天里哪个小时练得最多） */
function hourHist(logs) {
  const buckets = new Array(24).fill(0);
  (logs || []).forEach((l) => {
    const h = new Date(l.at || 0).getHours();
    if (h >= 0 && h < 24) buckets[h] += 1;
  });
  let peak = 0;
  buckets.forEach((v, i) => { if (v > buckets[peak]) peak = i; });
  return { buckets, peak, max: Math.max(1, Math.max.apply(null, buckets)) };
}

/** 某一天的明细：练了几次、对几道、涉及哪几张卡 */
function dayDetail(logs, key, nameOf) {
  const hit = (logs || []).filter((l) => dayKey(l.at || 0) === key);
  const right = hit.filter((l) => l.right).length;
  const titles = [];
  const seen = {};
  hit.forEach((l) => {
    if (seen[l.noteId]) return;
    seen[l.noteId] = true;
    const t = nameOf ? nameOf(l.noteId) : '';
    if (t && titles.length < 6) titles.push({ id: l.noteId, title: t });
  });
  return {
    count: hit.length, right, wrong: hit.length - right,
    acc: hit.length ? Math.round((right / hit.length) * 100) : 0,
    titles,
  };
}

/** 总体正确率 */
function accuracy(logs) {
  const all = logs || [];
  if (!all.length) return 0;
  return Math.round((all.filter((l) => l.right).length / all.length) * 100);
}

/** 类别排行：卡片数最多的几类，各自的掌握率（一眼看出哪一块最欠） */
function byCategory(notes, cats, top) {
  return (cats || []).map((c) => {
    const mine = (notes || []).filter((n) => n.categoryId === c.id);
    const m = mastery(mine);
    return { id: c.id, name: c.name, total: mine.length, mastered: m.mastered,
             learning: m.learning, fresh: m.new, pct: m.masteredPct };
  }).filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, top || 5);
}
/**
 * 学习热力图：最近 weeks 周，每列一周（周一为第一行）
 * @returns [[{key, count, level, isToday, isFuture, md}, ...7], ...weeks]
 */
function heatmap(logs, weeks) {
  return heatDetail(logs, weeks).grid;
}

/** 未来 days 天每天到期多少张 */
function forecast(notes, days) {
  const D = days || 7;
  const now = Date.now();
  const out = [];
  for (let i = 0; i < D; i += 1) {
    let c;
    if (i === 0) {
      c = notes.filter((n) => (n.dueAt || 0) <= now).length;
    } else {
      const from = now + i * DAY;
      const to = from + DAY;
      c = notes.filter((n) => (n.dueAt || 0) > from && (n.dueAt || 0) <= to).length;
    }
    out.push({ label: i === 0 ? '今天' : (i === 1 ? '明天' : i + '天后'), count: c });
  }
  return out;
}

/** 难点卡片：错误率最高的若干张（只统计复习过的） */
function hardest(notes, top) {
  return notes
    .filter((n) => (n.reviewCount || 0) > 0)
    .map((n) => {
      const a = n.alpha || 1;
      const b = n.beta || 1;
      return Object.assign({}, n, { _err: b / (a + b), _acc: a / (a + b) });
    })
    .sort((x, y) => y._err - x._err)
    .slice(0, top || 5)
    .filter((n) => n._err > 0.35);
}

/** 连续学习天数（今天没练则从昨天开始算） */
function streak(logs) {
  const set = new Set((logs || []).map((l) => dayKey(l.at || Date.now())));
  const d = new Date();
  if (!set.has(dayKey(d.getTime()))) {
    d.setDate(d.getDate() - 1);                 // 今天还没练，从昨天算
  }
  let s = 0;
  for (;;) {
    if (set.has(dayKey(d.getTime()))) {
      s += 1;
      d.setDate(d.getDate() - 1);
    } else break;
  }
  return s;
}

/** 今天已复习多少张 */
function todayCount(logs) {
  const k = dayKey(Date.now());
  return (logs || []).filter((l) => dayKey(l.at || 0) === k).length;
}

/** 总复习次数 */
function totalReviews(logs) {
  return (logs || []).length;
}

module.exports = {
  dayKey, masteryLevel, mastery, heatmap, heatDetail, forecast, hardest, streak,
  ROW_LABELS, heatLevel, startOfWeek, yearCalendar, logYears, longestStreak,
  weekCompare, hourHist, dayDetail, accuracy, byCategory,
  todayCount, totalReviews,
};
