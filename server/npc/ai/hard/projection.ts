/** Deterministic, decision-oriented state transitions. Never instantiate a PS Battle here. */
import { toID } from '../../../../sim/dex';
import type { PokemonConditionData } from '../../../../sim/dex-conditions';
import type { AIPokemon, BattleState, OpponentModel } from '../cfru/types';
import { hardMove } from './opponent-model';
import { calculateDamage, selectDamage, type DamagePolicy } from './damage';
import { canHaveOpponentMoves } from '../cfru/util/opponent-presets';
import {
	effectiveAbility, defensiveAbility, effectiveItem, fieldWithActivePokemon, grounded, rulesDex, tracedAbility,
} from '../cfru/util/mechanics';
import { compareActionOrder, compareSpeedOrder } from '../cfru/util/speed';
import { megaEvolutionState } from '../cfru/util/forms';
import { directRecoveryAmount, entryHazardDamage, flinchesOnHit } from '../cfru/util/turn-outcome';
import { getEffectiveHpAfterSecondary, getExpectedHitCount } from '../cfru/util/damage-calc';
import {
	boostsCanChange, boostChanges, statusFailure, protectionMoves, volatileEffectFailure, moveSelectionFailure,
} from '../cfru/util/move-effects';
import { getMoveInteraction } from '../cfru/util/type-calc';
import { itemMoveFailure, itemRemovalFailure } from '../cfru/util/items';

export interface SearchAction {
	id: string;
	move?: string;
	/** A deterministic outcome of a calling move; never sampled. */
	calledMove?: string;
	mega?: boolean;
	switchTo?: AIPokemon;
	prior: number;
}
export type Side = 'self' | 'opponent';
interface ProjectedPokemon extends AIPokemon {
	projection?: { pp?: Record<string, number>, substituteHp?: number, protect?: boolean, flinch?: boolean,
		tauntTurns?: number, encoreTurns?: number, startHp?: number, wishHp?: number, roostTypes?: string[],
		chargingMove?: string, damageTaken?: number, damageCategory?: string,
		nativePP?: Record<string, number>,
		native?: Pick<AIPokemon, 'species' | 'types' | 'baseStats' | 'ability' | 'abilityChanged' | 'moves' | 'moveKnowledge'>,
	};
}
export const identity = (p: AIPokemon) => p.ident || `${p.ownerSide}:${p.slot}:${p.species}`;
const other = (side: Side): Side => side === 'self' ? 'opponent' : 'self';

/** Staying actions share the immediate-Mega rule in candidate selection and matchup verification. */
export function moveAction(state: BattleState, side: Side, move: string): SearchAction {
	const party = state[side], actor = party.active[0], dex = rulesDex(state.field);
	return { id: `move ${move}`, move, prior: 0,
		mega: !!dex.items.get(actor.item).megaStone?.[dex.species.get(actor.species).baseSpecies] &&
			!dex.species.get(actor.species).isMega && !party.megaUsedByOwner?.[actor.ownerSide || ''] };
}

export function hp(p: AIPokemon, amount: number): void {
	p.hp = Math.max(0, Math.min(p.maxHp, amount)); p.hpPercent = 100 * p.hp / p.maxHp;
	p.fainted = p.hp <= 0;
}

function triggerHealthItem(pokemon: AIPokemon, state: BattleState): void {
	if (!pokemon.fainted && effectiveItem(pokemon, state.field) === 'sitrusberry' && pokemon.hp <= pokemon.maxHp / 2) {
		hp(pokemon, pokemon.hp + Math.floor(pokemon.maxHp / 4)); pokemon.item = ''; pokemon.itemLost = true;
	}
}

export function clonePosition(state: BattleState): BattleState {
	const side = (s: BattleState['opponent']) => {
		const team = s.team.map((p: ProjectedPokemon): ProjectedPokemon => ({ ...p, boosts: { ...p.boosts },
			volatiles: new Set(p.volatiles), moves: [...p.moves], baseStats: { ...p.baseStats },
			projection: p.projection ? { ...p.projection, pp: p.projection.pp && { ...p.projection.pp } } : undefined }));
		const get = (p: AIPokemon) => team.find(q => identity(q) === identity(p))!;
		return { ...s, team, active: s.active.map(get).filter(Boolean), reserve: s.reserve.map(get).filter(Boolean),
			conditions: { ...s.conditions, wishes: { ...s.conditions.wishes }, futureMoves: { ...s.conditions.futureMoves },
				wishSources: { ...s.conditions.wishSources }, futureAttacks: { ...s.conditions.futureAttacks } },
			megaUsedByOwner: { ...s.megaUsedByOwner } };
	};
	return { ...state, self: side(state.self), opponent: side(state.opponent), field: { ...state.field } };
}

const profileKeys = new WeakMap<OpponentModel, string>();
/** Compact cache identity: never serialize whole repeated preset objects per search node. */
export function positionKey(state: BattleState): string {
	const pokemon = (p: ProjectedPokemon) => [identity(p), p.species, p.hp, p.maxHp, p.active, p.fainted,
		p.status, p.sleepTurns, p.toxicCounter, p.boosts, p.baseStats, p.statSpread, p.trapSource,
		p.types, p.item, p.itemKnown, p.itemLost,
		p.itemChanged, p.itemExchange, p.ability, p.observedAbility, p.abilityChanged, p.moves, p.lastMove, p.activeMoveActions,
		[...p.volatiles].sort(), p.projection, p.queuedSpeed, p.queuedPriorityAbility,
		p.moveKnowledge, p.presetModels?.map(m => {
			let key = profileKeys.get(m);
			if (!key) {
				key = JSON.stringify([m.weight, m.pokemon.baseStats, m.pokemon.maxHp, m.pokemon.item,
					m.pokemon.ability, m.spread, m.moves, m.pokemon.moveKnowledge]); profileKeys.set(m, key);
			}
			return key;
		})];
	const conditions = (side: BattleState['self']) => ({ ...side.conditions,
		wishes: side.conditions.wishes || {}, futureMoves: side.conditions.futureMoves || {},
		wishSources: side.conditions.wishSources || {}, futureAttacks: side.conditions.futureAttacks || {} });
	return JSON.stringify([state.self.team.map(pokemon), state.opponent.team.map(pokemon), state.field,
		conditions(state.self), conditions(state.opponent),
		state.self.megaUsedByOwner || {}, state.opponent.megaUsedByOwner || {}]);
}

