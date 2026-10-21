/**
 * CFRU ai_master.c:PredictMovesForBanks / ai_advanced.c:PredictFightingStyle.
 * Predictions use revealed moves plus explicit presets, never the simulator's hidden team or choices.
 * Roles and predictions are estimates; they are not written back to BattleTracker.
 */
import { FS } from '../../../../lib';
import { Dex, toID } from '../../../../sim/dex';
import {
	DISCOURAGED_SCORE, type AIPokemon, type AIMove, type BattleState, type MoveScore,
	type OpponentModel as OpponentHypothesis,
} from '../cfru/types';
export type { OpponentModel as OpponentHypothesis } from '../cfru/types';
import { calculateDamage } from '../cfru/util/damage-calc';
import { compareActionOrder } from '../cfru/util/speed';
import { effectiveItem, replaceActivePokemon } from '../cfru/util/mechanics';
import { inferRandomBattle } from '../cfru/util/random-presets';
import { canRestoreUserHp, mustSkipMove } from '../cfru/util/move-effects';
import { buildAIMove } from '../cfru/state-builder';
import {
	computeStatsFromPreset, getOpponentPreset, getOpponentMoveKnowledge,
	canHaveOpponentMoves, compatibleMoveSlots, presetSpeciesId,
} from '../cfru/util/opponent-presets';

export type FightingStyle = 'attacker' | 'setup' | 'stall' | 'hazards' | 'screens' | 'cleric' | 'phazer' |
	'batonpass' | 'trickroom' | 'support';

export function fightingStyle(pokemon: AIPokemon, formatId: string): FightingStyle {
	const dex = formatId ? Dex.forFormat(formatId) : Dex;
	const knowledge = pokemon.moveKnowledge;
	const moves = (knowledge ? [...knowledge.revealedMoves, ...knowledge.presetCandidates] : pokemon.moves)
		.map(id => dex.moves.get(id));
	const ids = moves.map(m => m.id as string);
	const together = (group: string[]) => knowledge ?
		canHaveOpponentMoves(knowledge, group) : group.every(id => ids.includes(id));
	// A role describes the loadout, so temporary item suppression does not change this classification.
	if (['choiceband', 'choicespecs', 'choicescarf', 'assaultvest'].includes(toID(pokemon.item))) return 'attacker';
	if (ids.includes('batonpass')) return 'batonpass';
	if (ids.includes('trickroom')) return 'trickroom';
	if (ids.some(m => ['haze', 'clearsmog', 'roar', 'whirlwind'].includes(m))) return 'phazer';
	if (ids.some(m => ['wish', 'healbell', 'aromatherapy'].includes(m))) return 'cleric';
	if (ids.includes('auroraveil') || together(['reflect', 'lightscreen'])) {
		return 'screens';
	}
	if (ids.some(m => ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(m))) return 'hazards';
	if (moves.some(m => m.category === 'Status' && m.target === 'self' &&
		Object.values(m.boosts || {}).some(n => n && n > 0))) return 'setup';
	const attacks = moves.filter(m => m.category !== 'Status').map(m => m.id);
	if (attacks.some((a, i) => attacks.slice(i + 1).some((b, j) =>
		attacks.slice(i + j + 2).some(c => together([a, b, c]))))) return 'attacker';
	if (moves.some(m => canRestoreUserHp(m, { formatId }) || m.id === 'toxic')) return 'stall';
	return 'support';
}

/** Read format-specific metadata and the power encoded in Return/Frustration names. */
export function hardMove(id: string, slot: number, formatId: string): AIMove {
	const dex = formatId ? Dex.forFormat(formatId) : Dex;
	const power = /^(return|frustration)(\d+)$/.exec(toID(id));
	const move = dex.moves.get(power ? power[1] : id);
	return {
		...buildAIMove({ id: move.id }, slot, formatId), type: move.type, category: move.category,
		basePower: power ? Number(power[2]) : ['return', 'frustration'].includes(move.id) ? 102 : move.basePower,
		accuracy: move.accuracy, priority: move.priority, target: move.target,
		flags: move.flags, status: move.status, boosts: move.boosts, recoil: move.recoil,
		multihit: move.multihit || null, secondaryChance: move.secondary?.chance || 0,
	};
}

