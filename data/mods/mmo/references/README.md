# PokeMMO 机制参考归档

来源：[PokeMMO vs Mainline - Complete Differences](https://www.mmoshowdown.com/resources/mechanics-reference)，网站署名 suhleam。抓取时间：2026-10-12T06:52:20+00:00。日期是归档时间，不代表网页更新时间。

- [英文正文 Markdown](mechanics-reference-2026-10-12.md)：保留正文、全部表格和页脚署名；去除导航与装饰，便于离线阅读和检索。
- [原始 HTML 快照](mechanics-reference-2026-10-12.html)：下载响应原样保存。正文与样式内嵌；图标和站外链接未镜像，离线可能无法显示或访问。
- [项目实现与测试核对记录](../README.md#mechanics-reference-audit-2026-10-12)：说明本地采用的规则及验证范围。

原始 HTML 的 SHA-256：`f3b05c35852eb5805798f2d8da4cd2e8f920c7abe40c54c2b6c29eb27f9be4b4`。

## 正文索引

- [Core Premise](mechanics-reference-2026-10-12.md#core-premise)
- [Battle Mechanics](mechanics-reference-2026-10-12.md#battle-mechanics)
- [Move Base Power Changes](mechanics-reference-2026-10-12.md#move-base-power-changes)
- [Move PP, Behavior, and Flags](mechanics-reference-2026-10-12.md#move-pp-behavior-and-flags)
- [Abilities](mechanics-reference-2026-10-12.md#abilities)
- [Items](mechanics-reference-2026-10-12.md#items)
- [Base Stat Changes](mechanics-reference-2026-10-12.md#base-stat-changes)
- [Bans and Clauses](mechanics-reference-2026-10-12.md#bans-and-clauses)
- [Special Event Moves](mechanics-reference-2026-10-12.md#special-event-moves)

## 项目核对说明

英文归档保留网页说法，不将项目修正写入原文。以下是项目核对结论：

- 禁用冲突采用 2026-10-12 的线上服务器规则：允许 Garchomp + Swords Dance，禁用 Blaziken + Speed Boost；网页禁用前者且未列后者。见 [rulesets.ts](../rulesets.ts) 与 [formats.ts](../../../../config/formats.ts)。
- 网页把破格抑制 Iron Barbs / Rough Skin 标为 Gen 9 行为；本项目把它作为 MMO 特例实现，不能据此修改普通 Gen 9。
- 网页声称有 55 项种族值更新，实际列出 54 个名字；公开数据另含 Illumise。具体数值见 [pokedex.ts](../pokedex.ts)。
- 回复招式表中的 8 PP 是强化后的上限，对应 5 基础 PP；招式威力表只列部分变更，不能当作完整招式数据库。
- VGC 专属条款保留在原文中，不应用于本项目的 OU／UU／NU 单打模式。

相关回归测试：[pokemmo-reference.js](../../../../test/sim/misc/pokemmo-reference.js)。精灵分级和招式池仍以项目的静态数据为准；该网页不包含完整分级目录。

本目录用于保留外部参考，不会在对战启动时加载。后续更新请另存带日期的快照，保留本次归档与来源署名；归档不改变原内容的权利归属。
