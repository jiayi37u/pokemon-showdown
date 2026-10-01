# PS 原生测试基础设施

Pokemon Showdown 自带三层测试机制，目的各不相同。

---

## 1. 单元测试 (`test/sim/`)

**目的**：验证每个招式/特性/道具是否按游戏规则正确实现。

**结构**：
```
test/sim/
├── abilities/       # 特性测试 (每个特性一个文件)
├── moves/           # 招式测试
├── items/           # 道具测试
├── misc/            # 综合测试 (天气/地形/体重等)
├── tools/           # 工具测试
├── data.js          # 数据完整性测试
├── dex.js           # Dex API 测试
└── common.js        # 测试工具库
```

**核心 API** (`test/common.js`):
```javascript
const battle = common.createBattle(options, [team1, team2]);
battle.makeChoices('move 1', 'move 2');     // 双方同时选择
battle.choose('p1', 'switch 2');            // 单方选择
battle.getDebugLog();                       // 获取完整日志
```

`common.createBattle()` 直接实例化 `Battle` 对象（绕过 BattleStream），同步执行，适合断言式测试。默认使用固定随机种子保证确定性。

**示例**：
```javascript
it('Earthquake should hit all adjacent in doubles', function () {
    battle = common.createBattle({gameType: 'doubles'}, [
        [{species: 'Garchomp', moves: ['earthquake']}, ...],
        [{species: 'Pikachu', moves: ['splash']}, ...]
    ]);
    battle.makeChoices('move earthquake', 'move splash, move splash');
    assert(battle.p2.active[0].hp < battle.p2.active[0].maxhp);
});
```

---

## 2. 批量随机模拟 (`tools/simulate`)

**入口**：`node tools/simulate [multi|exhaustive] [flags]`

### multi 模式 — 崩溃检测

```bash
node tools/simulate multi --num 1000 --format gen9randombattle
```

- 两个 `RandomPlayerAI` 互相随机出招
- **不验证决策质量**，只验证能否正常跑完不 crash
- 用途：发现招式/特性交互中未处理的异常

### exhaustive 模式 — 效果覆盖

```bash
node tools/simulate exhaustive --cycles 3
```

- 维护 Pool（所有宝可梦/招式/特性/道具）
- 每局从池中抽取，确保每个效果至少被执行一次
- 遍历所有世代 (gen1-gen9) 和对战类型 (singles/doubles)
- **冒烟测试**：通过不代表无 Bug，只代表不会着火

### --dual 模式 — 序列化一致性

```bash
node tools/simulate multi --num 100 --dual
```

- 同时跑两个 BattleStream，输入完全相同
- 每回合对 test 流执行 `toJSON()` → `fromJSON()` 重建
- 断言两个流状态完全一致
- 验证战斗状态序列化/反序列化的正确性

### 常用标志

| 标志 | 说明 |
|------|------|
| `--num N` | 对局数（默认 100） |
| `--format` | 指定格式 |
| `--seed A,B,C,D` | PRNG 种子（可复现） |
| `--output` | 打印对战输出日志 |
| `--input` | 打印对战输入日志 |
| `--error` | 仅在出错时打印输入日志 |
| `--async` | 并发执行 |

---

## 3. 程序化对战模拟 API

PS 提供三种方式程序化运行对战，复杂度递增：

### 方式 A：命令行 stdin/stdout

```bash
echo '>start {"formatid":"gen9randombattle"}
>player p1 {"name":"Alice"}
>player p2 {"name":"Bob"}
>p1 move 1
>p2 move 3' | ./pokemon-showdown simulate-battle
```

输出是 PS 协议消息（双换行分隔 chunk）。支持 `--debug`、`--replay`。

配套命令：
- `./pokemon-showdown generate-team [FORMAT]` — 生成随机队伍（packed 格式）
- `./pokemon-showdown validate-team [FORMAT]` — 验证队伍合法性
- `./pokemon-showdown pack-team` / `export-team` / `json-team` — 格式转换

### 方式 B：BattleStream（Node.js 进程内）

```typescript
import {BattleStream, getPlayerStreams} from '../sim';

const stream = new BattleStream();
const streams = getPlayerStreams(stream);
// streams: { omniscient, spectator, p1, p2, p3, p4 }

void streams.omniscient.write(
    '>start {"formatid":"gen9ou"}\n' +
    '>player p1 {"name":"A","team":"..."}\n' +
    '>player p2 {"name":"B","team":"..."}'
);

// 读取 p1 的 request
for await (const chunk of streams.p1) {
    const request = JSON.parse(chunk);  // 包含可选招式、可切换精灵等
    streams.p1.write('move 1');         // 发送选择
}
```

**关键文件**：`sim/battle-stream.ts`

**协议命令**：`>start`, `>player`, `>p1`/`>p2`/`>p3`/`>p4`, `>forcewin`, `>forcetie`, `>reseed`

### 方式 C：Runner 类（封装好的自动对战）

```typescript
import {Runner} from '../sim/tools/runner';
import {RandomPlayerAI} from '../sim/tools/random-player-ai';

const runner = new Runner({
    format: 'gen9ou',
    p1options: { createAI: (s, o) => new RandomPlayerAI(s, o) },
    p2options: { createAI: (s, o) => new MyCustomAI(s, o) },
    output: true,
});
await runner.run();
```

`RandomPlayerAI` 可继承，覆盖以下方法：
```typescript
class MyAI extends RandomPlayerAI {
    chooseMove(request): string { /* 自定义招式选择 */ }
    chooseSwitch(request): string { /* 自定义切换选择 */ }
    chooseTeamPreview(request): string { /* 自定义预览选择 */ }
}
```

**关键文件**：
- `sim/tools/runner.ts` — Runner 类
- `sim/tools/random-player-ai.ts` — RandomPlayerAI 基类
- `sim/tools/multi-random-runner.ts` — 批量运行器
- `sim/tools/exhaustive-runner.ts` — 穷举运行器
- `sim/examples/battle-stream-example.ts` — 完整示例

### 选择指南

| 场景 | 推荐方式 |
|------|---------|
| 非 Node.js 环境 / 快速验证 | A (stdin/stdout) |
| 自定义 AI 对战 / 集成测试 | B (BattleStream) 或 C (Runner) |
| 批量跑对战收集统计 | C (Runner + MultiRandomRunner) |
| 单元测试断言 | `common.createBattle()` (同步，无 Stream) |

---

## 文档参考

| 文件 | 说明 |
|------|------|
| `COMMANDLINE.md` | CLI 命令完整列表 |
| `sim/SIMULATOR.md` | 模拟器协议文档 |
| `sim/SIM-PROTOCOL.md` | 协议消息格式、选择格式 |

---

*最后更新: 2026-06-05*
