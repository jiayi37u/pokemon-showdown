/** Build disposable PS battles from knowledge, never from the live Battle or its serialization. */
import { Battle } from '../../../../sim/battle';
import { Dex, toID } from '../../../../sim/dex';
import type { Pokemon } from '../../../../sim/pokemon';
import type { PokemonSet } from '../../../../sim/teams';
import type { AIPokemon, BattleState, OpponentModel } from '../cfru/types';
import { canHaveOpponentMoves } from '../cfru/util/opponent-presets';
import { buildPokemonFromRequest } from '../cfru/state-builder';
import { abilityStatModifier, normalizeWeather } from '../cfru/util/mechanics';

const stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const spreads = new Map<string, Pick<PokemonSet, 'ivs' | 'evs' | 'nature'> | null>();
const moveId = (id: string) => toID(id).replace(/^(return|frustration)\d+$/, '$1');

/** Requests expose stats, not spreads. Find a legal encoding with exactly those stats. */
function spread(p: AIPokemon, dex: ReturnType<typeof Dex.forFormat>) {
	const key = JSON.stringify([p.species, p.level, p.maxHp, p.baseStats]);
	if (spreads.has(key)) return spreads.get(key)!;
	const base = dex.species.get(p.species).baseStats;
	for (const nature of dex.natures.all()) {
		const ivs = {} as StatsTable, evs = {} as StatsTable;
		for (const stat of stats) {
			const target = stat === 'hp' ? p.maxHp : p.baseStats[stat];
			let found = false;
			for (let ev = 0; ev <= 63 && !found; ev++) for (let iv = 31; iv >= 0; iv--) {
				const raw = Math.floor((2 * base[stat] + iv + ev) * p.level / 100);
				const value = stat === 'hp' ? (base.hp === 1 ? 1 : raw + p.level + 10) :
					Math.floor((raw + 5) * (nature.plus === stat ? 110 : nature.minus === stat ? 90 : 100) / 100);
				if (value !== target) continue;
				ivs[stat] = iv; evs[stat] = ev * 4; found = true; break;
			}
			if (!found) break;
		}
		if (stats.every(s => ivs[s] !== undefined) && Object.values(evs).reduce((a, b) => a + b, 0) <= 510) {
			const result = { ivs, evs, nature: nature.name };
			if (spreads.size > 2048) spreads.clear();
			spreads.set(key, result);
			return result;
		}
	}
	spreads.set(key, null);
	return null;
}

/** One coherent moveset: slash alternatives never become a five/eight-move opponent. */
export function completeMoves(model: OpponentModel, variant: number): string[] {
	const knowledge = model.pokemon.moveKnowledge;
	const revealed = knowledge?.revealedMoves || model.pokemon.moves;
	// Rotate unknown choices only: revealed moves must not consume all the sampled offsets.
	const known = new Set(revealed.map(toID));
	const ordered = model.moves.filter(m => !known.has(toID(m.id))).sort((a, b) => b.availability - a.availability);
	const rotated = [...ordered.slice(variant % Math.max(1, ordered.length)),
		...ordered.slice(0, variant % Math.max(1, ordered.length))];
	// Protocol reveals "Hidden Power", while a preset supplies its possible type. They occupy one slot.
	const hiddenPower = rotated.find(m => m.id.startsWith('hiddenpower') && m.id !== 'hiddenpower')?.id;
	const moves = [...new Set(revealed.map(id => toID(id) === 'hiddenpower' && hiddenPower ? hiddenPower : toID(id)))];
	for (const candidate of rotated) {
		if (moves.length >= 4) break;
		if (candidate.id.startsWith('hiddenpower') && moves.some(id => id.startsWith('hiddenpower'))) continue;
		if (!moves.includes(candidate.id) && (!knowledge || canHaveOpponentMoves(knowledge, [...moves, candidate.id]))) {
			moves.push(candidate.id);
		}
	}
	return moves;
}

export interface Projection {
	battle: Battle;
	/** Simulation party order differs from the controller's request order. */
	self: AIPokemon[];
	opponent: AIPokemon[];
}