interface StrategySet {
	name: string;
	abilities: string[];
	items: string[];
	natures: string[];
	moves: string[][];
	evs: Partial<AIPokemon['baseStats']>[];
	ivs?: Partial<AIPokemon['baseStats']>[];
}

const strategyFormats: Record<string, string> = {
	gen6ou: 'gen6ou', gen6customgame: 'gen6ou', gen7ou: 'gen7ou', gen7customgame: 'gen7ou',
};
const strategies = new Map<string, Record<string, StrategySet[]>>();
function strategyData(formatId: string): Record<string, StrategySet[]> {
	const source = strategyFormats[toID(formatId)];
	if (!source) return {};
	if (!strategies.has(source)) {
		strategies.set(source, JSON.parse(FS(`data/npc/strategies/${source}.json`).readSync()).species);
	}
	return strategies.get(source)!;
}

/** A revealed move must occupy a distinct slot, including overlapping slash options. */
export function compatibleSlots(slots: string[][], revealed: string[]): boolean {
	return compatibleMoveSlots(slots, revealed);
}

/** Recomputed from tracker evidence: an inference never becomes a public observation. */
export function inferOpponent(opponent: AIPokemon, formatId: string): OpponentHypothesis[] {
	if (opponent.volatiles.has('transform')) {
		const knowledge = opponent.moveKnowledge;
		const moves = [...new Set(knowledge ? [...knowledge.revealedMoves, ...knowledge.presetCandidates] : opponent.moves)];
		return [{ name: 'transform', pokemon: opponent, matched: true, weight: 1,
			moves: moves.map(id => ({ id: toID(id), availability: 1 })) }];
	}
	const randomModels = opponent.presetModels || inferRandomBattle(opponent, formatId);
	if (randomModels) return randomModels;
	const dex = formatId ? Dex.forFormat(formatId) : Dex;
	const species = dex.species.get(opponent.species);
	const revealed: string[] = [...new Set(opponent.moves.map(toID))];
	const data = strategyData(formatId);
	// Forme identity comes from public protocol, never from a guessed Mega Stone.
	const sets = data[species.id] || data[presetSpeciesId(opponent.species, formatId)] || [];
	const hypotheses: OpponentHypothesis[] = [];
	for (const set of sets) {
		if (!compatibleSlots(set.moves, revealed)) continue;
		const originalItem = toID(opponent.originalItem ||
			(opponent.itemKnown && !opponent.itemChanged && !opponent.itemLost ? opponent.item : ''));
		const items = set.items.filter(item => (!originalItem || item === originalItem) &&
			(!species.isMega || dex.items.get(item).megaStone?.[species.baseSpecies] === species.name));
		const native = toID(opponent.observedAbility);
		// Sources sometimes list the Mega ability even for a pre-evolution set.
		const abilities = species.isMega ? [toID(species.abilities[0])] :
			set.abilities.map(a => Object.values(species.abilities).some(b => toID(b) === a) ? a : toID(species.abilities[0]));
		const possibleAbilities = [...new Set(abilities)].filter(a => !native || a === native);
		if (!items.length || !possibleAbilities.length) continue;
		const candidates = [...new Set([...revealed, ...set.moves.flat()])].filter(id =>
			!(id === 'hiddenpower' && set.moves.flat().some(m => m.startsWith('hiddenpower'))));
		const moves = candidates.filter(id => dex.moves.get(id).exists &&
			(revealed.includes(id) || compatibleSlots(set.moves,
				[...revealed.filter(m => !(m === 'hiddenpower' && id.startsWith('hiddenpower'))), id]))).map(id => ({
			id, availability: revealed.includes(id) ? 1 : Math.min(1,
				set.moves.reduce((n, slot) => n + (slot.includes(id) ? 1 / slot.length : 0), 0)),
		}));
		const variants: OpponentHypothesis[] = [];
		for (const item of items) for (const ability of possibleAbilities) for (const nature of set.natures) {
			for (const evs of set.evs) for (const ivs of set.ivs || [{}]) {
				const stats = computeStatsFromPreset(species.baseStats, opponent.level, {
					nature: dex.natures.get(nature).name, evs, ivs,
				});
				if (species.baseStats.hp === 1) stats.hp = 1;
				variants.push({
					name: set.name, matched: true, weight: 0, moves,
					pokemon: { ...opponent, baseStats: stats, maxHp: stats.hp,
						moveKnowledge: { revealedMoves: revealed, presetCandidates: moves.map(m => m.id).filter(id =>
							!revealed.includes(id)), remainingSlots: Math.max(0, 4 - revealed.length), slots: set.moves },
						hp: Math.max(opponent.fainted ? 0 : 1, Math.floor(stats.hp * opponent.hpPercent / 100)),
						item: opponent.itemKnown ? opponent.item : item,
						ability: opponent.abilityChanged ? opponent.ability : (opponent.ability || ability),
					},
				});
			}
		}
		for (const variant of variants) variant.weight = 1 / variants.length;
		hypotheses.push(...variants);
	}
	if (hypotheses.length) {
		const total = hypotheses.reduce((n, h) => n + h.weight, 0);
		return hypotheses.map(h => ({ ...h, weight: h.weight / total }));
	}
	// Every format shares this fallback, including species absent from a tier and out-of-book sets.
	const preset = getOpponentPreset(opponent.species, formatId);
	const knowledge = getOpponentMoveKnowledge(opponent.species, opponent.moves, formatId);
	const stats = computeStatsFromPreset(species.baseStats, opponent.level, preset || {});
	if (species.baseStats.hp === 1) stats.hp = 1;
	const fallback = { ...opponent, baseStats: stats, maxHp: stats.hp, moveKnowledge: knowledge,
		hp: Math.max(opponent.fainted ? 0 : 1, Math.floor(stats.hp * opponent.hpPercent / 100)),
		item: opponent.itemKnown || opponent.itemLost ? opponent.item : (preset?.item || ''),
	};
	const moves = [...knowledge.revealedMoves, ...knowledge.presetCandidates];
	// Unknown coverage is not evidence of zero threat. Use learnable STAB attacks as a conservative fallback.
	if (knowledge.remainingSlots && !moves.some(id => dex.moves.get(id).category !== 'Status')) {
		const learnset = dex.species.getLearnsetData(species.id).learnset ||
			dex.species.getLearnsetData(toID(species.baseSpecies)).learnset || {};
		for (const type of species.types) {
			const attack = Object.keys(learnset).map(id => dex.moves.get(id)).filter(m =>
				m.type === type && m.category !== 'Status' && m.basePower > 0 && m.basePower <= 100 &&
				learnset[m.id]?.some(source => Number(source[0]) <= dex.gen))
				.sort((a, b) => b.basePower - a.basePower)[0];
			if (attack && !moves.includes(attack.id)) {
				moves.push(attack.id);
				knowledge.presetCandidates.push(attack.id);
			}
		}
	}
	return [{ name: preset ? 'default' : 'unmatched', matched: false, weight: 1, pokemon: fallback,
		moves: moves.map(id => ({ id, availability: revealed.includes(toID(id)) ? 1 : 0.25 })),
	}];
}

