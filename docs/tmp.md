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

**问题**: 招式评分循环、目标选择逻辑、换人决策有重复

**结论**: 暂不合并，Multi 的特殊性（协调两个 side）使强行合并代价大
