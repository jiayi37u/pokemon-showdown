/** Bounded two-turn search. Every root action is compared on the same team-position scale. */
import { Battle } from '../../../../sim/battle';
import { PRNG } from '../../../../sim/prng';
import type { Pokemon } from '../../../../sim/pokemon';
import type { Side } from '../../../../sim/side';
import type { AIPokemon, BattleState, OpponentModel } from '../cfru/types';
import type { HardEvaluation } from './evaluation';
import { hardMove } from './opponent-model';
import { getExpectedHitCount } from '../cfru/util/damage-calc';
import { MatchupEvaluator } from './matchups';
import { completeMoves, projectBattle, projectedState, projectionUnsupported } from './projection';

export interface SearchAction {
	/** Controller choice, also stable across configuration hypotheses. */
	id: string;
	move?: string;
	mega?: boolean;
	switchTo?: AIPokemon;
	prior: number;
}

interface Branch { snapshot: string; weight: number; value: number }
export interface SearchResult {
	choice?: string;
	reason: string;
	values: { id: string, value: number }[];
	nodes: number;
}

function quantile<T extends { weight: number }>(models: readonly T[], fraction: number): T {
	let sum = 0;
	for (const model of models) {
		sum += model.weight;
		if (fraction < sum) return model;
	}
	return models[models.length - 1];
}

function encoded(action: SearchAction, party: AIPokemon[]): string {
	if (action.switchTo) return `switch ${party.findIndex(p => p === action.switchTo ||
		!!p.ident && p.ident === action.switchTo!.ident) + 1}`;
	return `move ${action.move}${action.mega ? ' mega' : ''}`;
}

/** Team roles are recomputed from cached pair relations in each hypothetical position. */
export function positionValue(battle: Battle, matchups = new MatchupEvaluator()): number {
	if (battle.ended) return battle.winner === battle.p1.name ? 10000 : battle.winner === battle.p2.name ? -10000 : 0;
	return matchups.assess(projectedState(battle)).value;
}

/** Ordering estimate only; move preparation can mutate its user, so run those hooks on a scratch battle. */
export function searchDamage(
	battle: Battle, actor: Pokemon, target: Pokemon, id: string, snapshot?: { value?: string }
): number {
	const base = battle.dex.moves.get(id);
	if (base.category === 'Status') return 0;
	let scratch: Battle | undefined;
	if (!actor.isActive || !target.isActive || base.onModifyMove || base.onModifyType ||
		'onTryHit' in target.getAbility() || 'onTryHit' in target.getItem() ||
		[actor.getAbility(), actor.getItem()].some(effect => 'onModifyMove' in effect || 'onModifyType' in effect) ||
		[...Object.keys(target.volatiles), ...Object.keys(target.side.sideConditions)].some(effect =>
			'onTryHit' in battle.dex.conditions.get(effect))) {
		const serialized = snapshot ? (snapshot.value ??= JSON.stringify(battle.toJSON())) : JSON.stringify(battle.toJSON());
		scratch = Battle.fromJSON(serialized);
		actor = scratch.sides[actor.side.n].pokemon[actor.position];
		target = scratch.sides[target.side.n].pokemon[target.position];
		battle = scratch;
		// Bench Pokemon ignore their items and abilities in PS. Rank their prospective active matchup.
		// Entry effects and hazards are resolved by advance(), not by this damage-only estimate.
		for (const pokemon of [actor, target]) {
			pokemon.side.active[0].isActive = false;
			pokemon.side.active[0] = pokemon;
			pokemon.isActive = true;
		}
	}
	const seed = battle.prng.getSeed();
	try {
		let move = battle.dex.getActiveMove(id);
		if (scratch) {
			battle.setActiveMove(move, actor, target);
			battle.singleEvent('ModifyType', move, null, actor, target, move, move);
			battle.singleEvent('ModifyMove', move, null, actor, target, move, move);
			move = battle.runEvent('ModifyType', actor, target, move, move);
			move = battle.runEvent('ModifyMove', actor, target, move, move);
			if (!move) return 0;
			if (!battle.runEvent('TryHit', target, actor, move)) return 0;
		}
		// A beam must not discard the reliable response because one ranking roll happened to crit.
		if (move.willCrit === undefined) move.willCrit = false;
		const hits = getExpectedHitCount({ ...hardMove(id, 1, battle.format.id), multihit: move.multihit || null },
			actor.getAbility().id, actor.getItem().id, actor.species.id);
		let total = 0;
		for (let hit = 1; hit <= Math.ceil(hits); hit++) {
			move.hit = hit;
			const result = battle.actions.getDamage(actor, target, move, true);
			total += (typeof result === 'number' ? result : 0) * Math.min(1, hits - hit + 1);
		}
		return total * (move.accuracy === true ? 1 : move.accuracy / 100);
	} finally {
		battle.prng = new PRNG(seed);
		scratch?.destroy();
	}
}

