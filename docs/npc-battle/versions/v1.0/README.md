# v1.0 - 基础对战系统

**发布日期**: 2026-01-21
**状态**: ✅ 已发布
**里程碑**: 实现 NPC 对战基础框架

---

## 概述

v1.0 版本实现了 NPC 对战的基础功能，包括 NPC 模板系统、BasicAI 智能、聊天命令接口，以及对单打、双打、随机对战的支持。

## 核心功能

### 1. NPC 模板系统
- 定义 NPC 的名称、难度、队伍配置
- 支持多个 NPC 模板
- 配置文件: `data/npc/templates.json`

### 2. BasicAI
简单 AI，优先使用最大伤害的攻击招式。

**决策逻辑**:
- 计算 基础威力 × STAB × 属性克制
- 检查类型免疫、特性免疫
- 不使用状态招式
- 不主动换人

### 3. 聊天命令
- `/npc challenge <template>` - 挑战 NPC
- `/npc list` - 列出可用 NPC

### 4. 对战格式支持
- 单打 (Singles)
- 双打 (Doubles)
- 随机对战 (Random Battle)

---

## 技术架构

```
server/npc/
├── index.ts        # 模块入口
├── manager.ts      # NPCManager 模板管理
├── room.ts         # 对战房间创建
└── ai/
    ├── index.ts    # NPCBattleAI 基类
    └── basic.ts    # BasicAI 实现
```

---

## 文档索引

- [需求文档](./requirements.md) - 为什么做 v1.0
- [设计文档](./design.md) - 如何实现 v1.0
- [变更记录](./changelog.md) - v1.0.0 详细变更
- [AI 逻辑文档](../../ai-logic/BasicAI/logic.md) - BasicAI 决策逻辑

---

## 后续版本

v1.0 为 NPC 对战奠定了基础，v1.1 将引入 CFRU 评分系统，实现更智能的 NormalAI。

*最后更新: 2026-01-24*
