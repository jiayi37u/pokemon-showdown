/** Strategic action membership. No branch-count caps and no search/transition execution. */
import { DISCOURAGED_SCORE, type AIPokemon, type BattleState } from '../cfru/types';
import { hardMove } from './opponent-model';
import { HardEvaluation } from './evaluation';
import { actionDelay, type MatchupEvaluator } from './matchups';
import { megaEvolutionState } from '../cfru/util/forms';
import { effectiveAbility, effectiveItem, effectivePriority, grounded, rulesDex } from '../cfru/util/mechanics';
import { boostsCanChange, boostChanges } from '../cfru/util/move-effects';
import { entryHazardDamage } from '../cfru/util/turn-outcome';
import { compareActionOrder } from '../cfru/util/speed';
import { itemRemovalFailure } from '../cfru/util/items';
import { bindOpponent, clonePosition, identity, knownMoves, modelsFor, positionKey, switchIn, usableMove,
	type SearchAction, type Side } from './projection';

export function perspective(state: BattleState, side: Side): BattleState {
	return side === 'self' ? state : { ...state, self: state.opponent, opponent: state.self };
}

/** Only failures independent of the opposing stay/switch choice are hard-pruned. */
export function certainlyUseless(state: BattleState, side: Side, action: SearchAction): boolean {
	if (!action.move) return false;
	if (!usableMove(state, side, action.move)) return true;
	const view = perspective(state, side), actor = view.self.active[0];
	const move = hardMove(action.move, 1, state.field.formatId || ''), data = rulesDex(state.field).moves.get(move.id);
	if (['sleeptalk', 'snore'].includes(move.id) && actor.status !== 'slp') return true;
	if (move.id === 'fakeout' && (actor.activeMoveActions || actor.lastMove)) return true;
	if (data.target === 'self' && data.boosts && !data.heal && !data.volatileStatus &&
		!boostsCanChange(actor, boostChanges(move, view) || data.boosts, view)) return true;
	return false;
}

/** Retain real-position move choices for this AI/battle. Hypothetical future positions
 * stay in the per-search cache, so a search cannot overwrite the next turn's knowledge.
 */
const battleCoverage = new WeakMap<MatchupEvaluator, Map<string, { dependency: string, moves: Set<string> }>>();

export class CandidateSelector {
	pruned = { invalid: 0, scores: 0, attacks: 0, switches: 0 };
	reused = { choices: 0, coverage: 0 };
	protected assessments = new Map<string, ReturnType<MatchupEvaluator['assess']>>();
	private choicesCache = new Map<string, SearchAction[]>();
	private coverageCache = new Map<string, Set<string>>();
	readonly matchups: MatchupEvaluator;
	private rootTurn?: number;
	private rootObservation?: string;
	private readonly knownCoverage: Map<string, { dependency: string, moves: Set<string> }>;
	constructor(matchups: MatchupEvaluator, root?: BattleState) {
		this.matchups = matchups; this.rootTurn = root?.turn;
		this.rootObservation = root && observationKey(root);
		if (!battleCoverage.has(matchups)) battleCoverage.set(matchups, new Map());
		this.knownCoverage = battleCoverage.get(matchups)!;
	}

	damage(state: BattleState, actor: AIPokemon, target: AIPokemon, id: string, side: Side): number {
		const view = perspective(state, side);
		return this.matchups.attack(view, actor, target, hardMove(id, 1, state.field.formatId || '')).damage;
	}

	assess(state: BattleState) {
		const key = positionKey(state), cached = this.assessments.get(key);
		if (cached) return cached;
		const result = this.matchups.assess(state); this.assessments.set(key, result); return result;
	}