/** Beam ordering only. All selected continuations are resolved by the simulator. */
export function searchChoices(battle: Battle, side: Side, limit: number): string[] {
	const request = side.activeRequest;
	if (!request || request.wait) return ['pass'];
	const actor = side.active[0], foe = side.foe.active[0];
	const snapshot: { value?: string } = {};
	const options: { choice: string, rank: number }[] = [];
	if ('active' in request) {
		for (const [index, slot] of request.active[0].moves.entries()) {
			if (slot.disabled || actor.moveSlots[index]?.pp <= 0) continue;
			const move = battle.dex.moves.get(slot.id);
			let rank = 0;
			if (move.category !== 'Status') {
				const dealt = searchDamage(battle, actor, foe, move.id, snapshot);
				rank = Math.min(1, dealt / Math.max(1, foe.hp)) * 50 + (dealt >= foe.hp ? 40 : 0);
			} else if (move.heal || move.id === 'rest' || move.id === 'wish') {
				rank = 65 * Math.min(0.5, 1 - actor.hp / actor.maxhp);
			} else if (move.boosts && move.target === 'self') {
				rank = 23 * actor.hp / actor.maxhp;
			} else if (move.status && !foe.status) {
				rank = 20;
			} else if (move.sideCondition && !side.foe.sideConditions[move.sideCondition]) {
				rank = 15;
			}
			if (move.id === 'fakeout' && actor.activeMoveActions > 0) rank = -100;
			options.push({ choice: `move ${index + 1}${request.active[0].canMegaEvo ? ' mega' : ''}`, rank });
		}
	}
	if (!('active' in request) || !actor.trapped && !request.active[0].trapped) {
		for (const p of side.pokemon) {
			if (p.isActive || !p.hp || p.fainted) continue;
			const incoming = Math.max(0, ...foe.moveSlots.map(m => searchDamage(battle, foe, p, m.id, snapshot)));
			const outgoing = Math.max(0, ...p.moveSlots.map(m => searchDamage(battle, p, foe, m.id, snapshot)));
			options.push({ choice: `switch ${p.position + 1}`,
				rank: 30 * Math.min(1, outgoing / Math.max(1, foe.hp)) - 60 * incoming / Math.max(1, p.hp) });
		}
	}
	options.sort((a, b) => b.rank - a.rank);
	const selected = options.slice(0, limit);
	const retreat = options.find(o => o.choice.startsWith('switch'));
	// Keep retreat available after attacking: damage-only ordering can otherwise remove every escape.
	if (limit === 2 && retreat && !selected.includes(retreat)) selected.push(retreat);
	return selected.map(o => o.choice);
}

/** Resolve pivots and forced replacements before assessing a completed turn. */
function advance(snapshot: string, own: string, foe: string): Battle | null {
	const battle = Battle.fromJSON(snapshot);
	if (!battle.p1.choose(own) || !battle.p2.choose(foe)) { battle.destroy(); return null; }
	battle.commitChoices();
	for (let i = 0; i < 4 && !battle.ended && battle.requestState === 'switch'; i++) {
		const replacements = battle.sides.map(side => searchChoices(battle, side, 1)[0] || 'pass');
		if (battle.sides.some((side, index) => side.requestState && !side.choose(replacements[index]))) {
			battle.destroy(); return null;
		}
		battle.commitChoices();
	}
	if (!battle.ended && battle.requestState !== 'move') { battle.destroy(); return null; }
	return battle;
}

