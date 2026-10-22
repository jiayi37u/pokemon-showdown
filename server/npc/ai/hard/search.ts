/** Two-ply action search over AI knowledge snapshots; no simulator or complete-team samples. */
import { DEFAULT_AI_CONFIG, type AIPokemon, type BattleState, type OpponentModel } from '../cfru/types';
import { ScoringEngine } from '../cfru/scoring';
import { createCache } from '../cfru/util/cache';
import { hardMove, hardMoveId } from './opponent-model';
import type { HardEvaluation } from './evaluation';
import { MatchupEvaluator } from './matchups';
import { calculateDamage, selectDamage } from './damage';
import { compareActionOrder } from '../cfru/util/speed';
import { effectiveAbility, effectiveItem, grounded, rulesDex } from '../cfru/util/mechanics';
import { boostsCanChange, boostChanges, recoveryCuresStatus } from '../cfru/util/move-effects';
import { directRecoveryAmount, entryHazardDamage } from '../cfru/util/turn-outcome';
import {
	actionOutcomes, advancePosition, bindOpponent, clonePosition, endTurn, identity, knownMoves, modelsFor, positionKey,
	supportsMove, switchIn, transitionSupported, usableMove, type SearchAction, type Side,
} from './projection';
export type { SearchAction } from './projection';

export interface SearchResult {
	choice?: string;
	reason: string;
	values: { id: string, value: number }[];
	nodes: number;
}
interface Branch {
	state: BattleState;
	config: number;
	configWeight: number;
	reply: string;
	weight: number;
	value: number;
}

/** Terminal values dominate finite positional heuristics. */
export function positionValue(state: BattleState, matchups = new MatchupEvaluator()): number {
	const self = state.self.team.some(p => !p.fainted && p.hp > 0);
	const foe = state.opponent.team.some(p => !p.fainted && p.hp > 0);
	if (!self || !foe) return self ? 10000 : foe ? -10000 : 0;
	return matchups.assess(state).value;
}

function perspective(state: BattleState, side: Side): BattleState {
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
	if (actor.hp >= actor.maxHp && directRecoveryAmount(actor, move, state.field) &&
		!(recoveryCuresStatus(move) && actor.status) && move.id !== 'roost') return true;
	return false;
}

class UnsupportedTransition extends Error {
	readonly nodes: number;
	constructor(move: string, nodes: number) { super(`transition unavailable: ${move}`); this.nodes = nodes; }
}

class Search {
	nodes = 0;
	pruned = { invalid: 0, dominated: 0, budget: 0 };
	private values = new Map<string, number>();
	private assessments = new Map<string, ReturnType<MatchupEvaluator['assess']>>();
	private choicesCache = new Map<string, SearchAction[]>();
	readonly matchups: MatchupEvaluator;
	constructor(matchups: MatchupEvaluator) { this.matchups = matchups; }

	value(state: BattleState): number {
		const key = positionKey(state);
		const found = this.values.get(key); if (found !== undefined) return found;
		const terminal = !state.self.team.some(p => p.hp && !p.fainted) || !state.opponent.team.some(p => p.hp && !p.fainted);
		const value = terminal ? positionValue(state, this.matchups) : this.assess(state).value;
		this.values.set(key, value); return value;
	}

	damage(state: BattleState, actor: AIPokemon, target: AIPokemon, id: string, side: Side): number {
		const view = perspective(state, side);
		return selectDamage(calculateDamage(actor, target, hardMove(id, 1, state.field.formatId || ''), state.field,
			undefined, { attackerSideConditions: view.self.conditions, defenderSideConditions: view.opponent.conditions,
				activePokemon: [...view.self.active, ...view.opponent.active] }), this.matchups.damagePolicy);
	}

	assess(state: BattleState) {
		const key = positionKey(state), cached = this.assessments.get(key);
		if (cached) return cached;
		const result = this.matchups.assess(state); this.assessments.set(key, result); return result;
	}