/**
 * Open formats can contain sets absent from the catalogue. Generate complete, legal stat profiles
 * around the existing move priors; evidence.ts decides which of these explanations remain plausible.
 * This does not add moves to observations or allow a random-battle set outside its published pool.
 */
export function* alternativeOpponentModels(
	opponent: AIPokemon, models: OpponentHypothesis[], formatId: string
): Generator<OpponentHypothesis> {
	if (opponent.presetModels || formatId.includes('randombattle')) return;
	const dex = Dex.forFormat(formatId);
	const species = dex.species.get(opponent.species);
	if (!species.exists || dex.gen < 3) return;
	const preset = getOpponentPreset(opponent.species, formatId);
	const sets = strategyData(formatId)[presetSpeciesId(opponent.species, formatId)] || [];
	// Public item identity, including a consumed item, constrains the original configuration.
	const fixedItem = toID(opponent.originalItem || (opponent.itemKnown ? opponent.item : ''));
	const items = fixedItem || opponent.itemKnown || opponent.itemLost ? [fixedItem] : [...new Set([
		...models.map(m => toID(m.pokemon.item)), ...sets.flatMap(s => s.items), toID(preset?.item),
		'choiceband', 'choicespecs', 'choicescarf', 'lifeorb', 'leftovers', 'assaultvest', 'eviolite',
	])];
	const abilities = opponent.observedAbility ? [toID(opponent.observedAbility)] :
		[...new Set(Object.values(species.abilities).map(toID))].filter(id => dex.abilities.get(id).gen <= dex.gen);
	const seen = new Set<string>();
	for (const model of models) {
		// Each profile spends at most 508 EVs. Never combine max attack, defenses and speed independently.
		const profiles: { name: string, stats: AIPokemon['baseStats'], prior: number }[] = [
			{ name: 'prior spread', stats: model.pokemon.baseStats, prior: 4 },
		];
		const add = (name: string, nature: string, evs: Partial<AIPokemon['baseStats']>,
			ivs?: Partial<AIPokemon['baseStats']>) => profiles.push({ name,
			stats: computeStatsFromPreset(species.baseStats, opponent.level, { nature, evs, ivs }), prior: 1 });
		if (preset?.evs) add('default spread', preset.nature || 'Hardy', preset.evs, preset.ivs);
		for (const set of sets) for (const nature of set.natures) for (const evs of set.evs) {
			for (const ivs of set.ivs || [{}]) add(`${set.name} spread`, dex.natures.get(nature).name, evs, ivs);
		}
		const categories = new Set(model.moves.map(m => dex.moves.get(m.id).category));
		const physical = categories.has('Physical'), special = categories.has('Special');
		if (physical) {
			add('fast physical', 'Jolly', { atk: 252, spe: 252, spd: 4 });
			add('strong physical', 'Adamant', { atk: 252, spe: 252, spd: 4 });
			add('bulky physical', 'Adamant', { hp: 252, atk: 252, spd: 4 });
		}
		if (special) {
			add('fast special', 'Timid', { spa: 252, spe: 252, spd: 4 });
			add('strong special', 'Modest', { spa: 252, spe: 252, spd: 4 });
			add('bulky special', 'Modest', { hp: 252, spa: 252, spd: 4 });
		}
		add('physical wall', physical ? 'Impish' : 'Bold', { hp: 252, def: 252, spd: 4 });
		add('special wall', physical ? 'Careful' : 'Calm', { hp: 252, spd: 252, def: 4 });
		if (physical && special) add('mixed attacker', 'Naive', { atk: 128, spa: 128, spe: 252 });
		const uniqueProfiles = profiles.filter((profile, i) => profiles.findIndex(p =>
			JSON.stringify(p.stats) === JSON.stringify(profile.stats)) === i);
		for (const item of items) {
			const data = dex.items.get(item);
			if (item && (!data.exists || data.gen > dex.gen)) continue;
			if (item === 'eviolite' && !species.nfe) continue;
			const exchangesItem = model.moves.some(m => ['trick', 'switcheroo'].includes(m.id));
			if (!fixedItem && !exchangesItem &&
				(item === 'choiceband' && !physical || item === 'choicespecs' && !special)) continue;
			if (species.requiredItems?.length && !species.requiredItems.some(id => toID(id) === item)) continue;
			if (species.isMega && data.megaStone?.[species.baseSpecies] !== species.name) continue;
			// An actual Mega stone cannot coexist with an invented Choice item before Mega evolution either.
			if (data.megaStone && !data.megaStone[species.baseSpecies]) continue;
			const moves = model.moves.filter(m => item !== 'assaultvest' || dex.moves.get(m.id).category !== 'Status');
			if (item === 'assaultvest' && opponent.moves.some(id => dex.moves.get(id).category === 'Status')) continue;
			for (const ability of abilities) for (const profile of uniqueProfiles) {
				const key = JSON.stringify([item, ability, profile.stats, moves, model.pokemon.moveKnowledge]);
				if (seen.has(key)) continue;
				seen.add(key);
				const stats = profile.stats;
				yield { ...model, name: `inferred ${data.name || 'no item'}, ${profile.name}, ${ability}`,
					matched: false, weight: model.weight * profile.prior, moves,
					pokemon: { ...model.pokemon, baseStats: stats, maxHp: stats.hp,
						hp: Math.max(opponent.fainted ? 0 : 1, Math.floor(stats.hp * opponent.hpPercent / 100)),
						item: opponent.itemLost ? '' : item, itemAssumed: true,
						ability: opponent.abilityChanged ? opponent.ability : ability,
					},
				};
			}
		}
	}
}

