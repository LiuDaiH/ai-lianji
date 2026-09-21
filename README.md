# AI 链记

把讲义和笔记变成会考你的卡片，练完把掌握度写回你自己的 Markdown 文件。

微信小程序。2026 微信小程序开发大赛参赛作品，命题「与 AI 共生」。

---

## 获取方式

小程序已在微信平台提交审核，上线后：

- 在微信里搜索小程序名称 **AI 链记** 即可打开
- 或扫描下方小程序码

```
（小程序码：上线后补在此处）
```

当前提交审核的版本不含 AI 能力（原因见下文「关于 AI 能力」一节）。

---

## 这是什么

一个学习工具。把讲义或笔记切成一张张知识点卡片，到该复习的时候用五种方式考你，
练完再把每个知识点的掌握度写回你自己的 `.md` 文件。

和常见的背卡工具不同，它不把你锁进自己的数据库：

```
你的 Markdown 笔记  ──导入──▶  按文件夹与标题层级建成类别树
                                      │
                                      ▼
                               五种题型轮换复习
                               间隔随表现自适应伸缩
                                      │
       ◀──────── 掌握度 ──────────────┘
       写回原笔记文件
```

数据全程留在本机。没有账号体系，不上传服务器，可随时导出备份。

---

## 主要功能

### 录入

提供七种文本解析方式：一行一张、标题加内容、空行分段、按句子拆、竖线分隔、自定义分隔符、智能识别。
其中「智能识别」会读取文本结构，自动挑最合适的一种。

支持从 Obsidian 导入：单个 `.md` 文件，或整个 vault 打包成的 `.zip`，
按文件夹与标题层级还原成类别树。

打开录入页会自动检测剪贴板；从 PPT 或文档复制完讲义，一进来就会询问是否导入。
切分结果可编辑（修改、删除、并入上一张），确认后才保存。
每张卡片附带「出题能力诊断」，说明它当前能出哪些题型、还缺什么。

### 复习

今日清单按复习收益排序，而不是简单地到期的全部推送。排序依据三项加权：

- 时效度 0.5
- 不确定度 0.3
- 历史错误率 0.2

其中「不确定度」借鉴多臂老虎机（multi-armed bandit）的思路：复习次数越少的卡片越不确定，
越值得优先试探。这样冷门卡片不会被热门卡片长期压在队尾。

复习间隔按实际表现伸缩：答对且干脆则乘 2，答对但犹豫乘 1.2，答错乘 0.5。
时间零碎时可以选「只练 10 分钟」档位。

### 五种题型

题型按卡片熟练度自动切换：

- 翻转卡片：新卡或反复答错的卡，可分两层要提示
- 选择题：复习一至两次时使用，干扰项从你自己的其他卡片里抽取
- 判断题：复习一至两次时使用，有五成概率把内容替换掉
- 填空题：复习三次以上，挖去术语
- 默写题：复习三次以上，自己完整写出来

### 类别管理

支持树形层级与子树聚合（选中父类自动包含所有子类）。
提供四种视图：发散图、横向树图、列表、大纲。

可以粘贴一份大纲一次性建出整棵类别树，同名节点自动复用。
发散图既是展示也是选择器，点击节点即可圈定练习范围。

### 统计

掌握度堆叠（未学、学习中、已掌握）、学习热力图、最需要补的五张卡片、
连续学习天数、未来到期预测。

热力图带星期与月份刻度、今天标记，点击任意一格可以看到那一天的复习次数。

### Obsidian 双向同步

写回采用幂等设计：在每个标题下方插入一条高亮块，重复导出不会产生重复标记。
标题匹配做了归一化处理，`1.2 过拟合` 与 `过拟合` 能命中同一份数据，
手动改过编号也不会整篇失配。另支持导出汇总报告。

---

## 关于 AI 能力

AI 能力的完整实现位于 `ai-backup/` 目录，但**默认不启用**。

