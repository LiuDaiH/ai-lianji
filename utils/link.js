// utils/link.js —— 卡片之间的「链」：双向链接 / 反向链接 / 未链接提及 / 图谱数据
//
// 设计要点：
//   ① 显式链接：内容里写 [[卡片标题]]，解析出「出链」
//      · 支持 Obsidian 的标准写法：[[文件#标题]]、[[文件|别名]]、![[文件]]（嵌入）、[[文件#^块id]]
//   ② 反向链接：谁引用了当前卡片（遍历求，卡片量小，成本可忽略）
//   ③ **未链接提及**：内容里出现了别的卡片标题，但没加 [[]] —— 动态计算，不存储
//      （这样内容一改就立刻同步，不会出现「存了旧链接」的问题）
//   ④ 图谱数据：类别为骨架、卡片挂在类别下，两层节点 + 三类边
//
// 为什么「未链接提及」是精髓：
//   用户写笔记时不会刻意加链接。系统主动发现「你提到了 X」，
//   把「建立关联」这件事从「用户想起来要做」变成「系统提醒你做」。

// 允许 # —— Obsidian 的 [[笔记#标题]] 是标准写法
// 允许前导 ! —— ![[笔记]] 是 Obsidian 的「嵌入」，它同样是一条链接，只是显示方式不同
const LINK_RE = /!?\[\[([^\[\]|]{1,60})(?:\|[^\[\]]*)?\]\]/g;

/** Obsidian 的块 id：行尾的 ^abc-123 */
const BLOCK_RE = /(?:^|\s)\^([A-Za-z0-9][A-Za-z0-9-]{0,39})\s*$/gm;

/** 从内容里解析出 [[...]] 里的标题（去重、保序） */
function parseLinkTitles(content) {
  const out = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(String(content || '')))) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return Array.from(new Set(out));
}


/**
 * 把 [[...]] 解析成「目标描述」
 *   支持四种写法：
 *     [[某笔记]]          → { name: '某笔记' }              （指向 Obsidian 的文件名）
 *     [[某笔记#某标题]]    → { file: '某笔记', head: '某标题' }（指向文件里的某个标题）
 *     [[某笔记#^blk-1]]   → { file: '某笔记', block: 'blk-1' }（指向某个块 id）
 *     ![[某笔记]]          → 同上，但 embed = true（嵌入）
 *     [[某卡片标题]]       → { name: '某卡片标题' }          （直接指向卡片标题）
 *   注意：Obsidian 的 [[]] 绝大多数指向的是**文件名**，而我们的卡片标题是**标题行的名字**，
 *   所以必须做「文件名 → 该文件的代表卡」这一层映射，否则链接永远连不上。
 */
function parseTargets(content) {
  const out = [];
  const seen = {};
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(String(content || '')))) {
    const raw = m[1].trim();
    if (!raw) continue;
    if (seen[raw]) continue;
    seen[raw] = true;
    const embed = m[0].charAt(0) === '!';
    const h = raw.indexOf('#');
    const head0 = h >= 0 ? raw.slice(h + 1).trim() : '';
    // #^xxx 是块引用，不是标题
    const isBlock = head0.charAt(0) === '^';
    if (h > 0 && (head0 || isBlock)) {
      out.push({
        raw, embed, file: raw.slice(0, h).trim(), name: '',
        head: isBlock ? '' : head0,
        block: isBlock ? head0.slice(1).trim() : '',
      });
    } else if (h === 0) {
      // [[#标题]] / [[#^块id]] —— 指向本文档内的标题或块
      out.push({
        raw, embed, file: '', name: '',
        head: isBlock ? '' : head0,
        block: isBlock ? head0.slice(1).trim() : '',
      });
    } else {
      out.push({ raw, embed, file: '', head: '', block: '', name: raw });
    }
  }
  return out;
}

