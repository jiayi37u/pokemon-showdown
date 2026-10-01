# 已知问题与解决方案

本文档记录开发过程中遇到的 bug，包括原因分析和解决方案，供后续开发参考。

---

## Bug 1: AI 选择机制问题

**版本**: v1.1.0
**发现日期**: 2026-01-22

### 问题
NPC 模板设置 `difficulty: "smart"`，但实际运行的总是 BasicAI。

### 原因
`room.ts` 中硬编码创建 BasicAI：
```typescript
const ai = new BasicAI(battle.stream);  // 总是 BasicAI
```

### 解决方案
根据 `difficulty` 字段选择 AI 类。

---

## Bug 2: AI 无响应

**版本**: v1.1.0
**发现日期**: 2026-01-22

### 问题
服务端显示 `Using NormalAI`，但战斗界面一直 "Waiting for opponent..."。

### 原因
`BattlePlayer.choose()` 直接写入 `move 1`，但服务端需要 `>p2 move 1` 格式。

### 解决方案
重写 `choose` 方法添加 `>p2` 前缀。

---

## Bug 3: 招式分类识别错误

**版本**: v1.1.0
**发现日期**: 2026-01-22

### 问题
BasicAI 反复使用隐形岩 (Status)，不使用攻击招式。

### 原因
request 数据不含 `category` 字段，默认值是 `'Status'`，导致所有招式都被标记为 Status。

### 解决方案
从 Dex 查询招式的完整信息：
```typescript
const dexMove = Dex.moves.get(move.move);
category: dexMove.category || 'Status'
```

---

## Bug 4: 无法获取对手信息

**版本**: v1.1.0
**发现日期**: 2026-01-22

### 问题
AI 对飞行系使用地震，无法计算类型免疫。日志显示 "No defender info"。

### 原因
服务端架构中 `Battle` 对象在子进程，AI 运行在主进程，无法访问 `battle.sides`。

### 解决方案
创建 `BattleTracker`，通过监听协议消息追踪对手状态。

---

## Bug 5: 属性免疫未检测

**版本**: v1.1.2
**发现日期**: 2026-01-23

### 问题
地面系招式对飞行系返回正常伤害 (1x) 而非免疫 (0x)。

### 原因
`getTypeEffectiveness` 只使用 `Dex.getEffectiveness()`，该函数不包含免疫检查。

### 解决方案
先调用 `Dex.getImmunity()` 检查免疫：
```typescript
if (!Dex.getImmunity(moveType, defenderTypes)) {
    return 0;  // 免疫
}
```

**PS Dex API 注意**: `getImmunity` 返回 `false` 表示免疫。

---

## Bug 6: 魔法镜特性遗漏

**版本**: v1.1.2
**发现日期**: 2026-01-23

### 问题
AI 对魔法镜精灵使用隐形岩，被反弹到己方场地。

### 原因
搜索了错误的项目目录 (`pokefirered` 而非 `Complete-Fire-Red-Upgrade`)，误以为 CFRU 没有魔法镜处理。

### 解决方案
使用招式的 `reflectable` 标志检查：
```typescript
if (ctx.move.flags['reflectable']) {
    return -20;
}
```

### 教训
**始终使用正确的 CFRU 源码目录**：
- ✅ `Complete-Fire-Red-Upgrade/src/Battle_AI/`
- ❌ `pokefirered/src/`

---

## Bug 7: 己方 boosts 读取错误

**版本**: v1.1.1
**发现日期**: 2026-01-22

### 问题
使用剑舞后，下回合仍显示 `atk: +0`，AI 不断重复使用剑舞。

### 原因
1. 硬编码使用 `battle.sides[0]` 读取 boosts
2. NPC AI 是 p2，数据在 `battle.sides[1]`
3. 服务端环境中 `battle.sides` 根本不存在

### 解决方案
在 `BattleTracker` 中追踪我方 boosts：
```typescript
private ourActiveBoosts: Map<string, BoostStats> = new Map();

// 监听 |-boost| 消息同时追踪我方
if (side === this.ourSide) {
    boosts[stat] += amount;
}
```

---

## Bug 8: 切换后 boosts 未清空

**版本**: v1.1.1
**发现日期**: 2026-01-22

### 问题
使用剑舞后切换精灵，新精灵仍显示 `atk: +4`。

### 原因
`handleSwitch` 只追踪对手切换，忽略了我方。切换时 `ourActiveBoosts` 没有重置。

### 解决方案
我方切换时清空对应 slot 的 boosts：
```typescript
if (side === this.ourSide) {
    this.ourActiveBoosts.set(slot, { atk: 0, def: 0, ... });
}
```

---

## Bug 9: 隐形岩追踪失败

**版本**: v1.1.3
**发现日期**: 2026-01-23

### 问题
AI 在已设置隐形岩后仍重复使用。

### 原因
PS 协议消息格式是 `|-sidestart|p1: Player|move: Stealth Rock`，condition 部分含 `"move: "` 前缀。
`toID("move: Stealth Rock")` = `"movestealthrock"`，不等于 `"stealthrock"`。

### 解决方案
解析时去除 `"move: "` 前缀：
```typescript
if (condition.startsWith('move: ')) {
    condition = condition.slice(6);
}
```

