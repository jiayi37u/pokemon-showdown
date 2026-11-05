'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { advancePosition, endTurn } = require('../../../dist/server/npc/ai/hard/projection');
const { calculateDamage } = require('../../../dist/server/npc/ai/hard/damage');
const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');

const action = move => ({ id: `move ${move}`, move, prior: 0 });

describe('Hard projected weather expiry', () => {
	let battle;
	afterEach(() => battle?.destroy());
	function fixture(ability, item = '', moves = ['splash']) {
		battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
			p1: { name: 'Own', team: [{ species: 'Mew', ability, item, moves }] },
			p2: { name: 'Foe', team: [{ species: 'Mew', ability: 'Synchronize', moves: ['splash'] }] },
		});
		battle.makeChoices();
		return battle;
	}
	for (const [weather, ability] of [
		['sandstorm', 'Synchronize'], ['hail', 'Synchronize'],
		['sunnyday', 'Dry Skin'], ['sunnyday', 'Solar Power'], ['raindance', 'Dry Skin'],
	]) for (const turns of [1, 2]) for (const item of ['', 'Leftovers']) {
		it(`matches native ${weather}/${ability} at ${turns} remaining with ${item || 'no item'}`, () => {
			const b = fixture(ability, item);
			// At one HP, weather damage must not prevent later recovery after the weather expires.
			b.p1.active[0].hp = item ? 1 : Math.floor(b.p1.active[0].maxhp / 2);
			b.field.setWeather(weather, b.p1.active[0]);
			b.field.weatherState.duration = turns;
			const state = projectedState(b);
			endTurn(state);
			b.makeChoices('move 1', 'move 1');
			assert.equal(state.field.weatherId, b.field.weather);
			assert.equal(state.field.weatherTurns, b.field.weatherState.duration || 0);
			for (const [side, native] of [['self', b.p1], ['opponent', b.p2]]) {
				assert.equal(state[side].team[0].hp, native.pokemon[0].hp);
				assert.equal(state[side].team[0].fainted, native.pokemon[0].fainted);
			}
		});
	}
	it('expires sunlight before a due Future Sight uses Solar Power', () => {
		const b = fixture('Solar Power', '', ['futuresight', 'splash']);
		let state = projectedState(b);
		state = advancePosition(state, action('futuresight'), action('splash'), () => undefined);
		b.makeChoices('move 1', 'move 1');
		state = advancePosition(state, action('splash'), action('splash'), () => undefined);
		b.makeChoices('move 2', 'move 1');
		const target = state.opponent.active[0], source = state.self.active[0];
		assert.equal(state.opponent.conditions.futureMoves[target.slot], 1);
		b.field.setWeather('sunnyday', b.p1.active[0]);
		b.field.weatherState.duration = 1;
		Object.assign(state.field, { weather: 'sun', weatherId: 'sunnyday', weatherTurns: 1 });
		const move = hardMove('futuresight', 1, state.field.formatId);
		const withoutSun = calculateDamage(source, target, move,
			{ ...state.field, weather: '', weatherId: '', weatherTurns: 0 });
		const withSun = calculateDamage(source, target, move, state.field);
		assert(withoutSun.max < withSun.min, 'The weather-dependent ranges distinguish the resolution order');
		const targetHP = target.hp, sourceHP = source.hp;
		endTurn(state);
		b.makeChoices('move 2', 'move 1');
		assert.equal(targetHP - state.opponent.active[0].hp, Math.floor(withoutSun.average));
		const nativeDamage = targetHP - b.p2.active[0].hp;
		assert(nativeDamage >= withoutSun.min && nativeDamage <= withoutSun.max);
		assert.equal(state.self.active[0].hp, sourceHP);
		assert.equal(b.p1.active[0].hp, sourceHP);
		const expiry = b.log.findIndex(line => line === '|-weather|none');
		const hit = b.log.findIndex(line => line.includes('|-end|') && line.includes('move: Future Sight'));
		assert(expiry >= 0 && hit > expiry, 'Native PS ends sunlight before Future Sight resolves');
	});
});