/** Project the same hidden profile onto current public/hypothetical HP, boosts and conditions. */
export function modelsFor(p: AIPokemon): OpponentModel[] {
	const pool = p.presetModels || [{ name: 'bound', weight: 1, matched: true, pokemon: p,
		moves: [...new Set([...p.moves, ...(p.moveKnowledge?.presetCandidates || [])])].map(id => ({ id, availability: 1 })) }];
	const known = p.moveKnowledge?.revealedMoves || p.moves;
	const models = pool.filter(m => !m.pokemon.moveKnowledge || canHaveOpponentMoves(m.pokemon.moveKnowledge, known));
	const mass = models.reduce((n, m) => n + m.weight, 0) || 1;
	return models.map(m => {
		const maxHp = m.pokemon.maxHp;
		return { ...m, weight: m.weight / mass, moves: m.moves.filter(move =>
			!m.pokemon.moveKnowledge || canHaveOpponentMoves(m.pokemon.moveKnowledge, [...known, move.id])),
		pokemon: { ...p, baseStats: m.pokemon.baseStats, statSpread: m.spread || p.statSpread, maxHp,
			hp: maxHp === p.maxHp ? p.hp : Math.ceil(p.hpPercent * maxHp / 100),
			item: p.itemKnown || p.itemChanged || p.itemLost ? p.item : m.pokemon.item,
			ability: p.abilityChanged ? p.ability : m.pokemon.ability,
			moveKnowledge: m.pokemon.moveKnowledge, presetModels: undefined } };
	});
}

export function bindOpponent(state: BattleState, original: AIPokemon, model: OpponentModel): void {
	const pokemon = state.opponent.team.find(p => identity(p) === identity(original))!;
	Object.assign(pokemon, model.pokemon, { presetModels: undefined, active: pokemon.active });
}

export function knownMoves(p: AIPokemon): string[] {
	return [...new Set([...p.moves, ...(p.moveKnowledge?.presetCandidates || [])])].filter(id =>
		!p.moveKnowledge || canHaveOpponentMoves(p.moveKnowledge, [id]));
}

export function usableMove(state: BattleState, side: Side, id: string): boolean {
	const p = state[side].active[0] as ProjectedPokemon;
	if (!p || p.fainted) return false;
	const data = rulesDex(state.field).moves.get(id);
	if (p.projection?.chargingMove && p.projection.chargingMove !== data.id) return false;
	if (state[other(side)].active[0]?.volatiles.has('imprison') &&
		knownMoves(state[other(side)].active[0]).includes(data.id)) return false;
	if (p.projection?.pp?.[data.id] === 0) return false;
	if (moveSelectionFailure(p, id, state.field)) return false;
	return !p.moveKnowledge || canHaveOpponentMoves(p.moveKnowledge, [id]);
}

function boosts(p: AIPokemon, changes: SparseBoostsTable, state: BattleState, hostile = false): void {
	const ability = effectiveAbility(p, state.field);
	for (const [stat, amount] of Object.entries(changes)) {
		if (hostile && amount < 0 && ['clearbody', 'whitesmoke', 'fullmetalbody'].includes(ability)) continue;
		const key = stat as keyof AIPokemon['boosts'];
		if (!(key in p.boosts)) continue;
		p.boosts[key] = Math.max(-6, Math.min(6, p.boosts[key] + amount *
		(ability === 'contrary' ? -1 : ability === 'simple' ? 2 : 1)));
		if (hostile && amount < 0 && ability === 'defiant') p.boosts.atk = Math.min(6, p.boosts.atk + 2);
		if (hostile && amount < 0 && ability === 'competitive') p.boosts.spa = Math.min(6, p.boosts.spa + 2);
	}
}

function entryAbility(state: BattleState, side: Side): void {
	const actor = state[side].active[0], foe = state[other(side)].active[0];
	if (!actor || actor.fainted) return;
	const copied = tracedAbility(actor, state[other(side)].active, state.field);
	if (copied) {
		actor.observedAbility ||= actor.ability;
		actor.ability = copied; actor.abilityChanged = true;
	}
	const ability = effectiveAbility(actor, state.field);
	if (ability === 'intimidate' && foe && !foe.fainted) boosts(foe, { atk: -1 }, state, true);
	const weather: Record<string, string> = {
		drought: 'sunnyday', drizzle: 'raindance', sandstream: 'sandstorm', snowwarning: 'hail',
	};
	if (weather[ability]) { state.field.weatherId = weather[ability]; state.field.weatherTurns = 5; }
	state.field = fieldWithActivePokemon(state.field, [...state.self.active, ...state.opponent.active]);
}

/** Binding ends when its source leaves; a new occupant of that slot is not the source. */
function releaseTraps(state: BattleState, source: AIPokemon): void {
	for (const p of [...state.self.active, ...state.opponent.active]) {
		if (p.trapSource && toID(p.trapSource) === toID(identity(source))) {
			p.volatiles.delete('partiallytrapped'); delete p.trapSource;
		}
	}
}

