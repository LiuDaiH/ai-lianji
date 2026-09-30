// pages/quiz/quiz.js —— 五种题型 + 撤销 + 错题重练 + 触感反馈
const store = require('../../utils/store.js');
const quizLib = require('../../utils/quiz.js');
const scheduler = require('../../utils/scheduler.js');
const filter = require('../../utils/filter.js');
const haptic = require('../../utils/haptic.js');
const ai = require('../../utils/ai.js');

const TYPE_LABEL = { flip: '回忆', choice: '选择', judge: '判断', blank: '填空', recall: '默写' };
const SCOPE_KEY = 'sc_quiz_scope';
const SIZE_KEY = 'sc_quiz_size';
const TYPES_KEY = 'sc_quiz_types';

Page({
  data: {
    quiz: [], idx: 0, current: null, typeLabel: '',
    submitted: false, isRight: false, rightCount: 0, finished: false, emptyTip: '',
    showAnswer: false, hintUsed: 0, hintText: '',
    picked: '', blankInput: '', recallInput: '', recallHit: 0, recallTotal: 0,
    // AI 语义判分（grading = 正在等模型返回）
    grading: false, aiUsed: false, aiComment: '', aiMissed: '', aiOn: false,
    // AI 分层提示 + 错因诊断
    aiHinting: false, aiHintUsed: false, aiDiag: null, aiDiagLoading: false,
    wrongList: [], isRetry: false, rangeText: '',
    canUndo: false, answered: 0,
    // 首次进页引导
    tourActive: false, tourFlow: 'quiz', pageStyle: '',
  },

  onLoad() {
    this.setData({ aiOn: ai.enabled() });
    haptic.readSetting();
    const scope = wx.getStorageSync(SCOPE_KEY) || 'all';
    const size = wx.getStorageSync(SIZE_KEY) || 10;
    let allowed = [];
    try { allowed = wx.getStorageSync(TYPES_KEY) || []; } catch (e) { allowed = []; }
    wx.removeStorageSync(SCOPE_KEY);
    wx.removeStorageSync(SIZE_KEY);

    this.scopeText = filter.rangeShort(scope);

    const allNotes = store.listNotes();
    const scoped = filter.notesByCat(allNotes, scope);
    const withContent = scoped.filter((n) => n.content && String(n.content).trim());
    const pool0 = withContent.length >= 1 ? withContent : scoped;

    const due = scheduler.todayQueue(pool0, 0);
    const pool = due.length >= 3 ? due : pool0;
    const cnt = size > 0 ? Math.min(size, pool.length) : pool.length;
    const quiz = quizLib.makeQuiz(pool, cnt, allowed);

    this.setData({ rangeText: filter.rangeText(scope) });
    if (!quiz.length) {
      this.setData({ emptyTip: '这个范围内还没有可出题的卡片，先去「录入知识点」加几张' });
      return;
    }
    this.setData({ quiz, current: quiz[0], typeLabel: TYPE_LABEL[quiz[0].type] || '' });
    this.maybeTour();     // 第一次进小测：放一遍引导
  },

  // ---------- 各题型交互 ----------
  onHint() {
    const cur = this.data.current;
    const used = this.data.hintUsed;
    if (!cur.hints || used >= cur.hints.length) return;
    this.setData({ hintText: cur.hints[used], hintUsed: used + 1 });
  },

  /**
   * AI 分层提示：本地提示用完之后的"再给点方向"。
   * 关键约束（写在系统提示里）：AI 只给方向，绝不把答案说出来 ——
   * 一旦它替你想出来，主动回忆就失效了，这张卡就白练了。
   */
  async onAiHint() {
    if (this.data.aiHinting || this.data.showAnswer) return;
    const cur = this.data.current;
    if (!ai.enabled()) { wx.showToast({ title: 'AI 未配置，先用上面的本地提示', icon: 'none' }); return; }
    this.setData({ aiHinting: true });
    const level = this.data.hintUsed === 0 ? 1 : 2;
    const t = await ai.hintFor(cur.stem, cur.content, level);
    this.setData({ aiHinting: false });
    if (!t) { wx.showToast({ title: 'AI 没返回，用本地提示吧', icon: 'none' }); return; }
    this.setData({
      hintText: '🤖 ' + t,
      hintUsed: this.data.hintUsed + 1,
      aiHintUsed: true,
    });
  },

  onReveal() { this.setData({ showAnswer: true }); },

  onFlipJudge(e) {
    if (this.data.submitted) return;
    const remembered = e.currentTarget.dataset.ok === 'true';
    const right = remembered && this.data.hintUsed === 0;
    this.setData({ submitted: true, isRight: right });
    right ? haptic.right() : haptic.wrong();
    this.applyResult(right, 1 + this.data.hintUsed * 0.35);
  },

  onChoose(e) {
    if (this.data.submitted) return;
    const val = e.currentTarget.dataset.val;
    const right = val === this.data.current.answer;
    this.setData({ picked: val, submitted: true, isRight: right });
    right ? haptic.right() : haptic.wrong();
    this.applyResult(right, 1);
  },

  onJudge(e) {
    if (this.data.submitted) return;
    const said = e.currentTarget.dataset.val === 'true';
    const right = said === this.data.current.answer;
    this.setData({ picked: String(said), submitted: true, isRight: right });
    right ? haptic.right() : haptic.wrong();
    this.applyResult(right, 1);
  },

  onBlankInput(e) { this.setData({ blankInput: e.detail.value }); },
  onBlankSubmit() {
    if (this.data.submitted) return;
    const val = (this.data.blankInput || '').trim();
    if (!val) return;
    const right = val.toLowerCase() === String(this.data.current.answer).toLowerCase();
    this.setData({ picked: val, submitted: true, isRight: right });
    right ? haptic.right() : haptic.wrong();
    this.applyResult(right, 1);
  },

  onRecallInput(e) { this.setData({ recallInput: e.detail.value }); },

  /**
   * 默写题判分：
   *   配了云开发 AI → 让模型做**语义**判分（换个说法说对了也算对）
   *   没配 / 调用失败 → 自动降级成本地关键词命中率
   * 两者结果结构一致，展示层不用区分。
   */
  async onRecallSubmit() {
    if (this.data.submitted || this.data.grading) return;
    const cur = this.data.current;
    const text = this.data.recallInput || '';
    if (!text.trim()) return;

    if (!ai.enabled()) {
      this.finishRecall(quizLib.scoreRecall(text, cur.keywords), null);
      return;
    }

    this.setData({ grading: true });
    const r = await ai.gradeRecall(cur.stem, cur.answer, text);
    this.setData({ grading: false });
    if (!r) { this.finishRecall(quizLib.scoreRecall(text, cur.keywords), null); return; }
    this.finishRecall(r.score, r);
  },

  /** 落地判分结果 —— 本地关键词和 AI 语义走同一条路 */
  finishRecall(score, aiResult) {
    const cur = this.data.current;
    const right = score >= 0.6;
    const total = cur.keywords.length;
    const hit = (aiResult && aiResult.hit && aiResult.hit.length)
      ? aiResult.hit.length
      : Math.round(score * total);

    this.setData({
      submitted: true, isRight: right,
      recallHit: hit,
      recallTotal: total,
      aiUsed: !!aiResult,
      aiComment: aiResult ? aiResult.comment : '',
      aiMissed: aiResult && aiResult.missed ? aiResult.missed.join('；') : '',
    });
    right ? haptic.right() : haptic.wrong();
    this.applyResult(right, right ? 1 : 1.5);
  },

  applyResult(right, ratio) {
    const cur = this.data.current;
    if (!cur) return;
    const note = store.getNote(cur.noteId);
    if (!note) return;

    const before = {
      interval: note.interval, dueAt: note.dueAt,
      alpha: note.alpha, beta: note.beta,
      reviewCount: note.reviewCount, lastReviewedAt: note.lastReviewedAt,
    };
    const interval = scheduler.nextInterval(note.interval, right, ratio);
    store.updateNote(cur.noteId, {
      interval,
      dueAt: Date.now() + interval * scheduler.DAY,
      alpha: (note.alpha || 1) + (right ? 1 : 0),
      beta: (note.beta || 1) + (right ? 0 : 1),
      reviewCount: (note.reviewCount || 0) + 1,
      lastReviewedAt: Date.now(),
    });
    store.addLog({ noteId: cur.noteId, right, interval, type: cur.type });

    const undo = this.data.undoStack || [];
    undo.push({ idx: this.data.idx, noteId: cur.noteId, before, right, type: cur.type });

    this.setData({
      undoStack: undo, canUndo: true,
      answered: this.data.answered + 1,
      rightCount: right ? this.data.rightCount + 1 : this.data.rightCount,
      wrongList: right ? this.data.wrongList : this.data.wrongList.concat([cur.noteId]),
    });

    // 答错了 → 让 AI 判断"错在哪、该怎么补"
    // 不阻塞主流程：结果已经落库了，诊断回来了再补上界面
    if (!right && ai.enabled()) this.runDiagnosis(cur);
  },

  /** 把用户这次的作答还原成文本，喂给错因诊断 */
  userAnswerText(cur) {
    if (!cur) return '';
    if (cur.type === 'recall') return this.data.recallInput || '';
    if (cur.type === 'blank') return this.data.blankInput || '';
    if (cur.type === 'choice') return this.data.picked || '';
    if (cur.type === 'judge') return '（判断题：判断错了）';
    if (cur.type === 'flip') return this.data.hintUsed ? '（没想起来，用了提示）' : '（没想起来）';
    return '';
  },

  async runDiagnosis(cur) {
    const mine = this.userAnswerText(cur);
    this.setData({ aiDiagLoading: true, aiDiag: null });
    const r = await ai.diagnoseWrong(cur.stem, cur.content, mine);
    // 用户可能已经翻到下一题了，回来时对一下题号再上屏
    if (this.data.current && this.data.current.noteId !== cur.noteId) return;
    this.setData({ aiDiagLoading: false, aiDiag: r || null });
  },

  onUndo() {
    const stack = this.data.undoStack || [];
    if (!stack.length) { wx.showToast({ title: '没有可撤销的', icon: 'none' }); return; }
    const last = stack[stack.length - 1];
    store.updateNote(last.noteId, last.before);

    const target = this.data.quiz[last.idx];
    this.setData({
      undoStack: stack.slice(0, -1),
      canUndo: stack.length > 1,
      idx: last.idx,
      current: target,
      typeLabel: TYPE_LABEL[target.type] || '',
      submitted: false, isRight: false, showAnswer: false,
      hintUsed: 0, hintText: '', picked: '', blankInput: '',
      recallInput: '', recallHit: 0, recallTotal: 0,
      aiUsed: false, aiComment: '', aiMissed: '', grading: false,
      aiHinting: false, aiHintUsed: false, aiDiag: null, aiDiagLoading: false,
      rightCount: Math.max(0, this.data.rightCount - (last.right ? 1 : 0)),
      wrongList: this.data.wrongList.filter((x) => x !== last.noteId),
      answered: Math.max(0, this.data.answered - 1),
      finished: false,
    });
    wx.showToast({ title: '已撤销上一题', icon: 'none' });
  },

  onNext() {
    const n = this.data.idx + 1;
    if (n >= this.data.quiz.length) {
      store.addQuizResult({
        total: this.data.quiz.length,
        right: this.data.rightCount,
        scopeText: this.scopeText,
      });
      haptic.done();
      this.setData({ finished: true });
      return;
    }
    const q = this.data.quiz[n];
    this.setData({
      idx: n, current: q, typeLabel: TYPE_LABEL[q.type] || '',
      submitted: false, isRight: false, showAnswer: false,
      hintUsed: 0, hintText: '', picked: '', blankInput: '',
      recallInput: '', recallHit: 0, recallTotal: 0,
      aiUsed: false, aiComment: '', aiMissed: '', grading: false,
      aiHinting: false, aiHintUsed: false, aiDiag: null, aiDiagLoading: false,
    });
  },

  onRetryWrong() {
    const ids = this.data.wrongList;
    if (!ids.length) return;
    const all = store.listNotes();
    const pool = ids.map((id) => all.filter((n) => n.id === id)[0]).filter(Boolean);
    if (!pool.length) return;
    // 错题重练固定用两种简单题型
    const quiz = pool.map((n) => quizLib.buildQuestion(Math.random() < 0.5 ? 'flip' : 'choice', n, all))
                     .filter(Boolean);
    const first = quiz[0];
    this.setData({
      quiz, idx: 0, current: first, typeLabel: TYPE_LABEL[first.type] || '',
      submitted: false, isRight: false, rightCount: 0,
      finished: false, wrongList: [], isRetry: true, undoStack: [], canUndo: false,
      answered: 0, showAnswer: false, hintUsed: 0, hintText: '', picked: '',
      blankInput: '', recallInput: '', recallHit: 0, recallTotal: 0,
      aiUsed: false, aiComment: '', aiMissed: '', grading: false,
      aiHinting: false, aiHintUsed: false, aiDiag: null, aiDiagLoading: false,
    });
  },

  onBackHome() { wx.switchTab({ url: '/pages/index/index' }); },
  onBackPractice() { wx.switchTab({ url: '/pages/practice/practice' }); },


  /* ==================== 首次进页引导 ==================== */
  // ⚠️ 标记要在**一开始**就写：只写在「走完/跳过」里，用户没走完就会每次重放
  maybeTour() {
    if (wx.getStorageSync('sc_tour_done_quiz')) return;
    wx.setStorageSync('sc_tour_done_quiz', 1);
    this.setData({ tourActive: true });
  },

  notifyCoach(action) {
    const c = this.selectComponent('#coach');
    if (c) c.notify(action);
  },

  onTourLock(e) { this.setData({ pageStyle: e.detail.locked ? 'overflow: hidden;' : '' }); },

  onPageScroll() {
    if (!this.data.tourActive) return;
    const c = this.selectComponent('#coach');
    if (c) c.relocate();
  },

  onTourClose() {
    wx.setStorageSync('sc_tour_done_quiz', 1);
    this.setData({ tourActive: false, pageStyle: '' });
  },

  onRestartTour() {
    this.setData({ tourActive: false });
    setTimeout(() => this.setData({ tourActive: true, tourFlow: 'quiz' }), 30);
  },

});
