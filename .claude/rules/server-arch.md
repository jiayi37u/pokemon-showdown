# 服务端架构约束

AI 运行在主进程，sim Battle 在子进程，无法直接访问。架构详情见 `docs/npc-battle/arch/server-integration.md`。

## 关键约束

- `roomBattle.stream.battle` 在服务端返回 `undefined`，不要尝试访问
- 己方数据来自 `request.side.pokemon[]`
- 对手数据必须通过 **BattleTracker** 监听协议消息获取
- 场地状态通过 `tracker.getFieldConditions()` 获取

## 开发前检查

1. 数据来源是 request（己方）还是需要追踪（对手）？
2. 如果需要对手信息，是否使用 BattleTracker？
3. 是否有现有代码解决了类似问题？先搜索复用：
   ```bash
   grep -rn "BattleTracker" server/npc/ai/
   ```
4. 变量命名是否清晰区分 `roomBattle` 和 `simBattle`？

