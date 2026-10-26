/** Two-ply action search over AI knowledge snapshots; no simulator or complete-team samples. */
import type { BattleState, OpponentModel } from '../cfru/types';
import type { HardEvaluation } from './evaluation';
import { MatchupEvaluator } from './matchups';
import { rulesDex } from '../cfru/util/mechanics';
import { CandidateSelector, observationKey, perspective } from './candidates';
import {
	actionOutcomes, beginTurn, continueTurn, bindOpponent, clonePosition, endTurn, identity, modelsFor, positionKey,
	supportsMove, switchIn, transitionSupported, snapshotPosition, clonePokemon,
	type SearchAction, type Side, type TurnCheckpoint,
} from './projection';
export type { SearchAction } from './projection';

export interface SearchResult {
	choice?: string;
	reason: string;
	values: { id: string, value: number, upperBound?: boolean, lowerBound?: boolean, upperValue?: number }[];
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
interface TransitionNode {
	checkpoint?: Omit<EntryDecision, 'choice'>;
	weight: number;
	entries: EntryDecision[];
	state?: BattleState;
	/** A checkpoint owns its state; children clone it only when visited. */
	expand?: () => TransitionNode[];
}
interface ResponseWork {
	response: Response;
	frontier: { node: TransitionNode, branch?: Branch }[];
	cursor: number;
	branches?: Branch[];
	upper?: { independent: ReadonlySet<string>, value: number };
}
interface Continuation {
	action: SearchAction;
	responses: Response[];
	pending: Response[];
	completed: Map<Response, Leaf[]>;
	expansions: Map<Response, ResponseWork>;
	upper: number;
	configs: Map<number, { weight: number, upper: number }>;
	leaves?: Leaf[];
}
export interface SearchOptions {
	/** Reference mode evaluates the same candidate tree without bound cutoffs or work reordering. */
	prune?: boolean;
}

/** A draw is terminal too; its zero value must not be mistaken for an unresolved position. */
function terminalValue(state: BattleState): number | undefined {
	const self = state.self.team.some(p => !p.fainted && p.hp > 0);
	const foe = state.opponent.team.some(p => !p.fainted && p.hp > 0);
	if (!self || !foe) return self ? 10000 : foe ? -10000 : 0;
}

/** Terminal values dominate finite positional heuristics. */
export function positionValue(state: BattleState, matchups = new MatchupEvaluator()): number {
	return terminalValue(state) ?? matchups.assess(state).value;
}

class UnsupportedTransition extends Error {
	readonly nodes: number;
	constructor(move: string, nodes: number) { super(`transition unavailable: ${move}`); this.nodes = nodes; }
}

export class Search extends CandidateSelector {
	nodes = 0;
	override reused = { choices: 0, continuations: 0, responses: 0 };
	private values = new Map<string, number>();
	private continuations = new Map<string, Continuation>();
	private responseCache = new Map<string, Response[]>();
	readonly cutoffs = { actions: 0, roots: 0 };

	value(state: BattleState): number {
		const key = positionKey(state);
		const found = this.values.get(key); if (found !== undefined) return found;
		const value = terminalValue(state) ?? (this.assessments.get(key) || this.matchups.assess(state)).value;
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
		const configs = new Map(responses.map(r => [r.config, { weight: r.profile.weight, upper: Infinity }]));
		const work: Continuation = { action, responses, pending, configs, completed: new Map(),
			expansions: new Map(), upper: Infinity };
		this.continuations.set(key, work); return work;
	}

	/** Discover the first checkpoint, but do not visit recipient/configuration children. */
	prepareContinuation(work: Continuation): void {
		for (const response of work.responses) this.prepareResponse(work, response);
	}

	prepareResponse(work: Continuation, response: Response): ResponseWork {
		let expansion = work.expansions.get(response);
		if (!expansion) work.expansions.set(response, expansion = this.responseWork(response, work.action));
		return expansion;
	}

