# CFRU AI 逻辑开发规则

仅在开发 AI 评分/伤害计算/切换决策等逻辑时适用。

## CFRU 参考优先

实现任何 AI 逻辑前，必须先查阅 CFRU 对应 C 代码。

源码路径: `/ssd3/lvjiawei01/projects/Complete-Fire-Red-Upgrade/src/`

| 功能 | CFRU 文件 | 说明 |
|------|-----------|------|
| 伤害计算 | `damage_calc.c` | 完整伤害公式 |
| 负面评分 | `ai_negatives.c` | 招式扣分规则 |
| 正面评分 | `ai_positives.c` | 招式加分规则 |
| 切换决策 | `ai_switching.c` | 换人判断 |
| 高级策略 | `ai_advanced.c` | 预测和风格 |

实现前检查：
1. 找到 CFRU 对应函数
2. 理解完整逻辑，列出所有特殊情况
3. 检查相关 ABILITY_、ITEM_EFFECT_、gSpecialMoveFlags 的使用

## 特性/道具/招式效果完整性

涉及战斗机制的代码必须考虑所有相关效果。常见遗漏：

- 类型免疫特性: 蓄电、储水、引火、食草、电气引擎、避雷针
- 伤害减免特性: Multiscale, Shadow Shield, Fur Coat, Filter
- 反弹特性: Magic Bounce
- 道具效果: Loaded Dice, Skill Link, Air Balloon, Safety Goggles
- 多段攻击: 2-5次、固定次数、Parental Bond

搜索命令：
```bash
grep -rn "ABILITY_" /ssd3/lvjiawei01/projects/Complete-Fire-Red-Upgrade/src/Battle_AI/
grep -rn "ITEM_EFFECT_" /ssd3/lvjiawei01/projects/Complete-Fire-Red-Upgrade/src/Battle_AI/
```
