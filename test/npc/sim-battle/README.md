# NPC AI 实战模拟 Runner

用户指定局面和标准答案的独立评测见 [Hard AI 人工标注评测集](../decision-eval/README.md)。只由用户选题和标注，行动不匹配即判错。

直接在进程内跑一局 PS 对战，一方由"策略玩家"（max-damage / random / mirror-npc / scripted / interactive）控制，另一方由本仓库的 NPC AI 控制。目标是让 AI 的真实运行时轨迹可观察、可复现，不用启服务器 + 浏览器 + 复制聊天日志。

默认使用正式 `TeamValidator` 校验队伍，并保留 Mega 等战斗形态的规范化结果。`--allow-illegal-teams` 仅用于明确需要非法配置的机制测试。

支持 **singles / doubles / multi** 三种 game type。`--format` 必须存在且与 `--game-type` 一致，否则报错。`--seed` 同时传入战斗与 AI 的随机选择。

选择 Hard 使用 `--npc-difficulty hard`。Multi 中 Normal／Hard 均通过生产 `NPCMultiManager` 协调 p2/p4，两位 NPC 可分别选 `normal` 或 `hard`；不支持与 `basic` 混用。Multi 玩家侧建议使用 `max-damage`、`random` 或 `scripted`，`mirror-npc` 尚未复用四人协调器。

---

## 快速开始

```bash
npm run build

# 单打：max-damage p1 对 Normal NPC
node dist/test/npc/sim-battle/runner.js \
  --format        gen7ou \
  --game-type     singles \
  --player        test/npc/sim-battle/sample-teams/sample_team_1_gen7ou.txt \
  --npc           test/npc/sim-battle/sample-teams/sample_team_2_gen7ou.txt \
  --p1-strategy   max-damage \
  --npc-difficulty normal \
  --log-level     DECISION \
  --seed          1,2,3,4 \
  --max-turns     30 \
  > battle.log 2> ai.log
```

- `battle.log` = PS 全视角协议与 NPC 控制台决策日志（`--log-level NONE` 可关闭后者）
- `ai.log` = 玩家策略日志与运行错误

---

## 五种玩家策略

| 策略 | 用途 |
|---|---|
| `max-damage` | 按 BP × STAB × 平均属性相克挑最强招（忽略 Status 招式）；对手类型从协议 switch/drag 实时聚合 |
| `random` | PS 原生 `RandomPlayerAI`，冒烟/批量跑 |
| `mirror-npc` | 对面也用 NPC AI（默认跟随 `--npc-difficulty`，可用 `--p1-difficulty` 单独指定），basic vs basic / normal vs normal / hard vs hard，用来观察对称情况 |
| `scripted` | JSON 定义的 choice 序列，回归测试、复现 Bug |
| `interactive` | 从 stdin 读 choice，现场手动调试 |

p1 用 `--p1-strategy`；Multi 的 p3 用 `--p3-strategy`。两边可以不同策略。

### scripted 示例

```bash
--p1-strategy scripted --script-p1 test/npc/sim-battle/scripts/always-move-1.json
```

每个条目一个 `{"choice": "move 2"}`，依次用于每次 **招式** request；`teamPreview`/`forceSwitch` 固定走 `default`。

---

## 三种 game type

### singles（默认）
```
--game-type singles
--player team_a.txt --npc team_b.txt
```
p1 玩家 vs p2 NPC。

### doubles
```
--format gen9nationaldexdoubles --game-type doubles
--player team_a.txt --npc team_b.txt
--p1-strategy max-damage
```
p1 玩家 vs p2 NPC，各 2 只 active。

### multi
```
--format gen9nationaldexmulti --game-type multi
--player test/npc/sim-battle/sample-teams/sample_team_1_gen7ou.txt --player2 test/npc/sim-battle/sample-teams/sample_team_2_gen7ou.txt
--npc data/npc/teams/maxie-gen9nationaldexmulti.json
# 可选：--npc2 另一个 NPC 文件
--p1-strategy max-damage --p3-strategy max-damage
```
`(p1+p3)` 玩家队伍 vs `(p2+p4)` NPC 队伍。

