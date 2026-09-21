// utils/ai.js —— 微信云开发 AI+ 统一入口（所有 AI 能力都从这里走）
//
// 设计三条原则（决定了它为什么"加了 AI 也不会把 App 做脆"）：
//
//   ① 页面永远不直接碰 wx.cloud —— 只调本模块暴露的 3 个业务函数
//      splitCards() / gradeRecall() / ping()
//
//   ② 任何一步失败都返回 null，调用方自动降级到本地算法：
//      没配置环境 ID、基础库不支持、云函数报错、模型没在控制台开启、
//      返回的 JSON 解析不出来 …… 全都走降级。
//      → 所以【没开云开发时整个 App 功能完全不受影响】，只是少了 AI 那一层
//
//   ③ API Key 不落在前端：走云开发托管，也不用配域名白名单
//
// 官方接口（微信开放文档 小程序 → 云开发 → AI 快速开始）：
//   wx.cloud.init({ env })
//   const model = wx.cloud.extend.AI.createModel('cloudbase')
//   const res = await model.generateText({ model: 'hy3-preview', messages: [...] })
//   res.choices[0].message.content
//   要求：基础库 ≥ 3.15.1、已开通云开发、控制台 AI → 生文模型 里把模型打开

const ENV_KEY = 'sc_ai_env';      // 用户自己填的环境 ID
const OFF_KEY = 'sc_ai_off';      // 用户主动关闭 AI 的开关

// 配置（环境 ID / 模型名）单独放在 ai-config.js —— 那是唯一需要手填的地方
const CFG = require('./ai-config.js');


const PROVIDER = 'cloudbase';        // 云开发 AI+ 的 provider
const MODEL = CFG.MODEL || 'hy3-preview';   // 默认混元，可在 ai-config.js 里换
const TIMEOUT = 45000;               // 模型偶发挂起时的兜底
const MAX_INPUT = 3000;              // 输入截断，避免 token 爆掉

let inited = false;
let lastError = '';            // 最后一次真实错误原文，只用于「测试连通性」时告诉用户卡在哪

/* ==================== 配置 ==================== */

/* ---------- AI 开关（用户可主动关掉，退回纯本地算法） ---------- */
function isOff() {
  try { return !!wx.getStorageSync(OFF_KEY); } catch (e) { return false; }
}

function setOff(v) {
  try { wx.setStorageSync(OFF_KEY, v ? 1 : 0); } catch (e) { /* ignore */ }
  inited = false;
}

/** 用户在界面上自己填的那个（不含内置）—— 界面只显示这个，不暴露内置 ID */
function getUserEnv() {
  try { return wx.getStorageSync(ENV_KEY) || ''; } catch (e) { return ''; }
}

/** 代码里是否配置了内置环境 */
function hasBuiltin() { return !!CFG.BUILTIN_ENV; }

/** 当前是否在用内置环境（界面用来提示，但不显示具体值） */
function usingBuiltin() { return !getUserEnv() && hasBuiltin() && !isOff(); }

/**
 * 最终生效的环境 ID
 * 优先级：用户关掉了 AI → 空（退回本地）
 *         用户自己填了     → 用用户的
 *         否则             → 用内置的（对用户不可见）
 */
function getEnv() {
  if (isOff()) return '';
  return getUserEnv() || CFG.BUILTIN_ENV || '';
}

/** 一次性拿到界面要用的所有状态（避免界面到处拼逻辑） */
function status() {
  return {
    off: isOff(),
    userEnv: getUserEnv(),
    usingBuiltin: usingBuiltin(),
    hasBuiltin: hasBuiltin(),
    env: getEnv(),
    active: !!getEnv() && supported(),
  };
}

function setEnv(id) {
  try { wx.setStorageSync(ENV_KEY, String(id || '').trim()); } catch (e) { /* ignore */ }
  inited = false;
}

/** 云开发扩展能力是否可用（只检查到 extend 这一层） */
function supported() {
  // ⚠️ 这里**不能**检查 wx.cloud.extend.AI ——
  // AI 是 wx.cloud.init() 成功之后才挂到 extend 上的，
  // 如果在这里就先要 AI 存在，就会形成死锁：
  //   supported() 为 false → ensureInit() 直接返回 → 永远不 init → AI 永远挂不上
  try { return !!(wx.cloud && wx.cloud.extend); } catch (e) { return false; }
}