---

## Bug 10: 强化招式评分不递减

**版本**: v1.1.3
**发现日期**: 2026-01-23

### 问题
多次使用剑舞，每次评分都是 +12，没有递减。

### 原因
`checkStatBoostWasted` 没有正确读取当前 boosts 值。

### 解决方案
实现递减收益：
| 当前 atk | 剑舞加成 |
|----------|---------|
| +0 | +14 |
| +2 | +8 |
| +4 | +3 |
| +6 | 0 |

---

## Bug 11: Encore/Disable 逻辑错误

**版本**: v1.1.6
**发现日期**: 2026-01-23

### 问题
AI 在对手没有使用过招式时仍尝试使用 Encore/Disable，或者对手刚使用了攻击招式时 Encore 评分过高。

### 原因
原实现检查对手的**招式池** (`ctx.target.moves.some(...)`) 是否包含某类招式，而非检查对手**上一回合使用的招式**。

这与 CFRU 的逻辑不符。CFRU 中：
```c
// ai_positives.c 第 935 行 (EFFECT_DISABLE)
// ai_positives.c 第 958 行 (EFFECT_ENCORE)
if (IsClassDamaging(gLastUsedMoves[bankDef]))
    // ...
```

`gLastUsedMoves[bankDef]` 是对手**上一回合使用的招式**，不是对手已知的招式列表。

### 正确逻辑
```
Encore/Disable 只在以下情况有价值:
1. 对手本回合使用过招式 (lastMove 非空)
2. lastMove 是状态招式 (如剑舞) → 锁定它很有价值
3. lastMove 免疫我方 (如我方飞行，对手用地震) → 锁定它很有价值
4. lastMove 是普通攻击招式 → 价值较低
```

### 解决方案

1. **BattleTracker 追踪 lastMove**:
   ```typescript
   // TrackedPokemon 接口
   lastMove: string;  // 对手上一回合使用的招式

   // handleMove 方法
   tracked.lastMove = move;  // 记录上一回合招式
   ```

2. **AIPokemon 接口添加 lastMove**:
   ```typescript
   /** Last move used (for Encore/Disable evaluation) */
   lastMove: string;
   ```

3. **rewardEncore/rewardDisable 使用 lastMove**:
   ```typescript
   const lastMove = ctx.target.lastMove;
   if (!lastMove) return 0;  // 对手没使用过招式，无价值

   const lastMoveData = Dex.moves.get(lastMove);
   const lastMoveIsStatus = lastMoveData.category === 'Status';

   if (lastMoveIsStatus) {
       bonus += 4;  // 锁定状态招式很有价值
   }
   ```

### 教训
**CFRU 中的 gLastUsedMoves 非常重要**，它追踪每个精灵上一回合使用的招式，影响：
- Encore/Disable 评分
- 未来的切换预测
- 招式选择预测

---

## Bug 12: 双打 AI 不行动 - "waiting for opponent"

**版本**: v1.1.12
**发现日期**: 2026-01-23

### 问题
双打时 AI 卡住不动，一直显示 "waiting for opponent"。所有招式都被扣 15 分并显示 "Attacking partner with damaging move"。

### 日志特征
```
[AI T1]   Rock Slide: 88 (-15/3)
[AI T1]     - Attacking partner with damaging move: -15
[AI T1]   Crunch: 94 (-15/9) [SE]
[AI T1]     - Attacking partner with damaging move: -15
[NPC] AI choice: move 2 -1, move 4
```

### 原因
两个 bug 共同导致：

1. **目标位置错误** (`getTargetPosition`)
   - 返回 `-1` (表示队友) 而不是 `1` (表示对手)
   - PS 的目标格式：正数 = 对手位置，负数 = 队友位置

2. **队友判断错误** (`isTargetingPartner`)
   - 使用 `p.slot === target.slot` 比较
   - 但 slot 是位置编号，双方的 slot 可能相同 (都是 1 或 2)
   - 导致所有招式都被误判为 "攻击队友"

### 解决方案
1. **修复 getTargetPosition**:
   ```typescript
   // 正确: 正数表示对手
   if (move.target === 'normal' || move.target === 'any') {
       return '1';  // 对手位置 1
   }
   ```

2. **修复 isTargetingPartner**:
   ```typescript
   // 使用对象引用比较，而非 slot 数字
   const isTargetingPartner = state.isDoubles &&
       state.self.active.some(p => p === target);
   ```

### 教训
**PS 双打目标格式**:
- `1`, `2` = 对手位置
- `-1`, `-2` = 队友位置
- `0` = 无特定目标 (自动选择)

**对象比较 vs 数字比较**: 当多个数组的元素可能有相同的 slot 数字时，应使用对象引用比较 (`===`)。

---

## Bug 13: 双打攻击方识别错误

**版本**: v1.1.13
**发现日期**: 2026-01-23

### 问题
双打时日志显示两只精灵都是 Tyranitar，但它们有不同的招式。另外 AI 不会选择最优目标，Tyranitar 用咬碎攻击抵抗恶系的炽焰咆哮虎，而不是弱点恶系的 Sinistcha。

