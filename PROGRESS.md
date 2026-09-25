# 📈 多因子选股工具 — 开发进度

> 更新日期：2026-08-15
> 技术栈：React 18 + TypeScript + Vite 5 + ECharts

## 启动方式

```bash
npm run mobile     # 一键启动：代理(8787) + 开发服务器(5173)，手机局域网可访问
npm run ai-server  # AI 研报后端（FastAPI :8000，需先装依赖 + 配置 .env 的 DEEPSEEK_API_KEY）
# 或分开：
npm run proxy      # 终端1：数据代理（127.0.0.1:8787）
npm run dev        # 终端2：前端开发（http://localhost:5173）
```

## ✅ 已完成功能

### MVP 基础（v0.1）
- [x] 8 因子打分模型（趋势/MACD/RSI/量能/估值/盈利/成长/资金）
- [x] 选股配置界面（股票池 + 因子权重滑条 + 过滤条件）
- [x] 结果列表（排序 + CSV 导出）
- [x] 股票详情（K线图 + 雷达图 + 因子明细）
- [x] IndexedDB 本地缓存（股票列表/K线/财务/资金流）
- [x] 数据代理层（东方财富 clist/fflow/datacenter + 腾讯 kline）

### 优化 v1.1（Phase 1 — 核心引擎）
- [x] **行业中性化估值**：PE 分位从"全市场"改为"行业内"，样本不足自动退化
- [x] **12 因子模型**：新增 动量(1月)/动量(3月)/短期反转/低波动
- [x] **5 个策略模板**：均衡/价值/成长/动量/质量，一键应用
- [x] 行业字段（f100）解析

### 优化 v1.2（Phase 2 — 量化分析）
- [x] **因子 IC/IR 分析**：Spearman 秩相关，IC 均值/标准差/IR/t 值/胜率
- [x] **IC 可视化**：因子 IC 均值柱状图 + 累计 IC 曲线 + 统计表 + 因子评级
- [x] **策略回测引擎**：定期打分 → Top N 等权 → 滚动调仓
- [x] **回测可视化**：净值曲线 vs 基准 + 绩效指标（年化/夏普/回撤/胜率）+ 调仓记录
- [x] App 三大 Tab：选股 / 因子分析 / 策略回测

### 优化 v1.3（Phase 3 — 组合与工程）
- [x] **行业分散**：每个行业最多 N 只，避免结果集中（默认 3）
- [x] **ECharts 按需引入**：主包 1202KB → 741KB（-38%）
- [x] **Web Worker 打分**：后台线程计算，UI 不阻塞（自动降级）

### 优化 v1.4（今日推荐 + 买卖点）
- [x] **今日推荐 Tab**：尾盘（14:45-14:55）运行，打分选 Top 4（行业分散）
- [x] **买卖点计算引擎**（`src/engine/tradingSignals.ts`）：
  - 买入区间（回踩均线 / 近期低点）
  - 止盈目标（前期高点 / +5%）
  - 止损价（跌破近期低点 3%，最多 -8%）
  - 风险回报比 + 可解释理由
  - 短线模式（MA5 回踩）vs 长线模式（MA20 回踩）
- [x] **实时价保证**：Top 4 强制拉最新 K 线（绕过缓存），用最后一根 close 作实时价
- [x] **尾盘时段提示**：14:30-15:00 显示绿色提示"可收盘前下单"
- [x] 点击卡片可跳转 K 线详情（复用 StockDetailModal）

### 优化 v1.5（短线强势领涨股）
- [x] **新增 2 个短线因子**（`short_momentum` 3日爆发力、`breakout` 创新高）
- [x] **「🔥 强势领涨」策略模板**：候选池按涨幅排序（强势股进池）+ 聚焦短线动量/资金，关闭估值/盈利/RSI超买惩罚
- [x] **今日推荐默认走短线**：策略选择器默认「强势领涨」，短线模式用 MA5 回踩
- [x] 修复 breakout 定义（对比前 20 日高点不含当日，正确识别创新高）

