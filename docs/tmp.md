# 重构分析 - 2026-01-25 (v1.2.9)

## 问题清单

### P1 - Pokemon 构建逻辑重复 ✅ 已处理（v1.2.20）

**文件**: `state-builder.ts`, `multi-manager.ts`

**原三个重复函数**:
- `buildPokemonFromRequest` - 从 request 构建己方
- `buildAIPokemon` - Multi 模式的构建
- `trackedPokemonToAIPokemon` - 从 tracker 构建对手

**处理方式**: 抽出 `server/npc/ai/cfru/util/pokemon-builder.ts`，共享 `parseCondition` / `parseDetails` / `speciesDefaults` / `makeAIPokemonSkeleton`。state-builder 的两个函数已复用这些底层。

**遗留**: `multi-manager.ts` 的 `buildAIPokemon` 没完全并进来——它用 `isActive` 命名、带 Multi 专用的 `terastallized/teraType`、缺一些字段。目前下游不读这些字段，所以能跑通；完整合并留给 Multi 流程彻底过完 state-builder 的后续重构。相关注释已写在该函数的 JSDoc 里。

---

### P2 - AIMove 转换重复 ✅ 已处理（v1.2.20）

**文件**: `state-builder.ts`, `multi-manager.ts`, `normal.ts`

**处理方式**: 在 `state-builder.ts` 导出 `buildAIMove(moveData, slot)`。三处调用点都替换为 `moves.map((m, i) => buildAIMove(m, i + 1))`。

---

### P3 - 常量散落各处 ✅ 已处理（v1.2.20）

**文件**: `state-builder.ts`, `multi-manager.ts`, `battle-tracker.ts`

**处理方式**: 在 `types.ts` 加 `defaultBoosts()` 工厂函数（返回新对象，避免共享引用）。替换生产代码 10+ 处字面量。test/ 下的 mock 定义保留原样（本就是独立快照）。

---

### P4 - NormalAI 和 NPCMultiManager 重复逻辑（延后）

**文件**: `normal.ts`, `multi-manager.ts`

**现状**: 单打和双打使用 `NormalAI`，线上 Multi 使用 `NPCMultiManager`。两条路径共享 `BattleTracker`、`ScoringEngine` 和 `buildAIMove`，没有统一完整决策流程。提交 `b781736cc` 包含构建工具的共享，不包含决策流程统一。

**双打决策**: `NormalAI` 按行动精灵的场上位置评估所有存活对手，替补评分覆盖两个对手。`NPCBattleAI` 依据请求中的场上数量及 `active` 标志排除队友，且排除倒下和已选替补。`test/server/npc/doubles-switching.js` 使用真实双打请求验证两个行动位置、免疫目标、替补分配、困住及被迫换人，并检查模拟器接受指令。

**待修复（2026-10-12 核验，Multi 按用户要求延后）**:
- `NPCMultiManager.evaluateSideChoice` 没有因招式无效或评分低而主动换人的分支。围巾多边兽-Z 锁定十万伏特，对面是已暴露蓄电的电灯怪和烈咬陆鲨时，线上决策路径仍输出 `>p2 move 1 1`。
- `test/npc/sim-battle/runner.ts` 的 Multi 使用两个 `NormalAI`，与线上 `NPCMultiManager` 不同；Multi 回归需要直接覆盖线上协调器及其请求处理。

**验证边界**: 吸收类特性追踪覆盖三种模式；单打和双打换人有真实模拟器回归，线上 Multi 的主动换人仍待处理。