export function switchIn(state: BattleState, side: Side, selected: AIPokemon): void {
	const party = state[side], outgoing = party.active[0];
	const incoming = party.team.find(p => identity(p) === identity(selected))!;
	if (!incoming || incoming.fainted || incoming === outgoing) return;
	if (outgoing) {
		releaseTraps(state, outgoing);
		const ability = effectiveAbility(outgoing, state.field);
		if (!outgoing.fainted && ability === 'regenerator') hp(outgoing, outgoing.hp + Math.floor(outgoing.maxHp / 3));
		if (ability === 'naturalcure') outgoing.status = '';
		outgoing.active = false; outgoing.volatiles.clear();
		delete outgoing.trapSource;
		outgoing.lastMove = ''; outgoing.activeMoveActions = 0;
		outgoing.toxicCounter = 0;
		for (const key of Object.keys(outgoing.boosts) as (keyof AIPokemon['boosts'])[]) outgoing.boosts[key] = 0;
		const projected = outgoing as ProjectedPokemon;
		if (projected.projection?.roostTypes) projected.types = projected.projection.roostTypes;
		if (projected.projection?.native) {
			Object.assign(projected, projected.projection.native);
			projected.projection.pp = projected.projection.nativePP;
		}
		if (outgoing.abilityChanged && outgoing.observedAbility) {
			outgoing.ability = outgoing.observedAbility; outgoing.abilityChanged = false;
		}
		projected.projection = { pp: projected.projection?.pp, wishHp: projected.projection?.wishHp };
	}
	incoming.active = true; incoming.lastMove = ''; incoming.activeMoveActions = 0;
	party.active = [incoming]; party.reserve = party.team.filter(p => p !== incoming && !p.fainted);
	const healing = party.conditions.healingWish;
	if (healing && !incoming.fainted) {
		hp(incoming, incoming.maxHp); incoming.status = '';
		incoming.sleepTurns = 0; incoming.toxicCounter = 0;
		if (healing === 'lunardance') {
			const p = incoming as ProjectedPokemon;
			p.projection ||= {};
			p.projection.pp = Object.fromEntries(knownMoves(p).map(id => {
				const move = rulesDex(state.field).moves.get(id);
				return [move.id, move.noPPBoosts ? move.pp : Math.floor(move.pp * 8 / 5)];
			}));
		}
		delete party.conditions.healingWish;
	}
	hp(incoming, incoming.hp - entryHazardDamage(incoming, party.conditions, state.field));
	if (!incoming.fainted && grounded(incoming, state.field) && effectiveItem(incoming, state.field) !== 'heavydutyboots') {
		if (party.conditions.stickyweb) boosts(incoming, { spe: -1 }, state, true);
		if (incoming.types.includes('Poison')) party.conditions.toxicspikes = 0;
		else if (party.conditions.toxicspikes && !incoming.status && !incoming.types.includes('Steel') &&
			effectiveAbility(incoming, state.field) !== 'immunity') {
			incoming.status = party.conditions.toxicspikes > 1 ? 'tox' : 'psn';
		}
	}

	entryAbility(state, side);
	const waiting = state[other(side)].active[0];
	if (waiting && tracedAbility(waiting, state[side].active, state.field)) entryAbility(state, other(side));
}

function status(
	state: BattleState, side: Side, actor: AIPokemon, target: AIPokemon, id: string, condition: string
): void {
	const perspective = side === 'self' ? state : { ...state, self: state.opponent, opponent: state.self };
	if (statusFailure(perspective, actor, target, hardMove(id, 1, state.field.formatId || ''), condition)) return;
	target.status = condition; target.toxicCounter = 0;
	if (condition === 'slp') {
		target.sleepTurns = 3; target.sleepSelfInflicted = actor === target;
	}
	if (effectiveItem(target, state.field) === 'lumberry' ||
		condition === 'slp' && effectiveItem(target, state.field) === 'chestoberry') {
		target.status = ''; target.sleepTurns = 0;
		target.item = ''; target.itemLost = true;
	}
}

export function transitionSupported(state: BattleState): string | undefined {
	if (state.isDoubles) return 'two-turn search currently supports singles';
	if (state.self.active.length !== 1 || state.opponent.active.length !== 1) return 'requires active placeholders';
	if (rulesDex(state.field).gen < 3 || rulesDex(state.field).gen > 7) return 'generation outside transition coverage';
	for (const side of [state.self, state.opponent]) {
		if (Object.entries(side.conditions.futureMoves).some(([slot, n]) => n > 0 &&
			!side.conditions.futureAttacks?.[+slot])) return 'delayed attack source unavailable';
		if (Object.values(side.conditions.wishes).some(n => n > 0) &&
			!side.team.some(p => (p as ProjectedPokemon).projection?.wishHp) &&
			!Object.values(side.conditions.wishSources || {}).length) return 'Wish source HP unavailable';
	}
	return undefined;
}

/** A limited effect vocabulary, not silent no-ops for unknown status moves. */
export function supportsMove(state: BattleState, id: string): boolean {
	const move = rulesDex(state.field).moves.get(id); id = move.id;
	if (move.selfSwitch === 'copyvolatile' ||
		move.flags.charge && !['solarbeam', 'bounce'].includes(id) || move.ohko) return false;
	if (rulesDex(state.field).gen < 5 &&
		(move.flags.futuremove || ['healingwish', 'lunardance'].includes(id))) return false;
	if (['bide', 'naturepower'].includes(id)) return false;
	if (move.category !== 'Status') return true;
	return !!(move.boosts || move.heal || move.status || move.sideCondition || move.weather || move.terrain ||
		protectionMoves.has(id) || ['rest', 'wish', 'painsplit', 'substitute', 'taunt', 'encore', 'leechseed',
		'haze', 'defog', 'trick', 'switcheroo', 'roar', 'whirlwind', 'healbell', 'aromatherapy',
		'curse', 'imprison', 'sleeptalk', 'bellydrum', 'perishsong', 'reflecttype', 'transform', 'skillswap', 'magnetrise', 'fairylock', 'healingwish', 'lunardance', 'synthesis', 'moonlight', 'morningsun', 'shoreup', 'splash', 'trickroom'].includes(id));
}

export type ChooseEntry = (state: BattleState, side: Side, cause: 'pivot' | 'phaze') => AIPokemon | undefined;
interface PendingEntry { side: Side; cause: 'pivot' | 'phaze' }

