# 服务端集成架构

## 目录

1. [架构概述](#架构概述)
2. [数据获取方式](#数据获取方式)
3. [BattleTracker](#battletracker)
4. [格式等级解析](#格式等级解析-v127)
5. [AI 选择机制](#ai-选择机制)
6. [choose 命令格式](#choose-命令格式)
7. [双打特殊处理](#双打特殊处理-v1112)
8. [Multi Battle 架构](#multi-battle-架构-v12)
9. [选择错误处理](#选择错误处理-v1118)
10. [NPC 队伍配置系统](#npc-队伍配置系统-v1129)

---

## 架构概述

Pokemon Showdown 服务端采用**多进程架构**，战斗模拟器运行在单独的子进程中。

```
主进程 (Server)          子进程 (Simulator)
┌─────────────┐          ┌─────────────┐
│ RoomBattle  │◄─stream─►│   Battle    │
│ (房间管理)   │          │ (战斗模拟)   │
└─────────────┘          └─────────────┘
      ▲                         │
      │                         │
   AI 运行                  完整战斗状态
```

### 关键限制

- **AI 运行在主进程**，只能访问 `RoomBattle`
- **`Battle` 对象在子进程**，包含 `sides[]`、`p1.active[]` 等完整状态
- **无法直接访问对手信息**，必须通过协议消息追踪

> ⚠️ **常见错误 (Bug 17)**
>
> 不要尝试通过以下方式访问 sim Battle：
> ```typescript
> // ❌ 错误 - 返回 undefined
> const simBattle = roomBattle.stream?.battle;
> const opponent = simBattle.sides[0].active[0];
>
> // ❌ 错误 - roomBattle.p1 是 RoomBattlePlayer，不是 Side
> const pokemon = battle.p1.active;  // 这不是 Pokemon[]
> ```
>
> 正确做法是使用 **BattleTracker**：
> ```typescript
> // ✅ 正确
> const tracker = createBattleTracker('p2');
> tracker.attachToStream(roomBattle.stream);
> const opponent = tracker.getActiveOpponent();
> ```
>
> 详见 [Bug 17: Multi Battle 对手追踪失败](../troubleshooting/known-issues.md#bug-17-multi-battle-对手追踪失败)

---

## 数据获取方式

| 数据类型 | 获取方式 | 示例 |
|---------|---------|------|
| 己方精灵 | request 对象 | `request.side.pokemon[]` |
| 对手精灵 | 协议消息追踪 | `|switch|p1a: Name|Species|HP` |
| 招式信息 | Dex 查询 | `Dex.moves.get('earthquake')` |
| 场地状态 | 协议消息追踪 | `|-weather|Sandstorm` |

### Request 数据结构 (v1.2.8+)

PS 的 `request.side.pokemon[]` 包含己方精灵的完整信息：

```typescript
// sim/pokemon.ts:getSwitchRequestData() 返回的结构
interface PokemonSwitchRequestData {
    ident: string;       // "p2: Tyranitar"
    details: string;     // "Tyranitar, F" (注意: 默认等级时无 L100!)
    condition: string;   // "341/341" 或 "200/341 par"
    active: boolean;

    // 实际能力值 (非种族值!)
    stats: {
        atk: number;     // 例: 403
        def: number;     // 例: 256
        spa: number;     // 例: 203
        spd: number;     // 例: 236
        spe: number;     // 例: 159
    };

    moves: ID[];         // 招式列表
    baseAbility: ID;     // 基础特性
    item: ID;            // 道具
    ability?: ID;        // 当前特性 (Gen 7+)
    teraType?: string;   // 太晶属性 (Gen 9)
    // ...
}
```

> ⚠️ **关键发现 (Bug 21)**
>
> 1. **`mon.stats` 是实际能力值**，不是种族值！必须使用 `mon.stats` 而非 `Dex.species.get().baseStats`
> 2. **`details` 省略默认等级**：当等级是格式默认值时，不包含在 details 中
>    - 例：National Dex (Lv100) 显示 `"Tyranitar, F"` 而非 `"Tyranitar, L100, F"`
>    - VGC (Lv50) 会显示 `"Tyranitar, L50, F"`

### 己方 vs 对手数据来源对比

| 数据 | 己方 | 对手 |
|------|------|------|
| **能力值** | `mon.stats` (精确值) | 估算: `(2*base+31+21)*level/100+5` |
| **等级** | 从 `details` 解析，默认 L100 | `tracked.level` (从协议解析) |
| **HP** | `condition` 中的精确值 | 估算 + 百分比追踪 |
| **招式** | `moves[]` 完整列表 | 只有已暴露的招式 |
| **道具** | `item` 完整信息 | 只有已暴露/失去的道具 |
| **特性** | `ability`/`baseAbility` | 只有已暴露的特性 |

### 正确使用 Request 数据

```typescript
// ✅ 正确 - 使用 mon.stats 获取实际能力值
const actualStats = mon.stats ? {
    hp: maxHp,
    atk: mon.stats.atk,
    def: mon.stats.def,
    spa: mon.stats.spa,
    spd: mon.stats.spd,
    spe: mon.stats.spe,
} : fallbackStats;

// ✅ 正确 - 默认等级使用格式默认值 (通常 100)
const level = parseInt((details[1] || 'L100').replace('L', '')) || 100;

// ❌ 错误 - 使用种族值
const baseStats = Dex.species.get(species).baseStats;  // 这是种族值!

// ❌ 错误 - 默认等级使用 50
const level = parseInt((details[1] || 'L50').replace('L', '')) || 50;
```

---

## BattleTracker

共享的战斗状态追踪器，通过监听协议消息获取信息：

```typescript
// 单打/双打
const tracker = createBattleTracker('p2');
tracker.attachToStream(battle.stream);

// Multi Battle (v1.2.4+)
const tracker = createBattleTracker('p2', true);  // isMulti = true
tracker.attachToStream(battle.stream);

// 获取对手信息
const opponent = tracker.getActiveOpponent();      // 单打
const opponents = tracker.getActiveOpponents();    // 双打/Multi
```

### Multi Battle 支持 (v1.2.4+)

BattleTracker 支持 multi battle 追踪多个对手 side：

```typescript
// 构造函数签名
createBattleTracker(ourSide: 'p1' | 'p2' = 'p2', isMulti = false)

// 内部实现
constructor(ourSide, isMulti) {
    if (isMulti) {
        // p2/p4 的对手是 p1 AND p3
        this.opponentSides = new Set(ourSide === 'p2' ? ['p1', 'p3'] : ['p2', 'p4']);
    } else {
        this.opponentSides = new Set([ourSide === 'p1' ? 'p2' : 'p1']);
    }
}

private isOpponentSide(side: string): boolean {
    return this.opponentSides.has(side);
}
```

| 模式 | ourSide | opponentSides |
|------|---------|---------------|
| 单打/双打 | p2 | {p1} |
| Multi | p2 | {p1, p3} |

### 追踪的消息类型

| 消息 | 格式 | 追踪内容 |
|------|------|----------|
| switch | `\|switch\|p1a: Name\|Species, L50\|100/100` | 精灵种类、属性 |
| move | `\|move\|p1a: Name\|Earthquake` | **上一回合招式** |
| -ability | `\|-ability\|p1a: Name\|Levitate` | 特性暴露 |
| -item | `\|-item\|p1a: Name\|Air Balloon` | 道具暴露 |
| -enditem | `\|-enditem\|p1a: Name\|Air Balloon` | 道具失去 |
| -boost | `\|-boost\|p1a: Name\|atk\|2` | 能力变化 |
| -weather | `\|-weather\|Sandstorm` | 天气变化 |
| -sidestart | `\|-sidestart\|p1: Player\|Stealth Rock` | 场地状态 |

### lastMove 追踪 (v1.1.6+)

对应 CFRU 的 `gLastUsedMoves[bankDef]`，追踪对手上一回合使用的招式：

```typescript
// BattleTracker 内部
handleMove(pokemon: string, move: string) {
    tracked.lastMove = move;
}

// 获取 API
tracker.getOpponentLastMove(slot);      // 返回招式 ID
tracker.getOpponentLastMoveInfo(slot);  // 返回完整招式数据
```

**用途**:
- Encore/Disable 评分 (锁定上一回合招式)
- 未来: 切换预测 (预测对手下一步动作)

### itemLost 追踪 (v1.1.30+)

区分"道具未知"和"道具已失去"：

```typescript
// BattleTracker 追踪
{
    item: null,           // null = 未知
    itemLost: false,      // 默认
}

// 当收到 |-enditem| 消息
{
    item: null,
    itemLost: true,       // 已失去道具
}
```

**用途**: Knock Off 评分 (对已失去道具的目标不加分)

### 格式等级解析 (v1.2.7+)

不同对战格式使用不同的精灵等级，伤害计算需要正确处理等级以确保伤害百分比准确。

#### 问题背景

| 格式 | 实际等级 | 错误估算 HP | 正确 HP | 伤害误差 |
|------|---------|-------------|---------|----------|
| National Dex | 100 | 194 (L50) | 378 (L100) | 2x |
| VGC/BSS | 50 | 378 (L100) | 194 (L50) | 0.5x |

**关键洞察**: 伤害百分比的准确性依赖于攻击方和防御方使用**一致的等级**。

#### 解决方案: 格式推断等级

```typescript
// types.ts
export function getFormatLevel(formatId: string): number {
    const id = formatId.toLowerCase();

    // 随机对战: 每只精灵等级可能不同
    if (id.includes('random')) return 0;  // 0 表示使用追踪值

    // Little Cup
    if (id.includes('lc') || id.includes('littlecup')) return 5;

    // VGC / BSS / Battle Stadium
    if (id.includes('vgc') || id.includes('bss') ||
        id.includes('battlestadium') || id.includes('battlespot')) return 50;

    // National Dex / OU / UU / Uber 等
    return 100;
}

export function resolveLevel(formatId: string, parsedLevel?: number): number {
    const formatLevel = getFormatLevel(formatId);

    // 随机对战: 使用追踪的等级
    if (formatLevel === 0) {
        return (parsedLevel && parsedLevel > 0) ? parsedLevel : 100;
    }

    // 其他格式: 使用格式默认等级 (确保双方一致)
    return formatLevel;
}
```

#### 数据流

```
┌─────────────────┐
│  roomBattle     │
│  .format        │ ─────┐
└─────────────────┘      │
                         ▼
               ┌─────────────────┐
               │  CFRUAIConfig   │
               │  .formatId      │
               └────────┬────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │ NormalAI   │ │ NPCMulti   │ │ state-     │
   │ setBattle()│ │ Manager    │ │ builder    │
   └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
         │              │              │
         ▼              ▼              ▼
   ┌─────────────────────────────────────────┐
   │         resolveLevel(formatId)          │
   │  ┌─────────────────────────────────┐    │
   │  │  trackedPokemonToAIPokemon()    │    │
   │  │  - 使用格式推断的等级            │    │
   │  │  - 确保 attacker/defender 一致   │    │
   │  └─────────────────────────────────┘    │
   └─────────────────────────────────────────┘
```

#### 设置 formatId 的位置

| 组件 | 设置时机 | 代码位置 |
|------|---------|----------|
| NormalAI | `setBattle()` | normal.ts:144-148 |
| NPCMultiManager | `buildVirtualDoublesState()` | multi-manager.ts:364 |

```typescript
// NormalAI
setBattle(battle: AnyObject): void {
    this.battleRef = battle;
    if (battle.format) {
        this.cfruConfig = {
            ...this.cfruConfig,
            formatId: battle.format,
        };
    }
    // ...
}

// NPCMultiManager
const formatId = this.roomBattle?.format || '';
opponentActive.push(trackedPokemonToAIPokemon(pokemon, slot, true, formatId));
```

#### 格式等级映射表

| 格式类型 | formatId 模式 | 等级 |
|---------|--------------|------|
| Random Battle | `*random*` | 追踪值 |
| Little Cup | `*lc*`, `*littlecup*` | 5 |
| VGC | `*vgc*` | 50 |
| Battle Stadium | `*bss*`, `*battlestadium*` | 50 |
| National Dex | `*nationaldex*` | 100 |
| OU/UU/Uber | 其他 | 100 |

---

## AI 选择机制

`server/npc/room.ts` 中根据 NPC 模板的 `difficulty` 选择 AI：

```typescript
switch (difficulty) {
case 'smart':
case 'normal':
    ai = new NormalAI(battle.stream, options);
    break;
case 'basic':
default:
    ai = new BasicAI(battle.stream);
    break;
}
```

---

## choose 命令格式

### 基本格式

服务端需要带玩家前缀的命令格式：

```typescript
// 原始格式 (本地)
stream.write('move 1');

// 服务端格式
stream.write('>p2 move 1');  // NPC 是 p2
```

在 `room.ts` 中重写：

```typescript
ai.choose = (choice: string) => {
    void battle.stream.write(`>p2 ${choice}`);
};
```

### 单打命令

```typescript
'move 1'      // 使用第一个招式
'move 2'      // 使用第二个招式
'switch 3'    // 换成第三只精灵
```

### 双打命令

```typescript
// 指定目标
'move 1 1'                  // 第一招攻击对手位置 1
'move 2 2'                  // 第二招攻击对手位置 2
'move 3 -2'                 // 第三招对队友使用

// 扩散招式不需要指定目标
'move 1'                    // 地震，自动攻击所有相邻

// 两只精灵的选择用逗号分隔
'move 1 1, move 2 2'        // 第一只攻击位置1，第二只攻击位置2
'move 1 1, switch 3'        // 第一只攻击，第二只换人
```

---

## 双打特殊处理 (v1.1.12+)

### Request 结构差异

单打和双打的 request 结构不同：

```typescript
// 单打 request
{
    active: [{ moves: [...], trapped: false }],  // 长度 1
    side: { pokemon: [...] }
}

// 双打 request
{
    active: [
        { moves: [...], trapped: false },  // 第一只精灵
        { moves: [...], trapped: false },  // 第二只精灵
    ],
    side: { pokemon: [...] }
}
```

### activeIndex 参数

`handleMoveRequest` 遍历 `request.active` 时，使用索引 `i` 作为 `activeIndex`：

```typescript
const choices = request.active.map((active, i) => {
    // i = 0 → 第一只精灵
    // i = 1 → 第二只精灵 (仅双打)
    const decision = this.makeDecision(active, moves, switches, flags, i);
    // ...
});
```

### 目标位置格式

Pokemon Showdown 双打目标使用**数字**表示位置：

```
场地布局 (从 AI 视角，AI 是 p2):
        ┌─────┐  ┌─────┐
        │ p1a │  │ p1b │
        │  1  │  │  2  │   ← 对手位置 (正数)
        └─────┘  └─────┘

        ┌─────┐  ┌─────┐
        │ p2a │  │ p2b │
        │ -1  │  │ -2  │   ← 己方位置 (负数)
        └─────┘  └─────┘
```

| 值 | 含义 |
|----|------|
| `1` | 对手第一只 (p1a) |
| `2` | 对手第二只 (p1b) |
| `-1` | 己方第一只 (p2a，通常是自己) |
| `-2` | 己方第二只 (p2b，队友) |
| `0` | 无特定目标 |

### slot vs 对象引用

**重要**: 在双打中，`slot` 数字可能在双方重复（双方都有 slot 1 和 2），因此判断目标是否为队友时必须使用**对象引用比较**：

```typescript
// ✅ 正确 - 对象引用比较
const isPartner = state.self.active.some(p => p === target);

// ❌ 错误 - slot 数字比较 (会误判)
const isPartner = state.self.active.some(p => p.slot === target.slot);
```

### 双打必须指定目标

在双打中，以下类型的招式**必须**指定 `targetPos`：

| 目标类型 | 示例招式 | 需要目标? |
|---------|---------|----------|
| `normal` | 十万伏特、冰冻光束 | ✅ 必须 |
| `any` | 超级角击 | ✅ 必须 |
| `adjacentAlly` | 治愈铃声 | ✅ 必须 |
| `allAdjacentFoes` | 地震、热风 | ❌ 不需要 |
| `allAdjacent` | 冲浪 | ❌ 不需要 |
| `self` | 剑舞 | ❌ 不需要 |

---

## Multi Battle 架构 (v1.2)

### 概述

Multi Battle 是 PS 原生支持的 4 人对战模式，用于实现"两名玩家组队对战 NPC"功能。

```
              Team 1                    Team 2
        ┌─────┐  ┌─────┐          ┌─────┐  ┌─────┐
        │ p1a │  │ p3a │          │ p2a │  │ p4a │
        │(3只)│  │(3只)│    VS    │(3只)│  │(3只)│
        └─────┘  └─────┘          └─────┘  └─────┘

        玩家1    玩家2              NPC     NPC
```

### 敌对/同盟关系 (sim/battle.ts:1869-1877)

```typescript
// gameType === 'multi' 时的初始化
this.sides[0].foe = this.sides[3];      // p1 的 foe 是 p4
this.sides[1].foe = this.sides[2];      // p2 的 foe 是 p3
this.sides[2].foe = this.sides[1];      // p3 的 foe 是 p2
this.sides[3].foe = this.sides[0];      // p4 的 foe 是 p1

this.sides[0].allySide = this.sides[2]; // p1 的同盟是 p3
this.sides[1].allySide = this.sides[3]; // p2 的同盟是 p4
this.sides[2].allySide = this.sides[0]; // p3 的同盟是 p1
this.sides[3].allySide = this.sides[1]; // p4 的同盟是 p2

// 同盟共享 sideConditions
this.sides[2].sideConditions = this.sides[0].sideConditions;
this.sides[3].sideConditions = this.sides[1].sideConditions;
```

### NPCMultiManager 协调器

由于 NPC 被拆成 p2 和 p4 两个 side，需要 NPCMultiManager 统一协调决策：

```
                    ┌─────────────────────────────────────┐
                    │        NPCMultiManager              │
                    │  ┌─────────────────────────────┐    │
                    │  │   BattleTracker (isMulti)   │    │
                    │  │   追踪 p1 AND p3 对手状态    │    │
                    │  └─────────────────────────────┘    │
                    │                 │                   │
                    │                 ▼                   │
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

**重要**: NPCMultiManager 使用 BattleTracker 追踪对手，不直接访问 sim Battle：

```typescript
// 创建 tracker 时指定 isMulti=true
this.tracker = createBattleTracker('p2', true);
this.tracker.attachToStream(roomBattle.stream);

// buildVirtualDoublesState 使用 tracker 获取对手信息
const trackedOpponents = this.tracker.getActiveOpponents();
for (const { position, pokemon } of trackedOpponents) {
    const side = position.slice(0, 2); // 'p1' or 'p3'
    const slot = side === 'p1' ? 1 : 2;
    opponentActive.push(trackedPokemonToAIPokemon(pokemon, slot, true));
}
```

### Multi Battle 位置命名规则 (v1.2.12+)

PS Multi Battle 的位置命名与普通双打不同：

```
普通双打 (同一 side 有两只精灵):
        ┌─────┐  ┌─────┐
        │ p1a │  │ p1b │    ← p1 的两只精灵用 a/b 区分
        └─────┘  └─────┘

Multi Battle (每个 side 只有一只精灵):
        ┌─────┐  ┌─────┐
        │ p1a │  │ p3a │    ← Team 1: p1 用 a, p3 用 a
        └─────┘  └─────┘

        ┌─────┐  ┌─────┐
        │ p2a │  │ p4b │    ← Team 2: p2 用 a, p4 用 b
        └─────┘  └─────┘
```

**关键差异**: Multi Battle 中，同一队伍的两个 side 使用不同的 slot 字符：

| Side | Slot 字符 | 完整位置 |
|------|-----------|----------|
| p1 | `a` | `p1a` |
| p2 | `a` | `p2a` |
| p3 | `a` | `p3a` |
| p4 | `b` | `p4b` |

**协议消息示例**:
```
# 威吓触发
|-unboost|p2a: Tyranitar|atk|1    ← p2 用 slot 'a'
|-unboost|p4b: Garchomp|atk|1     ← p4 用 slot 'b'
```

**代码中的处理**:
```typescript
// 根据 side 确定 slot 字符
const slotChar = side === 'p2' ? 'a' : 'b';
const boostKey = `${side}${slotChar}`;  // p2 → p2a, p4 → p4b
```

> ⚠️ **常见错误 (Bug 22)**
>
> 硬编码使用 `${side}a` 获取 boost：
> ```typescript
> // ❌ 错误 - p4 会得到 'p4a'，但实际追踪的是 'p4b'
> const boostKey = `${side}a`;
>
> // ✅ 正确 - 根据 side 动态确定 slot
> const slotChar = side === 'p2' ? 'a' : 'b';
> const boostKey = `${side}${slotChar}`;
> ```
>
> 详见 [Bug 22: Multi Battle p4 Slot 格式错误](../troubleshooting/known-issues.md#bug-22-multi-battle-p4-slot-格式错误)

---

### Request 同步机制

Multi 格式中，p2 和 p4 的 request 可能不同时到达：

| 情况 | 处理方式 |
|------|---------|
| 两边都需要选择 | 等待同步后统一决策 |
| 只有一边需要选择 | 单独处理该 side |
| forceSwitch | 立即处理，不等待另一边 |
| wait | 标记并跳过 |

```typescript
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

### 关键代码位置

| 功能 | 文件 | 行号 |
|------|------|------|
| Multi 格式定义 | config/formats.ts | 83-94 |
| 敌对/同盟关系初始化 | sim/battle.ts | 1869-1880 |
| allySide 属性定义 | sim/side.ts | 163-164 |
| 邀请表单 | server/room-battle.ts | 1225-1248 |
| /invitebattle 命令 | server/chat-commands/core.ts | 1172-1238 |
| /acceptbattle 命令 | server/chat-commands/core.ts | 1243-1272 |

详见 [v1.2 设计文档](../versions/v1.2/design.md)。

---

## 选择错误处理 (v1.1.18+)

### 错误类型

Pokemon Showdown 对无效选择返回两种错误：

| 错误类型 | 含义 | 示例 |
|---------|------|------|
| `[Invalid choice]` | 选择格式错误或非法 | 选择已禁用的招式 |
| `[Unavailable choice]` | 选择当前不可用 | 双打中单体招式缺少目标 |

### 错误处理流程

```
AI 发送选择
    │
    ▼
PS 验证选择
    │
    ├─ 有效 → 执行招式/切换
    │
    └─ 无效 → 返回错误
              │
              ├─ [Invalid choice]
              │   └─ 重置 request.isWait = false
              │
              └─ [Unavailable choice]
                  └─ 调用 emitRequest() 重发 request
                      └─ 新 request 带有 update: true
```

### Request 重发机制

当 `[Unavailable choice]` 发生时，PS 会重新发送 request：

```typescript
// side.ts:emitChoiceError()
emitChoiceError(message: string, update?) {
    // ...
    if (updated) this.emitRequest(this.activeRequest!, true);
}

// emitRequest 重发 request
emitRequest(update, updatedRequest = false) {
    if (updatedRequest) (this.activeRequest as any).update = true;
    this.battle.send('sideupdate', `${this.id}\n|request|${JSON.stringify(update)}`);
}
```

服务端处理新 request 时会**重置 `request.isWait`**：

```typescript
// room-battle.ts:795-809
if (lines[2].startsWith(`|request|`)) {
    this[slot].request = {
        rqid: this.rqid,
        request: requestJSON,
        isWait: request.wait ? 'cantUndo' : false,  // 重置!
        choice: '',
    };
}
```

### 无限循环风险

如果 AI 总是发送无效选择：
1. PS 返回错误并重发 request
2. `request.isWait` 被重置
3. 轮询检测到新 request，再次发送相同选择
4. 循环...

**防护措施** (room.ts):
```typescript
let lastProcessedRqid = 0;
let retryCount = 0;
const MAX_RETRIES = 3;

if (requestData.update || request.rqid === lastProcessedRqid) {
    retryCount++;
    if (retryCount >= MAX_RETRIES) {
        request.isWait = true;  // 停止重试
        return;
    }
}
```

---

## NPC 队伍配置系统 (v1.1.29+)

### 多世代支持

NPC 队伍配置支持任意世代和格式：

```typescript
// NPCTeamConfig 接口
export interface NPCTeamConfig {
    singles?: {
        [format: string]: string[];  // 如 "gen9ou", "gen8ou"
    };
    doubles?: {
        [format: string]: string[];  // 如 "gen9doublesou", "gen9vgc2024"
    };
    multi?: {
        [format: string]: string[];  // 如 "gen9nationaldexmulti" (v1.2)
    };
    randombattle?: string[];  // 如 ["gen9randombattle", "gen8randombattle"]
}
```

### 配置示例 (templates.json)

```json
{
  "gymbrock": {
    "teams": {
      "singles": {
        "gen9ou": ["gym-brock-gen9ou.json", "gym-brock-gen9ou-2.json"],
        "gen9uu": ["gym-brock-gen9uu.json"],
        "gen8ou": ["gym-brock-gen8ou.json"]
      },
      "doubles": {
        "gen9doublesou": ["gym-brock-gen9doublesou.json"]
      },
      "multi": {
        "gen9nationaldexmulti": ["gym-brock-gen9multi.json"]
      },
      "randombattle": ["gen9randombattle", "gen8randombattle"]
    }
  }
}
```

### Multi 队伍配置 (v1.2)

Multi 队伍文件需要通过 `slot` 字段标明精灵归属：

```json
[
  { "name": "Tyranitar", "species": "Tyranitar", "slot": "p2", ... },
  { "name": "Excadrill", "species": "Excadrill", "slot": "p4", ... },
  { "name": "Landorus-Therian", "species": "Landorus-Therian", "slot": "p2", ... },
  { "name": "Garchomp", "species": "Garchomp", "slot": "p4", ... },
  { "name": "Ferrothorn", "species": "Ferrothorn", "slot": "p2", ... },
  { "name": "Rotom-Wash", "species": "Rotom-Wash", "slot": "p4", ... }
]
```

| 字段 | 值 | 说明 |
|------|-----|------|
| `slot` | `"p2"` | 该精灵归属 NPC 的 p2 位置 |
| `slot` | `"p4"` | 该精灵归属 NPC 的 p4 位置 |
| (无) | - | 向后兼容：无此字段时用于普通双打 |

### 格式识别

```typescript
// 判断是否为双打格式
function isDoublesFormat(format: string): boolean {
    return format.includes('doubles') || format.includes('vgc');
}

// 判断是否为随机对战格式
function isRandomBattleFormat(format: string): boolean {
    return format.includes('randombattle') || format.includes('randomdoubles');
}

// 判断是否为 Multi 格式 (v1.2)
function isMultiFormat(format: string): boolean {
    return format.includes('multi');
}
```

### 队伍文件命名规范

推荐格式: `{npc}-{format}.json`

示例:
- `gym-brock-gen9ou.json`
- `gym-brock-gen8ou.json`
- `gym-brock-gen9doublesou.json`
- `gym-brock-gen9multi.json`

### 添加新世代队伍步骤

1. 创建队伍文件 `data/npc/teams/{npc}-{format}.json`
2. 在 `templates.json` 中添加配置:
   ```json
   "singles": {
     "gen8ou": ["gym-brock-gen8ou.json"]
   }
   ```
3. 重启服务器或执行 `/npc reload`

---

*最后更新: 2026-01-25 (v1.2.12 Multi Battle 位置命名规则)*