### 原因
1. **攻击方识别错误**: `chooseBestMoveWithScores` 总是使用 `self.active[0]`，不论是哪只精灵在行动
2. **单目标评估**: 招式只针对第一个对手评分，不考虑攻击第二个对手是否更优

### 解决方案
1. **添加 `activeIndex` 参数**:
   ```typescript
   // index.ts
   const decision = this.makeDecision(active, moves, canSwitch, flags, i);

   // normal.ts
   protected override makeDecision(..., activeIndex = 0) {
       const attacker = this.battleState.self.active[activeIndex];
   }
   ```

2. **多目标评估**:
   ```typescript
   // 遍历所有对手，为每个目标分别评分
   for (let targetIdx = 0; targetIdx < opponents.length; targetIdx++) {
       const target = opponents[targetIdx];
       const scores = this.scoringEngine.scoreMoves(state, attacker, aiMoves, target);
       // 跟踪最佳分数和目标
   }

   // 返回最佳目标位置
   bestTargetPos = String(chosen.targetIndex + 1);
   ```

### 教训
**双打的复杂性**: 双打需要考虑：
- 正确识别当前行动的精灵 (activeIndex)
- 为每个目标分别评估招式
- 扩散招式只评估一次 (影响所有对手)
- 返回最优目标位置

---

## Bug 14: 双打目标位置使用数组索引

**版本**: v1.1.14
**发现日期**: 2026-01-23

### 问题
AI 评估了两个对手的招式分数，但最终选择攻击错误的目标。例如 Crunch 对 Sinistcha 效果绝佳 (+109)，但 AI 攻击了抵抗恶系的 Incineroar。

控制台只显示针对一个目标的分数，应该显示所有对手的评分。

### 原因
1. **目标位置计算错误**: 使用 `targetIndex + 1` (数组索引) 而非 `target.slot` (实际位置)
   - 当 `opponents = [Sinistcha, Incineroar]` 且 Sinistcha 是 slot 2 时
   - `targetIndex = 0` → 返回 `1` (位置 1 = Incineroar)
   - 实际应该返回 `2` (Sinistcha 的 slot)

2. **日志不完整**: 只存储第一个目标的分数 (`targetIdx === 0`)

### 解决方案
1. **使用 `target.slot`**:
   ```typescript
   // 修改前 (错误)
   bestMoves = [{ move, aiMove, targetIndex: targetIdx }];
   bestTargetPos = String(chosen.targetIndex + 1);

   // 修改后 (正确)
   bestMoves = [{ move, aiMove, targetSlot: target.slot }];
   bestTargetPos = String(chosen.targetSlot);
   ```

2. **存储所有目标的分数**:
   ```typescript
   const allScoresByTarget: Map<number, MoveScore[]> = new Map();
   allScoresByTarget.set(targetSlot, scores);
   ```

3. **扩展日志支持多目标**:
   ```typescript
   // 日志输出格式
   [AI T1] vs Sinistcha [CHOSEN]:
   [AI T1]   Crunch: 109 (0/9) [SE]
   [AI T1] vs Incineroar:
   [AI T1]   Crunch: 94 (-5/3)
   ```

### 教训
**数组索引 ≠ slot**: 当数组经过 `filter()` 后，元素的索引不再等于原始 slot。必须使用对象的 `slot` 属性。

---

## Bug 15: 双打 tracker 只追踪到 1 只对手

**版本**: v1.1.15
**发现日期**: 2026-01-23

### 问题
双打时日志显示 `Opponent active: 1 Pokemon`，只追踪到 Sinistcha (slot 2)，Incineroar (slot 1) 丢失。

### 原因
`handleSwitch` 中的去重逻辑错误：

```typescript
// 错误代码
for (const [pos, mon] of this.opponentPokemon) {
    if (pos.startsWith(side) && pos !== position) {  // 问题在这里！
        mon.active = false;
    }
}
```

条件 `pos.startsWith(side) && pos !== position` 的含义是：
- 当 p1a 上场时，把 p1b 设为 inactive（因为 `p1b.startsWith('p1')` 且 `p1b !== p1a`）
- 这会导致双打的另一只对手被错误标记为 inactive

### 解决方案
只把**同一位置**的之前精灵设为 inactive：

```typescript
// 正确代码
const existingInPosition = this.opponentPokemon.get(position);
if (existingInPosition && existingInPosition.species !== species) {
    existingInPosition.active = false;
}
```

### 教训
**双打位置管理**: 双打中 p1a 和 p1b 是独立的位置，切换时只应影响同一位置的精灵，不应影响其他位置。

---

## Bug 16: BasicAI 双打无限循环

**版本**: v1.1.18
**发现日期**: 2026-01-23

### 问题
双打中 BasicAI 不断输出 `[NPC] AI choice: move 1, move 3` 无限循环，控制台被刷屏。NormalAI (SmartAI) 不受影响。

### 日志特征
```
[NPC] AI choice: move 1, move 3
[NPC] AI choice: move 1, move 3
[NPC] AI choice: move 1, move 3
... (无限重复)
```

### 原因
**根本原因**: BasicAI 在双打中没有为单体招式提供 `targetPos`

