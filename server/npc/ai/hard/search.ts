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

export interface SearchResult {
	choice?: string;
	reason: string;
	values: { id: string, value: number, upperBound?: boolean }[];
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
interface Response {
	config: number;
	profile: OpponentModel;
	state: BattleState;
	action: SearchAction;
}
interface Continuation {
	action: SearchAction;
	responses: Response[];
	pending: Response[];
	completed: Map<Response, Leaf[]>;
	upper: number;
	leaves?: Leaf[];
}
export interface SearchOptions {
	/** Reference mode evaluates the same candidate tree without bound cutoffs or work reordering. */
	prune?: boolean;
}

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
	override reused = { choices: 0, continuations: 0 };
	private values = new Map<string, number>();
	private continuations = new Map<string, Continuation>();
	readonly cutoffs = { actions: 0, roots: 0 };

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

	/** Work ordering only: no action is removed for having expensive random/replacement outcomes. */
	expansionCost(state: BattleState, side: Side, action: SearchAction): number {
		if (action.switchTo) return side === 'opponent' ? modelsFor(action.switchTo).length : 1;
		const move = rulesDex(state.field).moves.get(action.move || '');
		const recipient = move.forceSwitch ? (side === 'self' ? 'opponent' : 'self') : side;
		if (!move.forceSwitch && !move.selfSwitch) return 1;
		return Math.max(1, state[recipient].reserve.filter(p => !p.fainted).reduce((n, p) =>
			n + (recipient === 'opponent' ? modelsFor(p).length : 1), 0));
	}

	/** Retain partial work, never cache an optimistic bound as an exact continuation value. */
	continuation(state: BattleState, action: SearchAction, reorder = false): Continuation {
		const key = `${positionKey(state)}:${action.id}:${!!action.mega}`;
		const cached = this.continuations.get(key);
		if (cached) { this.reused.continuations++; return cached; }
		const responses = this.responses(state), pending = [...responses];
		if (reorder) pending.sort((a, b) =>
			this.expansionCost(a.state, 'opponent', a.action) - this.expansionCost(b.state, 'opponent', b.action) ||
			b.action.prior - a.action.prior);
		const work: Continuation = { action, responses, pending, completed: new Map(), upper: Infinity };
		this.continuations.set(key, work); return work;
	}

	advanceContinuation(work: Continuation): void {
		const response = work.pending.shift();
		if (response) work.completed.set(response,
			this.expandResponse(response, work.action).map(({ state: _state, ...leaf }) => leaf));
		const configs = new Map<number, { weight: number, upper: number }>();
		for (const reply of work.responses) {
			let config = configs.get(reply.config);
			if (!config) configs.set(reply.config, config = { weight: reply.profile.weight, upper: Infinity });
			const leaves = work.completed.get(reply);
			if (leaves?.length) {
				// Another continuation world may share these entry decisions. Relax control,
				// but retain the complete random/configuration mass under each recipient.
				const upper = optimisticValue(leaves, false);
				config.upper = Math.min(config.upper, upper);
			}
		}
		const mass = [...configs.values()].reduce((n, c) => n + c.weight, 0);
		work.upper = mass ? [...configs.values()].filter(c => c.weight > 0)
			.reduce((n, c) => n + c.weight * c.upper, 0) / mass : Infinity;
		if (!work.pending.length) {
			// Canonical response order preserves reference summation and tie behavior.
			work.leaves = work.responses.flatMap(r => work.completed.get(r) || []);
		}
	}