**NPC 队伍结构**：优先读 npc 文件里 `slot: "p2"` / `slot: "p4"` 字段拆成两边；也可以用 `--npc` + `--npc2` 两个文件分开指定。Max Team Size = 3，长队伍自动截断前 3 只。

---

## 队伍文件格式

runner 自动识别三种：

1. **PS 导出 `.txt`**（Smogon / damagecalc.com 导出）
   ```
   Garchomp @ Rockium Z
   Ability: Rough Skin
   EVs: 252 Atk / 4 SpD / 252 Spe
   Jolly Nature
   - Swords Dance
   - Earthquake
   ...
   ```

2. **带 `format` + `pokemon` 的 JSON**（`data/npc/teams/*.json`）
3. **纯 `PokemonSet[]` JSON 数组**

Multi 文件可以带 `slot: "p2" | "p4"` 字段，被自动分割。

---

## CLI 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--format` | PS 格式 id | `gen9nationaldex` |
| `--game-type` | `singles` \| `doubles` \| `multi` | `singles` |
| `--player` / `--player-team` | p1 队伍 | 必填 |
| `--player2` | p3 队伍（Multi） | — |
| `--npc` / `--npc-team` | p2 队伍 | 必填 |
| `--npc2` | p4 队伍（Multi）；或留空让 npc 文件按 slot 拆分 | — |
| `--p1-strategy` | p1 策略 | `max-damage` |
| `--p3-strategy` | p3 策略（Multi） | `max-damage` |
| `--script-p1` / `--script` | scripted 策略的脚本路径 | — |
| `--script-p3` | p3 scripted 脚本 | — |
| `--npc-difficulty` | `basic` \| `normal` \| `hard` | `normal` |
| `--npc2-difficulty` | p4 的难度（Multi） | 同 `--npc-difficulty` |
| `--seed` | PRNG 种子 `a,b,c,d` | 随机 |
| `--log-level` | `NONE` \| `DECISION` \| `SCORING` \| `VERBOSE` | `DECISION` |
| `--max-turns` | 回合上限，到达后 `>forcetie`；0 不施加 runner 上限 | `200` |
| `--debug-ai` | 额外打印 NPC 的 choose（stderr） | 关闭 |

---

## 典型调试工作流

1. **收集数据**：固定 `--seed`，用不同 `--p1-strategy` 跑几遍，观察 NormalAI 对不同难度对手的决策差异
2. **锁定场景**：发现决策异常后，`--log-level SCORING` 看评分明细
3. **写回归**：把场景写成 `scripted` 脚本放到 `scripts/`，加进 CI
4. **AI 伤害计算校验**：`test/npc/ai/ai-damage-calc.test.js` —— Garchomp vs Mega Char-X 的四个期望值
   ```bash
   node test/npc/ai/run-tests.js ai-damage-calc
   ```

## 测试 "挑衅" 这类特殊招式的使用

1. 找一队装 Taunt 的队伍，和一队高威胁 Setup 使用者的队伍
2. `--p1-strategy mirror-npc` 让另一个 NormalAI 做 Setup，让 NPC 侧有正当理由出 Taunt
3. `--log-level SCORING` 看 Taunt 的具体评分，对照 CFRU `ai_positives.c` 的 Taunt 分支

---

## 已知限制

- max-damage 策略只认 Dex basePower；对 BP=0 的变基招（Low Kick、Grass Knot、Hidden Power 之类）会落到 fallback，不是最佳对手选择
- scripted 还不支持"看到协议子串 X 后才下一个 choice"的断言型等待
- Multi 长队伍截取前 3 只；普通队伍文件必须分别提供 `--npc` 和 `--npc2`。默认执行所选赛制的队伍合法性验证
- BasicAI 没有决策级日志，只能靠 `--debug-ai` 看 choose 原文

## Hard / Normal 配对对照

```bash
node build
node test/npc/sim-battle/compare.js 10 /tmp/npc-hard-comparison
```

对照使用本目录两套 gen7ou 队伍。每个种子运行四场，交换队伍和 Hard 所在位置；记录自然胜负、平局和回合上限。所有协议、决策与错误日志保存在输出目录，汇总为 `summary.json`。该结果用于定位行为问题和比较固定对局，不代表所有 OU 队伍的总体胜率。