### 五个能力

| 能力 | 位置 | 作用 |
|---|---|---|
| 智能切卡 | 录入页 | 读懂格式混乱的讲义，切成独立可考的卡片 |
| 语义判分 | 默写题 | 判断语义是否等价，换个说法说对了也算对 |
| 分层提示 | 回忆题 | 卡住时给方向，但不把答案说出来 |
| 错因诊断 | 答错后 | 把「答错了」细分成六类错因，并给出补法 |
| 学习诊断 | 统计页 | 把统计数据翻译成「现在该练什么」 |

### 设计原则：划定 AI 的边界

产品的核心不是让 AI 做更多事，而是明确它不该做什么：

> AI 只负责整理和批改，答题必须由人自己完成。

理由很直接。一旦让 AI 生成卡片内容，或者让 AI 直接给出答案，
用户就变成「AI 生成的内容再喂给 AI 判断」，中间那个真正产生记忆的环节、
也就是自己努力回忆的过程，就消失了。那是被 AI 替代，不是与 AI 共生。

### 全链路降级

五个能力各有独立的降级路径。任何一步失败（未配置、超时、返回格式不对）
都返回空值，调用方自动退回本地算法：

```
AI 可用    → 五个能力全开
AI 不可用  → 本地七种规则切分 + 关键词命中率判分，功能不减少
```

这套降级链路从产品第一版就在设计里。结果是 AI 成为可选增强层而非地基，
产品在任何 AI 可用性条件下都能完整运行。

### 为什么默认关闭

微信规定，小程序面向用户提供生成式 AI 服务，须补充「深度合成 - AI 问答」服务类目，
而该类目仅向企业、个体工商户等非个人主体开放。本项目为个人主体，因此无法在正式版启用。

代码完整保留在 `ai-backup/`，取得类目后一条命令即可启用：

```bash
python tools/toggle-ai.py on       # 切到 AI 版
python tools/toggle-ai.py off      # 切回提交审核版
python tools/toggle-ai.py status   # 查看当前状态
```

细节见 [ai-backup/README.md](ai-backup/README.md)。

---

## 技术栈

- 微信原生小程序（WXML / WXSS / JavaScript），无第三方依赖，无 npm 包
- 零后端：数据存于 `wx.setStorageSync`，无账号体系
- AI 为可选层：使用微信云开发 AI+（`wx.cloud.extend.AI`），密钥由平台托管，不下发前端
- 主包体积约 0.75 MB（上限 2 MB）

### 几处值得一提的实现

**自适应调度**
不是固定的遗忘曲线。用 Beta 分布在线估计每张卡的记住概率，间隔按实际表现伸缩。

**AI 逐层诊断**
测试连通性时会逐层报告问题出在哪一层（`wx.cloud`、`wx.cloud.extend`、
`wx.cloud.extend.AI`、模型调用），而不是笼统地报「调用失败」。
这里踩过一个坑：`wx.cloud.extend.AI` 是 `wx.cloud.init()` 成功之后才挂载的，
如果一开始就检查它是否存在，会形成死锁（永远不 init，于是永远不存在）。

**模型输出容错**
模型常把 JSON 裹在代码块里或前后多说两句。解析时扫描首个方括号或花括号再做括号配对，
并兼容多种字段别名（含中文键名）。

**幂等标注**
回写前先移除紧跟标题的旧标记，反复导出不产生垃圾。

**发散图布局**
小程序 WXML 不支持内联 SVG，因此自己实现了 tidy tree 与径向布局。
径向布局的每环半径按最拥挤处的角间隔反推，保证同环节点不重叠。

**主题系统**
全局抽一套 CSS 自定义属性，每个页面只覆盖八个变量。
掌握度这类语义色保持全局固定，不随板块变化。

**换行符防御**
微信开发者工具对 CRLF 敏感，混用会导致「找不到模块」的编译错误。
仓库用 `.gitattributes` 强制 LF。