	/** Cache the uncollapsed tree so indistinguishable worlds still share entry decisions. */
	continuationBranches(state: BattleState, action: SearchAction): Leaf[] {
		const work = this.continuation(state, action);
		while (!work.leaves) this.advanceContinuation(work);
		return work.leaves;
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
			const legal = state[side].reserve.filter(p => !p.fainted && p.hp > 0);
			const exposed = turn?.remaining.some(a => a.side !== side &&
				!state[a.side].active[0]?.fainted && a.actor === identity(state[a.side].active[0]));
			const options = cause === 'phaze' ? legal : this.entryChoices(state, side, exposed ? 'exposed' : 'free');
			this.pruned.entries += legal.length - options.length;
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

	private responses(state: BattleState, replacing = false): Response[] {
		const active = state.opponent.active[0];
		const profiles = active.fainted ?
			[{ name: 'fainted', pokemon: active, moves: [], weight: 1, matched: true }] : modelsFor(active);
		return profiles.flatMap((profile, config) => {
			const bound = clonePosition(state); bindOpponent(bound, active, profile);
			const replies = replacing ? [{ id: 'pass', prior: 0 }] : this.choices(bound, 'opponent');
			return replies.map(action => ({ config, profile, state: bound, action }));
		});
	}

	/** Expand one complete opponent response, keeping all random outcomes and their weights. */
	private expandResponse(response: Response, own: SearchAction, replacing = false): Branch[] {
		const { config, profile, state: bound, action: reply } = response;
		const branches: Branch[] = [];
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
		return branches;
	}

	branches(state: BattleState, own: SearchAction, replacing = false): Branch[] {
		return this.responses(state, replacing).flatMap(reply => this.expandResponse(reply, own, replacing));
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

/** Bound complete response trees, preserving chance mass underneath each entry choice.
 * Only an opposing decision confined to one configuration/response can be minimized
 * independently. Shared decisions are relaxed to our best recipient, never chosen with
 * knowledge of the hidden world. Nested entries retain the conservative leaf envelope.
 */
export function optimisticValue(branches: Leaf[], independentOpponent = true): number {
	if (!branches.some(b => b.entries.length)) return aggregateLeaves(branches);
	const envelope = () => Math.max(...branches.map(b => b.value));
	if (branches.some(b => b.entries.length > 1)) return envelope();
	const cells = new Map<string, Leaf[]>();
	const events = new Map<string, Map<string, Set<string>>>();
	for (const branch of branches) {
		const cell = JSON.stringify([branch.config, branch.reply]);
		if (!cells.has(cell)) cells.set(cell, []);
		cells.get(cell)!.push(branch);
		const entry = branch.entries[0];
		if (!entry) continue;
		if (!events.has(entry.key)) events.set(entry.key, new Map());
		const members = events.get(entry.key)!;
		if (!members.has(cell)) members.set(cell, new Set());
		members.get(cell)!.add(entry.choice);
	}
	// A shared choice must not erase an opposing response or a hidden configuration.
	// Different available options need the unrestricted envelope instead.
	for (const members of events.values()) {
		const options = [...members.values()];
		if (options.some(set => set.size !== options[0].size || [...set].some(c => !options[0].has(c)))) {
			return envelope();
		}
	}
	const bounded: Leaf[] = [];
	for (const members of cells.values()) {
		const entries = new Map<string, Map<string, Leaf[]>>();
		for (const branch of members) {
			const entry = branch.entries[0];
			if (!entry) { bounded.push(branch); continue; }
			if (!entries.has(entry.key)) entries.set(entry.key, new Map());
			const choices = entries.get(entry.key)!;
			if (!choices.has(entry.choice)) choices.set(entry.choice, []);
			choices.get(entry.choice)!.push(branch);
		}
		for (const [key, choices] of entries) {
			const outcomes = [...choices.values()].map(leaves => ({
				mass: leaves.reduce((n, b) => n + b.weight, 0), value: aggregateLeaves(leaves),
			}));
			const mass = outcomes[0].mass;
			// Selecting a recipient changes the position, not the probability of reaching
			// this checkpoint. Do not infer a normalized chance model if that is untrue.
			if (!(mass > 0) || outcomes.some(o => Math.abs(o.mass - mass) > 1e-9 * mass)) return envelope();
			const representative = choices.values().next().value![0];
			const minimize = independentOpponent && representative.entries[0].side === 'opponent' &&
				events.get(key)!.size === 1;
			const value = (minimize ? Math.min : Math.max)(...outcomes.map(o => o.value));
			bounded.push({ ...representative, weight: mass, value, entries: [] });
		}
	}
	return aggregateLeaves(bounded);
}

/** Race continuations by proven upper bounds. A fully evaluated common action is
 * an executable lower bound; unresolved actions may only win within their upper bound.
 */
function resolveContinuations(
	search: Search, group: Branch[], pruning: boolean, reject: (upper: number[]) => boolean
): number[] | undefined {
	const alternatives = new Map<string, SearchAction>();
	for (const branch of group) for (const action of search.choices(branch.state, 'self')) {
		alternatives.set(action.id, action);
	}
	const options = [...alternatives.values()].map((action, rank) => ({
		action, rank, upper: Infinity, uppers: group.map(() => Infinity),
		works: undefined as Continuation[] | undefined, done: false,
	}));
	if (pruning) options.sort((a, b) =>
		search.expansionCost(group[0].state, 'self', a.action) - search.expansionCost(group[0].state, 'self', b.action) ||
		b.action.prior - a.action.prior || a.rank - b.rank);
	let best = -Infinity, bestRank = Infinity, chosen: number[] | undefined;
	while (true) {
		let next: typeof options[number] | undefined;
		for (const option of options) {
			if (option.done) continue;
			if (pruning && option.upper < best - 1e-9) {
				option.done = true; search.cutoffs.actions++; continue;
			}
			if (!next || pruning && option.upper > next.upper) next = option;
		}
		if (!next) return chosen;
		const works = next.works ||= group.map(b => search.continuation(b.state, next.action, pruning));
		// Keep all hidden worlds represented. Each response includes its complete chance outcomes.
		for (const work of works) if (!work.leaves) search.advanceContinuation(work);
		next.uppers = works.map(w => w.upper);
		next.upper = optimisticValue(group.map((b, i) => ({ ...b, value: next.uppers[i] })));
		if (works.every(w => w.leaves)) {
			const values = resolveEntries(works.map(w => w.leaves!), estimates => aggregate(group.flatMap((branch, i) =>
				estimates[i] === undefined ? [] : [{ ...branch, value: estimates[i] }])));
			const value = aggregate(group.map((branch, i) => ({ ...branch, value: values[i] })));
			next.done = true;
			if (value > best || value === best && next.rank < bestRank) {
				best = value; bestRank = next.rank; chosen = values;
			}
		}
		// Even before a common continuation is settled, allow a different action in each
		// world for the root upper bound. Keep bounds of locally rejected actions too:
		// losing on average does not imply losing in every individual hidden world.
		if (pruning && reject(group.map((_, i) => Math.max(...options.map(o => o.uppers[i]))))) return undefined;
	}
}

function runSearch(
	state: BattleState, evaluator: HardEvaluation, actions: SearchAction[], ownPP: Map<string, number>,
	matchups = new MatchupEvaluator(), replacing = false, options: SearchOptions = {}
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
	const entries = replacing ? new Set(search.entryChoices(root, 'self', 'free').map(identity)) : undefined;
	const candidates = entries ? actions.filter(a => a.switchTo && entries.has(identity(a.switchTo))) :
		search.choices(root, 'self', actions);
	const order = new Map(candidates.map((action, index) => [action.id, index]));
	const roots = candidates.filter(a => a.id !== 'pass').map(action => ({
		action, branches: search.branches(root, action, replacing), value: -Infinity, upperBound: false,
	}));
	const pruning = options.prune !== false;
	// All actions receive a shallow evaluation. Cheap candidates establish an exact
	// incumbent before expensive replacement trees; heuristic values only order work.
	if (pruning) roots.sort((a, b) => a.branches.length - b.branches.length ||
		aggregate(b.branches) - aggregate(a.branches) || order.get(a.action.id)! - order.get(b.action.id)!);
	let incumbent = -Infinity;
	for (const candidate of roots) {
		const groups = new Map<string, Branch[]>();
		const bounds = new Map<Branch, number>();
		for (const branch of candidate.branches) {
			bounds.set(branch, Math.abs(branch.value) >= 10000 ? branch.value : Infinity);
			if (Math.abs(branch.value) >= 10000) continue;
			const key = observationKey(branch.state);
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(branch);
		}
		const pending = [...groups.values()];
		if (pruning) pending.sort((a, b) => aggregate(a) - aggregate(b));
		for (const group of pending) {
			const chosen = resolveContinuations(search, group, pruning, upper => {
				group.forEach((branch, i) => bounds.set(branch, upper[i]));
				const value = optimisticValue(candidate.branches.map(b => ({ ...b, value: bounds.get(b)! })));
				if (!(value < incumbent - 1e-9)) return false;
				candidate.upperBound = true; candidate.value = value;
				search.cutoffs.roots++; return true;
			});
			if (candidate.upperBound) break;
			if (chosen) group.forEach((branch, i) => { branch.value = chosen[i]; bounds.set(branch, chosen[i]); });
			const upper = optimisticValue(candidate.branches.map(b => ({ ...b, value: bounds.get(b)! })));
			if (pruning && [...bounds.values()].some(value => value === Infinity) && upper < incumbent - 1e-9) {
				candidate.upperBound = true; candidate.value = upper; search.cutoffs.roots++; break;
			}
		}
		if (!candidate.upperBound) candidate.value = aggregate(candidate.branches);
		incumbent = Math.max(incumbent, candidate.value);
	}
	const initial = search.value(root);
	const values = roots.map(c => ({ id: c.action.id, value: c.value - initial,
		...(c.upperBound ? { upperBound: true } : {}) }))
		.sort((a, b) => b.value - a.value || order.get(a.id)! - order.get(b.id)!);
	if (!values.length || !Number.isFinite(values[0].value)) {
		return { reason: 'no resolved action', values: [], nodes: search.nodes };
	}
	return { choice: values[0].id, values, nodes: search.nodes,
		reason: `${replacing ? 'Replacement search' : 'Two-turn search'} (${search.nodes} nodes, damage-only): ${values.map(v => `${v.id}${v.upperBound ? '<=' : '='}${v.value.toFixed(1)}`).join(', ')}` +
			`; Pruned invalid=${search.pruned.invalid}, score-gap=${search.pruned.scores}, switch-purpose=${search.pruned.switches}, entry-purpose=${search.pruned.entries}` +
			`; Reused choices=${search.reused.choices}, continuation=${search.reused.continuations}` +
			`; Bound cutoffs actions=${search.cutoffs.actions}, roots=${search.cutoffs.roots}` };
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
