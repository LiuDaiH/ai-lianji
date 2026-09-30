// utils/obsidian.js —— Obsidian 知识来源导入 / 掌握度回写
//
// 数据流（两条通道，都绕开"小程序不能读写本地文件"的限制）：
//
//   导入  Obsidian .md / vault.zip
//         → 聊天「文件传输助手」发给小程序
//         → wx.chooseMessageFile 选文件
//         → parseMarkdown() / parseVault()
//         → 建类别树 + 卡片，并把「原文件全文」留在本地供回写
//
//   回写  学习数据（alpha/beta/reviewCount/dueAt）
//         → annotate()  在原 md 每个标题后插入 Obsidian 高亮块 + #掌握度/xx 标签，
//                       并把 study_* 字段写回 YAML frontmatter（可被 Dataview 查询）
//         → dueList()   生成「待复习清单.md」，每条是 [[文件#标题]]，回 Obsidian 点得开
//         → report()    额外生成一份汇总报告
//         → wx.shareFileMessage 发到聊天 → 电脑上覆盖回 vault
//
// 设计要点：
//   ① 标题行 → 节点，「节点路径」= 祖先标题数组，回写时靠它精确定位
//   ② 导入时把每张卡片的节点路径写进 note.src，回写才有依据
//   ③ annotate 是**幂等**的：会先删掉上一次插入的标记再重插，反复导出不会堆积
//   ④ 导入时先 stripMarks() 去掉上一轮写下的高亮块 —— 否则那行会被当成正文切成卡片

const stats = require('./stats.js');

/* ==================== 小工具 ==================== */

function stripComments(s) {
  return String(s || '').replace(/%%[\s\S]*?%%/g, '');
}

