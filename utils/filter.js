// utils/filter.js —— 按类别筛选卡片 / 复习记录（含子类聚合）
const cat = require('./category.js');

/** 按类别筛选卡片（含子类） */
function notesByCat(notes, activeId) {
  if (!activeId || activeId === 'all') return notes;
  if (activeId === '__none__') return notes.filter((n) => !n.categoryId);
  const ids = cat.descendants(cat.list(), activeId);
  return notes.filter((n) => n.categoryId && ids[n.categoryId]);
}

/** 把复习记录按筛选后的卡片过滤 */
function logsByNotes(logs, notes) {
  const keep = {};
  notes.forEach((n) => { keep[n.id] = true; });
  return logs.filter((l) => keep[l.noteId]);
}

/** 完整范围文字：`计算机 / Python（含子类）` */
function rangeText(activeId) {
  if (!activeId || activeId === 'all') return '全部卡片';
  if (activeId === '__none__') return '未分类';
  return cat.pathText(cat.list(), activeId) + '（含子类）';
}

/** 简短范围文字：只取最后一级，用于提示条等窄处 */
function rangeShort(activeId) {
  if (!activeId || activeId === 'all') return '全部';
  if (activeId === '__none__') return '未分类';
  const all = cat.list();
  const p = cat.pathOf(all, activeId);
  return p.length ? p[p.length - 1].name : '全部';
}

module.exports = { notesByCat, logsByNotes, rangeText, rangeShort };
