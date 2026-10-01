# Pokemon Showdown 招式名称使用方式分析

## 一、核心发现

Pokemon Showdown 在三个不同场景中获取和使用招式名称，数据来源和处理方式各不相同。

---

## 二、场景1：Teambuilder 前端显示招式名称

### 关键文件位置
- **招式数据定义**: `/data/moves.ts`
- **招式Dex接口**: `/sim/dex-moves.ts`
- **编译输出**: `/dist/data/moves.js` (前端使用)

### 数据结构
在 `data/moves.ts` 中，每个招式包含 `name` 字段用于前端显示：

```typescript
export const Moves: MoveDataTable = {
    "10000000voltthunderbolt": {
        num: 719,
        accuracy: true,
        basePower: 195,
        category: "Special",
        name: "10,000,000 Volt Thunderbolt",  // 前端显示的名称
        pp: 1,
        type: "Electric",
        // ...其他属性
    },
    absorb: {
        num: 71,
        accuracy: 100,
        basePower: 20,
        category: "Special",
        name: "Absorb",  // 前端显示的名称
        pp: 25,
        type: "Grass",
        // ...其他属性
    }
}
```

### 前端获取方式
- 前端通过 **Dex 对象** 访问编译后的 `/dist/data/moves.js`
- 招式ID（如 `absorb`, `earthquake`）作为主键查询
- 前端代码类似：`Dex.moves.get('earthquake').name` → `"Earthquake"`

### 编译过程
- 构建时将 `data/moves.ts` (TypeScript) 编译为 `dist/data/moves.js` (JavaScript)
- 前端通过 CDN 或本地加载编译后的 JavaScript 文件

---

## 三、场景2：对战进行中技能选择界面

### 关键文件位置
- **招式请求数据构建**: `/sim/pokemon.ts` 行 939-1021 (`getMoves()` 方法)
- **MoveSlot 初始化**: `/sim/pokemon.ts` 行 344-368 (构造函数)
- **选择处理**: `/sim/side.ts` 行 519-650 (`chooseMove()` 方法)

### 数据流程

#### 1. MoveSlot 初始化（战斗开始时）

在 Pokemon 对象构造时初始化：

```typescript
// sim/pokemon.ts 行 344-368
this.baseMoveSlots = [];
this.moveSlots = [];
if (!this.set.moves?.length) {
    throw new Error(`Set ${this.name} has no moves`);
}
for (const moveid of this.set.moves) {
    let move = this.battle.dex.moves.get(moveid);
    if (!move.id) continue;
    if (move.id === 'hiddenpower' && move.type !== 'Normal') {
        if (!set.hpType) set.hpType = move.type;
        move = this.battle.dex.moves.get('hiddenpower');
    }
    let basepp = move.noPPBoosts ? move.pp : move.pp * 8 / 5;
    if (this.battle.gen < 3) basepp = Math.min(61, basepp);
    this.baseMoveSlots.push({
        move: move.name,           // 从 Dex 查询获得的招式名称
        id: move.id,               // 招式ID 用于内部查询
        pp: basepp,
        maxpp: basepp,
        target: move.target,       // 目标类型
        disabled: false,
        disabledSource: '',
        used: false,
    });
}
```

**MoveSlot 接口定义** (行 13-23)：
```typescript
interface MoveSlot {
    id: ID;                 // 招式ID (如 'earthquake')
    move: string;           // 招式名称 (如 'Earthquake')
    pp: number;             // 当前PP
    maxpp: number;          // 最大PP
    target?: string;        // 目标类型
    disabled: boolean | 'hidden';
    disabledSource?: string;
    used: boolean;
    virtual?: boolean;
}
```

#### 2. 招式请求数据构建（每回合）

每当需要向前端发送选择请求时调用 `getMoves()`：