/** 文件名（去路径去扩展名）→ 该文件的「代表卡」id（取文件内最靠前的一张） */
function fileIndex(notes) {
  const m = {};
  (notes || []).forEach((n) => {
    const f = n && n.src && n.src.file;
    if (!f) return;
    const base = String(f).replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '');
    if (!base) return;
    const cur = m[base];
    if (!cur) { m[base] = n; return; }
    const a = typeof n.lineNo === 'number' ? n.lineNo : 1e9;
    const b = typeof cur.lineNo === 'number' ? cur.lineNo : 1e9;
    if (a < b) m[base] = n;
  });
  return m;
}

/** 找「来自某文件、且标题路径末项等于某标题」的卡片 */
function findByFileHead(notes, file, head) {
  const target = normText(file);
  const ht = normText(head);
  let found = null;
  (notes || []).forEach((n) => {
    if (found || !n || !n.src || !n.src.file) return;
    const base = String(n.src.file).replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '');
    if (normText(base) !== target) return;
    const path = n.src.nodePath || [];
    // 精确匹配末项，或路径中任一层命中（[[文件#大章节]] 指向整节时更宽容）
    if (normText(path.slice(-1)[0] || '') === ht
        || path.some((x) => normText(x) === ht)) found = n.id;
  });
  return found;
}

function normText(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}


/**
 * 章节标题（src.nodePath 的末项）→ 该章节下的「代表卡」id
 *
 * 为什么需要这一层：
 *   Obsidian 的 [[X]] 语义上只匹配**文件名**，写 [[过拟合]] 而库里没有「过拟合.md」时
 *   它只是个悬空链接。但用户的**意图**通常就是要关联那个章节。
 *   所以我们在「卡片标题 → 文件名」之后再加一层「章节标题」兜底：
 *   能连上就比连不上好，而且放在匹配链最末，不会干扰前两种精确匹配。
 */
function headIndex(notes) {
  const m = {};
  (notes || []).forEach((n) => {
    const p = n && n.src && n.src.nodePath;
    const last = (p && p.length) ? p[p.length - 1] : '';
    if (!last) return;
    const cur = m[last];
    if (!cur) { m[last] = n; return; }
    const a = typeof n.lineNo === 'number' ? n.lineNo : 1e9;
    const b = typeof cur.lineNo === 'number' ? cur.lineNo : 1e9;
    if (a < b) m[last] = n;
  });
  return m;
}

/** 标题 → 卡片 的索引 */
function titleIndex(notes) {
  const idx = {};
  notes.forEach((n) => {
    if (n && n.title && !idx[n.title]) idx[n.title] = n.id;
  });
  return idx;
}

/**
 * 块 id（正文里行尾的 ^abc）→ 卡片 id
 * Obsidian 的 [[笔记#^abc]] 是「块引用」，比标题引用更精确。
 * 我们导入时把列表项原样存成了卡片正文，所以块 id 就保存在卡片内容里 —— 可以直接对上。
 */
function blockIndex(notes) {
  const m = {};
  (notes || []).forEach((n) => {
    const c = String((n && n.content) || '');
    if (!c) return;
    BLOCK_RE.lastIndex = 0;
    let x;
    while ((x = BLOCK_RE.exec(c))) {
      if (!m[x[1]]) m[x[1]] = n.id;
    }
  });
  return m;
}

/** 一次建好四层索引，供批量解析复用（backLinks / 图谱 会循环调用，别每次都重建） */
function buildIndices(notes) {
  return {
    byTitle: titleIndex(notes),
    byFile: fileIndex(notes),
    byHead: headIndex(notes),
    byBlock: blockIndex(notes),
  };
}

/** 当前卡片所在文件的 basename（[[#标题]] / [[#^块id]] 用它定位） */
function selfBase(note) {
  const f = (note && note.src && note.src.file) || '';
  return f ? String(f).replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '') : '';
}

/**
 * 出链的详细版：每条的 id + 原始写法 + 是否嵌入
 * 返回 [{ id, raw, embed }]
 */