**触发流程**:
1. AI 发送 `move 1, move 3`（缺少目标位置）
2. PS 返回 `[Unavailable choice] move name needs a target` 错误
3. PS 重发 request（带 `update: true` 标志）
4. `room-battle.ts` 处理新 request 时重置 `request.isWait = false`
5. 轮询检测到新 request（`!request.isWait`），再次发送相同无效选择
6. 循环回到步骤 2

**PS 协议细节** (room-battle.ts:795-809):
```typescript
// 收到新 request 时
this[slot].request = {
    rqid: this.rqid,
    request: requestJSON,
    isWait: request.wait ? 'cantUndo' : false,  // 重置 isWait!
    choice: '',
};
```

**为什么 NormalAI 不受影响**:
NormalAI 有 `getTargetPosition()` 方法作为后备，在 `bestTargetPos` 为空时提供默认目标。

### 解决方案

1. **添加 `getDefaultTargetPos()` 方法**:
   ```typescript
   private getDefaultTargetPos(move: MoveChoice): string | undefined {
       if (move.target === 'normal' || move.target === 'any') {
           return '1'; // 默认攻击第一个对手
       }
       if (move.target === 'adjacentAlly' || move.target === 'adjacentAllyOrSelf') {
           return '-2'; // 队友位置
       }
       return undefined; // 扩散招式等不需要目标
   }
   ```

2. **修复三处目标选择**:
   - 单招式时 (`moves.length === 1`)
   - tracker 无对手信息时 (`opponents.length === 0`)
   - 只有状态招式时（随机选择）

3. **额外保护** - room.ts 添加重试计数器:
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

### 教训

1. **双打目标必须明确**: 在双打中，单体招式必须指定 `targetPos`，否则 PS 返回错误
2. **PS 错误处理会重发 request**: `[Unavailable choice]` 会触发 `emitRequest()`，重新发送带 `update: true` 的 request
3. **AI 类之间功能差异**: NormalAI 和 BasicAI 的后备逻辑不同，测试时需要分别验证
4. **防御性编程**: 添加重试限制可以防止任何原因导致的无限循环

---

## 最佳实践总结

### 开发流程
1. **开发前必读架构文档**: 特别是 `server-integration.md`，理解进程边界
2. **复用现有模式**: 新功能先搜索现有代码是否有类似实现
   ```bash
   grep -rn "BattleTracker" server/npc/ai/
   grep -rn "getActiveOpponent" server/npc/ai/
   ```
3. **CFRU 参考优先**: 实现前先查阅 CFRU 源码
4. **使用正确目录**: `Complete-Fire-Red-Upgrade/src/Battle_AI/`

### PS 架构约束
5. **服务端限制**: AI 无法直接访问 `Battle` 对象，需通过 BattleTracker 追踪
6. **RoomBattle vs sim Battle**: `room.battle` 是 `RoomBattle`，sim `Battle` 在子进程不可直接访问
7. **变量命名区分**: 使用 `roomBattle` 和 `simBattle` 明确区分，避免混淆

### PS API 注意事项
8. **PS Dex API**: `getImmunity` 返回 `false` 表示免疫
9. **协议消息格式**: 注意 `"move: "` 等前缀
10. **PS 错误处理**: `[Unavailable choice]` 会重发 request，轮询逻辑需要处理重试

### 战斗逻辑
11. **lastMove vs moveset**: Encore/Disable 判断**上一回合招式**，不是招式池
12. **数组索引 vs slot**: filter 后的数组索引不等于 slot，必须使用 `target.slot`

### 双打/Multi 特殊处理
13. **双打位置独立**: p1a 和 p1b 是独立位置，切换逻辑不应相互影响
14. **双打目标必须明确**: 单体招式必须提供 `targetPos`，否则 PS 会返回错误
15. **Multi Battle 对手**: p2/p4 的对手是 p1 AND p3，BattleTracker 需要 `isMulti=true`

### 开发清单 (每次开发前检查)
- [ ] 复习 `docs/npc-battle/arch/server-integration.md`
- [ ] 数据来源是 request (己方) 还是需要追踪 (对手)？
- [ ] 如果需要对手信息，是否使用 BattleTracker？
- [ ] 是否有现有代码解决了类似问题？
- [ ] 变量命名是否清晰区分 roomBattle 和 simBattle？

---

## Bug 17: Multi Battle 对手追踪失败

**版本**: v1.2.3
**发现日期**: 2026-01-24

### 问题
Multi Battle 中 AI (p2/p4) 无法识别对手精灵，日志显示 `opponents=0`，AI 只能使用随机招式。

### 日志特征
```
[DEBUG] virtualState: self.active=1, opponent.active=0
[DEBUG] p2 selfIndex=0, attacker=Tyranitar, opponents=
[DEBUG] p2 fallback: attacker=true, opponents=0
```

### 原因分析
三个问题叠加导致：

1. **sim Battle 不可直接访问**
   - PS 架构中 sim `Battle` 运行在子进程
   - 主进程通过 `ProcessManager` 与子进程通信
   - `roomBattle.stream.battle` 返回 `undefined`

2. **RoomBattle.p1 != Side**
   - `room.battle.p1` 是 `RoomBattlePlayer` 对象
   - 不是 sim 的 `Side` 对象（后者有 `active: Pokemon[]`）
   - room.ts 中 `battle.p2.active = true` 会覆盖 `RoomBattlePlayer.active` 属性

