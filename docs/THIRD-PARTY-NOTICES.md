# 第三方来源与许可声明

本仓库基于开源项目二次开发，除上游代码外还包含以下第三方内容。请在使用/再分发前核对各自许可证。

---

## 1. Pokemon Showdown（上游）

- 来源：<https://github.com/smogon/pokemon-showdown>
- 许可：MIT
- 版权：Copyright (c) 2011-2026 Guangcong Luo and other contributors <http://pokemonshowdown.com/>
- 说明：本仓库为其 fork，上游代码与文档按 MIT 保留原版权声明，完整文本见仓库根目录 `LICENSE`。

---

## 2. CFRU — NPC AI 决策逻辑移植

- 来源：<https://github.com/Skeli789/Complete-Fire-Red-Upgrade>（`src/Battle_AI/`）
- 用途：`server/npc/ai/` 下的 AI 决策逻辑（评分系统、伤害计算、切换决策等）由该项目的 C 代码移植为 TypeScript。
- 许可：**未在本仓库中确认**。CFRU 为 ROM Hack 项目，其仓库许可证需自行核对后再决定是否公开分发移植代码。
- 相关文档：`docs/ai-logic/CFRU-Migration-Checklist.md`、`docs/ai-logic/CFRU-Review-Report.md`

> ⚠️ 待办：公开发布前请确认 CFRU 的许可证条款，并在本节补充其许可证全文或链接。

---

## 3. Translation.js — PSChina 汉化脚本

- 文件：仓库根目录 `Translation.js`
- 来源：PSChina 社区（脚本头部标注作者 **AL、WyAK**，版本 1.7.2）
- 许可：脚本头部标注 MIT
- 说明：该脚本为**独立的油猴（UserScript）插件**，用于客户端界面汉化，不参与服务端构建与运行。其内含宝可梦官方中文译名等数据。

> ⚠️ 待办：若要随本仓库公开分发，建议向原作者确认授权；或改为仅保留链接、不纳入仓库。

---

## 4. 中文翻译数据（`tmp_chinese/`）

- 文件：`tmp_chinese/name.txt`、`tmp_chinese/move.txt`、`tmp_chinese/ability.txt`
- 来源：为汉化方案收集的百科/Wiki 格式译名数据，采集来源与授权未记录。
- 用途：仅作为 `docs/trans.md` 所述汉化方案的素材，**未接入运行时**。
- 相关设计文档：`docs/trans.md`

> ⚠️ 待办：确认数据来源与再分发授权后再公开。

---

## 5. 其它

- `all_changes.patch`：本项目二次开发的完整 diff 快照，由本项目生成。
- `data/npc/teams/*.json`：NPC 队伍配置，由本项目编写。
- `error.log`：本地调试残留，发布前已建议删除。

---

*如发现遗漏的第三方内容，请补充到本文件。*
