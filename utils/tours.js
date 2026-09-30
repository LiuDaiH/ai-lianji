// utils/tours.js —— 引导流程配置（模块化）
//
// 步骤字段：
//   target    要高亮的元素选择器（页面级 id）
//   title     标题
//   desc      说明
//   action    可选。设了表示「必须用户真的点那个控件才继续」；
//             页面在对应事件处理函数里调 coach.notify('action') 推进。
//             没设则显示「下一步」按钮。

const TOURS = {
  index: {
    name: '卡片页怎么用',
    page: 'index',
    icon: '📇',
    steps: [
      {
        target: '#cat-bar',
        title: '类别范围',
        desc: '卡片能按类别分模块。这里显示当前范围，点它可以切换或管理类别（支持树形层级）。',
      },
      {
        target: '#alert-bar',
        title: '今日待复习',
        desc: '一打开就告诉你今天该复习多少张。直接点这条蓝色横幅就能开始。',
        action: 'goReview',
      },
      {
        target: '#brief-card',
        title: '掌握度概览',
        desc: '灰＝没学过，蓝＝学习中，绿＝已掌握。右边数字是连续学习天数。',
      },
      {
        target: '#fab',
        title: '录入入口',
        desc: '点「＋」有两个选择：粘贴讲义切卡，或者从 Obsidian 导入笔记（.md / zip）。',
        action: 'goCapture',
      },
      {
        target: '#search-box',
        title: '搜索',
        desc: '卡片多了可以搜标题或内容。',
      },
    ],
  },

  capture: {
    name: '怎么录入知识点',
    page: 'capture',
    icon: '✍️',
    steps: [
      {
        target: '#raw',
        title: '粘贴区',
        desc: '把讲义文字粘到这里。打开这个页面时会自动检测剪贴板，有内容会问你要不要导入。',
      },
      {
        target: '#preview-card',
        title: '切分预览',
        desc: '这里会实时显示"切出几张、每张长什么样"。切法不对就换上面的「解析方式」。',
      },
      {
        target: '#cat-pick',
        title: '放进哪个类别',
        desc: '选一个类别（可以选任意层级）。没有想要的类别就去「统计 → 操作引导」旁边先建一个。',
      },
      {
        target: '#split',
        title: '自动切分',
        desc: '粘好之后点这个按钮，系统按空行和编号把长文本切成多张卡片。',
        action: 'split',
      },
      {
        target: '#save',
        title: '确认保存',
        desc: '切完可以逐张改、删、并入上一张。确认无误后点这里保存。',
        action: 'save',
      },
    ],
  },

  review: {
    name: '怎么复习',
    page: 'review',
    icon: '🔁',
    steps: [
      {
        target: '#cat-bar',
        title: '复习范围',
        desc: '可以只复习某个类别（自动含它的子类别）。',
      },
      {
        target: '#preset-card',
        title: '今天练多久',
        desc: '选「10 分钟」就只挑 5 张最该练的 —— 不是到期就全推给你。',
      },
      {
        target: '#forecast-card',
        title: '接下来几天的量',
        desc: '提前知道明天、后天各有多少张，好安排时间。',
      },
      {
        target: '#start',
        title: '开始小测',
        desc: '点这里开始。5 种题型会按你的熟练度自动换。',
        action: 'start',
      },
    ],
  },

  stats: {
    name: '数据与统计',
    page: 'stats',
    icon: '📊',
    steps: [
      {
        target: '#cat-bar',
        title: '统计范围',
        desc: '所有统计都按这个范围算 —— 可以只看某个类别，会自动含它的子类别。',
      },
      {
        target: '#kpi-card',
        title: '四个关键数字',
        desc: '连续天数是大字，右边是最长连续 / 累计次数 / 正确率；下面那条彩带是掌握度分布。',
      },
      {
        target: '#cal-card',
        title: '学习热力图',
        desc: '可以切「近 12 周 / 整年」，还能选年份；点任意一格看那天练了几次、对几道、练了哪几张卡。',
      },
      {
        target: '#hard-card',
        title: '最需要补的 5 张',
        desc: '按错误率排出来的薄弱点，点进去就能重点攻。',
      },
      {
        target: '#settings-card',
        title: '数据备份',
        desc: '这里能改「介绍弹窗」的显示模式，也能导出备份（导入是追加，不会覆盖）。',
      },
    ],
  },
  practice: {
    name: '怎么开始一轮小测',
    page: 'practice',
    icon: '📝',
    steps: [
      {
        target: '#pcat',
        title: '先圈范围',
        desc: '可以只练某个类别（含它的所有子类）。不改就是全部卡片。',
      },
      {
        target: '#mode-card',
        title: '再选题型',
        desc: '5 种题型可以任意组合。灰掉的是当前范围的卡片暂时出不了的题。',
      },
      {
        target: '#psize',
        title: '定个题量',
        desc: '按剩下的时间选 5 / 10 / 20 题。答完会自动排下次复习时间。',
      },
      {
        target: '#pstart',
        title: '开始',
        desc: '点这里进入答题。答完会告诉你这轮的正确率。',
      },
    ],
  },

  obsidian: {
    name: 'Obsidian 怎么双向同步',
    page: 'obsidian',
    icon: '🔗',
    steps: [
      {
        target: '#obbanner',
        title: '核心创新点 ②',
        desc: '别的软件把你锁在它自己的数据库里。这个不锁 —— 笔记还在你原来的 vault 里。',
      },
      {
        target: '#obtabs',
        title: '进和出是两个方向',
        desc: '「导入」是把 .md / vault.zip 变成卡片；「回写掌握度」是把练完的结果写回笔记。',
      },
      {
        target: '#obsync',
        title: '同步状态一眼看',
        desc: '这里显示导入了几个文件、多少张卡记得出处、有多少个标题可以回写。',
      },
      {
        target: '#obgraph',
        title: '关联也一起建好了',
        desc: '笔记里的 [[双向链接]] 会变成卡片之间的关联 —— 打开任意卡片能看到「关联卡片」，或者从这里直接进知识图谱看全貌。',
      },
    ],
  },

  categories: {
    name: '类别怎么管',
    page: 'categories',
    icon: '🌳',
    steps: [
      {
        target: '#cattabs',
        title: '三种看法',
        desc: '发散图看结构、树图看层级、列表做精确操作。选类别时也能用发散图直接点。',
      },
      {
        target: '#catgraph',
        title: '节点颜色就是掌握度',
        desc: '绿＝已掌握、蓝＝学习中、橙＝薄弱、灰＝未学。点节点展开，长按出菜单。',
      },
      {
        target: '#catcreate',
        title: '两种建树方式',
        desc: '「大纲快速建树」粘一份大纲一次成型；「单个新建」可以勾「连续新建」留着弹窗接着敲。',
      },
    ],
  },
  detail: {
    name: '卡片详情怎么看',
    page: 'detail',
    icon: '🔍',
    steps: [
      {
        target: '#dtrack',
        title: '掌握轨迹',
        desc: '每次复习后，系统会重新安排间隔。条越长说明记忆越牢 —— 不是固定的遗忘曲线，而是按你的表现自己伸缩。',
      },
      {
        target: '#dwhy',
        title: '为什么现在复习它',
        desc: '展开看得到算法把优先级拆成三项（逾期 / 不熟 / 易错），还标了各自权重 —— 为什么它排前面，不用猜。',
      },
      {
        target: '#dlink',
        title: '关联卡片（这就是「链」）',
        desc: '笔记里写的 [[链接]] 会变成这里的关系；正文里提到但没加链接的，会提供「建立关联」一键连上。右上角还能进知识图谱看全貌。',
      },
      {
        target: '#dedit',
        title: '随时改',
        desc: '标题和内容都能改。用「【】」或「**」把关键词标出来，填空题会优先挖这些词。',
      },
    ],
  },
  quiz: {
    name: '小测怎么答',
    page: 'quiz',
    icon: '✅',
    steps: [
      {
        target: '#qbar',
        title: '题型与进度',
        desc: '这里显示当前是哪种题型（回忆 / 选择 / 判断 / 填空 / 默写）和答到第几题。答错了点右上角「撤销」可以退回重答。',
      },
      {
        target: '#qcard',
        title: '先自己想，再翻面',
        desc: '默认是「回忆」题：先在心里过一遍，再点「看答案」核对。直接翻面就白练了——回忆这一步才是关键。',
      },
      {
        target: '#qops',
        title: '卡住了有两级提示',
        desc: '「本地提示」给关键线索；开了 AI 的话还能让 AI 给个方向 —— 它只给方向、不说答案，想起来这件事必须你自己做。',
      },
      {
        target: '#qcard',
        title: '答完会自动排期',
        desc: '答对的卡片间隔会拉长，答错的提前安排复习 —— 不用你自己安排。结束后还能一键重练错题。',
      },
    ],
  },
  graph: {
    name: '知识图谱怎么看',
    page: 'graph',
    icon: '🌐',
    steps: [
      {
        target: '#gcv',
        title: '这是一张知识网络',
        desc: '大深色圆是一个类别（卡片越多它越大）；小圆点是卡片，颜色就是掌握度：绿已掌握、蓝学习中、橙薄弱、灰未学；蓝实线连着的两张卡，是笔记里互相 [[链接]] 过的。',
      },
      {
        target: '#gtools',
        title: '四个按钮',
        desc: '「只看关联」藏起孤立卡片；「重排」重新算一遍位置；「适配」缩放回整张图；「◎ 聚焦」只看你选中的那个类别。',
      },
      {
        target: '#gzoom',
        title: '卡片挤在一起就放大',
        desc: '两根手指捏合，或点这两个按钮。**缩放不同，显示的粒度也不同**：55% 以下把大类别收成带数字的圈；55%~105% 看到卡片点；105% 以上才写标题；175% 以上连掌握度百分比都给你。',
      },
      {
        target: '#gcv',
        title: '怎么点',
        desc: '点类别大圆 → 下面列出这个类别下所有卡片（点其中一条直接进那张卡）；点卡片 → 直接打开这张卡；双击类别 → 只看这一块，别的变淡。',
      },
    ],
  },
};

function menu() {
  return Object.keys(TOURS).map((k) => ({
    key: k,
    name: TOURS[k].name,
    icon: TOURS[k].icon,
    page: TOURS[k].page,
    count: TOURS[k].steps.length,
  }));
}

function get(flow) {
  return TOURS[flow] || null;
}

module.exports = { TOURS, menu, get };
