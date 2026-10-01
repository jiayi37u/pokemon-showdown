# 重构分析 - 2026-01-25 (v1.2.9)

## 问题清单

### P1 - Pokemon 构建逻辑重复 (高优先级)

**文件**: `state-builder.ts`, `multi-manager.ts`

**重复函数**:
- `buildPokemonFromRequest` - 从 request 构建己方
- `buildAIPokemon` - Multi 模式的构建
- `trackedPokemonToAIPokemon` - 从 tracker 构建对手

**问题**: 三个文件有相似的 Pokemon 构建逻辑，修复一处容易遗漏另一处（v1.2.8/v1.2.9 的 Bug 就是这个原因）

**建议**: 提取共享的 `PokemonBuilder` 工具类到 `server/npc/ai/cfru/util/pokemon-builder.ts`

**工作量**: 1-2 小时

---

### P2 - AIMove 转换重复 (中优先级)

**文件**: `state-builder.ts`, `multi-manager.ts`, `normal.ts`

**重复函数**:
- `buildMovesFromRequest`
- `convertToAIMoves`

**问题**: 三处几乎相同的代码，相似度 95%

**建议**: 统一到 `state-builder.ts` 并导出

**工作量**: 30 分钟

---

### P3 - 常量散落各处 (低优先级)

**文件**: `state-builder.ts`, `multi-manager.ts`, `normal.ts`

**问题**: 默认 boosts 初始化有 6 处重复：
```typescript
const boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
```

**建议**: 在 `types.ts` 添加 `DEFAULT_BOOSTS` 常量

**工作量**: 15 分钟

---

### P4 - NormalAI 和 NPCMultiManager 重复逻辑 (低优先级)

**文件**: `normal.ts`, `multi-manager.ts`

**问题**: 招式评分循环、目标选择逻辑、换人决策有重复

**建议**: 暂不合并，Multi 的特殊性（协调两个 side）使强行合并代价大

**工作量**: 延后

---

## 建议

**现在值得做**:
1. 提取 `PokemonBuilder` 工具类，统一 Pokemon 构建
2. 统一 `convertToAIMoves` 函数

**暂时不做**:
- NormalAI/NPCMultiManager 合并
- 过度抽象
