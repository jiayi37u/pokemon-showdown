# NormalAI PS 接入

## 输入数据

### Request 对象

与 BasicAI 相同，通过 `receiveRequest` 接收。

### 数据补充

NormalAI 需要更多数据，从多个来源获取：

| 数据 | 来源 |
|------|------|
| 招式信息 | Dex.moves.get() |
| 精灵属性 | Dex.species.get() |
| 对手信息 | BattleTracker |
| 己方 boosts | BattleTracker |
| 场地状态 | BattleTracker |

## BattleTracker

### 创建与附加

```typescript
import { createBattleTracker } from './cfru/util/battle-tracker';

// 创建 tracker (我们是 p2)
const tracker = createBattleTracker('p2');

// 附加到战斗流
tracker.attachToStream(battle.stream);
```

### 获取对手信息

```typescript
const opponent = tracker.getActiveOpponent();
// {
//   species: 'Landorus-Therian',
//   types: ['Ground', 'Flying'],
//   ability: 'Intimidate',  // 可能为空
//   item: '',               // 可能为空
//   hpPercent: 75,
//   status: '',
//   boosts: { atk: -1, def: 0, ... }
// }
```

### 获取己方 boosts

```typescript
// 服务端环境无法访问 battle.sides
// 必须通过 tracker 获取
const boosts = tracker.getOurActiveBoosts('a');
// { atk: 2, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 }
```

### 获取场地状态

```typescript
const field = tracker.getFieldConditions();
// {
//   weather: 'Sandstorm',
//   terrain: null,
//   trickRoom: false
// }

const opponentSide = tracker.getOpponentSideConditions();
// {
//   stealthRock: true,
//   spikes: 2,
//   toxicSpikes: 1,
//   stickyWeb: false,
//   reflect: false,
//   lightScreen: false
// }
```

## 追踪的协议消息

### 对手精灵

| 消息 | 格式 | 追踪内容 |
|------|------|----------|
| switch | `\|switch\|p1a: Name\|Species, L50, M\|100/100` | 种类、属性 |
| -ability | `\|-ability\|p1a: Name\|Levitate` | 特性 |
| -item | `\|-item\|p1a: Name\|Air Balloon` | 道具 |
| -enditem | `\|-enditem\|p1a: Name\|Air Balloon` | 道具消耗 |
| -damage | `\|-damage\|p1a: Name\|50/100` | HP |
| -status | `\|-status\|p1a: Name\|par` | 状态 |
| move | `\|move\|p1a: Name\|Earthquake` | 已知招式 |

### 能力变化

| 消息 | 格式 | 说明 |
|------|------|------|
| -boost | `\|-boost\|p1a: Name\|atk\|2` | 能力提升 |
| -unboost | `\|-unboost\|p1a: Name\|def\|1` | 能力下降 |
| -setboost | `\|-setboost\|p1a: Name\|atk\|6` | 设置绝对值 |
| -clearboost | `\|-clearboost\|p1a: Name` | 清除所有 |

### 场地状态

| 消息 | 格式 |
|------|------|
| -weather | `\|-weather\|Sandstorm` |
| -fieldstart | `\|-fieldstart\|move: Trick Room` |
| -sidestart | `\|-sidestart\|p1: Player\|move: Stealth Rock` |
| -sideend | `\|-sideend\|p1: Player\|Stealth Rock` |

**注意**: `-sidestart` 的 condition 可能带 `"move: "` 前缀。

### 特殊能力追踪

| 消息 | 格式 | 说明 |
|------|------|------|
| -start | `\|-start\|p1a: Name\|ability: Quark Drive\|[from] ability: Quark Drive` | 能力激活 |
| -end | `\|-end\|p1a: Name\|ability: Quark Drive` | 能力结束 |

用于追踪 Quark Drive / Protosynthesis 的能力提升。

## 输出格式

与 BasicAI 相同，使用 `choose` 命令。

### 服务端前缀

```typescript
ai.choose = (choice: string) => {
    void battle.stream.write(`>p2 ${choice}`);
};
```

## 初始化流程

```typescript
import { NormalAI, NormalAIOptions } from './ai/normal';
import { LogLevel } from './ai/cfru/logger';

// 1. 创建配置
const options: NormalAIOptions = {
    battleId: room.roomid,
    logging: {
        console: LogLevel.SCORING,  // 控制台显示评分
        file: LogLevel.VERBOSE,     // 文件记录详情
        logDir: './logs/ai',
    },
};

// 2. 创建 AI
const ai = new NormalAI(battle.stream, options);

// 3. 设置战斗引用 (启用追踪)
ai.setBattle(battle);

// 4. 重写 choose 方法
ai.choose = (choice: string) => {
    void battle.stream.write(`>p2 ${choice}`);
};

// 5. 启动
void ai.start();
```

## 日志系统

### 日志级别

```typescript
enum LogLevel {
    NONE = 0,      // 无日志
    DECISION = 1,  // 仅决策
    SCORING = 2,   // 含评分详情
    VERBOSE = 3,   // 全部详情
}
```

### 控制台输出示例 (SCORING)

```
[AI T3] Charizard (85%) -> Use Flamethrower
[AI T3] Move Scores:
[AI T3]   Flamethrower: 128 (-0/+28) [KO, SE]
[AI T3]   Air Slash: 112 (-0/+12)
[AI T3]   Dragon Claw: 105 (-0/+5)
```

### 导出日志

```typescript
const logger = ai.getLogger();
logger.saveToFile('./logs/battle.json', 'json');
logger.saveToFile('./logs/battle.txt', 'text');
```

## 数据流

```
Battle 进程                    AI (主进程)
    │                              │
    │  request                     │
    ├─────────────────────────────►│
    │                              │
    │  协议消息                     │
    ├─────────────────────────────►│ → BattleTracker 更新
    │                              │
    │                              │ → buildBattleStateWithTracker()
    │                              │ → ScoringEngine.scoreMoves()
    │                              │ → makeDecision()
    │                              │
    │  >p2 move 1                  │
    │◄─────────────────────────────┤
    │                              │
```

---

*最后更新: 2026-01-23*
