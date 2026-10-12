# 重构分析 - 2026-01-25 (v1.2.9)

## 问题清单

### P1 - Pokemon 构建逻辑重复 ✅ 已处理（v1.2.20）

**文件**: `state-builder.ts`, `multi-manager.ts`

**原三个重复函数**:
- `buildPokemonFromRequest` - 从 request 构建己方
- `buildAIPokemon` - Multi 模式的构建
- `trackedPokemonToAIPokemon` - 从 tracker 构建对手

**处理方式**: 抽出 `server/npc/ai/cfru/util/pokemon-builder.ts`，共享 `parseCondition` / `parseDetails` / `speciesDefaults` / `makeAIPokemonSkeleton`。state-builder 的两个函数已复用这些底层。

**Multi 构建**: `multi-manager.ts` 复用 `buildPokemonFromRequest`，能力等级、特性能力值修正及上次招式从 Multi tracker 的 `p2a` / `p4b` 记录补齐。己方等级、当前特性和 `active` 等字段遵循共享模型。

---

### P2 - AIMove 转换重复 ✅ 已处理（v1.2.20）

**文件**: `state-builder.ts`, `multi-manager.ts`, `normal.ts`

**处理方式**: 在 `state-builder.ts` 导出 `buildAIMove(moveData, slot)`。三处调用点都替换为 `moves.map((m, i) => buildAIMove(m, i + 1))`。

---

### P3 - 常量散落各处 ✅ 已处理（v1.2.20）

**文件**: `state-builder.ts`, `multi-manager.ts`, `battle-tracker.ts`

**处理方式**: 在 `types.ts` 加 `defaultBoosts()` 工厂函数（返回新对象，避免共享引用）。替换生产代码 10+ 处字面量。test/ 下的 mock 定义保留原样（本就是独立快照）。

---

### P4 - NormalAI 和 NPCMultiManager 重复逻辑 ✅ 已处理

**文件**: `normal.ts`, `multi-manager.ts`

**决策路径**: 单打、双打由 `NormalAI.receiveRequest` 构建状态后决策。线上 Multi 由 `NPCMultiManager` 汇总 p2 / p4 请求和公开协议，调用各自 `NormalAI.receiveRequestWithState`，共用招式编号、目标选择、主动换人和被迫换人逻辑。

**位置与队伍**: 场上位置固定为 p2 = 1、p4 = 2、p1 = 1、p3 = 2，不因倒下而重新编号。替补候选只来自行动玩家自己的 `request.side.pokemon`，p2 和 p4 可分别选择自己队伍的 `switch 2`。状态中的队友只参与场面评估。

**请求协调**: 行动请求等待队友请求或同回合的明确 `wait`；队伍预览和被迫换人可独立执行。双方选择先计算后发送，已提交请求不重复发送。等待玩家的队伍数据仍用于状态构建。

**验证**: `test/server/npc/multi-decisions.js` 直接覆盖线上协调器，使用真实四人模拟器的请求、公开协议和指令校验，包含锁招免疫、禁用招式编号、各自后备、辅助目标、困住、倒下、被迫换人、请求延迟、能力字段、黑雾及完整对战。`test/npc/sim-battle/runner.ts` 的两个 `NormalAI` 不能替代协调器回归。
