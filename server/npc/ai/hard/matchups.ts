/** Singles team value from replaceable checks, switch-ins and offensive routes.
 * Ratings are bounded estimates, not proofs of a counter or calibrated win probabilities.
 * Inputs are knowledge snapshots (or disposable search hypotheses), never a live opponent team.
 */
import type { AIPokemon, AIMove, BattleState, FieldConditions, SideConditions, AICache } from '../cfru/types';
import { createCache } from '../cfru/util/cache';
import { hardMove, hardMoveId } from './opponent-model';
import { getEffectiveHpAfterSecondary } from '../cfru/util/damage-calc';
import { calculateDamage, selectDamage, type DamagePolicy } from './damage';
import { modelsFor, knownMoves, clonePosition, settleFutureAttacks } from './projection';
import { compareActionOrder } from '../cfru/util/speed';
import { directRecoveryAmount, entryHazardDamage } from '../cfru/util/turn-outcome';
import { effectiveAbility, effectiveItem, fieldWithActivePokemon, grounded, rulesDex } from '../cfru/util/mechanics';
import { mustSkipMove, statusFailure, moveSelectionFailure } from '../cfru/util/move-effects';

export interface Matchup {
	/** Ability to win after a free entry, and after conceding an entry action. */
	check: number;
	counter: number;
	/** Useful offensive progress even when the user cannot win the exchange. */
	pressure: number;
	/** Damage a particular move threatens into a switch, independent of revenge-kill speed. */
	switchPressure: Record<string, number>;
	/** Capacity to repeat the defensive assignment. */
	sustain: number;
}
interface Pair { self: Matchup; opponent: Matchup }
interface PairState extends BattleState {
	calculations: AICache; damagePolicy?: DamagePolicy;
	damageMemo: Map<AIPokemon, Map<AIPokemon, Map<string, number>>>;
}
const zero = (): Matchup => ({ check: 0, counter: 0, pressure: 0, switchPressure: {}, sustain: 0 });
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const hp = (p: AIPokemon, value: number): AIPokemon => ({ ...p, hp: Math.max(0, value),
	hpPercent: 100 * Math.max(0, value) / p.maxHp });
const moveData = new Map<string, AIMove>();

/** A value key, not an object/slot key: simulated branches cannot overwrite the real position.
 * Knowledge metadata does not affect a concrete hypothesis; its resolved stats/moves do.
 */
function fingerprint(p: AIPokemon): string {
	return JSON.stringify([p.species, p.level, p.hp, p.maxHp, p.types, p.status, p.ability, p.item,
		p.itemLost, p.itemKnown, p.itemAssumed, p.baseStats, p.boosts, [...p.volatiles].sort(), p.moves,
		p.lastMove, p.active, p.activeMoveActions, p.sleepTurns, p.toxicCounter, p.sleepSelfInflicted,
		p.queuedSpeed, p.queuedPriorityAbility, p.abilityStatMod, p.terastallized]);
}

function moves(p: AIPokemon, field: FieldConditions): AIMove[] {
	return p.moves.map(id => {
		const key = `${field.formatId}:${id}`;
		let move = moveData.get(key);
		if (!move) {
			move = hardMove(id, 1, field.formatId || '');
			if (moveData.size >= 2048) moveData.clear();
			moveData.set(key, move);
		}
		return move;
	}).filter(move =>
		!(move.id === 'fakeout' && p.activeMoveActions) &&
		!moveSelectionFailure(p, hardMoveId(move), field));
}

/** Entry HP is charged once. Actual turn resolution remains the PS simulator's responsibility. */
function entered(p: AIPokemon, side: SideConditions, field: FieldConditions): AIPokemon {
	if (p.active || p.fainted) return p;
	const entrant = side.healingWish ? { ...hp(p, p.maxHp), status: '', sleepTurns: 0, toxicCounter: 0 } : p;
	let result = hp(entrant, entrant.hp - entryHazardDamage(entrant, side, field));
	if (grounded(result, field) && effectiveItem(result, field) !== 'heavydutyboots') {
		if (side.stickyweb) {
			const change = effectiveAbility(result, field) === 'contrary' ? 1 : -1;
			result = { ...result, boosts: { ...result.boosts, spe: Math.max(-6, Math.min(6, result.boosts.spe + change)) } };
		}
		if (side.toxicspikes && !result.status && !result.types.includes('Poison') &&
			rulesDex(field).getImmunity('psn', result.types) && effectiveAbility(result, field) !== 'immunity') {
			result = { ...result, status: side.toxicspikes > 1 ? 'tox' : 'psn', toxicCounter: 0 };
		}
	}
	return result;
}

