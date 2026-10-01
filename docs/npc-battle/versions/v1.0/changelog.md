# v1.0 变更记录

## [1.0.0] - 2026-01-21

### 新增功能

#### NPC 模板系统
- 新增 `NPCManager` 类，管理 NPC 模板
- 新增 `data/npc/templates.json` 配置文件
- 支持定义 NPC 的 ID、名字、难度、队伍文件

#### BasicAI
- 新增 `NPCBattleAI` 抽象基类
- 新增 `BasicAI` 实现
- 实现基础伤害计算（威力 × STAB × 克制）
- 实现类型免疫检查
- 实现特性免疫检查（蓄电、储水、引火、食草、飘浮）

#### 聊天命令
- 新增 `/npc challenge <template>` 命令
- 新增 `/npc list` 命令
- 新增 `/npc info <template>` 命令

#### 对战格式支持
- 支持单打 (gen9ou, gen9uu 等)
- 支持双打 (gen9doublesou 等)
- 支持随机对战 (gen9randombattle)

### 代码结构

新增文件：
```
server/npc/
├── index.ts              # 模块导出
├── manager.ts            # NPCManager
├── room.ts               # createNPCBattle
└── ai/
    ├── index.ts          # NPCBattleAI 基类
    └── basic.ts          # BasicAI

data/npc/
├── templates.json        # NPC 模板
└── teams/
    └── gym-brock.txt     # 示例队伍

server/chat-plugins/
└── npc.ts                # 聊天命令
```

### 技术细节

- 使用 PS 的 `RoomBattle.stream` 与模拟器通信
- 重写 AI 的 `choose` 方法以适配服务端命令格式 (`>p2 move 1`)
- NPC 固定为 p2 (对手方)

### 测试

- 新增 `test/npc/ai/basic.test.js`
- 测试覆盖: 伤害计算、免疫检查、STAB、克制

---

*v1.0 是第一个可用版本，后续版本将增强 AI 智能。*
