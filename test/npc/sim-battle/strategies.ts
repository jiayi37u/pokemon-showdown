/**
 * NPC AI 实战模拟 Runner —— 玩家策略（strategies）
 *
 * 把 BattlePlayer 的 request 处理拆成几种"决策口味"，让一个入口的 Runner
 * 可以塞不同对手去对打同一个 NPC，看 NPC 在各种压力下的决策曲线。
 *
 * 现有策略：
 *   - max-damage: 用 AI 自己的 damage-calc 挑伤害最高的招式（遇到不能打的目标回退 default）
 *   - random:     PS 原生 RandomPlayerAI
 *   - mirror-npc: 对手也用 NormalAI；用来采两个 AI 互殴的 trace
 *   - scripted:   按 JSON 脚本顺序回答每次 request
 *   - interactive: stdin 手动输入
 */

import type { ObjectReadWriteStream } from '../../../lib/streams';
import { BattlePlayer } from '../../../sim/battle-stream';
import { RandomPlayerAI } from '../../../sim/tools/random-player-ai';
import type { PRNG, PRNGSeed } from '../../../sim/prng';
import type { ChoiceRequest } from '../../../sim/side';
import { Dex } from '../../../sim/dex';
import * as readline from 'readline';

import { BasicAI } from '../../../server/npc/ai/basic';
import { NormalAI, NormalAIOptions } from '../../../server/npc/ai/normal';
import { LogLevel } from '../../../server/npc/ai/cfru/logger';
import { createBattleTracker } from '../../../server/npc/ai/cfru/util/battle-tracker';

export type StrategyName = 'max-damage' | 'random' | 'mirror-npc' | 'scripted' | 'interactive';

export interface StrategyContext {
	stream: ObjectReadWriteStream<string>;
	label: string;              // "p1" | "p2" | "p3" | "p4"
	seed?: PRNG | PRNGSeed | null;
	// scripted-only
	script?: ScriptEntry[];
	// mirror-npc-only
	mirrorOptions?: NormalAIOptions;
	mirrorDifficulty?: 'basic' | 'normal'; // mirror 的 AI 等级，默认 normal
	// mirror-npc / shared：挂同一个 BattleTracker 用的 stream，当 label=p1/p3 时 ourSide='p1'
	ourSide?: 'p1' | 'p2';
	isMulti?: boolean;
	formatId?: string;
	// controls whether choices get echoed to stderr
	trace?: boolean;
}

export interface ScriptEntry {
	choice: string;
	expect?: string;
}

export interface StrategyPlayer {
	start(): Promise<void>;
	close?(): void;
}

export function makeStrategy(name: StrategyName, ctx: StrategyContext): StrategyPlayer {
	switch (name) {
	case 'random':   return new RandomPlayerAI(ctx.stream, { seed: ctx.seed || null });
	case 'scripted': return new ScriptedPlayer(ctx);
	case 'interactive': return new InteractivePlayer(ctx);
	case 'max-damage':  return new MaxDamagePlayer(ctx);
	case 'mirror-npc':  return new MirrorNPCPlayer(ctx);
	}
}

// ---------------------------------------------------------------------------
// Scripted —— 按序列答每次招式 request；teamPreview/forceSwitch 走默认
// ---------------------------------------------------------------------------

class ScriptedPlayer extends BattlePlayer implements StrategyPlayer {
	private cursor = 0;
	private script: ScriptEntry[];
	private labelName: string;
	private trace: boolean;

	constructor(ctx: StrategyContext) {
		super(ctx.stream);
		this.script = ctx.script || [];
		this.labelName = ctx.label;
		this.trace = ctx.trace ?? true;
	}

	override receiveRequest(request: ChoiceRequest): void {
		const req: AnyObject = request;
		if (req.wait) return;
		if (req.teamPreview) { this.choose('default'); return; }
		if (req.forceSwitch) {
			const peek = this.script[this.cursor];
			if (peek && /^(switch|pass)/i.test(peek.choice)) {
				this.cursor++;
				this.trace2(`forceSwitch → ${peek.choice}`);
				this.choose(peek.choice);
			} else {
				this.choose('default');
			}
			return;
		}
		const entry = this.script[this.cursor];
		this.cursor++;
		const choice = entry?.choice || 'default';
		this.trace2(`request#${this.cursor} → ${choice}`);
		this.choose(choice);
	}

	override receiveError(error: Error): void {
		if (error.message.startsWith('[Unavailable choice]')) return;
		throw error;
	}

