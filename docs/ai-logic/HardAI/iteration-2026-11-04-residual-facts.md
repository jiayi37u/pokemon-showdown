# Hard 回合末事件跨 HP 复用

## 计算边界

持续净损耗评价需要以攻击后的 HP 重新结算回合末效果，但不必为每个 HP 重建相同事件列表。Hard 的正数 `maxHp` 合同下，事件金额与顺序依赖最大 HP、状态及计数、道具、特性、volatile、规则和场地，不读取当前 HP。

`CombatantFacts` 缓存有序事件列表，另按对手有效特性区分 Bad Dreams。静态竞速不包含 Wish；公共结算工具保留 Wish 金额、`beforeOrder` 和完整原调用方式。每次仍根据实际 HP 应用同一序列，执行回复上限、提前阵亡和 `perish0`。不缓存最终 HP，也不按血量近似分桶。Normal 的调用及策略不变。

`residualEvents` 仍由公共模块构造；`getEffectiveHpAfterSecondary` 接受内部已准备的事件列表，应用过程共用原实现。没有重复维护剩饭、天气或异常状态机制。公共工具对缺失最大 HP 的回退可能读取当前 HP，不属于 Hard 缓存的适用状态。

## 验证

3584 组世代、HP、异常状态、剩饭、天气、地形和 Bad Dreams 组合，完整 Assessment 与改动前逐项一致。永久回归覆盖回复上限、沙暴先行击倒后剩饭不能复活，以及对手 Bad Dreams 改变时的对位缓存区分。

全部 NPC 回归：1682 passing、1 pending；TypeScript 和 Hard 改动文件 ESLint 通过。公共 `damage-calc.ts` 有 16 个既存 ESLint 错误，以 HEAD 原文件验证得到相同错误，改动行没有新增错误。diff 检查通过。

材料：`/tmp/hard-residual-facts/grid.js`、`grid-result.json`、`full-tests.log`、`baseline-lint.log`。初步 Slowbro 和 011 回放完整 reasoning 一致；生产版冻结 batch 对照单独记录，避免把重叠负载的初步耗时当作稳定提速。

## 生产版冻结 batch 对照

7 个现有快照各运行两版，14 个独立冷进程串行交错完成。除 `matchups` 与公共残余模块外，其余 AI 模块完全相同；两版事件构建计数采用同一轻量插桩。没有时间上限或配置截断。

| 快照 | 决策耗时：基线 → 缓存事件 | 事件构建次数：基线 → 缓存事件 |
| --- | ---: | ---: |
| 016 | 4.537 → 4.338 s | 92519 → 20117 |
| 024 T35 | 2.158 → 2.063 s | 35445 → 9326 |
| 024 T52 | 5.993 → 5.506 s | 115711 → 28135 |
| 024 T59 | 4.798 → 4.438 s | 89165 → 21853 |
| Slowbro | 4.441 → 4.098 s | 83233 → 17311 |
| Diancie | 2.077 → 2.030 s | 30082 → 7040 |
| 011 | 53.154 → 50.618 s | 629795 → 139292 |

7/7 最终行动、完整 reasoning 和节点数完全一致。事件构建合计 1075950 → 243074，减少 77.41%；合计决策耗时 77.159 → 73.091 秒，减少 5.27%。011 节点保持 25689，maxRSS 996.7 → 800.4 MiB；其他快照 RSS 有升有降。每例每模式一次，不将时间或 RSS 比例外推为稳定总体收益。

原始材料：`/tmp/hard-residual-production/REPORT.md`、`comparison.json`、`manifest.json` 及冻结模块。
