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
        desc: '点这个蓝色的「＋」，把讲义粘进来，会自动切成知识点卡片。',
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
        desc: '卡片数、待复习、连续天数、累计复习次数。',
      },
      {
        target: '#heat-card',
        title: '学习热力图',
        desc: '最近 8 周每天的复习量。格子越蓝说明那天练得越多。',
      },
      {
        target: '#hard-card',
        title: '最需要补的 5 张',
        desc: '按错误率排出来的薄弱点，点进去就能重点攻。',
      },
      {
        target: '#backup-card',
        title: '数据备份',
        desc: '数据存在本机。换手机前先导出一份，可以发到「文件传输助手」保存。',
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
