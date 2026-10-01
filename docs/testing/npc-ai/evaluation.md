# NPC AI 测试现状

## 测试结构

```
test/npc/ai/
├── run-tests.js              # 主测试运行器
├── test-utils.js             # 测试框架工具
├── type-effectiveness.test.js    # 属性相克
├── battle-tracker.test.js        # BattleTracker 追踪
├── multi-hit.test.js             # 多次攻击
├── damage-calc.test.js           # 伤害计算
├── doubles-partner.test.js       # 双打队友检查
├── contact-moves.test.js         # 接触招式风险
├── positives.test.js             # 正面评分
├── negatives.test.js             # 负面评分
├── switching.test.js             # 换人逻辑
└── multi-battle.test.js          # Multi Battle (v1.2)
```

**运行方式**：
```bash
node test/npc/ai/run-tests.js              # 全部运行 (348 用例)
node test/npc/ai/run-tests.js positives    # 单模块运行
```

---

## 测试方式

当前测试是**纯逻辑单元测试**：构造 mock 的 `AIPokemon`、`BattleState` 等对象，直接调用评分函数，断言返回值。

```javascript
test('负面评分: 电系招式对蓄电特性扣分', () => {
    const ctx = buildContext({
        move: { type: 'Electric', ... },
        target: { ability: 'Volt Absorb', ... }
    });
    const score = scoreNegatives(ctx);
    assert(score <= -10);
});
```

**优点**：快速、确定性、覆盖率高
**局限**：不经过 PS 协议，不验证真实对战环境中的数据格式

---

## 评估维度

NPC AI 开发过程中的评估分三层：

### 第一层：CFRU 源码对照（完整性）

以 CFRU C 代码为基准，逐函数/逐 case 对照：

| 模块 | CFRU case 数 | 已实现 | 完成率 |
|------|-------------|--------|--------|
| M1 工具函数 | 37 | 20 | ~60% |
| M2 负面评分 | ~55 | ~51 | ~95% |
| M3 正面评分 | ~19 | 19 | ~100% |

遗漏项按影响分级：P0（功能失效）> P1（明显偏差）> P2（精度不够）

详见 [CFRU-Migration-Checklist.md](../ai-logic/CFRU-Migration-Checklist.md)

### 第二层：单元测试（正确性）

348 个测试用例覆盖：
- 属性相克计算（含免疫、特性免疫）
- 伤害计算（含多段攻击、道具加成、天气修正）
- 评分规则（正面/负面各条规则的边界情况）
- 双打特殊逻辑（队友检查、扩散招式、目标选择）
- Multi Battle（多对手追踪、boost 同步）

### 第三层：实际对战验证（可用性）

通过真实对战观察 AI 行为，结合日志系统分析决策过程：

```
[AI T1 p2] vs Garchomp [CHOSEN]:
[AI T1 p2]   Earthquake: 117 (-5/22) [2HKO]
[AI T1 p2]     - Spread move damage reduction: -5
[AI T1 p2]     - Moderate damage (56%): +6
[AI T1 p2]   Iron Head: 105 (0/5)
```

**这是发现 Bug 最有效的环节**。23 个已记录 Bug 中，超过一半是在这一层发现的。

---

## 已暴露的测试盲区

从 Bug 记录中总结的测试无法覆盖的问题类型：

| 问题类型 | 典型 Bug | 为什么测试没抓住 |
|----------|---------|----------------|
| PS 协议格式差异 | Bug 9 (隐形岩 "move: " 前缀) | 测试直接用 ID，不经过协议解析 |
| 多进程架构限制 | Bug 4, 17 (无法访问 Battle 对象) | 测试在单进程内构造 mock |
| 位置/slot 约定 | Bug 22 (p4 用 'b' 不是 'a') | 测试硬编码了错误的假设 |
| 异步时序 | Bug 16 (request 重发导致循环) | 测试是同步的 |
| 数组索引 vs 属性值 | Bug 14 (filter 后索引变化) | 测试数据恰好索引=slot |

**关键教训**：这些 Bug 的共同特征是**测试和实现共享了同一个错误假设**。只有在真实环境中运行才能暴露。

---

*最后更新: 2026-06-05*
