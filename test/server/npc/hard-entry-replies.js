'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { clonePosition, isTrapped } = require('../../../dist/server/npc/ai/hard/projection');

describe('Hard safe entry replies', () => {
	let battle;
	afterEach(() => battle?.destroy());
	function fixture(pivot, ability = 'Levitate') {
		battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
			p1: { name: 'Own', team: [
				{ species: 'Snorlax', ability: 'Immunity', moves: ['bodyslam', ...(pivot ? [pivot] : [])] },
				{ species: 'Magikarp', moves: ['splash'] },
			] },
			p2: { name: 'Foe', team: [
				{ species: 'Mew', moves: ['splash'] },
				{ species: 'Gengar', ability, moves: ['focusblast'] },
			] },
		});
		battle.makeChoices();
		return projectedState(battle);
	}
	function risk(state, evaluator = new MatchupEvaluator()) {
		const trapped = clonePosition(state);
		trapped.opponent.active[0].volatiles.add('trapped');
		return evaluator.assess(state).self - evaluator.assess(trapped).self;
	}
	it('recognizes a safe receiver that reverses the current matchup', () => {
		assert(risk(fixture()) < 0);
	});
	for (const pivot of ['uturn', 'voltswitch']) {
		it(`does not treat an effective ${pivot} as conceding a locked matchup`, () => {
			assert.equal(risk(fixture(pivot)), 0);
		});
	}
	it('retains receiver risk when Volt Switch is absorbed', () => {
		assert(risk(fixture('voltswitch', 'Volt Absorb')) < 0);
	});
	it('resolves an incoming Trace before deciding whether Volt Switch escapes', () => {
		battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
			p1: { name: 'Own', team: [
				{ species: 'Jolteon', ability: 'Volt Absorb', moves: ['voltswitch'] },
				{ species: 'Magikarp', moves: ['splash'] },
			] },
			p2: { name: 'Foe', team: [
				{ species: 'Magikarp', moves: ['splash'] },
				{ species: 'Porygon2', ability: 'Trace', item: 'Eviolite', moves: ['triattack', 'recover'] },
			] },
		});
		battle.makeChoices();
		const state = projectedState(battle), resolved = clonePosition(state);
		resolved.opponent.reserve[0].ability = 'voltabsorb';
		assert(risk(state) < 0, 'An absorbed Volt Switch cannot escape the safe receiver');
		assert.equal(risk(state), risk(resolved));
		battle.makeChoices('move 1', 'switch 2');
		assert.equal(battle.p2.active[0].ability, 'voltabsorb');
		assert.equal(battle.p2.active[0].hp, battle.p2.active[0].maxhp);
		assert.equal(battle.p1.active[0].species.id, 'jolteon');
		assert(!battle.p1.active[0].switchFlag, 'The engine does not grant a pivot after absorption');
	});
	it('invalidates cached pivot eligibility when its PP is exhausted', () => {
		const state = fixture('uturn'), evaluator = new MatchupEvaluator();
		assert.equal(risk(state, evaluator), 0);
		state.self.active[0].projection = { pp: { uturn: 0 } };
		assert(risk(state, evaluator) < 0);
		assert.equal(risk(state, evaluator), risk(state));
	});
	it('recomputes a pivot when public move possibilities exclude it', () => {
		const state = fixture('uturn'), evaluator = new MatchupEvaluator();
		const actor = state.self.active[0];
		actor.moves = ['bodyslam'];
		actor.moveKnowledge = { revealedMoves: ['bodyslam'], presetCandidates: ['uturn'], remainingSlots: 3 };
		const possible = evaluator.assess(state);
		actor.moveKnowledge.presetCandidates = [];
		const excluded = evaluator.assess(state);
		assert(excluded.self < possible.self);
		assert.deepEqual(excluded, new MatchupEvaluator().assess(state));
		actor.moveKnowledge.presetCandidates = ['uturn'];
		actor.moveKnowledge.remainingSlots = 0;
		assert.deepEqual(evaluator.assess(state), new MatchupEvaluator().assess(state));
		assert.equal(evaluator.assess(state).self, excluded.self);
	});
	it('does not reuse a free pivot while the actor is committed to a charging move', () => {
		const state = fixture('uturn'), evaluator = new MatchupEvaluator();
		state.self.active[0].moves.push('solarbeam');
		const available = evaluator.assess(state);
		state.self.active[0].projection = { chargingMove: 'solarbeam' };
		const charging = evaluator.assess(state);
		assert(charging.self < available.self);
		assert.deepEqual(charging, new MatchupEvaluator().assess(state));
		delete state.self.active[0].projection.chargingMove;
		assert.deepEqual(evaluator.assess(state), available);
	});
	it('reuses ability-based trapping while respecting Shed Shell', () => {
		const state = fixture();
		state.self.active[0].ability = 'Shadow Tag';
		assert(isTrapped(state, 'opponent'));
		assert.equal(risk(state), 0);
		state.opponent.active[0].item = 'shedshell';
		assert(!isTrapped(state, 'opponent'));
		assert(risk(state) < 0);
	});
	for (const side of ['self', 'opponent']) {
		it(`does not invent a voluntary reversal before ${side} has replaced a fainted active`, () => {
			const state = fixture();
			Object.assign(state[side].active[0], { hp: 0, hpPercent: 0, fainted: true });
			const evaluator = new MatchupEvaluator();
			assert.equal(risk(state, evaluator), 0);
			assert(evaluator.upperBound(state) >= evaluator.assess(state).value);
		});
	}
});
