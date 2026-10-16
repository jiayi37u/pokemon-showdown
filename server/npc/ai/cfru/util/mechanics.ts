/** Shared rule primitives over AI snapshots. No simulator objects or strategic scores. */
import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, AIMove, FieldConditions } from '../types';

export function rulesDex(field: Pick<FieldConditions, 'formatId'>) {
	return field.formatId ? Dex.forFormat(field.formatId) : Dex;
}

export function effectiveItem(pokemon: AIPokemon, field: FieldConditions): string {
	const item = rulesDex(field).items.get(pokemon.item);
	if (pokemon.itemLost) return '';
	if (item.isPrimalOrb) return item.id;
	if (field.magicroom || pokemon.volatiles.has('embargo') ||
		(toID(pokemon.ability) === 'klutz' && !item.ignoreKlutz)) return '';
	return item.id;
}

/** Ability Shield protects its holder; Mold Breaker only suppresses breakable defending abilities. */
export function defensiveAbility(
	attacker: AIPokemon, defender: AIPokemon, move: AIMove, field: FieldConditions
): string {
	const ability = toID(defender.ability);
	const dex = rulesDex(field);
	const ignores = ['moldbreaker', 'teravolt', 'turboblaze'].includes(toID(attacker.ability)) ||
		dex.moves.get(move.id).ignoreAbility;
	if (attacker !== defender && ignores && dex.abilities.get(ability).flags.breakable &&
		effectiveItem(defender, field) !== 'abilityshield') return '';
	return ability;
}

export function grounded(pokemon: AIPokemon, field: FieldConditions, ignoreLevitate = false): boolean {
	if (field.gravity || pokemon.volatiles.has('smackdown') ||
		(pokemon.volatiles.has('ingrain') && rulesDex(field).gen >= 4) ||
		effectiveItem(pokemon, field) === 'ironball') return true;
	if (pokemon.types.includes('Flying') && !pokemon.volatiles.has('roost')) return false;
	if (!ignoreLevitate && toID(pokemon.ability) === 'levitate') return false;
	return !pokemon.volatiles.has('magnetrise') && !pokemon.volatiles.has('telekinesis') &&
		effectiveItem(pokemon, field) !== 'airballoon';
}

export function effectivePriority(pokemon: AIPokemon, move: AIMove, field: Pick<FieldConditions, 'formatId'>): number {
	const ability = toID(pokemon.ability);
	let priority = move.priority;
	if (ability === 'prankster' && move.category === 'Status') priority++;
	if (ability === 'galewings' && move.type === 'Flying' &&
		(rulesDex(field).gen === 6 || pokemon.hpPercent === 100)) priority++;
	if (ability === 'triage' && move.flags.heal) priority += 3;
	return priority;
}

export function getEffectiveStat(base: number, boost: number): number {
	return Math.floor(boost >= 0 ? base * (2 + boost) / 2 : base * 2 / (2 - boost));
}

/** Public start/end events are the authority for active Protosynthesis / Quark Drive boosts. */
export function abilityStatModifier(volatiles: ReadonlySet<string>): AIPokemon['abilityStatMod'] {
	for (const effect of volatiles) {
		const match = /^(?:quarkdrive|protosynthesis)(atk|def|spa|spd|spe)$/.exec(effect);
		if (match) return { stat: match[1] as AIPokemon['abilityStatMod']['stat'],
			multiplier: match[1] === 'spe' ? 1.5 : 5325 / 4096 };
	}
	return { stat: null, multiplier: 1 };
}