function damage(actor: AIPokemon, target: AIPokemon, move: AIMove, state: PairState): number {
	let targets = state.damageMemo.get(actor);
	if (!targets) state.damageMemo.set(actor, targets = new Map());
	let results = targets.get(target);
	if (!results) targets.set(target, results = new Map());
	const cached = results.get(hardMoveId(move)); if (cached !== undefined) return cached;
	const value = selectDamage(calculateDamage(actor, target, move, state.field, state.calculations, {
		isDoubles: false, numAliveTargets: 1,
		attackerSideConditions: state.self.conditions, defenderSideConditions: state.opponent.conditions,
		activePokemon: [actor, target], defenderAllies: [target],
	}), state.damagePolicy);
	results.set(hardMoveId(move), value); return value;
}

function reverse<T extends BattleState>(state: T): T {
	return { ...state, self: state.opponent, opponent: state.self };
}

function recovery(p: AIPokemon, state: BattleState): number {
	if (p.volatiles.has('healblock') || mustSkipMove(p, p.moves, state.field)) return 0;
	return Math.max(0, ...moves(p, state.field).map(move => {
		// Rest/Wish spend additional turns; do not call them repeatable one-turn recovery.
		if (move.id === 'rest') return directRecoveryAmount(p, move, state.field) / 3;
		if (move.id === 'wish') return p.maxHp / 4;
		return directRecoveryAmount(p, move, state.field);
	}));
}

/** Remaining missed actions; sleep-usable and thawing attacks retain their own timing. */
function actionDelay(p: AIPokemon, field: FieldConditions, move?: AIMove): number {
	if (p.volatiles.has('mustrecharge')) return 1;
	const data = move && rulesDex(field).moves.get(move.id);
	if (p.status === 'slp' && !data?.sleepUsable) {
		const decrement = effectiveAbility(p, field) === 'earlybird' ? 2 : 1;
		return p.sleepTurns ? Math.max(0, Math.ceil(p.sleepTurns / decrement) - 1) : 1;
	}
	if (p.status === 'frz' && !data?.flags.defrost) return 2;
	return data?.flags.futuremove ? 2 :
		data?.flags.charge && !(move?.id === 'solarbeam' && field.weather === 'sun') ? 1 : 0;
}

/** The same residual route exists before and after inflicting status. Recovery can stall
 * ordinary poison/burn, but escalating Toxic eventually exceeds repeatable recovery.
 */
function attrition(target: AIPokemon, state: BattleState): boolean {
	if (!['tox', 'psn', 'brn'].includes(target.status)) return false;
	if (moves(target, state.field).some(m => ['rest', 'refresh', 'healbell', 'aromatherapy'].includes(m.id))) return false;
	if (['shedskin', 'naturalcure'].includes(effectiveAbility(target, state.field)) ||
		effectiveAbility(target, state.field) === 'hydration' && state.field.weather === 'rain' ||
		effectiveItem(target, state.field) === 'lumberry') return false;
	const later = { ...hp(target, target.maxHp), toxicCounter: target.status === 'tox' ? 14 : target.toxicCounter };
	const loss = later.hp - getEffectiveHpAfterSecondary(later, state.field.weather, '', state.field);
	return loss > recovery(target, state);
}

/** Attack race plus sustainable recovery. The two-turn search handles exact move effects;
 * this estimates the remaining assignment beyond its horizon using shared mechanics.
 */