function execute(state: BattleState, side: Side, action: SearchAction, reply: SearchAction,
	policy: DamagePolicy): PendingEntry | undefined {
	if (action.switchTo) { switchIn(state, side, action.switchTo); return; }
	let party = state[side], foeParty = state[other(side)];
	let actor = party.active[0] as ProjectedPokemon, target = foeParty.active[0] as ProjectedPokemon;
	if (!actor || actor.fainted || !action.move) return;
	const dex = rulesDex(state.field), selected = dex.moves.get(action.move);
	const data = dex.moves.get(action.calledMove || action.move), id = data.id;
	const move = hardMove(action.calledMove || action.move, 1, state.field.formatId || '');
	actor.projection ||= {};
	if (actor.projection.flinch) return;
	if (actor.volatiles.has('mustrecharge')) { actor.volatiles.delete('mustrecharge'); return; }
	if (actor.status === 'slp') {
		actor.sleepTurns -= effectiveAbility(actor, state.field) === 'earlybird' ? 2 : 1;
		if (actor.sleepTurns <= 0) actor.status = '';
		else if (!selected.sleepUsable) return;
	}
	if (actor.status === 'frz') { if (data.flags.defrost) actor.status = ''; else return; }
	if (!usableMove(state, side, action.move)) return;
	if (selected.id === 'sleeptalk' && actor.status !== 'slp' &&
		effectiveAbility(actor, state.field) !== 'comatose') return;
	const previous = actor.lastMove;
	const actionActor = { ...actor, lastMove: previous, activeMoveActions: actor.activeMoveActions || 0 };
	actor.lastMove = selected.id; actor.activeMoveActions = (actor.activeMoveActions || 0) + 1;
	if (!actor.projection.chargingMove && actor.projection.pp?.[selected.id] !== undefined) {
		actor.projection.pp[selected.id]--;
	}
	if (actor.moveKnowledge) {
		const known = [...new Set([...actor.moveKnowledge.revealedMoves, selected.id, id])];
		actor.moveKnowledge = { ...actor.moveKnowledge, revealedMoves: known, remainingSlots: Math.max(0, 4 - known.length) };
		actor.moves = known;
	}
	if (['healingwish', 'lunardance'].includes(id)) {
		if (party.reserve.some(p => !p.fainted)) {
			party.conditions.healingWish = id as 'healingwish' | 'lunardance'; hp(actor, 0);
		}
		return;
	}
	if (['futuresight', 'doomdesire'].includes(id)) {
		const slot = target.slot;
		if (!foeParty.conditions.futureMoves[slot]) {
			foeParty.conditions.futureMoves[slot] = 3;
			foeParty.conditions.futureAttacks ||= {};
			foeParty.conditions.futureAttacks[slot] = { source: identity(actor), move: id };
		}
		return;
	}
	if (['solarbeam', 'bounce'].includes(id) && !actor.projection.chargingMove &&
		!(id === 'solarbeam' && state.field.weather === 'sun')) {
		if (effectiveItem(actor, state.field) === 'powerherb') {
			actor.item = ''; actor.itemLost = true;
		} else {
			actor.projection.chargingMove = id;
			if (id === 'bounce') actor.volatiles.add('bounce');
			return;
		}
	}
	delete actor.projection.chargingMove; actor.volatiles.delete('bounce');
	if (protectionMoves.has(id)) {
		if (!protectionMoves.has(previous)) actor.projection.protect = true;
		return;
	}
	if (!target || target.fainted) return;
	let perspective = side === 'self' ? state : { ...state, self: state.opponent, opponent: state.self };
	if (id === 'suckerpunch' && (!reply.move || dex.moves.get(reply.move).category === 'Status' ||
		compareActionOrder(actor, target, move, [hardMove(reply.move, 1, state.field.formatId || '')],
			state.field) <= 0)) return;
	if (id === 'fakeout' && (actor.activeMoveActions || 0) > 1) return;
	if (id === 'focuspunch' && actor.hp < actor.projection.startHp! && !actor.volatiles.has('substitute')) return;
	const targetsSelf = id === 'curse' && !actor.types.includes('Ghost') ||
		data.target === 'self' || data.target === 'allySide' || data.target === 'allyTeam';
	if (!targetsSelf && target.projection?.protect && data.flags.protect && !data.breaksProtect) return;
	const interaction = getMoveInteraction(actionActor, target, move, state.field);
	if (!targetsSelf && (interaction.failed || data.category === 'Status' && interaction.blockedBy)) return;
	if (data.category === 'Status' && !targetsSelf && data.flags.reflectable &&
		defensiveAbility(actor, target, move, state.field) === 'magicbounce') {
		[actor, target] = [target, actor]; [party, foeParty] = [foeParty, party]; side = other(side);
		perspective = side === 'self' ? state : { ...state, self: state.opponent, opponent: state.self };
	}
	const immunity = getMoveInteraction(actionActor, target, move, state.field);
	if (target.volatiles.has('bounce') && data.target !== 'self' &&
		!['thunder', 'hurricane', 'gust', 'twister', 'skyuppercut', 'smackdown'].includes(id) &&
		effectiveAbility(actor, state.field) !== 'noguard' && effectiveAbility(target, state.field) !== 'noguard') return;
	if (data.category !== 'Status' && !immunity.effectiveness) {
		const ability = defensiveAbility(actor, target, move, state.field);
		if (['waterabsorb', 'voltabsorb', 'dryskin'].includes(ability)) hp(target, target.hp + Math.floor(target.maxHp / 4));
		if (['lightningrod', 'stormdrain'].includes(ability)) boosts(target, { spa: 1 }, state);
		if (ability === 'motordrive') boosts(target, { spe: 1 }, state);
		if (ability === 'sapsipper') boosts(target, { atk: 1 }, state);
		if (ability === 'flashfire') target.volatiles.add('flashfire');
		return;
	}
	let dealt = 0;
	let hitSubstitute = false;
	if (data.category !== 'Status') {
		const reactive = ['counter', 'mirrorcoat', 'metalburst'].includes(id);
		dealt = reactive ? (id === 'metalburst' ||
			actor.projection?.damageCategory === (id === 'counter' ? 'Physical' : 'Special') ?
			Math.floor((actor.projection?.damageTaken || 0) * (id === 'metalburst' ? 1.5 : 2)) : 0) :
			Math.floor(selectDamage(calculateDamage(actionActor, target, move, state.field, undefined, {
				attackerSideConditions: party.conditions, defenderSideConditions: foeParty.conditions,
				defenderSwitching: id === 'pursuit' && !!reply.switchTo,
				activePokemon: [...party.active, ...foeParty.active] }), policy));
		if (!dealt) return;
		hitSubstitute = target.volatiles.has('substitute') &&
			!data.flags.sound && effectiveAbility(actor, state.field) !== 'infiltrator';
		if (hitSubstitute) {
			target.projection ||= {};
			const before = target.projection.substituteHp ?? Math.floor(target.maxHp / 4);
			target.projection.substituteHp = Math.max(0, before - dealt);
			dealt = Math.min(dealt, before);
			if (!target.projection.substituteHp) target.volatiles.delete('substitute');
		} else {
			if (target.hp === target.maxHp && (effectiveItem(target, state.field) === 'focussash' ||
				defensiveAbility(actor, target, move, state.field) === 'sturdy') && !move.multihit) {
				if (dealt >= target.hp && effectiveItem(target, state.field) === 'focussash') {
					target.item = ''; target.itemLost = true;
				}
				dealt = Math.min(dealt, target.hp - 1);
			}
			dealt = Math.min(dealt, target.hp); hp(target, target.hp - dealt);
			target.projection ||= {}; target.projection.damageTaken = dealt; target.projection.damageCategory = data.category;
			if (target.item === 'airballoon') { target.item = ''; target.itemLost = true; }
			triggerHealthItem(target, state);
		}
		if (data.drain) hp(actor, actor.hp + Math.floor(dealt * data.drain[0] / data.drain[1]));
		if (data.recoil && !['rockhead', 'magicguard'].includes(effectiveAbility(actor, state.field))) {
			hp(actor, actor.hp - Math.max(1, Math.round(dealt * data.recoil[0] / data.recoil[1])));
		}
		if (data.flags.contact && !hitSubstitute && effectiveAbility(actor, state.field) !== 'magicguard') {
			const hits = Math.round(getExpectedHitCount(move, effectiveAbility(actor, state.field),
				effectiveItem(actor, state.field), actor.species));
			if (['roughskin', 'ironbarbs'].includes(effectiveAbility(target, state.field))) {
				hp(actor, actor.hp - hits * Math.floor(actor.maxHp / 8));
			}
			if (effectiveItem(target, state.field) === 'rockyhelmet') hp(actor, actor.hp - hits * Math.floor(actor.maxHp / 6));
		}
		if (effectiveItem(actor, state.field) === 'lifeorb' && effectiveAbility(actor, state.field) !== 'magicguard' &&
			!(effectiveAbility(actor, state.field) === 'sheerforce' && !!data.secondaries?.length)) {
			hp(actor, actor.hp - Math.floor(actor.maxHp / 10));
		}
		if (!target.fainted && flinchesOnHit({ ...actor, activeMoveActions: actor.activeMoveActions! - 1,
			lastMove: previous }, target, move, state.field)) {
			target.projection ||= {}; target.projection.flinch = true;
		}
	}
	if (data.self?.boosts && actor.hp) boosts(actor, data.self.boosts, state);
	if (data.self?.volatileStatus === 'mustrecharge' && actor.hp) actor.volatiles.add('mustrecharge');
	if (data.selfdestruct) hp(actor, 0);
	if (hitSubstitute) {
		if (data.selfSwitch && actor.hp) return { side, cause: 'pivot' };
		return;
	}
	if (data.volatileStatus === 'partiallytrapped' && !target.fainted && !target.volatiles.has('partiallytrapped')) {
		target.volatiles.add('partiallytrapped'); target.trapSource = identity(actor);
	}
	if (id === 'bellydrum' && actor.hp > actor.maxHp / 2 && actor.boosts.atk < 6) {
		hp(actor, actor.hp - Math.floor(actor.maxHp / 2));
		boosts(actor, { atk: 12 }, state);
	}
	if (id === 'perishsong') for (const p of [actor, target]) {
		if (effectiveAbility(p, state.field) !== 'soundproof' && ![0, 1, 2, 3].some(n => p.volatiles.has(`perish${n}`))) {
			p.volatiles.add('perish3');
		}
	}
	if (['reflecttype', 'transform', 'skillswap'].includes(id)) {
		for (const p of id === 'skillswap' ? [actor, target] : [actor]) {
			p.projection ||= {};
			if (!p.projection.native) p.projection.nativePP = p.projection.pp;
			p.projection.native ||= { species: p.species, types: p.types, baseStats: p.baseStats,
				ability: p.ability, abilityChanged: p.abilityChanged, moves: p.moves, moveKnowledge: p.moveKnowledge };
		}
	}
	if (id === 'reflecttype') { actor.originalTypes ||= actor.types; actor.types = [...target.types]; }
	if (id === 'transform' && !target.volatiles.has('substitute') && !target.volatiles.has('transform')) {
		actor.species = target.species; actor.originalTypes ||= actor.types; actor.types = [...target.types];
		actor.baseStats = { ...target.baseStats, hp: actor.maxHp }; actor.boosts = { ...target.boosts };
		actor.ability = target.ability; actor.abilityChanged = true;
		actor.moves = knownMoves(target); actor.moveKnowledge = target.moveKnowledge;
		actor.projection ||= {};
		actor.volatiles.add('transform'); actor.projection.pp = Object.fromEntries(actor.moves.map(m => [m, 5]));
	}
	if (id === 'skillswap' && ![actor, target].some(p =>
		rulesDex(state.field).abilities.get(p.ability).flags?.failskillswap)) {
		[actor.ability, target.ability] = [target.ability, actor.ability];
		actor.abilityChanged = target.abilityChanged = true; entryAbility(state, side); entryAbility(state, other(side));
	}
	if (id === 'magnetrise' && !state.field.gravity) actor.volatiles.add('magnetrise');
	if (id === 'fairylock') state.field.fairylockTurns = 2;
	if (id === 'imprison') actor.volatiles.add('imprison');
	if (id === 'curse') {
		if (actor.types.includes('Ghost')) {
			if (!target.volatiles.has('curse')) {
				hp(actor, actor.hp - Math.floor(actor.maxHp / 2)); target.volatiles.add('curse');
			}
		} else boosts(actor, { atk: 1, def: 1, spe: -1 }, state);
	}
	if (data.boosts) {
		const recipient = targetsSelf ? actor : target;
		if (boostsCanChange(recipient, boostChanges(move, perspective) || data.boosts, perspective)) {
			boosts(recipient, boostChanges(move, perspective) || data.boosts, state, !targetsSelf);
		}
	}
	if (data.status && !target.fainted) status(state, side, actor, targetsSelf ? actor : target, id, data.status);
	for (const secondary of data.secondaries || []) {
		if (secondary.chance !== 100 || effectiveAbility(actor, state.field) === 'sheerforce') continue;
		if (secondary.self?.boosts && actor.hp) boosts(actor, secondary.self.boosts, state);
		if (target.fainted || defensiveAbility(actor, target, move, state.field) === 'shielddust') continue;
		if (secondary.status) status(state, side, actor, target, id, secondary.status);
		if (secondary.boosts) boosts(target, secondary.boosts, state, true);
	}
	const healing = id === 'rest' && actor.status === 'slp' ? 0 : directRecoveryAmount(actor, move, state.field);
	if (healing && actor.hp && !actor.volatiles.has('healblock')) {
		if (id !== 'rest' || !statusFailure(perspective, actor, actor, move, 'slp')) {
			if (id === 'rest') { actor.status = ''; status(state, side, actor, actor, id, 'slp'); }
			hp(actor, actor.hp + healing);
		}
	}
	if (id === 'roost' && actor.types.includes('Flying')) {
		actor.projection ||= {}; actor.projection.roostTypes = actor.types;
		actor.types = actor.types.filter(type => type !== 'Flying');
		if (!actor.types.length) actor.types = ['Normal'];
	}
	if (id === 'painsplit') {
		const health = Math.floor((actor.hp + target.hp) / 2); hp(actor, health); hp(target, health);
	}
	if (id === 'substitute' && !actor.volatiles.has('substitute') && actor.hp > Math.floor(actor.maxHp / 4)) {
		actor.projection ||= {};
		actor.projection.substituteHp = Math.floor(actor.maxHp / 4); hp(actor, actor.hp - actor.projection.substituteHp);
		actor.volatiles.add('substitute');
	}
	if (['taunt', 'encore', 'leechseed'].includes(id) && !volatileEffectFailure(perspective, actor, target, move)) {
		target.volatiles.add(id); target.projection ||= {};
		if (id === 'taunt') target.projection.tauntTurns = 3;
		if (id === 'encore') target.projection.encoreTurns = 3;
	}
	if (id === 'wish' && !party.conditions.wishes[1]) {
		for (const p of party.team as ProjectedPokemon[]) if (p.projection) delete p.projection.wishHp;
		actor.projection ||= {};
		actor.projection.wishHp = Math.floor(actor.maxHp / 2); party.conditions.wishes[actor.slot] = 2;
		party.conditions.wishSources ||= {}; party.conditions.wishSources[actor.slot] = identity(actor);
	}
	if (data.sideCondition) {
		const conditions = (data.target === 'foeSide' ? foeParty : party).conditions;
		if (data.sideCondition === 'spikes') conditions.spikes = Math.min(3, conditions.spikes + 1);
		else if (data.sideCondition === 'toxicspikes') conditions.toxicspikes = Math.min(2, conditions.toxicspikes + 1);
		else if (data.sideCondition === 'stealthrock') conditions.stealthrock = true;
		else if (data.sideCondition === 'stickyweb') conditions.stickyweb = true;
		else if (['reflect', 'lightscreen', 'auroraveil', 'tailwind', 'safeguard', 'mist'].includes(data.sideCondition)) {
			(conditions as unknown as Record<string, number>)[data.sideCondition] = data.sideCondition === 'tailwind' ? 4 : 5;
		}
	}
	if (id === 'rapidspin' || id === 'defog') {
		for (const team of id === 'defog' && dex.gen >= 6 ? [party, foeParty] : [party]) {
			Object.assign(team.conditions, { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false });
		}
		if (id === 'rapidspin') {
			actor.volatiles.delete('leechseed'); actor.volatiles.delete('partiallytrapped'); delete actor.trapSource;
			if (dex.gen >= 8) boosts(actor, { spe: 1 }, state);
		}
		if (id === 'defog') Object.assign(foeParty.conditions, { reflect: 0, lightscreen: 0, auroraveil: 0 });
	}
	if (id === 'haze' || id === 'clearsmog') for (const p of id === 'haze' ? [actor, target] : [target]) {
		for (const key of Object.keys(p.boosts) as (keyof AIPokemon['boosts'])[]) p.boosts[key] = 0;
	}
	if (id === 'knockoff' && !itemRemovalFailure(actor, target, move, state.field)) {
		target.item = ''; target.itemLost = true;
	}
	if (['trick', 'switcheroo'].includes(id) && !itemMoveFailure(actor, target, move, state.field)) {
		const item = actor.item;
		actor.itemExchange = { given: toID(item), received: toID(target.item) };
		actor.item = target.item; target.item = item;
		actor.itemChanged = target.itemChanged = true; actor.itemLost = !actor.item; target.itemLost = !target.item;
	}
	if (['healbell', 'aromatherapy'].includes(id)) for (const p of party.team) { p.status = ''; p.sleepTurns = 0; }
	if (data.weather) { state.field.weatherId = data.weather; state.field.weatherTurns = 5; }
	if (data.terrain) { state.field.terrain = data.terrain.replace('terrain', ''); state.field.terrainTurns = 5; }
	if (id === 'trickroom') {
		state.field.trickroom = !state.field.trickroom; state.field.trickroomTurns = state.field.trickroom ? 5 : 0;
	}

	triggerHealthItem(actor, state);
	if (data.forceSwitch && target.hp) return { side: other(side), cause: 'phaze' };
	if (data.selfSwitch && actor.hp) return { side, cause: 'pivot' };
}

