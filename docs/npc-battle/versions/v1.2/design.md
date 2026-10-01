# v1.2 设计文档 - 多人组队对战 NPC

## 方案概述

采用 **方案 A: Multi 格式 + NPCManager 协调**

```
玩家1 (p1, 3只) ─┐              ┌─ NPC (p2, 3只) ─┐
                 ├─ Team 1  vs  ─┤                 ├─ NPCManager 统一协调
玩家2 (p3, 3只) ─┘              └─ NPC (p4, 3只) ─┘
```

---

## PS 原生 Multi Battle 机制

### 格式定义

```javascript
// config/formats.ts
{
    name: "[Gen 9] Multi Random Battle",
    gameType: 'multi',
    team: 'random',
    ruleset: ['Max Team Size = 3', ...]  // 每人3只
}
```

### 场地布局

```
              Team 1                    Team 2
        ┌─────┐  ┌─────┐          ┌─────┐  ┌─────┐
        │ p1a │  │ p3a │          │ p2a │  │ p4a │
        │(3只)│  │(3只)│    VS    │(3只)│  │(3只)│
        └─────┘  └─────┘          └─────┘  └─────┘

        p1 + p3 共享 sideConditions
        p2 + p4 共享 sideConditions
```

### 敌对关系 (sim/battle.ts:1869-1877)

```typescript
// gameType === 'multi' 时的初始化
this.sides[0].foe = this.sides[3];  // p1 的 foe 是 p4
this.sides[1].foe = this.sides[2];  // p2 的 foe 是 p3
this.sides[2].foe = this.sides[1];  // p3 的 foe 是 p2
this.sides[3].foe = this.sides[0];  // p4 的 foe 是 p1

this.sides[0].allySide = this.sides[2];  // p1 的同盟是 p3
this.sides[1].allySide = this.sides[3];  // p2 的同盟是 p4
this.sides[2].allySide = this.sides[0];  // p3 的同盟是 p1
this.sides[3].allySide = this.sides[1];  // p4 的同盟是 p2

// 同盟共享 sideConditions
this.sides[2].sideConditions = this.sides[0].sideConditions;
this.sides[3].sideConditions = this.sides[1].sideConditions;
```

### 邀请流程

1. **创建对战**: 设置 `delayedStart: 'multi'`
2. **显示邀请表单**: 让现有玩家邀请其他玩家
   ```
   /invitebattle @用户, p3
   /invitebattle @用户, p4
   ```
3. **接受邀请**: 被邀请者执行 `/acceptbattle`，提交队伍
4. **开始对战**: 4人全部就位后自动开始

### 关键代码位置

| 功能 | 文件 | 行号 |
|------|------|------|
| Multi 格式定义 | config/formats.ts | 83-94 |
| 敌对/同盟关系初始化 | sim/battle.ts | 1869-1880 |
| allySide 属性定义 | sim/side.ts | 163-164 |
| 邀请表单 | server/room-battle.ts | 1225-1248 |
| /invitebattle 命令 | server/chat-commands/core.ts | 1172-1238 |
| /acceptbattle 命令 | server/chat-commands/core.ts | 1243-1272 |
| BattleInvite 类 | server/ladders-challenges.ts | 78-93 |

---

## 格式定义

```javascript
// 在 config/formats.ts 中添加
{
    name: "[Gen 9] National Dex Multi",
    mod: 'gen9',
    gameType: 'multi',           // 4人对战，每人1只active
    searchShow: false,
    tournamentShow: false,
    rated: false,
    ruleset: [
        'Standard Doubles',      // 复用双打基础规则
        'NatDex Mod',            // National Dex 机制
        'Evasion Abilities Clause',
        'Max Team Size = 3',     // 每人3只
    ],
    banlist: [
        // 复用 National Dex Doubles 的 banlist
        'Annihilape', 'Arceus', 'Calyrex-Ice', 'Calyrex-Shadow',
        'Deoxys-Attack', 'Dialga', 'Dialga-Origin', 'Espathra',
        // ... 其他禁止项
    ],
}
```

**格式对比**:

| 属性 | National Dex Doubles | National Dex Multi (新) |
|------|---------------------|------------------------|
| gameType | `doubles` | `multi` |
| playerCount | 2 | 4 |
| 每人控制 | 2只 active | 1只 active |
| 队伍大小 | 6只 | 3只 |
| 规则基础 | Standard Doubles + NatDex | 相同 |

---

## NPCManager 设计

### 核心思路

虽然 NPC 被拆成 p2 和 p4 两个 side，但由一个 NPCManager 统一协调决策，保留双打协作能力。

### 架构图

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

### 关键组件

