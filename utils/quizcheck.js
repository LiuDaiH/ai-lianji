// utils/quizcheck.js —— 出题能力自检
//
// 解决的问题：用户不知道"内容写成什么样，题才出得好"，
// 所以也不知道该怎么切分 / 怎么补内容。
// 这里把出题规则反过来告诉用户：这张卡能出哪几种题、差什么、怎么改。

const quizLib = require('./quiz.js');

const MODE_NAME = { flip: '翻转卡片', choice: '选择题', judge: '判断题',
                    blank: '填空题', recall: '默写题' };

const MIN_CONTENT = 8;    // 内容短于这个长度，挖词和默写都不靠谱
const GOOD_TERMS = 2;     // 至少这么多个"术语"才算能稳定出填空题

/**
 * 诊断一张卡片的出题能力
 * @param {string} title
 * @param {string} content
 * @param {number} totalCards 当前总卡片数（选择题需要至少 3 张）
 * @returns {{ modes: string[], modeNames: string[], level: string,
 *             levelText: string, tips: string[], termCount: number,
 *             contentLen: number, keyCount: number }}
 */
function diagnose(title, content, totalCards) {
  const t = String(title || '').trim();
  const c = String(content || '').trim();
  const total = typeof totalCards === 'number' ? totalCards : 99;

  const modes = [];
  const tips = [];

  const hasContent = !!c;
  const sameAsTitle = hasContent && c === t;
  const terms = hasContent ? quizLib.findTerms(c) : [];
  const keys = hasContent ? quizLib.extractKeywords(c) : [];
  const termCount = terms.length;
  const keyCount = keys.length;

  // ---- 逐题型判断可用性（与 quiz.js 的实际出题逻辑保持一致）----
  // 翻转卡片：有标题就能出；但内容为空时翻面没东西看
  modes.push('flip');
  // 选择题：需要至少 3 张卡才有干扰项（无内容时用标题当题面，也退化得厉害）
  if (total >= 3) modes.push('choice');
  // 判断题：需要内容非空
  if (hasContent) modes.push('judge');
  // 填空题：需要在内容里找得到"术语"
  if (hasContent && termCount >= 1) modes.push('blank');
  // 默写题：需要有 2 个以上关键词
  if (hasContent && keyCount >= 2) modes.push('recall');

  // ---- 给改进建议 ----
  if (!hasContent) {
    tips.push('补一句解释 —— 有了内容，判断题/填空题/默写题才能用');
  } else if (sameAsTitle) {
    tips.push('标题和内容完全一样，判断题和默写题会"送分" —— 建议在内容里补上解释');
  }

  if (hasContent && c.length < MIN_CONTENT) {
    tips.push('内容只有 ' + c.length + ' 个字，偏短 —— 填空题可能挖不到合适的词，建议写到 '
            + MIN_CONTENT + ' 字以上');
  }

  if (hasContent && termCount < GOOD_TERMS) {
    tips.push('内容里可挖的关键词偏少 —— 用【】或 ** 把术语标出来，填空题会优先挖这些词');
  }

  if (total < 3) {
    tips.push('选择题需要至少 3 张卡片才有干扰项，再多录几张就能用');
  }

  // ---- 总体评价 ----
  let level = 'good';
  let levelText = '';
  if (!hasContent || sameAsTitle || modes.length <= 2) {
    level = 'poor';
    levelText = '只能出 ' + modes.length + ' 种题，建议按下面提示改一改';
  } else if (modes.length >= 4) {
    // 能出 4 种以上就算好（提示只是"还能更好"）
    level = 'good';
    levelText = modes.length === 5 ? '能出全部 5 种题' : ('能出 ' + modes.length + ' 种题');
  } else {
    level = 'ok';
    levelText = '能出 ' + modes.length + ' 种题';
  }

  return {
    modes, modeNames: modes.map((m) => MODE_NAME[m] || m),
    level, levelText, tips, termCount, keyCount,
    contentLen: c.length, sameAsTitle,
  };
}

/** 给整套卡片做一个汇总（录入页用） */
function summary(cards) {
  const total = cards.length;
  const details = cards.map((c) => diagnose(c.title, c.content, total));
  const weak = details.filter((d) => d.level !== 'good').length;
  // 整套卡片里，能被用上的题型 = 所有卡片题型并集
  const union = {};
  details.forEach((d) => d.modes.forEach((m) => { union[m] = true; }));
  return {
    total,
    weak,
    modeNames: Object.keys(MODE_NAME).filter((m) => union[m]).map((m) => MODE_NAME[m]),
    details,
  };
}

module.exports = { diagnose, summary, MODE_NAME };
