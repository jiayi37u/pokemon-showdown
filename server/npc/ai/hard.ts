/** Hard NPC controller. CFRU strategy lives in hard/, shared mechanics remain in cfru/. */
import type { ObjectReadWriteStream } from '../../../lib/streams';
import type { ChoiceRequest } from '../../../sim/side';
import type { PRNG, PRNGSeed } from '../../../sim/prng';
import { Dex, toID } from '../../../sim/dex';
import { NPCBattleAI, type MoveChoice, type SwitchChoice } from './index';
import { DEFAULT_AI_CONFIG, type AIPokemon, type BattleState, type CFRUAIConfig, type MoveScore } from './cfru/types';
import { buildBattleStateWithTracker, buildPokemonFromRequest } from './cfru/state-builder';
import { createBattleTracker } from './cfru/util/battle-tracker';
import { createBattleLogger, type LogLevel } from './cfru/logger';
import { HardEvaluation } from './hard/evaluation';
import { fightingStyle, hardMove } from './hard/opponent-model';

export interface HardAIOptions {
	side?: 'p2' | 'p4';
	seed?: PRNG | PRNGSeed | null;
	cfruConfig?: Partial<CFRUAIConfig>;
	battleId?: string;
	logging?: { console?: LogLevel, file?: LogLevel, logDir?: string };
}

export class HardAI extends NPCBattleAI {
	readonly difficulty = 'hard';
	protected tracker = createBattleTracker('p2');
	private battleRef: AnyObject | null = null;
	private state: BattleState | null = null;
	private activeSlot = 1;
	private configCFRU: CFRUAIConfig;
	private logger: ReturnType<typeof createBattleLogger>;
	private lastSwitchTurn = new Map<number, number>();

	constructor(stream: ObjectReadWriteStream<string>, options: HardAIOptions = {}, debug = false) {
		super(stream, { useStatusMoves: true, canSwitch: true, damageCalc: 'full' }, { seed: options.seed }, debug);
		this.configCFRU = { ...DEFAULT_AI_CONFIG, ...options.cfruConfig, usePrediction: true, useFightingStyle: true };
		this.logger = createBattleLogger(options.battleId || 'hard', options.side || 'p2', options.logging);
	}

	setBattle(battle: AnyObject): void {
		this.battleRef = battle;
		this.tracker.setFormat(battle.format || '');
		if (battle.format) this.configCFRU.formatId = battle.format;
		if (battle.stream) this.tracker.attachToStream(battle.stream);
	}

	getTracker() { return this.tracker; }
	getLogger() { return this.logger; }

	override receiveRequest(request: ChoiceRequest): void {
		if (request.wait) return;
		const state = buildBattleStateWithTracker(request, this.battleRef, this.tracker, this.configCFRU);
		this.receiveRequestWithState(request, state);
	}

	/** Multi supplies a combined public state, with reserves scoped to this controller's own request. */
	receiveRequestWithState(request: ChoiceRequest, state: BattleState, activeSlot = 1): void {
		this.activeSlot = activeSlot;
		this.state = state;
		try {
			super.receiveRequest(request);
		} finally {
			this.activeSlot = 1;
		}
	}

