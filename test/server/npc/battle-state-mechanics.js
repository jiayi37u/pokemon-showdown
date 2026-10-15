'use strict';

const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildAIMove } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { getEffectiveSpeed } = require('../../../dist/server/npc/ai/cfru/util/speed');

function decision({ hp = 18, ability = 'Synchronize', weather = '', moves = ['psychic', 'focusblast'] } = {}) {
	const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
	ai.setBattle({ format: 'gen5pokemmorandombattle' });
	ai.getTracker().parseMessage(`|switch|p1a: Foe|Magcargo, L100|${hp}/100`);
	if (weather) ai.getTracker().parseMessage(`|-weather|${weather}`);
	let choice;
	ai.choose = value => { choice = value; };
	ai.receiveRequest({
		side: { id: 'p2', pokemon: [{
			ident: 'p2: Gardevoir', details: 'Gardevoir, L100', condition: '300/300', active: true,
			stats: { atk: 150, def: 200, spa: 300, spd: 250, spe: 300 }, moves, ability, item: '',
		}] },
		active: [{ moves: moves.map(id => ({ id, move: id, pp: 10, maxpp: 10, target: 'normal' })) }],
	});
	return { ai, choice, state: ai.battleState };
}

describe('NPC public weather and Rest state', () => {
	it('normalizes protocol weather for damage, speed and charge-turn scoring', () => {
		for (const [protocol, expected] of [
			['SunnyDay', 'sun'], ['RainDance', 'rain'], ['Sandstorm', 'sand'], ['Hail', 'hail'],
			['Snowscape', 'snow'], ['DesolateLand', 'sun'], ['PrimordialSea', 'rain'], ['none', ''],
		]) {
			const { state } = decision({ weather: protocol });
			assert.equal(state.field.weather, expected);
		}
		const { ai, state } = decision({ weather: 'SunnyDay', ability: 'Chlorophyll', moves: ['solarbeam', 'flamethrower'] });
		const actor = state.self.active[0];
		const target = state.opponent.active[0];
		const fire = buildAIMove({ id: 'flamethrower' }, 1);
		const neutral = { ...state.field, weather: '' };
		assert(calculateDamage(actor, target, fire, state.field).average > calculateDamage(actor, target, fire, neutral).average);
		assert.equal(getEffectiveSpeed(actor, state.field), getEffectiveSpeed(actor, neutral) * 2);
		assert(!ai.lastMoveScores.find(s => s.move.id === 'solarbeam').breakdown.details.some(d => /Two-turn/.test(d.reason)));
	});

	it('counts only successful Rest and public sleep actions, independently for each Pokemon', () => {
		const tracker = createBattleTracker('p2', true);
		tracker.setFormat('gen5pokemmomultirandombattle');
		tracker.parseMessage('|switch|p2a: Steel|Registeel|100/100\n|switch|p4b: Bird|Xatu|100/100');
		tracker.parseMessage('|move|p2a: Steel|Rest|p2a: Steel\n|-fail|p2a: Steel');
		assert.equal(tracker.getSleepTurns('p2a'), 0);
		tracker.parseMessage('|-status|p2a: Steel|slp|[from] move: Rest\n|-status|p4b: Bird|slp|[from] move: Rest');
		assert.equal(tracker.getSleepTurns('p2a'), 3);
		tracker.parseMessage('|cant|p2a: Steel|flinch\n|turn|2');
		assert.equal(tracker.getSleepTurns('p2a'), 3, 'Turns without a sleep check do not decrement');
		tracker.parseMessage('|cant|p2a: Steel|slp\n|cant|p4b: Bird|slp');
		assert.equal(tracker.getSleepTurns('p2a'), 2);
		assert.equal(tracker.getSleepTurns('p4b', 'Early Bird'), 1);
		tracker.parseMessage('|cant|p2a: Steel|slp');
		assert.equal(tracker.getSleepTurns('p2a'), 1);
		tracker.parseMessage('|-curestatus|p2a: Steel|slp\n|-status|p2a: Steel|slp|[from] move: Spore');
		tracker.parseMessage('|cant|p2a: Steel|slp\n|cant|p2a: Steel|slp');
		assert.equal(tracker.getSleepTurns('p2a'), 0, 'Random sleep duration is not public');
		tracker.parseMessage('|-cureteam|p4: Ally');
		assert.equal(tracker.getSleepTurns('p4b'), 0);
	});

	for (const [format, expected] of [['gen5customgame', 3], ['gen5pokemmorandombattle', 2], ['gen9customgame', 2]]) {
		it(`tracks Rest across switches in ${format}`, () => {
			const tracker = createBattleTracker('p2');
			tracker.setFormat(format);
			tracker.parseMessage('|switch|p2a: Steel|Registeel|100/100');
			tracker.parseMessage('|-status|p2a: Steel|slp|[from] move: Rest\n|cant|p2a: Steel|slp');
			tracker.parseMessage('|switch|p2a: Bird|Xatu|100/100');
			assert.equal(tracker.getSleepTurns('a'), 0);
			tracker.parseMessage('|switch|p2a: Steel|Registeel|100/100 slp');
			assert.equal(tracker.getSleepTurns('a'), expected);
			tracker.reset();
			assert.equal(tracker.getSleepTurns('a'), 0);
		});
	}

	it('chooses Sleep Talk for both Rest sleep turns, then an effective move on the waking turn', () => {
		const format = 'gen5pokemmorandombattle';
		const battle = new Battle({
			formatid: format, seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: [{ species: 'Blissey', ability: 'Natural Cure', moves: ['seismictoss', 'tackle'] }] },
			p2: { name: 'NPC', team: [{ species: 'Registeel', ability: 'Clear Body', moves: ['rest', 'sleeptalk', 'seismictoss'] }] },
		});
		const stream = { push() {}, write() {} };
		const ai = new NormalAI(stream, { seed: [1, 2, 3, 4] });
		ai.setBattle({ stream, format });
		let choice;
		let cursor = 0;
		ai.choose = value => { choice = value; };
		const decide = () => {
			stream.push(battle.log.slice(cursor).join('\n'));
			cursor = battle.log.length;
			ai.receiveRequest(JSON.parse(JSON.stringify(battle.p2.activeRequest)));
		};
		try {
			if (battle.requestState === 'teampreview') battle.makeChoices();
			battle.makeChoices('move 1', 'move 1');
			for (const turns of [3, 2]) {
				decide();
				assert.equal(ai.battleState.self.active[0].sleepTurns, turns);
				assert.equal(choice, 'move 2');
				battle.makeChoices('move 2', choice);
			}
			decide();
			assert.equal(ai.battleState.self.active[0].sleepTurns, 1);
			assert.equal(choice, 'move 3');
			assert.equal(ai.lastMoveScores.find(s => s.move.id === 'sleeptalk').score, 0);
			battle.makeChoices('move 2', choice);
			assert.equal(battle.p2.active[0].status, '');
			assert(battle.log.slice(cursor).some(line => line.startsWith('|move|p2a: Registeel|Seismic Toss')));
		} finally {
			battle.destroy();
		}
	});
});

describe('Normal reliable KO selection', () => {
	it('prefers Psychic to Focus Blast when both average damage estimates KO', () => {
		const { ai, choice } = decision();
		assert.equal(choice, 'move 1');
		const focus = ai.lastMoveScores.find(s => s.move.id === 'focusblast');
		assert(focus.breakdown.details.some(d => d.reason.includes('Prefer reliable KO: Psychic')));
		assert.equal(100 + focus.breakdown.details.reduce((sum, d) => sum + d.amount, 0), focus.score);
	});

	it('retains damage scoring when the more accurate move cannot KO', () => {
		const { ai, choice } = decision({ hp: 100 });
		assert.equal(choice, 'move 2');
		assert(!ai.lastMoveScores.some(s => s.breakdown.details.some(d => d.reason.includes('Prefer reliable KO'))));
	});

	it('does not penalize Focus Blast under No Guard', () => {
		assert.equal(decision({ ability: 'No Guard' }).choice, 'move 2');
	});
});
