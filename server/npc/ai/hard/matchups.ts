/** Singles team value from replaceable checks, switch-ins and offensive routes.
 * Ratings are bounded estimates, not proofs of a counter or calibrated win probabilities.
 * Inputs are knowledge snapshots (or disposable search hypotheses), never a live opponent team.
 */
import type { AIPokemon, AIMove, BattleState, FieldConditions, SideConditions } from '../cfru/types';
import { hardMove, hardMoveId } from './opponent-model';
import { getEffectiveHpAfterSecondary } from '../cfru/util/damage-calc';
import { calculateDamage, selectDamage, DamageCache, type DamagePolicy } from './damage';
import { modelsFor, clonePosition, settleFutureAttacks, bindOpponent,
	positionKey, usableMove, clonePokemon, projectEntry, boosts, status,
	applyRecovery, type Side } from './projection';
import { compareActionOrder, compareSpeedOrder } from '../cfru/util/speed';
import { getMoveInteraction } from '../cfru/util/type-calc';
import { directRecoveryAmount } from '../cfru/util/turn-outcome';
import {
	effectiveAbility, effectiveItem, fieldWithActivePokemon, rulesDex, tracedAbility,
} from '../cfru/util/mechanics';
import {
	mustSkipMove, statusFailure, sleepClauseOccupied, moveSelectionFailure, conditionalAttackDiscouraged,
} from '../cfru/util/move-effects';

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
	/** Pressure and sustain after conceding the entry action, shared with entry pruning. */
	entryPressure: number;
	entrySustain: number;
}
interface Pair { self: Matchup; opponent: Matchup }
interface Assessment { value: number; self: number; opponent: number; matrix: Pair[][] }
interface PairState extends BattleState {
	evaluator: MatchupEvaluator;
	/** Object-local lookup avoids serializing the same race participants for each hit. */
	damageMemo: Map<AIPokemon, Map<AIPokemon, Map<string, number>>>;
	/** Only lives during one read-only assessment; never memoize live mutable Pokemon by identity. */
	keys: WeakMap<object, number>;
}
export interface AttackFacts { damage: number; delay: number }
const zero = (): Matchup => ({ check: 0, counter: 0, pressure: 0, switchPressure: {}, sustain: 0,
	entryPressure: 0, entrySustain: 0 });
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
		p.queuedSpeed, p.queuedPriorityAbility, p.abilityStatMod, p.terastallized, p.gender, p.fainted, p.ownerSide]);
}

/** Static matchup races do not advance field clocks. Search positions still keep them. */
function combatFieldKey(field: FieldConditions): string {
	const { weatherTurns, terrainTurns, trickroomTurns, fairylockTurns, ...effects } = field;
	return JSON.stringify(effects);
}

/** Entry effects are already applied to the keyed participants; delayed attacks are
 * settled before assessment. These records do not affect a stationary exchange.
 * Keep other fields by default so new side mechanics do not silently escape the key.
 */
function combatSideKey(conditions: SideConditions): string {
	const { stealthrock, spikes, toxicspikes, stickyweb, healingWishes,
		wishes, wishSources, wishAmounts, futureMoves, futureAttacks, ...effects } = conditions;
	return JSON.stringify({ ...effects, reflect: !!effects.reflect, lightscreen: !!effects.lightscreen,
		auroraveil: !!effects.auroraveil, tailwind: !!effects.tailwind, safeguard: !!effects.safeguard,
		mist: !!effects.mist });
}