/** wx.cloud.extend.AI 是否已挂上（必须 init 之后再看） */
function hasAI() {
  try { return !!(wx.cloud && wx.cloud.extend && wx.cloud.extend.AI); } catch (e) { return false; }
}

/** 是否已经配好可用（配了环境 ID + 云开发扩展可用） */
function enabled() {
  if (!getEnv() || !supported()) return false;
  ensureInit();          // 顺手初始化一次，让 extend.AI 挂上
  return true;
}

function ensureInit() {
  if (inited) return true;
  const env = getEnv();
  if (!env || !supported()) return false;
  try {
    wx.cloud.init({ env, traceUser: true });
    inited = true;
    return true;
  } catch (e) {
    lastError = 'wx.cloud.init 失败：' + ((e && (e.errMsg || e.message)) || String(e));
    console.warn('[ai]', lastError);
    return false;
  }
}

/**
 * 环境自检 —— 分层报告「到底缺哪一层」，比笼统的"不支持"好定位得多
 *   hasCloud  : wx.cloud 有没有
 *   hasExtend : wx.cloud.extend 有没有（基础库 ≥ 3.7.1 才有）
 *   hasAI     : wx.cloud.extend.AI 有没有
 *   sdk       : 当前实际生效的基础库版本
 */
function envInfo() {
  const out = { hasCloud: false, hasExtend: false, hasAI: false, sdk: '', err: '' };
  try { out.sdk = (wx.getAppBaseInfo && wx.getAppBaseInfo().SDKVersion) || ''; } catch (e) { /* ignore */ }
  if (!out.sdk) { try { out.sdk = (wx.getSystemInfoSync() || {}).SDKVersion || ''; } catch (e) { /* ignore */ } }
  try { out.hasCloud = !!wx.cloud; } catch (e) { out.err = String(e); }
  try { out.hasExtend = !!(wx.cloud && wx.cloud.extend); } catch (e) { /* ignore */ }
  try { out.hasAI = !!(wx.cloud && wx.cloud.extend && wx.cloud.extend.AI); } catch (e) { /* ignore */ }
  return out;
}

/** 基础库版本比较：a >= b ? */
function sdkAtLeast(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/* ==================== 底层调用 ==================== */

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    promise.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
           .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
  });
}

/**
 * 单轮对话，返回纯文本。任何异常都返回 null。
 * @param {Array} messages [{role:'system'|'user', content}]
 */
async function chat(messages, opts) {
  lastError = '';
  if (!ensureInit()) { lastError = 'init 失败（未配置环境 ID 或基础库不支持）'; return null; }
  const model = (opts && opts.model) || MODEL;
  try {
    const m = wx.cloud.extend.AI.createModel(PROVIDER);
    const res = await withTimeout(m.generateText({ model, messages }), TIMEOUT);
    const txt = res && res.choices && res.choices[0] && res.choices[0].message
      ? res.choices[0].message.content
      : '';
    return String(txt || '').trim() || null;
  } catch (e) {
    lastError = (e && (e.errMsg || e.message)) ? String(e.errMsg || e.message) : String(e);
    console.warn('[ai] 调用失败 → 降级到本地算法', lastError);
    return null;
  }
}

/**
 * 从模型回复里抠出 JSON —— 模型经常裹 ```json 或者前面bbb两句，
 * 所以不用 JSON.parse 硬吃，而是扫描第一个 [ / { 再做括号配对。
 */