### 优化 v1.6（短线三项强化）
- [x] **候选池按换手率排序**：新增 `turnover` 排序方式，优先选资金活跃的强势股
- [x] **止损收紧到 5%**：`tradingSignals.ts` 止损下限从 -8% 改为 -5%（超短线更严格）
- [x] **连板高度因子** `limit_up`：检测连续涨停天数，自动识别主板 10%/创业板 20% 涨停，2-4 板黄金期得分最高
- [x] **强势领涨模板更新**：候选池改 `turnover` 排序 + 新增 `limit_up` 权重 15%

### 优化 v1.7（数据源容灾）
- [x] **proxy clist 内存缓存**：push2 偶发限流时返回最近一次成功缓存（10 分钟内）
- [x] **pipeline 过期缓存降级**：股票列表拉取失败时读 IndexedDB 过期缓存兜底
- [x] 明确错误提示：首次使用且数据源不可用时提示"请等待恢复"

### 优化 v1.8（监控功能）
- [x] **腾讯实时行情接口** `/quote`：批量快照（GBK 解码），当前价/涨跌幅/最高/最低/换手率
- [x] **监控列表**（localStorage）：今日推荐自动加入 + 手动增删，持久化
- [x] **监控状态引擎**：跌破止损🔴/到止盈🔵/买点区间🟢/破下沿🟡/超买点🟡/仅监控⚪
- [x] **监控面板**：每 30 秒定时刷新，状态异常票排前面高亮
- [x] 实时价走腾讯（绕开限流 push2），更稳定

### 优化 v1.9（股票池过滤增强）
- [x] **默认排除科创板（688）**：`excludeKcb: true`
- [x] **默认排除创业板（300/301）**：新增 `excludeCyb` 字段，默认 `true`
- [x] 配置面板可手动开关（适合买不了科创板/创业板的用户）

### 优化 v2.0（选股质量提升四件套）
- [x] **市场情绪择时**（`marketSentiment.ts`）：涨停家数/涨跌比/平均涨幅 → 情绪温度 0-100 + 🔥热/😐中性/🧊冰点建议
- [x] **热点板块榜**（`sectorHeat.ts`）：按行业聚合涨停家数+平均涨幅，识别风口板块
- [x] **一字板标记**（`isOneWordLimitUp`）：检测买不进的票，UI 显示"⚠️ 一字板买不进"
- [x] **强势模板一键回测**：回测页一键验证短线策略历史胜率
- [x] **「🌡️ 市场」Tab**：情绪温度计 + 涨停/跌停/涨跌家数 + 热点板块排行
- [x] **今日推荐页情绪条**：生成推荐前先看今天该不该做

### 优化 v2.1（板块选股）
- [x] **板块过滤**：SelectConfig 加 `sector` 字段，选股/今日推荐可按行业过滤
- [x] **选股页板块下拉**：股票池下加行业选择（东财行业分类，动态加载）
- [x] **今日推荐板块下拉**：策略选择旁加板块，限定板块内选票
- [x] `fetchSectorList`：从全市场快照提取去重行业列表

### 优化 v2.2（复盘 + 模拟持仓 + 分时图）
- [x] **复盘**（`ReviewPanel.tsx` + `records.ts`）：推荐自动存档，统计胜率/平均涨跌/止盈止损触发数
- [x] **模拟持仓**（`PositionPanel.tsx` + `positions.ts`）：记买入价/股数，实时算盈亏，止损标红
- [x] **分时图**（`MinuteChart.tsx` + proxy `/minute`）：价格线 + 均价线 + 成交量柱 + 昨收线
- [x] **详情弹窗**加「日K / 分时」切换
- [x] 推荐存档：`DailyPick` 生成后 `savePickRecord`（保留 30 天）