---

## 项目结构

```
app.js / app.json / app.wxss
pages/                  十个页面
  index/        卡片列表、今日目标、搜索
  capture/      录入：解析方式、实时预览、出题诊断
  review/       复习队列：收益排序、时长档位
  practice/     小测设置：范围、题型、题量
  quiz/         答题：五种题型、撤销、错题重练
  stats/        统计：掌握度、热力图、难点榜
  categories/   类别树：四视图、批量建树
  obsidian/     Obsidian 导入与回写
  detail/       卡片详情
  help/         关于与引导入口
components/
  cat-picker/   发散图类别选择器
  coach/        新手引导
  intro/        产品介绍
utils/
  splitter.js   七种文本切卡
  scheduler.js  自适应间隔与收益排序
  quiz.js       五种题型生成
  stats.js      掌握度、热力图、预测
  category.js   类别树
  tree.js       tidy tree 与径向布局
  obsidian.js   Markdown 解析、幂等标注
  store.js      本地存储与导出导入
  haptic.js     触感反馈
  ai.js         AI 层（提交版为空壳，真实实现在 ai-backup/）
ai-backup/        AI 完整实现与恢复说明（不参与小程序打包）
tools/            开发脚本（不参与小程序打包）
```

---

## 本地运行

1. 用微信开发者工具打开本目录
2. 把 `project.config.json` 里的 `appid` 换成你自己的
3. 基础库选择 3.15.1 及以上
4. 编译

不需要任何后端，也不需要配置环境变量。

如需启用 AI 能力（需自备云开发环境并取得相应类目）：

```bash
python tools/toggle-ai.py on
```

然后按 [ai-backup/README.md](ai-backup/README.md) 填写环境 ID。

---

## 开发脚本

`tools/` 下的脚本供本项目自用，均已排除在小程序包外：

| 脚本 | 用途 |
|---|---|
| `preflight.py` | 上传前体检：文件完整性、事件绑定、资源路径、跳转方式、模板变量、换行符、包体积 |
| `toggle-ai.py` | 在 AI 版与提交审核版之间切换 |
| `smoke-load.js` | 模拟运行环境加载全部模块，捕获加载期错误 |
| `smoke-ai.js` | AI 全链路降级的回归测试 |
| `t-hidden.js` | 验证提交审核版的 AI 元素已被隐藏 |
| `t-ai-text.js` | 审计用户可见文字中是否出现不该有的 AI 表述 |
| `make_logo.py` | 生成图标（多方案、多尺寸、圆形裁切预览） |
| `md2pdf.py` | 中文 Markdown 转 PDF |

---

## 开源说明

本项目以 MIT 许可证开源。欢迎阅读、学习、提 Issue 与 Pull Request。

几点说明：

**数据归属**
你的笔记始终是磁盘上的 `.md` 文件，本项目不建立自己的笔记库。
这条原则贯穿整个设计，也是掌握度回写功能存在的原因。

**代码可复用的部分**
`utils/` 下的模块大多与具体产品无关，可以独立拿走：

- `splitter.js`：七种中文文本切分规则，适用于任何需要把段落结构化的场景
- `scheduler.js`：带不确定度权重的间隔重复调度
- `tree.js`：小程序环境下的 tidy tree 与径向布局计算
- `obsidian.js`：Markdown 标题树解析与幂等原地标注
- `tools/` 下的脚本：尤其是 `preflight.py`（小程序上传前体检）与 `md2pdf.py`（中文 PDF 生成）

**关于 AI 部分的取舍**
`ai-backup/` 保留的是完整可用的实现，不是占位代码。
之所以默认关闭，是平台类目限制所致，与代码质量无关。
如果你要给自己的小程序接 AI，`utils/ai.js` 里的降级设计与逐层诊断可以直接参考。

**贡献**
提 Issue 时如果能附上复现步骤和基础库版本会很有帮助。
修改代码前建议先跑一遍 `python tools/preflight.py`。