	/** Order free replacements using pair evaluations, without removing any candidate. */
	rankEntries(state: BattleState, side: Side): AIPokemon[] {
		const table = this.assess(state).matrix, view = perspective(state, side);
		const ownIndex = state.self.team.findIndex(p => p.active);
		const foeIndex = state.opponent.team.findIndex(p => p.active);
		return view.self.reserve.filter(p => !p.fainted && p.hp).map(p => {
			const index = state[side].team.indexOf(p);
			const matchup = side === 'self' ? table[index]?.[foeIndex]?.self : table[ownIndex]?.[index]?.opponent;
			const health = Math.max(0, (view.self.conditions.healingWish ? p.maxHp : p.hp) -
				entryHazardDamage(p, view.self.conditions, state.field));
			return { p, rank: [Number(health > 0), matchup?.check || 0,
				matchup?.pressure || 0, matchup?.sustain || 0, health / p.maxHp] };
		}).sort((a, b) => {
			for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i];
			return a.p.slot - b.p.slot;
		}).map(entry => entry.p);
	}

	benefitsFromLeaving(state: BattleState, side: Side): boolean {
		const actor = state[side].active[0], ability = effectiveAbility(actor, state.field);
		return ability === 'regenerator' && actor.hp < actor.maxHp ||
			ability === 'naturalcure' && !!actor.status || actor.status === 'tox' ||
			Object.values(state[side].conditions.wishes).some(turns => turns > 0) &&
			state[side].reserve.some(p => !p.fainted && p.hp < p.maxHp) ||
			Object.values(actor.boosts).some(n => n < 0) ||
			['yawn', 'perish1', 'perish2', 'leechseed', 'curse', 'confusion', 'encore', 'taunt', 'disable']
				.some(id => actor.volatiles.has(id)) ||
				['choiceband', 'choicespecs', 'choicescarf'].includes(effectiveItem(actor, state.field)) && !!actor.lastMove;
	}

	/** Consume the cached matchup verdict; do not independently reclassify it from move names.
	 * Existing exit benefits still apply. Partial/uncertain advantages do not suppress switching.
	 */
	favorableStay(state: BattleState, side: Side): boolean {
		if (state.self.active[0]?.fainted || state.opponent.active[0]?.fainted ||
			this.benefitsFromLeaving(state, side)) return false;
		const i = state.self.team.indexOf(state.self.active[0]), j = state.opponent.team.indexOf(state.opponent.active[0]);
		const pair = this.assess(state).matrix[i]?.[j];
		return !!pair && pair[side].check >= 1 && pair[side === 'self' ? 'opponent' : 'self'].check === 0;
	}

	/** Destinations are selected independently of attack coverage, avoiding circular pruning.
	 * A pivot still has all legal landing spots; phazing is resolved as chance later.
	 */
	destinations(state: BattleState, side: Side): AIPokemon[] {
		const view = perspective(state, side), actor = view.self.active[0], dex = rulesDex(state.field);
		const reserves = view.self.reserve.filter(p => !p.fainted && p.hp > 0);
		if (knownMoves(actor).some(id => dex.moves.get(id).selfSwitch && usableMove(state, side, id))) {
			return [actor, ...reserves];
		}
		if (actor.volatiles.has('trapped') || this.trapped(state, side)) return [actor];
		const switches = this.switchChoices(state, side, reserves.map(p =>
			({ id: `switch ${p.slot}`, switchTo: p, prior: 0 })));
		return [actor, ...switches.map(a => a.switchTo!)];
	}

	/** Independent effects retain a move only when that effect can matter. Unknown callback
	 * effects remain conservative; priority itself is compared through attack timing below.
	 */
	attackUtility(state: BattleState, action: SearchAction): boolean {
		const m = rulesDex(state.field).moves.get(action.move), actor = state.self.active[0];
		if (m.id === 'knockoff') return !itemRemovalFailure(actor, state.opponent.active[0],
			hardMove(action.move!, 1, state.field.formatId || ''), state.field);
		if (m.id === 'rapidspin') {
			const c = state.self.conditions;
			return !!(c.stealthrock || c.spikes || c.toxicspikes || c.stickyweb ||
				actor.volatiles.has('leechseed') || actor.volatiles.has('partiallytrapped') ||
				m.self?.boosts || rulesDex(state.field).gen >= 8 && boostsCanChange(actor, { spe: 1 }, state) ||
				knownMoves(state.opponent.active[0]).some(id => {
					const reply = rulesDex(state.field).moves.get(id);
					return !!reply.sideCondition || ['leechseed', 'partiallytrapped'].includes(reply.volatileStatus || '');
				}));
		}
		if (m.id === 'suckerpunch') return false;
		return !!(m.selfSwitch && state.self.reserve.some(p => !p.fainted && p.hp > 0) ||
			m.forceSwitch && state.opponent.reserve.some(p => !p.fainted && p.hp > 0) ||
			m.drain || m.status || m.volatileStatus ||
			m.boosts || m.secondaries?.some(effect => effect.chance === 100) ||
			Object.entries(m).some(([key, value]) => typeof value === 'function' &&
				!['basePowerCallback', 'damageCallback', 'onModifyMove', 'onBasePower'].includes(key)));
	}

	/** A weaker priority attack needs a concrete race benefit: finish before a response,
	 * or deal damage before an otherwise lethal response. Merely moving first is not value.
	 */
	priorityUseful(state: BattleState, action: SearchAction, dealt: number,
		alternatives: SearchAction[], switching: boolean): boolean {
		if (switching || dealt <= 0) return false;
		const actor = state.self.active[0], target = state.opponent.active[0];
		const move = hardMove(action.move!, 1, state.field.formatId || '');
		if (effectivePriority(actor, move, state.field) <= 0 || actionDelay(actor, state.field, move)) return false;
		const first = (id: string, reply: ReturnType<typeof hardMove>) => compareActionOrder(actor, target,
			hardMove(id, 1, state.field.formatId || ''), [reply], state.field, state.self.conditions, state.opponent.conditions);
		return knownMoves(target).filter(id => usableMove(state, 'opponent', id)).some(id => {
			const reply = hardMove(id, 1, state.field.formatId || '');
			if (actionDelay(target, state.field, reply) || move.id === 'suckerpunch' && reply.category === 'Status') return false;
			if (first(action.move!, reply) <= 0 || alternatives.some(a => first(a.move!, reply) > 0)) return false;
			const finishes = dealt >= target.hp && !target.volatiles.has('substitute');
			const lethal = reply.category !== 'Status' && this.damage(state, target, actor, id, 'opponent') >= actor.hp;
			return finishes || lethal;
		});
	}

	/** Union coverage over credible destinations and every compatible profile. Separate
	 * resource costs, but a weaker contact attack may be dominated by a non-contact attack.
	 */
	coverage(state: BattleState, side: Side, actions: SearchAction[]): Set<SearchAction> {
		this.rootTurn ??= state.turn;
		this.rootObservation ??= observationKey(state);
		const remember = state.turn === this.rootTurn && observationKey(state) === this.rootObservation;
		const view = perspective(state, side), dex = rulesDex(state.field);
		const selected = new Set(actions.filter(a => a.move && dex.moves.get(a.move).category === 'Status'));
		const attacks = actions.filter(a => a.move && !selected.has(a));
		if (!attacks.length) return selected;
		const targets = this.destinations(state, side === 'self' ? 'opponent' : 'self');
		for (const target of targets.filter(p => !p.fainted && p.hp)) {
			for (const model of modelsFor(target)) {
				const entered = clonePosition(view); bindOpponent(entered, target, model);
				if (!target.active) switchIn(entered, 'opponent', target);
				if (entered.opponent.active[0].fainted) continue;
				const mega = megaEvolutionState(entered, entered.self.active[0]);
				const pair = { ...entered,
					self: { ...entered.self, team: entered.self.active, reserve: [] },
					opponent: { ...entered.opponent, team: entered.opponent.active, reserve: [] } };
				const signature = (a: SearchAction) => `${a.move}:${!!a.mega}`;
				const moves = attacks.map(signature).sort().join(',');
				const entryOptions = [entered.self, entered.opponent].map(s => s.reserve.some(p => !p.fainted && p.hp > 0));
				const key = `${positionKey(pair)}:${!target.active}:${entryOptions}:${moves}`;
				const actor = entered.self.active[0];
				const slot = JSON.stringify([side, identity(actor), identity(target), actor.baseStats,
					actor.item, actor.ability, model.name, moves]);
				const remembered = remember ? this.knownCoverage.get(slot) : undefined;
				let winners = this.coverageCache.get(key) || (remembered?.dependency === key ? remembered.moves : undefined);
				if (winners) this.reused.coverage++;
				if (!winners) {
					winners = new Set();
					const groups = new Map<string, SearchAction[]>();
					for (const a of attacks) {
						const position = a.mega && mega ? mega : entered;
						if (a.move === 'suckerpunch' && (!target.active ||
							!knownMoves(position.opponent.active[0]).some(id => dex.moves.get(id).category !== 'Status' &&
								usableMove(position, 'opponent', id)))) continue;
						if (this.attackUtility(position, a)) { winners.add(signature(a)); continue; }
						const m = dex.moves.get(a.move);
						const cost = JSON.stringify([!!a.mega, m.recoil, m.selfdestruct, m.self,
							m.flags.charge, m.multihit, Math.min(0, m.priority)]);
						if (!groups.has(cost)) groups.set(cost, []);
						groups.get(cost)!.push(a);
					}
					for (const group of groups.values()) {
						const position = group[0].mega && mega ? mega : entered;
						const amounts = group.map(a => this.damage(position, position.self.active[0],
							position.opponent.active[0], a.move!, 'self'));
						group.forEach((a, i) => {
							if (amounts[i] <= 0) return;
							const contact = !!dex.moves.get(a.move).flags.contact;
							const better = group.filter((b, j) => (a.move === 'suckerpunch' || b.move !== 'suckerpunch') &&
								(contact || !dex.moves.get(b.move).flags.contact) && (amounts[j] > amounts[i] || amounts[j] === amounts[i] &&
								(contact && !dex.moves.get(b.move).flags.contact || a.move === 'suckerpunch' && b.move !== 'suckerpunch')));
							if (!better.length || this.priorityUseful(position, a, amounts[i], better, !target.active)) {
								winners!.add(signature(a));
							}
						});
					}
				}
				this.coverageCache.set(key, winners);
				if (remember) this.knownCoverage.set(slot, { dependency: key, moves: winners });
				for (const action of attacks) if (winners.has(signature(action))) selected.add(action);
			}
		}
		return selected;
	}

	/** Keep matchup improvements, defensive pivots against any plausible attack, and
	 * the least valuable members among those a plausible attack can sacrifice.
	 * No rank cutoff: ties and different tactical roles all survive.
	 */
	switchChoices(state: BattleState, side: Side, actions: SearchAction[]): SearchAction[] {
		const switches = actions.filter(a => a.switchTo);
		if (!switches.length || this.favorableStay(state, side)) return [];
		const view = perspective(state, side), actor = view.self.active[0], foe = view.opponent.active[0];
		const assessment = this.assess(state), ownIndex = state.self.team.indexOf(state.self.active[0]);
		const foeIndex = state.opponent.team.indexOf(state.opponent.active[0]);
		const current = assessment.matrix[ownIndex]?.[foeIndex]?.[side];
		const selected = new Set<SearchAction>(), sacrifices = new Set<SearchAction>();
		const leaveBenefit = this.benefitsFromLeaving(state, side);
		for (const action of switches) {
			const index = state[side].team.findIndex(p => identity(p) === identity(action.switchTo!));
			const pair = side === 'self' ? assessment.matrix[index]?.[foeIndex]?.self :
				assessment.matrix[ownIndex]?.[index]?.opponent;
			if (leaveBenefit || pair && (!current || pair.counter > 0 || pair.pressure > current.pressure ||
				pair.sustain > current.sustain)) selected.add(action);
			for (const model of modelsFor(foe)) {
				const before = clonePosition(view); bindOpponent(before, foe, model);
				for (const entrant of modelsFor(action.switchTo!)) {
					const after = clonePosition(before);
					bindOpponent(perspective(after, 'opponent'), action.switchTo!, entrant);
					switchIn(after, 'self', action.switchTo!);
					const incoming = after.self.active[0], attacker = after.opponent.active[0];
					if (incoming.fainted) sacrifices.add(action);
					for (const id of knownMoves(attacker).filter(move => usableMove(before, 'opponent', move))) {
						if (rulesDex(state.field).moves.get(id).category === 'Status') continue;
						const dealt = this.damage(after, attacker, incoming, id, 'opponent');
						const stay = this.damage(before, before.opponent.active[0], before.self.active[0], id, 'opponent');
						const entryLoss = Math.max(0, action.switchTo!.hp - incoming.hp);
						if (!incoming.fainted && dealt < incoming.hp &&
							(dealt + entryLoss) / incoming.maxHp < stay / actor.maxHp) selected.add(action);
						if (dealt >= incoming.hp) sacrifices.add(action);
					}
				}
			}
		}
		if (sacrifices.size) {
			const roles = this.matchups.roles(view);
			const cost = (a: SearchAction) => roles[view.self.team.findIndex(p => identity(p) === identity(a.switchTo!))].value;
			const least = Math.min(...[...sacrifices].map(cost));
			for (const action of sacrifices) if (cost(action) === least) selected.add(action);
		}
		return switches.filter(a => selected.has(a));
	}

	/** Reuse tactical scoring over the search's existing knowledge. Destination membership
	 * comes from the matchup policy; scoring cannot invent a switch to rescue a weak move.
	 */
	scoreActions(state: BattleState, side: Side, actions: SearchAction[]): void {
		const view = perspective(state, side), format = state.field.formatId || '';
		const other = side === 'self' ? 'opponent' : 'self';
		const targets = this.destinations(state, other).filter(p => !p.active);
		for (const transform of [false, true]) {
			const moves = actions.filter(a => a.move && !!a.mega === transform);
			if (!moves.length) continue;
			const position = transform ? megaEvolutionState(view, view.self.active[0]) || view : view;
			const actor = position.self.active[0], foe = position.opponent.active[0];
			const evaluator = new HardEvaluation(position, format, new Map(
				[...position.opponent.team, ...(position.opponent.preview || [])].map(p => [p, modelsFor(p)])));
			const replacements = evaluator.switchTargets(actor, foe, targets);
			const predictions = evaluator.predictions(actor, replacements, this.benefitsFromLeaving(state, other));
			for (const a of moves) {
				const conditional = { ...actor,
					moves: [...new Set([...(actor.moveKnowledge?.revealedMoves || actor.moves), a.move!])] };
				a.prior = evaluator.scoreMoves(conditional, [hardMove(a.move!, 1, format)], foe,
					predictions, replacements)[0].score;
			}
		}
	}

	/** Score eligibility precedes effect/attack coverage; no move-name exemptions or count caps. */
	choices(state: BattleState, side: Side, supplied?: SearchAction[]): SearchAction[] {
		const key = `${positionKey(state)}:${side}`;
		const cached = !supplied && this.choicesCache.get(key);
		if (cached) { this.reused.choices++; return cached; }
		const view = perspective(state, side), actor = view.self.active[0];
		if (!actor || actor.fainted) return this.rankEntries(state, side).map(p =>
			({ id: `switch ${p.slot}`, switchTo: p, prior: 0 }));
		const dex = rulesDex(state.field);
		const known = knownMoves(actor).filter(id => usableMove(state, side, id));
		let actions: SearchAction[] = supplied || [
			...known.map(move => ({ id: `move ${move}`, move, prior: 0,
				mega: !!dex.items.get(actor.item).megaStone?.[dex.species.get(actor.species).baseSpecies] &&
					!dex.species.get(actor.species).isMega && !view.self.megaUsedByOwner?.[actor.ownerSide || ''] })),
			...(!actor.volatiles.has('trapped') && !this.trapped(state, side) ? view.self.reserve.filter(p => !p.fainted)
				.map(p => ({ id: `switch ${p.slot}`, switchTo: p, prior: 0 })) : []),
		];
		actions = actions.filter(action => {
			if (certainlyUseless(state, side, action)) { this.pruned.invalid++; return false; }
			return true;
		});
		const switches = this.switchChoices(state, side, actions);
		this.scoreActions(state, side, actions);
		const moves = actions.filter(a => a.move);
		let eligible = moves.filter(a => a.prior > DISCOURAGED_SCORE);
		// A legal turn still needs an action when every move is discouraged and escape is unavailable.
		if (!eligible.length && !switches.length) {
			const best = Math.max(...moves.map(a => a.prior));
			eligible = moves.filter(a => a.prior === best);
		}
		this.pruned.scores += moves.length - eligible.length;
		const coverage = this.coverage(state, side, eligible);
		let movesKept = eligible.filter(a => coverage.has(a));
		if (!movesKept.length && !switches.length) movesKept = eligible;
		this.pruned.attacks += eligible.length - movesKept.length;
		this.pruned.switches += actions.filter(a => a.switchTo).length - switches.length;
		const selected = [...movesKept, ...switches].sort((a, b) => b.prior - a.prior);
		const result = selected.length ? selected : [{ id: 'pass', prior: 0 }];
		if (!supplied) this.choicesCache.set(key, result);
		return result;
	}

	trapped(state: BattleState, side: Side): boolean {
		const actor = state[side].active[0], foe = state[side === 'self' ? 'opponent' : 'self'].active[0];
		if (!foe || actor.types.includes('Ghost') && rulesDex(state.field).gen >= 6 ||
			effectiveItem(actor, state.field) === 'shedshell') return false;
		if (state.field.fairylockTurns) return true;
		if (actor.volatiles.has('partiallytrapped')) return true;
		const ability = effectiveAbility(foe, state.field);
		return ability === 'magnetpull' && actor.types.includes('Steel') || ability === 'shadowtag' &&
			effectiveAbility(actor, state.field) !== 'shadowtag' || ability === 'arenatrap' && grounded(actor, state.field);
	}
}

/** An own continuation may depend on public consequences, never on invisible profile identity. */
export function observationKey(state: BattleState): string {
	return JSON.stringify([state.self.team.map(p => [identity(p), p.hp, p.maxHp, p.active, p.status,
		p.boosts, p.baseStats, p.item, p.lastMove,
		p.moves, p.species, p.types, p.ability, [...p.volatiles].sort()]),
	state.opponent.team.map(p => [identity(p), Math.ceil(p.hpPercent), p.active, p.status, p.boosts,
		p.lastMove, p.itemKnown ? p.item : '', p.moves, p.species, p.types, [...p.volatiles].sort(),
		p.observedAbility || p.abilityChanged ? p.ability : '']),
	state.field, state.self.conditions, state.opponent.conditions]);
}