```typescript
// sim/pokemon.ts 行 939-1021
getMoves(lockedMove?: ID | null, restrictData?: boolean): {
    move: string, id: ID, disabled?: string | boolean, 
    disabledSource?: string, target?: string, pp?: number, maxpp?: number,
}[] {
    if (lockedMove) {
        lockedMove = toID(lockedMove);
        this.trapped = true;
        if (lockedMove === 'recharge') {
            return [{
                move: 'Recharge',
                id: 'recharge' as ID,
            }];
        }
        for (const moveSlot of this.moveSlots) {
            if (moveSlot.id !== lockedMove) continue;
            return [{
                move: moveSlot.move,   // 从缓存的 moveSlot 获取
                id: moveSlot.id,
            }];
        }
        // fallback: 从 Dex 查询
        return [{
            move: this.battle.dex.moves.get(lockedMove).name,
            id: lockedMove,
        }];
    }
    
    const moves = [];
    let hasValidMove = false;
    for (const moveSlot of this.moveSlots) {
        let moveName = moveSlot.move;  // 从 moveSlot 缓存读取
        
        // 特殊招式名称处理 - 动态计算变量部分
        if (moveSlot.id === 'hiddenpower') {
            moveName = `Hidden Power ${this.hpType}`;
            if (this.battle.gen < 6) moveName += ` ${this.hpPower}`;
        } else if (moveSlot.id === 'return' || moveSlot.id === 'frustration') {
            const basePowerCallback = this.battle.dex.moves.get(moveSlot.id)
                .basePowerCallback as (pokemon: Pokemon) => number;
            moveName += ` ${basePowerCallback(this)}`;
        }
        
        // 处理目标类型
        let target = moveSlot.target;
        switch (moveSlot.id) {
        case 'curse':
            if (!this.hasType('Ghost')) {
                target = this.battle.dex.moves.get('curse').nonGhostTarget;
            }
            break;
        case 'pollenpuff':
            if (this.volatiles['healblock']) {
                target = 'adjacentFoe';
            }
            break;
        case 'terastarstorm':
            if (this.species.name === 'Terapagos-Stellar') {
                target = 'allAdjacentFoes';
            }
            break;
        }
        
        // 处理禁用状态
        let disabled = moveSlot.disabled;
        if (this.volatiles['dynamax']) {
            const canCauseStruggle = ['Encore', 'Disable', 'Taunt', 'Assault Vest', 'Belch', 'Stuff Cheeks'];
            disabled = this.maxMoveDisabled(moveSlot.id) || 
                       disabled && canCauseStruggle.includes(moveSlot.disabledSource!);
        } else if (moveSlot.pp <= 0 && !this.volatiles['partialtrappinglock']) {
            disabled = true;
        }
        
        if (disabled === 'hidden') {
            disabled = !restrictData;
        }
        if (!disabled) {
            hasValidMove = true;
        }
        
        moves.push({
            move: moveName,      // 最终的显示名称
            id: moveSlot.id,     // 招式ID
            pp: moveSlot.pp,
            maxpp: moveSlot.maxpp,
            target,
            disabled,
        });
    }
    return hasValidMove ? moves : [];
}
```

#### 3. getMoveRequestData 方法

```typescript
// sim/pokemon.ts 行 1062-1119
getMoveRequestData() {
    let lockedMove = this.maybeLocked ? null : this.getLockedMove();
    const isLastActive = this.isLastActive();
    const canSwitchIn = this.battle.canSwitch(this.side) > 0;
    let moves = this.getMoves(lockedMove, isLastActive);
    
    if (!moves.length) {
        moves = [{ move: 'Struggle', id: 'struggle' as ID, target: 'randomNormal', disabled: false }];
        lockedMove = 'struggle' as ID;
    }
    
    const data: PokemonMoveRequestData = {
        moves,
        // ...其他字段
    };
    // ...返回 data
    return data;
}
```

#### 4. 请求数据结构 (发送到前端)

```typescript
// sim/side.ts 行 93-108
export interface PokemonMoveRequestData {
    moves: { 
        move: string,               // 招式显示名称 (如 "Earthquake", "Hidden Power Fire")
        id: ID,                     // 招式ID (如 'earthquake', 'hiddenpower')
        target?: string,            // 目标类型 (如 'normal', 'allAdjacentFoes')
        disabled?: string | boolean, // 是否禁用
        disabledSource?: string     // 禁用原因
    }[];
    maybeDisabled?: boolean;
    maybeLocked?: boolean;
    trapped?: boolean;
    maybeTrapped?: boolean;
    canMegaEvo?: boolean;
    canMegaEvoX?: boolean;
    canMegaEvoY?: boolean;
    canUltraBurst?: boolean;
    canZMove?: (boolean | string)[];
    canDynamax?: boolean;
    maxMoves?: DynamaxOptions;
    canTerastallize?: ID;
}
```

#### 5. 前端使用流程

1. 前端通过 WebSocket 接收 `request` 对象
2. 获取招式列表：`request.side.pokemon[0].moves[]`
3. 遍历 moves 数组，使用 `move` 字段在 UI 中显示
4. 用户选择后，使用 `id` 字段发送选择命令

