# BasicAI PS 接入

## 输入数据

### Request 对象

AI 通过 `receiveRequest` 方法接收战斗请求：

```typescript
interface BattleRequest {
    requestType: 'move' | 'switch' | 'teampreview';
    side: {
        id: string;           // 'p1' 或 'p2'
        name: string;
        pokemon: Pokemon[];   // 队伍信息
    };
    active?: [{
        moves: MoveSlot[];    // 可用招式
        canDynamax?: boolean;
        canMegaEvo?: boolean;
    }];
}
```

### MoveSlot 格式

```typescript
interface MoveSlot {
    move: string;      // 招式名称
    id: string;        // 招式 ID
    pp: number;        // 剩余 PP
    maxpp: number;
    target: string;    // 目标类型
    disabled: boolean; // 是否被禁用
}
```

**注意**: request 中的 `MoveSlot` 不包含 `basePower`、`type`、`category`，需要从 Dex 查询。

### 从 Dex 补充数据

```typescript
const dexMove = Dex.moves.get(move.id);
const fullMove = {
    ...move,
    basePower: dexMove.basePower,
    type: dexMove.type,
    category: dexMove.category,
};
```

## 输出格式

### choose 命令

```typescript
// 使用招式
ai.choose('move 1');              // 使用第1个招式
ai.choose('move 2 1');            // 双打：招式2打目标1
ai.choose('move 1 mega');         // Mega 进化后使用招式1

// 切换精灵
ai.choose('switch 3');            // 切换到队伍第3只

// 服务端格式 (需要前缀)
battle.stream.write('>p2 move 1');
```

### 招式目标

| 目标类型 | 说明 | 命令格式 |
|---------|------|---------|
| normal | 选择单个对手 | `move 1 2` |
| adjacentFoe | 相邻对手 | `move 1 2` |
| any | 任意精灵 | `move 1 -1` (己方) |
| self | 自己 | `move 1` |
| allAdjacentFoes | 所有对手 | `move 1` |
| allAdjacent | 所有相邻 | `move 1` |

## 协议消息

### 追踪的消息

| 消息 | 格式 | 用途 |
|------|------|------|
| switch | `\|switch\|p1a: Name\|Species, L50\|100/100` | 追踪对手精灵 |
| drag | `\|drag\|p1a: Name\|Species\|100/100` | 追踪被动换入 |
| faint | `\|faint\|p1a: Name` | 清除对手信息 |

### 消息位置标识

```
p1a  = 玩家1，位置a (单打唯一位置)
p1b  = 玩家1，位置b (双打第二位置)
p2a  = 玩家2，位置a
```

## 初始化流程

```typescript
// 1. 创建 AI
const ai = new BasicAI(battle.stream);

// 2. 设置战斗引用 (启用对手追踪)
ai.setBattle(battle);

// 3. 重写 choose 方法 (服务端环境)
ai.choose = (choice: string) => {
    void battle.stream.write(`>p2 ${choice}`);
};

// 4. 启动轮询
void ai.start();
```

## 数据流

```
Battle 进程                    AI (主进程)
    │                              │
    │  request (己方信息)          │
    ├─────────────────────────────►│
    │                              │
    │  协议消息 (|switch| 等)      │
    ├─────────────────────────────►│ → 更新 opponentActive
    │                              │
    │                              │ → makeDecision()
    │                              │
    │  >p2 move 1                  │
    │◄─────────────────────────────┤
    │                              │
```

---

*最后更新: 2026-01-23*
