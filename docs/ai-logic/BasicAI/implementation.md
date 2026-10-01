# BasicAI 技术实现

## 类结构

```typescript
class BasicAI extends NPCBattleAI {
    readonly difficulty = 'basic';

    // 对手追踪
    private opponentActive: { species: string; types: string[] } | null;
    private battleRef: AnyObject | null;

    // 主要方法
    setBattle(battle: AnyObject): void;
    protected makeDecision(active, moves, switches, flags): Decision;
    protected getOpponentInfo(): AnyObject | null;
}
```

## 核心方法

### makeDecision

```typescript
protected makeDecision(
    active: AnyObject[],
    moves: MoveChoice[][],
    switches: SwitchChoice[][],
    flags: DecisionFlags
): Decision {
    const myMoves = moves[0];

    // 筛选攻击招式
    const attackingMoves = myMoves.filter(m =>
        m.category === 'Physical' || m.category === 'Special'
    );

    if (attackingMoves.length === 0) {
        // 无攻击招式，随机选择
        return { type: 'move', slot: myMoves[0].slot };
    }

    // 计算伤害并排序
    const scored = attackingMoves.map(m => ({
        move: m,
        damage: this.estimateDamage(m, active[0])
    }));
    scored.sort((a, b) => b.damage - a.damage);

    // 选择最高伤害招式
    return { type: 'move', slot: scored[0].move.slot };
}
```

### estimateDamage

```typescript
private estimateDamage(move: MoveChoice, attacker: AnyObject): number {
    const opponent = this.getOpponentInfo();
    let power = move.basePower;

    // STAB
    if (attacker.types.includes(move.type)) {
        power *= 1.5;
    }

    // 属性克制
    if (opponent) {
        const effectiveness = this.getEffectiveness(move.type, opponent.types);
        power *= effectiveness;
    }

    return power;
}
```

### getEffectiveness

```typescript
private getEffectiveness(moveType: string, defTypes: string[]): number {
    // 检查免疫
    if (!Dex.getImmunity(moveType, defTypes)) {
        return 0;
    }

    // 计算效果
    const sum = Dex.getEffectiveness(moveType, defTypes);
    return Math.pow(2, sum);
}
```

## 对手追踪

通过拦截 `battle.stream.push` 监听协议消息：

```typescript
setBattle(battle: AnyObject): void {
    this.battleRef = battle;

    const originalPush = battle.stream.push.bind(battle.stream);
    battle.stream.push = (chunk: string) => {
        this.parseBattleMessage(chunk);
        return originalPush(chunk);
    };
}

private parseBattleMessage(message: string): void {
    const lines = message.split('\n');
    for (const line of lines) {
        // 匹配 |switch|p1a: Name|Species, L50|100/100
        const match = line.match(/\|(switch|drag)\|p1[a-z]?: [^|]+\|([^,|]+)/);
        if (match) {
            const species = match[2].trim();
            const data = Dex.species.get(species);
            this.opponentActive = { species, types: data.types };
        }
    }
}
```

## 文件位置

- **主文件**: `server/npc/ai/basic.ts`
- **基类**: `server/npc/ai/index.ts`

## CFRU 对照

BasicAI 不直接对应 CFRU 的任何 AI 难度，它是一个简化版本，仅用于测试和简单场景。

---

*最后更新: 2026-01-23*