export interface PredictedAction {
	move: AIMove | null;
	/** The selected action can call a different move (for example, Sleep Talk). */
	selectedMove?: AIMove;
	/** Heuristic weights, not measured player frequencies. */
	weight: number;
	switching: boolean;
	/** Each response retains its own item, ability, EV and nature hypothesis. */
	user?: AIPokemon;
	preset?: string;
}

export function predictOpponent(
	state: BattleState, opponent: AIPokemon, target: AIPokemon, formatId: string,
	score: (state: BattleState, actor: AIPokemon, moves: AIMove[], target: AIPokemon) => MoveScore[],
	hypotheses = inferOpponent(opponent, formatId), switchConfidence = 0.6
): PredictedAction[] {
	const dex = formatId ? Dex.forFormat(formatId) : Dex;
	const actions: PredictedAction[] = [];
	for (const hypothesis of hypotheses) {
		const user = hypothesis.pokemon;
		const projected = replaceActivePokemon(state, opponent, user);
		let candidates = hypothesis.moves.filter(m => dex.moves.get(m.id).exists &&
			dex.moves.get(m.id).isNonstandard !== 'Future' &&
			(!user.moveKnowledge || canHaveOpponentMoves(user.moveKnowledge, [m.id])));
		if (user.lastMove && ['choiceband', 'choicespecs', 'choicescarf'].includes(effectiveItem(user, projected.field))) {
			candidates = candidates.filter(m => toID(m.id) === toID(user.lastMove) ||
				toID(user.lastMove) === 'hiddenpower' && m.id.startsWith('hiddenpower'));
		}
		if (user.lastMove) candidates = candidates.filter(m => m.id !== 'fakeout');
		if (user.volatiles.has('taunt')) candidates = candidates.filter(m => dex.moves.get(m.id).category !== 'Status');
		if (user.status === 'slp' && (user.sleepTurns || 0) > 1) {
			candidates = candidates.filter(m => dex.moves.get(m.id).sleepUsable);
		}
		if (!candidates.length || mustSkipMove(user, candidates.map(m => m.id), projected.field)) {
			actions.push({ move: null, weight: hypothesis.weight, switching: false, user, preset: hypothesis.name });
			continue;
		}
		// Score each response conditional on that move occupying a slot. Unconfirmed alternatives
		// stay in knowledge, not in a fabricated five-move loadout passed to the shared scorers.
		const scores = candidates.map(candidate => {
			const known = user.moveKnowledge?.revealedMoves || user.moves.map(toID);
			const conditional = { ...user, moves: [...new Set([...known, candidate.id])].filter(id =>
				!(id === 'hiddenpower' && candidate.id !== 'hiddenpower' && candidate.id.startsWith('hiddenpower'))) };
			const conditionalState = replaceActivePokemon(state, opponent, conditional);
			return score({ ...conditionalState, self: conditionalState.opponent, opponent: conditionalState.self }, conditional,
				[hardMove(candidate.id, 1, formatId)], target)[0];
		});
		const best = Math.max(...scores.map(m => m.score));
		// CFRU's all-bad-moves switch prediction is evidence, never certainty.
		const owner = user.ownerSide;
		const remaining = owner && state.opponent.remainingByOwner ?
			state.opponent.remainingByOwner[owner] : state.opponent.remaining;
		const ownParty = (p: AIPokemon) => !p.fainted && (!owner || p.ownerSide === owner);
		const canSwitch = (remaining || 0) > state.opponent.active.filter(ownParty).length ||
			state.opponent.reserve.some(ownParty);
		const attacks = target.moves.map((id, i) => hardMove(id, i + 1, formatId)).filter(m => m.category !== 'Status');
		const userCanFinish = scores.some(s => s.flags.canKO && !s.flags.hasNoEffect && attacks.every(attack =>
			compareActionOrder(user, target, s.move, [attack], projected.field,
				projected.opponent.conditions, projected.self.conditions) > 0));
		const threatened = !userCanFinish && attacks.some(attack => {
			const damage = calculateDamage(target, user, attack, projected.field, undefined, {
				isDoubles: projected.isDoubles, numAliveTargets: projected.opponent.active.filter(p => !p.fainted).length,
				attackerSideConditions: projected.self.conditions, defenderSideConditions: projected.opponent.conditions,
				activePokemon: [...projected.self.active, ...projected.opponent.active], defenderAllies: projected.opponent.active,
			});
			return damage.average >= user.hp && scores.some(s => s.score >= best - 5 &&
				compareActionOrder(target, user, attack, [s.move], projected.field,
					projected.self.conditions, projected.opponent.conditions) > 0);
		});
		// Slightly weak moves are weaker evidence than no useful action or an imminent first-strike KO.
		const retreatSignal = threatened ? 1 : Math.max(0, Math.min(1, (100 - best) / (100 - DISCOURAGED_SCORE)));
		const switchWeight = canSwitch && !user.volatiles.has('trapped') ? switchConfidence * retreatSignal : 0;
		if (switchWeight) actions.push({ move: null, weight: hypothesis.weight * switchWeight,
			switching: true, user, preset: hypothesis.name });
		const weighted = scores.map((result, i) => ({ result,
			weight: candidates[i].availability * Math.exp(Math.max(-12, (result.score - best) / 8)),
		}));
		const total = weighted.reduce((sum, a) => sum + a.weight, 0);
		for (const { result, weight } of weighted) {
			const probability = hypothesis.weight * (1 - switchWeight) * weight / total;
			if (result.move.id === 'sleeptalk' && !result.flags.hasNoEffect) {
				const called = hypothesis.moves.filter(candidate => {
					const move = dex.moves.get(candidate.id);
					return move.exists && !move.flags.nosleeptalk && !move.flags.charge && !move.isZ && !move.isMax &&
						(!user.moveKnowledge || canHaveOpponentMoves(user.moveKnowledge, ['sleeptalk', candidate.id]));
				});
				const available = called.reduce((sum, candidate) => sum + candidate.availability, 0);
				if (available) {
					for (const candidate of called) actions.push({
						move: hardMove(candidate.id, 1, formatId), selectedMove: result.move,
						weight: probability * candidate.availability / available,
						switching: false, user, preset: hypothesis.name,
					});
					continue;
				}
			}
			actions.push({ move: result.move, weight: probability, switching: false, user, preset: hypothesis.name });
		}
	}
	return actions;
}
