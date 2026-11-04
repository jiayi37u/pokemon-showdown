# Hard 同一对位竞速内复用行动顺序事实

同一次 `outlook` 的精灵、HP、场地及队列信息不变。每个实际参与竞速的己方招式只需解析一次优先级；每个对手回应惰性解析一次优先级；同优先级比较复用一次双方速度顺序。优先级不同不计算速度。

规则继续由公共 `effectivePriority` 和 `compareSpeedOrder` 提供。复用范围仅限当前调用，不把 Gale Wings 满血条件放进跨 HP 缓存，也不向局面写入伪造的 queuedSpeed。

原型两快照 choice、完整 reasoning、节点均一致。Slowbro 的速度计算 142432 → 39876，011 为 1569950 → 289084；优先级解析分别为 232982 → 147539、2173254 → 1249249。含计数插桩的单次耗时分别降低 5.17% 和 1.87%，不视为稳定性能结论。材料：`/tmp/hard-order-facts-nYZDAc/REPORT.md`。

3456 组公共顺序计算对照覆盖 Gen 6／7、满血／非满血、queuedPriorityAbility、queuedSpeed、Trick Room 及不同优先级，结果与 `compareActionOrder` 一致。永久 Pair 回归覆盖队列优先级、队列速度、戏法空间和同速；既有 Gale Wings HP 边界测试继续保留。

生产改动的对位、缓存、搜索专项测试 179 passing；TypeScript、ESLint、diff 检查通过。无插桩冻结 batch 对照另列，不能与原型计数耗时混为同一实验。

## 无计数插桩的冻结 batch

545 个运行模块冻结并记录 SHA，只替换 `matchups`。7 快照各两次，14 个进程串行交错全部正常结束。7/7 最终行动、完整 reasoning 和节点数完全一致。

| 快照 | 决策耗时：基线 → 局部复用 |
| --- | ---: |
| 016 | 4.092 → 3.973 s |
| 024 T35 | 2.068 → 2.076 s |
| 024 T52 | 5.488 → 5.368 s |
| 024 T59 | 4.620 → 4.394 s |
| Slowbro | 4.038 → 4.081 s |
| Diancie | 1.955 → 1.946 s |
| 011 | 49.738 → 48.872 s |

合计 72.001 → 70.710 秒，减少 1.79%；5 例更快，2 例略慢。011 的 maxRSS 820.2 → 1031.5 MiB，其他样本有升有降，不主张内存收益。每例每模式一次，不外推稳定提速比例。材料：`/tmp/hard-order-production/REPORT.md`、`comparison.json` 及冻结模块。
