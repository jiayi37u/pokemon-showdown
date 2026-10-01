# v1.0 设计文档

## 架构设计

### 系统概览

```
用户聊天命令
    │
    ▼
ChatPlugin (npc.ts)
    │
    ▼
NPCManager (manager.ts)
    │
    ├─ 加载 NPC 模板
    ├─ 验证队伍文件
    └─ 创建对战房间
        │
        ▼
    RoomBattle (room.ts)
        │
        ├─ 初始化战斗
        ├─ 实例化 AI
        └─ 轮询 AI 决策
            │
            ▼
        BasicAI (basic.ts)
            │
            ├─ 解析 request
            ├─ 评估招式
            └─ 返回选择
```

### 模块划分

| 模块 | 职责 | 文件 |
|------|------|------|
| NPCManager | NPC 模板管理、队伍加载 | `server/npc/manager.ts` |
| RoomBattle | 对战房间创建、AI 轮询 | `server/npc/room.ts` |
| NPCBattleAI | AI 基类接口 | `server/npc/ai/index.ts` |
| BasicAI | 简单 AI 实现 | `server/npc/ai/basic.ts` |
| ChatPlugin | 聊天命令处理 | `server/chat-plugins/npc.ts` |

---

## 关键设计决策

### 决策 1: 多进程架构下的 AI 实现

**背景**: Pokemon Showdown 使用主进程 (Server) 和子进程 (Simulator) 分离架构，`Battle` 对象和完整状态在子进程中。

**挑战**: AI 运行在主进程，无法直接访问对手精灵信息 (`battle.sides[0].active`)。

**方案**: 通过 `request` 对象获取己方信息，对手信息在 v1.0 中不追踪（BasicAI 只需要招式元数据）。

```typescript
// v1.0 限制: 只能访问 request 数据
makeDecision(active, moves, switches) {
    // active: 己方精灵信息
    // moves: 可用招式列表
    // switches: 可换人选项

    // 无法访问: 对手精灵、对手能力变化、场地状态等
}
```

**后续**: v1.1 将引入 `BattleTracker` 通过协议消息追踪对手状态。

### 决策 2: BasicAI 决策算法

**需求**: 选择伤害最高的招式。

**伤害估算公式**:
```
估算伤害 = 基础威力 × STAB × 属性克制 × 特性修正
```

**简化假设**:
- 对手防御 = 100（中等值）
- 不考虑能力变化
- 不考虑天气/地形
- 不考虑道具

**理由**: v1.0 目标是快速实现可用的 AI，复杂计算推迟到 v1.1。

### 决策 3: choose 方法格式

**问题**: 服务端需要玩家前缀的命令格式。

```typescript
// 本地格式
stream.write('move 1');

// 服务端格式
stream.write('>p2 move 1');  // NPC 固定是 p2
```

**解决方案**: 在 `room.ts` 中重写 AI 的 `choose` 方法：

```typescript
ai.choose = (choice: string) => {
    void battle.stream.write(`>p2 ${choice}`);
};
```

### 决策 4: NPC 模板存储格式

**选择**: JSON 文件

**格式设计**:
```json
{
  "gymbrock": {
    "id": "gymbrock",
    "name": "Brock",
    "difficulty": "basic",
    "teamFile": "gym-brock.txt"
  }
}
```

**理由**:
- 易于编辑
- 支持版本控制
- 与 PS 现有配置格式一致

---

## 数据模型

### NPCTemplate

```typescript
interface NPCTemplate {
    id: string;           // NPC 唯一标识符
    name: string;         // 显示名称
    difficulty: string;   // AI 难度 (v1.0 固定为 "basic")
    teamFile: string;     // 队伍文件路径
}
```

### NPCBattleAI 接口

```typescript
abstract class NPCBattleAI {
    abstract makeDecision(
        active: AnyObject,
        moves: Move[],
        switches: Pokemon[]
    ): string;

    choose(choice: string): void;  // 可重写
}
```

---

## 实现细节

### BasicAI 决策流程

```
收到 request
    │
    ▼
获取可用招式
    │
    ├─ 无招式 → 返回 'default'
    │
    └─ 有招式
        │
        ▼
    为每个招式计算伤害
        │
        ├─ 获取招式数据 (Dex.moves.get)
        ├─ 计算 STAB (1.5x)
        ├─ 计算克制 (Dex.getEffectiveness)
        ├─ 检查免疫 (Dex.getImmunity)
        └─ 计算最终伤害
            │
            ▼
    选择伤害最高的招式
```

### 类型免疫检查

```typescript
// 检查属性免疫 (如地面 vs 飞行)
const typeImmune = !Dex.getImmunity(move.type, targetTypes);

// 检查特性免疫 (如蓄电 vs 电系)
const abilityImmune = this.checkAbilityImmunity(move.type, ability);
```

### STAB 计算

```typescript
const hasSTAB = selfTypes.includes(move.type);
const stab = hasSTAB ? 1.5 : 1.0;
```

---

## 测试策略

### 单元测试

测试文件: `test/npc/ai/basic.test.js`

测试覆盖:
- [x] 招式伤害计算
- [x] 类型免疫检查
- [x] STAB 加成
- [x] 属性克制计算
- [x] 无可用招式场景

### 集成测试

测试场景:
1. 完整对战流程（创建房间 → AI 决策 → 对战结束）
2. 不同对战格式（单打/双打/随机）
3. 多个 NPC 模板

---

## 性能考虑

### AI 决策性能

- 招式评估: O(n)，n = 招式数量（通常 ≤ 4）
- Dex 查询: 缓存机制，O(1)
- 总决策时间: < 10ms（测量值）

### 内存占用

- NPCManager: 单例模式，加载所有模板
- BattleAI: 每场对战一个实例
- 预期内存占用: < 5MB per battle

---

## 安全性

### 队伍文件验证

```typescript
// 防止路径遍历攻击
const teamPath = path.join(TEAMS_DIR, template.teamFile);
if (!teamPath.startsWith(TEAMS_DIR)) {
    throw new Error('Invalid team file path');
}
```

### 命令权限

- `/npc` 命令无需特殊权限
- NPC 对战不影响用户排名

---

## 限制与已知问题

### v1.0 限制

1. **AI 只使用攻击招式**: 不评估状态招式和强化招式
2. **不主动换人**: 即使场上精灵不利也不换人
3. **伤害估算不准确**: 不考虑能力变化、天气等因素
4. **无对手状态追踪**: 无法获取对手 boosts、特性等

### 已知问题

无重大 bug（v1.0.0 发布时）。

---

## 后续版本计划

v1.1 将解决以下问题：
1. 引入 `BattleTracker` 追踪对手状态
2. 实现完整的伤害计算公式
3. 引入 CFRU 评分系统
4. 实现 NormalAI

详见 [v1.1 需求文档](../v1.1/requirements.md)。

---

*最后更新: 2026-01-24*