### 优化 v2.3（概念题材龙头）
- [x] **概念字段**：clist 加 f128，`StockInfo.concept` 识别题材（光模块/算力等）
- [x] **概念热度榜**：`computeConceptHeat` 按概念聚合（市场页「概念题材」tab，默认显示）
- [x] **题材龙头选股**（`conceptLeader.ts`）：从最强概念里选领涨股，过滤非热点题材
- [x] **「🔥 题材龙头」策略模板**：今日推荐选它时走概念聚合路径，绕开候选池粗筛
- [x] **不排除冷门题材**：改为"个股强度 + 题材热度加成"加权排序——热点题材龙头（美利云/亨通）+ 冷门但暴涨的妖股（一鸣）都能选出

### 优化 v2.4（数据源自动降级）
- [x] **新浪全市场数据源**（`/sina-list`）：5207 只，现价/涨跌幅/换手率/PE/PB/市值，稳定可用
- [x] **东财→新浪自动降级**：clist 限流时自动切新浪，选股/情绪/候选池不中断
- [x] 三级降级链：东财 → 新浪 → 过期缓存
- [x] 说明：新浪无行业/概念字段（东财独有），降级时这两类功能暂时缺失

### 优化 v2.5（温和放量规则 · 东财条件选股）
- [x] **「📈 温和放量」策略模板**：应用东财条件选股规则
- [x] 快照粗筛：换手率 5~15% + 涨跌幅 1~6% + 剔除 ST/退市/科创板/北交所
- [x] K线精筛：量比 1.2~5（当日量 ÷ 5日均量，K线近似计算）
- [x] 两阶段筛选避免全市场逐只拉K线
- [x] 验证：换手/涨跌幅/剔除过滤正确，量比 0.3(排除)/2.0(满足)/6.0(排除) 正确
- [x] **上升趋势硬性过滤**（博主规则②）：MA20>MA60 + 收盘>MA20 + MA20向上，拒绝抄底低位股（下跌/横盘均排除）
- [x] **上升趋势改为可开关** `requireUptrend`（types/pipeline/UI/样式）：温和放量模板默认开启；关闭后为同花顺式宽松放量（对比同花顺能筛出更多票）

### 优化 v2.6（策略说明）
- [x] **「📖 策略说明」弹窗**：今日推荐页 + 选股页均可打开
- [x] 展示 7 个策略的适用场景 + 权重构成（可视化条）
- [x] 展示全部因子通俗解释（技术/基本面/资金面分组）
- [x] 买卖点读法 + 涨停板风险提示
- [x] 用户使用指南 `README.md`（日常流程/策略选择/因子/买卖点/风险）

### 优化 v2.7（量化规则三件套）
- [x] **均线粘合突破因子**（`breakout.ts`）：MA5/20/60 粘合后放量突破 = 启动信号，高分
- [x] **大盘择时**（`marketTiming.ts`）：上证/深成指 vs MA20，市场页顶部总闸门提示（🟢多头可做 / 🔴破位降仓）
- [x] **高位风险预警**：连板≥5 降级 + 高连板/放天量标记 `highRisk`，今日推荐卡片标红
- [x] 验证：粘合突破✅ 大盘择时✅ 5连板触发预警✅ 2连板正常✅

### 优化 v2.8（资金趋势 + 仓位建议 + 多策略回测对比）
- [x] **资金趋势因子** `moneyflow_5d`：近5日主力净流入，识别吸筹/出货（默认禁用，可选启用）
- [x] **仓位建议**（`positionAdvice.ts`）：情绪温度→仓位（🔥8成/😐5成/🧊0成），市场页+今日推荐显示
- [x] **多策略对比回测**：7 个策略全部回测，横向对比累计收益/年化/夏普/回撤/胜率
- [x] 验证：仓位建议三级正确，连续净流入高分/净流出低分，无数据因子缺席
- [x] 说明：资金流历史数据源（push2his）间歇性不可用，moneyflow_5d 失败时自动降级（因子缺席）

