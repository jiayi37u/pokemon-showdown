/** Strategic action membership. No branch-count caps and no search/transition execution. */
import { type AIPokemon, type BattleState, type MoveScore } from '../cfru/types';
import { hardMove } from './opponent-model';
import { HardEvaluation } from './evaluation';
import { actionDelay, type MatchupEvaluator } from './matchups';
import { megaEvolutionState } from '../cfru/util/forms';
import { effectiveAbility, effectiveItem, grounded, rulesDex } from '../cfru/util/mechanics';
import { entryHazardDamage } from '../cfru/util/turn-outcome';
import { selectMoveCandidates } from '../cfru/scoring';
import { bindOpponent, clonePosition, identity, knownMoves, modelsFor, moveAction, positionKey, switchIn, usableMove,
	type SearchAction, type Side } from './projection';

export function perspective(state: BattleState, side: Side): BattleState {
	return side === 'self' ? state : { ...state, self: state.opponent, opponent: state.self };
}

/** Prune below-baseline moves only when the adjacent boundary gap exceeds this value. */
export const SEARCH_SCORE_GAP = 20;

export class CandidateSelector {
	pruned = { invalid: 0, scores: 0, switches: 0, entries: 0 };
	reused = { choices: 0 };
	protected assessments = new Map<string, ReturnType<MatchupEvaluator['assess']>>();
	private choicesCache = new Map<string, SearchAction[]>();
	private entryCache = new Map<string, Set<string>>();
	readonly matchups: MatchupEvaluator;
	private readonly knowledge?: BattleState;
	constructor(matchups: MatchupEvaluator, root?: BattleState) {
		this.knowledge = root;
		this.matchups = matchups;
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

	/** Required entries share the same matchup policy as voluntary switches. */
	rankEntries(state: BattleState, side: Side): AIPokemon[] {
		const table = this.assess(state).matrix, view = perspective(state, side);
		const ownIndex = state.self.team.findIndex(p => p.active);
		const foeIndex = state.opponent.team.findIndex(p => p.active);
		return this.entryChoices(state, side, 'free').map(p => {
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

	/** Consume the cached matchup verdict. Partial/uncertain advantages do not suppress switching. */
	favorableStay(state: BattleState, side: Side): boolean {
		return this.matchups.holdsAdvantage(state, side, this.assess(state));
	}

	/** Destinations share entry selection; possible pivot timing retains either entry context. */
	destinations(state: BattleState, side: Side): AIPokemon[] {
		const view = perspective(state, side), actor = view.self.active[0], dex = rulesDex(state.field);
		const reserves = view.self.reserve.filter(p => !p.fainted && p.hp > 0);
		if (knownMoves(actor).some(id => dex.moves.get(id).selfSwitch && usableMove(state, side, id))) {
			return [actor, ...new Set([...this.entryChoices(state, side, 'exposed'),
				...this.entryChoices(state, side, 'free')])];
		}
		if (actor.volatiles.has('trapped') || this.trapped(state, side)) return [actor];
		const switches = this.switchChoices(state, side, reserves.map(p =>
			({ id: `switch ${p.slot}`, switchTo: p, prior: 0 })));
		return [actor, ...switches.map(a => a.switchTo!)];
	}

	/** Restore the observer's whole hypothesis pool before pruning an information set.
	 * A concrete search world must not decide which hidden-dependent entries remain legal.
	 */
	private entryKnowledge(state: BattleState, side: Side): BattleState | undefined {
		if (side !== 'self' || !this.knowledge) return state;
		const next = clonePosition(state);
		for (const p of next.opponent.team) {
			const known = this.knowledge.opponent.team.find(q => identity(p) === identity(q));
			if (!known?.presetModels) continue;
			// A public form change needs a new belief pool; retain entries until it is available.
			if (known.species !== p.species) return;
			p.presetModels = known.presetModels;
			p.hpPercent = Math.ceil(p.hpPercent);
			p.hp = Math.ceil(p.hpPercent * p.maxHp / 100);
		}
		return next;
	}

	/** One entry policy. `switch` is voluntary and concedes an action; `exposed` is
	 * a required entry with a public pending action; `free` concedes no action.
	 * No access to the queued move, and no species/move-specific candidate exceptions.
	 */
	entryChoices(state: BattleState, side: Side, context: 'switch' | 'exposed' | 'free'): AIPokemon[] {
		const legal = state[side].reserve.filter(p => !p.fainted && p.hp > 0);
		const required = context !== 'switch', exposed = context !== 'free';
		if (!legal.length || !required && this.favorableStay(state, side)) return [];
		const key = `${positionKey(state)}:${side}:${context}`, cached = this.entryCache.get(key);
		if (cached) return legal.filter(p => cached.has(identity(p)));
		const belief = this.entryKnowledge(state, side);
		if (!belief) return legal;
		const view = perspective(belief, side), actor = view.self.active[0], foe = view.opponent.active[0];
		// Simultaneous faints do not yet reveal the opponent's next occupant.
		if (!foe || foe.fainted) return legal;
		const other = side === 'self' ? 'opponent' : 'self';
		const table = this.assess(belief).matrix;
		const ownIndex = belief.self.team.indexOf(belief.self.active[0]);
		const foeIndex = belief.opponent.team.indexOf(belief.opponent.active[0]);
		const entries = legal.map(p => {
			const index = belief[side].team.findIndex(q => identity(q) === identity(p));
			const pair = side === 'self' ? table[index]?.[foeIndex] : table[ownIndex]?.[index];
			const own = pair?.[side], opposing = pair?.[other];
			const health = (view.self.conditions.healingWish ? p.maxHp : p.hp) -
				entryHazardDamage(p, view.self.conditions, state.field);
			return { p, own, margin: (exposed ? own?.counter : own?.check) || 0,
				pressure: (exposed ? own?.entryPressure : own?.pressure) || 0,
				sustain: (exposed ? own?.entrySustain : own?.sustain) || 0,
				threat: opposing?.check || 0, health, loss: 0, stayLoss: 0, survival: 0 };
		});
		const selected = new Set(entries.filter(e => e.health > 0 && e.margin > e.threat).map(e => e.p));
		const hasAdvantage = selected.size > 0;
		const sacrifices = new Set<AIPokemon>();
		for (const entry of entries) {
			if (entry.health <= 0) sacrifices.add(entry.p);
			if (!exposed) continue;
			for (const model of modelsFor(foe)) {
				const before = clonePosition(view); bindOpponent(before, foe, model);
				for (const entrant of modelsFor(view.self.team.find(p => identity(p) === identity(entry.p))!)) {
					const after = clonePosition(before);
					bindOpponent(perspective(after, 'opponent'), entry.p, entrant);
					const entryHP = after.self.team.find(p => identity(p) === identity(entry.p))!.hp;
					switchIn(after, 'self', entry.p);
					const incoming = after.self.active[0], attacker = after.opponent.active[0];
					if (incoming.fainted) sacrifices.add(entry.p);
					let worst = 0, stay = 0;
					for (const id of knownMoves(attacker).filter(move => usableMove(before, 'opponent', move))) {
						if (rulesDex(state.field).moves.get(id).category === 'Status') continue;
						if (actionDelay(attacker, state.field, hardMove(id, 1, state.field.formatId || ''))) continue;
						const dealt = this.damage(after, attacker, incoming, id, 'opponent');
						worst = Math.max(worst, dealt);
						stay = Math.max(stay, this.damage(before, before.opponent.active[0], before.self.active[0], id, 'opponent'));
					}
					if (worst >= incoming.hp) sacrifices.add(entry.p);
					const weight = model.weight * entrant.weight;
					entry.loss += weight * (Math.max(0, entryHP - incoming.hp) + Math.min(incoming.hp, worst)) / incoming.maxHp;
					entry.stayLoss += weight * Math.min(actor.hp, stay) / actor.maxHp;
					entry.survival += weight * Number(!incoming.fainted && worst < incoming.hp);
				}
			}
		}
		if (!hasAdvantage) {
			const useful = entries.filter(e => e.health > 0 && e.own && (required ||
				e.survival > 0 && e.loss < e.stayLoss));
			// Without a winning matchup, preserve distinct strengths rather than a fixed top K.
			const metrics = (e: typeof entries[number]) => [e.margin - e.threat, e.pressure, e.sustain, -e.loss];
			for (const e of useful) {
				const a = metrics(e);
				if (!useful.some(q => {
					const b = metrics(q);
					return b.every((n, i) => n >= a[i]) && b.some((n, i) => n > a[i]);
				})) selected.add(e.p);
			}
		}
		if (sacrifices.size) {
			const roles = this.matchups.roles(view);
			const cost = (p: AIPokemon) => roles[view.self.team.findIndex(q => identity(q) === identity(p))].value;
			const least = Math.min(...[...sacrifices].map(cost));
			for (const p of sacrifices) if (cost(p) === least) selected.add(p);
		}
		const result = required && !selected.size ? legal : legal.filter(p => selected.has(p));
		this.entryCache.set(key, new Set(result.map(identity)));
		return result;
	}

	switchChoices(state: BattleState, side: Side, actions: SearchAction[]): SearchAction[] {
		if (!actions.some(a => a.switchTo)) return [];
		const selected = new Set(this.entryChoices(state, side, 'switch').map(identity));
		return actions.filter(a => a.switchTo && selected.has(identity(a.switchTo)));
	}

	/** Reuse tactical scoring over the search's existing knowledge. Destination membership
	 * comes from the matchup policy; scoring cannot invent a switch to rescue a weak move.
	 */
	scoreActions(state: BattleState, side: Side, actions: SearchAction[]): Map<SearchAction, MoveScore> {
		const scores = new Map<SearchAction, MoveScore>();
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
			const predictions = evaluator.predictions(actor, replacements);
			for (const a of moves) {
				const conditional = { ...actor,
					moves: [...new Set([...(actor.moveKnowledge?.revealedMoves || actor.moves), a.move!])] };
				const score = evaluator.scoreMoves(conditional, [hardMove(a.move!, 1, format)], foe,
					predictions, replacements)[0];
				a.prior = score.score; scores.set(a, score);
			}
		}
		return scores;
	}

	/** All tactical eligibility comes from scoring; search only supplies recipients and hypotheses. */
	choices(state: BattleState, side: Side, supplied?: SearchAction[]): SearchAction[] {
		const key = `${positionKey(state)}:${side}`;
		const cached = !supplied && this.choicesCache.get(key);
		if (cached) { this.reused.choices++; return cached; }
		const view = perspective(state, side), actor = view.self.active[0];
		if (!actor || actor.fainted) return this.rankEntries(state, side).map(p =>
			({ id: `switch ${p.slot}`, switchTo: p, prior: 0 }));
		const known = knownMoves(actor).filter(id => usableMove(state, side, id));
		let actions: SearchAction[] = supplied || [
			...known.map(move => moveAction(state, side, move)),
			...(!actor.volatiles.has('trapped') && !this.trapped(state, side) ? view.self.reserve.filter(p => !p.fainted)
				.map(p => ({ id: `switch ${p.slot}`, switchTo: p, prior: 0 })) : []),
		];
		actions = actions.filter(action => {
			if (action.move && !usableMove(state, side, action.move)) { this.pruned.invalid++; return false; }
			return true;
		});
		const switches = this.switchChoices(state, side, actions);
		const scores = this.scoreActions(state, side, actions);
		const retained = new Set(selectMoveCandidates([...scores.values()], SEARCH_SCORE_GAP));
		const movesKept = actions.filter(action => retained.has(scores.get(action)!));
		this.pruned.scores += scores.size - movesKept.length;
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
		p.boosts, p.baseStats, p.item, p.itemExchange, p.lastMove,
		p.moves, p.species, p.types, p.ability, [...p.volatiles].sort()]),
	state.opponent.team.map(p => [identity(p), Math.ceil(p.hpPercent), p.active, p.status, p.boosts,
		p.lastMove, p.itemKnown ? p.item : '', p.itemExchange, p.moves, p.species, p.types, [...p.volatiles].sort(),
		p.observedAbility || p.abilityChanged ? p.ability : '']),
	state.field, state.self.conditions, state.opponent.conditions]);
}