function outlook(actor: AIPokemon, target: AIPokemon, state: PairState): Matchup {
	if (actor.hp <= 0 || target.hp <= 0 || actor.fainted || target.fainted) return zero();
	const theirs = reverse(state);
	const attacks = moves(actor, state.field).filter(m => m.category !== 'Status');
	const responses = moves(target, state.field).filter(m => m.category !== 'Status');
	const incoming = responses.map(move => ({ move, amount: damage(target, actor, move, theirs) }));
	const worst = Math.max(0, ...incoming.map(r => r.amount));
	const residual = Math.max(0, actor.hp - getEffectiveHpAfterSecondary(actor, state.field.weather,
		effectiveAbility(target, state.field), state.field));
	const targetResidual = target.hp - getEffectiveHpAfterSecondary(target, state.field.weather,
		effectiveAbility(actor, state.field), state.field);
	const healing = recovery(actor, state), targetHealing = recovery(target, theirs);
	const delay = actionDelay(actor, state.field);
	const stable = healing > worst + residual && actor.hp > worst * 2 && !delay;
	let check = 0, pressure = 0;
	const switchPressure: Record<string, number> = {};
	for (const move of attacks) {
		if (move.id === 'focuspunch' && !actor.volatiles.has('substitute') && target.status !== 'slp') continue;
		const dealt = damage(actor, target, move, state);
		if (!dealt) continue;
		const accuracy = 1;
		const turns = Math.min(8, Math.ceil(target.hp / Math.max(1, dealt + targetResidual)));
		let race = 1, opportunity = 1;
		for (const response of incoming) {
			const first = (compareActionOrder(actor, target, move, [response.move], state.field,
				state.self.conditions, state.opponent.conditions) + 1) / 2;
			const ownDelay = actionDelay(actor, state.field, move);
			const foeDelay = actionDelay(target, state.field, response.move);
			const before = Math.max(0, turns - first + ownDelay - foeDelay) * response.amount +
				Math.max(0, turns - 1 + ownDelay) * residual;
			race = Math.min(race, actor.hp > before ? 1 : 0);
			opportunity = Math.min(opportunity, clamp((actor.hp - Math.max(0, 1 - first + ownDelay - foeDelay) * response.amount) /
				Math.max(1, actor.hp)));
		}
		// Repeated low damage cannot break a faster/reliably surviving recovery user.
		const wall = targetHealing > dealt + targetResidual && target.hp > dealt * 2;
		const breaking = wall ? clamp(dealt / Math.max(1, 2 * targetHealing)) : 1;
		if (!actionDelay(actor, state.field, move) && move.id !== 'suckerpunch') {
			switchPressure[hardMoveId(move)] = clamp(dealt / target.hp) * accuracy * breaking;
		}
		if (stable && !wall) race = Math.max(race, 0.9);
		// Conditional priority is pressure, not a reliable answer to a foe with status options.
		const conditional = move.id === 'suckerpunch' &&
			moves(target, state.field).some(m => m.category === 'Status') ? 0.5 : 1;
		check = Math.max(check, race * breaking * accuracy ** Math.min(3, turns) * conditional);
		pressure = Math.max(pressure, clamp(dealt / target.hp) * opportunity * accuracy * breaking);
	}
	// Recovery plus poison/burn can be a real defensive answer without large direct damage.
	if (stable) {
		if (attrition(target, theirs)) { check = Math.max(check, 0.75); pressure = Math.max(pressure, 0.35); }
		for (const move of moves(actor, state.field)) {
			if (!['tox', 'psn', 'brn'].includes(move.status || '') || statusFailure(state, actor, target, move)) continue;
			if (!attrition({ ...target, status: move.status!, toxicCounter: 0 }, theirs)) continue;
			check = Math.max(check, 0.75);
			pressure = Math.max(pressure, 0.35);
		}
	}
	const sustain = clamp((actor.hp - worst - residual) / actor.maxHp +
		(healing > worst + residual ? 0.5 : 0));
	return { check, counter: 0, pressure, switchPressure, sustain };
}