---

## 四、场景3：对战日志输出系统

### 关键文件位置
- **日志记录核心方法**: `/sim/battle.ts` 行 3092-3120
- **日志实际使用例**: `/sim/battle-actions.ts` 多处 `this.battle.add()` 调用
- **日志结构**: `/sim/battle.ts` 行 143-146

### 日志记录机制

#### 1. add() 方法 - 基础日志记录

```typescript
// sim/battle.ts 行 3092-3114
add(...parts: (Part | (() => { side: SideID, secret: string, shared: string }))[]) {
    if (!parts.some(part => typeof part === 'function')) {
        this.log.push(`|${parts.join('|')}`);
        return;
    }

    let side: SideID | null = null;
    const secret = [];
    const shared = [];
    for (const part of parts) {
        if (typeof part === 'function') {
            const split = part();
            if (side && side !== split.side) throw new Error("Multiple sides passed to add");
            side = split.side;
            secret.push(split.secret);
            shared.push(split.shared);
        } else {
            secret.push(part);
            shared.push(part);
        }
    }
    this.addSplit(side!, secret, shared);
}
```

格式：所有部分用 `|` 分隔，形成协议行

#### 2. addMove() 方法 - 移动相关日志

```typescript
// sim/battle.ts 行 3116-3120
addMove(...args: (string | number | Function | AnyObject)[]) {
    this.lastMoveLine = this.log.length;
    this.log.push(`|${args.join('|')}`);
}
```

用于追踪最后的移动线，便于后续属性添加

#### 3. 招式相关日志示例

**提示消息中的招式名称**:
```typescript
// sim/battle-actions.ts 行 317
this.battle.add('-hint', `Some effects can force a Pokemon to use ${move.name} again in a row.`);
// 输出日志: |-hint|Some effects can force a Pokemon to use Earthquake again in a row.
```

**激活效果中的招式**:
```typescript
// sim/battle-actions.ts 行 768
this.battle.add('-activate', target, `move: ${move.name}`, '[broken]');
// 输出日志: |-activate|p1a|move: Protect|[broken]
```

**移动相关的增益清除**:
```typescript
// sim/battle-actions.ts 行 791
this.battle.add('-clearpositiveboost', target, pokemon, 'move: ' + move.name);
// 输出日志: |-clearpositiveboost|p1a|p2a|move: Close Combat
```

**移动动画**:
```typescript
// sim/battle-actions.ts 行 899
this.battle.addMove('-anim', pokemon, move.name, target);
// 输出日志: |-anim|p1a|Earthquake|p2a
```

#### 4. 日志对象结构

```typescript
// sim/battle.ts 行 143-148
readonly log: string[];           // 完整的对战日志行数组
readonly inputLog: string[];      // 输入日志 (用户的选择历史)
readonly messageLog: string[];    // 消息日志 (系统消息)
sentLogPos: number;              // 已发送的日志位置追踪
sentEnd: boolean;                 // 是否已发送结束消息
sentRequests = true;             // 是否已发送请求
```

---

## 五、招式名称的三个主要数据源

### 数据源1：Dex 对象 (直接查询)

**使用场景**: 需要最新、最可靠的招式数据

```typescript
// 直接查询
const move = this.battle.dex.moves.get('earthquake');
console.log(move.name);  // "Earthquake"

// 获取所有属性
console.log(move.basePower);      // 100
console.log(move.accuracy);       // 100
console.log(move.type);           // "Ground"
console.log(move.category);       // "Physical"
```

**来源**:
- `/data/moves.ts` (TypeScript 源文件)
- `/sim/dex-moves.ts` (类型定义和接口)

**特点**:
- 优点: 实时、始终最新、包含完整信息
- 缺点: 每次查询都需要对象访问，略有性能开销

### 数据源2：MoveSlot (缓存)

**使用场景**: 对战过程中重复访问的招式数据

```typescript
// 初始化时保存一次
moveSlot = {
    move: "Earthquake",    // 缓存的名称
    id: "earthquake",      // 缓存的ID
    pp: 15,               // 当前PP
    maxpp: 15,            // 最大PP
    target: "normal",     // 缓存的目标类型
}

// 使用时直接读取
console.log(moveSlot.move);  // "Earthquake" (立即返回，无查询)
```

