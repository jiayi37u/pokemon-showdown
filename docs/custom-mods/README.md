# 自定义 Mods 完整指南

本指南介绍如何在 Pokemon Showdown 中创建自定义 mods，修改招式、宝可梦数据、技能池等。

---

## 目录

1. [Mods 系统概述](#mods-系统概述)
2. [创建自定义 Mod](#创建自定义-mod)
3. [修改招式效果](#修改招式效果)
4. [修改技能学习面](#修改技能学习面)
5. [修改种族值](#修改种族值)
6. [注册格式](#注册格式)
7. [完整示例](#完整示例)

---

## Mods 系统概述

### 目录结构

```
pokemon-showdown/
├── data/
│   └── mods/
│       ├── gen5/              # 官方第五世代 mod
│       │   ├── moves.ts       # 招式覆盖
│       │   ├── pokedex.ts     # 宝可梦数据覆盖
│       │   ├── learnsets.ts   # 技能学习面覆盖 (可选)
│       │   ├── abilities.ts   # 特性覆盖
│       │   ├── items.ts       # 道具覆盖
│       │   └── ...
│       └── gen5custom/         # 自定义 mod (示例)
│           ├── moves.ts
│           ├── learnsets.ts
│           └── pokedex.ts
└── config/
    └── formats.ts             # 格式注册 (使用 custom-formats.ts)
```

### 继承机制

Mods 使用 **继承覆盖** 机制：

- 每个 mod 基于 **基础数据** (`data/moves.ts`, `data/pokedex.ts` 等)
- 使用 `inherit: true` 继承基础数据
- 只需要覆盖需要修改的字段

```typescript
// 示例：修改招式威力
export const Moves = {
    thunderbolt: {
        inherit: true,  // 继承基础 Thunderbolt 数据
        basePower: 100, // 只覆盖威力字段
    },
};
```

---

## 创建自定义 Mod

### 步骤 1: 创建 Mod 目录

```bash
mkdir -p data/mods/gen5custom
```

### 步骤 2: 选择基础世代

自定义 mod 需要基于某个世代，通常选择：
- `gen5` - 第五世代
- `gen9` - 最新世代

**方法**: 使用 `inherit: true` 自动继承对应世代的数据。

---

## 修改招式效果

### 文件: `data/mods/gen5custom/moves.ts`

```typescript
export const Moves: import('../../../sim/dex-moves').ModdedMoveDataTable = {
    // 示例 1: 修改 Defog，让它扫除双方钉子
    defog: {
        inherit: true,  // 继承基础 Defog 数据
        onHit(target, source, move) {
            let success = false;

            // 降低对方回避率
            if (!target.volatiles['substitute'] || move.infiltrates) {
                success = !!this.boost({ evasion: -1 });
            }

            // 定义需要清除的场地效果
            const removeAll = ['spikes', 'toxicspikes', 'stealthrock', 'stickyweb', 'gmaxsteelsurge'];
            const removeTarget = ['reflect', 'lightscreen', 'auroraveil', 'safeguard', 'mist', ...removeAll];

            // 清除对方场地效果
            for (const targetCondition of removeTarget) {
                if (target.side.removeSideCondition(targetCondition)) {
                    if (!removeAll.includes(targetCondition)) continue;
                    this.add('-sideend', target.side, this.dex.conditions.get(targetCondition).name, '[from] move: Defog', `[of] ${source}`);
                    success = true;
                }
            }

            // 清除己方场地效果 (修改后的逻辑)
            for (const sideCondition of removeAll) {
                if (source.side.removeSideCondition(sideCondition)) {
                    this.add('-sideend', source.side, this.dex.conditions.get(sideCondition).name, '[from] move: Defog', `[of] ${source}`);
                    success = true;
                }
            }

            // 清除场地
            this.field.clearTerrain();
            return success;
        },
    },

    // 示例 2: 修改招式威力
    thunderbolt: {
        inherit: true,
        basePower: 100,  // 从 90 提升到 100
    },

    // 示例 3: 修改命中率
    thunder: {
        inherit: true,
        accuracy: 85,  // 从 70 提升到 85
    },
};
```

### 常用字段

| 字段 | 说明 | 示例 |
|------|------|------|
| `basePower` | 招式威力 | `90` |
| `accuracy` | 命中率 | `100` (true 表示必中) |
| `pp` | 技能点数 | `15` |
| `priority` | 优先度 | `1` (先制) |
| `category` | 类型 | `"Physical"`, `"Special"`, `"Status"` |
| `type` | 属性 | `"Electric"`, `"Fire"` 等 |
| `onHit` | 命中效果回调 | 函数 |
| `secondary` | 附加效果 | `{ chance: 10, status: 'par' }` |

---

## 修改技能学习面

### 文件: `data/mods/gen5custom/learnsets.ts`

```typescript
export const Learnsets: import('../../../sim/dex-species').ModdedLearnsetDataTable = {
    // 示例 1: 让闪电鸟学会 Hurricane
    zapdos: {
        learnset: {
            // 添加 Hurricane (第五世代 TM 标记)
            hurricane: ["5L50", "5M"],  // L50 = 50 级学会, M = TM

            // 保留原有技能 (可选，如果需要覆盖完整技能池)
            // 注意：不写其他技能则自动继承基础数据
        },
    },

    // 示例 2: 让急冻鸟学会更多招式
    articuno: {
        learnset: {
            hurricane: ["5L50", "5M"],
            defog: ["5M"],
            roost: ["5L40", "5M"],
        },
    },

    // 示例 3: 移除特定招式
    mewtwo: {
        learnset: {
            // 移除 Psystrike (设置为空数组)
            psystrike: [],
        },
    },
};
```

### 技能标记格式

| 格式 | 说明 | 示例 |
|------|------|------|
| `5L50` | 第5世代，50级学会 | `["5L50"]` |
| `5M` | 第5世代，TM/HM | `["5M"]` |
| `5T` | 第5世代，Tutor (教授招式) | `["5T"]` |
| `5E` | 第5世代，Egg Move (遗传) | `["5E"]` |
| `5S0` | 第5世代，Event (活动) | `["5S0"]` |

### 注意事项

**重要**: 如果不创建 `learnsets.ts`，则技能池完全继承基础数据。只有需要修改时才创建此文件。

**部分覆盖**: 只需要写需要修改的宝可梦，其他宝可梦自动继承基础数据。

---

## 修改种族值

### 文件: `data/mods/gen5custom/pokedex.ts`

```typescript
export const Pokedex: import('../../../sim/dex-species').ModdedSpeciesDataTable = {
    // 示例 1: 提升闪电鸟的种族值
    zapdos: {
        inherit: true,
        baseStats: {
            hp: 90,
            atk: 90,   // 从 90 提升
            def: 90,   // 从 85 提升
            spa: 125,  // 保持不变
            spd: 90,   // 保持不变
            spe: 100,  // 保持不变
        },
    },

    // 示例 2: 修改属性
    charizard: {
        inherit: true,
        types: ["Fire", "Dragon"],  // 从 Fire/Flying 改为 Fire/Dragon
    },

    // 示例 3: 修改特性
    pikachu: {
        inherit: true,
        abilities: {
            0: "Static",
            H: "Lightning Rod",  // 修改隐藏特性
        },
    },

    // 示例 4: 修改体重 (影响 Low Kick / Heavy Slam)
    snorlax: {
        inherit: true,
        weightkg: 500,  // 从 460 提升到 500
    },
};
```

### 常用字段

| 字段 | 说明 | 示例 |
|------|------|------|
| `baseStats` | 种族值 | `{ hp: 100, atk: 100, ... }` |
| `types` | 属性 | `["Fire", "Flying"]` |
| `abilities` | 特性 | `{ 0: "Overgrow", H: "Chlorophyll" }` |
| `weightkg` | 体重 (kg) | `90.5` |
| `heightm` | 身高 (m) | `1.7` |
| `color` | 颜色 | `"Red"`, `"Blue"` 等 |
| `eggGroups` | 蛋组 | `["Field", "Monster"]` |

---

## 注册格式

### 文件: `config/custom-formats.ts`

创建此文件来注册自定义格式（**不要修改 `config/formats.ts`**）：

```typescript
// Note: This is the list of formats
// The rules that formats use are stored in data/rulesets.ts

export const Formats: import('../sim/dex-formats').FormatList = [
    {
        section: "Custom Formats",  // 自定义分组
    },
    {
        name: "[Gen 5] OU Custom",
        desc: `第五世代 OU，但闪电鸟学会 Hurricane，Defog 扫除双方钉子。`,
        mod: 'gen5custom',  // 使用自定义 mod
        ruleset: ['Standard', 'Sleep Clause Mod', 'Species Clause', 'Nickname Clause', 'OHKO Clause', 'Evasion Moves Clause', 'HP Percentage Mod', 'Cancel Mod'],
        banlist: ['Uber', 'Arena Trap', 'Drizzle ++ Swift Swim', 'Drought ++ Chlorophyll', 'Sand Stream ++ Sand Rush', 'Snow Warning ++ Slush Rush'],
    },
    {
        name: "[Gen 5] Ubers Custom",
        desc: `第五世代 Ubers 自定义规则。`,
        mod: 'gen5custom',
        ruleset: ['Standard', 'Sleep Clause Mod', 'Species Clause', 'Nickname Clause', 'HP Percentage Mod', 'Cancel Mod'],
        banlist: [],
    },
];
```

### 如何使用

1. **创建文件**: 在 `config/custom-formats.ts` 中注册格式
2. **重启服务器**: `npm run build && node pokemon-showdown start`
3. **选择格式**: 在对战界面选择 "Custom Formats" 分组下的格式

---

## 完整示例

### 场景: 创建 "Gen 5 Enhanced" Mod

**需求**:
1. 闪电鸟学会 Hurricane
2. Defog 扫除双方钉子
3. 提升部分宝可梦种族值

### 文件结构

```
data/mods/gen5enhanced/
├── moves.ts
├── learnsets.ts
└── pokedex.ts
```

### `moves.ts`

```typescript
export const Moves: import('../../../sim/dex-moves').ModdedMoveDataTable = {
    defog: {
        inherit: true,
        onHit(target, source, move) {
            let success = false;
            if (!target.volatiles['substitute'] || move.infiltrates) {
                success = !!this.boost({ evasion: -1 });
            }
            const removeAll = ['spikes', 'toxicspikes', 'stealthrock', 'stickyweb', 'gmaxsteelsurge'];
            const removeTarget = ['reflect', 'lightscreen', 'auroraveil', 'safeguard', 'mist', ...removeAll];
            for (const targetCondition of removeTarget) {
                if (target.side.removeSideCondition(targetCondition)) {
                    if (!removeAll.includes(targetCondition)) continue;
                    this.add('-sideend', target.side, this.dex.conditions.get(targetCondition).name, '[from] move: Defog', `[of] ${source}`);
                    success = true;
                }
            }
            for (const sideCondition of removeAll) {
                if (source.side.removeSideCondition(sideCondition)) {
                    this.add('-sideend', source.side, this.dex.conditions.get(sideCondition).name, '[from] move: Defog', `[of] ${source}`);
                    success = true;
                }
            }
            this.field.clearTerrain();
            return success;
        },
    },
};
```

### `learnsets.ts`

```typescript
export const Learnsets: import('../../../sim/dex-species').ModdedLearnsetDataTable = {
    zapdos: {
        learnset: {
            hurricane: ["5L50", "5M"],
        },
    },
    articuno: {
        learnset: {
            hurricane: ["5L50", "5M"],
        },
    },
    moltres: {
        learnset: {
            hurricane: ["5L50", "5M"],
        },
    },
};
```

### `pokedex.ts`

```typescript
export const Pokedex: import('../../../sim/dex-species').ModdedSpeciesDataTable = {
    zapdos: {
        inherit: true,
        baseStats: { hp: 90, atk: 90, def: 90, spa: 125, spd: 90, spe: 100 },
    },
    articuno: {
        inherit: true,
        baseStats: { hp: 90, atk: 85, def: 100, spa: 100, spd: 125, spe: 85 },
    },
    moltres: {
        inherit: true,
        baseStats: { hp: 90, atk: 100, def: 90, spa: 125, spd: 85, spe: 90 },
    },
};
```

### `config/custom-formats.ts`

```typescript
export const Formats: import('../sim/dex-formats').FormatList = [
    {
        section: "Gen 5 Enhanced",
    },
    {
        name: "[Gen 5] OU Enhanced",
        desc: `第五世代 OU 增强版：三神鸟学会 Hurricane，Defog 扫除双方钉子。`,
        mod: 'gen5enhanced',
        ruleset: ['Standard', 'Sleep Clause Mod', 'Species Clause', 'Nickname Clause', 'OHKO Clause', 'Evasion Moves Clause', 'HP Percentage Mod', 'Cancel Mod'],
        banlist: ['Uber', 'Arena Trap', 'Drizzle ++ Swift Swim', 'Drought ++ Chlorophyll', 'Sand Stream ++ Sand Rush', 'Snow Warning ++ Slush Rush'],
    },
];
```

---

## 测试 Mod

### 1. 编译

```bash
npm run build
```

### 2. 启动服务器

```bash
node pokemon-showdown start
```

### 3. 测试对战

在对战界面选择 `[Gen 5] OU Enhanced` 格式，验证：

- 闪电鸟可以使用 Hurricane
- Defog 扫除双方钉子
- 种族值修改生效

---

## 常见问题

### 1. 修改后不生效

**原因**: 代码缓存未清除

**解决**:
```bash
npm run build
node pokemon-showdown restart
```

### 2. 技能池不生效

**原因**: `learnsets.ts` 未正确继承

**解决**: 确保只写需要修改的宝可梦和招式，其他自动继承。

### 3. 格式未出现在列表中

**原因**: `custom-formats.ts` 未创建或格式错误

**解决**: 检查文件语法，确保 `export const Formats` 正确。

---

## 进阶技巧

### 1. 条件修改

```typescript
// 示例: 雨天下 Thunder 必中
thunder: {
    inherit: true,
    onModifyMove(move, pokemon, target) {
        if (this.field.isWeather('raindance')) {
            move.accuracy = true;
        }
    },
},
```

### 2. 修改多个招式

```typescript
// 批量提升电系招式威力
const electricMoves = ['thunderbolt', 'thunder', 'voltswitch', 'thunderpunch'];
for (const moveId of electricMoves) {
    Moves[moveId] = {
        inherit: true,
        basePower: Moves[moveId].basePower * 1.2,
    };
}
```

### 3. 基于其他 Mod

```typescript
// 基于 gen5 的修改
export const Moves: import('../../../sim/dex-moves').ModdedMoveDataTable = {
    // 先继承 gen5 的所有修改
    ...require('../gen5/moves').Moves,

    // 再添加自己的修改
    defog: {
        inherit: true,
        // ...
    },
};
```

---

## 参考资料

- [官方 Mods 目录](../../../data/mods/)
- [Pokemon Showdown Simulator 文档](https://github.com/smogon/pokemon-showdown)
- [Smogon 格式规则](https://www.smogon.com/dex/ss/formats/)

---

*最后更新: 2026-01-24*