function moves(p: AIPokemon, field: FieldConditions): AIMove[] {
	return p.moves.map(id => {
		const key = `${field.formatId}:${id}`;
		let move = moveData.get(key);
		if (!move) {
			move = hardMove(id, 1, field.formatId || '');
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
	return projectEntry(p, side, field);
}

function damage(actor: AIPokemon, target: AIPokemon, move: AIMove, state: PairState): number {
	let targets = state.damageMemo.get(actor);
	if (!targets) state.damageMemo.set(actor, targets = new Map());
	let amounts = targets.get(target);
	if (!amounts) targets.set(target, amounts = new Map());
	const id = hardMoveId(move), cached = amounts.get(id);
	if (cached !== undefined) return cached;
	const amount = state.evaluator.attack(state, actor, target, move, state.keys).damage;
	amounts.set(id, amount); return amount;
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
export function actionDelay(p: AIPokemon, field: FieldConditions, move?: AIMove): number {
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
function outlook(actor: AIPokemon, target: AIPokemon, state: PairState, attackChoices?: AIMove[]): Matchup {
	if (actor.hp <= 0 || target.hp <= 0 || actor.fainted || target.fainted) return zero();
	const theirs = reverse(state);
	const attacks = attackChoices || moves(actor, state.field).filter(m => m.category !== 'Status');
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
		if (conditionalAttackDiscouraged(state, actor, target, move)) continue;
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
		check = Math.max(check, race * breaking * accuracy ** Math.min(3, turns));
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
	return { check, counter: 0, pressure, switchPressure, sustain, entryPressure: 0, entrySustain: 0 };
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
	const entry = outlook(hp(damaged, getEffectiveHpAfterSecondary(damaged, state.field.weather,
		effectiveAbility(target, state.field), state.field)), restedTarget, state);
	counter = Math.min(counter, entry.check);
	for (const move of options.filter(m => m.category === 'Status')) {
		let defender = actor, attacker = restedTarget;
		if (move.boosts && move.target === 'self') {
			attacker = clonePokemon(restedTarget);
			boosts(attacker, move.boosts, state);
		} else if (move.status && !statusFailure(reverse(state), target, actor, move)) {
			defender = clonePokemon(actor);
			status(state, 'opponent', target, defender, move.id, move.status);
		} else if (directRecoveryAmount(target, move, state.field)) {
			attacker = clonePokemon(target);
			applyRecovery(state, 'opponent', attacker, move);
		} else {
			continue;
		}
		defender = hp(defender, getEffectiveHpAfterSecondary(defender, state.field.weather,
			effectiveAbility(attacker, state.field), state.field));
		const response = outlook(defender, attacker, state);
		counter = Math.min(counter, response.check);
		entry.pressure = Math.min(entry.pressure, response.pressure);
		entry.sustain = Math.min(entry.sustain, response.sustain);
	}
	return { ...result, counter, entryPressure: entry.pressure, entrySustain: entry.sustain };
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
	/** Raw inputs alias the resolved pair, so repeated lookups do not redo entry/Trace work. */
	private pairInputs = new Map<string, Pair>();
	private positions = new Map<string, Assessment>();
	private advantages = new Map<string, boolean>();
	private attacks = new Map<string, Map<string, AttackFacts>>();
	private tokens = new Map<string, number>();
	private token(value: string): number {
		let token = this.tokens.get(value);
		if (token === undefined) this.tokens.set(value, token = this.tokens.size + 1);
		return token;
	}
	private inputKey(value: object, encode: () => string, memo?: WeakMap<object, number>): number {
		const cached = memo?.get(value);
		if (cached !== undefined) return cached;
		const key = this.token(encode()); memo?.set(value, key); return key;
	}
	readonly stats = { hits: 0, misses: 0, positions: 0 };
	readonly damageCache: DamageCache;
	readonly damagePolicy: DamagePolicy;
	constructor(damagePolicy: DamagePolicy = 'mean', damageCache = new DamageCache()) {
		this.damagePolicy = damagePolicy; this.damageCache = damageCache;
	}

	/** A faster winning matchup can act before a pivot. A slower one cannot enforce
	 * its stationary advantage when the opponent can pivot to a living reserve.
	 */
	holdsAdvantage(state: BattleState, side: Side, assessment = this.assess(state)): boolean {
		if (state.self.active[0]?.fainted || state.opponent.active[0]?.fainted) return false;
		const i = state.self.team.indexOf(state.self.active[0]), j = state.opponent.team.indexOf(state.opponent.active[0]);
		const other = side === 'self' ? 'opponent' : 'self', pair = assessment.matrix[i]?.[j];
		if (!pair || pair[side].check < 1 || pair[other].check !== 0) return false;
		const view = side === 'self' ? state : reverse(state);
		if (!view.opponent.reserve.some(p => p.hp > 0 && !p.fainted)) return true;
		const key = `${side}:${positionKey(state)}`, cached = this.advantages.get(key);
		if (cached !== undefined) return cached;
		const dex = rulesDex(state.field), actor = view.self.active[0], target = view.opponent.active[0];
		const result = modelsFor(actor).every(own => modelsFor(target).every(foe => {
			if (compareSpeedOrder(own.pokemon, foe.pokemon, state.field,
				view.self.conditions, view.opponent.conditions) > 0) return true;
			const bound = clonePosition(view); bindOpponent(bound, target, foe);
			return !foe.moves.some(({ id }) => {
				if (!dex.moves.get(id).selfSwitch || !usableMove(bound, 'opponent', id) ||
					mustSkipMove(foe.pokemon, [id], state.field)) return false;
				const move = hardMove(id, 1, state.field.formatId || '');
				return move.target === 'self' || getMoveInteraction(foe.pokemon, own.pokemon, move, state.field).effectiveness > 0;
			});
		}));
		this.advantages.set(key, result); return result;
	}

	/** Concrete pair facts shared by matchup races, coverage and defensive switching.
	 * The key includes HP, resolved profile and field; estimates never outlive their inputs.
	 */
	attack(state: BattleState, actor: AIPokemon, target: AIPokemon, move: AIMove,
		keys?: WeakMap<object, number>): AttackFacts {
		const context = [this.inputKey(state.field, () => combatFieldKey(state.field), keys),
			...[state.self.conditions, state.opponent.conditions]
				.map(value => this.inputKey(value, () => combatSideKey(value), keys))].join(':');
		const key = `${context}:${this.inputKey(actor, () => fingerprint(actor), keys)}:` +
			`${this.inputKey(target, () => fingerprint(target), keys)}`;
		let estimates = this.attacks.get(key);
		if (!estimates) {
			this.attacks.set(key, estimates = new Map());
		}
		const id = hardMoveId(move), cached = estimates.get(id);
		if (cached) return cached;
		const facts = { damage: selectDamage(calculateDamage(actor, target, move, state.field, undefined, {
			cache: this.damageCache, isDoubles: false, numAliveTargets: 1,
			attackerSideConditions: state.self.conditions, defenderSideConditions: state.opponent.conditions,
			activePokemon: [actor, target], defenderAllies: [target],
		}), this.damagePolicy), delay: actionDelay(actor, state.field, move) };
		estimates.set(id, facts); return facts;
	}

	/** At most 36 cells per concrete singles world. Content keys also survive switches/turns. */
	assess(state: BattleState) {
		if ([state.self, state.opponent].some(s => Object.values(s.conditions.futureMoves).some(n => n > 0))) {
			state = clonePosition(state); settleFutureAttacks(state, this.damagePolicy, true, this.damageCache);
		}
		const own = state.self.team, foes = state.opponent.team;
		const keys = new WeakMap<object, number>();
		const sleepers = (party: AIPokemon[]) => party.filter(p => !p.fainted && p.status === 'slp')
			.map(p => [p.ownerSide, !!p.sleepSelfInflicted]);
		const context = JSON.stringify([state.field, state.self.conditions, state.opponent.conditions,
			// Sleep-clause eligibility is the one team-wide status dependency of pair evaluation.
			sleepers(own), sleepers(foes)]);
		// A perspective change does not turn estimated profiles into known configurations.
		const profilesFor = (party: AIPokemon[]) => party.map(target => modelsFor(target).map(model => {
			const pokemon = { ...model.pokemon, moves: model.moves.map(m => m.id) };
			return { pokemon, weight: model.weight, key: this.inputKey(pokemon, () => fingerprint(pokemon), keys) };
		}));
		const actors = profilesFor(own), profiles = profilesFor(foes);
		const prefix = this.token(context + JSON.stringify(this.damagePolicy));
		// Cache evaluation inputs, not search history. PP, pending choices and reveal
		// bookkeeping still distinguish search states but do not alter this value function.
		const position = JSON.stringify([prefix,
			...[own, foes].map(party => party.map(p => this.inputKey(p, () => fingerprint(p), keys))),
			...[actors, profiles].map(pools => pools.map(pool => pool.map(p => [p.key, p.weight])))]);
		const cached = this.positions.get(position);
		if (cached) { this.stats.positions++; return cached; }
		const sides = [state.self.conditions, state.opponent.conditions]
			.map(value => this.inputKey(value, () => combatSideKey(value), keys)).join(':');
		const entryInputs = [state.self.conditions, state.opponent.conditions].map(side =>
			[side.stealthrock, side.spikes, side.toxicspikes, side.stickyweb, side.healingWishes]);
		const inputs = this.token(JSON.stringify([combatFieldKey(state.field), sides, entryInputs,
			sleepers(own), sleepers(foes)]));
		// Resolve each concrete pair through one cache path, including the current pair
		// used to determine whether a boost can contribute to other team matchups.
		type Profile = typeof actors[number][number];
		const pair = (actorModel: Profile, foeModel: Profile): Pair => {
			const actor = actorModel.pokemon;
			const input = `${inputs}:${actorModel.key}:${foeModel.key}`;
			let result = this.pairInputs.get(input);
			if (result) this.stats.hits++;
			else {
				const foe = foeModel.pokemon;
				let field = fieldWithActivePokemon(state.field, [actor, foe]);
				let a = entered(actor, state.self.conditions, field), b = entered(foe, state.opponent.conditions, field);
				const ownCopy = tracedAbility(a, [b], field), foeCopy = tracedAbility(b, [a], field);
				if (ownCopy) a = { ...a, ability: ownCopy };
				if (foeCopy) b = { ...b, ability: foeCopy };
				if (ownCopy || foeCopy) field = fieldWithActivePokemon(field, [a, b]);
				// Team-wide sleep eligibility matters only to pairs that can inflict sleep.
				// Use the shared clause primitive, including owner and self-sleep rules.
				const sleep = [[a, b, state.opponent.team], [b, a, state.self.team]] as const;
				const clauses = sleep.map(([source, recipient, team]) =>
					moves(source, field).some(move => move.status === 'slp') && sleepClauseOccupied(field, team, recipient));
				const key = `${this.inputKey(field, () => combatFieldKey(field), keys)}:${sides}:` +
					`${this.inputKey(a, () => fingerprint(a), keys)}:${this.inputKey(b, () => fingerprint(b), keys)}:${clauses}`;
				result = this.cache.get(key);
				if (result) this.stats.hits++;
				else {
					this.stats.misses++;
					const pairState: PairState = { ...state, field, evaluator: this, damageMemo: new Map(), keys,
						self: { ...state.self, active: [a] }, opponent: { ...state.opponent, active: [b] } };
					result = { self: directional(a, b, pairState), opponent: directional(b, a, reverse(pairState)) };
					this.cache.set(key, result);
				}
				this.pairInputs.set(input, result);
			}
			return result;
		};
		const ownActive = own.findIndex(p => p.active && p.hp > 0 && !p.fainted);
		const foeActive = foes.findIndex(p => p.active && p.hp > 0 && !p.fainted);
		const withoutStrandedBoosts = (pool: Profile[], opponents: Profile[], side: Side): Profile[] =>
			pool.map(model => {
				if (!Object.values(model.pokemon.boosts).some(n => n > 0) || !opponents.length) return model;
				const stranded = opponents.every(other => {
					const current = side === 'self' ? pair(model, other) : pair(other, model);
					const theirs = side === 'self' ? 'opponent' : 'self';
					return current[side].check === 0 && current[side].pressure === 0 && current[theirs].check === 1;
				});
				if (!stranded) return model;
				// The current opponent can win without conceding offensive progress. Leaving
				// loses the boost, so it cannot also provide coverage against the bench.
				// Keep the real active pair intact; this is a value constraint, not a switch.
				const pokemon = { ...model.pokemon, boosts: { ...model.pokemon.boosts } };
				for (const stat of Object.keys(pokemon.boosts) as (keyof AIPokemon['boosts'])[]) {
					pokemon.boosts[stat] = Math.min(0, pokemon.boosts[stat]);
				}
				return { ...model, pokemon, key: this.inputKey(pokemon, () => fingerprint(pokemon), keys) };
			});
		const ownPotential = ownActive >= 0 && foeActive >= 0 ?
			withoutStrandedBoosts(actors[ownActive], profiles[foeActive], 'self') : [];
		const foePotential = ownActive >= 0 && foeActive >= 0 ?
			withoutStrandedBoosts(profiles[foeActive], actors[ownActive], 'opponent') : [];
		const matrix = own.map((original, i) => foes.map((target, j): Pair => {
			if (!original.hp || !target.hp || original.fainted || target.fainted) return { self: zero(), opponent: zero() };
			const sum: Pair = { self: zero(), opponent: zero() };
			const ownPool = i === ownActive && foeActive >= 0 && j !== foeActive ? ownPotential : actors[i];
			const foePool = j === foeActive && ownActive >= 0 && i !== ownActive ? foePotential : profiles[j];
			for (const ownModel of ownPool) for (const model of foePool) {
				const weight = ownModel.weight * model.weight, result = pair(ownModel, model);
				for (const side of ['self', 'opponent'] as const) {
					for (const metric of ['check', 'counter', 'pressure', 'sustain', 'entryPressure', 'entrySustain'] as const) {
						sum[side][metric] += weight * result[side][metric];
					}
					for (const [move, value] of Object.entries(result[side].switchPressure)) {
						sum[side].switchPressure[move] = (sum[side].switchPressure[move] || 0) + weight * value;
					}
				}
			}
			return sum;
		}));
		const selfRows = matrix.map(row => row.map(p => p.self));
		const opponentRows = foes.map((foe, j) => own.map((actor, i) => matrix[i][j].opponent));
		const self = teamValue(own, foes, selfRows, state);
		const opponent = teamValue(foes, own, opponentRows, reverse(state));
		const assessment = { value: self - opponent, self, opponent, matrix };
		this.positions.set(position, assessment); return assessment;
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
