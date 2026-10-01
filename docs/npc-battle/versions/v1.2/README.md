# v1.2 - 多人组队对战 NPC

**计划日期**: 2026-01-24 ~
**状态**: ✅ 核心实现完成
**里程碑**: M-Multi (多人组队对战 NPC 双打)

---

## 概述

v1.2 版本实现多人组队对战 NPC 功能：两名玩家组队 (p1+p3) 对战 NPC (p2+p4)。

**核心特性**:
- 基于 PS 原生 Multi Battle 机制 (`gameType: 'multi'`)
- 两名玩家各控制一只精灵，各有 3 只后备
- NPC 通过 NPCManager 协调 p2+p4 两个位置，保留双打协作能力
- 复用现有 NormalAI 评分系统

**场地布局**:
```
              Team 1                    Team 2
        ┌─────┐  ┌─────┐          ┌─────┐  ┌─────┐
        │ p1a │  │ p3a │          │ p2a │  │ p4a │
        │(3只)│  │(3只)│    VS    │(3只)│  │(3只)│
        └─────┘  └─────┘          └─────┘  └─────┘

        p1 + p3 共享 sideConditions (玩家队)
        p2 + p4 共享 sideConditions (NPC 队)
```

---

## 实现阶段

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 格式定义 `[Gen 9] National Dex Multi` | ✅ 完成 |
| Phase 2 | 房间创建流程 | ✅ 完成 |
| Phase 3 | NPCManager 协调器 | ✅ 完成 |
| Phase 4 | 集成测试 | 🚧 部分完成 |

---

## 核心功能

### 1. 格式定义

新建 `[Gen 9] National Dex Multi` 格式：
- `gameType: 'multi'` - 4 人对战
- `Max Team Size = 3` - 每人 3 只
- 复用 Standard Doubles + NatDex 规则

### 2. NPCManager

协调 p2 和 p4 的决策，保留双打协作能力：

```
                    ┌─────────────────────────────────────┐
                    │           NPCManager                │
                    │  ┌─────────────────────────────┐    │
                    │  │      虚拟双打状态构建        │    │
                    │  │  p2.active + p4.active      │    │
                    │  │  → virtualDoublesState      │    │
                    │  └─────────────────────────────┘    │
                    │                 │                   │
                    │                 ▼                   │
                    │  ┌─────────────────────────────┐    │
                    │  │    现有评分系统 (复用)       │    │
                    │  │  - negatives.ts             │    │
                    │  │  - positives.ts             │    │
                    │  │  - 双打队友检查             │    │
                    │  └─────────────────────────────┘    │
                    │                 │                   │
                    │        ┌────────┴────────┐          │
                    │        ▼                 ▼          │
                    │   p2 decision       p4 decision     │
                    └────────┬─────────────────┬──────────┘
                             │                 │
                             ▼                 ▼
                      ">p2 move X"      ">p4 move Y"
```

### 3. 命令流程

```bash
# 1. 玩家1 发起邀请 (需要先选好队伍，最多 3 只)
/npc multi gymbrock, @玩家2

# 2. 玩家2 收到邀请通知

# 3. 玩家2 接受邀请 (需要先选好队伍，最多 3 只)
/npc acceptmulti 玩家1

# 4. 系统创建房间，战斗开始
# - p1: 玩家1, p2: NPC, p3: 玩家2, p4: NPC
```

**邀请机制**:
- 使用 PS 原生 `GameChallenge` 系统
- 邀请数据存储在 challenge 对象
- 双方都准备好后才创建房间，避免 placeholder 问题

### 4. NPC 队伍配置

复用现有 doubles 队伍文件，通过 `slot` 字段标明精灵归属：

```json
[
  { "name": "Tyranitar", "species": "Tyranitar", "slot": "p2" },
  { "name": "Excadrill", "species": "Excadrill", "slot": "p4" },
  // ... 共 6 只，p2 和 p4 各 3 只
]
```

---

## 技术决策

### 方案选择

| 方案 | 复用程度 | 改动范围 | 风险 | 结论 |
|------|---------|---------|------|------|
| A: Multi 格式 + NPCManager | 高 (PS 原生) | AI 层 | 低 | ✅ 采用 |
| B: Doubles + 分控 | 中 | server 层 | 中 | ❌ |
| C: 非对称 gameType | 低 | sim 核心 | 高 | ❌ |

**选择理由**:
1. 复用 PS 原生 multi 机制，改动可控
2. AI 层改造不影响 PS 核心稳定性
3. 与 PS 主分支保持兼容

### 非对称方案分析 (已否决)

方案 C 尝试创建一侧 doubles、另一侧 multi 的混合 gameType，但 PS sim 层假设对称结构：

| 代码位置 | 问题 |
|---------|------|
| `sim/side.ts:218-227` | Side.active 长度按 gameType 统一设置 |
| `sim/battle.ts:221-223` | activePerHalf 全局值被多处代码依赖 |
| `sim/pokemon.ts:768-773` | getLocOf 假设每 side 的 active.length 相同 |

风险过高，不推荐。

---

## 需要修改的文件

| 文件 | 改动 | 复杂度 |
|------|------|--------|
| config/formats.ts | 添加 National Dex Multi 格式 | 低 |
| server/npc/room.ts | 新增 `createNPCMultiBattle` 函数 | 中 |
| server/npc/ai/multi-manager.ts | 新建 NPCManager 协调组件 | 中 |
| server/chat-plugins/npc.ts | 添加 `/npc multi` 命令 | 低 |
| data/npc/teams/*.json | 添加 `slot` 字段 | 低 |

---

## 文档索引

- [需求文档](./requirements.md) - 详细需求分析
- [设计文档](./design.md) - 技术方案设计
- [变更记录](./changelog.md) - 开发变更记录

---

## 相关文档

- [PS Multi Battle 机制](../../arch/ps-multi-battle.md) - PS 原生 Multi Battle 研究
- [服务端集成架构](../../arch/server-integration.md) - 服务端架构说明

---

*最后更新: 2026-01-24*