单场复现可使用 `--p1-strategy mirror-npc --p1-difficulty normal --npc-difficulty hard --format gen7ou --seed 1,2,3,4`，并通过 `--player`、`--npc` 指定队伍文件。

NPC 队伍池批量对照（Python 标准库，默认 5 组、交换后共 10 局）：

```bash
node build
python3 test/npc/sim-battle/benchmark.py --pool npc1 --pairs 30 --output /tmp/npc-tuning
python3 test/npc/sim-battle/benchmark.py --pool npc1 --pairs 60 --offset 30 --output /tmp/npc-validation
```

固定种子打乱队伍组合，`--offset` 划分不重复的调优和验证组合；每组交换双方队伍，Hard 所在位置按组交替。输出包含队伍与种子的 `manifest.json`、逐局完整评分日志和 `summary.json`。运行错误、自然平局、回合上限分别统计，不计入胜利；输出目录必须尚不存在。不同队伍池可用 `--format` 指定对应规则。`--timeout` 设置单局进程时限（默认 240 秒），不改变 300 回合上限；计算较慢时可提高进程时限。

Hard 单打使用项目内伤害计算器和 `hard/projection.ts` 做确定性的两回合推演，不创建 PS Battle、不抽样整队配置，也不按固定数量截断行动。搜索按配置权重平均、配置内取最不利的保留回应；回应预测概率用于战术评分。精确值、上界和下界必须分别解释。实现及缓存边界见 [Hard 逻辑](../../../docs/ai-logic/HardAI/logic.md)。

## 与玩家录像逐回合对照

现有导入器限定 Gen 9 Random Battle 单打、控制 p2。Hard 两回合搜索支持 Gen 3～7，因此该导入器中的 Hard 比较使用评分与规则回退，不衡量两回合搜索效果。其他格式需要适配状态还原；模拟产生的原始决策可使用下文快照工具直接复现。

```bash
node build
node test/npc/replay-audit.js /tmp/npc-expert-replay gen9randombattle-*.html
node test/npc/replay-audit.js /tmp/npc-expert-hard --difficulty hard gen9randombattle-*.html
```

输入为 Gen 9 Random Battle 单打的下载录像，以及同名 `.txt` 文件中的 **p2 完整队伍**。工具让 `NormalAI` 或 `HardAI` 控制 p2，复用生产决策入口、评分和换人逻辑。每个回合只传入回合开始前的公开协议，以及从队伍导出和已发生事件还原的己方 request；对手的精确 HP 转成公开百分比，未展示的配置继续由本地 random preset 推断。Hard 的换人冷却根据已发生的主动换人恢复。录像服务器与本地配置库版本可能不同。

输出包括 `comparison.tsv` 逐回合对照、`report.txt` 评分摘要、`summary.json` 统计，以及每场的 JSON 请求、AI 状态、招式分数及加减分原因。`exact` 比较招式或换人，`topEquivalent` 另外接受同分招式；`fullChoiceExact` 同时要求太晶化选择一致。太晶化回合还提供固定玩家太晶选择后的独立诊断，不影响基线结果。

`staySwitch` 分别记录双方都留场、双方都换人、AI 留场而玩家换人、AI 换人而玩家留场，以及换人目标一致的次数。主动换人和强制补位/轮转分开统计；每个决策还输出所有合法后备的评分和安全性判断，包括 AI 决定留场时的后备。

己方 HP 只有百分比时，工具根据导出配置计算最大 HP，保留可能的整数 HP 区间，以区间中点进行评分。它分别检查每只精灵的区间端点及全队同时取最小/最大值的情况；选择发生变化的样本排除出一致率。这是边界敏感性检查，并不穷举所有 HP 组合。

麻痹、出手前倒下和投降可能隐藏所选招式，这些回合不计入一致率。中途轮转和倒下补位单独统计，双倒后没有在场对手的补位不作匹配判断。录像没有原始 request，工具还原已覆盖的 HP、PP、道具、讲究锁定、挑衅等信息；遇到变身、幻觉和未支持的招式封锁事件会标记并排除后续比较。工具不重演伤害随机数，也不把玩家选择或战斗结果作为正确答案；一致率不代表胜率。

## 随机队伍对照模拟

