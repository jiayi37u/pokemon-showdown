/**
 * Public random-battle rules, shared by Normal and Hard. The generator here is a separate,
 * deterministic instance: it never receives a battle, generated team, or battle PRNG.
 * Source roles are authoritative. Bounded expansion reuses the actual move/item/stat rules;
 * unfinished expansion retains a conservative role envelope, never treats missing samples as proof.
 */
import { Dex, toID } from '../../../../../sim/dex';
import { Teams } from '../../../../../sim/teams';
import type { AIPokemon, OpponentModel, OpponentMoveKnowledge } from '../types';
import { compatibleMoveSlots, computeStatsFromPreset, canHaveOpponentMoves } from './opponent-presets';
import { formeAbility } from './mechanics';

type RandomSet = RandomTeamsTypes.RandomSet;
interface RandomGenerator {
	dex: ModdedDex;
	maxMoveCount: number;
	randomSets: Record<string, RandomTeamsTypes.RandomSpeciesData>;
	randomDoublesSets: Record<string, RandomTeamsTypes.RandomSpeciesData>;
	getLevel(species: Species, doubles?: boolean): number;
	getForme(species: Species): string;
	randomSet(species: string, team: RandomTeamsTypes.TeamDetails, lead: boolean, doubles: boolean): RandomSet;
	randomMoveset(...args: unknown[]): Set<string>;
	sample<T>(options: readonly T[]): T;
	sampleNoReplace(options: string[]): string | null;
	fastPop(options: string[], index: number): string;
	randomChance(numerator: number, denominator: number): boolean;
	random(): number;
}
interface Expansion {
	sets: RandomSet[];
	complete: boolean;
}
interface Source {
	generator: RandomGenerator;
	data: Record<string, RandomTeamsTypes.RandomSpeciesData>;
	doubles: boolean;
	forms: Map<string, string[]>;
	expansions: Map<string, Expansion>;
}

const sources = new Map<string, Source>();
const EXPANSION_LIMIT = 1024;
// These generators expose the same role-based randomSet contract. Factory and arbitrary custom
// generators are deliberately not interpreted as these formats just because their name says random.
const supportedMods = new Set(['gen5', 'gen6', 'gen7', 'gen9', 'mmo']);

function sourceFor(formatId: string): Source | null {
	if (!formatId) return null;
	const format = Dex.formats.get(formatId);
	if (format.team !== 'random' || !supportedMods.has(format.mod)) return null;
	const key = formatId;
	if (!sources.has(key)) {
		const generator: RandomGenerator = Teams.getGenerator(format, '1,2,3,4');
		// Gen 9 uses doubles sets for Multi too. The older generators (including MMO) use singles sets.
		const doubles = format.mod === 'gen9' && format.gameType !== 'singles';
		const data = doubles ? generator.randomDoublesSets : generator.randomSets;
		if (!data) return null;
		sources.set(key, { generator, data, doubles, forms: new Map(), expansions: new Map() });
	}
	return sources.get(key)!;
}

class Branch extends Error {
	readonly size: number;
	constructor(size: number) {
		super('Unexplored public generator choice');
		this.size = size;
	}
}

class ImpossibleConfiguration extends Error {}