/** Read only a disposable, knowledge-built search world back into shared AI mechanics.
 * This adapter must never be passed the live battle: its opponent sets are hypotheses.
 */
export function projectedState(battle: Battle): BattleState {
	const side = (s: typeof battle.p1): BattleState['self'] => {
		const team = s.pokemon.map((p, index): AIPokemon => {
			const volatiles = new Set(Object.keys(p.volatiles));
			if (p.volatiles.perishsong) volatiles.add(`perish${p.volatiles.perishsong.duration}`);
			const moves = p.moveSlots.filter(m => m.pp > 0 && (!p.isActive || !m.disabled)).map(m => {
				if (m.id === 'hiddenpower') return `hiddenpower${p.hpType.toLowerCase()}`;
				if (m.id === 'return' || m.id === 'frustration') {
					const happiness = m.id === 'return' ? p.happiness : 255 - p.happiness;
					return `${m.id}${Math.max(1, Math.floor(happiness / 2.5))}`;
				}
				return m.id;
			});
			return { ...buildPokemonFromRequest({ details: `${p.species.name}, L${p.level}, ${p.gender || 'N'}`,
				condition: `${p.hp}/${p.maxhp}${p.status ? ` ${p.status}` : ''}`,
				stats: p.storedStats, ability: p.ability, item: p.item, moves }, index + 1, p.isActive, battle.format.id),
			ident: p.name, ownerSide: s.id, types: p.getTypes(), boosts: { ...p.boosts }, volatiles,
			fainted: p.fainted, baseSpecies: p.baseSpecies.name, lastMove: p.lastMove?.id || '',
			activeMoveActions: p.activeMoveActions, sleepTurns: p.statusState.time || 0,
			sleepSelfInflicted: p.statusState.source === p, toxicCounter: p.statusState.stage || 0,
			abilityStatMod: abilityStatModifier(volatiles), recyclableItem: p.lastItem,
			};
		});
		const conditions = s.sideConditions;
		return { team, active: team.filter(p => p.active), reserve: team.filter(p => !p.active), conditions: {
			stealthrock: !!conditions.stealthrock, spikes: conditions.spikes?.layers || 0,
			toxicspikes: conditions.toxicspikes?.layers || 0, stickyweb: !!conditions.stickyweb,
			reflect: conditions.reflect?.duration || 0, lightscreen: conditions.lightscreen?.duration || 0,
			auroraveil: conditions.auroraveil?.duration || 0, tailwind: conditions.tailwind?.duration || 0,
			safeguard: conditions.safeguard?.duration || 0, mist: conditions.mist?.duration || 0,
			wishes: {}, futureMoves: {},
		} };
	};
	return { turn: battle.turn, isDoubles: false, self: side(battle.p1), opponent: side(battle.p2), field: {
		formatId: battle.format.id, weatherId: battle.field.weather, weather: normalizeWeather(battle.field.weather),
		weatherTurns: battle.field.weatherState.duration || 0,
		terrain: battle.field.terrain.replace(/terrain$/, ''), terrainTurns: battle.field.terrainState.duration || 0,
		trickroom: !!battle.field.pseudoWeather.trickroom, trickroomTurns: battle.field.pseudoWeather.trickroom?.duration || 0,
		gravity: !!battle.field.pseudoWeather.gravity, magicroom: !!battle.field.pseudoWeather.magicroom,
		wonderroom: !!battle.field.pseudoWeather.wonderroom,
	} };
}