```typescript
class NPCManager {
    private tracker: BattleTracker;  // 复用现有追踪器
    private scorer: CFRUScoring;     // 复用现有评分系统

    // 缓存两个 side 的 request，等待同步
    private pendingRequests: {
        p2?: Request;
        p4?: Request;
    } = {};

    /**
     * 接收单个 side 的 request
     * 等两边都收到后统一决策
     */
    receiveRequest(side: 'p2' | 'p4', request: Request) {
        this.pendingRequests[side] = request;

        // 两边都准备好了，开始决策
        if (this.pendingRequests.p2 && this.pendingRequests.p4) {
            this.makeCoordinatedDecision();
        }
    }

    /**
     * 统一决策：把 p2+p4 视为双打的两只精灵
     */
    private makeCoordinatedDecision() {
        // 1. 构建虚拟双打状态
        const virtualState = this.buildVirtualDoublesState(
            this.pendingRequests.p2!,
            this.pendingRequests.p4!
        );

        // 2. 复用现有评分系统
        //    - 评估所有招式（含双打队友检查）
        //    - 选择最优动作
        const decisions = this.evaluateDoubles(virtualState);

        // 3. 分别发送选择
        this.sendChoice('p2', decisions.p2Choice);
        this.sendChoice('p4', decisions.p4Choice);

        // 4. 清空缓存
        this.pendingRequests = {};
    }

    /**
     * 构建虚拟双打状态
     * 把 p2 和 p4 的 active 精灵合并，模拟标准双打视角
     */
    private buildVirtualDoublesState(p2Req: Request, p4Req: Request): VirtualState {
        return {
            self: {
                active: [
                    this.extractActivePokemon(p2Req),  // 位置 0
                    this.extractActivePokemon(p4Req),  // 位置 1
                ],
                // p2 和 p4 的后备精灵合并（用于换人评估）
                reserve: [
                    ...this.extractReserve(p2Req),
                    ...this.extractReserve(p4Req),
                ],
            },
            opponents: this.tracker.getActiveOpponents(),  // p1 和 p3
            field: this.tracker.getFieldState(),
        };
    }
}
```

### Request 同步机制

Multi 格式中，p2 和 p4 的 request 可能不同时到达（如一方被 trapped）。NPCManager 需要处理：

```typescript
// 情况1: 两边都需要选择 → 等待同步后统一决策
// 情况2: 只有一边需要选择 → 单独处理该 side
// 情况3: forceSwitch → 立即处理，不等待另一边

receiveRequest(side: 'p2' | 'p4', request: Request) {
    if (request.forceSwitch) {
        // 强制换人，立即处理
        this.handleForceSwitch(side, request);
        return;
    }

    if (request.wait) {
        // 该 side 等待中，标记并跳过
        this.pendingRequests[side] = null;
        return;
    }

    this.pendingRequests[side] = request;
    this.tryMakeDecision();
}
```

### 与现有系统的集成

| 现有组件 | 复用方式 |
|---------|---------|
| BattleTracker | 扩展支持追踪 p1/p3 两个对手 |
| CFRUScoring (negatives/positives) | 直接复用，传入虚拟状态 |
| 双打队友检查 | 直接复用，p2 和 p4 互为"队友" |
| 伤害计算 | 直接复用 |

---

## 房间创建流程

```
┌─────────────────────────────────────────────────────────────┐
│  1. p1 (玩家1) 发起 /npc multi [npcId]                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. 创建房间                                                 │
│     players: [p1_user, p2_npc, null, p4_npc]                │
│     delayedStart: 'multi'                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. 显示定制邀请表单（只显示 p3 邀请选项）                     │
│     "邀请队友加入对战"                                        │
│     [p3: 输入用户名] [邀请]                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. p1 执行 /invitebattle @玩家2, p3                         │
│     → 发送邀请给玩家2                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. 玩家2 执行 /acceptbattle，提交队伍                        │
│     → 玩家2 加入 p3 位置                                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  6. 4人齐备，启动战斗                                         │
│     - 启动 NPCManager (监听 p2 和 p4 的 request)             │
│     - battle.started = true                                 │
└─────────────────────────────────────────────────────────────┘
```

### 能复用的部分

| 功能 | 代码位置 | 复用方式 |
|------|---------|---------|
| 创建4人房间 | `Rooms.createBattle` | 直接复用 |
| 邀请机制 | `/invitebattle`, `/acceptbattle` | 直接复用 |
| 邀请表单 | `sendInviteForm` | 需定制（只显示 p3） |
| 玩家加入检测 | `joinGame` | 直接复用 |

### 需要定制的部分

1. **创建时预填 p2 和 p4 为 NPC**（而不是留空等邀请）
2. **邀请表单只显示 p3**（p2/p4 已被 NPC 占用）
3. **p3 加入后启动 NPCManager**

---

## NPC 队伍配置

复用现有 doubles 队伍文件，通过新增字段标明精灵归属：