function pickJSON(text) {
  if (!text) return null;
  const s = String(text).replace(/```json/gi, '').replace(/```/g, '');
  const starts = [s.indexOf('['), s.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min.apply(null, starts);
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/* ==================== 业务能力 ①：AI 智能切卡 ==================== */

const SPLIT_SYSTEM = [
  '你是「知识点卡片」切分助手。用户会给你一段讲义/笔记原文（格式可能很乱：',
  '可能是 PPT 复制的一坨、可能有编号、可能有换行混乱）。',
  '',
  '你的任务：把它切成若干张**独立可考**的知识点卡片。',
  '规则：',
  '1. 一张卡只讲一个知识点，标题是这个知识点的名字，内容是它的完整解释；',
  '2. 标题不超过 20 个字，不要带「1.」「一、」这类编号；',
  '3. 内容要自包含 —— 脱离原文也能看懂，公式、定义、要点都保留；',
  '4. 如果某段只是过渡话/废话/目录，直接丢掉，不要硬切；',
  '5. 宁少勿碎：不要把一个知识点拆成两张；',
  '6. 保留原文里的术语、数字、公式，不要改写事实。',
  '',
  '只输出 JSON 数组本身。不要解释、不要 markdown 代码块、不要在外面包一层对象。',
  '格式严格如下（数组第一个字符就是 [）：',
  '[{"title":"梯度下降","content":"沿负梯度方向迭代更新参数；学习率过大震荡、过小收敛慢。"}]',
].join('\n');

/**
 * 用大模型把乱格式原文切成卡片
 * @returns [{title, content}] 或 null（调用方降级到本地规则切分）
 */
async function splitCards(raw) {
  const text = String(raw || '').trim();
  if (text.length < 4) return null;

  const out = await chat([
    { role: 'system', content: SPLIT_SYSTEM },
    { role: 'user', content: text.slice(0, MAX_INPUT) },
  ]);
  if (!out) return null;

  let arr = pickJSON(out);
  // 有些模型会包一层 { cards: [...] } / { data: [...] } / { list: [...] }
  if (arr && !Array.isArray(arr)) {
    arr = arr.cards || arr.data || arr.list || arr.items || null;
  }
  if (!Array.isArray(arr)) {
    console.warn('[ai] 切卡返回的不是数组，原文前 200 字：', String(out).slice(0, 200));
    return null;
  }

  const cards = arr
    .map((it) => {
      // 字段别名兜全：混元输出中文，有可能用中文键名
      const title = String((it && (it.title || it.name || it.heading || it.q
        || it['标题'] || it['知识点'] || it['名称'])) || '').trim().slice(0, 40);
      const content = String((it && (it.content || it.body || it.desc || it.a || it.answer
        || it['内容'] || it['解释'] || it['说明'])) || '').trim();
      // 内容为空时用标题兜底，别整张丢掉（丢了用户会觉得"AI 什么也没切出来"）
      return { title, content: content || title };
    })
    .filter((c) => c.title && c.title.length >= 2)
    .slice(0, 80);

  if (!cards.length) return null;
  cards._picked = 'ai';
  return cards;
}

/* ==================== 业务能力 ②：默写题 AI 语义判分 ==================== */

const GRADE_SYSTEM = [
  '你是严格的阅卷人，判断学生的默写答案和参考答案在**语义上**是否一致。',
  '不要只做字面比对 —— 同义表述、换个说法说对了，都应该算对；',
  '只写了关键词但没有把逻辑串起来，算部分对；',
  '写反了、写错了因果、漏了关键限定条件，要扣分。',
  '',
  '只输出 JSON，不要任何解释和 markdown 代码块。',
  '格式：{"score": 0到1之间的小数, "hit": ["答对的要点"], "missed": ["漏掉或答错的要点"], "comment": "一句话点评，25字以内，直接对学生说"}',
].join('\n');

/**
 * 语义判分默写题
 * @param stem      题目（卡片标题）
 * @param reference 参考答案（卡片内容）
 * @param answer    学生写的
 * @returns { score, hit, missed, comment } 或 null（调用方降级到关键词命中率）
 */
async function gradeRecall(stem, reference, answer) {
  const a = String(answer || '').trim();
  if (!a) return null;

  const out = await chat([
    { role: 'system', content: GRADE_SYSTEM },
    {
      role: 'user',
      content: '题目：' + String(stem || '').slice(0, 200)
        + '\n\n参考答案：' + String(reference || '').slice(0, 1200)
        + '\n\n学生答案：' + a.slice(0, 1200)
        + '\n\n请按约定 JSON 输出评分。',
    },
  ]);
  if (!out) return null;

  const obj = pickJSON(out);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  let score = Number(obj.score);
  if (!isFinite(score)) return null;
  if (score > 1) score = score / 100;              // 有些模型会回 85 而不是 0.85
  score = Math.max(0, Math.min(1, score));

  return {
    score,
    hit: Array.isArray(obj.hit) ? obj.hit.slice(0, 6).map(String) : [],
    missed: Array.isArray(obj.missed) ? obj.missed.slice(0, 6).map(String) : [],
    comment: String(obj.comment || '').trim().slice(0, 60),
  };
}

/* ==================== 业务能力 ③：AI 分层提示 ==================== */

const HINT_SYSTEM = [
  '你在帮一个正在「主动回忆」的学习者。他正在努力想起某个知识点，但现在卡住了。',
  '',
  '你的唯一任务是给**方向性提示**，帮助他自己想起来。',
  '',
  '绝对禁止：',
  '· 不能直接说出答案，不能写出答案里的关键术语',
  '· 不能把参考答案改写一遍给他',
  '· 不能给出任何能直接抄的完整表述',
  '',
  '规则：',
  '· level=1：只给一个思考方向 —— 提示它属于哪一类、和什么有关、从哪个角度想。',
  '· level=2：可以点出"该往哪个部分想"，但依然不能说出具体术语。',
  '',
  '只输出提示本身，一句话，25 字以内，不要任何解释和前缀。',
].join('\n');

/**
 * 分层提示：卡住时给方向，但绝不替他想出答案
 * @param level 1 = 只给方向；2 = 更具体一点
 * @returns {string} 提示文本，或 null（调用方回退到本地提示）
 */
async function hintFor(stem, reference, level) {
  const lv = level === 2 ? 2 : 1;
  const out = await chat([
    { role: 'system', content: HINT_SYSTEM },
    {
      role: 'user',
      content: '知识点标题：' + String(stem || '').slice(0, 120)
        + '\n\n【仅供你参考，绝对不能泄露】完整答案：' + String(reference || '').slice(0, 700)
        + '\n\n请给出 level=' + lv + ' 的方向性提示。',
    },
  ]);
  if (!out) return null;
  const t = out.replace(/^["「『]|["」』]$/g, '').trim();
  return t ? t.slice(0, 60) : null;
}

/* ==================== 业务能力 ④：AI 错因诊断 ==================== */

const DIAG_SYSTEM = [
  '你是学习诊断助手。学生会答错一个知识点，你要判断他**错在哪个环节**，',
  '这比单纯说"答错了"有用得多 —— 因为不同的错因要用不同的补法。',
  '',
  '错因分类只能从下面 6 个里选一个，原样输出：',
  '概念混淆 · 记不全 · 因果关系错 · 漏掉限定条件 · 只会背不会用 · 完全没印象',
  '',
  '然后给一句**怎么补**的具体建议，20 字以内，要可执行。',
  '',
  '只输出 JSON，不要任何解释和 markdown 代码块。',
  '格式：{"reason":"从上面 6 个里选一个","fix":"一句可执行的补法"}',
].join('\n');

/**
 * 错因诊断：把"答错了"变成"错在哪、该怎么补"
 * @returns { reason, fix } 或 null
 */
async function diagnoseWrong(stem, reference, userAnswer) {
  const out = await chat([
    { role: 'system', content: DIAG_SYSTEM },
    {
      role: 'user',
      content: '知识点：' + String(stem || '').slice(0, 120)
        + '\n正确答案要点：' + String(reference || '').slice(0, 700)
        + '\n学生写的：' + String(userAnswer || '（空）').slice(0, 500),
    },
  ]);
  if (!out) return null;
  const obj = pickJSON(out);
  if (!obj || Array.isArray(obj)) return null;
  const reason = String(obj.reason || '').trim().slice(0, 20);
  const fix = String(obj.fix || '').trim().slice(0, 50);
  if (!reason) return null;
  return { reason, fix };
}

/* ==================== 业务能力 ⑤：AI 学习诊断 ==================== */

const ADVICE_SYSTEM = [
  '你是学习教练。用户会给你一份他最近的学习数据快照（掌握度、错得最多的知识点、',
  '复习节奏等）。',
  '',
  '请给出**两句话**：',
  '第 1 句：指出他当前最值得注意的一个问题（要具体到知识点类型或节奏，不要泛泛而谈）。',
  '第 2 句：给他现在就该做的一件事。',
  '',
  '要求：',
  '· 语气像一个了解他的教练，直接、不说教、不安慰',
  '· 不要出现"建议你"这种空话，直接说做什么',
  '· 总共 60 字以内',
  '· 只输出这两句话，不要标题、不要编号、不要 markdown',
].join('\n');

/**
 * 学习诊断：把统计数据翻译成"你现在该干什么"
 * @returns {string} 诊断文本，或 null
 */
async function studyAdvice(snapshot) {
  const out = await chat([
    { role: 'system', content: ADVICE_SYSTEM },
    { role: 'user', content: String(snapshot || '').slice(0, 1500) },
  ]);
  if (!out) return null;
  return out.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim().slice(0, 160) || null;
}

/* ==================== 连通性自检（设置页用） ==================== */

async function ping() {
  // 顺序很重要：先把能查的都查了 → 再 init → init 之后才能看 extend.AI
  const env = getEnv();
  if (!env) return { ok: false, msg: '① 还没填云开发环境 ID' };
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,40}$/.test(env)) {
    return { ok: false, msg: '① 环境 ID 格式不对：「' + env + '」。'
      + '它应该像 my-env-1a2b3c 这样，只有字母数字和短横线，不含空格或中文' };
  }

  const info0 = envInfo();
  if (!info0.hasCloud) {
    return { ok: false, msg: '② wx.cloud 不存在。请确认项目「详情 → 项目配置」里的后端服务'
      + '选的是「云开发」而不是「不使用云服务」，改完重新编译' };
  }
  if (!info0.hasExtend) {
    return { ok: false, msg: '② wx.cloud.extend 不存在 | 基础库=' + (info0.sdk || '未知')
      + '。需要 ≥ 3.7.1，去「详情 → 本地设置 → 调试基础库」升级后重新编译' };
  }

  // ★ 先 init —— wx.cloud.extend.AI 是 init 成功之后才挂上去的
  if (!ensureInit()) {
    return { ok: false, msg: '③ 初始化失败：' + (lastError || '未知原因')
      + '。常见原因：云开发环境还没创建好、或环境 ID 不属于当前 AppID' };
  }

  const info = envInfo();
  if (!info.hasAI) {
    return { ok: false, msg: '④ 云开发已初始化，但 wx.cloud.extend.AI 仍然不存在'
      + '（基础库 ' + (info.sdk || '未知') + '）。'
      + '通常说明这个环境还没开通 AI 能力：去云开发控制台 → 左侧「AI」→「生文模型」，'
      + '把 hy3-preview（混元）打开；如果 AI 菜单里提示要先「开通」，先点开通' };
  }

  const out = await chat([
    { role: 'system', content: '只回两个字：正常' },
    { role: 'user', content: '连通性测试' },
  ]);
  if (out) return { ok: true, msg: 'AI 已连通：' + out.slice(0, 20) };
  return { ok: false, msg: '⑤ 模型调用失败：' + (lastError || '无返回内容')
    + '。检查云开发控制台「AI → 生文模型」里 hy3-preview 是否已勾选并保存' };
}

/** 全部 AI 能力的清单（关于页、介绍页都用它，避免两处说法不一致） */
const FEATURES = [
  { key: 'split',   name: '智能切卡',   desc: '格式再乱的讲义也能切成结构化知识点卡片', where: '录入页' },
  { key: 'grade',   name: '语义判分',   desc: '默写题改判"意思对不对"，不再只数关键词', where: '小测 · 默写题' },
  { key: 'hint',    name: '分层提示',   desc: '卡住时给方向，但绝不替你把答案说出来', where: '小测 · 回忆题' },
  { key: 'diag',    name: '错因诊断',   desc: '把"答错了"变成"错在哪、该怎么补"', where: '小测 · 答错后' },
  { key: 'advice',  name: '学习诊断',   desc: '把统计数据翻译成"你现在该干什么"', where: '统计页' },
];

module.exports = {
  ENV_KEY, OFF_KEY, MODEL, FEATURES, envInfo, sdkAtLeast,
  getEnv, setEnv, isOff, setOff, getUserEnv, hasBuiltin, usingBuiltin, status,
  supported, enabled, ensureInit,
  chat, pickJSON,
  splitCards, gradeRecall, hintFor, diagnoseWrong, studyAdvice,
  ping,
};