**位置**:
- `pokemon.baseMoveSlots[]` - Pokemon 的基础招式槽（不变）
- `pokemon.moveSlots[]` - 对战中动态修改的招式槽

**特点**:
- 优点: 高效、避免重复查询、可随时修改
- 缺点: 需要手动维护同步，特殊招式需要动态计算

### 数据源3：Protocol Message (日志中的字符串)

**使用场景**: 对战记录、客户端显示

```
|-anim|p1a|Earthquake|p2a
|-hint|Some effects can force a Pokemon to use Earthquake again in a row.
|-activate|p1a|move: Protect|[broken]
|-clearpositiveboost|p1a|p2a|move: Close Combat
```

**特点**:
- 形式: 纯文本字符串
- 位置: `battle.log` 数组中
- 用途: 供客户端解析显示、对战回放
- 特性: 一旦添加即不可变

---

## 六、特殊招式名称处理

### 1. Hidden Power 类型变量

```typescript
// sim/pokemon.ts 行 969-971
if (moveSlot.id === 'hiddenpower') {
    moveName = `Hidden Power ${this.hpType}`;  // 如 "Hidden Power Fire"
    if (this.battle.gen < 6) moveName += ` ${this.hpPower}`;  // Gen 3-5 添加威力
}
```

示例结果:
- Gen 6+: `"Hidden Power Fire"`, `"Hidden Power Electric"` 等
- Gen 3-5: `"Hidden Power Fire 70"`, `"Hidden Power Electric 60"` 等

### 2. Return / Frustration 威力变量

```typescript
// sim/pokemon.ts 行 972-975
else if (moveSlot.id === 'return' || moveSlot.id === 'frustration') {
    const basePowerCallback = this.battle.dex.moves.get(moveSlot.id)
        .basePowerCallback as (pokemon: Pokemon) => number;
    moveName += ` ${basePowerCallback(this)}`;  // 根据快乐度/不快乐度计算威力
}
```

示例结果:
- `"Return 102"` (快乐度100%)
- `"Return 51"` (快乐度50%)
- `"Frustration 88"` (不快乐度70%)

### 3. Z-Move 和 Max Move

```typescript
// sim/battle-actions.ts 行 9-50
readonly MAX_MOVES: { readonly [k: string]: string } = {
    Flying: 'Max Airstream',
    Dark: 'Max Darkness',
    Fire: 'Max Flare',
    Bug: 'Max Flutterby',
    Water: 'Max Geyser',
    Status: 'Max Guard',
    // ... 完整列表
};

readonly Z_MOVES: { readonly [k: string]: string } = {
    Poison: "Acid Downpour",
    Fighting: "All-Out Pummeling",
    Dark: "Black Hole Eclipse",
    Grass: "Bloom Doom",
    // ... 完整列表
};
```

这些是固定名称的专门招式，由基础招式的属性决定。

---

## 七、NPC AI 如何访问对手招式信息

由于 Pokemon Showdown 采用多进程架构，NPC AI 无法直接访问对手的 Battle 对象。相反，它使用 BattleTracker 追踪对手信息：

```typescript
// server/npc/ai/cfru/util/battle-tracker.ts 行 17-68
export interface TrackedPokemon {
    /** 已知招式列表 */
    knownMoves: string[];    // 对手曾使用过的招式名称
    
    /** 最后使用的招式 */
    lastMove: string;        // 用于 Encore/Disable 评估
    
    // ... 其他信息 (species, types, ability, item 等)
}
```

**工作流程**:
1. NPC AI 从对战日志中接收消息
2. BattleTracker 解析日志行，提取对手信息
3. 从日志中识别对手使用的招式（通过 `|-move|` 消息）
4. 招式名称存储在 `TrackedPokemon.knownMoves[]` 中
5. AI 决策时查询 `tracker.getActiveOpponent()` 获取对手信息

**关键约束**:
- NPC AI 只能看到已"显示"的招式（对手曾实际使用过的）
- 看不到对手还未使用的招式
- 所有数据通过对战协议消息解析获得

---

## 八、数据流总结图

