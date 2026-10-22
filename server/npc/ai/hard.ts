/** Hard NPC controller. CFRU strategy lives in hard/, shared mechanics remain in cfru/. */
import { moveTargets } from './cfru/util/move-effects';
import type { ObjectReadWriteStream } from '../../../lib/streams';
import type { ChoiceRequest } from '../../../sim/side';
import type { PRNG, PRNGSeed } from '../../../sim/prng';
import { Dex } from '../../../sim/dex';
import { NPCBattleAI, type MoveChoice, type SwitchChoice } from './index';
import { DEFAULT_AI_CONFIG, type BattleState, type CFRUAIConfig, type MoveScore } from './cfru/types';
import { buildBattleStateWithTracker, buildPokemonFromRequest } from './cfru/state-builder';
import { createBattleTracker } from './cfru/util/battle-tracker';
import { createBattleLogger, type LogLevel } from './cfru/logger';
import { megaEvolutionState } from './cfru/util/forms';
import { HardEvaluation } from './hard/evaluation';
import { fightingStyle, hardMove } from './hard/opponent-model';
import { searchPosition } from './hard/search';
import { MatchupEvaluator } from './hard/matchups';

export interface HardAIOptions {
	side?: 'p2' | 'p4';
	seed?: PRNG | PRNGSeed | null;
	cfruConfig?: Partial<CFRUAIConfig>;
	battleId?: string;
	logging?: { console?: LogLevel, file?: LogLevel, logDir?: string };
	/** Allows controlled comparisons against the heuristic policy in local simulations. */
	search?: boolean;
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
	private useSearch: boolean;
	private matchups = new MatchupEvaluator();
	private sacrificePlans = new Map<string, { turn: number, recipient: number, position: string, move: string }>();

	constructor(stream: ObjectReadWriteStream<string>, options: HardAIOptions = {}, debug = false) {
		super(stream, { useStatusMoves: true, canSwitch: true, damageCalc: 'full' }, { seed: options.seed }, debug);
		this.configCFRU = { ...DEFAULT_AI_CONFIG, ...options.cfruConfig, usePrediction: true, useFightingStyle: true };
		this.useSearch = options.search !== false;
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
		this.sacrificePlans.delete(actor.ident || actor.species);
		const formatId = this.configCFRU.formatId;
		const dex = Dex.forFormat(formatId);
		const evaluator = new HardEvaluation(state, formatId);
		const predictions = evaluator.predictions(actor);
		const variants = [{ actor, evaluator, predictions, transform: undefined as 'mega' | undefined }];
		const megaState = flags.canMegaEvo ? megaEvolutionState(state, actor) : null;
		if (megaState) {
			const mega = megaState.self.active.find(p => p.slot === actor.slot)!;
			// The opponent does not observe our current choice before choosing its own action.
			const evaluation = new HardEvaluation(megaState, formatId);
			variants.push({ actor: mega, evaluator: evaluation, predictions, transform: 'mega' });
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
			const targets = moveTargets(state, actor, move);
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
					String(state.self.active.includes(target) ? -target.slot : target.slot) : undefined;
				candidates.push({ choice, result, targetPos, targetName: target.species, variant });
			}
		}
		if (!candidates.length) {
			const fallback = super.makeDecision(active, moves, switches, flags, activeIndex);
			const move = moves.find(m => m.slot === fallback.slot);
			if (fallback.type === 'move' && move && state.isDoubles) {
				fallback.targetPos = this.getDefaultTargetPosition(move, actor.slot - 1);
			}
			return fallback;
		}
		const maxScore = Math.max(...candidates.map(c => c.result.score));
		let top = candidates.filter(c => c.result.score === maxScore);
		// A predicted bad outcome is preferable to a move known to have no effect.
		if (top.some(c => !c.result.flags.hasNoEffect && !c.result.flags.isImmune)) {
			top = top.filter(c => !c.result.flags.hasNoEffect && !c.result.flags.isImmune);
		}
		// If every action is predicted to fail, keep a damaging attempt instead of futile healing.
		if (maxScore === 0 && top.some(c => c.result.move.category !== 'Status')) {
			top = top.filter(c => c.result.move.category !== 'Status');
		}
		let best = this.prng.sample(top);
		const replacements = switches.map(sw =>
			evaluator.scoreSwitch(
				buildPokemonFromRequest(sw.pokemon, sw.slot, false, this.configCFRU.formatId), predictions, false, actor))
			.sort((a, b) => b.score - a.score);
		const replacement = replacements.find(p => p.safe && p.hasFollowUp);
		// Keep established impossibility checks: a lucky rollout must not revive a redundant status move.
		// Attacks remain available for a possible opposing switch into a different matchup.
		const searchActions = candidates.filter(c => !c.choice.zMove && (c.result.move.category !== 'Status' ||
			!c.result.flags.hasNoEffect && !c.result.flags.isImmune)).map(c => ({
			id: `move ${c.choice.slot}${c.variant.transform ? ' mega' : ''}`, move: c.result.move.id,
			mega: !!c.variant.transform, prior: c.result.score,
		}));
		const search = this.useSearch && !flags.canZMove ? searchPosition(state, evaluator, [...searchActions,
			...(!active.trapped ? switches.map(sw => ({ id: `switch ${sw.slot}`,
				switchTo: state.self.reserve.find(p => p.ident === sw.pokemon.ident)!, prior: 100 }))
				.filter(a => a.switchTo) : [])],
		new Map((active.moves || []).map((m: AnyObject) => [dex.moves.get(m.id || m.move).id, m.pp])),
		this.matchups) : undefined;
		if (search?.choice?.startsWith('switch')) {
			const target = Number(search.choice.split(' ')[1]);
			const sw = switches.find(s => s.slot === target)!;
			const pokemon = buildPokemonFromRequest(sw.pokemon, sw.slot, false, formatId);
			this.lastSwitchTurn.set(slot, state.turn);
			this.logger.logSwitchDecision(state.turn, actor, pokemon, search.values.filter(v =>
				v.id.startsWith('switch')).map(v => ({
				pokemon: buildPokemonFromRequest(switches.find(s => s.slot === Number(v.id.split(' ')[1]))!.pokemon,
					Number(v.id.split(' ')[1]), false, formatId).species,
				score: v.value, reasons: ['Two-turn team-position value'],
			})), search.reason, state);
			return { type: 'switch', target };
		}
		if (search?.choice) best = candidates.find(c =>
			`move ${c.choice.slot}${c.variant.transform ? ' mega' : ''}` === search.choice)!;
		if (!search?.choice && !active.trapped && replacement) {
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
		if (search) reasoning.push(search.choice ? search.reason : `Search fallback: ${search.reason}`);
		for (const [foe, actions] of predictions) {
			reasoning.push(...(evaluator.inferenceNotes.get(foe) || []).map(note => `${foe.species}: ${note}`));
			const summary = new Map<string, number>();
			for (const action of actions) {
				const name = action.switching ? 'switch' : action.selectedMove ?
					`${action.selectedMove.name} → ${action.move?.name || 'unknown'}` : action.move?.name || 'unknown';
				summary.set(name, (summary.get(name) || 0) + action.weight);
			}
			reasoning.push(`${foe.species} sets: ${[...new Set(actions.map(a => a.preset))].join(' / ')}`);
			reasoning.push(`${foe.species} prediction: ${[...summary].sort((a, b) => b[1] - a[1])
				.map(([name, weight]) => `${name} ${(100 * weight).toFixed(0)}%`).join(' / ')}`);
		}
		this.logger.logMoveDecision(state.turn, actor, candidates.map(c => c.result), best.result.move,
			state, reasoning, undefined, best.targetName);
		if (['healingwish', 'lunardance'].includes(best.result.move.id)) {
			const recipient = best.variant.evaluator.sacrificeRecipient(best.variant.actor);
			if (recipient) this.sacrificePlans.set(actor.ident || actor.species, {
				turn: state.turn, recipient: recipient.pokemon.slot,
				position: `${actor.ownerSide || this.tracker.getOurSide()}${String.fromCharCode(96 + actor.slot)}`,
				move: best.result.move.id });
		}
		return { type: 'move', slot: best.choice.slot, targetPos: best.targetPos,
			zMove: best.choice.zMove, transform: best.variant.transform };
	}