function outLinkDetail(notes, note, indices) {
  const idx = indices || buildIndices(notes);
  const { byTitle, byFile, byHead, byBlock } = idx;
  const base = selfBase(note);
  const out = [];
  const seen = {};
  parseTargets(note && note.content).forEach((t) => {
    let id = null;
    if (t.block) {
      // 块引用最精确：先按块 id 找，找不到再退回「整篇文件的代表卡」
      id = byBlock[t.block] || null;
      if (!id) {
        const f = t.file || base;
        id = (f && byFile[f]) ? byFile[f].id : null;
      }
    } else if (t.file && t.head) {
      id = findByFileHead(notes, t.file, t.head) || byTitle[t.head] || null;
    } else if (t.file) {
      id = byFile[t.file] ? byFile[t.file].id : null;
    } else if (t.head) {
      // [[#标题]]：指向本卡片所在文件的某个标题
      id = base ? findByFileHead(notes, base, t.head) : null;
      if (!id) id = byTitle[t.head] || null;
    } else {
      // [[某名]] 的匹配优先级：卡片标题 → 文件名 → 章节标题
      id = byTitle[t.name]
        || (byFile[t.name] ? byFile[t.name].id : null)
        || (byHead[t.name] ? byHead[t.name].id : null)
        || null;
    }
    if (id && id !== note.id && !seen[id]) { seen[id] = true; out.push({ id, raw: t.raw, embed: !!t.embed }); }
  });
  return out;
}

/** 出链：这张卡显式链接到的卡片 id */
function outLinkIds(notes, note, indices) {
  return outLinkDetail(notes, note, indices).map((t) => t.id);
}

/** 反向链接：哪些卡链接到了它 */
function backLinks(notes, noteId) {
  const idx = buildIndices(notes);
  const out = [];
  notes.forEach((n) => {
    if (!n || n.id === noteId) return;
    if (outLinkIds(notes, n, idx).indexOf(noteId) >= 0) out.push(n);
  });
  return out;
}

/**
 * 未链接提及：内容里出现了别的卡片标题，但没写成 [[...]]
 * 返回 [{id, title, count}]
 */
function unlinkedMentions(notes, note, limit) {
  const content = String((note && note.content) || '');
  if (!content) return [];
  const linked = {};
  parseLinkTitles(content).forEach((t) => { linked[t] = true; });

  const out = [];
  notes.forEach((n) => {
    if (!n || n.id === note.id || !n.title) return;
    const t = n.title;
    if (t.length < 2) return;          // 太短的标题容易误命中
    if (linked[t]) return;             // 已经显式链接过了
    if (content.indexOf(t) < 0) return;
    // 统计出现次数
    let c = 0, from = 0;
    for (;;) {
      const i = content.indexOf(t, from);
      if (i < 0) break;
      c += 1; from = i + t.length;
      if (c > 9) break;
    }
    out.push({ id: n.id, title: t, count: c });
  });
  out.sort((a, b) => b.count - a.count);
  return typeof limit === 'number' ? out.slice(0, limit) : out;
}

/**
 * 把正文里第一次出现的 `标题` 包成 [[标题]]（用于「建立链接」按钮）
 * 只在不在已有 [[]] 内的位置替换
 */
function makeLink(content, title) {
  const s = String(content || '');
  const t = String(title || '').trim();
  if (!t) return s;
  const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  let m;
  while ((m = re.exec(s))) {
    const i = m.index;
    // 看在不在 [[...]] 里
    const before = s.lastIndexOf('[[', i);
    const closed = s.lastIndexOf(']]', i);
    if (before > closed) continue;         // 在某个 [[ 后面且未闭合 → 已在链接内
    return s.slice(0, i) + '[[' + t + ']]' + s.slice(i + t.length);
  }
  return s;
}