### 优化 v2.9（手机端直接运行）
- [x] **前端直连数据源**（`api.ts` 重构）：所有接口直连腾讯/新浪/东财（CORS 已验证），去掉代理依赖
- [x] **腾讯行情 GBK 解码**：浏览器 `TextDecoder('gbk')` 直连解码（已验证中文名正确）
- [x] **PWA**：manifest + service worker + 图标，手机"添加到主屏幕"变 App
- [x] **响应式布局**：手机端 Tab 滚动、卡片堆叠、表格横滚
- [x] **部署文档** `DEPLOY.md`：Cloudflare Pages / Vercel 免费部署步骤
- [x] 本地开发仍走代理（`import.meta.env.DEV` 判断），生产直连，自动切换
- [x] 验证：直连 K线/行情/财务 ✅，生产构建含 PWA ✅，dev 回归 ✅
- [x] **局域网手机访问**：`npm run mobile` 一键启动，手机同一 WiFi 访问电脑 IP（零成本，无公网也能用）
- [x] 说明：公网部署需能访问国外站点或国内云实名，网络受限用户用局域网方案

### 优化 v3.0（AI 研报 · 接入 tradingAgents-astock 多智能体）
- [x] **后端 FastAPI 服务**（`ai-server/main.py`，端口 8000）：包装 `tradingAgents-astock` 的 `TradingAgentsGraph`，POST 启动分析 → 后台线程跑 LangGraph stream → 12 阶段进度写入内存 job → 完成返回完整研报 JSON
- [x] **单任务闸门**：并发提交返回 409「已有任务运行中」；DeepSeek 配置（`deepseek-chat`，`ai-server/.env` 填 `DEEPSEEK_API_KEY`）
- [x] **进度移植**：12 阶段定义（技术/情绪/新闻/基本面/政策/游资/解禁/质量门控/多空辩论/交易决策/风控/最终决策）从 `web/progress.py` 移植；报告 key 检测从 `web/runner.py` 移植
- [x] **结果投影**：研报 JSON 结构对齐 `examples/run_cases.py` 的 `_save_json_summary`（10 报告键 + 辩论 3 + 风控 4，文本截断 3000/2000）
- [x] **前端「🤖 AI 研报」Tab**：输入/快捷点选代码 → 实时 12 阶段进度 → 评级徽章 + 折叠报告分区（`AIPanel.tsx`）
- [x] **直连后端**：`api.ts` 新增 `AI_BASE`（`http://<hostname>:8000`，dev=localhost/手机=电脑IP）+ 长超时 fetch，不走 node 代理
- [x] **迷你 markdown 渲染器**：自写（标题/列表/粗体/代码），不引第三方库（网络受限）
- [x] **研报本地保存**（`aiReports.ts`）：localStorage 存历史 50 条，可回看/删除
- [x] **文档**：README 新增 AI 研报用法，DEPLOY 补 8000 端口放行说明

### 优化 v3.1（公网部署 · GitHub Pages）
- [x] **vite base 相对化**：`base: './'`，产物适配子路径部署（`username.github.io/repo/`）
- [x] **PWA 子路径修复**：SW 注册改相对路径 `./sw.js` + sw.js 内部用 `self.registration.scope` 动态计算缓存路径（原绝对路径在子路径下会 404，PWA 安装失效）
- [x] **GitHub Pages 上线**：公开仓库 `Jkwell/gu-stock-selector`，dist 推 `gh-pages` 分支，站点 **https://jkwell.github.io/gu-stock-selector/** 已可访问（首页/JS/manifest 均 200）
- [x] **gh CLI 安装**（`gh_2.97.0_windows_amd64.zip` 解压到 `.tools/`，免管理员）+ 浏览器设备码登录
- [x] **git 代理配置**：`git config http.proxy http://127.0.0.1:7890`（Clash 本地代理，VPN 代理模式下 git 推送必须走它）
- [x] 说明：公网站点数据直连可用；「🤖 AI 研报」Tab 依赖本地 FastAPI(8000)，公网站点上该 Tab 不可用（需自建后端托管）