	/** Rank the bench using existing pair evaluations. Full team value belongs to expanded states,
	 * not to each discarded entry candidate. Priorities: survive entry, answer the active foe,
	 * make progress, sustain, and retain HP. This is pruning, not the final switch decision.
	 */
	rankEntries(state: BattleState, side: Side, receivesAttack: boolean): AIPokemon[] {
		const table = this.assess(state).matrix, view = perspective(state, side);
		const ownIndex = state.self.team.findIndex(p => p.active);
		const foeIndex = state.opponent.team.findIndex(p => p.active);
		return view.self.reserve.filter(p => !p.fainted && p.hp).map(p => {
			const index = state[side].team.indexOf(p);
			const matchup = side === 'self' ? table[index]?.[foeIndex]?.self : table[ownIndex]?.[index]?.opponent;
			const health = Math.max(0, (view.self.conditions.healingWish ? p.maxHp : p.hp) -
				entryHazardDamage(p, view.self.conditions, state.field));
			return { p, rank: [Number(health > 0), matchup?.[receivesAttack ? 'counter' : 'check'] || 0,
				matchup?.pressure || 0, matchup?.sustain || 0, health / p.maxHp] };
		}).sort((a, b) => {
			for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i];
			return a.p.slot - b.p.slot;
		}).map(entry => entry.p);
	}

	entry = (state: BattleState, side: Side): AIPokemon | undefined => this.rankEntries(state, side, false)[0];

	/** All candidate moves are scored before the width limit. No four-slot completion occurs. */
	choices(state: BattleState, side: Side, depth: number, supplied?: SearchAction[]): SearchAction[] {
		const key = `${positionKey(state)}:${side}:${depth}`;
		const cached = !supplied && this.choicesCache.get(key); if (cached) return cached;
		const view = perspective(state, side), actor = view.self.active[0], foe = view.opponent.active[0];
		if (!actor || actor.fainted) return this.rankEntries(state, side, false).slice(0, 2).map(p =>
			({ id: `switch ${p.slot}`, switchTo: p, prior: 0 }));
		const dex = rulesDex(state.field);
		const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: state.field.formatId || '' },
			createCache(state.turn));
		const moves = knownMoves(actor).filter(id => usableMove(state, side, id));
		const scores = supplied ? [] : moves.map(id => {
			const conditional = { ...actor, moves: [...new Set([...(actor.moveKnowledge?.revealedMoves || actor.moves), id])] };
			return engine.scoreMoves({ ...view, self: { ...view.self, active: [conditional] } }, conditional,
				[hardMove(id, 1, state.field.formatId || '')], foe)[0];
		});
		let actions: SearchAction[] = supplied || [
			...scores.map(score => ({ id: `move ${hardMoveId(score.move)}`, move: hardMoveId(score.move), prior: score.score,
				mega: !!dex.items.get(actor.item).megaStone?.[dex.species.get(actor.species).baseSpecies] &&
					!dex.species.get(actor.species).isMega && !view.self.megaUsedByOwner?.[actor.ownerSide || ''] })),
			...(!actor.volatiles.has('trapped') && !this.trapped(state, side) ? view.self.reserve.filter(p => !p.fainted)
				.map(p => ({ id: `switch ${p.slot}`, switchTo: p, prior: 0 })) : []),
		];
		actions = actions.filter(action => {
			if (certainlyUseless(state, side, action)) { this.pruned.invalid++; return false; }
			return true;
		});
		// A safe dominance rule: same type/category/priority and no special effects or callbacks.
		const plain = (a: SearchAction) => {
			if (!a.move) return false;
			const m = dex.moves.get(a.move);
			return m.category !== 'Status' && m.basePower > 0 && !m.multihit && !m.secondaries?.length &&
				!m.self && !m.selfSwitch && !m.recoil && !m.drain && !m.selfdestruct && !m.volatileStatus &&
				!Object.values(m).some(value => typeof value === 'function');
		};
		actions = actions.filter(a => {
			if (!plain(a)) return true;
			const m = dex.moves.get(a.move);
			const dominated = actions.some(b => {
				if (a === b || !plain(b) || !!a.mega !== !!b.mega) return false;
				const n = dex.moves.get(b.move);
				return n.basePower > m.basePower && n.type === m.type && n.category === m.category &&
					n.priority === m.priority && JSON.stringify(n.flags) === JSON.stringify(m.flags);
			});
			if (dominated) this.pruned.dominated++; return !dominated;
		});
		const attacks = actions.filter(a => a.move).sort((a, b) => b.prior - a.prior);
		const selected = attacks.slice(0, depth === 0 ? 3 : 2);
		// Retain a first-strike finishing attack even when low base damage ranks behind coverage/setup.
		const finish = attacks.find(a => {
			const move = hardMove(a.move!, 1, state.field.formatId || '');
			return this.damage(state, actor, foe, hardMoveId(move), side) >= foe.hp && knownMoves(foe).filter(id =>
				dex.moves.get(id).category !== 'Status').every(id => compareActionOrder(actor, foe, move,
				[hardMove(id, 1, state.field.formatId || '')], state.field, view.self.conditions, view.opponent.conditions) > 0);
		});
		if (finish && !selected.includes(finish)) selected.push(finish);
		// Setup has delayed value, so give its best scored candidate access to the second ply.
		const setup = attacks.find(a => dex.moves.get(a.move).target === 'self' && dex.moves.get(a.move).boosts);
		if (setup && !selected.includes(setup) && setup.prior > 60) selected.push(setup);
		const switches = this.rankEntries(state, side, true).map(p => actions.find(a => a.switchTo &&
			identity(a.switchTo) === identity(p))).filter((a): a is SearchAction => !!a);
		selected.push(...switches.slice(0, depth === 0 ? 2 : 1));
		this.pruned.budget += actions.length - selected.length;
		const unsupported = selected.find(action => action.move && !supportsMove(state, action.move));
		if (unsupported) throw new UnsupportedTransition(unsupported.move!, this.nodes);
		const result = selected.length ? selected : [{ id: 'pass', prior: 0 }];
		if (!supplied) this.choicesCache.set(key, result);
		return result;
	}

	trapped(state: BattleState, side: Side): boolean {
		const actor = state[side].active[0], foe = state[side === 'self' ? 'opponent' : 'self'].active[0];
		if (!foe || actor.types.includes('Ghost') && rulesDex(state.field).gen >= 6 ||
			effectiveItem(actor, state.field) === 'shedshell') return false;
		if (state.field.fairylockTurns) return true;
		const ability = effectiveAbility(foe, state.field);
		return ability === 'magnetpull' && actor.types.includes('Steel') || ability === 'shadowtag' &&
			effectiveAbility(actor, state.field) !== 'shadowtag' || ability === 'arenatrap' && grounded(actor, state.field);
	}

	/** Bind only the participant needed for this branch. Reserve profiles stay as distributions. */
	branches(state: BattleState, own: SearchAction, depth: number, replacing = false): Branch[] {
		const active = state.opponent.active[0];
		const profiles = active.fainted ?
			[{ name: 'fainted', pokemon: active, moves: [], weight: 1, matched: true }] : modelsFor(active);
		const branches: Branch[] = [];
		for (const [config, profile] of profiles.entries()) {
			const bound = clonePosition(state); bindOpponent(bound, active, profile);
			const replies = replacing ? [{ id: 'pass', prior: 0 }] : this.choices(bound, 'opponent', depth);
			for (const reply of replies) {
				const targets: (OpponentModel | undefined)[] = reply.switchTo ? modelsFor(reply.switchTo) : [undefined];
				for (const target of targets) {
					const start = clonePosition(bound);
					if (target) bindOpponent(start, reply.switchTo!, target);
					for (const a of actionOutcomes(start, 'self', own)) {
						for (const b of actionOutcomes(start, 'opponent', reply, profile.moves)) {
							for (const outcome of [a, b]) if (outcome.action.calledMove &&
								!supportsMove(start, outcome.action.calledMove)) {
								throw new UnsupportedTransition(outcome.action.calledMove, this.nodes);
							}
							let next: BattleState;
							if (replacing) {
								next = clonePosition(start); switchIn(next, 'self', own.switchTo!);
								if (!state.self.active[0].fainted) endTurn(next, this.matchups.damagePolicy);
							} else next = advancePosition(start, a.action, b.action, this.entry, this.matchups.damagePolicy);
							this.nodes++;
							for (const side of ['self', 'opponent'] as const) if (next[side].active[0]?.fainted) {
								const entry = this.entry(next, side); if (entry) switchIn(next, side, entry);
							}
							branches.push({ state: next, config, configWeight: profile.weight, reply: reply.id,
								weight: (target?.weight ?? 1) * a.weight * b.weight, value: this.value(next) });
						}
					}
				}
			}
		}
		return branches;
	}
}

