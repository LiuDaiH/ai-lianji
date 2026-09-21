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
//         → annotate()  在原 md 每个标题后插入 Obsidian 高亮块
//         → report()    额外生成一份汇总报告
//         → wx.shareFileMessage 发到聊天 → 电脑上覆盖回 vault
//
// 设计要点：
//   ① 标题行 → 节点，「节点路径」= 祖先标题数组，回写时靠它精确定位
//   ② 导入时把每张卡片的节点路径写进 note.src，回写才有依据
//   ③ annotate 是**幂等**的：会先删掉上一次插入的标记再重插，反复导出不会堆积

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
  const root = buildTree(scan(body), fileTitle);
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

// 上一次插入的标记行（用于幂等清理）
const MARK_RE = /^\s*>\s*\[!\w+\]\s*(?:掌握度\s|尚未学习|已掌握|学习中|薄弱|未学)/;

/**
 * 归一化标题 key —— 用来容忍「1.2 过拟合」和「过拟合」这类只差编号的写法。
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
 * 在原 md 的每个标题行后插入/更新掌握度高亮块
 * @param originalText 原文件全文
 * @param markMap { '标题名': mastery对象 }
 * @param opts { headingDepth: 最多标注到几级标题, default 6 }
 */
function annotate(originalText, markMap, opts) {
  const o = opts || {};
  const maxDepth = o.headingDepth || 6;
  const idx = indexMarks(markMap);
  const { front, body } = splitFrontmatter(originalText);
  const lines = body.split(/\r?\n/);
  const out = [];
  let fence = false;
  let hits = 0;

  if (front) { out.push('---', front, '---', ''); }

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
            const tail = info.reviews > 0
              ? '掌握度 ' + info.pct + '% · 复习 ' + info.reviews + ' 次 · 下次 ' + fmtDate(info.nextDue)
              : '尚未学习 · 导入后还没练过';
            out.push('> [!' + info.callout + '] ' + tail);
            hits += 1;
          }
        }
        continue;
      }
    }
    out.push(raw);
  }

  return { text: out.join('\n'), hits };
}

/* ==================== ⑦ 汇总报告 ==================== */

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

module.exports = {
  TIER, cleanInline, extractTags, baseName, stripExt, fmtDate,
  splitFrontmatter, scan, buildTree, cardsOfNode, walkCards,
  parseMarkdown, parseVault,
  masteryOf, aggregate, annotate, report, paths2tree,
};