```json
// data/npc/teams/gym-brock-gen9doublesou.json
[
  {
    "name": "Tyranitar",
    "species": "Tyranitar",
    "ability": "Sand Stream",
    "moves": ["Rock Slide", "Crunch", "Earthquake", "Protect"],
    "item": "Assault Vest",
    "nature": "Adamant",
    "evs": { "hp": 252, "atk": 252, "spe": 4 },
    "slot": "p2"    // 归属 p2
  },
  {
    "name": "Excadrill",
    "species": "Excadrill",
    "ability": "Sand Rush",
    "moves": ["Iron Head", "Earthquake", "Rock Slide", "Protect"],
    "item": "Life Orb",
    "nature": "Jolly",
    "evs": { "atk": 252, "spe": 252, "hp": 4 },
    "slot": "p4"    // 归属 p4
  },
  // ... 共6只，p2和p4各3只
]
```

**字段说明**:

| 字段 | 值 | 说明 |
|------|-----|------|
| `slot` | `"p2"` | 该精灵归属 NPC 的 p2 位置 |
| `slot` | `"p4"` | 该精灵归属 NPC 的 p4 位置 |
| (无) | - | 向后兼容：无此字段时用于普通双打 |

**加载逻辑**:

```typescript
// server/npc/manager.ts
function loadMultiTeam(teamFile: string): { p2: PokemonSet[], p4: PokemonSet[] } {
    const team = JSON.parse(fs.readFileSync(teamFile));
    return {
        p2: team.filter((p: any) => p.slot === 'p2'),
        p4: team.filter((p: any) => p.slot === 'p4'),
    };
}
```

---

## 方案对比分析

### 方案A: Multi 格式 + NPCManager (采用)

**优点**:
- 复用 PS 原生 multi 机制
- 队伍分离、换人限制天然支持
- 邀请流程已有现成实现
- NPCManager 可保留双打协调能力

**缺点**:
- NPC 队伍从6只拆成3+3只
- 需要新建 NPCManager 组件

### 方案B: Doubles 格式 + 玩家分控 (否决)

```
玩家1 + 玩家2 (共同控制 p1) ──────► NPC (p2, AI 控制)
       │                              │
       └─ 各控制一只精灵              └─ 控制两只精灵
```

**优点**:
- NPC AI 无需改动
- 现有评分系统完全复用

**缺点**:
- 需要自定义 request 分发机制
- 需要自定义 choose 合并机制
- 队伍分割和换人限制需要额外实现
- 两名玩家共享一个 side，可能有 UI/权限问题

### 方案C: 非对称 gameType (否决)

```
玩家1 (p1, 1只active) ─┐
                       ├─ allySide ──► NPC (p2, 2只active)
玩家2 (p3, 1只active) ─┘
```

**问题: PS sim 层假设对称结构**

| 代码位置 | 影响 | 问题 |
|---------|------|------|
| sim/side.ts:218-227 | Side.active 数组长度 | 当前按 gameType 统一设置，不支持每 side 不同 |
| sim/battle.ts:221-223 | activePerHalf 全局值 | 被 ~15 处代码依赖，假设所有 side 相同 |
| sim/dex-formats.ts:509 | playerCount | 只支持 2 或 4，不支持 3 |
| sim/pokemon.ts:768-773 | getLocOf 位置计算 | 假设每 side 的 active.length 相同 |
| sim/pokemon.ts:716-718 | adjacentFoes 目标选择 | 依赖 activePerHalf |

**需要的改动**:
1. Side.active 长度按 side 设置 - 改 side.ts
2. 废弃 activePerHalf，改用 side.activeCount - 改 battle.ts 及所有引用处
3. 支持 playerCount = 3 - 改 dex-formats.ts, room-battle.ts
4. 重写位置计算 getLocOf/getAtLoc - 改 pokemon.ts
5. 重写目标选择 adjacentFoes 等 - 改 pokemon.ts, battle.ts
6. 客户端渲染不对称战场 - 可能需要改客户端

**风险评估**:

| 风险项 | 等级 | 说明 |
|--------|------|------|
| sim 核心稳定性 | 高 | 多处代码假设对称结构，改动可能引入隐藏 bug |
| 测试覆盖 | 高 | 大量现有测试基于对称假设，需要重写 |
| 与 PS 主分支分歧 | 高 | 后续难以合并上游更新 |
| 客户端兼容 | 中 | 需要确认客户端能否渲染不对称战场 |
| 边界情况 | 高 | 招式效果、特性、道具可能有未预料的交互 |
| 开发周期 | 中 | 预计 2-4 周核心改动 + 大量测试 |

**结论**: 不推荐。虽然直观上更好理解，但实现难度和风险都很高。

---

## 需要修改的文件

| 文件 | 改动 | 复杂度 |
|------|------|--------|
| config/formats.ts | 添加 National Dex Multi 格式 | 低 |
| server/npc/room.ts | 新增 `createNPCMultiBattle` 函数 | 中 |
| server/npc/manager.ts | NPC 模板支持 multi 队伍配置 | 低 |
| server/npc/ai/multi-manager.ts | 新建 NPCManager 协调组件 | 中 |
| server/room-battle.ts | (可选) 定制邀请表单 | 低 |
| server/chat-plugins/npc.ts | 添加 `/npc multi` 命令 | 低 |

---

*最后更新: 2026-01-24*
