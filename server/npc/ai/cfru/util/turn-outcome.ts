/** HP consequences in action order, shared by tactical scoring and retreat decisions. */
import type { AIPokemon, AIMove, FieldConditions, SideConditions } from '../types';
import { rulesDex, effectiveAbility, effectiveItem, defensiveAbility, grounded } from './mechanics';
import { recoveryKind, recoveryCuresStatus, stockpileLayers } from './move-effects';
import { getEffectiveHpAfterSecondary } from './damage-calc';

export function directRecoveryAmount(actor: AIPokemon, move: AIMove, field: FieldConditions): number {
	if (recoveryKind(move, field) !== 'direct') return 0;
	const data = rulesDex(field).moves.get(move.id);
	if (data.heal) return Math.floor(actor.maxHp * data.heal[0] / data.heal[1]);
	if (move.id === 'rest') return actor.maxHp;
	if (move.id === 'swallow') return Math.floor(actor.maxHp * [0, 1 / 4, 1 / 2, 1][stockpileLayers(actor)]);
	if (['synthesis', 'moonlight', 'morningsun'].includes(move.id)) {
		return Math.floor(actor.maxHp * (field.weather === 'sun' ? 2 / 3 : field.weather ? 1 / 4 : 1 / 2));
	}
	if (move.id === 'shoreup') return Math.floor(actor.maxHp * (field.weather === 'sand' ? 2 / 3 : 1 / 2));
	return 0;
}

/** Damage is supplied by the caller's public-information estimate; no simulator state is read. */
export function selfActionOutcome(actor: AIPokemon, move: AIMove, field: FieldConditions,
	beforeDamage: number, afterDamage: number, opponentAbility = '') {
	const cost = move.id === 'substitute' ? Math.floor(actor.maxHp / 4) : 0;
	const beforeHp = actor.hp - beforeDamage;
	if (beforeHp <= cost) {
		const hp = beforeHp - afterDamage;
		return { acted: false, recovered: 0, endHp: getEffectiveHpAfterSecondary(
			{ ...actor, hp, hpPercent: 100 * hp / actor.maxHp }, field.weather, opponentAbility, field) };
	}
	const recovered = Math.min(directRecoveryAmount(actor, move, field), actor.maxHp - beforeHp);
	const hp = beforeHp + recovered - cost - afterDamage;
	const after = { ...actor, hp, hpPercent: 100 * hp / actor.maxHp,
		status: move.id === 'rest' ? 'slp' : recoveryCuresStatus(move) ? '' : actor.status };
	return { acted: true, recovered,
		endHp: getEffectiveHpAfterSecondary(after, field.weather, opponentAbility, field) };
}

/** Switching resets escalating poison and removes Leech Seed; ordinary burns do not justify this. */
export function needsResidualReset(actor: AIPokemon, field: FieldConditions, opponentAbility = ''): boolean {
	if (actor.status !== 'tox' && !actor.volatiles.has('leechseed')) return false;
	const hp = actor.maxHp * 0.75;
	const probe = { ...actor, hp, hpPercent: 75 };
	return hp - getEffectiveHpAfterSecondary(probe, field.weather, opponentAbility, field) >= actor.maxHp / 4;
}

/** Immediate hazard HP loss, shared by normal safety checks and hard replacement valuation. */
export function entryHazardDamage(pokemon: AIPokemon, conditions: SideConditions, field: FieldConditions): number {
	if (effectiveAbility(pokemon, field) === 'magicguard' || effectiveItem(pokemon, field) === 'heavydutyboots') return 0;
	const dex = rulesDex(field);
	let damage = conditions.stealthrock ? Math.max(1, Math.floor(pokemon.maxHp / 8 *
		2 ** dex.getEffectiveness('Rock', pokemon.types))) : 0;
	if (grounded(pokemon, field) && conditions.spikes) {
		damage += Math.max(1, Math.floor(pokemon.maxHp * [0, 1 / 8, 1 / 6, 1 / 4][conditions.spikes]));
	}
	return damage;
}

/** Guaranteed flinch on a successful hit; callers still check immunity, accuracy and action order. */
export function flinchesOnHit(actor: AIPokemon, target: AIPokemon, move: AIMove, field: FieldConditions): boolean {
	const data = rulesDex(field).moves.get(move.id);
	if (!(data.secondaries || []).some(effect => effect.volatileStatus === 'flinch' && effect.chance === 100)) return false;
	if (move.id === 'fakeout' && (actor.activeMoveActions || actor.lastMove)) return false;
	return !target.volatiles.has('substitute') &&
		!['innerfocus', 'shielddust'].includes(defensiveAbility(actor, target, move, field)) &&
		effectiveItem(target, field) !== 'covertcloak' && effectiveAbility(actor, field) !== 'sheerforce';
}