function conservative(values: { value: number, weight: number }[], risk = 0.15): number {
	const mass = values.reduce((n, v) => n + v.weight, 0);
	const average = values.reduce((n, v) => n + v.value * v.weight, 0) / mass;
	// Preserve a modest adverse-response allowance; do not pretend the predicted action is certain.
	return (1 - risk) * average + risk * Math.min(...values.map(v => v.value));
}

/** Continuations cannot choose different actions solely because a hidden set differs. */
function observationKey(battle: Battle): string {
	const visible = (p: Pokemon, own: boolean) => [p.species.id, own ? p.hp : Math.ceil(100 * p.hp / p.maxhp),
		p.status, p.isActive, p.boosts,
		Object.keys(p.volatiles).filter(id => ['substitute', 'taunt', 'encore', 'confusion', 'leechseed',
			'perishsong', 'torment', 'gastroacid', 'ingrain', 'aquaring'].includes(id)),
		own ? [p.item, p.moveSlots.map(m => [m.id, m.pp])] : undefined];
	return JSON.stringify([battle.p1.pokemon.map(p => visible(p, true)), battle.p2.pokemon.map(p => visible(p, false)),
		battle.log.filter(line => /^\|(?:move|-ability|-item|-enditem|-activate)\|/.test(line))]);
}