normal 与 hard 的一组模拟包含两局：固定随机抽取的队伍 A、B，第一局 normal 使用 A、hard 使用 B，第二局交换队伍。两局使用相同的战斗 seed，保留双方评分和公开战斗日志。默认“5 次模拟”指 5 组、共 10 局；统计同时注明组数、局数和是否自然结束。

## 决策耗时

使用 Node preload 记录 Normal／Hard 每次决策的耗时、搜索节点和回退理由。计时从 `receiveRequestWithState` 开始，不包括此前的协议解析和状态构建；`kind: process` 记录 Node 进程运行总时间。日志默认为系统临时目录，也可通过 `NPC_TIMING_DIR` 指定，不写入仓库。

```bash
NPC_TIMING_DIR=/tmp/npc-timing \
NODE_OPTIONS='--require ./test/npc/sim-battle/decision-timing.js' \
python3 test/npc/sim-battle/benchmark.py \
  --pool npc1 --pairs 1 --workers 1 --timeout 1800 --output /tmp/npc-timed-matches
```

每个 Node 进程输出一份 `<pid>.jsonl`。比较性能时同时报告普通行动／补位耗时、完整搜索／回退次数、整局回合数、并发数和是否自然结束；回退较多不等于搜索更快。`manifest.json` 保存队伍和种子，可通过 `--replay-manifest` 复现。

## Hard 自我对战与关键决策复现

目标是减少经分析确认的不合理决策与决策耗时，胜负仅作为对局背景。`--self-play` 让双方使用 Hard，每个队伍组合只打一局，不交换队伍，默认不设置运行时间或 runner 回合上限；PS 自身的终局规则仍生效。`--pairs` 指不同队伍组合数。manifest 保留双方难度、种子、代码版本、并发数及运行限制。省略 `--self-play` 保持交换队伍的 Hard/Normal 对照（默认每局 240 秒、300 回合）。复现自我对战 manifest 时同样传入 `--self-play`，或显式指定 `--timeout 0 --max-turns 0`。

```bash
node build
NPC_TIMING_DIR=/tmp/hard-batch/timing \
NPC_CAPTURE_DIR=/tmp/hard-batch/snapshots \
NODE_OPTIONS='--require ./test/npc/sim-battle/decision-timing.js' \
python3 test/npc/sim-battle/benchmark.py --self-play --pairs 6 --workers 3 \
  --output /tmp/hard-batch/results
node test/npc/sim-battle/summarize-decisions.js /tmp/hard-batch/timing > /tmp/hard-batch/decisions.json
node test/npc/sim-battle/replay-decision.js /tmp/hard-batch/snapshots/PID-N.bin
```

`NPC_CAPTURE_DIR` 可选。快照保存 `receiveRequestWithState` 收到的己方 request、公开知识状态、AI 随机数状态、换人冷却和治疗牺牲计划，不读取对方真实配置或已提交行动。使用 Node v8 序列化保留 Set、Map 和对象共享引用；只读取可信的本地快照，并保留生成它的代码版本和 Node 版本。双方快照分别属于各自视角，不可把另一方快照拼入决策输入。

快照在计时前写入，输出记录在计时后写入；耗时包含生产决策与其日志开销，不包含状态构建。超时前已经写入但没有对应完成记录的快照可用于诊断卡住的决策，不作为完成耗时样本。离线复现使用新控制器的冷缓存，不直接与整局的缓存复用耗时比较。比较性能时使用同一快照、相同缓存条件和并发数；完整对局另作对照。

汇总按双方、普通行动／补位、搜索／单候选／回退分别给出样本数、中位数、P95、最大值和总耗时，并保留全部慢决策排序。协议中的连续换人、强化后撤退等仅为调查线索；记录具体分母和人工确认原因，不把自动标记率当作错误率。候选覆盖、配置推断、转移和终点价值应分别核查；`prune: false` 只关闭搜索上下界剪枝，不恢复候选层排除的行动。

价值校准按 [校准讨论](../../../docs/ai-logic/HardAI/value-calibration.md) 从具体局面开展：固定公开信息、候选配置、权重和计分基准后比较静态值与继续展开的价值。快照及复现工具不自动构成校准系统，不默认改变线上深度或策略参数。