	continuationUpper(work: Continuation, independent: ReadonlySet<string>): number {
		const configs = new Map<number, { weight: number, upper: number }>();
		for (const response of work.responses) {
			let config = configs.get(response.config);
			if (!config) configs.set(response.config, config = { weight: response.profile.weight, upper: Infinity });
			const expansion = work.expansions.get(response);
			if (expansion) {
				if (expansion.upper?.independent !== independent) expansion.upper = { independent,
					value: entryBound(this.responseBounds(expansion), true, entry => independent.has(entry.key)) };
				config.upper = Math.min(config.upper, expansion.upper.value);
			}
		}
		const mass = [...configs.values()].reduce((n, c) => n + c.weight, 0);
		return mass ? [...configs.values()].filter(c => c.weight > 0)
			.reduce((n, c) => n + c.weight * c.upper, 0) / mass : Infinity;
	}

	advanceContinuation(work: Continuation, independent?: ReadonlySet<string>): void {
		const response = work.pending[0];
		if (response) {
			const expansion = this.prepareResponse(work, response);
			const interruptible = independent && expansion.frontier.some(({ node }) =>
				[...node.entries, ...(node.checkpoint ? [node.checkpoint] : [])]
					.some(entry => entry.side === 'opponent' && independent.has(entry.key)));
			const before = interruptible ? this.continuationUpper(work, independent) : Infinity;
			do {
				this.advanceResponse(expansion);
				// Yield only useful bound progress, not each hidden-profile leaf.
				if (interruptible && this.continuationUpper(work, independent) < before - 1e-9) break;
			} while (!expansion.branches);
			if (expansion.branches) {
				work.pending.shift();
				const leaves = expansion.branches.map(({ state: _state, ...leaf }) => leaf);
				work.completed.set(response, leaves);
				if (leaves.length) {
					const config = work.configs.get(response.config)!;
					config.upper = Math.min(config.upper, optimisticValue(leaves, false));
				}
			}
		}
		const mass = [...work.configs.values()].reduce((n, c) => n + c.weight, 0);
		work.upper = mass ? [...work.configs.values()].filter(c => c.weight > 0)
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
	private transitionTree(start: BattleState, own: SearchAction, reply: SearchAction, replacing: boolean):
	TransitionNode[] {
		const walk = (state: BattleState, turn: TurnCheckpoint | undefined, history: string[],
			weight: number, entries: EntryDecision[]): TransitionNode[] => {
			let pending: { side: Side, cause: 'pivot' | 'phaze' | 'faint' } | undefined;
			if (turn) {
				const completed = continueTurn(turn, this.matchups.damagePolicy, this.matchups.damageCache);
				state = turn.state;
				if (!completed) pending = turn.pending;
			}
			if (!pending && [state.self, state.opponent].every(party => party.team.some(p => !p.fainted && p.hp > 0))) {
				const side = (['self', 'opponent'] as const).find(s => state[s].active[0]?.fainted);
				if (side) pending = { side, cause: 'faint' };
			}
			if (!pending) return [{ state: snapshotPosition(state), weight, entries }];
			const { side, cause } = pending;
			const key = JSON.stringify([side, cause, history, observationKey(perspective(state, side))]);
			return [{ weight, entries,
				checkpoint: cause === 'phaze' ? undefined : { key, side, depth: history.length },
				expand: () => {
					const legal = state[side].reserve.filter(p => !p.fainted && p.hp > 0);
					const exposed = turn?.remaining.some(a => a.side !== side &&
						!state[a.side].active[0]?.fainted && a.actor === identity(state[a.side].active[0]));
					const options = cause === 'phaze' ? legal : this.entryChoices(state, side, exposed ? 'exposed' : 'free');
					this.pruned.entries += legal.length - options.length;
					return options.flatMap(pokemon => {
						const profiles = side === 'opponent' ? modelsFor(pokemon) : [undefined];
						const decision = { key, side, choice: identity(pokemon), depth: history.length };
						const nextEntries = cause === 'phaze' ? entries : [...entries, decision];
						return profiles.map(model => ({
							weight: weight * (model?.weight ?? 1) / (cause === 'phaze' ? options.length : 1), entries: nextEntries,
							expand: () => {
								const next = clonePosition(state);
								if (model) bindOpponent(next, pokemon, model);
								switchIn(next, side, pokemon);
								return walk(next, cause === 'faint' ? undefined : { ...turn!, state: next, remaining: [...turn!.remaining] },
									[...history, identity(pokemon)], weight * (model?.weight ?? 1) /
									(cause === 'phaze' ? options.length : 1), nextEntries);
							},
						}));
					});
				},
			}];
		};
		if (!replacing) {
			const turn = beginTurn(start, own, reply);
			return walk(turn.state, turn, [], 1, []);
		}
		const next = clonePosition(start); switchIn(next, 'self', own.switchTo!);
		if (!start.self.active[0].fainted) endTurn(next, this.matchups.damagePolicy, this.matchups.damageCache);
		return walk(next, undefined, [], 1, []);
	}

	transitions(start: BattleState, own: SearchAction, reply: SearchAction, replacing: boolean):
	{ state: BattleState, weight: number, entries: EntryDecision[] }[] {
		const finish = (node: TransitionNode): ReturnType<Search['transitions']> => node.expand ?
			node.expand().flatMap(finish) : [{ state: node.state!, weight: node.weight, entries: node.entries }];
		return this.transitionTree(start, own, reply, replacing).flatMap(finish);
	}

	responses(state: BattleState, replacing = false): Response[] {
		const key = `${positionKey(state)}:${replacing}`, cached = this.responseCache.get(key);
		if (cached) { this.reused.responses++; return cached; }
		const active = state.opponent.active[0];
		const profiles = active.fainted ?
			[{ name: 'fainted', pokemon: active, moves: [], weight: 1, matched: true }] : modelsFor(active);
		const responses = profiles.flatMap((profile, config) => {
			const bound = clonePosition(state); bindOpponent(bound, active, profile);
			snapshotPosition(bound);
			const replies = replacing ? [{ id: 'pass', prior: 0 }] : this.choices(bound, 'opponent');
			return replies.map(action => ({ config, profile, state: bound, action }));
		});
		this.responseCache.set(key, responses); return responses;
	}

	private responseWork(response: Response, own: SearchAction, replacing = false): ResponseWork {
		const { profile, state: bound, action: reply } = response;
		const frontier: ResponseWork['frontier'] = [];
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
					const mass = (target?.weight ?? 1) * a.weight * b.weight;
					const weighted = (node: TransitionNode): TransitionNode => ({ ...node, weight: node.weight * mass,
						expand: node.expand && (() => node.expand!().map(weighted)) });
					frontier.push(...this.transitionTree(start, a.action, b.action, replacing)
						.map(node => ({ node: weighted(node) })));
				}
			}
		}
		return { response, frontier, cursor: 0 };
	}

	private responseBounds(work: ResponseWork): Leaf[] {
		const { config, profile, action } = work.response;
		return work.frontier.map(({ node, branch }) => branch || { config, configWeight: profile.weight,
			reply: action.id, weight: node.weight, entries: node.entries, value: Infinity });
	}

	private advanceResponse(work: ResponseWork): void {
		work.upper = undefined;
		const index = work.cursor;
		while (index < work.frontier.length) {
			const { node } = work.frontier[index];
			if (node.expand) {
				work.frontier.splice(index, 1, ...node.expand().map(child => ({ node: child })));
				continue;
			}
			const { config, profile, action } = work.response;
			this.nodes++;
			work.frontier[index].branch = { state: node.state!, config, configWeight: profile.weight,
				reply: action.id, weight: node.weight, entries: node.entries, value: this.value(node.state!) };
			work.cursor++;
			break;
		}
		if (work.cursor === work.frontier.length) work.branches = work.frontier.map(entry => entry.branch!);
	}

	/** Full reference and first-ply expansion drain the same resumable checkpoint tree. */
	expandResponse(response: Response, own: SearchAction, replacing = false): Branch[] {
		const work = this.responseWork(response, own, replacing);
		while (!work.branches) this.advanceResponse(work);
		return work.branches;
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
 * knowledge of the hidden world. Descendants collapse before their ancestors; an
 * incomplete information set retains the conservative leaf envelope.
 */
export function optimisticValue(branches: Leaf[], independentOpponent = true): number {
	return entryBound(branches, true, independentOpponent);
}

/** Relax every entry to the worse recipient for a lower bound; never invent a hidden-world policy. */
export function pessimisticValue(branches: Leaf[]): number {
	return entryBound(branches, false, false);
}

function entryBound(branches: Leaf[], upper: boolean,
	independentOpponent: boolean | ((entry: EntryDecision) => boolean)): number {
	if (!branches.some(b => b.entries.length)) return aggregateLeaves(branches);
	const envelope = () => (upper ? Math.max : Math.min)(...branches.map(b => b.value));
	let remaining = branches.filter(b => b.weight > 0);
	const events = new Map<string, EntryDecision>();
	for (const branch of remaining) for (const entry of branch.entries) events.set(entry.key, entry);
	// Collapse descendants first. Each collapsed choice keeps its original chance mass
	// and ancestor path, so consecutive entries never become a flat best/worst leaf.
	for (const event of [...events.values()].sort((a, b) => b.depth - a.depth)) {
		const members = remaining.filter(b => b.entries.some(e => e.key === event.key));
		const cells = new Map<string, Map<string, Leaf[]>>();
		for (const branch of members) {
			const cell = JSON.stringify([branch.config, branch.reply]);
			if (!cells.has(cell)) cells.set(cell, new Map());
			const choices = cells.get(cell)!;
			const choice = branch.entries.find(e => e.key === event.key)!.choice;
			if (!choices.has(choice)) choices.set(choice, []);
			choices.get(choice)!.push(branch);
		}
		const options = [...cells.values()];
		if (!options.length) continue;
		if (options.some(choices => choices.size !== options[0].size ||
			[...choices.keys()].some(choice => !options[0].has(choice)))) return envelope();
		const collapsed: Leaf[] = [];
		for (const choices of options) {
			const outcomes = [...choices.values()].map(leaves => ({ leaves,
				mass: leaves.reduce((n, b) => n + b.weight, 0), value: aggregateLeaves(leaves) }));
			const mass = outcomes[0].mass;
			if (!(mass > 0) || outcomes.some(o => Math.abs(o.mass - mass) > 1e-9 * mass)) return envelope();
			const independent = typeof independentOpponent === 'function' ? independentOpponent(event) : independentOpponent;
			const minimize = !upper || independent && event.side === 'opponent' && cells.size === 1;
			const value = (minimize ? Math.min : Math.max)(...outcomes.map(o => o.value));
			const representative = outcomes[0].leaves[0];
			collapsed.push({ ...representative, weight: mass, value,
				entries: representative.entries.filter(e => e.key !== event.key) });
		}
		const removed = new Set(members);
		remaining = [...remaining.filter(b => !removed.has(b)), ...collapsed];
	}
	return aggregateLeaves(remaining);
}

/** Only first checkpoints have complete membership before their descendants are visited.
 * An opponent entry may minimize independently only when no other hidden world/response
 * shares it. Later checkpoints keep the shared-information relaxation until completed.
 */
function independentEntries(search: Search, works: Continuation[]): Set<string> | undefined {
	// Ordinary responses need no replacement independence audit. Discover the other
	// responses only when the next work can actually yield an opposing-entry bound.
	const hasOpponentEntry = works.some(work => {
		const response = work.pending[0];
		return response && search.prepareResponse(work, response).frontier.some(({ node }) =>
			[...node.entries, ...(node.checkpoint ? [node.checkpoint] : [])]
				.some(entry => entry.depth === 0 && entry.side === 'opponent'));
	});
	if (!hasOpponentEntry) return undefined;
	const owners = new Map<string, Set<string>>();
	works.forEach((work, i) => {
		search.prepareContinuation(work);
		for (const [response, expansion] of work.expansions) {
			for (const { node } of expansion.frontier) for (const entry of
				[...node.entries, ...(node.checkpoint ? [node.checkpoint] : [])]) {
				if (entry.depth !== 0) continue;
				if (!owners.has(entry.key)) owners.set(entry.key, new Set());
				owners.get(entry.key)!.add(`${i}:${response.config}:${response.action.id}`);
			}
		}
	});
	return new Set([...owners].filter(([, cells]) => cells.size === 1).map(([key]) => key));
}

/** Race continuations by proven upper bounds. A fully evaluated common action is
 * an executable lower bound; unresolved actions may only win within their upper bound.
 */
function* resolveContinuations(
	search: Search, group: Branch[], pruning: boolean
): Generator<{ upper: number[], lower: number[] }, number[] | undefined> {
	const alternatives = new Map<string, SearchAction>();
	for (const branch of group) for (const action of search.choices(branch.state, 'self')) {
		alternatives.set(action.id, action);
	}
	const options = [...alternatives.values()].map((action, rank) => ({
		action, rank, upper: Infinity, uppers: group.map(() => Infinity),
		works: undefined as Continuation[] | undefined, independent: undefined as Set<string> | undefined,
		done: false, rejected: false,
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
				option.done = true; option.rejected = true;
				search.cutoffs.actions++; continue;
			}
			if (!next || pruning && option.upper > next.upper) next = option;
		}
		if (!next) return chosen;
		const works = next.works ||= group.map(b => search.continuation(b.state, next.action, pruning));
		const independent = pruning ? next.independent ||= independentEntries(search, works) : undefined;
		// Keep all hidden worlds represented. Each response includes its complete chance outcomes.
		for (const work of works) if (!work.leaves) search.advanceContinuation(work, independent);
		next.uppers = works.map(w => independent ? search.continuationUpper(w, independent) : w.upper);
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
		const upper = group.map((_, i) => Math.max(...options.map(o => o.uppers[i])));
		// For one world, the best completed action is an executable scalar lower bound.
		// In shared information sets its component values need not improve together.
		// Envelope every still-possible winning action instead of copying the average
		// improvement into each hidden world. Completed losing actions cannot be selected.
		const contenders = options.filter(o => !o.done && !o.rejected && (!pruning || o.upper >= best - 1e-9));
		const lower = group.length === 1 ? [best] : group.map((_, i) => Math.min(
			chosen?.[i] ?? -Infinity,
			...contenders.map(o => o.works?.[i].leaves ? pessimisticValue(o.works[i].leaves) : -Infinity)));
		yield { upper, lower };
	}
}

function runSearch(
	state: BattleState, evaluator: HardEvaluation, actions: SearchAction[], ownPP: Map<string, number>,
	matchups = new MatchupEvaluator('mean', evaluator.damageCache), replacing = false, options: SearchOptions = {}
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
		root.opponent.team.push({ ...clonePokemon(p), active: false });
		root.opponent.reserve.push(root.opponent.team[root.opponent.team.length - 1]);
	}
	for (const p of root.opponent.team) {
		const original = [...state.opponent.team, ...(state.opponent.preview || [])].find(q => identity(p) === identity(q))!;
		if (!p.fainted) p.presetModels = [...evaluator.opponentModels(original)];
	}
	Object.assign(root.self.active[0], { projection: { pp: Object.fromEntries(ownPP) } });
	snapshotPosition(root);
	const search = new Search(matchups, root);
	const entries = replacing ? new Set(search.entryChoices(root, 'self', 'free').map(identity)) : undefined;
	const candidates = entries ? actions.filter(a => a.switchTo && entries.has(identity(a.switchTo))) :
		search.choices(root, 'self', actions);
	const order = new Map(candidates.map((action, index) => [action.id, index]));
	const pruning = options.prune !== false;
	const playable = candidates.filter(a => a.id !== 'pass');
	if (pruning && playable.length === 1) return { choice: playable[0].id, values: [], nodes: 0,
		reason: `${replacing ? 'Replacement search' : 'Two-turn search'} (0 nodes, damage-only): only retained action ${playable[0].id}; no value search needed` };
	const responses = search.responses(root, replacing);
	const roots = playable.map(action => {
		// An unresolved response retains its configuration mass. In particular, an
		// unvisited rare profile must not disappear from either bound.
		const branches: Branch[] = responses.map(r => ({ state: root, config: r.config,
			configWeight: r.profile.weight, reply: r.action.id, weight: 1, entries: [], value: 0 }));
		return { action, branches,
			lower: new Map(branches.map(b => [b, -Infinity])), upper: new Map(branches.map(b => [b, Infinity])),
			unexpanded: responses.map((response, i) => ({ response, placeholder: branches[i] })),
			lo: -Infinity, hi: Infinity, done: false, rejected: false,
			pending: [] as { group: Branch[], work: ReturnType<typeof resolveContinuations> }[] };
	});
	// Work ordering uses only existing action facts, never a new candidate restriction.
	if (pruning) roots.sort((a, b) => search.expansionCost(root, 'self', a.action) -
		search.expansionCost(root, 'self', b.action) || b.action.prior - a.action.prior ||
		order.get(a.action.id)! - order.get(b.action.id)!);
	const groupContinuations = (candidate: typeof roots[number]) => {
		const groups = new Map<string, Branch[]>();
		for (const branch of candidate.branches) {
			if (terminalValue(branch.state) !== undefined) continue;
			const key = observationKey(branch.state);
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(branch);
		}
		const pending = [...groups.values()];
		if (pruning) pending.sort((a, b) => aggregate(a) - aggregate(b));
		candidate.pending = pending.map(group => ({ group, work: resolveContinuations(search, group, pruning) }));
	};
	const refresh = (candidate: typeof roots[number]) => {
		candidate.done = !candidate.unexpanded.length && !candidate.pending.length;
		if (candidate.done) candidate.lo = candidate.hi = aggregate(candidate.branches);
		else {
			candidate.lo = pessimisticValue(candidate.branches.map(b => ({ ...b, value: candidate.lower.get(b)! })));
			candidate.hi = optimisticValue(candidate.branches.map(b => ({ ...b, value: candidate.upper.get(b)! })),
				!candidate.unexpanded.length);
		}
	};
	roots.forEach(refresh);
	let winner: typeof roots[number] | undefined;
	while (roots.length) {
		const leader = [...roots].sort((a, b) => b.lo - a.lo || order.get(a.action.id)! - order.get(b.action.id)!)[0];
		if (pruning && Number.isFinite(leader.lo) && roots.every(c => c === leader || c.hi < leader.lo - 1e-9) ||
			roots.every(c => c.done)) { winner = leader; break; }
		if (pruning) for (const candidate of roots) {
			if (!candidate.done && !candidate.rejected && candidate.hi < leader.lo - 1e-9) {
				candidate.rejected = true; search.cutoffs.roots++;
			}
		}
		const available = roots.filter(c => !c.done && !c.rejected);
		// Infinite bounds are visited first. Once finite, advance the root that could
		// still beat the leader by the most, without requiring an exact winner value.
		if (pruning) available.sort((a, b) => b.hi - a.hi);
		const candidate = available[0];
		if (!candidate) { winner = leader; break; }
		const expansion = candidate.unexpanded.shift();
		if (expansion) {
			const { response, placeholder } = expansion;
			const branches = search.expandResponse(response, candidate.action, replacing);
			candidate.branches.splice(candidate.branches.indexOf(placeholder), 1, ...branches);
			candidate.lower.delete(placeholder); candidate.upper.delete(placeholder);
			for (const branch of branches) {
				const terminal = terminalValue(branch.state) !== undefined;
				candidate.lower.set(branch, terminal ? branch.value : -Infinity);
				candidate.upper.set(branch, terminal ? branch.value : Infinity);
			}
			// Shared observation groups cannot be resolved until every member is known.
			if (!candidate.unexpanded.length) groupContinuations(candidate);
			refresh(candidate); continue;
		}
		const { group, work } = candidate.pending[0], next = work.next();
		if (next.done) {
			if (next.value) group.forEach((branch, i) => {
				branch.value = next.value![i];
				candidate.lower.set(branch, branch.value); candidate.upper.set(branch, branch.value);
			});
			candidate.pending.shift();
		} else group.forEach((branch, i) => {
			candidate.lower.set(branch, next.value.lower[i]); candidate.upper.set(branch, next.value.upper[i]);
		});
		refresh(candidate);
	}
	if (!winner || !Number.isFinite(winner.lo)) {
		return { reason: 'no resolved action', values: [], nodes: search.nodes };
	}
	const initial = search.value(root);
	const values: SearchResult['values'] = roots.map(c => ({ id: c.action.id, value: (c === winner ? c.lo : c.hi) - initial,
		...(!c.done ? c === winner ? { lowerBound: true, upperValue: c.hi - initial } : { upperBound: true } : {}) }))
		.sort((a, b) => Number(b.id === winner.action.id) - Number(a.id === winner.action.id) ||
			b.value - a.value || order.get(a.id)! - order.get(b.id)!);
	return { choice: values[0].id, values, nodes: search.nodes,
		reason: `${replacing ? 'Replacement search' : 'Two-turn search'} (${search.nodes} nodes, damage-only): ${values.map(v => `${v.id}${v.upperBound ? '<=' : v.lowerBound ? '>=' : '='}${v.value.toFixed(1)}`).join(', ')}` +
			`; Pruned invalid=${search.pruned.invalid}, score-gap=${search.pruned.scores}, switch-purpose=${search.pruned.switches}, entry-purpose=${search.pruned.entries}` +
			`; Reused choices=${search.reused.choices}, responses=${search.reused.responses}, continuation=${search.reused.continuations}` +
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