	private trace2(msg: string): void {
		if (this.trace) console.error(`[${this.labelName}] ${msg}`);
	}
}

// ---------------------------------------------------------------------------
// Interactive —— stdin 读 choice
// ---------------------------------------------------------------------------

class InteractivePlayer extends BattlePlayer implements StrategyPlayer {
	private rl: readline.Interface;
	private labelName: string;

	constructor(ctx: StrategyContext) {
		super(ctx.stream);
		this.labelName = ctx.label;
		this.rl = readline.createInterface({ input: process.stdin, terminal: false });
	}

	override receiveRequest(request: ChoiceRequest): void {
		if (request.wait) return;
		this.printRequestSummary(request);
		process.stdout.write(`[${this.labelName}] choice> `);
		this.ask().then(line => {
			const choice = line.trim() || 'default';
			console.error(`[${this.labelName}] → ${choice}`);
			this.choose(choice);
		}).catch(err => { console.error(err); process.exit(1); });
	}

	override receiveError(error: Error): void {
		if (error.message.startsWith('[Unavailable choice]')) {
			console.error(`[${this.labelName}] 上一次 choice 非法: ${error.message}`);
			return;
		}
		throw error;
	}

	private printRequestSummary(request: ChoiceRequest): void {
		const req: AnyObject = request;
		if (req.teamPreview) {
			console.error(`[${this.labelName}] 请选择队伍顺序 (默认 'default')`);
			return;
		}
		if (req.forceSwitch) console.error(`[${this.labelName}] 强制换人：${JSON.stringify(req.forceSwitch)}`);
		if (req.active) {
			req.active.forEach((slot: AnyObject, i: number) => {
				const mon = req.side?.pokemon?.[i];
				const moves = slot.moves?.map((m: AnyObject, idx: number) =>
					`${idx + 1}:${m.move}${m.disabled ? '*' : ''}`
				).join(' ') ?? '';
				console.error(`  [${i}] ${mon?.details || '?'} HP=${mon?.condition || '?'} moves=${moves}`);
			});
		}
	}

	private ask(): Promise<string> {
		return new Promise(resolve => { this.rl.once('line', resolve); });
	}

	close(): void { this.rl.close(); }
}

// ---------------------------------------------------------------------------
// MaxDamage —— 对每个 active，用 AI 自己的 damage-calc 挑伤害最高的招式
// 没有可见对手数据时（例如 teamPreview、刚入场、Status 招式），回退 'default'。
// 规则：每个 request 独立决策，不依赖历史 state；对手使用 request.side.foe
// 不可见，只能基于 opponentActive 从 PS 协议聚合——这里偷个懒：对每个己方 active，
// 拿 request.active[i].moves + Dex；对手数据从 side.foe 不可得，所以用一个
// 内部 heuristic：如果 move.category 是 Status 跳过，否则对 Dex 构造一个
// 对手代理 pokemon（基于 request 的 foe 简要信息或空 types，按 BP 排序）。
// 这不要求对手精确伤害，仅要求相对排序正确。
// ---------------------------------------------------------------------------

class MaxDamagePlayer extends BattlePlayer implements StrategyPlayer {
	private labelName: string;
	private trace: boolean;
	// 维护一个最简陋的 opponent 快照：species + types + hp%
	private opponentTypes: Map<string, string[]> = new Map();
	constructor(ctx: StrategyContext) {
		super(ctx.stream);
		this.labelName = ctx.label;
		this.trace = ctx.trace ?? true;
	}

	override receiveLine(line: string): void {
		if (line.startsWith('|switch|') || line.startsWith('|drag|')) {
			const parts = line.slice(1).split('|');
			const pos = parts[1]?.split(':')[0]?.trim();
			const species = parts[2]?.split(',')[0]?.trim();
			if (pos && species && !this.isOwnSide(pos)) {
				const data = Dex.species.get(species);
				if (data.exists) this.opponentTypes.set(pos, data.types.slice());
			}
		}
		super.receiveLine(line);
	}

	private isOwnSide(position: string): boolean {
		const sideId = position.slice(0, 2);
		if (this.labelName === 'p1' || this.labelName === 'p3') return sideId === 'p1' || sideId === 'p3';
		if (this.labelName === 'p2' || this.labelName === 'p4') return sideId === 'p2' || sideId === 'p4';
		return sideId === this.labelName;
	}