### 优化 v3.2（个股买卖点分析）
- [x] **「🔍 个股分析」Tab**（`StockAnalysisPanel.tsx`）：输入股票代码 → 一键得出「现在能不能买、买点、卖点」
- [x] **支持中文名搜索**：复用全市场快照建名称索引，输入中文名实时弹出联想下拉（精确→前缀→包含排序），模糊命中多个时弹下拉让用户选，避免自动乱选
- [x] **个股分析引擎**（`engine/stockAnalysis.ts`）：6 项技术检查（趋势/MACD/RSI/量能/买点可及/风险回报）+ 综合评分 → 三档结论（✅适合买入 / ⏳观望等待 / ❌不建议买入）
- [x] **买点/卖点**：复用 `tradingSignals` 引擎输出买入区间 + 止盈目标 + 止损价，叠加可视化价位条
- [x] **特殊情形**：一字板买不进 ⛔、高位连板风险 🔴、已破止损 🔻 直接判"不适合买"
- [x] **大盘情绪总闸门**：冰点时「适合买入」自动降级为「观望」，只降级不抬分
- [x] **快捷选择**：今日推荐 + 监控列表一键带入；一键加入监控；附日 K 线图
- [x] 验证：`npm run verify:stockanalysis` ✅（上升趋势→买 / 空头→回避 / 一字板→回避 / 高位连板→回避 / 冰点降级）

### 优化 v2.10（数据去重修复 + 生产构建验证）
- [x] **proxy 缓存键修复**（`proxy/index.mjs`）：clist 缓存 key 加入完整 query 串（原单键缓存导致分页请求全部返回第 1 页 → 4100 条仅 100 个唯一代码 → 前 3 条结果重复）
- [x] **fetchStockList 去重**（`api.ts`）：按代码 Set 去重，杜绝重复候选进池
- [x] **组合去重**（`portfolio.ts`）：`diversifyPortfolio` 按代码去重 + 未知行业不受行业上限限制（新浪降级无行业字段时结果不塌缩）
- [x] **IndexedDB 过期缓存去重**（`pipeline.ts`）：`getStockList` 读缓存前按代码去重（防旧缓存含重复列表）
- [x] **生产构建验证**：`npm run build` ✅ dist 含 manifest/sw.js/图标，SW 注册生产模式激活（PWA 就绪）

## 📊 验证结果

| 验证项 | 命令 | 状态 |
|--------|------|------|
| 打分引擎 | `npm run verify` | ✅ 排序正确，分数 0-100 |
| IC/IR + 回测 | `npm run verify:ic` | ✅ 正常 |
| 行业中性化 | `npm run verify:industry` | ✅ 行业内分位生效 |
| 短线因子 | `npm run verify:strong` | ✅ 强势/弱势识别正确 |
| 连板高度 | `npm run verify:limitup` | ✅ 主板10%/创业板20%识别正确 |
| 监控状态 | `npm run verify:monitor` | ✅ 7 种状态判断正确 |
| 市场引擎 | `npm run verify:market` | ✅ 情绪/板块/一字板正确 |
| 题材龙头 | `npm run verify:concept` | ✅ 含冷门强势股 |
| 数据降级 | `npm run verify:fallback` | ✅ 新浪 5207 只可用 |
| 温和放量 | `npm run verify:quickrules` | ✅ 量比/趋势过滤正确 |
| 量化规则 | `npm run verify:rules` | ✅ 粘合突破/大盘择时/高位预警 |
| 仓位/资金 | `npm run verify:advice` | ✅ 仓位三级 + 资金趋势 |
| 前端直连 | `npm run verify:direct` | ✅ 直连 K线/行情/财务（GBK解码正确） |
| 个股分析 | `npm run verify:stockanalysis` | ✅ 买/观望/回避分级 + 买卖点结构 + 冰点降级 |
| AI 后端健康 | `curl http://127.0.0.1:8000/health` | ✅ `{ok:true}` |
| AI 分析流程 | `npm run ai-server` + curl POST | ✅ 单任务 409 闸门 + 12 阶段进度 + 管线跑到 LLM 调用；⏳ 真实评级返回待填 `DEEPSEEK_API_KEY` |
| 类型检查 | `npx tsc --noEmit` | ✅ 通过 |
| 生产构建 | `npm run build` | ✅ 主包 + PWA |

