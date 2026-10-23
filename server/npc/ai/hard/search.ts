/** Two-ply action search over AI knowledge snapshots; no simulator or complete-team samples. */
import type { BattleState, OpponentModel } from '../cfru/types';
import type { HardEvaluation } from './evaluation';
import { MatchupEvaluator } from './matchups';
import { rulesDex } from '../cfru/util/mechanics';
import { CandidateSelector, observationKey, perspective } from './candidates';
import {
	actionOutcomes, beginTurn, continueTurn, bindOpponent, clonePosition, endTurn, identity, modelsFor, positionKey,
	supportsMove, switchIn, transitionSupported, type SearchAction, type Side, type TurnCheckpoint,
} from './projection';
export type { SearchAction } from './projection';
export { certainlyUseless } from './candidates';

export interface SearchResult {
	choice?: string;
	reason: string;
	values: { id: string, value: number }[];
	nodes: number;
}
interface EntryDecision {
	key: string;
	side: Side;
	choice: string;
	depth: number;
}
interface Leaf {
	config: number;
	configWeight: number;
	reply: string;
	weight: number;
	value: number;
	entries: EntryDecision[];
}
interface Branch extends Leaf { state: BattleState }

/** Terminal values dominate finite positional heuristics. */
export function positionValue(state: BattleState, matchups = new MatchupEvaluator()): number {
	const self = state.self.team.some(p => !p.fainted && p.hp > 0);
	const foe = state.opponent.team.some(p => !p.fainted && p.hp > 0);
	if (!self || !foe) return self ? 10000 : foe ? -10000 : 0;
	return matchups.assess(state).value;
}

class UnsupportedTransition extends Error {
	readonly nodes: number;
	constructor(move: string, nodes: number) { super(`transition unavailable: ${move}`); this.nodes = nodes; }
}

export class Search extends CandidateSelector {
	nodes = 0;
	override reused = { choices: 0, coverage: 0, continuations: 0 };
	private values = new Map<string, number>();
	private continuations = new Map<string, Leaf[]>();

	value(state: BattleState): number {
		const key = positionKey(state);
		const found = this.values.get(key); if (found !== undefined) return found;
		const terminal = !state.self.team.some(p => p.hp && !p.fainted) || !state.opponent.team.some(p => p.hp && !p.fainted);
		const value = terminal ? positionValue(state, this.matchups) :
			(this.assessments.get(key) || this.matchups.assess(state)).value;
		this.values.set(key, value); return value;
	}

	override choices(state: BattleState, side: Side, supplied?: SearchAction[]): SearchAction[] {
		const actions = super.choices(state, side, supplied);
		const unsupported = actions.find(action => action.move && !supportsMove(state, action.move));
		if (unsupported) throw new UnsupportedTransition(unsupported.move!, this.nodes);
		return actions;
	}

	/** Cache the uncollapsed decision tree: entries must be selected across compatible
	 * hidden profiles together, not independently for each hypothetical world.
	 */
	continuationBranches(state: BattleState, action: SearchAction): Leaf[] {
		const key = `${positionKey(state)}:${action.id}:${!!action.mega}`;
		const cached = this.continuations.get(key);
		if (cached) { this.reused.continuations++; return cached; }
		const branches = this.branches(state, action).map(({ state: _state, ...leaf }) => leaf);
		this.continuations.set(key, branches); return branches;
	}

	continuationValue(state: BattleState, action: SearchAction): number {
		return aggregate(this.continuationBranches(state, action));
	}

	/** Fork only at entry checkpoints. Completed attacks/PP/residuals are never replayed. */
	transitions(start: BattleState, own: SearchAction, reply: SearchAction, replacing: boolean):
	{ state: BattleState, weight: number, entries: EntryDecision[] }[] {
		const walk = (state: BattleState, turn: TurnCheckpoint | undefined, history: string[],
			weight: number, entries: EntryDecision[]): ReturnType<Search['transitions']> => {
			let pending: { side: Side, cause: 'pivot' | 'phaze' | 'faint' } | undefined;
			if (turn && !continueTurn(turn, this.matchups.damagePolicy)) pending = turn.pending;
			if (!pending && [state.self, state.opponent].every(party => party.team.some(p => !p.fainted && p.hp > 0))) {
				const side = (['self', 'opponent'] as const).find(s => state[s].active[0]?.fainted);
				if (side) pending = { side, cause: 'faint' };
			}
			if (!pending) { this.nodes++; return [{ state, weight, entries }]; }
			const { side, cause } = pending;
			const options = state[side].reserve.filter(p => !p.fainted && p.hp > 0);
			// The key omits hidden spreads and the opponent's unexecuted action.
			const key = JSON.stringify([side, cause, history, observationKey(perspective(state, side))]);
			return options.flatMap(pokemon => {
				const profiles = side === 'opponent' ? modelsFor(pokemon) : [undefined];
				return profiles.flatMap(model => {
					const next = clonePosition(state);
					if (model) bindOpponent(next, pokemon, model);
					switchIn(next, side, pokemon);
					const decision = { key, side, choice: identity(pokemon), depth: history.length };
					return walk(next, cause === 'faint' ? undefined : { state: next, remaining: [...turn!.remaining] },
						[...history, identity(pokemon)], weight * (model?.weight ?? 1) / (cause === 'phaze' ? options.length : 1),
						cause === 'phaze' ? entries : [...entries, decision]);
				});
			});
		};
		if (!replacing) {
			const turn = beginTurn(start, own, reply);
			return walk(turn.state, turn, [], 1, []);
		}
		const next = clonePosition(start); switchIn(next, 'self', own.switchTo!);
		if (!start.self.active[0].fainted) endTurn(next, this.matchups.damagePolicy);
		return walk(next, undefined, [], 1, []);
	}