/** Expected value over configurations, worst retained opposing action within each configuration.
 * Opponent actions have no fabricated probabilities. Switching target configurations retain their own mass.
 */
function aggregate(branches: Branch[]): number {
	const configs = new Map<number, { weight: number, replies: Map<string, { sum: number, mass: number }> }>();
	for (const b of branches) {
		if (!configs.has(b.config)) configs.set(b.config, { weight: b.configWeight, replies: new Map() });
		const config = configs.get(b.config)!;
		const reply = config.replies.get(b.reply) || { sum: 0, mass: 0 };
		reply.sum += b.value * b.weight; reply.mass += b.weight; config.replies.set(b.reply, reply);
	}
	let sum = 0, mass = 0;
	for (const config of configs.values()) {
		sum += config.weight * Math.min(...[...config.replies.values()].map(r => r.sum / r.mass)); mass += config.weight;
	}
	return mass ? sum / mass : -Infinity;
}

/** An own continuation may depend on public consequences, never on invisible profile identity. */
function observationKey(state: BattleState): string {
	return JSON.stringify([state.self.team.map(p => [identity(p), p.hp, p.active, p.status, p.boosts, p.item, p.lastMove]),
		state.opponent.team.map(p => [identity(p), Math.ceil(p.hpPercent), p.active, p.status, p.boosts,
			p.lastMove, p.itemKnown ? p.item : '', p.moves, p.species, p.types, [...p.volatiles].sort(),
			p.observedAbility || p.abilityChanged ? p.ability : '']),
		state.field, state.self.conditions, state.opponent.conditions]);
}