## 🔧 已知问题 / 待办

- [ ] **AI 研报端到端验证**：`ai-server/.env` 当前是占位 key，填入真实 `DEEPSEEK_API_KEY` 后重启 `npm run ai-server`，跑一次真实分析确认评级返回（约 1-3 分钟、30-50 次调用）
- [ ] **push2 短期限流**：东财 clist 偶发限流（已降级新浪）；push2his 资金流历史间歇性不可用（moneyflow_5d 已降级）
- [x] **公网部署（GitHub Pages）已完成**：`https://jkwell.github.io/gu-stock-selector/`（详见 v3.1 记录）。更新部署 = 重新 `npm run build` → 推送 `gh-pages` 分支
- [ ] 财务数据仅取最新报告期，回测未纳入基本面因子
- [ ] 回测未考虑涨跌停无法成交、停牌等现实约束
- [ ] 止盈止损参数写死在引擎，可加 UI 配置（如宽松/严格档）
- [ ] 可扩展因子：北向资金、股东人数变化、昨日涨停溢价、连板梯队

## 📁 项目结构

```
src/
├── engine/              # 核心算法
│   ├── indicators.ts    # 技术指标（SMA/EMA/MACD/RSI/布林/波动率）
│   ├── rawFactors.ts    # 18 个技术因子向量化计算器（共享）
│   ├── factors.ts       # 多因子打分引擎（行业中性化 + 高位预警）
│   ├── correlation.ts   # Pearson/Spearman 相关
│   ├── icAnalysis.ts    # 因子 IC/IR 分析
│   ├── backtest.ts      # 策略回测引擎
│   ├── portfolio.ts     # 组合优化（行业分散）
│   ├── sectorHeat.ts    # 行业/概念热点榜
│   ├── conceptLeader.ts # 题材龙头选股
│   ├── quickRules.ts    # 温和放量规则 + 上升趋势过滤
│   ├── breakout.ts      # 均线粘合突破
│   ├── marketTiming.ts  # 大盘择时（指数 vs MA20）
│   ├── marketSentiment.ts # 市场情绪温度
│   ├── positionAdvice.ts # 仓位建议
│   ├── stockAnalysis.ts # 单只个股买卖点分析
│   └── tradingSignals.ts # 买卖点计算
├── data/                # 数据层
│   ├── api.ts           # 数据获取（本地代理/生产直连，自动切换）
│   ├── cache.ts         # IndexedDB 缓存
│   ├── pipeline.ts      # 选股流水线 + Worker 打分 + 行业分散
│   ├── watchlist.ts     # 监控列表（localStorage）
│   ├── positions.ts     # 模拟持仓（localStorage）
│   ├── records.ts       # 推荐记录（复盘用）
│   └── aiReports.ts     # AI 研报历史（localStorage）
├── components/          # UI
│   ├── ConfigPanel.tsx  # 配置面板（模板/股票池/因子/过滤）
│   ├── ResultTable.tsx  # 结果列表
│   ├── StockDetailModal.tsx # 详情（日K/分时切换）
│   ├── MarketPanel.tsx  # 市场（大盘择时 + 情绪 + 热点榜）
│   ├── AIPanel.tsx      # AI 研报（输入/进度/报告/历史）
│   ├── DailyPickPanel.tsx # 今日推荐
│   ├── WatchlistPanel.tsx # 监控
│   ├── PositionPanel.tsx # 持仓
│   ├── ReviewPanel.tsx  # 复盘
│   ├── StockAnalysisPanel.tsx # 个股买卖点分析
│   ├── ICPanel.tsx      # 因子分析
│   ├── BacktestPanel.tsx # 回测 + 多策略对比
│   ├── StrategyGuideModal.tsx # 策略说明
│   └── charts/          # ECharts（K线/分时/雷达，按需引入）
├── workers/             # Web Worker
│   └── scoring.worker.ts
└── config/factors.ts    # 18 因子 + 7 策略模板
ai-server/               # AI 研报后端（FastAPI，包装 tradingAgents-astock）
│   ├── main.py          # 任务启动/轮询/结果 + 单任务闸门 + CORS
│   ├── requirements.txt
│   └── .env             # DEEPSEEK_API_KEY
scripts/                 # 14 个验证脚本
proxy/index.mjs          # 本地数据代理
public/                  # PWA（manifest/sw.js/icons）
```

