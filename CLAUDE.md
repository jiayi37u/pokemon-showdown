# CLAUDE.md - NPC 对战系统

## 项目概述

Pokemon Showdown NPC 对战系统，在开源项目Pokemon Showdown上构建，AI 逻辑移植自 CFRU。
玩家可与不同难度 NPC 对战（单打/双打/Multi Battle）。

**当前版本**: v1.2 (Multi Battle 已完成)
**下一步**: 切换决策系统，但前期工作还有遗留问题，先询问用户需要做什么
**测试**: 简易测试 `node test/npc/ai/run-tests.js`；仿真模拟还在规划中
**构建**: `npm run build`

**核心路径**:
- AI 代码: `server/npc/ai/`
- 文档入口: `docs/README.md`

---

## 通用规则

### Always Do

- 读相关代码再动手，先搜索是否有现成实现可复用
- 方案没有完全理解、认为有风险时主动询问用户，用户很有耐心
- 新功能必须有测试
- 完成代码、用户表明测试通过后，更新 `docs/npc-battle/versions/当前版本/changelog.md`
- AI 逻辑变更同步更新 `docs/ai-logic/对应AI/logic.md`

### Ask First

- 修改服务端架构或对战协议相关代码
- 删除或重命名公共 API

### Never Do

- 通过 `roomBattle.stream.battle` 直接访问 sim Battle（它返回 undefined）
- 跳过测试验证
- 在已冻结版本目录写入变更

---

## 文档同步

所有改动记录在当前版本 changelog（版本号代表"何时修复"，不是"功能归属"）。

| 任务类型 | 更新文档 |
|----------|----------|
| Bug 修复 | `changelog.md` + `known-issues.md` |
| 新功能 / AI 逻辑 | `changelog.md` + 相关 `logic.md` |
| CFRU 迁移 | `changelog.md` + `CFRU-Migration-Checklist.md` |

---

## 深入指南

深入了解、开发项目时，阅读已有文档再继续，目录见`docs/README.md`。

---

*最后更新: 2026-06-05*
