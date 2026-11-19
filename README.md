# Pokemon Showdown — NPC 对战系统（二次开发）

> 本项目基于 [smogon/pokemon-showdown](https://github.com/smogon/pokemon-showdown)（MIT）二次开发，
> 新增**玩家 vs 电脑（NPC）的对战系统**：单打 / 双打 / 多人组队，AI 决策逻辑移植自
> [Complete-Fire-Red-Upgrade](https://github.com/Skeli789/Complete-Fire-Red-Upgrade) 的 `src/Battle_AI/`。
>
> A fork of [smogon/pokemon-showdown](https://github.com/smogon/pokemon-showdown) (MIT) that adds a
> player-vs-NPC battle system (singles / doubles / multi), with AI logic ported from
> [Complete-Fire-Red-Upgrade](https://github.com/Skeli789/Complete-Fire-Red-Upgrade).

## 二次开发内容

| 模块 | 位置 | 说明 |
|------|------|------|
| NPC 对战系统 | `server/npc/` | 模板管理、房间创建、AI 轮询驱动 |
| NPC AI | `server/npc/ai/` | `BasicAI`（最大伤害）、`NormalAI`（CFRU 评分）、`HardAI`（配置推断与单打搜索）、`NPCMultiManager`（多人协调） |
| CFRU 移植层 | `server/npc/ai/cfru/` | 评分引擎、伤害计算、`BattleTracker` 协议黑板、日志 |
| NPC 数据 | `data/npc/` | `templates.json` 模板 + `teams/*.json` 队伍 |
| 聊天命令 | `server/chat-plugins/npc.ts` | `/npc` 系列命令、`view-npc` 页面 |
| 自定义格式 | `config/formats.ts` | `[Gen 9] National Dex Multi`（`gameType: 'multi'`，每人 3 只） |
| 数值平衡 | `data/pokedex.ts` | 部分精灵种族值调整，记录见 `data/changelog.md` |
| 队伍转换工具 | `tools/convert-team.js` | PS 文本队伍 → NPC JSON，自动写回 `templates.json` |
| 测试 | `test/npc/ai/` | 348 个单元用例：`node test/npc/ai/run-tests.js` |

**AI 难度**：Basic、Normal（Smart）和 Hard 可用，Expert 仍在规划中。各模式的支持范围见 [AI 逻辑](docs/ai-logic/README.md)。

## 快速开始

```bash
npm install
npm run build          # 构建（必须，NPC 模块也在此编译）
node pokemon-showdown start --no-security
```

进入客户端后用 `/npc` 打开 NPC 列表（`/npc challenge`、`/npc random`、`/npc multi` 等）。

## 文档

中文开发文档入口见 [docs/README.md](docs/README.md)（架构、AI 逻辑、版本历史、已知问题、测试体系）。
协作规范见 [CLAUDE.md](CLAUDE.md)。

## 声明

上游代码与文档版权归 smogon/pokemon-showdown 及其贡献者所有，遵循 MIT 许可证（见 [LICENSE](LICENSE)）。
本项目新增代码同样以 MIT 发布；第三方来源与移植说明见 [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md)。

---

# 文档索引

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