	/** Bind only the participant needed for this branch. Reserve profiles stay as distributions. */
	branches(state: BattleState, own: SearchAction, replacing = false): Branch[] {
		const active = state.opponent.active[0];
		const profiles = active.fainted ?
			[{ name: 'fainted', pokemon: active, moves: [], weight: 1, matched: true }] : modelsFor(active);
		const branches: Branch[] = [];
		for (const [config, profile] of profiles.entries()) {
			const bound = clonePosition(state); bindOpponent(bound, active, profile);
			const replies = replacing ? [{ id: 'pass', prior: 0 }] : this.choices(bound, 'opponent');
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
							for (const next of this.transitions(start, a.action, b.action, replacing)) {
								branches.push({ state: next.state, config, configWeight: profile.weight, reply: reply.id,
									weight: (target?.weight ?? 1) * a.weight * b.weight * next.weight,
									value: this.value(next.state), entries: next.entries });
							}
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
function aggregateLeaves(branches: Leaf[]): number {
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

/** Resolve replacement information sets backwards. A chosen entrant is shared across
 * indistinguishable profiles and pending replies. Random entry/profile outcomes retain
 * their probability mass; they are never promoted to controllable choices.
 */
function resolveEntries(groups: Leaf[][], combine: (values: (number | undefined)[]) => number): number[] {
	const available = new Set(groups.flat());
	const events = new Map<string, { decision: EntryDecision, members: { branch: Leaf, group: number }[] }>();
	groups.forEach((branches, group) => branches.forEach(branch => {
		for (const decision of branch.entries) {
			if (!events.has(decision.key)) events.set(decision.key, { decision, members: [] });
			events.get(decision.key)!.members.push({ branch, group });
		}
	}));
	for (const { decision, members } of [...events.values()].sort((a, b) => b.decision.depth - a.decision.depth)) {
		const options = new Map<string, Leaf[][]>();
		for (const { branch, group } of members) {
			if (!available.has(branch)) continue;
			const choice = branch.entries.find(e => e.key === decision.key)!.choice;
			if (!options.has(choice)) options.set(choice, groups.map(() => []));
			options.get(choice)![group].push(branch);
		}
		let best = decision.side === 'self' ? -Infinity : Infinity, chosen: string | undefined;
		for (const [choice, branches] of options) {
			const value = combine(branches.map(leaves => leaves.length ? aggregateLeaves(leaves) : undefined));
			if (chosen === undefined || (decision.side === 'self' ? value > best : value < best)) {
				best = value; chosen = choice;
			}
		}
		for (const [choice, branches] of options) if (choice !== chosen) {
			for (const group of branches) for (const branch of group) available.delete(branch);
		}
	}
	return groups.map(branches => aggregateLeaves(branches.filter(branch => available.has(branch))));
}

function aggregate(branches: Leaf[]): number {
	return resolveEntries([branches], values => values[0] ?? -Infinity)[0];
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
	const search = new Search(matchups, root);
	const candidates = replacing ? actions : search.choices(root, 'self', actions);
	const roots = candidates.filter(a => a.id !== 'pass').map(action =>
		({ action, branches: search.branches(root, action, replacing) }));
	// Every root is expanded; sorting by an intermediate value adds no pruning benefit.
	for (const candidate of roots) {
		const groups = new Map<string, Branch[]>();
		for (const branch of candidate.branches) {
			if (Math.abs(branch.value) >= 10000) continue;
			const key = observationKey(branch.state);
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(branch);
		}
		for (const group of groups.values()) {
			const options = new Map<string, SearchAction>();
			for (const branch of group) for (const action of search.choices(branch.state, 'self')) {
				options.set(action.id, action);
			}
			let best = -Infinity, chosen: number[] | undefined;
			for (const action of options.values()) {
				const outcomes = group.map(branch => search.continuationBranches(branch.state, action));
				const values = resolveEntries(outcomes, estimates => aggregate(group.flatMap((branch, i) =>
					estimates[i] === undefined ? [] : [{ ...branch, value: estimates[i] }])));
				// One continuation per public observation; retain configuration weights and adversarial replies.
				const value = aggregate(group.map((branch, i) => ({ ...branch, value: values[i] })));
				if (value > best) { best = value; chosen = values; }
			}
			if (chosen) group.forEach((branch, i) => { branch.value = chosen[i]; });
		}
	}
	const initial = search.value(root);
	const order = new Map(candidates.map((action, index) => [action.id, index]));
	const values = roots.map(c => ({ id: c.action.id, value: aggregate(c.branches) - initial }))
		.sort((a, b) => b.value - a.value || order.get(a.id)! - order.get(b.id)!);
	if (!values.length || !Number.isFinite(values[0].value)) {
		return { reason: 'no resolved action', values: [], nodes: search.nodes };
	}
	return { choice: values[0].id, values, nodes: search.nodes,
		reason: `${replacing ? 'Replacement search' : 'Two-turn search'} (${search.nodes} nodes, damage-only): ${values.map(v => `${v.id}=${v.value.toFixed(1)}`).join(', ')}` +
			`; Pruned invalid=${search.pruned.invalid}, low-score=${search.pruned.scores}, attack-coverage=${search.pruned.attacks}, switch-purpose=${search.pruned.switches}` +
			`; Reused choices=${search.reused.choices}, coverage=${search.reused.coverage}, continuation=${search.reused.continuations}` };
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