3. **BattleTracker 单对手逻辑**
   - 原代码只检查 `this.opponentSide` (固定为 'p1' 或 'p2')
   - Multi 战斗中 p2/p4 的对手是 **p1 AND p3**
   - 导致 p3 上的对手精灵被忽略

### 错误代码

**room.ts** - 覆盖属性:
```typescript
// 这行代码会覆盖 RoomBattlePlayer 的 active 属性
battle.p2.active = true;  // 错误！
battle.p4.active = true;  // 错误！
```

**battle-tracker.ts** - 单对手:
```typescript
// 只检查单一对手 side
if (side !== this.opponentSide) return;  // 遗漏 p3!
```

### 解决方案

1. **移除 room.ts 中的覆盖代码**:
   ```typescript
   // 删除这些行
   // battle.p2.active = true;
   // battle.p4.active = true;
   ```

2. **BattleTracker 支持 multi battle**:
   ```typescript
   constructor(ourSide: 'p1' | 'p2' = 'p2', isMulti = false) {
       this.ourSide = ourSide;
       this.opponentSide = ourSide === 'p1' ? 'p2' : 'p1';
       this.isMultiBattle = isMulti;

       // Multi 战斗追踪两个对手 side
       if (isMulti) {
           // p2/p4 的对手是 p1 和 p3
           this.opponentSides = new Set(ourSide === 'p2' ? ['p1', 'p3'] : ['p2', 'p4']);
       } else {
           this.opponentSides = new Set([this.opponentSide]);
       }
   }

   private isOpponentSide(side: string): boolean {
       return this.opponentSides.has(side);
   }
   ```

3. **NPCMultiManager 使用 tracker**:
   ```typescript
   // 创建 tracker 时指定 isMulti=true
   this.tracker = createBattleTracker('p2', true);

   // buildVirtualDoublesState 使用 tracker
   const trackedOpponents = this.tracker.getActiveOpponents();
   for (const { position, pokemon } of trackedOpponents) {
       const side = position.slice(0, 2); // 'p1' or 'p3'
       const slot = side === 'p1' ? 1 : 2;
       opponentActive.push(trackedPokemonToAIPokemon(pokemon, slot, true));
   }
   ```

### PS 架构总结

```
主进程 (Server)              子进程 (Simulator)
┌─────────────────┐         ┌─────────────────┐
│   RoomBattle    │◄─stream─►│     Battle      │
│ ┌─────────────┐ │         │ ┌─────────────┐ │
│ │RoomBattleP1 │ │         │ │   Side[0]   │ │
│ │RoomBattleP2 │ │         │ │   Side[1]   │ │
│ │RoomBattleP3 │ │         │ │   Side[2]   │ │
│ │RoomBattleP4 │ │         │ │   Side[3]   │ │
│ └─────────────┘ │         │ └─────────────┘ │
└─────────────────┘         └─────────────────┘
       │                            │
   AI 运行在这里              Side.active[] 在这里
   ↓                               ↓
无法直接访问 Side         只能通过协议消息追踪
```

### 教训

1. **理解 PS 多进程架构**: sim Battle 在子进程，主进程只有 RoomBattle
2. **区分 RoomBattle 和 sim Battle**: 属性名可能相同但含义不同
3. **Multi 对手不是单一 side**: Team 1 = p1+p3, Team 2 = p2+p4
4. **复用已有模式**: NormalAI 用 BattleTracker，Multi 应该复用而非重新实现

---

## Bug 18: 双打 Spread Move 评分使用第一目标分数

**版本**: v1.2.5
**发现日期**: 2026-01-24

### 问题
双打时 AI 选择 Iron Head (105分) 攻击 Sinistcha，而不是选择 Earthquake (117分) 攻击 Roaring Moon。

### 日志特征
```
[AI T1 p2] vs Sinistcha [CHOSEN]:
[AI T1 p2]   Earthquake: 102 (-13/15)
[AI T1 p2]   Iron Head: 105 (0/5)
[AI T1 p2] vs Roaring Moon:
[AI T1 p2]   Earthquake: 117 (-5/22) [2HKO]
[AI T1 p2]   Iron Head: 105 (0/5)
```

### 原因
`chooseBestMoveWithScores` 中的 spread move 评分逻辑错误：

```typescript
// 错误代码
for (let i = 0; i < scores.length; i++) {
    const isSpreadMove = moveTarget === 'allAdjacentFoes' || ...;
    if (isSpreadMove && targetIdx > 0) {
        continue; // Earthquake vs Roaring Moon 的 117 分被跳过！
    }
    // 只有 targetIdx === 0 (Sinistcha) 的 102 分参与比较
}
```

代码假设 spread move 对所有目标评分相同，所以只在第一个目标时参与比较。但实际上：
- vs Sinistcha：地面被抵抗，只有 24% 伤害 → 102 分
- vs Roaring Moon：伤害 56%，可 2HKO → 117 分

### 解决方案
重构为两遍扫描：

