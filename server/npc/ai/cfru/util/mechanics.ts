/** Shared rule primitives over AI snapshots. No simulator objects or strategic scores. */
import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, AIMove, BattleState, FieldConditions } from '../types';

/** Protocol names and engine IDs share one vocabulary in AI calculations. */
export function normalizeWeather(weather: string): string {
	const id = toID(weather);
	const names: Record<string, string> = {
		sunnyday: 'sun', desolateland: 'sun', raindance: 'rain', primordialsea: 'rain',
		sandstorm: 'sand', snowscape: 'snow', none: '',
	};
	return names[id] ?? id;
}

type AbilityField = Partial<Pick<FieldConditions, 'formatId' | 'magicroom' | 'neutralizingGas'>>;
type AbilityPokemon = Pick<AIPokemon, 'ability' | 'item' | 'itemLost' | 'volatiles'>;

/** Ability identity is retained while suppressed, including inside preset hypotheses. */
export function effectiveAbility(pokemon: AbilityPokemon, field: AbilityField = {}): string {
	const ability = rulesDex(field).abilities.get(pokemon.ability);
	if (pokemon.volatiles.has('transform') && ability.flags.notransform) return '';
	if (ability.flags.cantsuppress) return ability.id;
	if (pokemon.volatiles.has('gastroacid')) return '';
	// Ability Shield ignores Klutz; checking it directly avoids item/ability recursion.
	const shield = !pokemon.itemLost && toID(pokemon.item) === 'abilityshield' &&
		!field.magicroom && !pokemon.volatiles.has('embargo');
	if (field.neutralizingGas && ability.id !== 'neutralizinggas' && !shield &&
		!pokemon.volatiles.has('commanding')) return '';
	return ability.id;
}

/** Recompute field-wide effects from the active lineup, also for hypothetical replacements. */
export function fieldWithActivePokemon(field: FieldConditions, active: readonly AIPokemon[]): FieldConditions {
	const result = { ...field, neutralizingGas: hasNeutralizingGas(active) };
	const suppressed = active.some(p => !p.fainted &&
		['cloudnine', 'airlock'].includes(effectiveAbility(p, result)));
	result.weather = suppressed ? '' : normalizeWeather(field.weatherId ?? field.weather);
	return result;
}

export function hasNeutralizingGas(active: readonly (AbilityPokemon & { fainted?: boolean })[]): boolean {
	return active.some(p => !p.fainted && toID(p.ability) === 'neutralizinggas' &&
		!p.volatiles.has('gastroacid') && !p.volatiles.has('transform'));
}

export function replaceActivePokemon(state: BattleState, outgoing: AIPokemon, incoming: AIPokemon): BattleState {
	const replace = (side: BattleState['self']) => ({ ...side,
		active: side.active.map(p => p === outgoing ? incoming : p),
		reserve: side.reserve.map(p => p === incoming ? outgoing : p),
		team: side.team.map(p => p === outgoing ? incoming : p === incoming ? outgoing : p),
	});
	const self = replace(state.self);
	const opponent = { ...state.opponent, ...replace(state.opponent) };
	return { ...state, self, opponent,
		field: fieldWithActivePokemon(state.field, [...self.active, ...opponent.active]) };
}

export function rulesDex(field: Pick<FieldConditions, 'formatId'>) {
	return field.formatId ? Dex.forFormat(field.formatId) : Dex;
}

export function effectiveItem(pokemon: AIPokemon, field: Partial<FieldConditions> = {}): string {
	const item = rulesDex(field).items.get(pokemon.item);
	if (pokemon.itemLost) return '';
	if (item.isPrimalOrb) return item.id;
	if (field.magicroom || pokemon.volatiles.has('embargo') ||
		(effectiveAbility(pokemon, field) === 'klutz' && !item.ignoreKlutz)) return '';
	return item.id;
}

/** Ability Shield protects its holder; Mold Breaker only suppresses breakable defending abilities. */
export function defensiveAbility(
	attacker: AIPokemon, defender: AIPokemon, move: AIMove, field: FieldConditions
): string {
	const ability = effectiveAbility(defender, field);
	const dex = rulesDex(field);
	const ignores = ['moldbreaker', 'teravolt', 'turboblaze'].includes(effectiveAbility(attacker, field)) ||
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
	if (!ignoreLevitate && effectiveAbility(pokemon, field) === 'levitate') return false;
	return !pokemon.volatiles.has('magnetrise') && !pokemon.volatiles.has('telekinesis') &&
		effectiveItem(pokemon, field) !== 'airballoon';
}

export function effectivePriority(pokemon: AIPokemon, move: AIMove, field: AbilityField): number {
	const ability = effectiveAbility(pokemon, field);
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
