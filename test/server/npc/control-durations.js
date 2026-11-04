'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildBattleStateWithTracker } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { advancePosition, endTurn, clonePosition, positionKey, transitionSupported, supportsMove } =
	require('../../../dist/server/npc/ai/hard/projection');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
const action = move => ({ id: `move ${move}`, move, prior: 100 });

describe('Public control duration tracking and projection', () => {
	const battles = [];
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	function fixture(gen, move, fast, reserve = false) {
		const format = `gen${gen}customgame`;
		const b = new Battle({ formatid: format, seed: '1,2,3,4',
			p1: { name: 'Caster', team: [{ species: 'Mew', moves: [move, 'splash'],
				nature: fast ? 'Timid' : 'Brave', ivs: { spe: fast ? 31 : 0 }, evs: { spe: fast ? 252 : 0 } }] },
			p2: { name: 'Target', team: [{ species: 'Mew', moves: ['tackle', 'splash'],
				nature: fast ? 'Brave' : 'Timid', ivs: { spe: fast ? 0 : 31 }, evs: { spe: fast ? 0 : 252 } },
			...(reserve ? [{ species: 'Slowbro', moves: ['tackle', 'splash'] }] : [])] } });
		battles.push(b);
		if (b.requestState === 'teampreview') b.makeChoices();
		b.makeChoices('move splash', 'move tackle');
		const trackers = ['p1', 'p2'].map(side => {
			const t = createBattleTracker(side); t.setFormat(format); return t;
		});
		let cursor = 0;
		const sync = () => { for (const t of trackers) t.parseMessage(b.log.slice(cursor).join('\n')); cursor = b.log.length; };
		const state = side => buildBattleStateWithTracker(b[side].activeRequest, null, trackers[side === 'p1' ? 0 : 1], { ...DEFAULT_AI_CONFIG, formatId: format });
		sync(); return { b, trackers, sync, state };
	}
	for (const gen of [3, 5, 6, 7]) for (const move of ['taunt', 'encore']) for (const fast of [true, false]) {
		if (gen === 3 && move === 'encore') continue;
		it(`matches public PS expiry for gen ${gen} ${fast ? 'fast' : 'slow'} ${move}`, () => {
			const f = fixture(gen, move, fast);
			const predicted = advancePosition(f.state('p1'), action(move), action('tackle'), () => undefined);
			f.b.makeChoices(`move ${move}`, 'move tackle'); f.sync();
			const observed = f.state('p2');
			assert.equal(predicted.opponent.active[0].volatileTurns[move], observed.self.active[0].volatileTurns[move]);
			assert.equal(transitionSupported(observed), undefined);
			const projection = clonePosition(observed);
			for (let i = 0; i < 4; i++) {
				assert.equal(projection.self.active[0].volatiles.has(move), f.state('p2').self.active[0].volatiles.has(move));
				endTurn(projection); f.b.makeChoices('move splash', 'move tackle'); f.sync();
			}
		});
	}
	it('uses the base Taunt duration on a new entrant and clears it on departure', () => {
		const f = fixture(6, 'taunt', false, true);
		const before = f.state('p2');
		const predicted = advancePosition(before, { id: 'switch 2', switchTo: before.self.reserve[0], prior: 100 },
			action('taunt'), () => undefined);
		f.b.makeChoices('move taunt', 'switch 2'); f.sync();
		assert.equal(f.state('p2').self.active[0].volatileTurns.taunt, 2);
		assert.equal(predicted.self.active[0].volatileTurns.taunt, 2);
		f.b.makeChoices('move splash', 'switch 2'); f.sync();
		assert(!f.state('p2').self.reserve[0].volatileTurns?.taunt);
	});
	for (const [gen, move] of [[3, 'encore'], [4, 'encore'], [4, 'taunt']]) {
		it(`keeps randomized gen ${gen} ${move} duration unknown`, () => {
			const f = fixture(gen, move, true);
			assert.equal(supportsMove(f.state('p1'), move), false);
			f.b.makeChoices(`move ${move}`, 'move tackle'); f.sync();
			const state = f.state('p2');
			assert.equal(state.self.active[0].volatileTurns?.[move], undefined);
			assert.equal(transitionSupported(state), `${move} remaining duration unavailable`);
		});
	}
	it('ends fast Encore at residual when the authorized locked move uses its final PP', () => {
		const f = fixture(6, 'encore', true);
		// Fixture mutation only; projection receives PP through the target's own request.
		f.b.p2.active[0].moveSlots.find(m => m.id === 'tackle').pp = 1;
		f.b.makeRequest('move');
		const state = f.state('p2');
		state.self.active[0].projection = { pp: Object.fromEntries(f.b.p2.activeRequest.active[0].moves.map(m =>
			[m.id, m.pp])) };
		const predicted = advancePosition(state, action('tackle'), action('encore'), () => undefined);
		f.b.makeChoices('move encore', 'move tackle'); f.sync();
		assert(f.b.log.some(line => line.startsWith('|-end|p2a:') && line.includes('|Encore')));
		assert(!f.state('p2').self.active[0].volatiles.has('encore'));
		assert(!predicted.self.active[0].volatiles.has('encore'));
		assert.equal(predicted.self.active[0].volatileTurns?.encore, undefined);
		const unknown = f.state('p1');
		unknown.opponent.active[0].volatiles.add('encore');
		unknown.opponent.active[0].volatileTurns = { encore: 2 };
		endTurn(unknown);
		assert(unknown.opponent.active[0].volatiles.has('encore'), 'Unknown opponent PP cannot cause an inferred expiry');
	});
	it('separates expiry states and does not alias timers across hypothetical branches', () => {
		const f = fixture(6, 'taunt', true); f.b.makeChoices('move taunt', 'move tackle'); f.sync();
		const state = f.state('p2'), copy = clonePosition(state), key = positionKey(state);
		copy.self.active[0].volatileTurns.taunt--;
		assert.notEqual(positionKey(copy), key);
		assert.equal(state.self.active[0].volatileTurns.taunt, 2);
	});
	it('accounts for public residual completion before a replacement request and the next turn', () => {
		const t = createBattleTracker('p2'); t.setFormat('gen6customgame');
		t.parseMessage('|switch|p2a: Mew|Mew|100/100\n|turn|1\n|-start|p2a: Mew|move: Taunt');
		assert.equal(t.getVolatileTurns('p2a').taunt, 3);
		t.parseMessage('|upkeep');
		assert.equal(t.getVolatileTurns('p2a').taunt, 2);
		t.parseMessage('|turn|2');
		assert.equal(t.getVolatileTurns('p2a').taunt, 2);
	});
	it('counts a public cant as a completed action without treating a long-staying target as a new entrant', () => {
		const t = createBattleTracker('p2'); t.setFormat('gen6customgame');
		t.parseMessage('|switch|p2a: Mew|Mew|100/100\n|turn|1\n|cant|p2a: Mew|slp\n|-start|p2a: Mew|move: Taunt\n|turn|2');
		assert.equal(t.getVolatileTurns('p2a').taunt, 3);
		t.parseMessage('|-end|p2a: Mew|move: Taunt');
		assert.equal(t.getVolatileTurns('p2a').taunt, undefined);
	});
});