```typescript
// 第一遍：收集所有目标的评分
for (const target of opponents) {
    const scores = this.scoringEngine.scoreMoves(..., target);
    allScoresByTarget.set(target.slot, scores);
}

// 第二遍：spread move 取最高分
for (let i = 0; i < aiMoves.length; i++) {
    if (isSpreadMove) {
        // 取所有目标中的最高分 (102 vs 117 → 117)
        for (const [slot, scores] of allScoresByTarget) {
            if (scores[i].score > maxScore) {
                maxScore = scores[i].score;
            }
        }
    } else {
        // 单体招式：分别比较每个目标
    }
}
```

### 教训
**Spread move 的评分不应固定使用第一个目标**：由于不同目标的属性克制/伤害百分比不同，同一个 spread move 对不同目标的评分可能差异很大。应取最高分或综合分。

---

## Bug 19: Multi Battle 伤害计算异常（对手等级硬编码为 50）

**版本**: v1.2.6
**发现日期**: 2026-01-25

### 问题
Multi Battle 中伤害计算明显异常，显示 Iron Head 对 Garchomp 造成 68% 伤害，而双打模式下相同配置只有 35%。

### 日志特征
```
# 双打模式 (正确)
[AI T1 p2]   Iron Head: 105 (0/5)
[AI T1 p2]     - Decent damage (35%): +2

# Multi 模式 (异常)
[AI T1 p4]   Iron Head: 117 (0/17) [2HKO]
[AI T1 p4]     - Moderate damage (68%): +6
```

68% 约是 35% 的 2 倍，提示 HP 计算出了问题。

### 原因分析
**`trackedPokemonToAIPokemon` 硬编码 level=50，而 National Dex 格式是 level 100**：

```typescript
// state-builder.ts 第715行 (修改前)
const level = 50; // Assume level 50  ← 错误！
```

**对手 HP 计算**（以 Garchomp HP 种族值 108 为例）：
- Level 50: HP = Math.floor((2*108 + 31 + 21) * 50/100) + 50 + 10 = **194**
- Level 100: HP = Math.floor((2*108 + 31 + 21) * 100/100) + 100 + 10 = **378**

当伤害值相同时：
- Level 50 HP: 伤害/194 ≈ 68%
- Level 100 HP: 伤害/378 ≈ 35%

**而己方宝可梦从 `request.details` 解析等级，是正确的 100！**

### 解决方案

1. **添加 `level` 字段到 `TrackedPokemon` 接口**：
   ```typescript
   export interface TrackedPokemon {
       // ...
       level: number;  // 新增
   }
   ```

2. **在 `handleSwitch` 中解析等级**：
   ```typescript
   // 从 "Species, L100, M" 格式解析等级
   const detailParts = detailPart.split(',').map(s => s.trim());
   let level = 100; // 默认 100 (National Dex 标准)
   for (const part of detailParts) {
       if (part.startsWith('L')) {
           level = parseInt(part.slice(1));
           break;
       }
   }
   ```

3. **修改 `trackedPokemonToAIPokemon` 使用追踪的等级**：
   ```typescript
   // 使用追踪的等级，默认 100
   const level = tracked.level || 100;
   ```

### 文件变更
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/cfru/util/battle-tracker.ts | 添加 level 字段和解析逻辑 |
| server/npc/ai/cfru/state-builder.ts | 使用追踪的等级 |

### 教训
1. **不要硬编码假设值**: 等级应该从协议消息中解析，不同格式有不同等级
2. **注意格式差异**: VGC/BSS 是 level 50，National Dex/OU 是 level 100
3. **HP 百分比的敏感性**: HP 计算涉及等级，错误的等级会导致伤害百分比偏差巨大

---

## Bug 20: v1.2.6 等级默认值不一致

**版本**: v1.2.7
**发现日期**: 2026-01-25

### 问题
v1.2.6 虽然修复了等级追踪问题，但引入了新问题：不同代码路径使用不同的默认等级值，导致伤害计算仍然不准确。

### 原因分析
v1.2.6 的修复只更新了部分代码的默认值：

| 位置 | 默认值 | 状态 |
|------|--------|------|
| `state-builder.ts:buildOpponentReserveRevealed` | 50 | 未修改 |
| `state-builder.ts:buildOpponentPokemonRevealed` | 50 | 未修改 |
| `state-builder.ts:buildOpponentPokemonFull` | 50 | 未修改 |
| `state-builder.ts:trackedPokemonToAIPokemon` | 100 | v1.2.6 新增 |
| `multi-manager.ts` | 100 | v1.2.6 新增 |
| `damage-calc.ts` | 50 | 未修改 |

当攻击方使用一个等级（如从 request 解析的 100），防御方使用另一个等级（如默认的 50），伤害百分比计算会出错。

### 解决方案
采用"格式推断等级"策略：

1. **新增 `getFormatLevel(formatId)` 函数**：
   ```typescript
   export function getFormatLevel(formatId: string): number {
       if (id.includes('random')) return 0; // 使用追踪值
       if (id.includes('lc')) return 5;
       if (id.includes('vgc') || id.includes('bss')) return 50;
       return 100; // National Dex, OU, etc.
   }
   ```

