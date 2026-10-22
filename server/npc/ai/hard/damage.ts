/** Damage-only adapter. No Battle instances, sampled rolls, or inferred EV encodings. */
import { calculate, Pokemon, Move, Field } from '../../../../lib/vendor/damage-calc/adaptable';
import { Generations } from '../../../../lib/vendor/damage-calc/data';
import type {
	GenerationNum, StatusName, TypeName, AbilityName, ItemName,
} from '../../../../lib/vendor/damage-calc/data/interface';
import type { AIPokemon, AIMove, AICache, DamageResult, FieldConditions } from '../cfru/types';
import { getExpectedHitCount, type DamageContext } from '../cfru/util/damage-calc';
import { getMoveInteraction, resolveMove } from '../cfru/util/type-calc';
import { effectiveAbility, effectiveItem, rulesDex } from '../cfru/util/mechanics';

export type DamagePolicy = 'mean' | { quantile: number };
export interface CalculatedDamage extends DamageResult { rolls: readonly number[] }
const cache = new Map<string, CalculatedDamage>();

/** The public request already supplies actual stats. Preserve them through calc's clone(). */
class KnownPokemon extends Pokemon {
	override clone(): Pokemon {
		const copy = Object.assign(Object.create(KnownPokemon.prototype), this) as KnownPokemon;
		copy.rawStats = { ...this.rawStats }; copy.stats = { ...this.stats };
		copy.boosts = { ...this.boosts }; copy.ivs = { ...this.ivs }; copy.evs = { ...this.evs };
		copy.types = [...this.types]; copy.moves = [...this.moves];
		// Species data is immutable in calc; mutations target the Pokemon's own stats/types.
		return copy;
	}
}

export function selectDamage(result: CalculatedDamage, policy: DamagePolicy = 'mean'): number {
	if (policy === 'mean') return result.average;
	const q = policy.quantile;
	if (!Number.isFinite(q) || q < 0 || q > 1) throw new Error('Damage quantile must be between 0 and 1');
	return result.rolls[Math.min(result.rolls.length - 1, Math.max(0, Math.ceil(q * result.rolls.length) - 1))];
}

export function calculateDamage(
	attacker: AIPokemon, defender: AIPokemon, move: AIMove, field: FieldConditions,
	_cache?: AICache, context: Partial<DamageContext> & { defenderSwitching?: boolean } = {}
): CalculatedDamage {
	const dex = rulesDex(field);
	move = resolveMove(attacker, move, field, defender);
	const interaction = getMoveInteraction(attacker, defender, move, field, context);
	const result = (rolls: number[]): CalculatedDamage => {
		rolls.sort((a, b) => a - b);
		const min = rolls[0], max = rolls[rolls.length - 1];
		const average = rolls.reduce((sum, n) => sum + n, 0) / rolls.length;
		return { rolls, min, max, average, minPercent: 100 * min / defender.maxHp,
			maxPercent: 100 * max / defender.maxHp, averagePercent: 100 * average / defender.maxHp,
			effectiveness: interaction.effectiveness, canKO: max >= defender.hp,
			guaranteedKO: min >= defender.hp, hitsToKO: average ? Math.ceil(defender.hp / average) : Infinity };
	};
	if (move.category === 'Status' || interaction.blockedBy || !interaction.effectiveness) return result([0]);
	const monKey = (p: AIPokemon) => [p.species, p.level, p.hp, p.maxHp, p.baseStats, p.boosts,
		p.status, effectiveAbility(p, field), effectiveItem(p, field), p.itemKnown, p.itemLost, p.itemAssumed,
		p.types, p.gender, p.terastallized, [...p.volatiles].sort()];
	const key = JSON.stringify([field, monKey(attacker), monKey(defender), move.id, move.calledMove,
		move.basePower, move.type, move.category, move.isZMove,
		context.attackerSideConditions, context.defenderSideConditions, context.isDoubles, context.defenderSwitching]);
	const cached = cache.get(key); if (cached) return cached;
	const gen = Generations.get(dex.gen as GenerationNum);
	const pokemon = (p: AIPokemon) => {
		const mon = new KnownPokemon(gen, dex.species.get(p.species).name, {
			level: p.level, ability: (dex.abilities.get(effectiveAbility(p, field)).name || 'No Ability') as AbilityName,
			item: (dex.items.get(effectiveItem(p, field)).name ||
				(!p.itemKnown && !p.itemLost && !p.itemAssumed ? 'Unknown Item' : undefined)) as ItemName | undefined,
			abilityOn: p.volatiles.has('flashfire') || p.volatiles.has('unburden') || p.volatiles.has('slowstart'),
			boosts: p.boosts, status: p.status as StatusName, teraType: p.terastallized as TypeName,
			gender: p.gender === 'N' ? 'N' : p.gender === 'F' ? 'F' : 'M',
		});
		mon.rawStats = { ...p.baseStats, hp: p.maxHp };
		mon.stats = { ...mon.rawStats }; mon.originalCurHP = p.hp;
		mon.types = p.types.slice(0, 2) as typeof mon.types;
		return mon;
	};
	const data = dex.moves.get(move.calledMove || move.id);
	const hits = Math.max(1, Math.round(getExpectedHitCount(move, effectiveAbility(attacker, field),
		effectiveItem(attacker, field), attacker.species)));
	const attack = new Move(gen, data.name, { hits,
		ability: dex.abilities.get(effectiveAbility(attacker, field)).name as AbilityName,
		item: dex.items.get(effectiveItem(attacker, field)).name as ItemName,
		// Re-resolve dynamic power/type inside calc, never apply an already resolved boost twice.
		overrides: { basePower: move.isZMove || ['return', 'frustration'].includes(data.id) ? move.basePower : data.basePower,
			// Hidden Power's canonical ID omits its publicly inferred/request-supplied type.
			type: (data.id === 'hiddenpower' ? move.type : data.type) as TypeName,
			category: move.isZMove ? move.category : data.category },
	});
	const weather: Record<string, string> = { sun: 'Sun', rain: 'Rain', sand: 'Sand', hail: 'Hail', snow: 'Snow' };
	const side = (s?: DamageContext['attackerSideConditions']) => ({
		isReflect: !!s?.reflect, isLightScreen: !!s?.lightscreen, isAuroraVeil: !!s?.auroraveil,
		isTailwind: !!s?.tailwind,
	});
	const calcField = new Field({ gameType: context.isDoubles ? 'Doubles' : 'Singles',
		weather: weather[field.weather] as Field['weather'],
		terrain: (field.terrain ? field.terrain[0].toUpperCase() + field.terrain.slice(1) : undefined) as Field['terrain'],
		isGravity: field.gravity, isMagicRoom: field.magicroom, isWonderRoom: field.wonderroom,
		attackerSide: side(context.attackerSideConditions),
		defenderSide: { ...side(context.defenderSideConditions),
			isSwitching: context.defenderSwitching ? 'out' : undefined } });
	const calculated = calculate(gen, pokemon(attacker), pokemon(defender), attack, calcField);
	const raw = calculated.damage;
	// Calc returns per-hit rolls for ordinary multihit moves, but separate component arrays
	// for effects such as Parental Bond. Keep the mean exact; correlated hit rolls bound quantiles.
	const rolls = typeof raw === 'number' ? [raw] : typeof raw[0] === 'number' ?
		(raw as number[]).map(n => n * attack.hits) :
		(raw as number[][]).reduce((sum, part) => part.map((n, i) => n + (sum[i] || 0)), [] as number[]);
	const value = result(rolls.length ? rolls : [0]);
	if (cache.size >= 20000) cache.clear();
	cache.set(key, value);
	return value;
}
