// utils/store.js —— 本地存储封装（不依赖云开发，零成本）
const KEY_NOTES = 'sc_notes';
const KEY_LOGS = 'sc_logs';
const KEY_QUIZ = 'sc_quiz_results';

function readNotes() {
  try { return wx.getStorageSync(KEY_NOTES) || []; } catch (e) { return []; }
}

function writeNotes(list) {
  try { wx.setStorageSync(KEY_NOTES, list); return true; }
  catch (e) { console.error('[store] 写入失败', e); return false; }
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function baseFields(over) {
  const now = Date.now();
  return Object.assign({ interval: 1, dueAt: now + 86400000, alpha: 1, beta: 1,
                         reviewCount: 0, lastReviewedAt: 0, createdAt: now }, over || {});
}

function addNote(note) {
  const list = readNotes();
  const item = Object.assign(baseFields(), {
    id: genId(),
    title: note.title || '未命名知识点',
    content: note.content || '',
    categoryId: note.categoryId || null,
    tags: note.tags || [],
  });
  list.push(item);
  writeNotes(list);
  return item;
}

function addNotes(notes) {
  const list = readNotes();
  // 注意：这里用 Object.assign(baseFields(), n, {...}) —— 先铺开调用方传的字段，
  // 再补默认值，保证 src（Obsidian 回写定位信息）这类扩展字段不会丢
  const items = notes.map((n) => Object.assign(baseFields(), n, {
    id: genId(),
    title: n.title || '未命名知识点',
    content: n.content || '',
    categoryId: n.categoryId || null,
    tags: n.tags || [],
  }));
  writeNotes(list.concat(items));
  return items;
}

function listNotes() {
  return readNotes().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function getNote(id) { return readNotes().filter((n) => n.id === id)[0] || null; }

function updateNote(id, patch) {
  const list = readNotes();
  const idx = list.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  list[idx] = Object.assign({}, list[idx], patch);
  writeNotes(list);
  return list[idx];
}

function removeNote(id) { writeNotes(readNotes().filter((n) => n.id !== id)); }

/**
 * 批量改 + 批量删（导入时"就地更新"要用）
 * 逐张 updateNote 是「读一次写一次」，400 张就是 400 次读写；这里只读写一遍。
 * @param patches [{ id, patch }]
 * @param removes [id]
 * @returns { updated, removed }
 */
function patchNotes(patches, removes) {
  const list = readNotes();
  const byId = {};
  list.forEach((n, i) => { byId[n.id] = i; });
  let updated = 0;
  (patches || []).forEach((x) => {
    if (!x || !x.patch) return;
    const i = byId[x.id];
    if (i === undefined) return;
    if (!Object.keys(x.patch).length) return;
    list[i] = Object.assign({}, list[i], x.patch);
    updated += 1;
  });
  let out = list;
  const del = {};
  (removes || []).forEach((id) => { del[id] = true; });
  const removed = Object.keys(del).length;
  if (removed) out = list.filter((n) => !del[n.id]);
  writeNotes(out);
  return { updated, removed };
}

function clearCategory(catIds) {
  const list = readNotes();
  let n = 0;
  list.forEach((note) => {
    if (note.categoryId && catIds[note.categoryId]) { note.categoryId = null; n += 1; }
  });
  if (n) writeNotes(list);
  return n;
}

function countByCategory() {
  const out = {};
  readNotes().forEach((n) => {
    const k = n.categoryId || '__none__';
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

/**
 * 首次使用：如果一张卡片都没有，就放几张示例卡
 * 这样新用户一打开就能直接练一轮，而不是面对空白页
 * @returns {number} 实际预置的数量
 */
function seedIfEmpty() {
  if (readNotes().length > 0) return 0;
  const seed = require('./seed.js');
  const items = addNotes(seed.build());
  wx.setStorageSync('sc_seeded', 1);
  return items.length;
}

/** 是否由系统预置过（供"清空示例"判断） */
function isSeeded() {
  try { return !!wx.getStorageSync('sc_seeded'); } catch (e) { return false; }
}

function addLog(log) {
  try {
    const logs = wx.getStorageSync(KEY_LOGS) || [];
    logs.push(Object.assign({ id: genId(), at: Date.now() }, log));
    wx.setStorageSync(KEY_LOGS, logs.slice(-2000));
  } catch (e) { console.error('[store] 记录失败', e); }
}

function readLogs() {
  try { return wx.getStorageSync(KEY_LOGS) || []; } catch (e) { return []; }
}

function addQuizResult(r) {
  try {
    const list = wx.getStorageSync(KEY_QUIZ) || [];
    list.push(Object.assign({ id: genId(), at: Date.now() }, r));
    wx.setStorageSync(KEY_QUIZ, list.slice(-50));
  } catch (e) { console.error('[store] 成绩记录失败', e); }
}

function readQuizResults() {
  try { return (wx.getStorageSync(KEY_QUIZ) || []).slice().reverse(); } catch (e) { return []; }
}

function exportJSON() {
  let cats = [];
  try { cats = wx.getStorageSync('sc_categories') || []; } catch (e) { cats = []; }
  return JSON.stringify({
    version: 2, exportedAt: Date.now(),
    categories: cats, notes: readNotes(), logs: readLogs(),
    quizResults: readQuizResults(),
  }, null, 2);
}

function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.notes)) throw new Error('文件格式不正确');
  let cats = [];
  try { cats = wx.getStorageSync('sc_categories') || []; } catch (e) { cats = []; }
  const catMap = {};
  (data.categories || []).forEach((c) => {
    const parentNew = c.parentId ? (catMap[c.parentId] || null) : null;
    const exist = cats.filter((x) => x.name === c.name && (x.parentId || null) === parentNew)[0];
    if (exist) { catMap[c.id] = exist.id; }
    else {
      const item = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                     name: c.name, parentId: parentNew, order: cats.length, createdAt: Date.now() };
      cats.push(item);
      catMap[c.id] = item.id;
    }
  });
  try { wx.setStorageSync('sc_categories', cats); } catch (e) { /* ignore */ }
  const list = readNotes();
  const seen = {};
  list.forEach((n) => { seen[n.title + '\u0001' + n.content] = true; });
  let added = 0;
  data.notes.forEach((n) => {
    const key = (n.title || '') + '\u0001' + (n.content || '');
    if (seen[key]) return;
    seen[key] = true;
    list.push(Object.assign({ id: genId() }, n, {
      categoryId: n.categoryId ? (catMap[n.categoryId] || null) : null,
    }));
    added += 1;
  });
  writeNotes(list);
  return added;
}

function stats() {
  const list = readNotes();
  const now = Date.now();
  return { total: list.length, due: list.filter((n) => (n.dueAt || 0) <= now).length };
}

/* ==================== Obsidian 来源存档（回写用） ====================
 * 导入时把每个 .md 的**原文**留一份，导出掌握度时才可能"按标题原样标注"。
 * 只存 markdown 纯文本，几百 KB 级别，远小于 10MB 上限。
 */
const KEY_OBS = 'sc_obsidian';
const OBS_CHUNK = 380000;          // 每片字符数（避开单键 1MB 上限）

/**
 * ⚠️ 为什么必须分片：
 *   微信 storage **单个 key 上限 1MB**。原来把整个 vault 的原文塞进一个 key，
 *   为了"安全"又把上限设成 2MB —— 结果超过 1MB 时 setStorageSync 直接抛异常被 catch 掉，
 *   **存档没存上、回写功能静默失效**，而界面上只有一行小字。分片后才真的能用大 vault。
 */
function readObsidianSources() {
  try {
    const m = wx.getStorageSync(KEY_OBS);
    if (!m) return [];
    if (Array.isArray(m)) return m;                       // 兼容旧数据（单键整存）
    if (!m.chunks) return [];
    let raw = '';
    for (let i = 0; i < m.chunks; i += 1) {
      raw += wx.getStorageSync(KEY_OBS + '_' + i) || '';
    }
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function saveObsidianSources(list) {
  const text = JSON.stringify(list || []);
  try {
    // 清掉可能残留的旧分片
    const old = wx.getStorageSync(KEY_OBS);
    if (old && old.chunks) {
      for (let i = 0; i < old.chunks; i += 1) {
        try { wx.removeStorageSync(KEY_OBS + '_' + i); } catch (e) { /* ignore */ }
      }
    }
    if (text.length <= OBS_CHUNK) {
      wx.setStorageSync(KEY_OBS, { chunks: 1, bytes: text.length, at: Date.now() });
      wx.setStorageSync(KEY_OBS + '_0', text);
      return true;
    }
    const n = Math.ceil(text.length / OBS_CHUNK);
    for (let i = 0; i < n; i += 1) {
      wx.setStorageSync(KEY_OBS + '_' + i, text.slice(i * OBS_CHUNK, (i + 1) * OBS_CHUNK));
    }
    wx.setStorageSync(KEY_OBS, { chunks: n, bytes: text.length, at: Date.now() });
    return true;
  } catch (e) {
    console.error('[store] Obsidian 存档失败（可能超出容量）', e);
    // 失败要留下痕迹：把清单也清掉，免得读到半截数据
    try { wx.setStorageSync(KEY_OBS, { chunks: 0, bytes: 0, at: Date.now(), failed: true }); } catch (e2) { /* ignore */ }
    return false;
  }
}

/** 存档占了多少（给界面显示用） */
const KEY_STAMPS = 'sc_obs_stamps';

/** 上次导出时每个文件的内容指纹（用来跳过"没变化"的文件，少弹几次分享面板） */
function readExportedStamps() {
  try {
    const v = wx.getStorageSync(KEY_STAMPS);
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}

function saveExportedStamps(map) {
  try { wx.setStorageSync(KEY_STAMPS, map || {}); return true; }
  catch (e) { return false; }
}

/** 内容指纹：长度 + 简单滚动哈希（够判断"变没变"，不用 crypto） */
function textStamp(text) {
  const s = String(text || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 7) h = (h * 31 + s.charCodeAt(i)) | 0;
  return s.length + ':' + h;
}

function obsidianBytes() {
  try {
    const m = wx.getStorageSync(KEY_OBS);
    if (!m) return 0;
    if (Array.isArray(m)) return JSON.stringify(m).length;
    return m.bytes || 0;
  } catch (e) { return 0; }
}

/** 合并式写入：同一个 relPath 覆盖旧版本 */
function upsertObsidianSources(items) {
  const cur = readObsidianSources();
  const map = {};
  cur.forEach((s) => { map[s.relPath] = s; });
  (items || []).forEach((s) => { map[s.relPath] = s; });
  const merged = Object.keys(map).map((k) => map[k]);
  saveObsidianSources(merged);
  return merged;
}

function clearObsidianSources() {
  try {
    const old = wx.getStorageSync(KEY_OBS);
    if (old && old.chunks) {
      for (let i = 0; i < old.chunks; i += 1) {
        try { wx.removeStorageSync(KEY_OBS + '_' + i); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
  saveObsidianSources([]);
}

/* ==================== 介绍弹窗的闸门 ====================
 * app.onLaunch 每次插一面旗子，哪个页面先加载就由谁弹介绍，然后把旗子取走。
 * 这样「每次打开小程序都放一遍」，又不会一次启动弹好几遍。
 */
function takeIntroPending() {
  try {
    if (!wx.getStorageSync('sc_intro_pending')) return false;
    wx.removeStorageSync('sc_intro_pending');
    return wx.getStorageSync('sc_intro_always') !== 0;
  } catch (e) { return false; }
}

module.exports = {
  addNote, addNotes, listNotes, getNote, updateNote, removeNote, patchNotes,
  clearCategory, countByCategory, seedIfEmpty, isSeeded,
  addLog, readLogs, addQuizResult, readQuizResults,
  exportJSON, importJSON, stats,
  readObsidianSources, saveObsidianSources, upsertObsidianSources, clearObsidianSources,
  obsidianBytes, readExportedStamps, saveExportedStamps, textStamp,
  takeIntroPending,
};