/** Enumerate public choices by replay, stopping before unbounded combinatorics block a request. */
function expand(source: Source, id: string, roleIndex: number, relaxed = false): Expansion {
	const key = `${id}:${roleIndex}:${relaxed}`;
	const cached = source.expansions.get(key);
	if (cached) return cached;
	const role = source.data[id].sets[roleIndex];
	const data = { [id]: { ...source.data[id], sets: [role] } };
	const combinations: string[][] = [];
	if (relaxed) {
		const pool = role.movepool.map(toID);
		const count = Math.min(pool.length, source.generator.maxMoveCount);
		const collect = (start: number, moves: string[]) => {
			if (moves.length === count) { combinations.push(moves); return; }
			for (let i = start; i <= pool.length - count + moves.length; i++) {
				if (pool[i].startsWith('hiddenpower') && moves.some(m => m.startsWith('hiddenpower'))) continue;
				collect(i + 1, [...moves, pool[i]]);
			}
		};
		collect(0, []);
	}
	const pending: number[][] = [[]];
	const sets = new Map<string, RandomSet>();
	let visits = 0;
	while (pending.length && visits++ < (relaxed ? 16384 : EXPANSION_LIMIT)) {
		const path = pending.pop()!;
		let cursor = 0;
		const choose = <T>(options: readonly T[]): T => {
			if (!options.length) throw new ImpossibleConfiguration();
			if (options.length <= 1) return options[0];
			if (cursor === path.length) throw new Branch(options.length);
			return options[path[cursor++]];
		};
		const generator: RandomGenerator = Object.create(source.generator);
		if (source.doubles) generator.randomDoublesSets = data;
		else generator.randomSets = data;
		generator.sample = choose;
		if (relaxed) generator.randomMoveset = () => new Set(choose(combinations));
		generator.sampleNoReplace = (list: string[]) => {
			if (!list.length) return null;
			const value = choose(list);
			generator.fastPop(list, list.indexOf(value));
			return value;
		};
		// Cosmetic choices are irrelevant to the configuration and use an isolated fixed PRNG.
		generator.getForme = (species: Species) => typeof species.battleOnly === 'string' ? species.battleOnly : species.name;
		generator.random = () => 0;
		generator.randomChance = (n: number, d: number) => d === 1024 ? false :
			choose(n === 0 ? [false] : n === d ? [true] : [false, true]);
		const flags: Record<string, number> = {};
		const team = new Proxy({}, {
			get(_target, property: string) {
				// Spikes is a count; all other generator team facts are boolean presences.
				return flags[property] ?? (flags[property] = choose(property === 'spikes' ? [0, 1, 2] : [0, 1]));
			},
		});
		try {
			const lead = choose([false, true]);
			const set: RandomSet = generator.randomSet(id, team, lead, source.doubles);
			const moves = set.moves.map(toID).sort();
			const signature = JSON.stringify([moves, set.ability, set.item, set.evs, set.ivs]);
			sets.set(signature, { ...set, moves });
		} catch (error) {
			if (error instanceof ImpossibleConfiguration) continue;
			if (!(error instanceof Branch)) throw error;
			for (let i = error.size - 1; i >= 0; i--) pending.push([...path, i]);
		}
	}
	// When selection-order permutations are too large, enumerate a superset of four-move
	// combinations instead. Ability, item and IV/EV rules still run unchanged. This may retain
	// impossible combinations, but cannot exclude a real set merely because it wasn't sampled.
	const result = pending.length && !relaxed ? expand(source, id, roleIndex, true) :
		{ sets: [...sets.values()], complete: pending.length === 0 };
	source.expansions.set(key, result);
	return result;
}

/** Form names that this public source entry can display before a battle-only forme change. */
function displayForms(source: Source, id: string): string[] {
	if (!source.forms.has(id)) {
		const species = source.generator.dex.species.get(id);
		const forms = new Set<string>();
		const generator: RandomGenerator = Object.create(source.generator);
		generator.sample = <T>(options: readonly T[]) => {
			for (const value of options) forms.add(toID(String(value)));
			return options[0];
		};
		forms.add(toID(generator.getForme(species)));
		// Include fully assembled names for getForme implementations that concatenate a sampled suffix.
		for (const forme of [species.name, ...(species.cosmeticFormes || []), ...(species.otherFormes || [])]) {
			const suffix = forme.slice(species.baseSpecies.length);
			if (forms.has(toID(suffix))) forms.add(toID(forme));
		}
		source.forms.set(id, [...forms]);
	}
	return source.forms.get(id)!;
}

function knowledge(revealed: string[], pools: string[][], count: number): OpponentMoveKnowledge {
	const remainingSlots = Math.max(0, count - revealed.length);
	const result: OpponentMoveKnowledge = {
		revealedMoves: revealed, presetCandidates: [], remainingSlots, movePools: pools,
	};
	// An untyped, observed Hidden Power can still have a typed hypothesis without using another slot.
	result.presetCandidates = [...new Set(pools.flat())].filter(id => !revealed.includes(id) &&
		(remainingSlots > 0 || (revealed.includes('hiddenpower') && id.startsWith('hiddenpower'))));
	result.presetCandidates = result.presetCandidates.filter(id => canHaveOpponentMoves(result, [id]));
	return result;
}

function originalItem(pokemon: AIPokemon): string {
	return toID(pokemon.originalItem ||
		(pokemon.itemKnown && !pokemon.itemChanged && !pokemon.itemLost ? pokemon.item : ''));
}

function possibleActions(known: OpponentMoveKnowledge): string[] {
	const moves = [...new Set([...known.revealedMoves, ...known.presetCandidates])];
	return moves.filter(id => id !== 'hiddenpower' ||
		!moves.some(move => move !== 'hiddenpower' && move.startsWith('hiddenpower')));
}