	protected override chooseSwitch(active: AnyObject | undefined, switches: SwitchChoice[]): number {
		if (!this.state || !switches.length) return super.chooseSwitch(active, switches);
		const plan = this.sacrificePlans.get(active?.ident);
		this.sacrificePlans.delete(active?.ident);
		const recipient = switches.find(sw => sw.slot === plan?.recipient);
		if (recipient && this.state.turn === plan?.turn && this.tracker.getOurLastMove(plan.position) === plan.move) {
			const pokemon = buildPokemonFromRequest(recipient.pokemon, recipient.slot, false, this.configCFRU.formatId);
			this.logger.logSwitchDecision(this.state.turn, null, pokemon, [],
				`Receive planned ${plan.move} recovery`, this.state);
			return recipient.slot;
		}
		// Shared state omits fainted actives. Keep an inert request placeholder only for
		// projecting this free entry; the simulator then applies entry effects normally.
		let state = this.state;
		if (!state.isDoubles && !state.self.active.length && active) {
			const fainted = buildPokemonFromRequest(active, 1, true, this.configCFRU.formatId);
			if (fainted.fainted) state = { ...state, self: { ...state.self,
				active: [fainted], team: [fainted, ...state.self.team] } };
		}
		const evaluator = new HardEvaluation(state, this.configCFRU.formatId);
		const candidates = switches.map(sw => {
			const mon = state.self.reserve.find(p => p.slot === sw.slot) ||
				buildPokemonFromRequest(sw.pokemon, sw.slot, false, this.configCFRU.formatId);
			return evaluator.scoreSwitch(mon, evaluator.predictions(mon), true);
		});
		const search = this.useSearch ? searchPosition(state, evaluator,
			candidates.map(c => ({ id: `switch ${c.pokemon.slot}`, switchTo: c.pokemon, prior: c.score })),
			new Map(), this.matchups, true) : undefined;
		const bestScore = Math.max(...candidates.map(c => c.score));
		const best = candidates.find(c => search?.choice === `switch ${c.pokemon.slot}`) ||
			this.prng.sample(candidates.filter(c => c.score === bestScore));
		this.logger.logSwitchDecision(this.state.turn, null, best.pokemon,
			candidates.map(c => ({ pokemon: c.pokemon.species, score: c.score, reasons: c.reasons })),
			search?.choice ? search.reason : `CFRU replacement fallback: ${search?.reason || 'search disabled'}`, this.state);
		return best.pokemon.slot;
	}

	protected override shouldDynamax(): boolean { return false; }
}
