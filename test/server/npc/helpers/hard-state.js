'use strict';
// Tests may inspect PS state; production hard search only receives AI knowledge snapshots.
const { buildPokemonFromRequest } = require('../../../../dist/server/npc/ai/cfru/state-builder');
function projectedState(battle) {
	const side = s => {
		const team = s.pokemon.map((p, index) => ({
			...buildPokemonFromRequest({ details: `${p.species.name}, L${p.level}, ${p.gender || 'N'}`,
				condition: `${p.hp}/${p.maxhp}${p.status ? ` ${p.status}` : ''}`, stats: p.storedStats,
				ability: p.ability, item: p.item, moves: p.moveSlots.map(m => m.id === 'hiddenpower' ? `hiddenpower${p.hpType.toLowerCase()}` : m.id) },
			index + 1, p.isActive, battle.format.id),
			ident: `${s.id}: ${p.name}`, ownerSide: s.id, types: p.getTypes(), boosts: { ...p.boosts },
			volatiles: new Set(Object.keys(p.volatiles)), fainted: p.fainted, lastMove: p.lastMove?.id || '',
			activeMoveActions: p.activeMoveActions, sleepTurns: p.statusState.time || 0,
			sleepSelfInflicted: p.statusState.source === p, toxicCounter: p.statusState.stage || 0,
		}));
		const c = s.sideConditions;
		return { team, active: team.filter(p => p.active), reserve: team.filter(p => !p.active), conditions: {
			stealthrock: !!c.stealthrock, spikes: c.spikes?.layers || 0, toxicspikes: c.toxicspikes?.layers || 0,
			stickyweb: !!c.stickyweb, reflect: c.reflect?.duration || 0, lightscreen: c.lightscreen?.duration || 0,
			auroraveil: c.auroraveil?.duration || 0, tailwind: c.tailwind?.duration || 0, wishes: {}, futureMoves: {},
		} };
	};
	const weather = { sunnyday: 'sun', raindance: 'rain', sandstorm: 'sand', hail: 'hail' };
	return { turn: battle.turn, isDoubles: false, self: side(battle.p1), opponent: side(battle.p2), field: {
		formatId: battle.format.id, weather: weather[battle.field.weather] || '', weatherId: battle.field.weather,
		weatherTurns: battle.field.weatherState.duration || 0, terrain: battle.field.terrain.replace('terrain', ''),
		terrainTurns: battle.field.terrainState.duration || 0, trickroom: !!battle.field.pseudoWeather.trickroom,
		trickroomTurns: battle.field.pseudoWeather.trickroom?.duration || 0, gravity: !!battle.field.pseudoWeather.gravity,
		magicroom: !!battle.field.pseudoWeather.magicroom, wonderroom: !!battle.field.pseudoWeather.wonderroom,
	} };
}
module.exports = { projectedState };