---

## 许可

MIT License

---

## 参赛信息

- 赛事：2026 微信小程序开发大赛（WAIC Future Tech 与微信小程序团队联合主办）
- 命题：与 AI 共生
- 形式：单人参赛

---

---

# AI Lianji

Turn your lecture notes into flashcards that actually quiz you, then write the mastery
level back into your own Markdown files.

A WeChat Mini Program. Entry for the 2026 WeChat Mini Program Development Competition,
theme "Coexisting with AI".

---

## How to Use

The Mini Program is under review. Once published:

- Search **AI 链记** inside WeChat, or
- Scan the Mini Program code below

```
(QR code to be added after release)
```

The version currently submitted for review does not include AI capabilities
(see the "About AI Capabilities" section below).

---

## What It Is

A study tool. It splits lecture notes or documents into individual knowledge cards,
quizzes you on them in five different ways when they come due, and then writes the
mastery level of each topic back into your own `.md` files.

Unlike most flashcard apps, it does not lock your data inside its own database:

```
Your Markdown notes  ──import──▶  Category tree built from folders and heading levels
                                        │
                                        ▼
                                  Five question types, rotating
                                  Intervals adapt to your performance
                                        │
        ◀──────── mastery ─────────────┘
        Written back into the original files
```

All data stays on your device. No account system, no server uploads, exportable at any time.

---

## Features

### Input

Seven text-splitting strategies: one card per line, title plus body, blank-line separated,
split by sentence, pipe-separated, custom delimiters, and automatic detection.
The automatic mode reads the structure of your text and picks the most suitable strategy.

Obsidian import supports a single `.md` file or an entire vault packed as `.zip`,
reconstructing the category tree from folder and heading hierarchy.

The input page checks your clipboard automatically — copy a lecture from slides or a document
and it will ask whether to import it.

Split results are editable (edit, delete, merge into the previous card) before saving.
Each card carries a diagnostic showing which question types it can currently produce.

### Review

Today's queue is ordered by expected review value rather than pushing everything that is due.
Three weighted factors:

- Recency 0.5
- Uncertainty 0.3
- Historical error rate 0.2

The uncertainty term borrows from multi-armed bandit scheduling: cards reviewed fewer times
are more uncertain and therefore worth exploring first. This prevents neglected cards from
being permanently buried behind frequently reviewed ones.

Intervals scale with performance: a clean correct answer doubles the interval,
a hesitant correct answer multiplies by 1.2, a wrong answer by 0.5.
A "10 minutes only" mode is available for fragmented time.

### Five Question Types

Question type adapts to how well you know a card:

- Flip card: new or repeatedly failed cards, with optional two-level hints
- Multiple choice: used at one or two reviews, distractors drawn from your own other cards
- True or false: used at one or two reviews, with a 50% chance of swapping the content
- Fill in the blank: at three or more reviews, key terms removed
- Free recall: at three or more reviews, writing the whole thing out

### Categories

Supports hierarchical trees with subtree aggregation (selecting a parent implicitly includes
all children). Four views are available: radial graph, horizontal tree, list, and outline.

An outline can be pasted to build an entire category tree at once, with duplicate names reused
automatically. The radial graph doubles as a picker — tap a node to scope your practice range.

### Statistics

Mastery breakdown (unseen, learning, mastered), a study heatmap, the five cards that most need
attention, current streak, and upcoming due-load forecast.

The heatmap includes weekday and month rulers, a today marker, and per-day readouts on tap.

### Obsidian Round-Trip Sync

Write-back is idempotent: a highlight block is inserted under each heading, and repeated exports
never produce duplicate markers. Heading matching is normalized, so `1.2 Overfitting` and
`Overfitting` resolve to the same record — editing a heading number will not break the whole file.

A summary report export is also available.

---

## About AI Capabilities

The full AI implementation lives in `ai-backup/` but is **disabled by default**.

