# Pokemon Showdown NPC 对战系统 - 文档索引

## 文档结构

```
docs/
├── README.md                    # 本文件 - 纯索引
├── intro_ps.md                  # Pokemon Showdown 框架介绍
│
├── npc-battle/                  # NPC 对战系统 (项目概述与管理)
│   ├── README.md                # 项目概述、当前进展、代码结构
│   ├── CHANGELOG.md             # 版本索引 (指向各版本详细记录)
│   ├── arch/                    # 架构文档
│   │   └── server-integration.md  # 多进程架构、BattleTracker 设计
│   ├── versions/                # 版本文档 (每版本独立目录)
│   │   └── vX.Y/               # requirements → design → changelog → README
│   └── troubleshooting/
│       └── known-issues.md      # Bug 原因与解决方案
│
├── ai-logic/                    # AI 逻辑文档 (专注决策逻辑)
│   ├── README.md                # AI 系统概述 (难度等级、文档结构)
│   ├── CFRU-Migration-Checklist.md  # CFRU 迁移状态追踪
│   ├── BasicAI/                 # BasicAI - 优先最大伤害
│   │   ├── logic.md             # 决策逻辑 (中文自然语言)
│   │   ├── implementation.md    # 技术实现 (代码结构)
│   │   └── integration.md       # PS 接入 (输入输出格式)
│   └── NormalAI/                # NormalAI - CFRU 评分系统
│       ├── logic.md
│       ├── implementation.md
│       └── integration.md
│
└── testing/                     # 测试体系文档
    ├── README.md                # 测试总览 + 核心认知
    ├── ps-native/               # PS 原生测试基础设施
    │   └── simulator-testing.md # 单元测试 + 批量模拟 + 程序化对战 API
    └── npc-ai/                  # NPC AI 测试与评估
        └── evaluation.md        # 三层评估体系 + 已知盲区
```

## 快速入口

### 项目概述与架构
- [NPC 对战系统概述](./npc-battle/README.md) — 入口，当前状态、代码结构、CFRU 映射
- [服务端集成架构](./npc-battle/arch/server-integration.md)

### 测试体系
- [测试总览](./testing/README.md) — 核心认知：测试通过 ≠ 实际可用
- [PS 原生测试](./testing/ps-native/simulator-testing.md) — 单元测试 / 批量模拟 / 程序化对战 API
- [NPC AI 评估](./testing/npc-ai/evaluation.md) — 三层评估体系 + 已知盲区

### AI 决策逻辑
- [AI 系统概述](./ai-logic/README.md)
- [BasicAI 逻辑](./ai-logic/BasicAI/logic.md) - 优先最大伤害
- [NormalAI 逻辑](./ai-logic/NormalAI/logic.md) - CFRU 评分系统

### 版本历史
- [变更索引](./npc-battle/CHANGELOG.md) - 各版本摘要与链接
- [v1.0 基础对战](./npc-battle/versions/v1.0/README.md)
- [v1.1 CFRU 评分](./npc-battle/versions/v1.1/README.md)
- [v1.2 多人组队对战](./npc-battle/versions/v1.2/README.md)

### 问题排查
- [已知问题与解决方案](./npc-battle/troubleshooting/known-issues.md)
- [CFRU 迁移清单](./ai-logic/CFRU-Migration-Checklist.md)
