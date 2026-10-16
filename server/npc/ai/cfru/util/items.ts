/** Item rules over public snapshots, shared by scoring and damage estimates. */
import { toID } from '../../../../../sim/dex';
import type { Item, ItemData } from '../../../../../sim/dex-items';
import type { Species } from '../../../../../sim/dex-species';
import type { AIPokemon, AIMove, FieldConditions } from '../types';
import { effectiveAbility, defensiveAbility, effectiveItem, rulesDex } from './mechanics';

export function knownItemless(pokemon: AIPokemon): boolean {
	return !!pokemon.itemLost || (!pokemon.item && !!(pokemon.itemKnown || pokemon.itemAssumed));
}

/**
 * PS item TakeItem predicates read only species and the active move. Project those facts,
 * never a live Pokemon/Battle: this retains format overrides without a second item blacklist.
 * The predicate contract is checked against the simulator's item tables in regression tests.
 */
export function itemAllowsRemoval(
	holder: AIPokemon, source: AIPokemon, move: AIMove, field: FieldConditions, itemId = holder.item
): boolean {
	const dex = rulesDex(field);
	const item = dex.items.get(itemId);
	const predicate = (item as ItemData).onTakeItem;
	if (typeof predicate !== 'function') return predicate !== false;
	type Subject = { readonly baseSpecies: Species };
	type Predicate = (this: { activeMove: { id: string } }, item: Item, holder: Subject, source: Subject) => unknown;
	const project = (pokemon: AIPokemon): Subject => ({
		baseSpecies: dex.species.get(pokemon.baseSpecies || pokemon.species),
	});
	return (predicate as unknown as Predicate).call({ activeMove: { id: move.id } }, item,
		project(holder), project(source)) !== false;
}

/** Sticky Hold blocks removal utility, but does not block Knock Off's power boost. */
export function itemRemovalFailure(
	attacker: AIPokemon, target: AIPokemon, move: AIMove, field: FieldConditions
): string | undefined {
	if (knownItemless(target)) return 'Target has no item to remove';
	if (defensiveAbility(attacker, target, move, field) === 'stickyhold') return 'Sticky Hold prevents item removal';
	if (!itemAllowsRemoval(target, target, move, field)) return 'Target item cannot be removed';
}

export function flingFailure(pokemon: AIPokemon, move: AIMove, field: FieldConditions): string | undefined {
	const dex = rulesDex(field);
	const item = dex.items.get(pokemon.item);
	if (!item.id || pokemon.itemLost) return 'No item to fling';
	if (!item.isPrimalOrb && (field.magicroom || pokemon.volatiles.has('embargo') ||
		(dex.gen >= 5 && effectiveAbility(pokemon, field) === 'klutz'))) return 'Item is suppressed: Fling fails';
	if (!item.fling || !itemAllowsRemoval(pokemon, pokemon, move, field)) return 'Cannot fling this item';
}

export function itemMoveFailure(
	attacker: AIPokemon, target: AIPokemon, move: AIMove, field: FieldConditions
): string | undefined {
	if (move.id === 'poltergeist' && knownItemless(target)) return 'Poltergeist requires the target to hold an item';
	if (move.id === 'fling') return flingFailure(attacker, move, field);
	if (move.id === 'naturalgift' && !rulesDex(field).items.get(effectiveItem(attacker, field)).naturalGift) {
		return 'Natural Gift requires an active berry';
	}
	if (move.id === 'recycle') {
		if (attacker.item && !attacker.itemLost) return 'Already holding an item';
		if (attacker.recyclableItem === '') return 'No consumed item to recycle';
	}
	if (move.id !== 'trick' && move.id !== 'switcheroo') return;
	// PS checks Trick's immunity before Mold Breaker suppresses defending events.
	if (effectiveAbility(target, field) === 'stickyhold') return 'Sticky Hold prevents item swap';
	if (knownItemless(attacker) && knownItemless(target)) return 'Neither Pokemon has an item to swap';
	const dex = rulesDex(field);
	if (dex.gen <= 4 && [attacker, target].some(p => p.itemKnockedOff)) {
		return 'Knock Off prevents item exchange in Gen 3–4';
	}
	if (dex.gen <= 4 && [attacker, target].some(p => effectiveAbility(p, field) === 'multitype')) {
		return 'Multitype prevents item swap';
	}
	// Trick checks both removal and receipt, including an item becoming bound to its new holder.
	if (!itemAllowsRemoval(attacker, attacker, move, field) ||
		!itemAllowsRemoval(target, attacker, move, field) ||
		!itemAllowsRemoval(target, attacker, move, field, attacker.item) ||
		!itemAllowsRemoval(attacker, target, move, field, target.item)) return 'Cannot swap species-bound items';
}