export function searchPosition(
	state: BattleState, evaluator: HardEvaluation, actions: SearchAction[], ownPP: Map<string, number>,
	matchups = new MatchupEvaluator()
): SearchResult {
	const unsupported = projectionUnsupported(state);
	if (unsupported) return { reason: unsupported, values: [], nodes: 0 };
	const current = state.opponent.active[0];
	const opponents = [current, ...state.opponent.reserve, ...(state.opponent.preview || [])].filter(p => !p.fainted);
	const models = opponents.map(p => evaluator.opponentModels(p));
	const predictions = evaluator.predictions(state.self.active[0]).get(current) || [];
	const branches = new Map(actions.map(a => [a.id, [] as Branch[]]));
	const roles = new Map<string, number>();
	const cacheBefore = { ...matchups.stats };
	let nodes = 0;
	for (let sample = 0; sample < 3; sample++) {
		const selected: OpponentModel[] = models.map((pool, index) => quantile(pool, ((sample + 0.5) / 3 + index / 7) % 1));
		const party = selected.map(model => ({ ...model.pokemon, moves: completeMoves(model, sample) }));
		const projection = projectBattle(state, party, sample, ownPP);
		if (!projection) return { reason: 'public stats cannot be represented by a coherent set', values: [], nodes };
		const battle = projection.battle;
		const legal = searchChoices(battle, battle.p2, 12);
		// A switch is one branch of the opponent's policy, not a fresh probability for every reserve.
		const destination = legal.find(choice => choice.startsWith('switch'));
		const responses = legal.filter(choice => !choice.startsWith('switch') || choice === destination).map(choice => {
			const index = Number(choice.split(' ')[1]) - 1;
			const isSwitch = choice.startsWith('switch');
			const id = battle.p2.active[0].moveSlots[index]?.id;
			const compatible = predictions.filter(p => p.user === selected[0].pokemon);
			const weight = (compatible.length ? compatible : predictions).filter(p =>
				isSwitch ? p.switching : !p.switching && (p.selectedMove || p.move)?.id === id).reduce((n, p) => n + p.weight, 0);
			return { choice, weight };
		}).sort((a, b) => b.weight - a.weight);
		const threat = legal.find(choice => choice.startsWith('move') &&
			battle.dex.moves.get(battle.p2.active[0].moveSlots[Number(choice.split(' ')[1]) - 1]?.id).category !== 'Status');
		const retained = responses.filter((r, i) => i < 2 || r.choice === threat);
		responses.splice(0, responses.length, ...retained);
		// Predictions are uncertain: keep the strongest available attack even when the prior rounds it to zero.
		const attack = responses.find(r => r.choice === threat);
		if (attack) attack.weight = Math.max(attack.weight, 0.15 * responses.reduce((n, r) => n + r.weight, 0));
		if (!responses.length) responses.push({ choice: 'move 1', weight: 1 });
		if (!responses.some(r => r.weight)) for (const response of responses) response.weight = 1;
		const mass = responses.reduce((n, r) => n + r.weight, 0);
		const snapshot = JSON.stringify(battle.toJSON());
		const initial = positionValue(battle, matchups);
		for (const role of matchups.roles(projectedState(battle))) {
			roles.set(role.pokemon, (roles.get(role.pokemon) || 0) + role.value / 3);
		}
		for (const action of actions) for (const response of responses.filter(r => r.weight > 0)) {
			const next = advance(snapshot, encoded(action, projection.self), response.choice);
			nodes++;
			if (!next) continue;
			branches.get(action.id)!.push({ snapshot: JSON.stringify(next.toJSON()), weight: response.weight / mass / 3,
				value: positionValue(next, matchups) - initial });
			next.destroy();
		}
		battle.destroy();
	}
	const viable = actions.filter(a => branches.get(a.id)!.reduce((n, b) => n + b.weight, 0) > 0.999);
	if (!viable.length) return { reason: 'no action valid across projected states', values: [], nodes };
	const oneTurn = new Map(viable.map(a => [a.id, conservative(branches.get(a.id)!)]));
	const beam = [...viable].sort((a, b) => oneTurn.get(b.id)! - oneTurn.get(a.id)!).slice(0, 3);
	// Keep the best heuristic action in the beam: setup/recovery can pay off beyond the first turn.
	const prior = [...viable].sort((a, b) => b.prior - a.prior)[0];
	if (!beam.includes(prior)) beam.push(prior);
	const values: SearchResult['values'] = [];
	for (const action of beam) {
		const groups = new Map<string, { branch: Branch, own: string[], foe: string[], before: number }[]>();
		const outcomes: { value: number, weight: number }[] = [];
		for (const branch of branches.get(action.id)!) {
			const start = Battle.fromJSON(branch.snapshot);
			if (start.ended) {
				start.destroy(); outcomes.push(branch); continue;
			}
			const own = searchChoices(start, start.p1, 2), foe = searchChoices(start, start.p2, 2);
			const before = positionValue(start, matchups);
			const key = observationKey(start);
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push({ branch, own, foe, before });
			start.destroy();
		}
		for (const group of groups.values()) {
			let best = -Infinity;
			const options = [...new Set(group.flatMap(g => g.own))];
			for (const move of options) {
				const results: { value: number, weight: number }[] = [];
				for (const { branch, foe, before } of group) {
					const responses = [];
					for (const response of foe) {
						const next = advance(branch.snapshot, move, response);
						nodes++;
						if (!next) continue;
						responses.push({ value: positionValue(next, matchups) - before, weight: 1 });
						next.destroy();
					}
					// The opponent can choose its best reply; a weak reply is not a free 50% escape chance.
					if (responses.length) results.push({ value: branch.value + conservative(responses, 1), weight: branch.weight });
				}
				if (results.length === group.length) best = Math.max(best, conservative(results));
			}
			if (!Number.isFinite(best)) return { reason: 'continuation could not be resolved', values: [], nodes };
			outcomes.push({ value: best, weight: group.reduce((n, g) => n + g.branch.weight, 0) });
		}
		values.push({ id: action.id, value: conservative(outcomes) + 0.005 * action.prior });
	}
	values.sort((a, b) => b.value - a.value);
	return { choice: values[0].id, values, nodes,
		reason: `Two-turn search (${nodes} nodes): ${values.map(v => `${v.id}=${v.value.toFixed(1)}`).join(', ')}` +
			`; Team roles: ${[...roles].map(([name, value]) => `${name}=${value.toFixed(1)}`).join(', ')}` +
			`; Matchup cache: ${matchups.stats.hits - cacheBefore.hits} reused, ${matchups.stats.misses - cacheBefore.misses} computed` };
}