/** Resolve due future attacks, or their pending liability at the search horizon.
 * The horizon estimate assumes the current occupant receives the hit; no extra action is invented.
 */
export function settleFutureAttacks(state: BattleState, policy: DamagePolicy = 'mean', horizon = false): void {
	for (const side of ['self', 'opponent'] as const) {
		const party = state[side], sources = state[other(side)];
		for (const [slot, turns] of Object.entries(party.conditions.futureMoves)) {
			if (turns <= 0) continue;
			if (!horizon && --party.conditions.futureMoves[+slot] > 0) continue;
			const pending = party.conditions.futureAttacks?.[+slot];
			const target = party.active.find(p => p.slot === +slot);
			const source = pending && sources.team.find(p => toID(identity(p)) === toID(pending.source));
			if (pending && source && target && !target.fainted) {
				const profiles = side === 'self' ? modelsFor(source) : [{ pokemon: source, weight: 1 }];
				const damage = profiles.reduce((sum, model) => sum + model.weight * selectDamage(calculateDamage(
					model.pokemon, target, hardMove(pending.move, 1, state.field.formatId || ''), state.field, undefined,
					{ attackerSideConditions: sources.conditions, defenderSideConditions: party.conditions,
						activePokemon: [...sources.active, ...party.active] }), policy), 0);
				const projected = target as ProjectedPokemon;
				if (target.volatiles.has('substitute') && effectiveAbility(source, state.field) !== 'infiltrator') {
					projected.projection ||= {};
					projected.projection.substituteHp = Math.max(0,
						(projected.projection.substituteHp ?? Math.floor(target.maxHp / 4)) - Math.floor(damage));
					if (!projected.projection.substituteHp) target.volatiles.delete('substitute');
				} else {
					let dealt = Math.floor(damage);
					if (target.hp === target.maxHp && dealt >= target.hp &&
						(effectiveItem(target, state.field) === 'focussash' || effectiveAbility(target, state.field) === 'sturdy')) {
						dealt = target.hp - 1;
						if (effectiveItem(target, state.field) === 'focussash') { target.item = ''; target.itemLost = true; }
					}
					hp(target, target.hp - dealt);
				}
			}
			party.conditions.futureMoves[+slot] = 0;
			if (party.conditions.futureAttacks) delete party.conditions.futureAttacks[+slot];
		}
	}
}

