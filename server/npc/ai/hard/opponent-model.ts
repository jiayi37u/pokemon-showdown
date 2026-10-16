/**
 * CFRU ai_master.c:PredictMovesForBanks / ai_advanced.c:PredictFightingStyle.
 * Predictions use revealed moves plus explicit presets, never the simulator's hidden team or choices.
 * Roles and predictions are estimates; they are not written back to BattleTracker.
 */
import { FS } from '../../../../lib';
import { Dex, toID } from '../../../../sim/dex';
import type { AIPokemon, AIMove, BattleState, MoveScore, OpponentModel as OpponentHypothesis } from '../cfru/types';
export type { OpponentModel as OpponentHypothesis } from '../cfru/types';
import { inferRandomBattle } from '../cfru/util/random-presets';
import { buildAIMove } from '../cfru/state-builder';
import {
	computeStatsFromPreset, getOpponentPreset, getOpponentMoveKnowledge, canHaveOpponentMoves, compatibleMoveSlots,
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
	if (moves.some(m => m.heal || ['rest', 'leechseed', 'toxic'].includes(m.id))) return 'stall';
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

const strategyFormats: Record<string, string> = { gen7ou: 'gen7ou', gen7customgame: 'gen7ou' };
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
	const sets = data[species.id] || [];
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

export interface PredictedAction {
	move: AIMove | null;
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
	hypotheses = inferOpponent(opponent, formatId)
): PredictedAction[] {
	const dex = formatId ? Dex.forFormat(formatId) : Dex;
	const actions: PredictedAction[] = [];
	for (const hypothesis of hypotheses) {
		const user = hypothesis.pokemon;
		let candidates = hypothesis.moves.filter(m => dex.moves.get(m.id).exists &&
			dex.moves.get(m.id).isNonstandard !== 'Future' &&
			(!user.moveKnowledge || canHaveOpponentMoves(user.moveKnowledge, [m.id])));
		if (user.lastMove && ['choiceband', 'choicespecs', 'choicescarf'].includes(toID(user.item))) {
			candidates = candidates.filter(m => toID(m.id) === toID(user.lastMove));
		}
		if (user.lastMove) candidates = candidates.filter(m => m.id !== 'fakeout');
		if (user.volatiles.has('taunt')) candidates = candidates.filter(m => dex.moves.get(m.id).category !== 'Status');
		if (!candidates.length) {
			actions.push({ move: null, weight: hypothesis.weight, switching: false, user, preset: hypothesis.name });
			continue;
		}
		// Score each response conditional on that move occupying a slot. Unconfirmed alternatives
		// stay in knowledge, not in a fabricated five-move loadout passed to the shared scorers.
		const scores = candidates.map(candidate => {
			const known = user.moveKnowledge?.revealedMoves || user.moves.map(toID);
			const conditional = { ...user, moves: [...new Set([...known, candidate.id])].filter(id =>
				!(id === 'hiddenpower' && candidate.id !== 'hiddenpower' && candidate.id.startsWith('hiddenpower'))) };
			const side = { ...state.opponent,
				active: state.opponent.active.map(p => p === opponent ? conditional : p),
				team: state.opponent.team.map(p => p === opponent ? conditional : p),
			};
			return score({ ...state, self: side, opponent: state.self }, conditional,
				[hardMove(candidate.id, 1, formatId)], target)[0];
		});
		const best = Math.max(...scores.map(m => m.score));
		// CFRU's all-bad-moves switch prediction is evidence, never certainty.
		const canSwitch = (state.opponent.remaining || 0) > state.opponent.active.filter(p => !p.fainted).length ||
			state.opponent.reserve.some(p => !p.fainted);
		const switchWeight = best < 100 && canSwitch ? 0.6 : 0;
		if (switchWeight) actions.push({ move: null, weight: hypothesis.weight * switchWeight,
			switching: true, user, preset: hypothesis.name });
		const weighted = scores.map((result, i) => ({ result,
			weight: candidates[i].availability * Math.exp(Math.max(-12, (result.score - best) / 8)),
		}));
		const total = weighted.reduce((sum, a) => sum + a.weight, 0);
		for (const { result, weight } of weighted) {
			actions.push({ move: result.move, weight: hypothesis.weight * (1 - switchWeight) * weight / total,
				switching: false, user, preset: hypothesis.name });
		}
	}
	return actions;
}