function runSearch(
	state: BattleState, evaluator: HardEvaluation, actions: SearchAction[], ownPP: Map<string, number>,
	matchups = new MatchupEvaluator(), replacing = false
): SearchResult {
	const unsupported = transitionSupported(state);
	if (unsupported) return { reason: unsupported, values: [], nodes: 0 };
	if (replacing && !state.self.active[0].fainted) {
		const actor = state.self.active[0];
		if (rulesDex(state.field).moves.get(actor.lastMove).selfSwitch !== true ||
			!state.actedThisTurn?.includes(`${actor.ownerSide}a`) ||
			!state.actedThisTurn.includes(`${state.opponent.active[0].ownerSide}a`)) {
			return { reason: 'mid-turn replacement requires pending action payload', values: [], nodes: 0 };
		}
	}
	const root = clonePosition(state);
	for (const p of state.opponent.preview || []) if (!root.opponent.team.some(q => identity(q) === identity(p))) {
		root.opponent.team.push({ ...p, active: false });
		root.opponent.reserve.push(root.opponent.team[root.opponent.team.length - 1]);
	}
	for (const p of root.opponent.team) {
		const original = [...state.opponent.team, ...(state.opponent.preview || [])].find(q => identity(p) === identity(q))!;
		if (!p.fainted) p.presetModels = [...evaluator.opponentModels(original)];
	}
	Object.assign(root.self.active[0], { projection: { pp: Object.fromEntries(ownPP) } });
	const search = new Search(matchups);
	const candidates = replacing ? actions : search.choices(root, 'self', 0, actions);
	const roots = candidates.filter(a => a.id !== 'pass').map(action =>
		({ action, branches: search.branches(root, action, 0, replacing) }));
	roots.sort((a, b) => aggregate(b.branches) - aggregate(a.branches));
	const beam = roots.slice(0, 4);
	const bestPrior = [...roots].filter(r => r.action.move).sort((a, b) => b.action.prior - a.action.prior)[0];
	if (bestPrior && !beam.includes(bestPrior)) beam.push(bestPrior);
	for (const candidate of beam) {
		const groups = new Map<string, Branch[]>();
		for (const branch of candidate.branches) {
			if (Math.abs(branch.value) >= 10000) continue;
			const key = observationKey(branch.state);
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(branch);
		}
		for (const group of groups.values()) {
			const options = new Map<string, SearchAction>();
			for (const branch of group) for (const action of search.choices(branch.state, 'self', 1)) {
				options.set(action.id, action);
			}
			let best = -Infinity, chosen: number[] | undefined;
			for (const action of options.values()) {
				const values = group.map(branch => aggregate(search.branches(branch.state, action, 1)));
				// One continuation per public observation; retain configuration weights and adversarial replies.
				const value = aggregate(group.map((branch, i) => ({ ...branch, value: values[i] })));
				if (value > best) { best = value; chosen = values; }
			}
			if (chosen) group.forEach((branch, i) => { branch.value = chosen[i]; });
		}
	}
	const initial = search.value(root);
	const values = beam.map(c => ({ id: c.action.id, value: aggregate(c.branches) - initial }))
		.sort((a, b) => b.value - a.value);
	if (!values.length || !Number.isFinite(values[0].value)) {
		return { reason: 'no resolved action', values: [], nodes: search.nodes };
	}
	return { choice: values[0].id, values, nodes: search.nodes,
		reason: `${replacing ? 'Replacement search' : 'Two-turn search'} (${search.nodes} nodes, damage-only): ${values.map(v => `${v.id}=${v.value.toFixed(1)}`).join(', ')}` +
			`; Pruned invalid=${search.pruned.invalid}, dominated=${search.pruned.dominated}, width=${search.pruned.budget}` };
}

/** Unsupported effects abort immediately instead of spending the rest of the search budget. */
export function searchPosition(...args: Parameters<typeof runSearch>): SearchResult {
	try { return runSearch(...args); } catch (error) {
		if (error instanceof UnsupportedTransition) {
			return { reason: `${error.message} (${error.nodes} nodes)`, values: [], nodes: error.nodes };
		}
		throw error;
	}
}