/** Missing effect payloads are explicit fallbacks, rather than silently invented battle mechanics. */
export function projectionUnsupported(state: BattleState): string | undefined {
	if (state.isDoubles) return 'requires singles';
	if (state.self.active.length !== 1 || state.opponent.active.length !== 1) return 'requires two active Pokemon';
	const dex = Dex.forFormat(state.field.formatId || 'gen6ou');
	if (dex.gen < 3 || dex.gen > 7) return 'generation mechanics outside projection coverage';
	if ((state.opponent.remaining || 0) > state.opponent.team.filter(p => !p.fainted).length +
		(state.opponent.preview?.length || 0)) return 'unseen party without preview';
	for (const side of [state.self, state.opponent]) {
		if (Object.keys(side.conditions.wishes).length || Object.keys(side.conditions.futureMoves).length) {
			return 'delayed effect source unavailable';
		}
		for (const p of side.team) {
			if (p.abilityChanged || p.terastallized || p.types.join() !== dex.species.get(p.species).types.join()) {
				return 'temporary identity requires effect payload';
			}
			for (const effect of p.volatiles) {
				if (!['mustrecharge', 'leechseed', 'gastroacid', 'ingrain', 'aquaring', 'torment', 'focusenergy',
					'protect', 'roost', 'choicelock', 'trapped', 'itemlost'].includes(effect) && !/^perish[0-3]$/.test(effect)) {
					return `effect payload unavailable: ${effect}`;
				}
			}
		}
	}
	return undefined;
}

export function projectBattle(
	state: BattleState, opponent: AIPokemon[], sample: number, ownPP = new Map<string, number>()
): Projection | null {
	const formatId = state.field.formatId || 'gen6ou';
	const dex = Dex.forFormat(formatId);
	const own = [...state.self.active, ...state.self.reserve].filter(p => !p.fainted);
	const parties = [own, opponent];
	const sets = parties.map(party => party.map(p => {
		const encoding = spread(p, dex);
		if (!encoding) return null;
		// Side requests encode public power in names such as return102. Those are not Dex
		// move IDs: passing them into PS silently removes the move from the projected set.
		const powers = p.moves.map(id => /^(return|frustration)(\d+)$/.exec(toID(id))).filter(m => m !== null);
		let happiness = p.moves.some(id => moveId(id) === 'frustration') ? 0 : 255;
		if (powers.length) {
			const compatible = Array.from({ length: 256 }, (_, i) => i).find(value => powers.every(m =>
				Math.max(1, Math.floor((m[1] === 'return' ? value : 255 - value) / 2.5)) === Number(m[2])));
			if (compatible === undefined) return null;
			happiness = compatible;
		}
		return { ...encoding, name: p.ident || p.species, species: p.species, level: p.level,
			ability: p.ability || dex.species.get(p.species).abilities[0], item: p.itemLost ? '' : p.item,
			moves: p.moves.map(id => /^(return|frustration)\d+$/.test(toID(id)) ? moveId(id) : id),
			gender: p.gender, happiness,
			hpType: p.moves.map(m => dex.moves.get(m)).find(m => m.id === 'hiddenpower' && m.type !== 'Normal')?.type };
	}));
	if (sets.some(party => party.some(p => !p?.moves.length))) return null;
	const battle = new Battle({ formatid: toID(formatId), seed: `${state.turn},${sample + 1},193,317`,
		p1: { name: 'Search self', team: sets[0] as PokemonSet[] },
		p2: { name: 'Search opponent', team: sets[1] as PokemonSet[] } });
	if (battle.requestState === 'teampreview') battle.makeChoices();
	// Initial switch-in effects are not evidence: restore the entire visible board after construction.
	for (let s = 0; s < 2; s++) {
		const side = battle.sides[s];
		for (let i = 0; i < parties[s].length; i++) restore(battle, side.pokemon[i], parties[s][i], sample);
		if ((s ? state.opponent : state.self).megaUsedByOwner?.[parties[s][0].ownerSide || ''] ||
			parties[s].some(p => dex.species.get(p.species).isMega)) {
			for (const pokemon of side.pokemon) pokemon.canMegaEvo = null;
		}
		side.pokemonLeft = parties[s].length;
		const conditions = s ? state.opponent.conditions : state.self.conditions;
		// Preserve format rule conditions on the field, but discard lead-induced side effects.
		side.sideConditions = {};
		for (const id of ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'reflect', 'lightscreen',
			'auroraveil', 'tailwind', 'safeguard', 'mist'] as const) {
			if (!conditions[id]) continue;
			const duration = ['reflect', 'lightscreen', 'auroraveil', 'tailwind', 'safeguard', 'mist'].includes(id) ?
				Number(conditions[id]) : undefined;
			side.sideConditions[id] = battle.initEffectState({ id, target: side,
				source: side.active[0], duration, layers: Number(conditions[id]) });
		}
	}
	const normalizedPP = new Map([...ownPP].map(([id, pp]) => [moveId(id), pp]));
	for (const slot of battle.p1.active[0].moveSlots) {
		if (normalizedPP.has(slot.id)) slot.pp = normalizedPP.get(slot.id)!;
	}
	const weather: Record<string, string> = { sun: 'sunnyday', rain: 'raindance', sand: 'sandstorm', hail: 'hail' };
	battle.field.weather = toID(state.field.weatherId || weather[state.field.weather] || '');
	battle.field.weatherState = battle.initEffectState({ id: battle.field.weather, source: battle.p1.active[0],
		duration: state.field.weatherTurns > 0 ? state.field.weatherTurns : undefined });
	battle.field.terrain = toID(state.field.terrain ? `${state.field.terrain}terrain` : '');
	battle.field.terrainState = battle.initEffectState({ id: battle.field.terrain, source: battle.p1.active[0],
		duration: state.field.terrainTurns > 0 ? state.field.terrainTurns : undefined });
	for (const id of ['trickroom', 'gravity', 'magicroom', 'wonderroom'] as const) {
		delete battle.field.pseudoWeather[id];
		if (state.field[id]) battle.field.pseudoWeather[id] = battle.initEffectState({ id,
			duration: id === 'trickroom' ? state.field.trickroomTurns : 2, source: battle.p1.active[0] });
	}
	battle.turn = state.turn;
	battle.log.length = 0;
	battle.makeRequest('move');
	return { battle, self: own, opponent };
}

