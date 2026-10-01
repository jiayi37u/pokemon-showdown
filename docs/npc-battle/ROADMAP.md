# NPC 对战系统 - 技术路线图

## 里程碑概览

| 里程碑 | 版本 | 内容 | CFRU 源文件 | 状态 |
|--------|------|------|-------------|------|
| M1 | v1.1 | 工具函数 (伤害/速度) | ai_util.c, damage_calc.c | ✅ 完成 |
| M2 | v1.1 | 负面评分规则 | ai_negatives.c | ✅ 完成 |
| M3 | v1.1 | 正面评分规则 | ai_positives.c | ✅ 完成 |
| M4 | v1.1 | NormalAI 整合 | - | ✅ 完成 |
| M-Multi | v1.2 | 多人组队对战 NPC | - | 🚧 规划中 |
| M5 | v1.3 | 切换决策系统 | ai_switching.c | ⏳ 待开始 |
| M6 | v1.3 | 战斗风格识别 | ai_advanced.c | ⏳ 待开始 |
| M7 | v1.3 | 招式预测系统 | ai_advanced.c | ⏳ 待开始 |
| M8 | v1.3 | HardAI 整合 | - | ⏳ 待开始 |
| M9 | v1.4 | 双打协作逻辑 | ai_partner.c | ⏳ 待开始 |
| M10 | v1.4 | ExpertAI 整合 | - | ⏳ 待开始 |

## 当前进度

**进行中**: v1.2 多人组队对战 NPC 需求设计

**已完成**:
- 评分引擎框架 (types.ts, scoring/)
- 负面评分规则 (negatives.ts)
- 正面评分规则 (positives.ts)
- 伤害计算 (damage-calc.ts)
- 速度比较 (speed.ts)
- BattleTracker 对手追踪
- Boosts 追踪
- Quark Drive/Protosynthesis 追踪
- 多次攻击伤害计算
- AI 决策日志系统

## 版本规划

### v1.2 - 多人组队对战 NPC (规划中)

**M-Multi: 多人组队对战 NPC**

两名玩家组队 (p1+p3) 对战 NPC (p2+p4)：

```
              Team 1                    Team 2
        ┌─────┐  ┌─────┐          ┌─────┐  ┌─────┐
        │ p1a │  │ p3a │          │ p2a │  │ p4a │
        │(3只)│  │(3只)│    VS    │(3只)│  │(3只)│
        └─────┘  └─────┘          └─────┘  └─────┘
```

**实现阶段**:
- Phase 1: 格式定义 `[Gen 9] National Dex Multi`
- Phase 2: 房间创建流程
- Phase 3: NPCManager 协调器
- Phase 4: 集成测试

**核心组件**:
- NPCManager - 统一协调 p2+p4 的 AI 决策
- 虚拟双打状态构建 - 合并 p2+p4 视角
- Request 同步机制 - 处理异步 request

详见 [v1.2 版本文档](./versions/v1.2/README.md)。

### v1.3 - HardAI (计划中)

**M5: 切换决策系统**
- 切换条件检查 (灭亡之歌、神奇守护、特性吸收等)
- 切换目标评分
- 切换时机判断

**M6: 战斗风格识别**
- 11 种单打风格分类
- 8 种双打风格分类
- 风格影响评分权重

**M7: 招式预测系统**
- 对手招式预测
- 切换预测
- 预测影响决策

**M8: HardAI 整合**
- 整合 M5-M7 功能
- 调优评分权重
- 测试与调试

### v1.4 - ExpertAI (计划中)

**M9: 双打协作逻辑**
- 队友保护
- 扩散招式评估
- 协同攻击

**M10: ExpertAI 整合**
- 完整信息模式可选
- 高级策略
- 长期规划
- 保存成本地文件，服务重启时可以读取

### 未来优化方向 - 使用率数据系统

**背景**: 当前 AI 无法推断未揭露的对手特性、性格、努力值。可以利用竞技对战的使用率数据来进行概率推断。

**核心思路**: 预设高使用率配置，帮助 AI 做出更准确的判断。

**示例 - 胡地 (Alakazam)**:
```typescript
{
    "alakazam": {
        abilities: { "Magic Guard": 0.85, "Inner Focus": 0.10, "Synchronize": 0.05 },
        natures: { "Timid": 0.75, "Modest": 0.20 },
        evSpreads: [
            { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252, usage: 0.70 },
            { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252, usage: 0.20 }
        ],
        commonMoves: ["Psychic", "Shadow Ball", "Focus Blast", "Nasty Plot"]
    }
}
```

**应用场景**:
| 场景 | 当前处理 | 使用率优化后 |
|------|---------|--------------|
| 特性推断 | 未知时不扣分 | 85% Magic Guard → 部分扣分 |
| 伤害计算 | 假设 85 EV (平均) | 使用 252 SpA 计算 |
| 速度比较 | 假设基础速度 | 考虑 Timid + 252 Spe |
| 招式预测 | 无预测 | 预测常用招式池 |

**实现计划**:
1. **Phase 1**: 手动维护 OU/UU 常用宝可梦数据
2. **Phase 2**: 从 Smogon 使用率数据自动导入
3. **Phase 3**: 根据对战观察动态调整概率

**优先级**: P2 (M5-M8 完成后)

---

### v2.0 - NPC 锦标赛 (远期)

- 连续 NPC 对战
- 成就系统
- 排行榜

## CFRU 迁移进度

| CFRU 文件 | 里程碑 | PS 实现 | 进度 |
|-----------|--------|---------|------|
| ai_util.c, damage_calc.c | M1 | util/damage-calc.ts, util/speed.ts | ✅ 核心完成 |
| ai_negatives.c | M2 | scoring/negatives.ts | ✅ 核心完成 |
| ai_positives.c | M3 | scoring/positives.ts | ✅ 核心完成 |
| - | M4 | NormalAI 整合 | ✅ 核心完成 |
| ai_switching.c | M5 | - | ⏳ 待开始 |
| ai_advanced.c | M6-M7 | - | ⏳ 待开始 |
| - | M8 | HardAI 整合 | ⏳ 待开始 |
| ai_partner.c | M9 | - | ⏳ 待开始 |
| - | M10 | ExpertAI 整合 | ⏳ 待开始 |

详细迁移清单见 [CFRU-Migration-Checklist.md](../ai-logic/CFRU-Migration-Checklist.md)，包含各模块的迁移状态和待实现功能列表。

---

*最后更新: 2026-01-24 (v1.2 规划 - 多人组队对战 NPC)*
