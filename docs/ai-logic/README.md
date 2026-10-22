# AI 逻辑文档

本目录聚焦 **AI 决策逻辑**，不涉及服务端集成细节。

## AI 难度等级

| 难度 | 类名 | 状态 | 说明 |
|------|------|------|------|
| Basic | BasicAI | ✅ 可用 | 优先最大伤害 |
| Normal | NormalAI | ✅ 策略固定 | CFRU 基础评分；保留正确性修复 |
| Hard | HardAI | ✅ 可用，持续调优 | 公开证据约束配置、单打对位价值与两回合搜索；其他局面使用战术评分和换人，见 [Hard 逻辑](./HardAI/logic.md) |
| Expert | ExpertAI | ⏳ 计划中 | 完整策略 + 双打协作 |

## 文档结构

Basic / Normal 的文档按以下结构组织；Hard 的实现和迁移边界集中在 `HardAI/logic.md`：

Hard 的主要计算说明：[对位与单只精灵价值](./HardAI/logic.md#对位关系和单只精灵的价值)、[对手回应预测](./HardAI/logic.md#对手回应预测)、[局面价值与两回合搜索](./HardAI/logic.md#局面价值和两回合搜索)。

```
BasicAI/
├── logic.md          # 决策逻辑 (中文自然语言，含计算细节)
├── implementation.md # 技术实现 (代码结构、类型定义)
└── integration.md    # PS 接入 (输入输出格式)
```

### logic.md - 决策逻辑

用中文自然语言描述 AI 的决策过程，包含：
- 决策流程图
- 评分计算细节
- 示例场景

**目标读者**: 需要理解或调整 AI 行为的人

### implementation.md - 技术实现

描述代码实现细节，包含：
- 类结构和方法
- 类型定义
- CFRU 源码对照

**目标读者**: 需要修改代码的开发者

### integration.md - PS 接入

描述如何与 Pokemon Showdown 交互，包含：
- 输入数据格式 (request)
- 输出格式 (choose 命令)
- 协议消息解析

**目标读者**: 需要理解数据流的开发者

## CFRU 迁移

AI 逻辑移植自 CFRU (Complete-Fire-Red-Upgrade) 项目。

- [CFRU 迁移对照清单](./CFRU-Migration-Checklist.md) - 功能迁移状态追踪，包含：
  - 评分系统 (negatives/positives) 迁移状态
  - 迁移中的模块：切换决策、战斗风格、招式预测；待实现双打协作

- [CFRU 迁移复查报告](./CFRU-Review-Report.md) - 详细复查结果，包含：
  - M1-M3 模块的已实现/遗漏功能对照
  - P0/P1/P2 级别修复优先级
  - 完成率统计和主要差距分析

**CFRU 源码位置**: `/home/lvjiawei.376/myproj/Complete-Fire-Red-Upgrade/src/Battle_AI/`

---

*最后更新: 2026-10-22*
