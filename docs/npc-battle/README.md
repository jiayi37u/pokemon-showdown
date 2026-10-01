# NPC 对战系统

## 项目概述

NPC 对战功能允许用户与电脑控制的对手进行对战，支持可配置的难度等级和队伍配置。AI 逻辑移植自 **Complete-Fire-Red-Upgrade (CFRU)** 项目。

## 当前状态

**版本**: v1.2.17
**进度**: BasicAI、NormalAI、Multi NPC 可用

| 组件 | 状态 | 说明 |
|------|------|------|
| BasicAI | ✅ 可用 | 简单 AI，优先最大伤害 |
| NormalAI | ✅ 可用 | CFRU 评分系统，基本调试完成，少量细节遗漏 |
| Multi NPC | ✅ 可用 | 两名玩家组队对战 NPC (v1.2) |
| HardAI | ⏳ 待开发 | 战斗风格 + 预测系统 (v1.3) |
| ExpertAI | ⏳ 待开发 | 完整策略 + 双打协作 (v1.4) |

## 核心需求

1. **NPC 模板系统** - 定义 NPC 的名称、难度、队伍
2. **多难度 AI** - Basic/Normal/Hard/Expert 四档
3. **战斗格式支持** - 单打、双打、随机对战
4. **对手信息追踪** - 通过协议消息追踪对手状态
5. **多人组队对战** - 两名玩家组队对战 NPC (v1.2)

## 架构认知

### 架构认知

AI 运行在主进程，无法直接访问子进程中的 `Battle` 对象。通过监听战斗协议消息追踪对手状态。

详见 [服务端集成架构](./arch/server-integration.md)。

## 文档索引

### 版本开发工作流

每个版本按以下流程推进：

```
ROADMAP.md          → 定义里程碑和版本目标
    ↓
versions/vX.Y/
  requirements.md   → 细化需求分析
    ↓
  design.md         → 技术方案设计
    ↓
  changelog.md      → 开发中持续追加（Bug修复、迭代记录）
    ↓
  README.md         → 发版冻结后撰写版本总结
```

## 文档索引

### 版本文档
- [技术路线图](./ROADMAP.md) - 里程碑规划
- [变更索引](./CHANGELOG.md) - 各版本摘要与链接
- [v1.0 基础对战](./versions/v1.0/) - 需求、设计、变更
- [v1.1 CFRU 评分](./versions/v1.1/) - 需求、设计、变更
- [v1.2 多人组队对战](./versions/v1.2/) - 需求、设计、变更

### 技术文档
- [服务端集成架构](./arch/server-integration.md)
- [已知问题与解决方案](./troubleshooting/known-issues.md)
- [AI 系统概述](../ai-logic/README.md)
- [CFRU 迁移清单](../ai-logic/CFRU-Migration-Checklist.md)

## 代码结构

```
server/npc/
├── index.ts              # 模块入口
├── manager.ts            # NPCManager 模板管理
├── room.ts               # 对战房间创建与 AI 轮询
└── ai/
    ├── index.ts          # NPCBattleAI 基类
    ├── basic.ts          # BasicAI 实现
    ├── normal.ts         # NormalAI 实现
    └── cfru/             # CFRU 移植模块
        ├── types.ts      # 类型定义
        ├── state-builder.ts  # 状态构建
        ├── scoring/      # 评分系统
        └── util/         # 工具函数

data/npc/
├── templates.json        # NPC 模板定义
└── teams/                # NPC 队伍文件
```

---

*最后更新: 2026-06-05*
