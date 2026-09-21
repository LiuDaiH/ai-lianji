// utils/category.js —— 类别体系（树形层级：父类 → 子类）
//
// 关系模型：树形层级（一个类别只有一个父类），理由——
//   ① 符合"分类"的直觉（东西放进文件夹，不会同时在两个文件夹）
//   ② 天然表达"包含"语义（父类包含其所有子孙类别）
//   ③ UI 可实现（缩进树 / 面包屑 / 按子树聚合统计）
//   「多父」图结构更灵活，但用户理解成本陡增，本项目不采用。

const KEY = 'sc_categories';

function read() {
  try { return wx.getStorageSync(KEY) || []; } catch (e) { return []; }
}

function write(list) {
  try { wx.setStorageSync(KEY, list); return true; }
  catch (e) { console.error('[category] 写入失败', e); return false; }
}

function genId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function list() {
  return read().sort((a, b) => (a.order || 0) - (b.order || 0));
}

function get(id) { return read().filter((c) => c.id === id)[0] || null; }

function add(name, parentId) {
  const n = String(name || '').trim();
  if (!n) return null;
  const all = read();
  const dup = all.filter((c) => (c.parentId || null) === (parentId || null) && c.name === n);
  if (dup.length) return null;
  const item = { id: genId(), name: n, parentId: parentId || null,
                 order: all.length, createdAt: Date.now() };
  all.push(item);
  write(all);
  return item;
}

function rename(id, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  const all = read();
  const c = all.filter((x) => x.id === id)[0];
  if (!c) return false;
  c.name = n;
  write(all);
  return true;
}

/** 删除（安全）：子类上提一层；卡片由上层转「未分类」 */
function remove(id) {
  const all = read();
  const target = all.filter((c) => c.id === id)[0];
  if (!target) return 0;
  let moved = 0;
  all.forEach((c) => {
    if (c.parentId === id) { c.parentId = target.parentId || null; moved += 1; }
  });
  write(all.filter((c) => c.id !== id));
  return moved;
}

function childrenOf(all, id) {
  const pid = id || null;
  return all.filter((c) => (c.parentId || null) === pid)
            .sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** 子孙 id 集合（含自己） */
function descendants(all, id) {
  const out = {};
  if (!id) return out;
  out[id] = true;
  let changed = true;
  while (changed) {
    changed = false;
    all.forEach((c) => {
      if (c.parentId && out[c.parentId] && !out[c.id]) { out[c.id] = true; changed = true; }
    });
  }
  return out;
}

function pathOf(all, id) {
  const out = [];
  let cur = all.filter((c) => c.id === id)[0];
  let guard = 0;
  while (cur && guard < 20) {
    out.unshift(cur);
    cur = all.filter((c) => c.id === cur.parentId)[0];
    guard += 1;
  }
  return out;
}

function pathText(all, id) {
  return pathOf(all, id).map((c) => c.name).join(' / ');
}

function flatten(all, expanded, countFn) {
  const out = [];
  const walk = (parentId, depth) => {
    childrenOf(all, parentId).forEach((c) => {
      const kids = childrenOf(all, c.id);
      out.push({ id: c.id, name: c.name, parentId: c.parentId || null, depth,
                 hasChildren: kids.length > 0, expanded: !!expanded[c.id],
                 count: countFn ? countFn(c.id) : 0, indent: [], isLast: true });
      if (expanded[c.id]) walk(c.id, depth + 1);
    });
  };
  walk(null, 0);
  return out;
}

/**
 * 带「树线信息」的扁平列表 —— 用于渲染树形图
 *   indent: boolean[]  祖先各层是否还有后续兄弟（true 则该层要画竖线）
 *   isLast: boolean    自己是否本层最后一个（决定连接符是 ├ 还是 └）
 *   depth:  number     层级深度（0 起，用于配色）
 */
function flattenTree(all, expanded, countFn) {
  const out = [];
  const walk = (parentId, ancestorsHasNext) => {
    const kids = childrenOf(all, parentId);
    kids.forEach((c, i) => {
      const isLast = i === kids.length - 1;
      const childKids = childrenOf(all, c.id);
      out.push({
        id: c.id,
        name: c.name,
        parentId: c.parentId || null,
        depth: ancestorsHasNext.length,
        indent: ancestorsHasNext.slice(),
        isLast,
        hasChildren: childKids.length > 0,
        expanded: !!expanded[c.id],
        count: countFn ? countFn(c.id) : 0,
      });
      if (expanded[c.id]) walk(c.id, ancestorsHasNext.concat([!isLast]));
    });
  };
  walk(null, []);
  return out;
}

/** 搜索类别（带完整路径） */
function search(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const all = list();
  return all.filter((c) => c.name.toLowerCase().indexOf(kw) >= 0)
            .map((c) => ({ id: c.id, name: c.name, path: pathText(all, c.id) }));
}

/** 祖先 id 列表（定位时用来展开） */
function ancestorIds(all, id) {
  return pathOf(all, id).map((c) => c.id).filter((x) => x !== id);
}

/** 树的最大深度（界面提示用） */
function maxDepth(all) {
  let d = 0;
  all.forEach((c) => { d = Math.max(d, pathOf(all, c.id).length); });
  return d;
}

/**
 * 按路径批量建类别（导入 Obsidian vault / 大纲时用）
 *   ensurePath(['计算机','Python','面向对象']) → 逐层复用已存在的同名类别，缺的才新建
 * @returns { id, created } 叶子类别 id 与新建数量
 */
function ensurePath(pathNames, counters) {
  const names = (pathNames || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!names.length) return { id: null, created: 0 };
  let all = read();
  let parentId = null;
  let created = counters || { n: 0 };

  names.forEach((name) => {
    const hit = all.filter((c) => (c.parentId || null) === (parentId || null) && c.name === name)[0];
    if (hit) { parentId = hit.id; return; }
    const item = { id: genId(), name, parentId: parentId || null,
                   order: all.filter((c) => (c.parentId || null) === (parentId || null)).length,
                   createdAt: Date.now() };
    all.push(item);
    write(all);
    parentId = item.id;
    created.n += 1;
  });
  return { id: parentId, created: created.n };
}

module.exports = { list, get, add, rename, remove, childrenOf, descendants,
                   pathOf, pathText, flatten, flattenTree, search, ancestorIds, maxDepth,
                   ensurePath };