/** Enumerate calling-move outcomes, then average their values; never choose the best call or sample it. */
export function actionOutcomes(state: BattleState, side: Side, action: SearchAction,
	pool?: readonly { id: string, availability: number }[]): { action: SearchAction, weight: number }[] {
	if (action.move !== 'sleeptalk') return [{ action, weight: 1 }];
	const actor = state[side].active[0], dex = rulesDex(state.field);
	const candidates = (pool || knownMoves(actor).map(id => ({ id, availability: 1 }))).filter(candidate => {
		const move = dex.moves.get(candidate.id);
		return !move.flags.nosleeptalk && !move.flags.charge && !move.isZ && !move.isMax &&
			(!actor.moveKnowledge || canHaveOpponentMoves(actor.moveKnowledge, ['sleeptalk', candidate.id]));
	});
	const mass = candidates.reduce((n, m) => n + m.availability, 0);
	return mass ? candidates.map(m => ({ action: { ...action, calledMove: m.id }, weight: m.availability / mass })) :
		[{ action, weight: 1 }];
}

export function endTurn(state: BattleState, policy: DamagePolicy = 'mean'): void {
	settleFutureAttacks(state, policy);
	state.field = fieldWithActivePokemon(state.field, [...state.self.active, ...state.opponent.active]);
	const active = [...state.self.active, ...state.opponent.active] as ProjectedPokemon[];
	const trap = rulesDex(state.field).conditions.get('partiallytrapped') as PokemonConditionData;
	const trapOrder = trap.onResidualOrder || 13;
	for (const source of active) {
		if (!active.some(p => p.trapSource && toID(p.trapSource) === toID(identity(source)))) continue;
		const foe = active.find(p => p !== source);
		if (!getEffectiveHpAfterSecondary(source, state.field.weather, foe?.ability || '', state.field, trapOrder)) {
			releaseTraps(state, source);
		}
	}
	for (const p of active) {
		if (!p.hp) continue;
		const foe = active.find(q => q !== p)!;
		const seeded = p.volatiles.has('leechseed') && effectiveAbility(p, state.field) !== 'magicguard';
		const drained = seeded ? Math.min(p.hp, Math.floor(p.maxHp / 8)) : 0;
		hp(p, getEffectiveHpAfterSecondary(p, state.field.weather, foe?.ability || '', state.field));
		if (drained && foe?.hp) hp(foe, foe.hp + drained);
		if (p.status === 'tox') p.toxicCounter++;
		p.queuedSpeed = undefined; p.queuedPriorityAbility = undefined;
		if (p.projection) {
			p.projection.protect = false; p.projection.flinch = false;
			delete p.projection.damageTaken; delete p.projection.damageCategory;
			if (p.projection.roostTypes) { p.types = p.projection.roostTypes; delete p.projection.roostTypes; }
			if (p.projection.tauntTurns && !--p.projection.tauntTurns) p.volatiles.delete('taunt');
			if (p.projection.encoreTurns && !--p.projection.encoreTurns) p.volatiles.delete('encore');
		}
		for (let n = 0; n <= 3; n++) if (p.volatiles.has(`perish${n}`)) {
			p.volatiles.delete(`perish${n}`); if (!n) hp(p, 0); else p.volatiles.add(`perish${n - 1}`); break;
		}
	}
	for (const party of [state.self, state.opponent]) {
		for (const [slot, turns] of Object.entries(party.conditions.wishes)) {
			if (turns <= 0) continue;
			party.conditions.wishes[+slot]--;
			if (turns === 1 && party.active[0]?.hp) {
				const source = party.team.find(p => toID(identity(p)) === toID(party.conditions.wishSources?.[+slot]) ||
					(p as ProjectedPokemon).projection?.wishHp);
				const amount = (source as ProjectedPokemon)?.projection?.wishHp || (source?.maxHp || party.active[0].maxHp) / 2;
				hp(party.active[0], party.active[0].hp + amount);
			}
		}
		for (const id of ['reflect', 'lightscreen', 'auroraveil', 'tailwind', 'safeguard', 'mist'] as const) {
			if (party.conditions[id]) party.conditions[id]--;
		}
		party.reserve = party.team.filter(p => !p.active && !p.fainted);
	}
	if (state.field.weatherTurns > 0 && !--state.field.weatherTurns) {
		state.field.weather = ''; state.field.weatherId = '';
	}
	if (state.field.terrainTurns > 0 && !--state.field.terrainTurns) state.field.terrain = '';
	if (state.field.trickroomTurns > 0 && !--state.field.trickroomTurns) state.field.trickroom = false;
	if (state.field.fairylockTurns) state.field.fairylockTurns--;
	state.turn++;
}