```
┌─────────────────────────────────────────────────────────────────┐
│                       战斗初始化阶段                              │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ↓
                    ┌─────────────────┐
                    │ /data/moves.ts  │
                    │  (招式定义库)    │
                    └─────────────────┘
                             │
                             ↓
                 Dex.moves.get(moveid)
                    → Move 对象
                    → name 字段
                             │
    ┌────────────────────────┼────────────────────────┐
    ↓                        ↓                        ↓
┌────────────┐      ┌──────────────────┐      ┌──────────────┐
│ MoveSlot   │      │  对战进行阶段     │      │   日志系统   │
│  初始化    │      │                  │      │              │
└────────────┘      └──────────────────┘      └──────────────┘
    │               │                        │
    │ 缓存一次       │ 每回合构建               │ 实时添加
    │               │ getMoves()              │
    │               │                        │
    ↓               ↓                        ↓
pokemon.      PokemonMoveRequest         battle.log
moveSlots[]   Data.moves[]               (协议消息)
    │               │                        │
    │               │ 发送                    │ 客户端接收
    │               ↓                        ↓
    │          ┌──────────────┐         ┌─────────────┐
    │          │ 前端 request │         │ 前端解析    │
    │          │   对象       │         │ 并显示      │
    │          └──────────────┘         └─────────────┘
    │               │                        │
    └───────────────┴────────────────────────┘
                    │
                    ↓
        ┌──────────────────────────┐
        │   玩家看到的界面          │
        │ (Teambuilder / 对战UI)   │
        └──────────────────────────┘
```

---

## 九、编译过程详解

### 源代码
```
TypeScript:  /data/moves.ts
```

### 编译过程
```
npm run build
    ↓
tsc (TypeScript 编译器)
    ↓
dest/data/moves.js
```

### 前端使用
```javascript
// dist/data/moves.js 的内容示例
const Moves = {
    "earthquake": {
        num: 89,
        accuracy: 100,
        basePower: 100,
        category: "Physical",
        name: "Earthquake",
        pp: 10,
        type: "Ground",
        // ...
    },
    // ...
};

// 前端代码
const move = Dex.moves.get('earthquake');
console.log(move.name);  // "Earthquake"
```

---

## 十、关键代码位置速查表

| 功能/概念 | 文件路径 | 行号范围 | 关键代码 |
|----------|---------|--------|---------|
| 招式数据定义 | `/data/moves.ts` | - | `export const Moves = { ... }` |
| 招式类型定义 | `/sim/dex-moves.ts` | 1-150 | `interface MoveDataTable`, `class Move` |
| MoveSlot 定义 | `/sim/pokemon.ts` | 13-23 | `interface MoveSlot` |
| MoveSlot 初始化 | `/sim/pokemon.ts` | 344-368 | 构造函数中的初始化循环 |
| 招式请求构建 | `/sim/pokemon.ts` | 939-1021 | `getMoves()` 方法 |
| 招式请求数据类型 | `/sim/side.ts` | 93-108 | `interface PokemonMoveRequestData` |
| 招式选择处理 | `/sim/side.ts` | 519-650 | `chooseMove()` 方法 |
| 日志 add() 方法 | `/sim/battle.ts` | 3092-3114 | 日志记录核心方法 |
| 移动日志 | `/sim/battle.ts` | 3116-3120 | `addMove()` 方法 |
| 日志使用示例 | `/sim/battle-actions.ts` | 317,768,791,899 | 各处 `add()` 调用 |
| NPC 招式追踪 | `/server/npc/ai/cfru/util/battle-tracker.ts` | 46-47 | `interface TrackedPokemon` |
| NPC AI 评分 | `/server/npc/ai/cfru/scoring/` | - | 使用 `move.name` 进行决策 |

---

## 十一、关键总结

### 三层架构

1. **数据层** (`/data/moves.ts`)
   - 定义招式元数据
   - 包含 `name` 字段用于显示

2. **业务逻辑层** (`/sim/`)
   - 管理 MoveSlot 缓存
   - 构建请求数据
   - 处理特殊名称（Hidden Power 等）
   - 输出日志消息

3. **表现层** (客户端 / 日志)
   - 前端 UI 显示
   - 对战日志/回放
   - 用户交互

### 招式名称的三个来源

| 来源 | 用途 | 更新频率 | 性能 |
|------|------|--------|------|
| Dex 查询 | 动态获取、验证 | 实时 | 中等 |
| MoveSlot 缓存 | 批量请求、显示 | 初始化一次 | 高 |
| Protocol 日志 | 记录、回放 | 实时 | 不适用 |

### 架构特点

- **多进程分离**: 模拟器在子进程，AI 在主进程
- **缓存优化**: 避免重复查询 Dex
- **动态名称**: Hidden Power 等需要运行时计算
- **协议驱动**: 前端通过协议消息与服务端交互
