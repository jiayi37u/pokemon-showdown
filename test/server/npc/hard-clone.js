'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { advancePosition, beginTurn, continueTurn, clonePosition, switchIn } = require('../../../dist/server/npc/ai/hard/projection');
const battles = [];
const action = move => ({ id: `move ${move}`, move, prior: 100 });
function fixture(own, foe) {
	const battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
		p1: { name: 'Own', team: own }, p2: { name: 'Foe', team: foe } });
	battles.push(battle); battle.makeChoices();
	return projectedState(battle);
}
const step = (state, own, foe = 'splash') => advancePosition(state, action(own), action(foe),
	(s, side) => s[side].reserve.find(p => !p.fainted));

describe('Hard projection branch isolation', () => {
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	it('restores a transformed branch without changing its native inputs or sibling', () => {
		const state = fixture([{ species: 'Ditto', ability: 'Limber', moves: ['transform'] },
			{ species: 'Mew', moves: ['splash'] }], [{ species: 'Garchomp', moves: ['splash', 'earthquake'] }]);
		const actor = state.self.active[0]; actor.projection = { pp: { transform: 10 } };
		const original = structuredClone(state), transformed = step(state, 'transform');
		const sibling = structuredClone(transformed), branch = clonePosition(transformed);
		const native = structuredClone(branch.self.active[0].projection.native);
		const attacked = step(branch, 'earthquake');
		assert.equal(attacked.self.active[0].projection.pp.earthquake, 4);
		assert.equal(transformed.self.active[0].projection.pp.earthquake, 5);
		switchIn(attacked, 'self', attacked.self.reserve[0]);
		const restored = attacked.self.reserve.find(p => p.species === 'Ditto');
		for (const key of ['moves', 'types', 'baseStats']) assert.deepEqual(restored[key], actor[key]);
		assert.deepEqual(restored.projection.pp, { transform: 9 });
		assert.deepEqual(transformed.self.active[0].projection.native, native);
		assert.deepEqual(transformed, sibling);
		assert.deepEqual(state, original);
	});
	it('replaces Mega stats and types without changing the source or sibling', () => {
		const state = fixture([{ species: 'Charizard', ability: 'Blaze', item: 'Charizardite X', moves: ['splash'] }],
			[{ species: 'Mew', moves: ['splash'] }]);
		const original = structuredClone(state), sibling = clonePosition(state), siblingBefore = structuredClone(sibling);
		const next = advancePosition(state, { ...action('splash'), mega: true }, action('splash'), () => undefined);
		assert.equal(next.self.active[0].species, 'Charizard-Mega-X');
		assert.deepEqual(next.self.active[0].types, ['Fire', 'Dragon']);
		assert.notDeepEqual(next.self.active[0].baseStats, state.self.active[0].baseStats);
		assert.deepEqual(state, original);
		assert.deepEqual(sibling, siblingBefore);
	});
	it('replaces and restores Roost types while a sibling keeps its original typing', () => {
		const state = fixture([{ species: 'Skarmory', moves: ['roost'] }],
			[{ species: 'Mew', moves: ['uturn'] }, { species: 'Blissey', moves: ['splash'] }]);
		const actor = state.self.active[0]; actor.baseStats = { ...actor.baseStats, spe: 1000 };
		actor.hp = Math.floor(actor.maxHp / 2); actor.hpPercent = 50;
		const original = structuredClone(state), sibling = clonePosition(state), siblingBefore = structuredClone(sibling);
		const turn = beginTurn(state, action('roost'), action('uturn'));
		assert.equal(continueTurn(turn), undefined);
		assert.deepEqual(turn.state.self.active[0].types, ['Steel']);
		switchIn(turn.state, 'opponent', turn.state.opponent.reserve[0]);
		const next = continueTurn(turn);
		assert.deepEqual(next.self.active[0].types, ['Steel', 'Flying']);
		assert.deepEqual(state, original);
		assert.deepEqual(sibling, siblingBefore);
	});
});
