/** Strategic action membership. No branch-count caps and no search/transition execution. */
import { type AIPokemon, type BattleState, type MoveScore } from '../cfru/types';
import { hardMove, publicTargetModels } from './opponent-model';
import { HardEvaluation } from './evaluation';
import { actionDelay, valueWeights, type MatchupEvaluator } from './matchups';
import { megaEvolutionState } from '../cfru/util/forms';
import { rulesDex } from '../cfru/util/mechanics';
import { selectMoveCandidates } from '../cfru/scoring';
import { bindOpponent, clonePosition, identity, knownMoves, modelsFor, moveAction, positionKey, switchIn,
	usableMove, projectEntry, snapshotPosition, isTrapped,
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
	private publicViews = new Map<string, BattleState>();
	private responseCachePolicy = new Map<string, { action: SearchAction, probability: number }[]>();
	private entryWeights = new Map<string, Map<string, number>>();
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
	private pairs(state: BattleState, coordinates: [number, number][]) {
		const cached = this.assessments.get(positionKey(state));
		return cached ? coordinates.map(([i, j]) => cached.matrix[i][j]) : this.matchups.pairs(state, coordinates);
	}

	/** Required entries share the same matchup policy as voluntary switches. */
	rankEntries(state: BattleState, side: Side): AIPokemon[] {
		const view = perspective(state, side);
		const ownIndex = state.self.team.findIndex(p => p.active);
		const foeIndex = state.opponent.team.findIndex(p => p.active);
		const entries = this.entryChoices(state, side, 'free');
		const pairs = this.pairs(state, entries.map(p => side === 'self' ?
			[state.self.team.indexOf(p), foeIndex] : [ownIndex, state.opponent.team.indexOf(p)]));
		return entries.map((p, n) => {
			const matchup = pairs[n]?.[side];
			const health = projectEntry(p, view.self.conditions, state.field, view.self.active[0].slot).hp;
			return { p, rank: [Number(health > 0), matchup?.check || 0,
				matchup?.pressure || 0, matchup?.sustain || 0, health / p.maxHp] };
		}).sort((a, b) => {
			for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i];
			return a.p.slot - b.p.slot;
		}).map(entry => entry.p);
	}

	/** Consume the cached matchup verdict. Partial/uncertain advantages do not suppress switching. */
	favorableStay(state: BattleState, side: Side): boolean {
		return this.matchups.holdsAdvantage(state, side, this.assessments.get(positionKey(state)));
	}

	/** Destinations share entry selection; possible pivot timing retains either entry context. */
	destinations(state: BattleState, side: Side): AIPokemon[] {
		const view = perspective(state, side), actor = view.self.active[0], dex = rulesDex(state.field);
		const reserves = view.self.reserve.filter(p => !p.fainted && p.hp > 0);
		if (knownMoves(actor).some(id => dex.moves.get(id).selfSwitch && usableMove(state, side, id))) {
			return [actor, ...new Set([...this.entryChoices(state, side, 'exposed'),
				...this.entryChoices(state, side, 'free')])];
		}
		if (actor.volatiles.has('trapped') || isTrapped(state, side)) return [actor];
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
		return snapshotPosition(next);
	}

	/** One entry policy. `switch` is voluntary and concedes an action; `exposed` is
	 * a required entry with a public pending action; `free` concedes no action.
	 * No access to the queued move, and no species/move-specific candidate exceptions.
	 */
	entryChoices(state: BattleState, side: Side, context: 'switch' | 'exposed' | 'free'): AIPokemon[] {
		const legal = state[side].reserve.filter(p => !p.fainted && p.hp > 0);
		const required = context !== 'switch', exposed = context !== 'free';
		if (!legal.length) return [];
		const key = `${positionKey(state)}:${side}:${context}`, cached = this.entryCache.get(key);
		if (cached) return legal.filter(p => cached.has(identity(p)));
		const belief = this.entryKnowledge(state, side);
		if (!belief) return legal;
		const view = perspective(belief, side), actor = view.self.active[0], foe = view.opponent.active[0];
		// Simultaneous faints do not yet reveal the opponent's next occupant.
		if (!foe || foe.fainted) return legal;
		const other = side === 'self' ? 'opponent' : 'self';
		const ownIndex = belief.self.team.indexOf(belief.self.active[0]);
		const foeIndex = belief.opponent.team.indexOf(belief.opponent.active[0]);
		const pairs = this.pairs(belief, legal.map(p => {
			const index = belief[side].team.findIndex(q => identity(q) === identity(p));
			return side === 'self' ? [index, foeIndex] : [ownIndex, index];
		}));
		const entries = legal.map((p, n) => {
			const pair = pairs[n];
			const own = pair?.[side], opposing = pair?.[other];
			const health = projectEntry(p, view.self.conditions, state.field, actor.slot).hp;
			return { p, own, margin: (exposed ? own?.counter : own?.check) || 0,
				pressure: (exposed ? own?.entryPressure : own?.pressure) || 0,
				sustain: (exposed ? own?.entrySustain : own?.sustain) || 0,
				threat: opposing?.check || 0, health, loss: 0, stayLoss: 0, survival: 0, stayFatal: true };
		});
		const selected = new Set(entries.filter(e => e.health > 0 && e.margin > e.threat).map(e => e.p));
		const hasAdvantage = selected.size > 0;
		const certainAdvantage = entries.some(e => e.health > 0 && e.margin >= 1 && e.threat === 0);
		// Winning the current exchange does not make preserving this member useless.
		// Keep reliable advantageous recipients for the team-value search to compare.
		if (!required && this.favorableStay(state, side)) return legal.filter(p => selected.has(p));
		const sacrifices = new Set<AIPokemon>();
		for (const entry of entries) {
			if (entry.health <= 0) { sacrifices.add(entry.p); continue; }
			if (!exposed) continue;
			// An advantageous recipient can still need a sacrifice or a cheaper way to save the active member.
			models: for (const model of modelsFor(foe)) {
				const before = clonePosition(view); bindOpponent(before, foe, model);
				for (const entrant of modelsFor(view.self.team.find(p => identity(p) === identity(entry.p))!)) {
					const after = clonePosition(before);
					bindOpponent(perspective(after, 'opponent'), entry.p, entrant);
					const entryHP = after.self.team.find(p => identity(p) === identity(entry.p))!.hp;
					switchIn(after, 'self', entry.p);
					const incoming = after.self.active[0], attacker = after.opponent.active[0];
					if (incoming.fainted) { sacrifices.add(entry.p); if (hasAdvantage) break models; }
					let worst = 0, stay = 0;
					for (const id of knownMoves(attacker).filter(move => usableMove(before, 'opponent', move))) {
						if (rulesDex(state.field).moves.get(id).category === 'Status') continue;
						if (actionDelay(attacker, state.field, hardMove(id, 1, state.field.formatId || ''))) continue;
						const dealt = this.damage(after, attacker, incoming, id, 'opponent');
						worst = Math.max(worst, dealt);
						if (!required && !certainAdvantage) {
							stay = Math.max(stay, this.damage(before, before.opponent.active[0], before.self.active[0], id, 'opponent'));
						}
					}
					if (worst >= incoming.hp) { sacrifices.add(entry.p); if (hasAdvantage) break models; }
					const weight = model.weight * entrant.weight;
					if (!required && weight > 0) entry.stayFatal &&= stay >= actor.hp;
					entry.loss += weight * (valueWeights.hp *
						(Math.max(0, entryHP - incoming.hp) + Math.min(incoming.hp, worst)) / incoming.maxHp +
						valueWeights.member * Number(incoming.fainted || worst >= incoming.hp));
					entry.stayLoss += weight * (valueWeights.hp * Math.min(actor.hp, stay) / actor.maxHp +
						valueWeights.member * Number(stay >= actor.hp));
					entry.survival += weight * Number(!incoming.fainted && worst < incoming.hp);
				}
			}
		}
		// Losing the active member is not cheaper merely because it has little HP left.
		// Preserve alternatives only when a recipient survives every probed configuration.
		if (!hasAdvantage || !required && !certainAdvantage &&
			entries.some(e => e.survival > 0 && !sacrifices.has(e.p) && e.stayFatal)) {
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
				[...position.opponent.team, ...(position.opponent.preview || [])].map(p => [p, modelsFor(p)])),
			this.matchups.damageCache);
			const replacements = evaluator.switchTargets(actor, foe, targets);
			const predictions = evaluator.predictions(actor, replacements);
			const groups = new Map<string, { actor: AIPokemon, actions: SearchAction[] }>();
			for (const a of moves) {
				const conditional = [...new Set([...(actor.moveKnowledge?.revealedMoves || actor.moves), a.move!])];
				const key = JSON.stringify(conditional);
				let group = groups.get(key);
				if (!group) groups.set(key, group = { actor: { ...actor, moves: conditional }, actions: [] });
				group.actions.push(a);
			}
			for (const group of groups.values()) {
				const results = evaluator.scoreMoves(group.actor, group.actions.map(a => hardMove(a.move!, 1, format)),
					foe, predictions, replacements);
				group.actions.forEach((a, i) => { a.prior = results[i].score; scores.set(a, results[i]); });
			}
		}
		return scores;
	}

	/** Public configurations are inference inputs, never the trainer's private request. */
	private responseView(state: BattleState): BattleState {
		const key = positionKey(state), cached = this.publicViews.get(key);
		if (cached) return cached;
		const next = clonePosition(state);
		for (const p of next.self.team) {
			const models = publicTargetModels(p, state.field.formatId || '');
			Object.assign(p, models[0].pokemon, { presetModels: models });
		}
		snapshotPosition(next); this.publicViews.set(key, next); return next;
	}

	/** One matrix row supplies entry quality. Exposed entries use counter; free entries use check.
	 * A cheap weakened member may buy a free entry for an otherwise unsafe check.
	 * These are behavior weights, not guarantees that a recipient survives every attack.
	 */
	entryProbabilities(state: BattleState, entries: AIPokemon[], exposed = true): Map<string, number> {
		const view = this.responseView(state);
		const key = `${positionKey(view)}:${exposed}:${entries.map(identity).join(',')}`;
		const cached = this.entryWeights.get(key); if (cached) return cached;
		const i = view.self.team.indexOf(view.self.active[0]);
		const pairs = this.pairs(view, entries.map(p =>
			[i, view.opponent.team.findIndex(q => identity(p) === identity(q))]));
		const ranked = entries.map((p, n) => {
			const pair = pairs[n];
			const health = projectEntry(p, view.opponent.conditions, view.field, view.opponent.active[0].slot).hp;
			const own = pair.opponent;
			const margin = (exposed ? own.counter : own.check) - pair.self.check;
			return { p, health, margin, check: own.check, pressure: own.pressure,
				quality: 1 + margin + (exposed ? own.entryPressure : own.pressure) +
					(exposed ? own.entrySustain : own.sustain) };
		});
		let selected = ranked.filter(e => e.health > 0 && e.margin > 0);
		if (!selected.length) {
			const best = Math.max(...ranked.map(e => e.health > 0 ? e.quality : -Infinity));
			selected = ranked.filter(e => e.health > 0 && e.quality >= best - 0.25);
		}
		const weights = new Map(selected.map(e => [identity(e.p), Math.max(0.25, e.quality)]));
		if (exposed) {
			// Material plus this row's offensive role is a cheap sacrifice-cost estimate.
			const cost = (e: typeof ranked[number]) => valueWeights.member +
				valueWeights.hp * e.p.hp / e.p.maxHp + valueWeights.check * e.check + valueWeights.pressure * e.pressure;
			const fodder = ranked.filter(e => e.health / e.p.maxHp <= 0.25 &&
				!weights.has(identity(e.p)) && ranked.some(q => q !== e && q.health > 0 && q.check > 0));
			fodder.sort((a, b) => cost(a) - cost(b));
			if (fodder.length) {
				const e = fodder[0], followup = Math.max(...ranked.filter(q => q !== e && q.health > 0).map(q => q.check));
				const weight = followup - cost(e) / (valueWeights.member + valueWeights.hp + valueWeights.check + valueWeights.pressure);
				if (weight > 0) weights.set(identity(e.p), weight);
			}
		}
		// All entrants may die to hazards; the forced replacement must still be represented.
		if (!weights.size) for (const p of entries) weights.set(identity(p), 1);
		const total = [...weights.values()].reduce((a, b) => a + b, 0);
		const result = new Map([...weights].map(([id, weight]) => [id, weight / total]));
		this.entryWeights.set(key, result); return result;
	}

	/** Score once against public beliefs, trim negligible alternatives, then normalize.
	 * The distribution is shared by every own root action; no queued move is an input.
	 */
	responseProbabilities(state: BattleState): { action: SearchAction, probability: number }[] {
		const view = this.responseView(state), key = positionKey(view);
		const cached = this.responseCachePolicy.get(key); if (cached) return cached;
		const actor = view.opponent.active[0];
		const moves = knownMoves(actor).filter(id => usableMove(view, 'opponent', id))
			.map(id => moveAction(view, 'opponent', id));
		const scores = this.scoreActions(view, 'opponent', moves);
		const retained = new Set(selectMoveCandidates([...scores.values()], SEARCH_SCORE_GAP));
		const best = Math.max(...[...scores.values()].map(s => s.score));
		const available = new Map(modelsFor(actor).flatMap(m => m.moves.map(move => [move.id, move.availability] as const)));
		let weighted = moves.filter(a => retained.has(scores.get(a)!)).map(action => ({ action,
			probability: (available.get(action.move!) || 1) * Math.exp((scores.get(action)!.score - best) / 8) }));
		// A response with less than 5% of the strongest move's mass is approximated away.
		const largest = Math.max(...weighted.map(a => a.probability));
		weighted = weighted.filter(a => a.probability >= largest * 0.05);
		const entries = !isTrapped(view, 'opponent') && !actor.volatiles.has('trapped') ?
			this.entryProbabilities(state, state.opponent.reserve.filter(p => !p.fainted && p.hp > 0)) : new Map<string, number>();
		const [pair] = this.pairs(view, [[view.self.team.indexOf(view.self.active[0]), view.opponent.team.indexOf(actor)]]);
		const retreat = Math.max(0, pair.self.check - pair.opponent.check, Math.min(1, (100 - best) / 70));
		const switchMass = entries.size ? 0.6 * retreat : 0;
		const total = weighted.reduce((sum, a) => sum + a.probability, 0);
		const result = weighted.map(a => ({ ...a, probability: (1 - switchMass) * a.probability / total }));
		if (!result.length) result.push({ action: { id: 'pass', prior: 0 }, probability: 1 - switchMass });
		for (const [id, probability] of entries) if (switchMass > 0) {
			const p = state.opponent.reserve.find(p => identity(p) === id)!;
			result.push({ action: { id: `switch ${p.slot}`, switchTo: p, prior: 0 }, probability: switchMass * probability });
		}
		this.responseCachePolicy.set(key, result); return result;
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
			...(!actor.volatiles.has('trapped') && !isTrapped(state, side) ? view.self.reserve.filter(p => !p.fainted)
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
}

/** An own continuation may depend on public consequences, never on invisible profile identity. */
export function observationKey(state: BattleState): string {
	return JSON.stringify([state.self.team.map(p => [identity(p), p.hp, p.maxHp, p.active, p.status,
		p.boosts, p.baseStats, p.item, p.itemExchange, p.lastMove,
		p.moves, p.species, p.types, p.ability, [...p.volatiles].sort(), p.volatileTurns?.taunt, p.volatileTurns?.encore]),
	state.opponent.team.map(p => [identity(p), Math.ceil(p.hpPercent), p.active, p.status, p.boosts,
		p.lastMove, p.itemKnown ? p.item : '', p.itemExchange, p.moves, p.species, p.types, [...p.volatiles].sort(),
		p.volatileTurns?.taunt, p.volatileTurns?.encore,
		p.observedAbility || p.abilityChanged ? p.ability : '']),
	state.field, state.self.conditions, state.opponent.conditions]);
}