function directional(actor: AIPokemon, target: AIPokemon, state: PairState): Matchup {
	const result = outlook(actor, target, state);
	if (!actor.hp || !target.hp) return result;
	let counter = result.check;
	const options = moves(target, state.field).filter(m => !actionDelay(target, state.field, m));
	// The conceded entry action also advances sleep/recharge and residuals on the opponent.
	const volatiles = new Set(target.volatiles); volatiles.delete('mustrecharge');
	const afterEntry = { ...target, volatiles, sleepTurns: target.sleepTurns ? Math.max(1, target.sleepTurns -
		(effectiveAbility(target, state.field) === 'earlybird' ? 2 : 1)) : 0 };
	const restedTarget = hp(afterEntry, getEffectiveHpAfterSecondary(afterEntry, state.field.weather,
		effectiveAbility(actor, state.field), state.field));
	const entryDamage = Math.max(0, ...options.filter(m => m.category !== 'Status').map(m =>
		damage(target, actor, m, reverse(state))));
	const damaged = hp(actor, actor.hp - entryDamage);
	counter = Math.min(counter, outlook(hp(damaged, getEffectiveHpAfterSecondary(damaged, state.field.weather,
		effectiveAbility(target, state.field), state.field)), restedTarget, state).check);
	for (const move of options.filter(m => m.category === 'Status')) {
		let defender = actor, attacker = restedTarget;
		if (move.boosts && move.target === 'self') {
			const boosts = { ...target.boosts };
			const multiplier = effectiveAbility(target, state.field) === 'contrary' ? -1 :
				effectiveAbility(target, state.field) === 'simple' ? 2 : 1;
			for (const [stat, amount] of Object.entries(move.boosts)) {
				const key = stat as keyof typeof boosts;
				boosts[key] = Math.max(-6, Math.min(6, boosts[key] + amount * multiplier));
			}
			attacker = { ...restedTarget, boosts };
		} else if (move.status && !statusFailure(reverse(state), target, actor, move)) {
			defender = { ...actor, status: move.status, sleepTurns: move.status === 'slp' ? 2 : 0, toxicCounter: 0 };
		} else if (directRecoveryAmount(target, move, state.field)) {
			attacker = hp(target, Math.min(target.maxHp, target.hp + directRecoveryAmount(target, move, state.field)));
			if (move.id === 'rest') attacker = { ...attacker, status: 'slp', sleepTurns: 3 };
		} else {
			continue;
		}
		defender = hp(defender, getEffectiveHpAfterSecondary(defender, state.field.weather,
			effectiveAbility(attacker, state.field), state.field));
		counter = Math.min(counter, outlook(defender, attacker, state).check);
	}
	return { ...result, counter };
}

/** Diminishing redundancy: the first reliable answer matters much more than a backup. */
function coverage(values: number[]): number {
	const sorted = values.sort((a, b) => b - a);
	return clamp((sorted[0] || 0) + 0.2 * (sorted[1] || 0));
}

function teamValue(party: AIPokemon[], foes: AIPokemon[], rows: Matchup[][], state: BattleState): number {
	let value = 0;
	const availableFoes = foes.map(p => entered(p, state.opponent.conditions, state.field));
	for (const [i, p] of party.entries()) {
		const available = entered(p, state.self.conditions, state.field);
		if (!available.hp || p.fainted) continue;
		value += 25 + 35 * available.hp / p.maxHp;
		// A wallbreaker can force progress on a free turn even when faster revenge killers
		// prevent a sweep. Require one common move to threaten every remaining switch-in.
		const defense = rows[i].filter((_, j) => availableFoes[j].hp && !availableFoes[j].fainted);
		const attacks = new Set(defense.flatMap(m => Object.keys(m.switchPressure)));
		const pressure = Math.max(0, ...[...attacks].map(id =>
			Math.min(...defense.map(m => m.switchPressure[id] || 0))));
		value += 15 * (defense.length ? pressure : 1);
	}
	for (const [j, foe] of availableFoes.entries()) {
		if (!foe.hp || foe.fainted) continue;
		const matchups = rows.map((row, i) => party[i].hp && !party[i].fainted ? row[j] : zero());
		// Penalize uncovered threats, rather than rewarding the continued existence of an
		// opponent we can answer. Removing an opposing threat must not remove our reward.
		value -= 45 * (1 - coverage(matchups.map(m => m.check))) +
			30 * (1 - coverage(matchups.map(m => m.counter))) +
			10 * (1 - coverage(matchups.map(m => m.counter * m.sustain)));
		// A reserve check needs a free entry. Against the current threat, only the active
		// member can act immediately; a reserve must survive the conceded entry action.
		// This values an executable answer, rather than a rotation toward another paper check.
		if (foe.active) value -= 35 * (1 - coverage(matchups.map((m, i) => party[i].active ? m.check : m.counter)));
	}
	return value;
}