### Five Capabilities

| Capability | Where | What it does |
|---|---|---|
| Smart card splitting | Input page | Reads messy lecture text and splits it into self-contained cards |
| Semantic grading | Free recall | Judges whether meaning matches — a correct paraphrase still counts |
| Layered hints | Flip cards | Gives direction when stuck, without revealing the answer |
| Error diagnosis | After a wrong answer | Classifies the mistake into one of six causes and suggests a fix |
| Study advice | Statistics page | Translates your data into "what to do now" |

### Design Principle: Drawing the Boundary of AI

The point of this product is not to make AI do more, but to be explicit about what it should
not do:

> AI handles organizing and grading. Answering must be done by the person.

The reasoning is straightforward. If AI generates the card content, or simply gives the answer,
the user ends up feeding AI-generated material back into AI. The step that actually builds
memory — the effort of recalling something yourself — disappears. That is being replaced by AI,
not coexisting with it.

### Full-Chain Fallback

Each of the five capabilities has its own fallback path. Any failure (not configured, timeout,
malformed output) returns null and the caller falls back to the local algorithm:

```
AI available    → all five capabilities active
AI unavailable  → local seven-strategy splitting + keyword-hit-rate grading, no features lost
```

This fallback chain has been part of the design since the first version. The result is that AI
is an optional enhancement layer rather than a foundation, and the product works completely
under any AI availability condition.

### Why It Is Disabled by Default

WeChat requires Mini Programs that offer generative AI services to users to declare the
"Deep Synthesis — AI Q&A" service category. That category is only open to non-individual
entities such as companies and sole proprietorships. This project is an individual entry,
so AI cannot be enabled in the published version.

The code is fully preserved in `ai-backup/` and can be enabled with one command once the
category is obtained:

```bash
python tools/toggle-ai.py on       # switch to AI build
python tools/toggle-ai.py off      # switch back to the review build
python tools/toggle-ai.py status   # show current state
```

See [ai-backup/README.md](ai-backup/README.md) for details.

---

## Technical Stack

- Native WeChat Mini Program (WXML / WXSS / JavaScript), no third-party dependencies, no npm packages
- Zero backend: data stored via `wx.setStorageSync`, no account system
- AI as an optional layer: WeChat CloudBase AI+ (`wx.cloud.extend.AI`), keys hosted by the platform
  and never shipped to the client
- Main package size approximately 0.75 MB (limit 2 MB)

### Implementation Notes Worth Mentioning

**Adaptive scheduling**
Not a fixed forgetting curve. A Beta distribution is used to estimate each card's recall
probability online, and intervals scale with actual performance.

**Layered AI diagnostics**
The connectivity test reports which layer failed (`wx.cloud`, `wx.cloud.extend`,
`wx.cloud.extend.AI`, or the model call) instead of a generic "call failed".
This came from a real pitfall: `wx.cloud.extend.AI` is only attached after
`wx.cloud.init()` succeeds. Checking for its existence first creates a deadlock —
init never runs, so the property never appears.

**Model output tolerance**
Models often wrap JSON in code fences or add commentary. The parser scans for the first
bracket and performs brace matching, and accepts several field-name aliases including
Chinese keys.

**Idempotent annotation**
Existing markers are removed before inserting new ones, so repeated exports produce no clutter.

**Radial graph layout**
WXML does not support inline SVG, so tidy tree and radial layouts are computed manually.
The radius of each ring is derived from the tightest angular gap on that ring, which keeps
same-ring nodes from overlapping.

**Theming**
A single set of CSS custom properties with eight overridden variables per page.
Semantic colors such as mastery levels stay globally fixed.

**Line-ending defense**
The WeChat DevTools are sensitive to CRLF; mixed endings cause "module not found" build errors.
The repository enforces LF via `.gitattributes`.

---

## Project Structure