/** Null means this is not a supported random format. An unmatched random mon never inherits OU EVs. */
export function inferRandomBattle(opponent: AIPokemon, formatId: string): OpponentModel[] | null {
	const source = sourceFor(formatId);
	if (!source) return null;
	const dex = source.generator.dex;
	const species = dex.species.get(opponent.species);
	const currentFormeAbility = formeAbility(species);
	const previousForms = species.isMega ? [] :
		(typeof species.battleOnly === 'string' ? [species.battleOnly] : species.battleOnly || []).map(toID);
	const revealed: string[] = [...new Set(opponent.moves.map(toID))];
	const nativeItem = originalItem(opponent);
	const nativeAbility = toID(opponent.observedAbility);
	const models: OpponentModel[] = [];
	const create = (name: string, pool: string[], preset: Partial<RandomSet>, matched: boolean) => {
		const stats = computeStatsFromPreset(species.baseStats, opponent.level, preset);
		const moveKnowledge = knowledge(revealed, [pool], source.generator.maxMoveCount);
		const item = opponent.itemKnown || opponent.itemLost ? opponent.item : preset.item || '';
		const ability = opponent.abilityChanged || nativeAbility ? opponent.ability :
			currentFormeAbility || preset.ability || '';
		const pokemon: AIPokemon = {
			...opponent, presetModels: undefined, moveKnowledge, baseStats: stats, maxHp: stats.hp,
			hp: opponent.fainted ? 0 : Math.max(1, Math.floor(stats.hp * opponent.hpPercent / 100)),
			item, ability, itemAssumed: preset.item !== undefined,
		};
		const candidates = possibleActions(moveKnowledge);
		return { name, pokemon, matched, weight: 1,
			moves: candidates.map(id => ({ id, availability: revealed.includes(id) ? 1 :
			Math.min(1, moveKnowledge.remainingSlots / Math.max(1, moveKnowledge.presetCandidates.length)) })),
		};
	};
	for (const [id, data] of Object.entries(source.data)) {
		const entry = dex.species.get(id);
		if (species.id !== id && !displayForms(source, id).some(form =>
			form === species.id || previousForms.includes(toID(form)))) continue;
		if (source.generator.getLevel(entry, source.doubles) !== opponent.level) continue;
		for (const [index, role] of data.sets.entries()) {
			const pool = role.movepool.map(toID);
			if (!compatibleMoveSlots(pool.map(move => [move]), revealed)) continue;
			const abilities = currentFormeAbility ? [currentFormeAbility] : role.abilities || [];
			if (nativeAbility && !abilities.some(ability => toID(ability) === nativeAbility)) continue;
			if (nativeItem && entry.requiredItems && !entry.requiredItems.some(item => toID(item) === nativeItem)) continue;
			const expansion = expand(source, id, index);
			const compatible = expansion.sets.filter(set =>
				compatibleMoveSlots(set.moves.map(move => [move]), revealed) &&
				(!nativeItem || toID(set.item) === nativeItem) &&
				(!nativeAbility || !!currentFormeAbility || toID(set.ability) === nativeAbility));
			const name = `random:${id}:${role.role}`;
			if (expansion.complete) {
				const variants = compatible.map(set => create(name, set.moves, set, true));
				for (const variant of variants) variant.weight = 1 / variants.length;
				models.push(...variants);
			} else {
				// Only guaranteed source constraints may exclude a role when exhaustive expansion is unfinished.
				const item = entry.requiredItems?.length === 1 ? entry.requiredItems[0] : undefined;
				const ability = abilities.length === 1 ? abilities[0] : undefined;
				models.push(create(name, pool, { item, ability }, true));
			}
		}
	}
	if (!models.length) models.push(create('random:unmatched', revealed, {}, false));
	const total = models.reduce((sum, model) => sum + model.weight, 0);
	for (const model of models) model.weight /= total;
	// Equivalent stat/item/ability hypotheses share an evaluation; their movesets stay separate.
	const groups = new Map<string, OpponentModel[]>();
	for (const model of models) {
		const key = JSON.stringify([model.name, model.pokemon.baseStats, model.pokemon.item, model.pokemon.ability]);
		const group = groups.get(key) || [];
		group.push(model);
		groups.set(key, group);
	}
	return [...groups.values()].map(group => {
		const model = group[0];
		const pools = group.flatMap(h => h.pokemon.moveKnowledge!.movePools!);
		const moveKnowledge = knowledge(revealed, pools, source.generator.maxMoveCount);
		return { ...model, weight: group.reduce((sum, h) => sum + h.weight, 0),
			pokemon: { ...model.pokemon, moveKnowledge },
			moves: possibleActions(moveKnowledge).map(id => ({ id,
				availability: revealed.includes(id) ? 1 : pools.filter(pool => pool.includes(id)).length / pools.length,
			})),
		};
	});
}

/** Normal uses one representative spread, certain shared traits, and every compatible attack threat. */
export function applyRandomBattlePresets(opponent: AIPokemon, formatId: string): AIPokemon {
	const models = inferRandomBattle(opponent, formatId);
	if (!models) return opponent;
	const representative = models.reduce((best, model) => model.weight > best.weight ? model : best).pokemon;
	const items = new Set(models.map(model => model.pokemon.item));
	const abilities = new Set(models.map(model => model.pokemon.ability));
	const pools = models.flatMap(model => model.pokemon.moveKnowledge!.movePools!);
	return {
		...opponent, baseStats: representative.baseStats, maxHp: representative.maxHp, hp: representative.hp,
		item: opponent.itemKnown || opponent.itemLost ? opponent.item : items.size === 1 ? representative.item : '',
		ability: opponent.observedAbility || opponent.abilityChanged ? opponent.ability :
		abilities.size === 1 ? representative.ability : '',
		moveKnowledge: knowledge(opponent.moves.map(toID), pools, sourceFor(formatId)!.generator.maxMoveCount),
		presetModels: models,
	};
}