export class MatchupEvaluator {
	private cache = new Map<string, Pair>();
	private tokens = new Map<string, number>();
	private token(value: string): number {
		let token = this.tokens.get(value);
		if (token === undefined) this.tokens.set(value, token = this.tokens.size + 1);
		return token;
	}
	readonly stats = { hits: 0, misses: 0 };
	private capacity: number;
	readonly damagePolicy: DamagePolicy;
	constructor(capacity = 12000, damagePolicy: DamagePolicy = 'mean') {
		this.capacity = capacity; this.damagePolicy = damagePolicy;
	}

	/** At most 36 cells per concrete singles world. Content keys also survive switches/turns. */
	assess(state: BattleState) {
		if ([state.self, state.opponent].some(s => Object.values(s.conditions.futureMoves).some(n => n > 0))) {
			state = clonePosition(state); settleFutureAttacks(state, this.damagePolicy, true);
		}
		if (this.tokens.size > 40000) { this.tokens.clear(); this.cache.clear(); }
		const own = state.self.team, foes = state.opponent.team;
		const sleepers = (party: AIPokemon[]) => party.filter(p => p.hp && p.status === 'slp')
			.map(p => [p.ownerSide, !!p.sleepSelfInflicted]);
		const context = JSON.stringify([state.field, state.self.conditions, state.opponent.conditions,
			// Sleep-clause eligibility is the one team-wide status dependency of pair evaluation.
			sleepers(own), sleepers(foes)]);
		const actors = own.map(p => ({ ...p, moves: knownMoves(p) }));
		const ownKeys = actors.map(p => this.token(fingerprint(p)));
		const profiles = foes.map(target => modelsFor(target).map(model => {
			const pokemon = { ...model.pokemon, moves: model.moves.map(m => m.id) };
			return { pokemon, weight: model.weight, key: this.token(fingerprint(pokemon)) };
		}));
		const prefix = this.token(context + JSON.stringify(this.damagePolicy));
		const matrix = actors.map((actor, i) => foes.map((target, j): Pair => {
			if (!actor.hp || !target.hp || actor.fainted || target.fainted) return { self: zero(), opponent: zero() };
			const sum: Pair = { self: zero(), opponent: zero() };
			for (const model of profiles[j]) {
				const foe = model.pokemon;
				const key = `${prefix}:${ownKeys[i]}:${model.key}`;
				let result = this.cache.get(key);
				if (result) this.stats.hits++;
				else {
					this.stats.misses++;
					const field = fieldWithActivePokemon(state.field, [actor, foe]);
					const a = entered(actor, state.self.conditions, field), b = entered(foe, state.opponent.conditions, field);
					const pairState: PairState = { ...state, field, calculations: createCache(state.turn),
						damagePolicy: this.damagePolicy, damageMemo: new Map(),
						self: { ...state.self, active: [a] }, opponent: { ...state.opponent, active: [b] } };
					result = { self: directional(a, b, pairState), opponent: directional(b, a, reverse(pairState)) };
					if (this.cache.size >= this.capacity) this.cache.delete(this.cache.keys().next().value!);
					this.cache.set(key, result);
				}
				for (const side of ['self', 'opponent'] as const) {
					for (const metric of ['check', 'counter', 'pressure', 'sustain'] as const) {
						sum[side][metric] += model.weight * result[side][metric];
					}
					for (const [move, value] of Object.entries(result[side].switchPressure)) {
						sum[side].switchPressure[move] = (sum[side].switchPressure[move] || 0) + model.weight * value;
					}
				}
			}
			return sum;
		}));
		const selfRows = matrix.map(row => row.map(p => p.self));
		const opponentRows = foes.map((foe, j) => own.map((actor, i) => matrix[i][j].opponent));
		const self = teamValue(own, foes, selfRows, state);
		const opponent = teamValue(foes, own, opponentRows, reverse(state));
		return { value: self - opponent, self, opponent, matrix };
	}

	/** Marginal team value, including the offensive routes opened for the opposing team. */
	roles(state: BattleState): { pokemon: string, value: number }[] {
		const baseline = this.assess(state).value;
		return state.self.team.map((pokemon, index) => ({ pokemon: pokemon.species,
			value: pokemon.fainted || !pokemon.hp ? 0 : baseline - this.assess({ ...state,
				self: { ...state.self, team: state.self.team.map((p, i) => i === index ? hp(p, 0) : p) },
			}).value }));
	}
}