```
app.js / app.json / app.wxss
pages/                  ten pages
  index/        card list, daily goal, search
  capture/      input: splitting strategies, live preview, diagnostics
  review/       review queue: value ordering, session length
  practice/     quiz setup: scope, question types, count
  quiz/         answering: five types, undo, retry wrong cards
  stats/        statistics: mastery, heatmap, hardest cards
  categories/   category tree: four views, bulk creation
  obsidian/     Obsidian import and write-back
  detail/       card detail
  help/         about and onboarding
components/
  cat-picker/   radial category picker
  coach/        onboarding walkthrough
  intro/        product introduction
utils/
  splitter.js   seven text-splitting strategies
  scheduler.js  adaptive intervals and value ordering
  quiz.js       five question type generators
  stats.js      mastery, heatmap, forecast
  category.js   category tree
  tree.js       tidy tree and radial layout
  obsidian.js   Markdown parsing, idempotent annotation
  store.js      local storage, export and import
  haptic.js     haptic feedback
  ai.js         AI layer (stub in the review build; real implementation in ai-backup/)
ai-backup/      full AI implementation and restore notes (not packaged)
tools/          development scripts (not packaged)
```

---

## Running Locally

1. Open this directory with the WeChat DevTools
2. Replace `appid` in `project.config.json` with your own
3. Select base library 3.15.1 or above
4. Build

No backend is required and no environment variables need to be configured.

To enable AI capabilities (requires your own CloudBase environment and the relevant category):

```bash
python tools/toggle-ai.py on
```

Then follow [ai-backup/README.md](ai-backup/README.md) to supply an environment ID.

---

## Development Scripts

The scripts under `tools/` are for this project's own use and are excluded from the Mini Program
package:

| Script | Purpose |
|---|---|
| `preflight.py` | Pre-upload audit: file completeness, event bindings, asset paths, navigation calls, template variables, line endings, package size |
| `toggle-ai.py` | Switch between the AI build and the review build |
| `smoke-load.js` | Load every module under a mocked runtime to catch load-time errors |
| `smoke-ai.js` | Regression tests for the AI fallback chain |
| `t-hidden.js` | Verify AI elements are hidden in the review build |
| `t-ai-text.js` | Audit user-visible strings for AI wording that should not be present |
| `make_logo.py` | Icon generation (multiple concepts, sizes, circular crop preview) |
| `md2pdf.py` | Chinese Markdown to PDF |

---

## Open Source Notes

This project is released under the MIT License. Reading, learning, opening issues, and sending
pull requests are all welcome.

A few notes:

**Data ownership**
Your notes remain `.md` files on disk. This project does not build its own note database.
That principle runs through the whole design and is the reason the mastery write-back feature
exists at all.

**Reusable parts**
Most modules under `utils/` are independent of this specific product and can be taken on their own:

- `splitter.js`: seven Chinese text-splitting rules, useful wherever paragraph structure must be inferred
- `scheduler.js`: spaced repetition scheduling with an uncertainty weight
- `tree.js`: tidy tree and radial layout computation for the Mini Program environment
- `obsidian.js`: Markdown heading-tree parsing and idempotent in-place annotation
- Scripts under `tools/`: especially `preflight.py` (pre-upload audit) and `md2pdf.py` (Chinese PDF generation)

**On the AI portion**
What is kept in `ai-backup/` is a complete, working implementation, not placeholder code.
It is disabled by default because of platform category restrictions, not for reasons of quality.
If you are adding AI to your own Mini Program, the fallback design and layered diagnostics in
`utils/ai.js` are worth reading directly.

**Contributions**
Issues with reproduction steps and base library versions are most helpful.
Before changing code, running `python tools/preflight.py` is recommended.

---

## License

MIT License

---

## Competition Information

- Event: 2026 WeChat Mini Program Development Competition
  (co-hosted by WAIC Future Tech and the WeChat Mini Program team)
- Theme: Coexisting with AI
- Category: individual entry