function restore(battle: Battle, target: Pokemon, p: AIPokemon, sample: number) {
	target.hp = p.hp;
	target.maxhp = target.baseMaxhp = p.maxHp;
	target.boosts = { ...p.boosts };
	target.status = toID(p.status);
	target.statusState = battle.initEffectState({ id: p.status, target,
		time: p.sleepTurns > 0 ? p.sleepTurns : 1 + sample % 3,
		startTime: p.sleepTurns > 0 ? p.sleepTurns : 1 + sample % 3,
		stage: p.toxicCounter, source: p.sleepSelfInflicted ? target : target.side.foe.active[0] });
	target.item = toID(p.itemLost ? '' : p.item);
	target.lastItem = toID(p.recyclableItem || '');
	target.ability = target.baseAbility = toID(p.ability || target.species.abilities[0]);
	target.abilityState = battle.initEffectState({ id: target.ability, target, started: true });
	target.itemState = battle.initEffectState({ id: target.item, target });
	target.activeMoveActions = p.activeMoveActions ?? (p.lastMove ? 1 : 0);
	target.activeTurns = target.activeMoveActions;
	target.lastMove = p.lastMove ? battle.dex.getActiveMove(p.lastMove) : null;
	target.lastMoveUsed = target.lastMove;
	target.volatiles = {};
	for (const effect of p.volatiles) {
		if (['protect', 'roost', 'choicelock', 'itemlost'].includes(effect)) continue;
		const id = /^perish[0-3]$/.test(effect) ? 'perishsong' : effect;
		target.volatiles[id] = battle.initEffectState({ id, target, source: target.side.foe.active[0],
			sourceSlot: target.side.foe.active[0].getSlot(),
			duration: id === 'mustrecharge' ? 2 : id === 'perishsong' ? Number(effect.slice(-1)) : undefined });
	}
	if (p.lastMove && battle.dex.items.get(target.item).isChoice) {
		target.volatiles.choicelock = battle.initEffectState({ id: 'choicelock', target, move: toID(p.lastMove) });
	}
	if (['protect', 'detect', 'kingsshield', 'spikyshield', 'endure'].includes(toID(p.lastMove))) {
		target.volatiles.stall = battle.initEffectState({ id: 'stall', target, counter: 3, duration: 2 });
	}
}