/** 去掉 markdown 行内标记，得到一个适合当卡片标题的纯文本 */
function cleanInline(s) {
  return stripComments(s)
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')   // [[link|alias]] → link
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')             // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // 链接留文字
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/(^|\s)#[A-Za-z0-9\u4e00-\u9fa5_\-/]+/g, '$1')   // 行内 #标签 不进标题（标题变干净，标签另有 tags 字段存着）
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_]+)_/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 抽 #标签（排除标题行本身的 #） */
function extractTags(s) {
  const out = [];
  const re = /(^|[\s(（])#([A-Za-z0-9\u4e00-\u9fa5_\-/]+)/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) out.push(m[2]);
  return out;
}

function baseName(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

function stripExt(name) {
  return String(name || '').replace(/\.md$/i, '');
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function fmtDate(ts) {
  const d = new Date(ts || 0);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

/** 去掉 YAML frontmatter，返回 { front, body } */
function splitFrontmatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { front: '', body: text || '' };
  return { front: m[1], body: String(text).slice(m[0].length) };
}

/* ==================== ⓪ 上一次回写留下的标记行 ==================== */

/**
 * 上一轮回写插进去的高亮块（含我们追加的 #掌握度/xx 标签）
 *
 * ⚠️ 这是一个**闭环陷阱**：回写把标记插在标题下面，那行就落在标题的正文里；
 *    如果用户带着标注的笔记再导入一次，这行会被当成正文，变成一张「掌握度 82% …」的卡片。
 *    所以解析前必须先把它清掉。
 */
const MARK_RE = /^\s*>\s*\[!\w+\]\s*(?:掌握度\s|尚未学习|已掌握|学习中|薄弱|未学)/;

function stripMarks(text) {
  return String(text || '').split(/\r?\n/).filter((l) => !MARK_RE.test(l)).join('\n');
}

/** 掌握度 → Obsidian 原生标签（用户能在标签面板里按它筛选） */
const TAG_ROOT = '掌握度';
function tierTag(label) { return '#' + TAG_ROOT + '/' + label; }

/* ==================== ① 扫描：切出「标题」与「正文」两类 token ==================== */

function scan(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let fence = false;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (/^(```|~~~)/.test(t)) { fence = !fence; out.push({ kind: 'text', text: raw, lineNo: i }); return; }
    if (fence) { out.push({ kind: 'text', text: raw, lineNo: i }); return; }
    const m = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      out.push({ kind: 'head', level: m[1].length, text: m[2].trim(), lineNo: i });
    } else {
      out.push({ kind: 'text', text: raw, lineNo: i });
    }
  });
  return out;
}

/* ==================== ② 建树：标题层级 → 节点树 ==================== */

function buildTree(tokens, rootName) {
  const root = { level: 0, name: rootName || '', path: [], children: [], body: [], lineNo: -1 };
  const stack = [root];
  tokens.forEach((tk) => {
    if (tk.kind === 'head') {
      while (stack.length > 1 && stack[stack.length - 1].level >= tk.level) stack.pop();
      const parent = stack[stack.length - 1];
      const name = cleanInline(tk.text);
      const node = {
        level: tk.level, raw: tk.text, name: name || ('未命名 ' + (tk.lineNo + 1)),
        path: parent.path.concat([name || ('未命名 ' + (tk.lineNo + 1))]),
        children: [], body: [], lineNo: tk.lineNo,
        tags: extractTags(tk.text),
      };
      parent.children.push(node);
      stack.push(node);
    } else {
      stack[stack.length - 1].body.push(tk.text);
    }
  });
  return root;
}

/* ==================== ③ 正文 → 卡片 ==================== */

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** 把一段正文切成「前置段落 + 顶层列表项」 */
function splitBody(body) {
  const lines = String(body || '').split('\n');
  const items = [];
  const pre = [];
  let cur = null;
  lines.forEach((l) => {
    const m = l.match(LIST_RE);
    const isTop = m && m[1].length === 0;
    if (isTop) {
      if (cur) items.push(cur);
      cur = [l];
    } else if (cur) {
      cur.push(l);
    } else {
      pre.push(l);
    }
  });
  if (cur) items.push(cur);
  return { pre: pre.join('\n').trim(), items: items.map((a) => a.join('\n').trim()) };
}

function cardFromItem(itemText) {
  const first = itemText.split('\n')[0].replace(LIST_RE, '$3');
  const title = cleanInline(first).slice(0, 40) || '未命名知识点';
  return { title, content: stripComments(itemText).trim(), tags: extractTags(itemText) };
}

/**
 * 一个节点的正文 → 0~N 张卡片
 *   ① 正文里有 ≥2 个顶层列表项 → 每项一张卡（最贴合"一条一个知识点"的笔记习惯）
 *   ② 否则整段正文 → 1 张卡，标题用节点名
 */
function cardsOfNode(node) {
  const body = stripComments(node.body.join('\n')).trim();
  if (!body) return [];
  const { pre, items } = splitBody(body);
  if (items.length >= 2) return items.map(cardFromItem);
  const content = body;
  const title = cleanInline(node.name).slice(0, 40) || '未命名知识点';
  return [{ title, content, tags: node.tags.concat(extractTags(body)) }];
}

/** 深度遍历，产出「卡片 + 它挂在哪个节点路径上」 */
function walkCards(root, out) {
  const acc = out || [];
  root.children.forEach((n) => {
    cardsOfNode(n).forEach((c) => {
      acc.push({
        title: c.title,
        content: c.content,
        tags: c.tags || [],
        nodePath: n.path,          // ← 回写定位靠这个
        headingName: n.name,
        lineNo: n.lineNo,
        node: n,
      });
    });
    walkCards(n, acc);
  });
  return acc;
}

/* ==================== ④ 对外的解析入口 ==================== */

/**
 * 解析单个 .md
 * @returns { file, front, root, cards, nodes }
 */
function parseMarkdown(text, fileName) {
  const { front, body } = splitFrontmatter(text);
  const fileTitle = stripExt(baseName(fileName)) || 'Obsidian 笔记';
  // 先清掉上一次回写留下的高亮块，避免它被当成正文再切出一堆卡片
  const root = buildTree(scan(stripMarks(body)), fileTitle);
  const cards = walkCards(root);
  return { file: fileName, fileTitle, front, root, cards, text: String(text || '') };
}

/**
 * 解析整个 vault（多个 .md）
 * @param files [{ relPath, text }]
 * @returns { files:[parsed], categories:[{path, name}], cards:[...] }
 */
function parseVault(files) {
  const parsed = (files || []).map((f) => parseMarkdown(f.text, f.relPath));
  const cards = [];
  const catPaths = {};

  parsed.forEach((p) => {
    const rel = String(p.file).replace(/\\/g, '/');
    const parts = rel.split('/');
    parts.pop();                                   // 去掉文件名
    const folders = parts.filter((x) => x && x !== '.');

    p.cards.forEach((c) => {
      // 类别路径 = 文件夹层级 + 标题层级（节点路径以文件名为根，这里换成文件夹）
      const catPath = folders.concat(c.nodePath);
      catPath.forEach((_, i) => { catPaths[catPath.slice(0, i + 1).join('\u0001')] = catPath.slice(0, i + 1); });
      cards.push(Object.assign({}, c, {
        catPath,
        src: { file: p.file, nodePath: c.nodePath },
      }));
    });
  });

  const categories = Object.keys(catPaths).map((k) => catPaths[k]);
  return { files: parsed, categories, cards };
}

/* ==================== ④.5 稳定身份：重复导入要「更新」而不是「新增」 ====================
 *
 * 为什么必须有：
 *   笔记天生要改。老逻辑用「标题 + 内容」全等去重，且 addNotes 只往后追加 ——
 *   你把某一句改了个字再导入，就会**多出一张双胞胎卡**：旧卡还带着旧掌握度，
 *   新卡从零开始，掌握度就此分裂。用一周就废。
 *
 * 身份怎么定（用导入时就存好的字段，不需要额外记录）：
 *   精确：file + 标题路径 + 卡片标题          —— 完全没动过的那张
 *   模糊：file + 标题路径 + **同一节里的顺序** —— 你改了这条的字（标题也跟着变了）
 */

/** 精确身份：文件 + 节点路径 + 卡片标题 */
function cardKey(c) {
  const f = (c && c.src && c.src.file) || '';
  const p = (c && c.src && c.src.nodePath) || [];
  return f + '\u0001' + p.join('\u0002') + '\u0001' + String((c && c.title) || '');
}

/** 节点身份：只到标题路径（不含卡片标题）—— 用来做「同一节下第 i 条」的兜底匹配 */
function nodeKey(c) {
  const f = (c && c.src && c.src.file) || '';
  const p = (c && c.src && c.src.nodePath) || [];
  return f + '\u0001' + p.join('\u0002');
}

/**
 * 把「新导入的卡片」和「库里已有的卡片」对上
 *
 * @param existing 库里已有的卡片（需带 src.file / src.nodePath）
 * @param incoming 这次解析出来的卡片（需带 src.file / src.nodePath）
 * @returns {
 *   updates: [{ id, patch, renamed }]   要就地更新的（保留掌握度）
 *   keeps:   [{ id }]                   命中但内容没变（跳过）
 *   adds:    [incoming 卡片]             新的
 *   orphans: [existing 卡片]             同一批文件里、这次没再出现的（疑似已从笔记删除）
 * }
 */
function matchImport(existing, incoming) {
  const byKey = {};
  const byNode = {};
  (existing || []).forEach((n) => {
    if (!n || !n.src || !n.src.file) return;
    const k = cardKey(n);
    if (!byKey[k]) byKey[k] = n;
    const nk = nodeKey(n);
    (byNode[nk] = byNode[nk] || []).push(n);
  });

  const used = {};
  const updates = [];
  const keeps = [];
  const adds = [];

  (incoming || []).forEach((c) => {
    const hit = byKey[cardKey(c)];
    if (hit && !used[hit.id]) {
      used[hit.id] = true;
      if (String(hit.content || '') !== String(c.content || '')) {
        updates.push({
          id: hit.id, renamed: false,
          patch: { content: c.content, tags: c.tags || [], lineNo: c.lineNo,
                   src: { file: c.src.file, nodePath: c.src.nodePath } },
        });
      } else {
        keeps.push({ id: hit.id });
      }
      return;
    }
    // 模糊兜底：同一节里按顺序对应（你把这条的字改了 → 标题也跟着变了）
    const pool = (byNode[nodeKey(c)] || []).filter((n) => !used[n.id]);
    if (pool.length) {
      const cand = pool[0];
      used[cand.id] = true;
      updates.push({
        id: cand.id, renamed: String(cand.title || '') !== String(c.title || ''),
        patch: {
          title: c.title, content: c.content, tags: c.tags || [], lineNo: c.lineNo,
          src: { file: c.src.file, nodePath: c.src.nodePath },
        },
      });
      return;
    }
    adds.push(c);
  });

  // 孤儿：只在这一批导入涉及的文件里找，别误伤别的笔记/手写的卡
  const files = {};
  (incoming || []).forEach((c) => { if (c && c.src && c.src.file) files[c.src.file] = true; });
  const orphans = (existing || []).filter((n) => n && n.src && files[n.src.file] && !used[n.id]);
  return { updates, keeps, adds, orphans };
}

/* ==================== ⑤ 掌握度计算 ==================== */

const TIER = {
  mastered: { key: 'mastered', label: '已掌握', callout: 'success', emoji: '🟢' },
  learning: { key: 'learning', label: '学习中', callout: 'info',    emoji: '🔵' },
  weak:     { key: 'weak',     label: '薄弱',   callout: 'warning', emoji: '🟠' },
  new:      { key: 'new',      label: '未学',   callout: 'note',    emoji: '⚪' },
};

/** 单张卡片的掌握度画像 */
function masteryOf(note) {
  const a = note.alpha || 1;
  const b = note.beta || 1;
  const pct = Math.round((a / (a + b)) * 100);
  const reviews = note.reviewCount || 0;
  let tier = stats.masteryLevel(note);
  if (tier === 'learning') {
    if (pct < 45) tier = 'weak';
  }
  return {
    pct, reviews, tier,
    label: TIER[tier].label,
    callout: TIER[tier].callout,
    emoji: TIER[tier].emoji,
    nextDue: note.dueAt || 0,
    interval: note.interval || 1,
  };
}

/** 一组卡片的加权掌握度（按 alpha/beta 汇总，不是简单平均） */
function aggregate(notes) {
  const arr = notes || [];
  if (!arr.length) return { pct: 0, count: 0, reviews: 0, tier: 'new',
                            label: TIER.new.label, callout: TIER.new.callout, emoji: TIER.new.emoji };
  let a = 0, b = 0, reviews = 0;
  arr.forEach((n) => { a += (n.alpha || 1); b += (n.beta || 1); reviews += (n.reviewCount || 0); });
  const pct = Math.round((a / (a + b)) * 100);
  let tier;
  if (reviews === 0) tier = 'new';
  else if (pct >= 70 && reviews >= arr.length * 2) tier = 'mastered';
  else if (pct < 45) tier = 'weak';
  else tier = 'learning';
  return { pct, count: arr.length, reviews, tier,
           label: TIER[tier].label, callout: TIER[tier].callout, emoji: TIER[tier].emoji };
}

/* ==================== ⑥ 回写：annotate ==================== */

/** 归一化标题 key —— 用来容忍「1.2 过拟合」和「过拟合」这类只差编号的写法。
 * 用户手改过标题编号、或不同工具导出的编号格式不一样时，回写不至于整篇失配。
 */
function normKey(s) {
  return cleanInline(s)
    .replace(/^\(?\d+(?:[.\-、)）]\d+)*[.\-、)）]?\s*/, '')  // 1. / 1.2.3 / 2) / 三、
    .replace(/^[一二三四五六七八九十]+[.、)）]\s*/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 建立「精确 + 宽松」双索引 */
function indexMarks(markMap) {
  const exact = {};
  const loose = {};
  Object.keys(markMap || {}).forEach((k) => {
    exact[k] = markMap[k];
    const nk = normKey(k);
    if (nk && !loose[nk]) loose[nk] = markMap[k];
  });
  return { exact, loose };
}

/**
 * 把 study_* 字段写进 YAML frontmatter（幂等）
 *
 * 规则：
 *   ① 只动 `study_` 开头的键 —— 用户自己的 key 一个不碰、顺序不动；
 *   ② 保留了 frontmatter 与正文之间的空行（`gap`），否则会重演「每次导出多一个空行」的老 bug；
 *   ③ 原本没有 frontmatter 就新建一段。
 *
 * @param text   原文件全文
 * @param fields { study_mastery: 62, ... }
 */
function applyFront(text, fields) {
  const keys = Object.keys(fields || {});
  const src = String(text || '');
  if (!keys.length) return src;

  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n*)/);
  const body = m ? src.slice(m[0].length) : src;
  let gap = m ? m[2] : '';
  if (!gap && body) gap = '\n';

  let head = m ? m[1].split(/\r?\n/) : [];
  head = head.filter((l) => !/^\s*study_[A-Za-z0-9_]+\s*:/.test(l));
  while (head.length && !head[head.length - 1].trim()) head.pop();
  keys.forEach((k) => head.push(k + ': ' + fields[k]));

  return '---\n' + head.join('\n') + '\n---' + gap + body;
}

/**
 * 一个来源文件的汇总 → 要写进 frontmatter 的 YAML 字段
 *
 * 为什么除了高亮块还要写 frontmatter：
 *   高亮块是给人看的（颜色一眼扫过），frontmatter 是给**查询**用的 ——
 *   装了 Dataview 就能 `TABLE study_mastery FROM #study SORT study_mastery ASC`
 *   直接列出"最薄弱的笔记"。
 */
function frontFields(notes) {
  const arr = notes || [];
  const agg = aggregate(arr);
  const reviews = arr.reduce((s, n) => s + (n.reviewCount || 0), 0);
  let next = 0;
  arr.forEach((n) => { const d = n.dueAt || 0; if (d && (!next || d < next)) next = d; });

  const out = {};
  // ⚠️ 一张都没练过时 aggregate 会给出 50%（alpha=beta=1 的先验），写进笔记是错的 → 强制 0
  out.study_mastery = reviews > 0 ? agg.pct : 0;
  out.study_state = agg.label;
  out.study_cards = arr.length;
  out.study_reviews = reviews;
  if (next) out.study_next = isoDate(next);
  out.study_updated = isoDate(Date.now());
  return out;
}

/**
 * 在原 md 的每个标题行后插入/更新掌握度高亮块
 * @param originalText 原文件全文
 * @param markMap { '标题名': mastery对象 }
 * @param opts {
 *   headingDepth 最多标注到几级标题（default 6）
 *   tags         是否同时追加 #掌握度/xx 原生标签（default true）
 *   front        要写进 frontmatter 的 study_* 字段（可选）
 * }
 * @returns { text, hits, tagged, front }
 */
function annotate(originalText, markMap, opts) {
  const o = opts || {};
  const maxDepth = o.headingDepth || 6;
  const useTags = o.tags !== false;
  const idx = indexMarks(markMap);

  // ⚠️ 这里**不要**用 splitFrontmatter 重建 frontmatter。
  //    旧写法是 push('---', front, '---', '')，那个空行是凭空加的：
  //      原文   ---/tags/---/# 标题      → 导出后 ---/tags/---/(空)/# 标题
  //      再导出 ---/tags/---/(空)/(空)/# 标题   ← 每导一次多一行，无限累积
  //    正确做法：把 frontmatter 段（含它后面原有的换行）**原样切出来**，
  //    最后再原样拼回去，保证与原文逐字一致。
  const text = applyFront(String(originalText || ''), o.front);
  const m0 = text.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n*)/);
  const head = m0 ? m0[0] : '';
  const body = m0 ? text.slice(m0[0].length) : text;
  const lines = body.split(/\r?\n/);
  const out = [];
  let fence = false;
  let hits = 0;
  let tagged = 0;
  const hitKeys = {};                 // 这次成功标注到的 mark 键
  const allKeys = Object.keys(markMap || {});

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const t = raw.trim();

    if (/^(```|~~~)/.test(t)) { fence = !fence; out.push(raw); continue; }

    if (!fence) {
      const m = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (m) {
        out.push(raw);
        // 先吃掉紧跟在标题后面的旧标记，保证反复导出不会堆积
        while (i + 1 < lines.length && MARK_RE.test(lines[i + 1])) i += 1;

        if (m[1].length <= maxDepth) {
          const key = cleanInline(m[2]);
          const info = idx.exact[key] || idx.loose[normKey(m[2])];
          if (info) {
            // 记下命中的原始 mark 键（宽松匹配时用归一化名反查）
            allKeys.forEach((k) => {
              if (idx.exact[k] === info || idx.loose[normKey(k)] === info) hitKeys[k] = true;
            });
            const tail = info.reviews > 0
              ? '掌握度 ' + info.pct + '% · 复习 ' + info.reviews + ' 次 · 下次 ' + fmtDate(info.nextDue)
              : '尚未学习 · 导入后还没练过';
            let line = '> [!' + info.callout + '] ' + tail;
            if (useTags) { line += '  ' + tierTag(info.label); tagged += 1; }
            out.push(line);
            hits += 1;
          }
        }
        continue;
      }
    }
    out.push(raw);
  }

  // 没对上的 mark 键 = 笔记里已经找不到这个标题了（多半是你改过标题）
  const missing = allKeys.filter((k) => !hitKeys[k]);
  return { text: head + out.join('\n'), hits, tagged, front: !!o.front, missing };
}

/* ==================== ⑦ 待复习清单（生成给 Obsidian 的 .md） ==================== */

const DAY_MS = 86400000;

function isoDate(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function startOfDay(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 一张卡片 → Obsidian 里可点击的链接
 * Obsidian 的 [[]] 指向的是**文件名（不含扩展名）**，跨文件定位到标题用 `文件名#标题`。
 */
function obsidianLink(note) {
  const f = (note && note.src && note.src.file) || '';
  if (!f) return '';
  const base = fileBase(f);
  const path = (note.src && note.src.nodePath) || [];
  const head = String(path[path.length - 1] || '').replace(/[#\[\]|]/g, '').trim();
  return base ? '[[' + base + (head ? '#' + head : '') + ']]' : '';
}

/**
 * 生成「待复习清单.md」
 *
 * 为什么值得做：小程序里的排期只有打开小程序才看得见，而 Obsidian 是用户真正待着的地方。
 * 把到期卡片变成一份**可点击的 .md**，复习闭环就落在 Obsidian 里了 ——
 * 点链接 → 跳到原笔记 → 回忆一遍 → 回小程序练一轮。
 *
 * @param notes 全部卡片
 * @param opts  { days: 往后看几天, default 7, now }
 */
function dueList(notes, opts) {
  const o = opts || {};
  const days = typeof o.days === 'number' ? o.days : 7;
  const now = o.now || Date.now();
  const t0 = startOfDay(now);
  const dayEnd = t0 + DAY_MS;
  const until = t0 + (days + 1) * DAY_MS;

  const all = (notes || []).filter((n) => n && n.title);
  const linked = all.filter((n) => n.src && n.src.file);
  const noSrc = all.length - linked.length;

  const groups = [
    { key: 'overdue', title: '🔴 已经逾期', items: [] },
    { key: 'today',   title: '📅 今天到期', items: [] },
    { key: 'soon',    title: '⏳ 未来 ' + days + ' 天', items: [] },
  ];
  const byKey = {};
  groups.forEach((g) => { byKey[g.key] = g; });

  linked.forEach((n) => {
    const due = n.dueAt || 0;
    if (due < t0) byKey.overdue.items.push(n);
    else if (due < dayEnd) byKey.today.items.push(n);
    else if (due <= until) byKey.soon.items.push(n);
  });

  const sortByDue = (a, b) => (a.dueAt || 0) - (b.dueAt || 0);
  groups.forEach((g) => g.items.sort(sortByDue));

  const total = groups.reduce((s, g) => s + g.items.length, 0);

  // 一块都没有 → 别给一份空文件，直接列最近要到期的，让人有下手的地方
  let fallback = null;
  if (!total) {
    fallback = {
      key: 'next', title: '📆 接下来最近到期的（共 ' + linked.length + ' 张里取前 15）',
      items: linked.slice().filter((n) => (n.dueAt || 0) > until).sort(sortByDue).slice(0, 15),
    };
  }

  const line = (n) => {
    const m = masteryOf(n);
    const bits = [];
    bits.push(m.reviews > 0 ? m.emoji + ' ' + m.pct + '% · ' + m.label
                            : m.emoji + ' 还没练过');
    // ⚠️ 逾期天数按**自然日**算（到期日到今天隔了几天），不是按「距 now 的小时数」取整 ——
    //    否则 27 号到期的卡在 29 号凌晨会显示成「逾期 1 天」，和人的直觉对不上。
    const overdue = Math.round((t0 - startOfDay(n.dueAt || now)) / DAY_MS);
    if ((n.dueAt || 0) < t0 && overdue > 0) bits.push('逾期 ' + overdue + ' 天');
    else if ((n.dueAt || 0) >= dayEnd) bits.push('到期 ' + isoDate(n.dueAt));
    if (m.reviews > 0) bits.push('练过 ' + m.reviews + ' 次');
    return '- ' + obsidianLink(n) + ' — ' + bits.join(' · ');
  };

  const blocks = [];
  (fallback ? [fallback] : groups).forEach((g) => {
    if (!g.items.length) return;
    blocks.push('## ' + g.title + '（' + g.items.length + '）', '');
    blocks.push(g.items.map(line).join('\n'), '');
  });

  const head =
    '> [!info] 共 ' + (fallback ? fallback.items.length : total) + ' 张'
    + (fallback ? '（最近到期的）'
                : '（逾期 ' + byKey.overdue.items.length
                  + ' · 今天 ' + byKey.today.items.length
                  + ' · 未来 ' + days + ' 天 ' + byKey.soon.items.length + '）');

  const tailLines = [
    '---',
    '',
    '### 怎么用',
    '',
    '1. 每一行都是 Obsidian 的 `[[文件#标题]]`，**点一下就能跳到原笔记的对应章节**；',
    '2. 这份清单是**一次性快照**，不会改动你的笔记，也没有勾选状态；',
    '3. 在笔记里回忆一遍，再回小程序练一轮 —— 掌握度、到期时间都会更新，下次导出就是新的清单。',
    '',
  ];
  if (noSrc > 0) {
    tailLines.push('> 另有 ' + noSrc + ' 张卡片不是从 Obsidian 笔记导入的，没有原笔记可跳转，没有列进这份清单。', '');
  }
  tailLines.push(
    '> 🟢 已掌握 / 🔵 学习中 / 🟠 薄弱 / ⚪ 未学 与小程序的掌握度分档一致。',
    '',
    '_由「知识卡片」小程序生成 · ' + isoDate(now) + '_',
    '',
  );

  return [
    '---',
    'type: study-companion-todo',
    'generated: ' + isoDate(now),
    'due: ' + (fallback ? fallback.items.length : total),
    'tags:',
    '  - study',
    '  - 待复习',
    '---',
    '',
    '# 📝 今天该复习什么',
    '',
    head,
    '',
    blocks.join('\n'),
    tailLines.join('\n'),
  ].join('\n');
}

/* ==================== ⑦.5 复习提醒（.ics 日历） ==================== */

/**
 * 生成一份可导入手机日历的 .ics
 *
 * 为什么用日历而不是推送：小程序的订阅消息需要**服务端**按模板发，
 * 而这个项目是零后端设计。日历是唯一"不需要服务器也能到点提醒"的路子 ——
 * 导入一次，之后系统自己提醒你。
 *
 * 每天一个全天事件：标题写「复习 N 张」，描述里列出当天该练的卡片。
 */
function icsFor(notes, opts) {
  const o = opts || {};
  const days = typeof o.days === 'number' ? o.days : 7;
  const now = o.now || Date.now();
  const t0 = startOfDay(now);
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

  const buckets = {};
  (notes || []).forEach((n) => {
    if (!n || !n.title || !n.dueAt) return;
    const d = startOfDay(n.dueAt);
    if (n.dueAt < t0 || d > t0 + days * DAY_MS) return;
    const key = isoDate(d).replace(/-/g, '');
    (buckets[key] = buckets[key] || []).push(n);
  });

  const esc = (t) => String(t || '')
    .replace(/[\;,]/g, ' ')
    .replace(/[\r\n]+/g, ' ');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI-' + esc('\u94fe\u8bb0') + '//study-reminder//CN',
    'CALSCALE:GREGORIAN',
  ];
  Object.keys(buckets).sort().forEach((k) => {
    const arr = buckets[k].slice().sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
    const end = new Date(Number(k.slice(0, 4)), Number(k.slice(4, 6)) - 1, Number(k.slice(6, 8)) + 1);
    const endKey = isoDate(end.getTime()).replace(/-/g, '');
    const titles = arr.slice(0, 12).map((n) => n.title);
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + k + '-' + arr.length + '@ai-lianji',
      'DTSTAMP:' + isoDate(now).replace(/-/g, '') + 'T000000Z',
      'DTSTART;VALUE=DATE:' + k,
      'DTEND;VALUE=DATE:' + endKey,
      'SUMMARY:' + esc('\u590d\u4e60 ' + arr.length + ' \u5f20\u5361\u7247'),
      'DESCRIPTION:' + esc(titles.join('\u3001') + (arr.length > 12 ? ' \u7b49' : '')),
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  });
  lines.push('END:VCALENDAR');
  return lines.join(CRLF) + CRLF;
}

/* ==================== ⑧ 汇总报告 ==================== */

function tree2lines(nodes, depth, rows) {
  // nodes: [{ name, children, notes, agg }]
  (nodes || []).forEach((n) => {
    const bars = '🟩'.repeat(Math.round(n.agg.pct / 20)) + '⬜'.repeat(5 - Math.round(n.agg.pct / 20));
    rows.push({
      depth,
      line: '- ' + n.agg.emoji + ' **' + n.name + '** — ' + n.agg.pct + '% · '
            + n.agg.count + ' 张 · ' + n.agg.label,
      bars,
    });
    tree2lines(n.children, depth + 1, rows);
  });
  return rows;
}

/**
 * 生成汇总报告 md
 * @param tree [ { name, agg, children:[...] } ]
 * @param overall 全局 aggregate
 * @param opts { title }
 */
function report(tree, overall, opts) {
  const o = opts || {};
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());

  const rows = tree2lines(tree || [], 0, []);
  const body = rows.map((r) => '  '.repeat(r.depth) + r.line).join('\n');

  return [
    '---',
    'type: study-companion-report',
    'generated: ' + dateStr,
    'cards: ' + (overall.count || 0),
    'mastery: ' + (overall.pct || 0) + '%',
    'tags:',
    '  - study',
    '  - 掌握度',
    '---',
    '',
    '# 📊 ' + (o.title || '知识卡片掌握度报告'),
    '',
    '> [!' + overall.callout + '] **总体掌握度 ' + overall.pct + '%** · '
      + overall.count + ' 张卡片 · 累计复习 ' + overall.reviews + ' 次 · ' + overall.label,
    '',
    '## 按类别树展开',
    '',
    body || '_（还没有数据）_',
    '',
    '## 怎么用',
    '',
    '1. 这份报告只是快照，**不会改动你的笔记**；',
    '2. 想看到「每个标题旁边的掌握度」，请用小程序里的 **导出带掌握度的 .md**，那份会按标题逐个标注；',
    '3. 配 [Dataview](https://github.com/blacksmithgu/obsidian-dataview) 可以直接查：',
    '',
    '```dataview',
    'TABLE mastery AS "掌握度", cards AS "卡片数", generated AS "生成时间"',
    'FROM #study',
    'WHERE type = "study-companion-report"',
    'SORT mastery DESC',
    '```',
    '',
    '---',
    '',
    '_由「知识卡片」小程序生成 · ' + dateStr + '_',
    '',
  ].join('\n');
}

/* ==================== ⑧ 建类别树（给 category.js 用） ==================== */

/** [[a,b,c], ...] → 树状嵌套，用于预览 */
function paths2tree(paths) {
  const root = { name: '', children: [], childrenMap: {} };
  (paths || []).forEach((p) => {
    let cur = root;
    p.forEach((name) => {
      if (!cur.childrenMap[name]) {
        const n = { name, children: [], childrenMap: {}, score: 0 };
        cur.childrenMap[name] = n;
        cur.children.push(n);
      }
      cur = cur.childrenMap[name];
    });
  });
  const strip = (n) => {
    delete n.childrenMap;
    (n.children || []).forEach(strip);
    return n;
  };
  return strip(root).children;
}

/**
 * 统计「有标题但没正文」的节点数 —— 这些节点不会生成卡片。
 * 纯大纲式笔记（只有标题没有正文）比较常见，导入预览里要如实告诉用户，
 * 否则用户会以为「导入丢了内容」。
 */
function countEmptyNodes(root) {
  let n = 0;
  const walk = (node) => {
    (node.children || []).forEach((c) => {
      const hasBody = stripComments(c.body.join('\n')).trim().length > 0;
      if (!hasBody) n += 1;
      walk(c);
    });
  };
  walk(root);
  return n;
}

/** 一个 root 下的标题总数 */
function countHeadings(root) {
  let n = 0;
  const walk = (node) => {
    (node.children || []).forEach((c) => { n += 1; walk(c); });
  };
  walk(root);
  return n;
}

/**
 * 从文件名推 basename（去路径、去扩展名）—— Obsidian 的 [[链接]] 指向的就是它
 */
function fileBase(p) {
  return stripExt(baseName(p));
}

module.exports = {
  cardKey, nodeKey, matchImport,
  TIER, cleanInline, extractTags, baseName, stripExt, fmtDate,
  countEmptyNodes, countHeadings, fileBase,
  splitFrontmatter, scan, buildTree, cardsOfNode, walkCards,
  parseMarkdown, parseVault,
  masteryOf, aggregate, annotate, applyFront, frontFields, report, paths2tree,
  stripMarks, tierTag, isoDate, obsidianLink, dueList, icsFor,
};