2. **新增 `resolveLevel(formatId, parsedLevel)` 函数**：
   ```typescript
   export function resolveLevel(formatId: string, parsedLevel?: number): number {
       const formatLevel = getFormatLevel(formatId);
       if (formatLevel === 0) { // Random battles
           return parsedLevel || 100;
       }
       return formatLevel; // Use format default
   }
   ```

3. **统一所有默认值为 100**（与追踪默认值一致）

4. **通过 `CFRUAIConfig.formatId` 传递格式信息**

### 关键洞察
- 对于非随机对战，**双方使用相同等级**比使用"正确"等级更重要
- 伤害百分比的准确性依赖于攻击方和防御方使用一致的等级
- 绝对伤害值可能不准确（如 Level 100 用 50 计算），但百分比是对的

### 文件变更
| 文件 | 变更类型 |
|------|---------|
| server/npc/ai/cfru/types.ts | 新增 `getFormatLevel`, `resolveLevel`, `formatId` 字段 |
| server/npc/ai/cfru/state-builder.ts | 统一默认值，使用 `resolveLevel` |
| server/npc/ai/cfru/util/damage-calc.ts | 统一默认值为 100 |
| server/npc/ai/multi-manager.ts | 传递 formatId |
| server/npc/ai/normal.ts | 在 `setBattle` 时设置 formatId |

### 教训
1. **修复要完整**: 修改默认值时，必须检查所有使用该值的地方
2. **一致性优先**: 在计算中，双方使用一致的假设比使用"正确"值更重要
3. **格式感知**: 不同格式有不同的标准等级，应该感知格式而非硬编码

---

## Bug 21: 己方能力值使用种族值而非实际能力值

**版本**: v1.2.8
**发现日期**: 2026-01-25

### 问题
伤害计算严重不准确。例如 Tyranitar 使用 Crunch 攻击 Zamazenta：
- 显示 ATK=134（种族值）而非实际能力值（约 403）
- 伤害被严重低估

### 日志特征
```
[DEBUG] Damage Calc: Tyranitar (Lv50) -> Zamazenta (Lv100)
[DEBUG]   Attacker baseStats: ATK=134, SPA=95  ← 种族值！
[DEBUG]   Defender baseStats: DEF=287, SPD=287  ← 估算能力值
```

### 原因分析
**两个 Bug 叠加**：

1. **己方使用种族值** (`state-builder.ts:168`)
   ```typescript
   // 错误代码
   const baseStats = speciesData.baseStats;  // 种族值！
   ```

   PS request 实际包含 `mon.stats`（实际能力值），但代码使用了 Dex 查询的种族值。

2. **等级默认值错误** (`state-builder.ts:162`)
   ```typescript
   // 错误代码
   const level = parseInt((details[1] || 'L50').replace('L', ''));  // 默认 L50！
   ```

   PS 在 `details` 中省略默认等级（如 "Tyranitar, F" 无 L100），代码错误默认为 L50。

### 数据来源对比

| 数据 | 己方来源 | 对手来源 |
|------|----------|----------|
| 能力值 | `speciesData.baseStats` (种族值 ✗) | `calculatedStats` (估算能力值 ✓) |
| 等级 | `details` 解析，默认 L50 (✗) | `tracked.level`，默认 100 (✓) |

### 解决方案

1. **使用 `mon.stats` 获取实际能力值**：
   ```typescript
   // 修复后
   const actualStats = mon.stats ? {
       hp: maxHp,
       atk: mon.stats.atk,
       def: mon.stats.def,
       spa: mon.stats.spa,
       spd: mon.stats.spd,
       spe: mon.stats.spe,
   } : speciesBaseStats;

   baseStats: actualStats,  // 使用实际能力值
   ```

2. **修改默认等级为 L100**：
   ```typescript
   // 修复后
   const level = parseInt((details[1] || 'L100').replace('L', '')) || 100;
   ```

### PS Request 数据结构
```typescript
// request.side.pokemon[].stats 包含实际能力值
{
    ident: "p2: Tyranitar",
    details: "Tyranitar, F",  // 注意：无等级信息（默认100时省略）
    condition: "341/341",
    stats: {
        atk: 403,  // 实际能力值！
        def: 256,
        spa: 203,
        spd: 236,
        spe: 159
    },
    // ...
}
```

### 验证修复
修复后输出：
```
[DEBUG] Damage Calc: Tyranitar (Lv100) -> Zamazenta (Lv100)
[DEBUG]   Attacker baseStats: ATK=403, SPA=203  ← 正确！
```

### 教训
1. **阅读 PS 源码确认数据结构**: `sim/pokemon.ts:getSwitchRequestData()` 显示 request 包含 `stats` 字段
2. **注意 PS 协议省略默认值**: 等级为格式默认值时不包含在 details 中
3. **己方和对手数据来源不同**: 己方有完整 request，对手需要追踪/估算

---

## Bug 20: Multi Battle 威吓/boost 追踪失效

**版本**: v1.2.10
**发现日期**: 2026-01-25

### 问题
Multi Battle 中，威吓 (Intimidate) 降低攻击后伤害计算不受影响，但双打模式正常。

### 原因
两个层面的问题：

**1. BattleTracker 只追踪 p2 的 boost**

