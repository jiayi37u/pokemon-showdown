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
	function fixture(gen, move, fast, reserve = false, ownReserve = false) {
		const format = `gen${gen}customgame`;
		const b = new Battle({ formatid: format, seed: '1,2,3,4',
			p1: { name: 'Caster', team: [{ species: 'Mew', moves: [move, 'splash'],
				nature: fast ? 'Timid' : 'Brave', ivs: { spe: fast ? 31 : 0 }, evs: { spe: fast ? 252 : 0 } },
			...(ownReserve ? [{ species: 'Slowbro', moves: ['splash'] }] : [])] },
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
	for (const move of ['dig', 'yawn']) {
		it(`rebuilds ${move} for both observers between turns and clears it after release`, () => {
			const f = fixture(6, move, true);
			f.b.makeChoices(`move ${move}`, 'move tackle'); f.sync();
			for (const side of ['p1', 'p2']) {
				const snapshot = f.state(side);
				const affected = snapshot[(side === 'p1') === (move === 'dig') ? 'self' : 'opponent'].active[0];
				if (move === 'dig') assert.equal(affected.chargingMove, move);
				else assert.equal(affected.volatileTurns.yawn, 1);
			}
			f.b.makeChoices(move === 'dig' ? 'move 1' : 'move splash', 'move tackle'); f.sync();
			assert(!f.state('p2').opponent.active[0].chargingMove);
			assert(!f.state('p1').opponent.active[0].volatiles.has('yawn'));
		});
	}
	it('tracks a successful Outrage from both public streams without mistaking its continuation for a new rampage', () => {
		const fixtureState = fixture(6, 'outrage', true);
		fixtureState.b.makeChoices('move outrage', 'move tackle'); fixtureState.sync();
		assert.equal(fixtureState.b.p1.activeRequest.active[0].moves[0].id, 'outrage');
		assert.equal(fixtureState.b.p1.activeRequest.active[0].moves.length, 1);
		assert.equal(fixtureState.state('p1').self.active[0].rampageMove, 'outrage');
		assert.equal(fixtureState.state('p2').opponent.active[0].rampageMove, 'outrage');
		fixtureState.b.makeChoices('move 1', 'move tackle'); fixtureState.sync();
		assert(!fixtureState.state('p2').opponent.active[0].rampageMove);
	});
	for (const move of ['rollout', 'iceball', 'uproar', 'bide']) {
		it(`forces ${move} for either observer and projects the next PS action`, () => {
			const { Search } = require('../../../dist/server/npc/ai/hard/search');
			const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
			const f = fixture(6, move, true, false, true);
			f.b.makeChoices('move 1', 'move tackle'); f.sync();
			const snapshot = f.state('p2'), own = f.state('p1');
			assert.deepEqual(f.b.p1.activeRequest.active[0].moves.map(m => m.id), [move]);
			assert(f.b.p1.activeRequest.active[0].trapped);
			const search = new Search(new MatchupEvaluator(), snapshot);
			assert.deepEqual(search.responseProbabilities(snapshot).map(r => [r.action.move, r.probability]), [[move, 1]]);
			assert.deepEqual(search.choices(own, 'self').map(a => a.move), [move]);
			own.opponent.active[0].item = '';
			own.opponent.active[0].itemKnown = true;
			const projected = advancePosition(own, action(move), action('tackle'), () => undefined);
			const release = advancePosition(projected, action(move), action('splash'), () => undefined);
			if (move === 'bide') {
				const stored = own.self.active[0].moveSequence.storedFraction * own.self.active[0].maxHp;
				const secondHit = own.self.active[0].hp - projected.self.active[0].hp;
				assert(stored > 0 && secondHit > 0);
				assert.equal(projected.opponent.active[0].hp, own.opponent.active[0].hp);
				assert.equal(projected.opponent.active[0].hp - release.opponent.active[0].hp,
					Math.min(projected.opponent.active[0].hp, 2 * Math.round(stored + secondHit)));
			}
			if (['rollout', 'iceball'].includes(move)) {
				assert.equal(projected.self.active[0].moveSequence.elapsed, 2);
				const secondHit = own.opponent.active[0].hp - projected.opponent.active[0].hp;
				assert(release.opponent.active[0].hp === 0 ||
					projected.opponent.active[0].hp - release.opponent.active[0].hp > secondHit * 1.8);
				projected.opponent.active[0].moves.push('protect');
				const blocked = advancePosition(projected, action(move), action('protect'), () => undefined);
				assert(!blocked.self.active[0].moveSequence);
			} else {
				assert(!release.self.active[0].moveSequence);
				f.b.makeChoices('move 1', 'move tackle'); f.sync();
				f.b.makeChoices('move 1', 'move splash'); f.sync();
				assert(!f.state('p2').opponent.active[0].moveSequence);
			}
		});
	}
	it('covers every move-local PS lock in supported generations and MMO', () => {
		const { Dex } = require('../../../dist/sim');
		for (const mod of ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8', 'gen9', 'mmo']) {
			for (const move of Dex.mod(mod).moves.all()) {
				if (move.condition?.onLockMove) assert(move.actionSequence, mod + ': ' + move.id);
			}
		}
	});
	for (const gen of [3, 4]) {
		it(`uses three turns for projected gen ${gen} Uproar and honors a longer public lock`, () => {
			const f = fixture(gen, 'uproar', true);
			f.b.makeChoices('move 1', 'move splash'); f.sync();
			const next = advancePosition(f.state('p2'), action('splash'), action('uproar'), () => undefined);
			assert.equal(next.opponent.active[0].moveSequence.elapsed, 2);
			assert(!advancePosition(next, action('splash'), action('uproar'), () => undefined).opponent.active[0].moveSequence);
			f.trackers[1].parseMessage('|upkeep\n|turn|4\n|upkeep\n|turn|5');
			const observed = f.state('p2');
			assert.equal(observed.opponent.active[0].moveSequence.elapsed, 3);
			assert(!advancePosition(observed, action('splash'), action('uproar'), () => undefined).opponent.active[0].moveSequence);
		});
	}
	for (const move of ['taunt', 'encore']) {
		it(`estimates three turns for gen 4 ${move} in search and public tracking`, () => {
			const f = fixture(4, move, true);
			assert(supportsMove(f.state('p1'), move));
			const predicted = advancePosition(f.state('p1'), action(move), action('tackle'), () => undefined);
			assert.equal(predicted.opponent.active[0].volatileTurns[move], 2);
			f.b.makeChoices(`move ${move}`, 'move tackle'); f.sync();
			const state = f.state('p2');
			assert.equal(state.self.active[0].volatileTurns[move], 2);
			assert.equal(transitionSupported(state), undefined);
			f.trackers[1].parseMessage(`|-end|p2a: Mew|${move}`);
			assert(!f.state('p2').self.active[0].volatiles.has(move));
		});
	}
	for (const [gen, move] of [[3, 'encore'], [4, 'encore'], [4, 'taunt']]) {
		it(`gen ${gen} ${move} estimates one final turn whenever it outlasts three turns`, () => {
			const f = fixture(gen, move, true);
			assert(supportsMove(f.state('p1'), move));
			f.b.makeChoices(`move ${move}`, 'move tackle'); f.sync();
			const tracker = f.trackers[1];
			assert.equal(tracker.getVolatileTurns('p2a')[move], 2);
			for (const elapsed of [3, 4]) {
				tracker.parseMessage(`|turn|${2 + elapsed}`);
				const observed = f.state('p2');
				assert.equal(transitionSupported(observed), undefined);
				assert.equal(observed.self.active[0].volatileTurns[move], 1);
				endTurn(observed); assert(!observed.self.active[0].volatiles.has(move));
			}
			tracker.parseMessage(`|-end|p2a: Mew|${move}`);
			assert(!f.state('p2').self.active[0].volatiles.has(move));
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
