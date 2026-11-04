# 016 持续消耗与临时控制校准

## 完整参考不支持强制换人

016 T20 的候选包括 Rapid Spin 和立即换 Chansey。用相同公开信息、配置及权重复用原生搜索，在保留候选树内完整展开：

| 根行动 | 两回合绝对价值 | 三回合绝对价值 |
| --- | ---: | ---: |
| Rapid Spin | 103.983907 | 48.018712 |
| 立即换 Chansey | 72.444162 | 40.643819 |

三回合仍选择 Rapid Spin，优势 7.374893。延伸参考不是绝对真值，但不支持为了停止低伤害循环而强制换人。对首回合 Defog，继续留场重新铺 Stealth Rock 有真实价值；留场也能让 Volt Switch 因地面免疫失败。

三回合诊断使用原生 `branches`、`resolveContinuations`、`resolveEntries` 和观察分组，未复制搜索算法。每个公开观察组共用行动，不对隐藏配置各自挑选。该局根只有一个 Zapdos 配置，第三层保留先前入场配置的概率质量；同组多回应必须给出相同局面的断言成立。同步重算两回合值与原参考一致。共 52620 个节点，约 117 秒；这是现有候选树参考，不是包含全部合法行动的完整博弈解。

## 条件计划确有延迟成本

“先 Spin 对 Hidden Power Ice，再换 Chansey 对 Volt Switch 接 Mew”与“立即换 Chansey 对 Volt Switch 接相同 Mew”的完整状态，仅差回合数、Excadrill 少 33 HP、Spin 少 1 PP；双方配置池和公开知识相同。前者静态价值 185.744，继续一回合参考 68.655；后者分别为 188.824、72.444。这条条件计划推迟了同一代价并多付损耗，但不能代表根行动的全部后续策略。三回合搜索面对首轮 Hidden Power Ice 会选择继续 Spin，而非执行原计划中的换人。

## 控制效果的估值问题

Mew 的 Taunt 使一个真实终点从未受控对照的 193.162 降到 68.519。价值差 124.644 中，约 120 来自对手全队对 Chansey 的 check、counter、持续防守和当前威胁覆盖变化。不能把这个差全部解释为当前 Chansey 对 Mew 的即时损失，也不能直接删去 Taunt：当前 Mew 可以续控。

合法条件路径中，Mew 换 Zapdos、Chansey 连续 Seismic Toss、Zapdos 回应 Heat Wave；结算实际伤害和入场代价后，Taunt 剩余 2 → 1 → 0，价值为 68.519 → 81.503 → 203.437。相同最终状态若人为保留 Taunt，价值为 84.494。静态对位没有使用剩余时长，因而将临时失去回复能力传播到不能续控的其他对手。进一步校准须同时保留到期之前的生存和接应代价，不能免费清除控制。

仅向 `directional` 补入目标 volatile 控制的试验没有采用：Chansey 对 Mew 的 counter 本已为零，新增计算只改变未直接参与全队价值的 entrySustain。016 行动、394 节点和完整 reasoning 均不变，额外计算没有解决排序问题。

## 后续依据

公开日志可以还原固定控制时长时，搜索应正确模拟其自然结束；随机或未观察到开始的时长不能凭空补成确定值。计时正确性与静态长期估值校准是不同层次，不能用修好计时冒充已解决全部循环。

原始材料：`/tmp/hard-016-calibration/REPORT.md`、`three-turn.json`、`three-turn.js`、`exact-state-diff.json`、`cross-control.json`。016 和 024 保留作后续校准与回归，不将这两例作为强制策略补丁的依据。

## 公开控制计时验证

`volatileTurns` 保存 Taunt／Encore 已知剩余残余结算次数。Tracker 依据公开开始／结束、行动、入场、回合和 upkeep 事件构造，不读取 PS 隐藏 duration 或已提交行动。预测转移复用格式的固定时长定义；Gen 5+ 后手施加多一回合，Taunt 对本回合新上场目标除外。真实与预测计时共用同一字段，克隆分支独立，换人清除；Encore 已知被锁招 PP 耗尽时提前解除。随机时长或未知年龄给出不支持推演的明确原因，不抽样、不猜确定值。

`test/server/npc/control-durations.js` 的 22 项回归以 PS 公开协议和己方 request 对照固定世代、快慢顺序、换入、cant、upkeep、分支克隆、随机未知与 PP0。全部 NPC 回归 1705 passing、1 pending，TypeScript 与 diff 检查通过。修改后的 projection、move-effects 和新测试 ESLint 通过；state-builder、types、tracker 的既存 lint 错误已与 HEAD 基线核对，未新增错误。

计时修复不等于解决静态长期控制估值，也不改变上面的三回合校准结论。复现和测试材料：`/tmp/hard-control-duration/`。