	override receiveRequest(request: ChoiceRequest): void {
		const req: AnyObject = request;
		if (req.wait) return;
		if (req.teamPreview) { this.choose('default'); return; }
		if (req.forceSwitch) { this.choose('default'); return; }
		if (!req.active) { this.choose('default'); return; }

		const choices: string[] = [];
		for (let i = 0; i < req.active.length; i++) {
			const slot = req.active[i];
			const mon = req.side?.pokemon?.[i];
			if (!mon || mon.condition.endsWith(' fnt') || mon.commanding) {
				choices.push('pass');
				continue;
			}
			if (!slot?.moves?.length) { choices.push('default'); continue; }
			const choice = this.pickMaxMove(slot, mon);
			choices.push(choice);
		}
		const final = choices.join(', ');
		this.trace2(`→ ${final}`);
		this.choose(final);
	}

	override receiveError(error: Error): void {
		if (error.message.startsWith('[Unavailable choice]')) return;
		throw error;
	}

	private pickMaxMove(slotData: AnyObject, mon: AnyObject): string {
		const atkerSpecies = Dex.species.get(mon.details?.split(',')[0] || mon.speciesForme || '');
		const moves = slotData.moves as AnyObject[];
		let best = { score: -1, idx: 0 };
		for (let i = 0; i < moves.length; i++) {
			const m = moves[i];
			if (m.disabled) continue;
			const dexMove = Dex.moves.get(m.move);
			if (!dexMove.exists || dexMove.category === 'Status') continue;
			const bp = dexMove.basePower || 0;
			if (!bp) continue;
			const stab = atkerSpecies.types?.includes(dexMove.type) ? 1.5 : 1.0;
			const eff = this.estimateEffectiveness(dexMove.type);
			const score = bp * stab * eff;
			if (score > best.score) best = { score, idx: i };
		}
		if (best.score < 0) return 'default';
		return `move ${best.idx + 1}`;
	}

	private estimateEffectiveness(moveType: string): number {
		if (!this.opponentTypes.size) return 1.0;
		let total = 0, n = 0;
		for (const types of this.opponentTypes.values()) {
			total += this.typeEff(moveType, types);
			n++;
		}
		return n ? total / n : 1.0;
	}

	private typeEff(moveType: string, defTypes: string[]): number {
		let mult = 1;
		for (const t of defTypes) {
			const defRow: AnyObject = Dex.types.get(t);
			if (!defRow.exists) continue;
			const dc = defRow.damageTaken?.[moveType];
			if (dc === 1) mult *= 2;
			else if (dc === 2) mult *= 0.5;
			else if (dc === 3) mult *= 0;
		}
		return mult;
	}

	private trace2(msg: string): void {
		if (this.trace) console.error(`[${this.labelName} max-damage] ${msg}`);
	}
}

// ---------------------------------------------------------------------------
// MirrorNPC —— 直接用 NormalAI 作为对手；两边 NPC 互打
// ---------------------------------------------------------------------------

class MirrorNPCPlayer implements StrategyPlayer {
	private ai: BasicAI | NormalAI;
	constructor(ctx: StrategyContext) {
		const ourSide: 'p1' | 'p2' = (ctx.label === 'p1' || ctx.label === 'p3') ? 'p1' : 'p2';
		const difficulty = ctx.mirrorDifficulty || 'normal';
		if (difficulty === 'basic') {
			this.ai = new BasicAI(ctx.stream);
		} else {
			const options: NormalAIOptions = {
				battleId: `mirror-${ctx.label}-${Date.now()}`,
				logging: { console: LogLevel.NONE },
				...ctx.mirrorOptions,
			};
			this.ai = new NormalAI(ctx.stream, options);
		}
		// 替换 tracker：根据 label 决定 ourSide，并打开 multi 模式支持 p1+p3 / p2+p4 共享
		(this.ai as AnyObject).tracker = createBattleTracker(ourSide, !!ctx.isMulti);
		this.ai.getTracker().attachToStream(ctx.stream);
		if (this.ai instanceof NormalAI) {
			this.ai.setBattle({ stream: ctx.stream, format: ctx.formatId || '' } as AnyObject);
		} else {
			// BasicAI.setBattle 也会挂一次 tracker，上面已挂过，这里给个最小占位让它拿到 battleRef
			this.ai.setBattle({ stream: ctx.stream, format: ctx.formatId || '' } as AnyObject);
		}
	}
	start(): Promise<void> { return this.ai.start(); }
}

export { ScriptedPlayer, InteractivePlayer, MaxDamagePlayer, MirrorNPCPlayer };