/** A forkable turn continuation. Completed actions never run again after an entry choice. */
export interface TurnCheckpoint {
	state: BattleState;
	pending?: PendingEntry;
	remaining: { side: Side, actor: string, action: SearchAction, reply: SearchAction }[];
	/** Voluntary switches precede Mega evolution and its entry abilities. */
	megaPending?: { side: Side, actor: string, action: SearchAction }[];
}

function evolveQueued(state: BattleState, queued: NonNullable<TurnCheckpoint['megaPending']>): BattleState {
	let next = state;
	const ordered = [...queued].sort((a, b) =>
		-compareSpeedOrder(state[a.side].active[0], state[b.side].active[0], state.field));
	for (const { side, actor, action } of ordered) {
		const current = next[side].active[0];
		if (!action.mega || !action.move || current.fainted || identity(current) !== actor ||
			next[side].megaUsedByOwner?.[current.ownerSide || '']) continue;
		const perspective = side === 'self' ? next : { ...next, self: next.opponent, opponent: next.self };
		const mega = megaEvolutionState(perspective, perspective.self.active[0], false);
		if (mega) {
			next = side === 'self' ? mega : { ...mega, self: mega.opponent, opponent: mega.self };
			next[side].megaUsedByOwner = { ...next[side].megaUsedByOwner, [next[side].active[0].ownerSide || '']: true };
			entryAbility(next, side);
		}
	}
	return next;
}

