/** Hard NPC controller. CFRU strategy lives in hard/, shared mechanics remain in cfru/. */
import { moveTargets } from './cfru/util/move-effects';
import type { ObjectReadWriteStream } from '../../../lib/streams';
import type { ChoiceRequest } from '../../../sim/side';
import type { PRNG, PRNGSeed } from '../../../sim/prng';
import { Dex } from '../../../sim/dex';
import { NPCBattleAI, type MoveChoice, type SwitchChoice } from './index';
import { DEFAULT_AI_CONFIG, type BattleState, type CFRUAIConfig, type MoveScore } from './cfru/types';
import { buildBattleStateWithTracker, buildPokemonFromRequest, damagingZMove, trackedPokemonToAIPokemon } from './cfru/state-builder';
import { createBattleTracker } from './cfru/util/battle-tracker';
import { createBattleLogger, type LogLevel } from './cfru/logger';
import { megaEvolutionState } from './cfru/util/forms';
import { getEffectiveSpeed } from './cfru/util/speed';
import { HardEvaluation } from './hard/evaluation';
import { fightingStyle, hardMove, hardMoveId } from './hard/opponent-model';
import { entryObservation, searchPosition, type SearchResult } from './hard/search';
import { MatchupEvaluator } from './hard/matchups';

const leadMoves = new Set(['voltswitch', 'uturn', 'flipturn', 'stealthrock', 'spikes']);

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
	private entryPlan?: { turn: number, belief: string,
		receivers: NonNullable<SearchResult['receivers']> };
	private matchups = new MatchupEvaluator();

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

	protected override chooseTeamPreview(team: AnyObject[]): string {
		const party = team.map((p, index) => buildPokemonFromRequest(p, index + 1, false, this.configCFRU.formatId));
		let candidates = party.filter(p => p.moves.some(move => leadMoves.has(move)));
		if (!candidates.length) {
			// Use known stats and held items, without assuming a future Mega or teammate's weather.
			const speeds = party.map(p => getEffectiveSpeed(p, this.state!.field));
			const fastest = Math.max(...speeds);
			candidates = party.filter((_, index) => speeds[index] === fastest);
		}
		// PS fills the remaining team order; only the lead is selected here.
		return `team ${this.prng.sample(candidates).slot}`;
	}

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
			this.matchups.releasePositions();
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
		this.entryPlan = undefined;
		if (!actor || !state.opponent.active.length) return super.makeDecision(active, moves, switches, flags, activeIndex);
		const formatId = this.configCFRU.formatId;
		const dex = Dex.forFormat(formatId);
		if (!switches.length && active.moves?.length === 1 && active.moves[0].pp === undefined && moves.length === 1) {
			const move = moves[0];
			this.logger.logMoveDecision(state.turn, actor, [], hardMove(move.move, move.slot, formatId), state,
				['Forced by the battle request; no alternative action']);
			return { type: 'move', slot: move.slot };
		}
		const evaluator = new HardEvaluation(state, formatId, undefined, this.matchups.damageCache);
		const predictions = evaluator.predictions(actor);
		const megaState = flags.canMegaEvo ? megaEvolutionState(state, actor) : null;
		// Staying in always evolves when authorized. Switching still uses the original state.
		const moveActor = megaState?.self.active.find(p => p.slot === actor.slot) || actor;
		const moveEvaluator = megaState ?
			new HardEvaluation(megaState, formatId, undefined, this.matchups.damageCache) : evaluator;
		const transform = flags.canMegaEvo ? 'mega' : undefined;
		const candidates: { choice: MoveChoice, result: MoveScore, targetPos?: string, targetName: string }[] = [];
		for (const choice of moves.filter(m => !m.disabled)) {
			// Return/Frustration power and Hidden Power type are public in our own side request.
			const requestId = moveActor.chargingMove || moveActor.moves[choice.slot - 1] || choice.move;
			const base = hardMove(requestId, choice.slot, formatId);
			const attack = choice.zMove ? damagingZMove(dex.moves.get(base.id), choice.move, choice.slot, formatId) : base;
			if (!attack) continue;
			const move = { ...attack, target: choice.target };
			const targets = moveTargets(state, actor, move);
			for (const target of targets) {
				const result = moveEvaluator.scoreMoves(moveActor, [move], target, predictions)[0];
				const adjust = (amount: number, reason: string) => {
					result.score = Math.max(0, result.score + amount);
					result.breakdown.styleAdjust += amount;
					result.breakdown.final = result.score;
					result.breakdown.details.push({ amount, reason, category: 'style' });
				};
				if (choice.zMove && result.score > 0) {
					const ordinary = moveEvaluator.damage(moveActor, target, base);
					const zDamage = moveEvaluator.damage(moveActor, target, move);
					adjust(ordinary.min >= target.hp ? -50 : zDamage.min >= target.hp ? 20 : -12,
						'Z resource: prefer a new KO over redundant damage');
				}
				const targeted = ['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf'].includes(move.target);
				const targetPos = state.isDoubles && targeted ?
					String(state.self.active.includes(target) ? -target.slot : target.slot) : undefined;
				candidates.push({ choice, result, targetPos, targetName: target.species });
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

		// A status move may affect a replacement or recover after incoming damage. The
		// search owns contextual pruning; a failure against the current occupant is not final.
		// Preserve the existing tie preference when search values are exactly equal.
		const choiceId = (choice: MoveChoice) => `move ${choice.slot}${choice.zMove ? ' zmove' : transform ? ' mega' : ''}`;
		const searchActions = [best, ...candidates.filter(c => c !== best)].map(c => ({
			id: choiceId(c.choice), move: c.choice.zMove ? actor.moves[c.choice.slot - 1] : hardMoveId(c.result.move),
			zMove: c.choice.zMove ? c.result.move : undefined,
			mega: !!transform, prior: c.result.score,
		}));
		const search = this.useSearch ? searchPosition(state, evaluator, [...searchActions,
			...(!active.trapped ? switches.map(sw => ({ id: `switch ${sw.slot}`,
				switchTo: state.self.reserve.find(p => p.ident === sw.pokemon.ident)!, prior: 100 }))
				.filter(a => a.switchTo) : [])],
		new Map((active.moves || []).map((m: AnyObject) => [dex.moves.get(m.id || m.move).id, m.pp])),
		this.matchups) : undefined;
		if (search?.receivers) this.entryPlan = { turn: state.turn, belief: this.entryBelief(evaluator, state),
			receivers: search.receivers };
		if (search?.choice?.startsWith('switch')) {
			const target = Number(search.choice.split(' ')[1]);
			const sw = switches.find(s => s.slot === target)!;
			const pokemon = buildPokemonFromRequest(sw.pokemon, sw.slot, false, formatId);
			this.lastSwitchTurn.set(slot, state.turn);
			this.logger.logSwitchDecision(state.turn, actor, pokemon, search.values.filter(v =>
				v.id.startsWith('switch')).map(v => ({
				pokemon: buildPokemonFromRequest(switches.find(s => s.slot === Number(v.id.split(' ')[1]))!.pokemon,
					Number(v.id.split(' ')[1]), false, formatId).species,
				score: v.value,
				reasons: [v.upperBound ? 'Two-turn value upper bound; dominated action' :
				v.lowerBound ? 'Two-turn value lower bound; winning action proven' : 'Two-turn team-position value'],
			})), search.reason, state);
			return { type: 'switch', target };
		}
		if (search?.choice) best = candidates.find(c => choiceId(c.choice) === search.choice)!;
		if (!search?.choice && !active.trapped) {
			const replacements = switches.map(sw =>
				evaluator.scoreSwitch(
					buildPokemonFromRequest(sw.pokemon, sw.slot, false, this.configCFRU.formatId), predictions, false, actor))
				.sort((a, b) => b.score - a.score);
			const replacement = replacements.find(p => p.safe && p.hasFollowUp);
			if (replacement) {
				const reason = moveEvaluator.switchReason(
					moveActor, best.result, replacement, predictions,
					state.turn - (this.lastSwitchTurn.get(slot) ?? -10) <= 2);
				if (reason) {
					this.lastSwitchTurn.set(slot, state.turn);
					this.logger.logSwitchDecision(state.turn, actor, replacement.pokemon,
						replacements.map(p => ({ pokemon: p.pokemon.species, score: p.score, reasons: p.reasons })),
						search ? `${reason}; Search fallback: ${search.reason}` : reason, state);
					return { type: 'switch', target: replacement.pokemon.slot };
				}
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
		return { type: 'move', slot: best.choice.slot, targetPos: best.targetPos,
			zMove: best.choice.zMove, transform };
	}

	private entryBelief(evaluator: HardEvaluation, state: BattleState): string {
		const foe = state.opponent.active[0];
		return JSON.stringify([foe.ident, foe.itemKnown && foe.item, foe.observedAbility,
			evaluator.opponentModels(foe).map(model => [model.name, model.weight, model.pokemon.item,
				model.pokemon.ability, model.pokemon.baseStats, model.moves])]);
	}

	protected override chooseSwitch(active: AnyObject | undefined, switches: SwitchChoice[]): number {
		if (!this.state || !switches.length) return super.chooseSwitch(active, switches);
		// Shared state omits fainted actives. Keep an inert request placeholder only for
		// projecting this free entry; the simulator then applies entry effects normally.
		let state = this.state;
		if (!state.isDoubles && !state.self.active.length && active) {
			const fainted = buildPokemonFromRequest(active, 1, true, this.configCFRU.formatId);
			fainted.ident = active.ident; fainted.ownerSide = active.ident.slice(0, 2);
			if (fainted.fainted) state = { ...state, self: { ...state.self,
				active: [fainted], team: [fainted, ...state.self.team] } };
		}
		if (!state.isDoubles && !state.opponent.active.length) {
			const fainted = this.tracker.getFaintedOpponentAt(`${this.tracker.getOpponentSideId()}a`);
			if (fainted) {
				const pokemon = trackedPokemonToAIPokemon(fainted, 1, true, this.configCFRU.formatId);
				state = { ...state, opponent: { ...state.opponent, active: [pokemon], team: [pokemon,
					...state.opponent.team.filter(member => member.ident !== pokemon.ident)] } };
			}
		}
		const evaluator = new HardEvaluation(state, this.configCFRU.formatId, undefined, this.matchups.damageCache);
		const actor = state.self.active.find(p => p.ident === active?.ident);
		const pivot = actor && this.tracker.getPivotMove(`${actor.ownerSide}a`);
		const previous = this.entryPlan;
		this.entryPlan = undefined;
		if (previous && previous.turn === state.turn && actor && (actor.fainted || pivot) &&
			state.opponent.active.length && previous.belief === this.entryBelief(evaluator, state)) {
			const observation = entryObservation(state);
			const health = [actor.hpPercent, state.opponent.active[0].hpPercent];
			const distance = (values: number[]) => health.reduce((sum, value, index) => sum + Math.abs(value - values[index]), 0);
			const match = previous.receivers.filter(candidate => candidate.observation === observation)
				.sort((left, right) => distance(left.health) - distance(right.health))[0];
			const selected = match && switches.find(choice => choice.pokemon.ident === match.recipient);
			if (selected) {
				this.logger.logSwitchDecision(state.turn, actor, state.self.reserve.find(member => member.ident === match.recipient)!,
					[], 'Reuse two-turn replacement plan', state);
				return selected.slot;
			}
		}
		const recipients = switches.map(sw => state.self.reserve.find(member => member.slot === sw.slot) ||
			buildPokemonFromRequest(sw.pokemon, sw.slot, false, this.configCFRU.formatId));
		const search = this.useSearch ? searchPosition(state, evaluator,
			recipients.map(member => ({ id: `switch ${member.slot}`, switchTo: member, prior: 0,
				copyVolatile: !!pivot && Dex.forFormat(this.configCFRU.formatId).moves.get(pivot).selfSwitch === 'copyvolatile' })),
			new Map(), this.matchups, true) : undefined;
		const searched = recipients.find(member => search?.choice === `switch ${member.slot}`);
		if (search && searched) {
			this.logger.logSwitchDecision(state.turn, null, searched, [], search.reason, state);
			return searched.slot;
		}
		const pending = actor && !actor.fainted ? evaluator.pendingPredictions(actor) : undefined;
		const candidates = recipients.map(member => pending?.size ? evaluator.scoreSwitch(member, pending, false, actor) :
			evaluator.scoreSwitch(member, evaluator.predictions(member), true));
		const bestScore = Math.max(...candidates.map(c => c.score));
		const best = this.prng.sample(candidates.filter(c => c.score === bestScore));
		this.logger.logSwitchDecision(this.state.turn, null, best.pokemon,
			candidates.map(c => ({ pokemon: c.pokemon.species, score: c.score, reasons: c.reasons })),
			search?.choice ? search.reason : `CFRU replacement fallback: ${search?.reason || 'search disabled'}`, this.state);
		return best.pokemon.slot;
	}

	protected override shouldDynamax(): boolean { return false; }
}