## 📄 文档

| 文档 | 内容 |
|------|------|
| `README.md` | 用户使用指南（日常流程/策略/因子/买卖点/风险） |
| `DEPLOY.md` | 手机端部署（局域网方案 + 公网方案） |
| `PROGRESS.md` | 开发进度（本文档） |

## 2026-08-15 本轮收尾记录

### 已完成

- [x] **移动端导航重构**：手机端使用固定底部五项导航（行情、今日推荐、选股、监控、更多）；复盘、持仓、AI 研报、因子分析、策略回测统一收纳到“更多”。桌面端顶部导航保持不变。
- [x] **移动端适配验证**：以 390px 视口验证底部导航、更多菜单、策略回测跳转和无横向溢出；截图位于 `C:\\Users\\lenovo\\.codex\\visualizations\\2026\\08\\15\\01a0034a-5fd4-7502-b0a1-be5cb53133b3\\gu-mobile.png`。
- [x] **历史财务数据防未来函数**：`fetchFinancials(code, asOfDate)` 依据披露日过滤；在截止日后才披露或缺少披露日的数据会被拒绝使用。最新快照与历史时点使用独立缓存键。
- [x] **回测结果增强**：新增前后半段稳定性指标，并明确展示本次回测实际使用的技术因子，以及无法由历史数据覆盖的基本面/资金面因子。
- [x] **构建与回归**：`npm run build`、`npx tsx scripts/verify-opt.ts`、`npx tsx scripts/verify-financials.ts` 均已通过。
- [x] **发布**：源码已推送至 `main` 提交 `62b670f`；GitHub Pages 已更新至 `gh-pages` 提交 `d2beae5`，线上地址为 `https://jkwell.github.io/gu-stock-selector/`。

### 当前数据源状态

- [x] 实时行情和 K 线：腾讯财经；全市场快照：东方财富失败时自动降级新浪，再降级 IndexedDB 过期缓存。
- [!] 东方财富 `datacenter-web` 当前在本地代理实测失败：`/financials?code=600519&asOfDate=2024-12-31` 返回 502（`TypeError: fetch failed`）。因此历史财务和部分资金流数据目前不能视为稳定可用。
- [ ] 用户提出评估 `mpquant/Ashare` 作为替代方案。本轮未能完成上游仓库的在线核实，尚未接入或修改任何数据源代码。

### 下次优先事项

1. 核实 Ashare 的真实数据源、维护状态、复权 K 线和财务数据能力；它若仅提供 Python 侧行情/K 线，应作为后端备源而不是直接替换浏览器端全部接口。
2. 把数据源按能力拆分并降级：行情/K 线优先腾讯，必要时接入 Ashare 或 mootdx；财务数据切换到可用的非东财来源；东财只保留其独有数据并标记数据缺失。
3. 为每个数据源增加健康检查、超时、缓存时效和页面可见的降级提示，避免在数据不完整时把结果误判为正常选股信号。
