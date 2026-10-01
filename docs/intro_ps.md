# Pokémon Showdown 开发者指南

本文档从开发者角度详细介绍 Pokémon Showdown 服务器的架构、技术细节和开发规范。

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 整体架构](#2-整体架构)
- [3. 技术栈](#3-技术栈)
- [4. 目录结构](#4-目录结构)
- [5. 核心模块详解](#5-核心模块详解)
- [6. 服务器启动流程](#6-服务器启动流程)
- [7. 网络通信协议](#7-网络通信协议)
- [8. 战斗模拟器](#8-战斗模拟器)
  - [8.4 伤害计算系统](#84-伤害计算系统)
- [9. 多进程架构](#9-多进程架构)
- [10. 数据格式规范](#10-数据格式规范)
- [11. 开发规范](#11-开发规范)
- [12. 测试指南](#12-测试指南)
- [13. Mod 系统](#13-mod-系统)
- [14. 常用命令](#14-常用命令)

---

## 1. 项目概述

Pokémon Showdown 是一个功能丰富的宝可梦对战模拟器，包含以下组件：

| 组件 | 说明 | 仓库 |
|------|------|------|
| Game Server | 聊天、对战匹配、战斗模拟 | 本仓库 |
| Client | Web 前端界面 | [pokemon-showdown-client](https://github.com/smogon/pokemon-showdown-client) |
| Login Server | 用户登录、数据库交互 | [pokemon-showdown-loginserver](https://github.com/smogon/pokemon-showdown-loginserver) |

支持第 1-9 代所有游戏的单打、双打、三打对战模拟。

---

## 2. 整体架构

### 2.1 三层分布式架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户浏览器                               │
│                    (Client - HTML5/JS)                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │ WebSocket       │ HTTP/API        │
         ▼                 ▼                 │
┌─────────────────┐  ┌─────────────────┐     │
│   Game Server   │  │  Login Server   │     │
│   (本仓库)       │◄─┤  (独立服务)      │     │
│                 │  │                 │     │
│  - 聊天系统      │  │  - 用户认证      │     │
│  - 对战匹配      │  │  - 天梯数据      │     │
│  - 战斗模拟      │  │  - 回放存储      │     │
└─────────────────┘  └─────────────────┘     │
                           │                 │
                     ┌─────┴─────┐           │
                     │  Database │           │
                     │ MySQL/PG  │◄──────────┘
                     └───────────┘
```

### 2.2 Game Server 内部架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Game Server                             │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ Sockets │  │  Users  │  │  Rooms  │  │  Chat   │        │
│  │ 网络连接 │──│ 用户管理 │──│ 房间管理 │──│ 聊天处理 │        │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │
│       │                          │                          │
│       │                    ┌─────┴─────┐                    │
│       │                    │  Battle   │                    │
│       │                    │  Rooms    │                    │
│       │                    └─────┬─────┘                    │
│       │                          │                          │
│  ┌────┴────────────────────────┴────────────────────┐      │
│  │                 Simulator (sim/)                  │      │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐    │      │
│  │  │ Battle │ │Pokemon │ │  Side  │ │  Dex   │    │      │
│  │  │  核心   │ │ 对象   │ │ 场地   │ │ 数据   │    │      │
│  │  └────────┘ └────────┘ └────────┘ └────────┘    │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 技术栈

### 3.1 核心技术

| 类别 | 技术 | 版本要求 |
|------|------|----------|
| 语言 | TypeScript | 5.8+ |
| 运行时 | Node.js | 22+ |
| 构建工具 | esbuild | 0.25+ |
| 网络通信 | SockJS | 0.3.x |
| 类型系统 | TypeScript Strict Mode | - |

### 3.2 数据库支持

| 数据库 | 用途 | 依赖包 |
|--------|------|--------|
| MySQL | 用户/天梯数据 | mysql2 |
| SQLite | 本地存储/Modlog | better-sqlite3 |
| PostgreSQL | 回放存储 | pg |

### 3.3 开发工具

| 工具 | 用途 |
|------|------|
| ESLint | 代码检查 |
| Mocha | 单元测试 |
| TypeScript ESLint | TS 规则检查 |

### 3.4 依赖管理哲学

> **重要**: 项目反对随意添加 NPM 依赖。
>
> "对于任何可以在约 30 行代码内重新实现的依赖，我们会自己编写并在 `lib/` 中维护。"

核心依赖仅包括：
- `sockjs` - WebSocket 兼容层
- `mysql2` - 数据库连接
- `esbuild` - 构建工具
- `preact` - UI 组件 (服务端渲染)

---

## 4. 目录结构

```
pokemon-showdown/
│
├── server/                 # 游戏服务器核心
│   ├── index.ts           # 入口文件，初始化全局对象
│   ├── sockets.ts         # SockJS 连接管理 (17KB)
│   ├── users.ts           # 用户管理 (56KB)
│   ├── rooms.ts           # 房间管理 (73KB)
│   ├── chat.ts            # 聊天命令处理 (102KB)
│   ├── chat-commands/     # 聊天命令模块
│   ├── chat-plugins/      # 聊天插件
│   ├── tournaments/       # 锦标赛系统
│   ├── ladders.ts         # 天梯系统
│   ├── ladders-local.ts   # 本地天梯实现
│   ├── ladders-remote.ts  # 远程天梯实现
│   ├── punishments.ts     # 惩罚系统 (71KB)
│   ├── room-battle.ts     # 战斗房间 (46KB)
│   ├── room-game.ts       # 游戏房间基类
│   ├── user-groups.ts     # 用户权限组
│   ├── ip-tools.ts        # IP 工具
│   ├── modlog/            # 管理日志
│   └── private-messages/  # 私聊系统
│
├── sim/                    # 战斗模拟器 (可独立使用)
│   ├── index.ts           # 模拟器入口
│   ├── battle.ts          # 核心战斗逻辑 (115KB)
│   ├── battle-actions.ts  # 战斗动作处理 (73KB)
│   ├── battle-queue.ts    # 动作队列
│   ├── battle-stream.ts   # 战斗流
│   ├── pokemon.ts         # 宝可梦对象 (74KB)
│   ├── side.ts            # 玩家场地 (43KB)
│   ├── field.ts           # 战场状态
│   ├── state.ts           # 状态管理
│   ├── dex.ts             # 图鉴加载器 (23KB)
│   ├── dex-species.ts     # 宝可梦数据结构
│   ├── dex-moves.ts       # 技能数据结构
│   ├── dex-items.ts       # 道具数据结构
│   ├── dex-abilities.ts   # 特性数据结构
│   ├── dex-conditions.ts  # 状态条件
│   ├── dex-formats.ts     # 对战格式
│   ├── teams.ts           # 队伍工具
│   ├── team-validator.ts  # 队伍验证器 (113KB)
│   ├── prng.ts            # 伪随机数生成器
│   ├── tools/             # 模拟器工具
│   └── examples/          # 使用示例
│
├── data/                   # 游戏数据
│   ├── pokedex.ts         # 宝可梦数据 (535KB)
│   ├── moves.ts           # 技能数据 (502KB)
│   ├── abilities.ts       # 特性数据 (154KB)
│   ├── items.ts           # 道具数据 (163KB)
│   ├── learnsets.ts       # 学习技能表 (3.7MB)
│   ├── formats-data.ts    # 格式数据 (93KB)
│   ├── conditions.ts      # 状态条件
│   ├── natures.ts         # 性格数据
│   ├── typechart.ts       # 属性克制表
│   ├── aliases.ts         # 别名映射
│   ├── rulesets.ts        # 规则集
│   ├── tags.ts            # 标签系统
│   ├── text/              # 文本描述
│   ├── random-battles/    # 随机对战数据
│   └── mods/              # 世代/变体规则 (50个子目录)
│       ├── gen1/
│       ├── gen2/
│       ├── ...
│       └── gen9/
│
├── lib/                    # 通用工具库
│   ├── index.ts           # 库入口
│   ├── streams.ts         # 流处理 (25KB)
│   ├── process-manager.ts # 多进程管理 (23KB)
│   ├── database.ts        # 数据库抽象层
│   ├── sql.ts             # SQL 工具
│   ├── fs.ts              # 文件系统工具
│   ├── net.ts             # 网络工具
│   ├── utils.ts           # 通用工具函数
│   ├── repl.ts            # REPL 调试服务
│   ├── crashlogger.ts     # 崩溃日志
│   ├── static-server.ts   # 静态文件服务
│   └── dashycode.ts       # 编码工具
│
├── config/                 # 配置文件
│   ├── config-example.js  # 配置示例
│   └── formats.ts         # 对战格式配置
│
├── test/                   # 测试用例
│   ├── sim/               # 模拟器测试
│   └── random-battles/    # 随机对战测试
│
├── tools/                  # 开发工具
│   ├── set-import/        # 队伍导入工具
│   └── modlog/            # Modlog 工具
│
├── translations/           # 国际化翻译
│
├── databases/              # 数据库文件目录
│
├── logs/                   # 日志目录
│
└── 配置文件
    ├── package.json
    ├── tsconfig.json
    ├── eslint.config.mjs
    ├── .mocharc.json
    └── pokemon-showdown   # 启动脚本
```

---

## 5. 核心模块详解

### 5.1 Sockets (`server/sockets.ts`)

负责 WebSocket 连接管理，是用户与服务器通信的入口。

```typescript
export const Sockets = new class {
    // 处理新连接
    async onSpawn(worker: StreamWorker) {
        for await (const data of worker.stream) {
            switch (data.charAt(0)) {
                case '*': // 新连接
                    Users.socketConnect(worker, id, socketid, ip, protocol);
                    break;
                case '!': // 断开连接
                    Users.socketDisconnect(worker, id, socketid);
                    break;
                case '<': // 收到消息
                    Users.socketReceive(worker, id, socketid, message);
                    break;
            }
        }
    }

    // 发送消息到客户端
    socketSend(worker, socketid, message) {
        void worker.stream.write(`>${socketid}\n${message}`);
    }
}
```

### 5.2 Users (`server/users.ts`)

用户管理系统，处理用户状态、连接、权限等。

**主要导出**:
- `Users.users` - 全局用户表
- `Users.connections` - 全局连接表
- `Users.socketConnect()` - 处理新连接
- `Users.socketReceive()` - 处理消息

### 5.3 Rooms (`server/rooms.ts`)

房间管理系统，每个聊天室和对战都是一个房间。

**主要导出**:
- `Rooms.rooms` - 全局房间表
- `Rooms.global` - 全局房间 (所有用户都在)
- `Rooms.GlobalRoomState` - 全局房间状态类

### 5.4 Chat (`server/chat.ts`)

聊天命令处理系统，解析并执行所有聊天命令。

**命令格式**:
```
/command argument1, argument2
```

**命令定义位置**:
- `server/chat-commands/` - 核心命令
- `server/chat-plugins/` - 插件命令

### 5.5 Dex (`sim/dex.ts`)

图鉴数据加载器，提供宝可梦、技能、道具等数据访问。

```typescript
const { Dex } = require('../sim/dex');

// 获取宝可梦数据
const pikachu = Dex.species.get('Pikachu');

// 获取技能数据
const thunderbolt = Dex.moves.get('Thunderbolt');

// 获取道具数据
const leftovers = Dex.items.get('Leftovers');

// 获取特性数据
const static = Dex.abilities.get('Static');
```

---

## 6. 服务器启动流程

入口文件: `server/index.ts`

```typescript
// 启动流程
export const readyPromise = cleanupStale()  // 1. 清理旧的 REPL 套接字
    .then(() => setupGlobals())              // 2. 初始化全局对象
    .then(() => {
        // 3. 启动子系统
        if (Config.usesqlite) {
            require('./modlog').start(Config.subprocessescache);
        }
        Rooms.global.start(Config.subprocessescache);
        Verifier.start(Config.subprocessescache);
        TeamValidatorAsync.start(Config.subprocessescache);
        Chat.start(Config.subprocessescache);

        // 4. 监听配置文件变化
        if (Config.watchconfig) {
            ConfigLoader.watch();
        }

        // 5. 设置错误处理
        if (Config.crashguard) {
            process.on('uncaughtException', (err) => {
                Monitor.crashlog(err, 'The main process');
            });
        }

        // 6. 启动 REPL 调试服务器
        Repl.startGlobal('app');

        // 7. 运行启动钩子
        if (Config.startuphook) {
            process.nextTick(Config.startuphook);
        }
    });
```

### 全局对象初始化 (`setupGlobals`)

```typescript
function setupGlobals() {
    global.Monitor = require('./monitor').Monitor;
    global.Dex = require('../sim/dex').Dex;
    global.toID = Dex.toID;
    global.Chat = require('./chat').Chat;
    global.Rooms = require('./rooms').Rooms;
    global.Teams = require('../sim/teams').Teams;
    global.LoginServer = require('./loginserver').LoginServer;
    global.Ladders = require('./ladders').Ladders;
    global.Users = require('./users').Users;
    global.Punishments = require('./punishments').Punishments;
    global.Verifier = require('./verifier');
    global.Tournaments = require('./tournaments').Tournaments;
    global.IPTools = require('./ip-tools').IPTools;
    global.TeamValidatorAsync = require('./team-validator-async');
    global.Sockets = Sockets;

    // 初始化全局房间
    Rooms.global = new Rooms.GlobalRoomState();

    // 启动网络监听
    Sockets.start(Config.subprocessescache);
}
```

---

## 7. 网络通信协议

### 7.1 连接方式

使用 SockJS (WebSocket 抽象层):

```
ws://sim.smogon.com:8000/showdown/websocket
wss://sim3.psim.us/showdown/websocket
```

### 7.2 客户端 → 服务器

**格式**:
```
ROOMID|TEXT
```

- `ROOMID`: 房间 ID (可省略)
- `TEXT`: 消息内容 (可包含换行)

**示例**:
```
lobby|/join battle-gen9ou-123456
|/pm zarel, Hello!
battle-gen9ou-123456|/choose move 1
```

### 7.3 服务器 → 客户端

**格式**:
```
>ROOMID
|TYPE|DATA
|TYPE|DATA
...
```

- `>ROOMID`: 房间标识 (lobby/global 可省略)
- `|TYPE|DATA`: 消息类型和数据

### 7.4 常见消息类型

#### 房间初始化
```
|init|chat                    # 聊天室
|init|battle                  # 对战室
|title|Room Title             # 房间标题
|users|@Mod,+Voice, User      # 用户列表
```

#### 聊天消息
```
|j| Username                  # 用户加入 (j = join)
|l| Username                  # 用户离开 (l = leave)
|c|@Mod|Hello everyone!       # 聊天消息 (c = chat)
|c:|1234567890|@Mod|Hello!    # 带时间戳的聊天
```

#### 对战消息
```
|player|p1|Alice|avatar123    # 玩家信息
|teamsize|p1|6                # 队伍大小
|move|p1a: Pikachu|Thunderbolt|p2a: Charizard
|damage|p2a: Charizard|50/100 # 伤害
|-supereffective|p2a: Charizard
|faint|p2a: Charizard         # 倒下
|win|Alice                    # 胜利
```

#### 缩写形式

为节省带宽，部分消息类型可缩写:

| 完整 | 缩写 | 说明 |
|------|------|------|
| `chat` | `c` | 聊天 |
| `join` | `j` / `J` | 加入 |
| `leave` | `l` / `L` | 离开 |
| `name` | `n` / `N` | 改名 |
| `battle` | `b` / `B` | 对战 |

大写版本 (`J`, `L`, `N`, `B`) 建议不在界面内联显示 (频率过高)。

---

## 8. 战斗模拟器

### 8.1 核心文件

| 文件 | 说明 | 大小 |
|------|------|------|
| `sim/battle.ts` | 战斗主逻辑 | 115KB |
| `sim/battle-actions.ts` | 战斗动作 | 73KB |
| `sim/pokemon.ts` | 宝可梦对象 | 74KB |
| `sim/side.ts` | 玩家场地 | 43KB |
| `sim/team-validator.ts` | 队伍验证 | 113KB |

### 8.2 事件驱动系统

战斗模拟器的核心是**事件系统**，所有游戏机制通过事件处理:

```typescript
// sim/battle.ts
runEvent(
    eventid: string,      // 事件名称
    target?: Pokemon,     // 目标
    source?: Pokemon,     // 来源
    sourceEffect?: Effect,// 来源效果
    relayVar?: any        // 传递变量
): any
```

#### 事件优先级

事件处理器按以下顺序排序:

1. `order` - 主排序 (数值越小越先)
2. `priority` - 优先级
3. `subOrder` - 子排序
4. `speed` - 速度 (同优先级时)

#### 常见事件

```typescript
// 回合开始/结束
'BeforeTurn', 'Residual'

// 技能使用流程
'BeforeMove', 'BasePower', 'Damage', 'AfterMove'

// 伤害相关
'TryHit', 'TryImmunity', 'ModifyDamage'

// 状态变化
'SetStatus', 'TryAddVolatile', 'ModifyBoost'

// 切换相关
'SwitchIn', 'SwitchOut', 'DragOut'
```

### 8.3 返回值约定

事件处理器的返回值有特殊含义:

| 返回值 | 含义 | 示例 |
|--------|------|------|
| `false` | 动作失败 | 地面系免疫电系技能 |
| `null` | 静默失败 (不显示失败消息) | 蓄电特性吸收电系技能 |
| `undefined` | 忽略该处理器 | 蓄电特性不处理火系技能 |

**示例**: 电系技能打地面系

```typescript
// 免疫检查器返回 false → 显示 "It doesn't affect..."
onTryImmunity(target, source, move) {
    if (move.type === 'Electric' && target.hasType('Ground')) {
        return false;
    }
}

// 蓄电特性返回 null → 显示特性效果，不显示失败消息
onTryHit(target, source, move) {
    if (move.type === 'Electric') {
        this.heal(target.maxhp / 4);
        this.add('-immune', target, '[from] ability: Volt Absorb');
        return null;
    }
}
```

### 8.4 伤害计算系统

伤害计算是战斗模拟器的核心逻辑，位于 `sim/battle-actions.ts`。

#### 核心函数

| 函数 | 说明 | 位置 |
|------|------|------|
| `getDamage()` | 主伤害计算函数 | `battle-actions.ts:1583` |
| `modifyDamage()` | 伤害修正函数 | `battle-actions.ts:1722` |
| `getConfusionDamage()` | 混乱自伤计算 | `battle-actions.ts:1844` |

#### 伤害公式

基础伤害公式（与游戏一致）:

```
baseDamage = ((2 * Level / 5 + 2) * BasePower * Attack / Defense) / 50
```

代码实现 (`battle-actions.ts:1716`):

```typescript
const baseDamage = tr(tr(tr(tr(2 * level / 5 + 2) * basePower * attack) / defense) / 50);
```

> `tr` = `this.battle.trunc`，用于整数截断（模拟游戏的整数运算）

#### 完整计算流程

```
getDamage() 流程:
│
├── 1. 免疫检查
│   └── target.runImmunity(move)
│       → false: 免疫，返回 false
│
├── 2. 特殊伤害处理
│   ├── OHKO 技能 → 返回 target.maxhp
│   ├── damageCallback → 返回回调结果
│   └── 固定伤害 → 返回 move.damage
│
├── 3. 基础威力计算
│   ├── move.basePower 或 basePowerCallback
│   └── BasePower 事件修正
│
├── 4. 会心一击判定
│   ├── critRatio 计算
│   ├── Gen 5-: [0, 16, 8, 4, 3, 2]
│   ├── Gen 6:  [0, 16, 8, 2, 1]
│   └── Gen 7+: [0, 24, 8, 2, 1]
│
├── 5. 能力值计算
│   ├── 攻击方: atk 或 spa
│   ├── 防御方: def 或 spd
│   ├── 能力等级修正
│   └── 会心忽略不利修正
│
├── 6. 能力值事件修正
│   ├── ModifyAtk / ModifySpA
│   └── ModifyDef / ModifySpD
│
├── 7. 基础伤害公式
│   └── ((2*L/5+2) * BP * Atk / Def) / 50
│
└── 8. 调用 modifyDamage() 进行最终修正
```

#### modifyDamage() 修正流程

```
modifyDamage() 流程:
│
├── 1. +2 常数
│   └── baseDamage += 2
│
├── 2. 多目标修正 (双打)
│   ├── 双打: × 0.75
│   └── 乱斗: × 0.5
│
├── 3. 亲子爱修正 (第二击)
│   ├── Gen 7+: × 0.25
│   └── Gen 6:  × 0.5
│
├── 4. 天气修正
│   └── WeatherModifyDamage 事件
│
├── 5. 会心修正
│   ├── Gen 6+: × 1.5
│   └── Gen 5-: × 2.0
│
├── 6. 随机因子
│   └── × (0.85 ~ 1.00)
│
├── 7. STAB (属性一致加成)
│   ├── 普通 STAB: × 1.5
│   ├── 太晶 STAB: × 2.0
│   └── 星晶首次: × 2.0 (本系) 或 × 1.2 (非本系)
│
├── 8. 属性相克
│   ├── 效果绝佳: × 2^n
│   └── 效果不好: × 0.5^n
│
├── 9. 烧伤减伤
│   └── 物理技能 × 0.5 (无根性)
│
├── 10. ModifyDamage 事件
│   └── 生命宝珠等道具修正
│
├── 11. Z/极巨破盾修正
│   └── × 0.25
│
└── 12. 最小伤害保证
    └── 至少为 1
```

#### 代码示例

```typescript
// sim/battle-actions.ts

getDamage(source, target, move, suppressMessages = false) {
    // 免疫检查
    if (!target.runImmunity(move, !suppressMessages)) {
        return false;
    }

    // OHKO 技能
    if (move.ohko) return target.maxhp;

    // 固定伤害
    if (move.damage === 'level') return source.level;
    if (move.damage) return move.damage;

    // 基础威力
    let basePower = move.basePower;
    if (move.basePowerCallback) {
        basePower = move.basePowerCallback.call(this.battle, source, target, move);
    }

    // 会心判定
    const critRatio = this.battle.runEvent('ModifyCritRatio', source, target, move, move.critRatio || 0);
    moveHit.crit = this.battle.randomChance(1, critMult[critRatio]);

    // BasePower 事件
    basePower = this.battle.runEvent('BasePower', source, target, move, basePower, true);

    // 能力值计算
    let attack = attacker.calculateStat(attackStat, atkBoosts, 1, source);
    let defense = defender.calculateStat(defenseStat, defBoosts, 1, target);

    // 能力值修正事件
    attack = this.battle.runEvent('ModifyAtk', source, target, move, attack);
    defense = this.battle.runEvent('ModifyDef', target, source, move, defense);

    // 基础伤害公式
    const baseDamage = tr(tr(tr(tr(2 * level / 5 + 2) * basePower * attack) / defense) / 50);

    // 最终修正
    return this.modifyDamage(baseDamage, source, target, move, suppressMessages);
}
```

#### 关键事件钩子

伤害计算过程中触发的主要事件：

| 事件 | 触发时机 | 常见用途 |
|------|----------|----------|
| `ModifyCritRatio` | 会心率计算 | 聚气、狙击手 |
| `CriticalHit` | 会心确认 | 战斗盔甲 (阻止会心) |
| `BasePower` | 基础威力修正 | 技师、铁拳 |
| `ModifyAtk` | 攻击修正 | 力量束带、讲究头带 |
| `ModifySpA` | 特攻修正 | 讲究眼镜 |
| `ModifyDef` | 防御修正 | 奇迹鳞片 |
| `ModifySpD` | 特防修正 | 突击背心 |
| `WeatherModifyDamage` | 天气修正 | 晴天火系+50% |
| `ModifySTAB` | STAB 修正 | 适应力 |
| `ModifyDamage` | 最终伤害修正 | 生命宝珠、滤镜 |

#### 混乱自伤

混乱自伤使用简化公式，不应用大多数修正：

```typescript
getConfusionDamage(pokemon, basePower) {
    const attack = pokemon.calculateStat('atk', pokemon.boosts['atk']);
    const defense = pokemon.calculateStat('def', pokemon.boosts['def']);
    const level = pokemon.level;

    // 简化公式
    const baseDamage = tr(tr(tr(tr(2 * level / 5 + 2) * basePower * attack) / defense) / 50) + 2;

    // 随机因子
    let damage = this.battle.randomizer(baseDamage);

    return Math.max(1, damage);
}
```

### 8.5 PRNG (伪随机数生成器)

`sim/prng.ts` 实现确定性随机数，支持对战回放:

```typescript
import { PRNG } from './prng';

const prng = new PRNG([seed1, seed2, seed3, seed4]);

// 生成随机数
prng.next();           // 0-1 之间的浮点数
prng.randomChance(85, 100);  // 85% 概率返回 true
prng.sample(array);    // 随机选择数组元素
```

### 8.6 独立使用模拟器

模拟器可以作为独立 npm 包使用:

```bash
npm install pokemon-showdown
```

```typescript
const { Dex, Teams, BattleStream } = require('pokemon-showdown');

// 验证队伍
const validator = Teams.getValidator('gen9ou');
const problems = validator.validateTeam(team);

// 创建对战
const stream = new BattleStream();
stream.write(`>start {"formatid":"gen9ou"}`);
stream.write(`>player p1 {"name":"Alice","team":"${packedTeam1}"}`);
stream.write(`>player p2 {"name":"Bob","team":"${packedTeam2}"}`);
```

---

## 9. 多进程架构

### 9.1 进程管理器

`lib/process-manager.ts` 管理子进程:

```typescript
import { ProcessManager } from '../lib';

const PM = new ProcessManager.StreamProcessManager(module, () => {
    // 工作进程逻辑
    return new Streams.ObjectReadWriteStream({
        async write(data) {
            // 处理数据
            return result;
        }
    });
});

// 主进程启动工作进程
PM.spawn(workerCount);
```

### 9.2 工作进程类型

| 进程 | 用途 | 配置项 |
|------|------|--------|
| network | WebSocket 连接处理 | `subprocessescache.network` |
| team-validator | 队伍验证 | `subprocessescache.teamvalidator` |
| modlog | 管理日志 | `subprocessescache.modlog` |

### 9.3 进程通信

使用流 (Streams) 进行进程间通信:

```typescript
// 主进程发送
void worker.stream.write(`>${socketid}\n${message}`);

// 工作进程接收
for await (const data of stream) {
    // 处理数据
}
```

---

## 10. 数据格式规范

### 10.1 ID 标准化

所有标识符使用 `toID()` 函数标准化:

```typescript
toID(name: string): ID

// 规则: 小写 + 移除非字母数字字符
toID("Pikachu")        // → "pikachu"
toID("Pikachu-Libre")  // → "pikachulibre"
toID("Mr. Mime")       // → "mrmime"
toID("Flabébé")        // → "flabebe"
```

### 10.2 字符串引号约定

```typescript
// 模板字符串 - 插值、HTML、协议代码
`<strong>${move.name}</strong>`
`|move|${pokemon}|${move}|${target}`

// 单引号 - 内部 ID、非用户可见字符串
'thunderbolt'
'gen9ou'

// 双引号 - 用户可见文本、名称
"Thunderbolt"
"Fire Blast"
"The opposing Pikachu"
```

### 10.3 可选值约定

```typescript
// 标准约定: 使用 null 表示可选
function getMove(id: ID): Move | null

// 旧代码可能使用 undefined (已弃用)
function oldGetMove(id: ID): Move | undefined

// 更旧的代码使用 false (PHP 遗留，请重构)
function veryOldGetMove(id: ID): Move | false
```

### 10.4 事件返回值

模拟器中 `false | null | undefined` 有特殊含义:

```typescript
// 事件处理器返回值
false     // 动作失败，显示失败消息
null      // 静默失败，不显示消息
undefined // 忽略此处理器，继续执行
```

---

## 11. 开发规范

### 11.1 注释规范

#### 不要教 JavaScript
```typescript
// 错误 ❌
// Increase counter by 1.
counter++;

// 正确 ✓
counter++;
```

#### 用变量名自文档化
```typescript
// 错误 ❌
/** move name */
let value = "Stealth Rock";

// 正确 ✓
let moveName = "Stealth Rock";
```

#### 使用 JSDoc 注释
```typescript
/** null = not accepting connections */
let numConnections: number | null = null;
```

### 11.2 代码风格

#### 循环
```typescript
// 推荐 ✓
for (const item of array) { }

// 避免 ❌
array.forEach(item => { });
```

#### 空值合并
```typescript
// 推荐 (大多数情况)
const value = foo || defaultValue;

// 仅当需要保留 0/''/ false 时使用 ??
const count = input ?? 0;
```

#### 模板字符串
```typescript
// 避免多行模板字符串 ❌
const html = `
    <div>
        ${content}
    </div>
`;

// 推荐 ✓
const html = '<div>\n' +
    '\t' + content + '\n' +
    '</div>';
```

### 11.3 提交信息规范

#### 格式
```
Tag: Imperative description (under 50 chars)

Optional detailed description.
```

#### 示例
```
# 正确 ✓
Monotype: Ban Genesect
Fix Mold Breaker Wonder Guard interaction
Refactor Users to use classes

# 错误 ❌
ban genesect                    # 没有标签，没有大写
Adding namefilter              # 不是祈使句
Adds namefilter.               # 不是祈使句，有句号
```

---

## 12. 测试指南

### 12.1 运行测试

```bash
# 完整测试 (lint + type check + unit tests)
npm test

# 仅运行单元测试
npx mocha

# 运行特定测试
npx mocha -g "Thunderbolt"

# 完整测试 (带超时)
npm run full-test
```

### 12.2 测试文件结构

```
test/
├── main.js              # 测试入口
├── sim/                 # 模拟器测试
│   ├── moves.js        # 技能测试
│   ├── abilities.js    # 特性测试
│   └── items.js        # 道具测试
└── random-battles/      # 随机对战测试
```

### 12.3 编写测试

```javascript
describe('Thunderbolt', function () {
    it('should deal Electric-type damage', function () {
        battle = common.createBattle();
        battle.setPlayer('p1', { team: [{ species: 'Pikachu', moves: ['thunderbolt'] }] });
        battle.setPlayer('p2', { team: [{ species: 'Magikarp', moves: ['splash'] }] });

        battle.makeChoices('move thunderbolt', 'move splash');

        assert.false.fullHP(battle.p2.active[0]);
    });

    // 仅运行此测试
    it.only('should be super effective against Water', function () {
        // ...
    });
});
```

---

## 13. Mod 系统

### 13.1 Mod 目录结构

`data/mods/` 包含 50+ 个游戏变体:

```
data/mods/
├── gen1/           # 第一世代
├── gen2/           # 第二世代
├── ...
├── gen9/           # 第九世代
├── gen9dlc1/       # DLC 变体
└── gen9ssb/        # 特殊规则
```

### 13.2 Mod 文件结构

每个 mod 可以覆盖以下文件:

```
data/mods/gen1/
├── moves.ts        # 技能修改
├── abilities.ts    # 特性修改 (Gen 1 没有)
├── items.ts        # 道具修改
├── pokedex.ts      # 宝可梦数据修改
├── formats-data.ts # 格式数据
├── conditions.ts   # 状态条件
├── rulesets.ts     # 规则集
└── scripts.ts      # 战斗脚本
```

### 13.3 创建自定义 Mod

```typescript
// data/mods/mymod/scripts.ts
export const Scripts: ModdedBattleScriptsData = {
    inherit: 'gen9',  // 继承的基础 mod

    // 覆盖战斗方法
    getDamage(source, target, move, suppressMessages) {
        // 自定义伤害计算
        let damage = this.actions.getDamage(source, target, move, suppressMessages);
        return damage * 2;  // 双倍伤害
    }
};
```

---

## 14. 常用命令

### 14.1 开发命令

```bash
# 启动服务器
./pokemon-showdown
node pokemon-showdown

# 指定端口
./pokemon-showdown 8080

# 构建项目
npm run build

# 类型检查
npm run tsc

# 代码检查
npm run lint

# 修复代码风格
npm run fix
```

### 14.2 测试命令

```bash
# 完整测试
npm test

# 仅单元测试
npx mocha

# 特定测试
npx mocha -g "pattern"

# 完整 CI 测试
npm run full-test-ci
```

### 14.3 NPM 发布

```bash
# 构建声明文件
./build decl

# 发布 (仅维护者)
npm publish
```

### 14.4 命令行工具

```bash
# 查看帮助
./pokemon-showdown help

# 模拟对战
./pokemon-showdown simulate-battle

# 验证队伍
./pokemon-showdown validate-team

# 生成随机队伍
./pokemon-showdown generate-team
```

---

## 附录

### A. 相关文档

| 文档 | 说明 |
|------|------|
| [PROTOCOL.md](./PROTOCOL.md) | 客户端-服务器通信协议 |
| [sim/SIM-PROTOCOL.md](./sim/SIM-PROTOCOL.md) | 对战消息协议 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 贡献指南 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构概述 |
| [sim/SIMULATOR.md](./sim/SIMULATOR.md) | 模拟器 API |
| [sim/TEAMS.md](./sim/TEAMS.md) | 队伍 API |
| [sim/DEX.md](./sim/DEX.md) | 图鉴 API |
| [COMMANDLINE.md](./COMMANDLINE.md) | 命令行工具 |

### B. 社区资源

- 官网: https://pokemonshowdown.com/
- 论坛: https://www.smogon.com/forums/forums/pokémon-showdown.209/
- Discord: https://psim.us/devdiscord
- 新手项目: https://github.com/smogon/pokemon-showdown/issues/2444

### C. 许可证

MIT License - 详见 [LICENSE](./LICENSE)