`handleBoost` 中检查 `side === this.ourSide` (p2)，但 multi battle 中 p4 也是我们队伍的成员：
```typescript
// 修复前 - 只追踪 p2
if (side === this.ourSide) {  // ourSide = 'p2'
    this.ourActiveBoosts.set(slot, ...);  // p4 的 boost 被忽略！
}
```

**2. multi-manager 不使用追踪的 boost**

`buildAIPokemon` 硬编码 boost 为全 0：
```typescript
const boosts = {
    atk: 0,  // 威吓降低的攻击没有反映
    def: 0,
    ...
};
```

### 解决方案

**1. BattleTracker 添加 `ourTeamSides` 概念**

在 multi 模式下追踪整个队伍 (p2 + p4) 的 boost：
```typescript
// Multi battle: Team 2 = p2 + p4
this.ourTeamSides = isMulti
    ? new Set(['p2', 'p4'])
    : new Set([this.ourSide]);

// 追踪整个队伍的 boost
if (this.isOurTeamSide(side)) {
    const boostKey = `${side}${slot}`;  // 'p2a' 或 'p4a'
    this.ourActiveBoosts.set(boostKey, ...);
}
```

**2. multi-manager 从 tracker 获取 boost**

```typescript
private buildAIPokemon(..., side?: string): AIPokemon {
    if (isActive && side) {
        const boostKey = `${side}a`;
        const trackerBoosts = this.tracker.getOurActiveBoosts(boostKey);
        boosts = { ...trackerBoosts };
    }
}
```

### 文件变更
| 文件 | 变更 |
|------|------|
| `battle-tracker.ts` | 添加 `ourTeamSides`, `isOurTeamSide()`, 更新所有追踪方法使用新 key 格式 |
| `multi-manager.ts` | `buildAIPokemon` 从 tracker 获取 boost |

### 教训
1. **multi battle 是队伍模式**: p2 + p4 是一个队伍，追踪逻辑需要考虑两者
2. **key 格式要唯一**: 使用 `side+slot` (如 'p2a', 'p4a') 区分不同位置的 boost
3. **向后兼容**: `getOurActiveBoosts('a')` 仍然工作，自动转换为 `${ourSide}a`

---

## Bug 22: Multi Battle p4 Slot 格式错误

**版本**: v1.2.12
**发现日期**: 2026-01-25

### 问题
Multi Battle 中 p4 的威吓 (Intimidate) 降攻击不影响伤害计算，但 p2 正常工作。

### 日志特征
```
[DEBUG BattleTracker] handleBoost: -unboost for p4b, side=p4, boostKey=p4b, stat=atk, amount=1
[DEBUG] buildAIPokemon: boostKey=p4a              ← 用 p4a 获取
[DEBUG] buildAIPokemon: trackerBoosts for p4a = atk:0  ← 拿不到 -1
```

### 原因
PS 协议中 Multi Battle 的位置格式：
- p2 使用 slot 'a' → `p2a`
- p4 使用 slot 'b' → `p4b`

但代码硬编码使用 `${side}a`：
```typescript
const boostKey = `${side}a`;  // p4 得到 'p4a'，但追踪的是 'p4b'
```

### 解决方案
根据 side 确定正确的 slot：
```typescript
const slotChar = side === 'p2' ? 'a' : 'b';
const boostKey = `${side}${slotChar}`;
```

### 教训
1. **PS Multi Battle 位置约定**: Team 内的两个玩家使用不同的 slot 字符 (a/b)
2. **添加调试日志**: 当问题难以定位时，添加详细日志可以快速发现问题

---

## Bug 23: Multi Battle p2 阵亡后 selfIndex 错误

**版本**: v1.2.16
**发现日期**: 2026-01-26

### 问题
Multi Battle 中，当 NPC p2 全部阵亡，只有 p4 存活时，伤害计算无法正常输出，显示 `attacker=undefined`。

### 日志特征
```
[DEBUG] p4 selfIndex=1, attacker=undefined
[DEBUG] p4 virtualState.self.active.length=1
[DEBUG] p4 fallback: attacker=false, opponents=2
```

### 原因
`buildVirtualDoublesState` 只往 `selfActive` 数组添加有 request 的精灵：
- 当 p2 阵亡时，`p2Request` 为 undefined
- `selfActive` 只有 p4 的精灵（在索引 0）
- 但 `evaluateSideChoice` 调用时 p4 的 `selfIndex` 固定传入 1
- 结果 `virtualState.self.active[1]` 是 undefined

```typescript
// 错误代码
const p4Choice = this.evaluateSideChoice(p4Request, virtualState, 1, 'p4');
// selfIndex 固定为 1，但数组只有 1 个元素
```

### 解决方案
动态计算 p4 的 selfIndex：
```typescript
// 修复后
const p4SelfIndex = p2Request ? 1 : 0;  // p2 阵亡时，p4 在索引 0
const p4Choice = this.evaluateSideChoice(p4Request, virtualState, p4SelfIndex, 'p4');
```

### 教训
1. **数组索引依赖条件**: 当数组元素数量可能变化时，索引不能硬编码
2. **考虑队友阵亡场景**: Multi Battle 测试需要覆盖一方队友全部阵亡的情况

---

*最后更新: 2026-01-26*