export function beginTurn(state: BattleState, own: SearchAction, foe: SearchAction): TurnCheckpoint {
	let next = clonePosition(state);
	const queued = (['self', 'opponent'] as const).map(side => ({ side,
		actor: identity(next[side].active[0]), action: side === 'self' ? own : foe }));
	const deferMega = !!(own.switchTo || foe.switchTo);
	if (!deferMega) next = evolveQueued(next, queued);
	const a = next.self.active[0], b = next.opponent.active[0];
	for (const p of [a, b] as ProjectedPokemon[]) { p.projection ||= {}; p.projection.startHp = p.hp; }
	const first = own.move === 'pursuit' && foe.switchTo ? true :
		foe.move === 'pursuit' && own.switchTo ? false : own.switchTo || foe.switchTo ? own.switchTo && foe.switchTo ?
			compareSpeedOrder(a, b, next.field) >= 0 : !!own.switchTo :
		compareActionOrder(a, b, hardMove(own.move || 'splash', 1, next.field.formatId || ''),
			[hardMove(foe.move || 'splash', 1, next.field.formatId || '')], next.field,
			next.self.conditions, next.opponent.conditions) > 0;
	// Speed ties conservatively let the opponent act first; no random tie samples.
	const order: Side[] = first ? ['self', 'opponent'] : ['opponent', 'self'];
	return { state: next, megaPending: deferMega ? queued.filter(q => q.action.mega && q.action.move) : undefined,
		remaining: order.map(side => ({ side,
			actor: identity(side === 'self' ? a : b), action: side === 'self' ? own : foe,
			reply: side === 'self' ? foe : own })) };
}

/** Mutates this checkpoint only; callers clone its state when branching at an entry. */
export function continueTurn(turn: TurnCheckpoint, policy: DamagePolicy = 'mean'): BattleState | undefined {
	let next = turn.state;
	while (turn.remaining.length) {
		if (turn.megaPending && !turn.remaining.some(q => q.action.switchTo)) {
			const before = next;
			next = turn.state = evolveQueued(next, turn.megaPending); turn.megaPending = undefined;
			turn.remaining = turn.remaining.map(q => q.actor === identity(before[q.side].active[0]) ?
				{ ...q, actor: identity(next[q.side].active[0]) } : q);
		}
		const { side, actor, action, reply } = turn.remaining.shift()!;
		// Phazing/pivots must not give the replacement the outgoing Pokemon's queued attack.
		if (!action.switchTo && identity(next[side].active[0]) !== actor) continue;
		const pending = execute(next, side, action, reply, policy);
		if (pending && next[pending.side].reserve.some(p => !p.fainted && p.hp > 0)) {
			turn.pending = pending; return undefined;
		}
	}
	endTurn(next, policy);
	return next;
}

export function advancePosition(state: BattleState, own: SearchAction, foe: SearchAction,
	chooseEntry: ChooseEntry, policy: DamagePolicy = 'mean'): BattleState {
	const turn = beginTurn(state, own, foe);
	while (!continueTurn(turn, policy)) {
		const { side, cause } = turn.pending!;
		const entrant = chooseEntry(turn.state, side, cause);
		if (entrant) switchIn(turn.state, side, entrant);
		turn.pending = undefined;
	}
	return turn.state;
}