/** 去掉某条链接（把 [[标题]] 变回 标题） */
function removeLink(content, title) {
  const t = String(title || '').trim();
  if (!t) return String(content || '');
  const re = new RegExp('\\[\\[' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\|[^\\]]*)?\\]\\]', 'g');
  return String(content || '').replace(re, t);
}

/** 把 [[标题]] 去掉标记，用于纯文本展示 */
function stripLinkMarks(content) {
  return String(content || '').replace(/\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g, '$1');
}

/**
 * 构建图谱数据
 *   节点：类别（type='cat'）+ 卡片（type='note'）
 *   边：  cat-note（归属）、note-note（显式链接，实线）、cat-cat（父子）
 */
function buildGraph(notes, cats) {
  const nodes = [];
  const edges = [];
  const catList = cats || [];
  const catIds = {};
  catList.forEach((c) => { catIds[c.id] = true; });

  // 先算每张卡片归到哪个类别 —— 类别节点的 count（卡片数）决定：
  //   ① 它在图谱里分到多大扇区　② 它的圆画多大
  // 所以必须先统计再建节点，不能边建边数。
  const catOf = {};
  const count = {};
  notes.forEach((n) => {
    if (!n || !n.title) return;
    const cid = (n.categoryId && catIds[n.categoryId]) ? n.categoryId : '__none__';
    catOf[n.id] = cid;
    count[cid] = (count[cid] || 0) + 1;
  });

  catList.forEach((c) => {
    nodes.push({
      id: 'c:' + c.id, rawId: c.id, type: 'cat',
      label: c.name, parent: c.parentId || null,
      count: count[c.id] || 0,
      weight: 1,
    });
  });

  // 未分类的虚拟节点
  if (count.__none__) {
    nodes.push({ id: 'c:__none__', rawId: '__none__', type: 'cat',
                 label: '未分类', parent: null, count: count.__none__, weight: 1 });
  }

  notes.forEach((n) => {
    if (!n || !n.title) return;
    const cid = catOf[n.id] || '__none__';
    nodes.push({
      id: 'n:' + n.id, rawId: n.id, type: 'note', label: n.title,
      cat: cid,
      // 掌握度分级，图谱按此着色
      level: masteryLevel(n),
      weight: 1,
    });
    edges.push({ a: 'n:' + n.id, b: 'c:' + cid, kind: 'belong' });
  });

  // 类别层级边
  catList.forEach((c) => {
    if (c.parentId && catIds[c.parentId]) {
      edges.push({ a: 'c:' + c.id, b: 'c:' + c.parentId, kind: 'tree' });
    }
  });

  // 卡片之间的显式链接
  const idx = buildIndices(notes);
  notes.forEach((n) => {
    if (!n || !n.title) return;
    outLinkIds(notes, n, idx).forEach((tid) => {
      if (tid && tid !== n.id) {
        edges.push({ a: 'n:' + n.id, b: 'n:' + tid, kind: 'link' });
      }
    });
  });

  return { nodes, edges };
}

/** 掌握度分级（与 stats.js 的口径保持一致） */
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

/** 汇总统计（图谱页顶部用） */
function summary(notes, cats) {
  let links = 0;
  const linkCount = {};
  const idx = buildIndices(notes);
  notes.forEach((n) => {
    const c = outLinkIds(notes, n, idx).length;
    linkCount[n.id] = c;
    links += c;
  });
  const noLink = notes.filter((n) => !linkCount[n.id]).length;
  const catsWith = (cats || []).length;
  return {
    notes: notes.length,
    cats: catsWith,
    links,
    linkedNotes: notes.length - noLink,
    unlinked: noLink,
  };
}

module.exports = {
  parseLinkTitles, parseTargets, titleIndex, fileIndex, headIndex, blockIndex, buildIndices,
  findByFileHead, selfBase,
  outLinkIds, outLinkDetail, backLinks, unlinkedMentions,
  makeLink, removeLink, stripLinkMarks, buildGraph, masteryLevel, summary,
};