	protected override makeDecision(
		active: AnyObject, moves: MoveChoice[], switches: SwitchChoice[],
		flags: {
			canMegaEvo: boolean, canUltraBurst: boolean, canZMove: boolean, canDynamax: boolean, canTerastallize: boolean,
		},
		activeIndex = 0
	): ReturnType<NPCBattleAI['makeDecision']> {
		const state = this.state!;
		const slot = this.activeSlot + activeIndex;
		const actor = state.self.active.find(p => p.slot === slot);
		if (!actor || !state.opponent.active.length) return super.makeDecision(active, moves, switches, flags, activeIndex);
		const formatId = this.configCFRU.formatId;
		const dex = Dex.forFormat(formatId);
		const evaluator = new HardEvaluation(state, formatId);
		const predictions = evaluator.predictions(actor);
		const variants = [{ actor, evaluator, predictions, transform: undefined as 'mega' | undefined }];
		const mega = flags.canMegaEvo ? this.megaForm(actor) : null;
		if (mega) {
			const megaState = { ...state, self: { ...state.self,
				active: state.self.active.map(p => p === actor ? mega : p),
				team: state.self.team.map(p => p === actor ? mega : p),
			}, field: { ...state.field } };
			if (toID(mega.ability) === 'drought') megaState.field.weather = 'sun';
			if (toID(mega.ability) === 'drizzle') megaState.field.weather = 'rain';
			const evaluation = new HardEvaluation(megaState, formatId);
			variants.push({ actor: mega, evaluator: evaluation, predictions: evaluation.predictions(mega), transform: 'mega' });
		}
		const candidates: { choice: MoveChoice, result: MoveScore, targetPos?: string, targetName: string,
			variant: typeof variants[number], }[] = [];
		for (const variant of variants) for (const choice of moves.filter(m => !m.disabled)) {
			// Return/Frustration power and Hidden Power type are public in our own side request.
			const requestId = variant.actor.moves[choice.slot - 1] || choice.move;
			const base = hardMove(requestId, choice.slot, formatId);
			const move = { ...(choice.zMove ? hardMove(choice.move, choice.slot, formatId) : base),
				target: choice.target, isZMove: choice.zMove };
			if (choice.zMove) {
				const item = dex.items.get(actor.item);
				if (!item.zMoveFrom) {
					move.category = base.category;
					move.basePower = dex.moves.get(base.id).zMove?.basePower || base.basePower;
					move.priority = base.priority;
				}
				// Status Z effects need their own resource valuation; don't spend the crystal for the base effect.
				if (move.category === 'Status') continue;
			}
			const allyTarget = ['adjacentAlly', 'adjacentAllyOrSelf'].includes(move.target);
			const targets = allyTarget ? state.self.active.filter(p => !p.fainted &&
				(p !== actor || move.target === 'adjacentAllyOrSelf')) : state.opponent.active.filter(p => !p.fainted);
			for (const target of targets) {
				const result = variant.evaluator.scoreMoves(variant.actor, [move], target, variant.predictions)[0];
				const adjust = (amount: number, reason: string) => {
					result.score = Math.max(0, result.score + amount);
					result.breakdown.styleAdjust += amount;
					result.breakdown.final = result.score;
					result.breakdown.details.push({ amount, reason, category: 'style' });
				};
				if (choice.zMove && result.score > 0) {
					const ordinary = variant.evaluator.damage(variant.actor, target, base);
					const zDamage = variant.evaluator.damage(variant.actor, target, move);
					adjust(ordinary.min >= target.hp ? -50 : zDamage.min >= target.hp ? 20 : -12,
						'Z resource: prefer a new KO over redundant damage');
				}
				if (variant.transform && result.score > 0) adjust(2, 'Mega evolution improves future turns');
				const targeted = ['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf'].includes(move.target);
				const targetPos = state.isDoubles && targeted ?
					String(allyTarget ? -target.slot : target.slot) : undefined;
				candidates.push({ choice, result, targetPos, targetName: target.species, variant });
			}
		}
		if (!candidates.length) return super.makeDecision(active, moves, switches, flags, activeIndex);
		const maxScore = Math.max(...candidates.map(c => c.result.score));
		let top = candidates.filter(c => c.result.score === maxScore);
		// If every action is predicted to fail, keep a damaging attempt instead of futile healing.
		if (maxScore === 0 && top.some(c => c.result.move.category !== 'Status')) {
			top = top.filter(c => c.result.move.category !== 'Status');
		}
		const best = this.prng.sample(top);
		const replacements = switches.map(sw =>
			evaluator.scoreSwitch(
				buildPokemonFromRequest(sw.pokemon, sw.slot, false, this.configCFRU.formatId), predictions, false, actor))
			.sort((a, b) => b.score - a.score);
		const replacement = replacements.find(p => p.safe);
		if (!active.trapped && replacement) {
			const reason = best.variant.evaluator.switchReason(
				best.variant.actor, best.result, replacement, best.variant.predictions,
				state.turn - (this.lastSwitchTurn.get(slot) ?? -10) <= 2);
			if (reason) {
				this.lastSwitchTurn.set(slot, state.turn);
				this.logger.logSwitchDecision(state.turn, actor, replacement.pokemon,
					replacements.map(p => ({ pokemon: p.pokemon.species, score: p.score, reasons: p.reasons })), reason, state);
				return { type: 'switch', target: replacement.pokemon.slot };
			}
		}
		const reasoning = [`Fighting style: ${fightingStyle(actor, this.configCFRU.formatId)}`];
		for (const [foe, actions] of predictions) {
			const summary = new Map<string, number>();
			for (const action of actions) {
				const name = action.switching ? 'switch' : action.move?.name || 'unknown';
				summary.set(name, (summary.get(name) || 0) + action.weight);
			}
			reasoning.push(`${foe.species} sets: ${[...new Set(actions.map(a => a.preset))].join(' / ')}`);
			reasoning.push(`${foe.species} prediction: ${[...summary].sort((a, b) => b[1] - a[1])
				.map(([name, weight]) => `${name} ${(100 * weight).toFixed(0)}%`).join(' / ')}`);
		}
		this.logger.logMoveDecision(state.turn, actor, candidates.map(c => c.result), best.result.move,
			state, reasoning, undefined, best.targetName);
		return { type: 'move', slot: best.choice.slot, targetPos: best.targetPos,
			zMove: best.choice.zMove, transform: best.variant.transform };
	}

	/** Own request exposes actual stats but not nature: bound the Mega stat delta conservatively. */
	private megaForm(actor: AIPokemon): AIPokemon | null {
		const dex = Dex.forFormat(this.configCFRU.formatId);
		const item = dex.items.get(actor.item);
		if (!item.megaStone) return null;
		const before = dex.species.get(actor.species);
		const evolution = item.megaStone[before.baseSpecies];
		if (before.isMega || !evolution) return null;
		const after = dex.species.get(evolution);
		const stats = { ...actor.baseStats };
		for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
			const delta = Math.floor(2 * (after.baseStats[stat] - before.baseStats[stat]) * actor.level / 100);
			stats[stat] = Math.max(1, stats[stat] + Math.floor(delta * (delta > 0 ? 0.9 : 1.1)));
		}
		return { ...actor, species: after.name, types: after.types, ability: after.abilities[0], baseStats: stats };
	}

	protected override chooseSwitch(active: AnyObject | undefined, switches: SwitchChoice[]): number {
		if (!this.state || !switches.length) return super.chooseSwitch(active, switches);
		const evaluator = new HardEvaluation(this.state, this.configCFRU.formatId);
		const candidates = switches.map(sw => {
			const mon = buildPokemonFromRequest(sw.pokemon, sw.slot, false, this.configCFRU.formatId);
			return evaluator.scoreSwitch(mon, evaluator.predictions(mon), true);
		});
		const bestScore = Math.max(...candidates.map(c => c.score));
		const best = this.prng.sample(candidates.filter(c => c.score === bestScore));
		this.logger.logSwitchDecision(this.state.turn, null, best.pokemon,
			candidates.map(c => ({ pokemon: c.pokemon.species, score: c.score, reasons: c.reasons })),
			'CFRU replacement: choose after entry hazards and matchup evaluation', this.state);
		return best.pokemon.slot;
	}

	protected override shouldDynamax(): boolean { return false; }
}
