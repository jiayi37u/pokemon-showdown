# 测试体系

## 核心认知

**测试通过 ≠ 实际可用。**

本项目开发过程中反复验证了这一点：NPC AI 的 23 个已知 Bug 中，大多数是单元测试全部通过后在实际对战中才发现的。原因：

1. **单元测试模拟的数据 vs PS 协议实际数据** — 测试中用 `p4a` 发送消息，但 PS 实际用 `p4b`
2. **测试覆盖了逻辑正确性，但没覆盖集成环境** — 多进程架构、协议格式、异步时序
3. **测试的假设可能是错的** — 如果测试和实现基于同一个错误假设，两者都会"通过"

**正确做法**：当测试通过但实际表现异常时，优先加日志观察真实运行时数据，而不是继续推理代码。

---

## 两层测试体系

| 层级 | 测什么 | 工具 | 文档 |
|------|--------|------|------|
| PS 原生 | 模拟器引擎正确性 + 稳定性 | test/sim/, tools/simulate | [ps-native/](./ps-native/) |
| NPC AI | AI 决策逻辑正确性 | test/npc/ai/ | [npc-ai/](./npc-ai/) |
| NPC AI 实战 | AI 在真实协议下的运行时轨迹 | test/npc/sim-battle/ | [sim-battle](../../test/npc/sim-battle/README.md) |

PS 原生测试保证"游戏规则没错"，NPC AI 单测保证"AI 决策逻辑按设计正确"，sim-battle 保证"AI 在真实协议环境里的行为可观察"。三者独立，互不替代。

---

## 实战验证入口

`test/npc/sim-battle/runner.ts` — 进程内启动一局 BattleStream，p1 可选 scripted / interactive / random 三种玩家，p2 直接实例化 `BasicAI` / `NormalAI`。协议日志 + AI 决策日志同一份输出，不再需要启服务 + 浏览器 + 复制聊天记录。使用方法见 [sim-battle README](../../test/npc/sim-battle/README.md)。

---

*最后更新: 2026-10-04*
