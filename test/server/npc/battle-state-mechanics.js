'use strict';

const assert = require('assert').strict;
const { Battle, Dex, toID } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildAIMove, buildBattleStateWithTracker, buildBattleStateFromRequests } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');
const { inferOpponent } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { getAttackStat } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { getEffectiveSpeed, isFaster } = require('../../../dist/server/npc/ai/cfru/util/speed');
const { effectiveAbility, grounded, replaceActivePokemon, normalizeWeather } = require('../../../dist/server/npc/ai/cfru/util/mechanics');
const { analyzeKnockout } = require('../../../dist/server/npc/ai/cfru/util/knockout');

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

describe('NPC public Transform state', () => {
	for (const format of ['gen5pokemmorandombattle', 'gen7randombattle', 'gen9randombattle']) {
		it(`recognizes an opening Imposter's copied immunity and stats in ${format}`, () => {
			const battle = new Battle({
				formatid: format, seed: [1, 2, 3, 4],
				p1: { name: 'Player', team: [{ species: 'Ditto', level: 87, ability: 'Imposter',
					item: 'Choice Scarf', moves: ['transform'] }] },
				p2: { name: 'NPC', team: [{ species: 'Jolteon', level: 77, ability: 'Volt Absorb',
					moves: ['thunderbolt', 'shadowball'], evs: { spa: 252, spe: 252 } }] },
			});
			try {
				const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
				ai.setBattle({ format });
				ai.getTracker().parseMessage(battle.log.join('\n'));
				let choice;
				ai.choose = value => { choice = value; };
				ai.receiveRequest(JSON.parse(JSON.stringify(battle.p2.activeRequest)));
				const target = ai.battleState.opponent.active[0];
				assert.equal(target.species, 'Jolteon');
				assert.deepEqual(target.types, ['Electric']);
				assert.equal(toID(target.ability), 'voltabsorb');
				assert.equal(target.level, 87, 'Transform retains the user level');
				for (const stat of ['atk', 'def', 'spa', 'spd', 'spe']) {
					assert.equal(target.baseStats[stat], battle.p1.active[0].storedStats[stat], stat);
				}
				assert.notEqual(target.maxHp, ai.battleState.self.active[0].maxHp, 'HP is not copied');
				assert(ai.lastMoveScores.find(s => s.move.id === 'thunderbolt').flags.isImmune);
				assert.equal(choice, 'move 2');
				assert.deepEqual(target.moveKnowledge.revealedMoves, ['thunderbolt', 'shadowball']);
				const model = inferOpponent(target, format)[0];
				assert.deepEqual(model.pokemon.baseStats, target.baseStats, 'Hard must retain the copied stats');
			} finally {
				battle.destroy();
			}
		});
	}

	function transformScenario(ours = false) {
		const tracker = createBattleTracker('p2');
		tracker.setFormat('gen9randombattle');
		const user = ours ? 'p2a: Ditto' : 'p1a: Ditto';
		const target = ours ? 'p1a: Jolteon' : 'p2a: Jolteon';
		tracker.parseMessage(`|switch|${user}|Ditto, L87|100/100\n|switch|${target}|Jolteon, L77|100/100`);
		tracker.parseMessage(`|-ability|${target}|Volt Absorb\n|-boost|${target}|spa|2\n|-boost|${target}|spe|1`);
		tracker.parseMessage(`|move|${user}|Transform|${target}\n|-transform|${user}|${target}`);
		const request = {
			side: { id: 'p2', pokemon: [{
				ident: ours ? 'p2: Ditto' : 'p2: Jolteon', details: ours ? 'Ditto, L87' : 'Jolteon, L77',
				condition: '225/225', active: true, moves: ['thunderbolt', 'shadowball'],
				stats: { atk: 80, def: 90, spa: 240, spd: 200, spe: 300 },
				ability: 'Volt Absorb', item: ours ? 'choicescarf' : 'leftovers',
			}] }, active: [{ moves: [] }],
		};
		const build = () => buildBattleStateWithTracker(request, null, tracker,
			{ ...DEFAULT_AI_CONFIG, formatId: 'gen9randombattle' });
		return { tracker, request, build, user, target };
	}

	it('copies boosts once and restores native identity and moves on switching', () => {
		const { tracker, build, user, target } = transformScenario();
		const copied = build().opponent.active[0];
		assert.equal(copied.boosts.spa, 2);
		assert.equal(copied.boosts.spe, 1);
		assert.equal(toID(copied.item), 'choicescarf');
		tracker.parseMessage(`|-boost|${target}|spa|1\n|-boost|${user}|spa|1\n|move|${user}|Shadow Ball|${target}`);
		assert.equal(build().opponent.active[0].boosts.spa, 3);
		tracker.parseMessage('|switch|p2a: Snorlax|Snorlax, L80|100/100');
		assert.equal(build().opponent.active[0].baseStats.spe, copied.baseStats.spe, 'Copied stats survive the target switching');
		tracker.parseMessage('|switch|p1a: Magikarp|Magikarp, L100|100/100');
		const reserve = build().opponent.reserve.find(p => p.species === 'Ditto');
		assert.deepEqual(reserve.moves, ['Transform']);
		assert.deepEqual(reserve.types, ['Normal']);
		tracker.parseMessage('|switch|p1a: Ditto|Ditto, L87|100/100');
		const returned = build().opponent.active[0];
		assert.equal(returned.species, 'Ditto');
		assert.equal(returned.boosts.spa, 0);
		assert(!returned.moves.includes('shadowball'));
	});

	it('uses the copied species, boosts and public stat estimate for our own transformed Pokemon', () => {
		const { build } = transformScenario(true);
		const actor = build().self.active[0];
		assert.equal(actor.species, 'Jolteon');
		assert.deepEqual(actor.types, ['Electric']);
		assert.equal(actor.ability, 'Volt Absorb');
		assert.equal(actor.boosts.spa, 2);
		assert.equal(actor.boosts.spe, 1);
		assert.equal(actor.baseStats.hp, 225);
		assert.notEqual(actor.baseStats.spa, 240, 'The request retains native stats; Transform uses the target estimate');
		assert.equal(actor.item, 'choicescarf');
	});
});

describe('NPC public protocol boundary', () => {
	it('ignores private split records, including a split marker delivered in a separate chunk', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|split|p1\n');
		tracker.parseMessage('|switch|p1a: Hidden|Zoroark, L100|281/281\n|switch|p1a: Mask|Mew, L100|100/100');
		assert.equal(tracker.getActiveOpponent().species, 'Mew');
		assert.equal(tracker.getOpponentTeam().length, 1);
		tracker.parseMessage('|split|p1\n|-item|p1a: Mask|Choice Specs\n');
		assert.equal(tracker.getActiveOpponent().item, '');
		tracker.parseMessage('|split|p1');
		tracker.reset();
		tracker.parseMessage('|switch|p1a: Seen|Mew|100/100');
		assert.equal(tracker.getActiveOpponent().ident, 'p1:Seen');
	});
});

describe('Shared public state pipeline across game types', () => {
	function fixture(gameType, team1, team2, partner1, partner2, reserve, formatId = 'gen9customgame') {
		const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
		const multi = gameType === 'multi';
		const battle = new Battle({
			format: { ...Dex.formats.get(formatId), gameType, playerCount: multi ? 4 : 2 }, seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: [...(gameType === 'doubles' ? [team1, partner1 || passive] : [team1]), ...(reserve ? [reserve] : [])] },
			p2: { name: 'NPC', team: [...(gameType === 'doubles' ? [team2, partner2 || passive] : [team2]), ...(reserve ? [reserve] : [])] },
			...(multi ? { p3: { name: 'Player2', team: [partner1 || passive] },
				p4: { name: 'NPC2', team: [partner2 || passive] } } : {}),
		});
		if (battle.requestState === 'teampreview') battle.makeChoices();
		const tracker = createBattleTracker('p2', multi);
		tracker.setFormat(formatId);
		let cursor = 0;
		const build = () => {
			tracker.parseMessage(battle.log.slice(cursor).join('\n'));
			cursor = battle.log.length;
			const config = { ...DEFAULT_AI_CONFIG, formatId, isDoubles: gameType !== 'singles' };
			if (multi) return buildBattleStateFromRequests(['p2', 'p4'].map(side =>
				({ side, request: JSON.parse(JSON.stringify(battle[side].activeRequest)) })), tracker, config, battle.turn);
			return buildBattleStateWithTracker(JSON.parse(JSON.stringify(battle.p2.activeRequest)), {
				turn: battle.turn,
				get sides() { throw new Error('Private simulator sides must not be read'); },
				get field() { throw new Error('Use public field events, not simulator state'); },
			}, tracker, config);
		};
		const play = (p1, p2, p3 = 'move 1', p4 = 'move 1') => {
			battle.makeChoices(...(multi ? [p1, p2, p3, p4] : gameType === 'doubles' ? [`${p1}, ${p3}`, `${p2}, ${p4}`] : [p1, p2]));
		};
		return { battle, tracker, build, play };
	}

	for (const gameType of ['singles', 'doubles', 'multi']) {
		it(`${gameType}: a recipient that cannot be suppressed drops Gastro Acid before passing again`, () => {
			const source = { species: 'Smeargle', ability: 'Own Tempo', moves: ['batonpass'] };
			const recipient = { species: 'Komala', ability: 'Comatose', moves: ['batonpass'] };
			const game = fixture(gameType, source, source, undefined, undefined, recipient);
			try {
				game.build();
				for (const side of [game.battle.p1, game.battle.p2]) side.active[0].addVolatile('gastroacid', side.active[0]);
				game.build();
				for (const species of ['Komala', 'Smeargle']) {
					game.play('move 1', 'move 1');
					while (game.battle.requestState === 'switch') {
						const side = game.battle.sides.find(s => s.activeRequest?.forceSwitch?.some(Boolean) && !s.isChoiceDone());
						assert(side);
						assert(game.battle.choose(side.id, `switch ${gameType === 'doubles' ? 3 : 2}`), side.choice.error);
					}
					const state = game.build();
					for (const team of [state.self, state.opponent]) {
						assert.equal(team.active[0].species, species);
						assert(!team.active[0].volatiles.has('gastroacid'));
					}
					assert(!game.battle.p1.active[0].volatiles.gastroacid);
					assert(!game.battle.p2.active[0].volatiles.gastroacid);
				}
			} finally { game.battle.destroy(); }
		});

		for (const spec of [
			{ move: 'batonpass', reserve: false }, { move: 'shedtail', reserve: false },
			{ move: 'shedtail', reserve: true, weak: true },
			{ move: 'shedtail', reserve: true, substitute: true },
		]) it(`${gameType}: impossible transfer scores zero and fails in PS: ${JSON.stringify(spec)}`, () => {
			const actor = { species: 'Smeargle', ability: 'Own Tempo', moves: [spec.move] };
			const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
			const game = fixture(gameType, passive, actor, undefined, undefined, spec.reserve ? passive : undefined);
			try {
				const actual = game.battle.p2.active[0];
				if (spec.weak) {
					actual.hp = Math.ceil(actual.maxhp / 2);
					game.battle.makeRequest('move');
				}
				if (spec.substitute) actual.addVolatile('substitute', actual);
				const state = game.build();
				const move = buildAIMove({ id: spec.move }, 1);
				const score = new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
					.scoreMove(state, state.self.active[0], move, state.opponent.active[0]);
				assert.equal(score.score, 0);
				game.play('move 1', 'move 1');
				assert(game.battle.log.some(line => line.startsWith('|-fail|p2a: Smeargle')));
				assert.equal(game.battle.requestState, 'move');
			} finally { game.battle.destroy(); }
		});

		if (gameType === 'doubles') it('doubles: Wish and Future Sight keep their slots while Ally Switch moves their occupants', () => {
			const user = { species: 'Mew', ability: 'Synchronize', moves: ['wish', 'allyswitch', 'splash'] };
			const foe = { species: 'Smeargle', ability: 'Own Tempo', moves: ['futuresight', 'splash'] };
			const ally = { species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] };
			const game = fixture(gameType, foe, user, undefined, ally, undefined, 'gen9doublescustomgame');
			try {
				game.build();
				game.battle.p2.active[1].hp -= 200;
				game.play('move 1 1', 'move 1');
				game.build();
				game.play('move 2', 'move 2');
				const log = game.battle.log;
				const swap = log.findIndex(line => line.startsWith('|swap|p2a: Mew'));
				assert(swap > 0);
				const observer = createBattleTracker('p2');
				observer.setFormat('gen9doublescustomgame');
				observer.parseMessage(log.slice(0, swap + 1).join('\n'));
				assert.equal(observer.getWish('p2a'), 1);
				assert.equal(observer.getWish('p2b'), 0);
				assert(observer.getFutureMoves()[1] > 0);
				assert.equal(observer.getFutureMoves()[2] || 0, 0);
				assert(log.slice(swap).some(line => line.startsWith('|-heal|p2a: Blissey') && line.includes('[from] move: Wish')));
				const state = game.build();
				assert.equal(state.self.active[0].species, 'Blissey');
				assert(state.self.conditions.futureMoves[1] > 0);
				game.play('move 2', 'move 1', 'move 1', 'move 3');
				assert(game.battle.log.some(line => line.startsWith('|-end|p2a: Blissey|move: Future Sight')));
				assert.equal(game.build().self.conditions.futureMoves[1] || 0, 0);
			} finally { game.battle.destroy(); }
		});

		if (gameType === 'doubles') it(`doubles: Ally Switch moves each occupant's boosts, effects, action and identity memory`, () => {
			const source = { species: 'Mew', ability: 'Synchronize', item: 'Sitrus Berry',
				moves: ['calmmind', 'substitute', 'allyswitch'] };
			const partner = { species: 'Smeargle', ability: 'Own Tempo', moves: ['agility', 'rest', 'splash'] };
			const game = fixture(gameType, source, source, partner, partner, undefined, 'gen9doublescustomgame');
			try {
				game.build();
				game.play('move 1', 'move 1', 'move 1', 'move 1');
				game.build();
				for (const side of [game.battle.p1, game.battle.p2]) {
					side.active[0].hp = Math.floor(side.active[0].maxhp / 2) + 20;
					side.active[1].hp -= 100;
				}
				game.play('move 2', 'move 2', 'move 2', 'move 2');
				game.build();
				game.play('move 3', 'move 3', 'move 3', 'move 3');
				const state = game.build();
				for (const [actualSide, snapshot] of [[game.battle.p1, state.opponent], [game.battle.p2, state.self]]) {
					for (const [index, actual] of actualSide.active.entries()) {
						const target = snapshot.active.find(p => p.slot === index + 1);
						assert.equal(target.species, actual.species.name);
						assert.deepEqual(target.boosts, actual.boosts);
						assert.equal(target.volatiles.has('substitute'), !!actual.volatiles.substitute);
						assert.equal(target.activeMoveActions, 1);
						assert.equal(target.sleepTurns, index === 0 ? 2 : 0);
						assert.equal(target.recyclableItem, index === 1 ? 'sitrusberry' : '');
						assert.equal(toID(target.lastMove), index === 0 ? 'rest' : 'allyswitch');
					}
				}
				const originalUser = state.opponent.active.find(p => p.species === 'Mew');
				assert.equal(game.tracker.getOpponentTeam().find(p => p.species === 'Mew').position, 'p1b');
				assert.equal(originalUser.slot, 2);
			} finally { game.battle.destroy(); }
		});

		if (gameType !== 'doubles') it(`${gameType}: Ally Switch fails under PS rules and scores zero`, () => {
			const actor = { species: 'Smeargle', ability: 'Own Tempo', moves: ['allyswitch'] };
			const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
			const formatId = gameType === 'multi' ? 'gen9nationaldexmulti' : 'gen9customgame';
			const game = fixture(gameType, passive, actor, undefined, undefined, undefined, formatId);
			try {
				const state = game.build();
				const move = buildAIMove({ id: 'allyswitch' }, 1, formatId);
				const score = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId }, createAICache(state.turn))
					.scoreMove(state, state.self.active[0], move, state.opponent.active[0]);
				assert.equal(score.score, 0);
				game.play('move 1', 'move 1');
				assert(game.battle.log.some(line => line.startsWith('|-fail|p2a: Smeargle')));
				assert(!game.battle.log.some(line => line.startsWith('|swap|')));
			} finally { game.battle.destroy(); }
		});

		for (const [formatId, move] of [
			['gen5pokemmorandombattle', 'batonpass'], ['gen7customgame', 'batonpass'],
			['gen9customgame', 'batonpass'], ['gen9customgame', 'shedtail'],
		]) {
			it(`${gameType}/${formatId}: ${move} transfers only eligible public effects for both teams`, () => {
				const source = { species: 'Smeargle', ability: 'Own Tempo',
					moves: ['calmmind', move === 'batonpass' ? 'substitute' : 'aquaring', move, 'splash'] };
				const recipient = { species: 'Bronzong', ability: 'Levitate', moves: ['splash'] };
				const game = fixture(gameType, source, source, undefined, undefined, recipient, formatId);
				try {
					game.build();
					game.play('move 1', 'move 1');
					game.build();
					game.play('move 2', 'move 2');
					for (const side of [game.battle.p1, game.battle.p2]) {
						const actor = side.active[0];
						actor.addVolatile('magnetrise', actor);
						actor.addVolatile('gastroacid', actor);
						actor.addVolatile('yawn', actor);
					}
					game.build();
					game.play('move 3', 'move 3');
					const choice = `switch ${gameType === 'doubles' ? 3 : 2}`;
					while (game.battle.requestState === 'switch') {
						const side = game.battle.sides.find(s => s.activeRequest?.forceSwitch?.some(Boolean) && !s.isChoiceDone());
						assert(side, 'A switching request must identify its owner');
						assert(game.battle.choose(side.id, choice), side.choice.error);
					}
					const state = game.build();
					for (const [side, stateSide] of [[game.battle.p1, state.opponent], [game.battle.p2, state.self]]) {
						const actual = side.active[0];
						const target = stateSide.active[0];
						assert.equal(target.species, 'Bronzong');
						assert.deepEqual(target.boosts, actual.boosts);
						for (const effect of ['substitute', 'magnetrise', 'gastroacid', 'aquaring', 'yawn']) {
							assert.equal(target.volatiles.has(effect), !!actual.volatiles[effect], effect);
						}
						assert.equal(target.activeMoveActions, 0);
						assert.equal(target.lastMove, '');
						if (stateSide === state.self) {
							assert.equal(effectiveAbility(target, state.field), actual.ignoringAbility() ? '' : actual.ability);
						}
						assert(!stateSide.reserve.find(p => p.species === 'Smeargle').volatiles.has('substitute'));
					}
					game.play('move 1', 'move 1');
					assert.equal(game.battle.p1.active[0].status, '', 'Yawn cannot follow the passer');
					assert.equal(game.build().opponent.active[0].status, '');
				} finally { game.battle.destroy(); }
			});
		}

		it(`${gameType}: a failed Baton Pass cannot turn a later ordinary switch into a transfer`, () => {
			const source = { species: 'Smeargle', ability: 'Own Tempo', moves: ['calmmind', 'batonpass'] };
			const foe = { species: 'Mew', ability: 'Synchronize', moves: ['splash', 'taunt'] };
			const recipient = { species: 'Bronzong', ability: 'Levitate', moves: ['splash'] };
			const game = fixture(gameType, foe, source, undefined, undefined, recipient);
			try {
				game.build();
				game.play('move 1', 'move 1');
				game.build();
				game.play('move 2 1', 'move 2');
				game.build();
				game.play('move 1', `switch ${gameType === 'doubles' ? 3 : 2}`);
				const state = game.build();
				assert.deepEqual(state.self.active[0].boosts, game.battle.p2.active[0].boosts);
				assert.equal(state.self.active[0].boosts.spa, 0);
				assert(!state.self.active[0].volatiles.has('taunt'));
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: Illusion reassigns entry observations while preserving live effects and teammate history`, () => {
			const hidden = { name: 'Hidden', species: 'Zoroark', ability: 'Illusion', item: 'Sitrus Berry',
				moves: ['nastyplot', 'substitute', 'agility', 'splash'] };
			const user = { species: 'Smeargle', ability: 'Own Tempo', moves: ['splash', 'snarl'] };
			const mask = { name: 'Mask', species: 'Mew', ability: 'Synchronize', item: 'Leftovers', moves: ['calmmind'] };
			const game = fixture(gameType, hidden, user, undefined, undefined, mask);
			try {
				let state = game.build();
				assert.equal(state.opponent.active[0].species, 'Mew', 'Unrevealed Illusion must remain disguised');
				game.play('move 1', 'move 1');
				game.build();
				const actual = game.battle.p1.active[0];
				actual.hp = Math.floor(actual.maxhp / 2) + 20;
				game.play('move 2', 'move 1');
				game.build();
				assert.equal(actual.item, '');
				game.play('move 3', 'move 2');
				state = game.build();
				let target = state.opponent.active[0];
				assert.equal(target.species, 'Zoroark');
				assert.deepEqual(target.boosts, actual.boosts);
				assert(target.volatiles.has('substitute'));
				assert.equal(toID(target.lastMove), 'agility');
				assert.equal(target.activeMoveActions, 1);
				assert.equal(target.item, '');
				assert(target.itemLost);
				assert.equal(target.recyclableItem, 'sitrusberry');
				assert.equal(toID(target.originalItem), 'sitrusberry');
				assert(!game.tracker.getOpponentTeam().some(p => p.ident === 'p1:Mask'), 'Do not invent a seen teammate');
				const switchSlot = gameType === 'doubles' ? 3 : 2;
				game.play(`switch ${switchSlot}`, 'move 1');
				game.build();
				game.play('move 1', 'move 2');
				game.build();
				game.play(`switch ${switchSlot}`, 'move 1');
				game.build();
				game.play('move 4', 'move 2');
				state = game.build();
				target = state.opponent.active[0];
				assert.equal(target.species, 'Zoroark');
				const memory = game.tracker.getOpponentTeam();
				const real = memory.find(p => p.ident === 'p1:Hidden');
				const teammate = memory.find(p => p.ident === 'p1:Mask');
				assert.deepEqual(real.knownMoves.map(toID).sort(), ['agility', 'nastyplot', 'splash', 'substitute']);
				assert.deepEqual(teammate.knownMoves, ['Calm Mind']);
				assert.equal(toID(teammate.item), 'leftovers');
				assert.equal(toID(teammate.originalItem), 'leftovers');
				assert.equal(teammate.recyclableItem, '');
				assert(!teammate.active);
				assert(target.itemLost);
				assert.equal(target.recyclableItem, 'sitrusberry');
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: an inherited Rest counter is rebased on the revealed member after re-entry`, () => {
			const hidden = { name: 'Hidden', species: 'Zoroark', ability: 'Illusion', moves: ['rest'] };
			const user = { species: 'Smeargle', ability: 'Own Tempo', moves: ['splash', 'snarl'] };
			const mask = { name: 'Mask', species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
			const game = fixture(gameType, hidden, user, undefined, undefined, mask);
			try {
				game.build();
				game.battle.p1.active[0].hp -= 100;
				game.play('move 1', 'move 2');
				assert.equal(game.build().opponent.active[0].sleepTurns, 3);
				const switchSlot = gameType === 'doubles' ? 3 : 2;
				game.play(`switch ${switchSlot}`, 'move 1');
				game.build();
				game.play(`switch ${switchSlot}`, 'move 1');
				assert.equal(game.build().opponent.active[0].species, 'Mew');
				game.play('move 1', 'move 2');
				const target = game.build().opponent.active[0];
				assert.equal(target.species, 'Zoroark');
				assert.equal(target.sleepTurns, 2);
				assert.equal(target.sleepSelfInflicted, true);
				assert.equal(game.tracker.getSleepTurns('p1: Mask'), 0);
			} finally { game.battle.destroy(); }
		});

		if (gameType === 'doubles') it('doubles: an Illusion and its active namesake retain independent observations', () => {
			const hidden = { name: 'Hidden', species: 'Zoroark', ability: 'Illusion', item: 'Sitrus Berry',
				moves: ['nastyplot', 'substitute', 'agility'] };
			const mask = { name: 'Mask', species: 'Mew', ability: 'Synchronize', item: 'Leftovers', moves: ['rest'] };
			const user = { species: 'Smeargle', ability: 'Own Tempo', moves: ['splash', 'snarl'] };
			const game = fixture(gameType, hidden, user, mask);
			try {
				game.build();
				game.battle.p1.active[1].hp -= 100;
				game.play('move 1', 'move 1', 'move 1');
				game.build();
				const actual = game.battle.p1.active[0];
				actual.hp = Math.floor(actual.maxhp / 2) + 20;
				game.play('move 2', 'move 1', 'move 1');
				game.build();
				game.play('move 3', 'move 2', 'move 1');
				const state = game.build();
				const real = state.opponent.active.find(p => p.species === 'Zoroark');
				const teammate = state.opponent.active.find(p => p.species === 'Mew');
				assert(real.itemLost);
				assert.equal(real.recyclableItem, 'sitrusberry');
				assert.equal(real.sleepTurns, 0);
				assert.equal(teammate.sleepTurns, 1);
				assert.equal(toID(teammate.item), 'leftovers');
				assert.equal(teammate.recyclableItem, '');
				const memory = game.tracker.getOpponentTeam();
				assert.equal(memory.length, 2);
				assert.deepEqual(memory.find(p => p.ident === 'p1:Mask').knownMoves, ['Rest']);
				assert(!memory.find(p => p.ident === 'p1:Hidden').knownMoves.includes('Rest'));
			} finally { game.battle.destroy(); }
		});

		for (const own of [false, true]) {
			it(`${gameType}: ${own ? 'our' : 'opponent'} Illusion keeps Rest counters and source through the reveal`, () => {
				const hidden = { name: 'Hidden', species: 'Zoroark', ability: 'Illusion', moves: ['rest', 'splash'] };
				const user = { species: 'Smeargle', ability: 'Own Tempo', moves: ['splash', 'snarl'] };
				const mask = { name: 'Mask', species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
				const game = fixture(gameType, own ? user : hidden, own ? hidden : user, undefined, undefined, mask);
				try {
					game.build();
					const actual = game.battle[own ? 'p2' : 'p1'].active[0];
					actual.hp -= 100;
					game.play('move 1', 'move 1');
					let state = game.build();
					let target = (own ? state.self : state.opponent).active[0];
					assert.equal(target.sleepTurns, 3);
					assert.equal(target.sleepSelfInflicted, true);
					game.play(own ? 'move 2' : 'move 1', own ? 'move 1' : 'move 2');
					state = game.build();
					target = (own ? state.self : state.opponent).active[0];
					assert.equal(target.species, 'Zoroark');
					assert.equal(target.sleepTurns, 2);
					assert.equal(target.sleepSelfInflicted, true);
					assert.equal(game.tracker.getSelfInflictedSleep(`${own ? 'p2' : 'p1'}: Mask`), undefined);
					assert.equal(actual.statusState.time, 2);
				} finally { game.battle.destroy(); }
			});
		}

		for (const [ability, attack] of [['Primordial Sea', 'flamethrower'], ['Desolate Land', 'watergun'], ['Delta Stream', 'icebeam']]) {
			for (const suppress of [false, true]) {
				it(`${gameType}: ${ability} ${suppress ? 'under Air Lock' : 'active'} keeps its public identity and correct move effects`, () => {
					const holder = { species: 'Rayquaza', ability, moves: ['splash'] };
					const user = { species: 'Mew', ability: suppress ? 'Air Lock' : 'Synchronize', moves: [attack, 'sunnyday', 'splash'] };
					const reserve = { species: 'Slowking', ability: 'Own Tempo', moves: ['splash'] };
					const game = fixture(gameType, holder, user, undefined, undefined, reserve);
					try {
						let state = game.build();
						assert.equal(state.field.weatherId, toID(ability));
						assert.equal(state.field.weather, normalizeWeather(game.battle.field.effectiveWeather()));
						const move = buildAIMove({ id: attack }, 1);
						const estimate = calculateDamage(state.self.active[0], state.opponent.active[0], move, state.field);
						const blocked = !suppress && ability !== 'Delta Stream';
						assert.equal(estimate.average === 0, blocked);
						if (ability === 'Delta Stream') assert.equal(estimate.effectiveness, suppress ? 4 : 2);
						const weatherMove = buildAIMove({ id: 'sunnyday' }, 2);
						assert.equal(new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
							.scoreMove(state, state.self.active[0], weatherMove, state.opponent.active[0]).score, 0);
						game.play('move 1', 'move 1 1');
						assert.equal(game.battle.p1.active[0].hp === game.battle.p1.active[0].maxhp, blocked);
						game.build();
						game.play('move 1', gameType === 'doubles' ? 'switch 3' : 'switch 2');
						state = game.build();
						assert.equal(state.field.weather, normalizeWeather(game.battle.field.effectiveWeather()));
						assert(state.field.weather, 'Weather effects resume after Air Lock leaves');
					} finally { game.battle.destroy(); }
				});
			}
		}

		for (const formatId of ['gen6customgame', 'gen7customgame', 'gen5pokemmorandombattle', 'gen9customgame']) {
			it(`${gameType}, ${formatId}: single-move effects persist across turns and repeated Destiny Bond follows the format`, () => {
				const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
				const user = { species: 'Gengar', ability: 'Cursed Body', moves: ['destinybond', 'splash'] };
				const game = fixture(gameType, passive, user, undefined, undefined, undefined, formatId);
				try {
					game.build();
					game.play('move 1', 'move 1');
					let state = game.build();
					assert(state.self.active[0].volatiles.has('destinybond'));
					assert(game.battle.p2.active[0].volatiles.destinybond);
					const move = buildAIMove({ id: 'destinybond' }, 1, formatId);
					const score = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId }, createAICache(state.turn))
						.scoreMove(state, state.self.active[0], move, state.opponent.active[0]);
					const restricted = formatId !== 'gen6customgame';
					assert.equal(score.flags.hasNoEffect, restricted);
					if (restricted) assert.equal(score.score, 0);
					game.play('move 1', 'move 1');
					state = game.build();
					assert.equal(state.self.active[0].volatiles.has('destinybond'), !restricted);
					assert.equal(!!game.battle.p2.active[0].volatiles.destinybond, !restricted);
					game.play('move 1', 'move 2');
					assert(!game.build().self.active[0].volatiles.has('destinybond'));
				} finally { game.battle.destroy(); }
			});
		}

		for (const effect of ['destinybond', 'grudge', 'glaiverush']) {
			it(`${gameType}: ${effect} expires on the holder's sleep action, even without a move event`, () => {
				const passive = { species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] };
				const user = { species: 'Smeargle', ability: 'Own Tempo', moves: [effect, 'splash'] };
				const game = fixture(gameType, passive, user);
				try {
					game.build();
					game.play('move 1', effect === 'glaiverush' ? 'move 1 1' : 'move 1');
					assert(game.build().self.active[0].volatiles.has(effect));
					game.battle.p2.active[0].setStatus('slp', game.battle.p1.active[0], game.battle.dex.moves.get('spore'));
					game.play('move 1', 'move 2');
					assert(!game.battle.p2.active[0].volatiles[effect]);
					assert(!game.build().self.active[0].volatiles.has(effect));
				} finally { game.battle.destroy(); }
			});
		}

		it(`${gameType}: single-turn effects expire without clearing persistent effects`, () => {
			const passive = { species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] };
			const user = { species: 'Mew', ability: 'Synchronize', moves: ['protect', 'splash'] };
			const game = fixture(gameType, passive, user);
			try {
				game.build();
				game.play('move 1', 'move 1');
				assert(game.battle.log.some(line => line.startsWith('|-singleturn|')));
				assert(!game.build().self.active[0].volatiles.has('protect'));
				game.tracker.parseMessage('|-singleturn|p2a: Mew|move: Protect\n|-start|p2a: Mew|Substitute');
				assert(game.build().self.active[0].volatiles.has('protect'));
				game.tracker.parseMessage('|upkeep');
				const state = game.build();
				assert(!state.self.active[0].volatiles.has('protect'));
				assert(state.self.active[0].volatiles.has('substitute'));
			} finally { game.battle.destroy(); }
		});

		for (const own of [false, true]) {
			it(`${gameType}: Gastro Acid retains ability identity through requests and preset inference (${own ? 'self' : 'foe'})`, () => {
				const victim = { species: 'Raichu', ability: 'Lightning Rod', moves: ['splash'] };
				const user = { species: 'Mew', ability: 'Synchronize', moves: ['thunderbolt', 'gastroacid', 'splash'] };
				const reserve = { species: 'Snorlax', ability: 'Immunity', moves: ['splash'] };
				const game = fixture(gameType, own ? user : victim, own ? victim : user, undefined, undefined, reserve);
				try {
					game.build();
					game.play(own ? 'move 1 1' : 'move 1', own ? 'move 1' : 'move 1 1'); // Reveal before suppression.
					let state = game.build();
					let target = (own ? state.self : state.opponent).active[0];
					assert.equal(effectiveAbility(target, state.field), 'lightningrod');
					game.play(own ? 'move 2 1' : 'move 1', own ? 'move 1' : 'move 2 1');
					state = game.build();
					target = (own ? state.self : state.opponent).active[0];
					const simulated = game.battle[own ? 'p2' : 'p1'].active[0];
					assert(simulated.ignoringAbility());
					assert.equal(toID(target.ability), simulated.ability);
					assert(target.volatiles.has('gastroacid'));
					assert.equal(effectiveAbility(target, state.field), '');
					assert.equal(effectiveAbility((own ? game.build().self : game.build().opponent).active[0], state.field), '');
					const attack = buildAIMove({ id: 'thunderbolt' }, 1);
					const actor = (own ? state.opponent : state.self).active[0];
					assert(calculateDamage(actor, target, attack, state.field).average > 0);
					if (!own) for (const model of inferOpponent(target, 'gen7customgame')) {
						assert.equal(effectiveAbility(model.pokemon, state.field), '', model.name);
					}
					const switchChoice = gameType === 'doubles' ? 'switch 3' : 'switch 2';
					game.play(own ? 'move 3' : switchChoice, own ? switchChoice : 'move 3');
					game.build();
					game.play(own ? 'move 3' : switchChoice, own ? switchChoice : 'move 3');
					state = game.build();
					target = (own ? state.self : state.opponent).active[0];
					assert.equal(effectiveAbility(target, state.field), 'lightningrod');
					assert(!target.volatiles.has('gastroacid'));
				} finally { game.battle.destroy(); }
			});
		}

		for (const move of ['skillswap', 'roleplay', 'worryseed']) {
			it(`${gameType}: ${move} changes ability identity while Gastro Acid keeps suppressing it`, () => {
				const target = { species: 'Bronzong', ability: 'Levitate', moves: ['splash'] };
				const user = { species: 'Mew', ability: 'Synchronize', moves: ['earthquake', 'gastroacid', move] };
				const game = fixture(gameType, target, user);
				try {
					game.build();
					game.play('move 1', 'move 1');
					game.build();
					game.play('move 1', 'move 2 1');
					game.build();
					game.play('move 1', 'move 3 1');
					const state = game.build();
					for (const [ai, actual] of [[state.self.active[0], game.battle.p2.active[0]],
						[state.opponent.active[0], game.battle.p1.active[0]]]) {
						assert.equal(toID(ai.ability), actual.ability);
						assert.equal(effectiveAbility(ai, state.field), actual.ignoringAbility() ? '' : actual.ability);
					}
					assert.equal(toID(state.opponent.active[0].observedAbility), 'levitate');
					assert.equal(effectiveAbility(state.opponent.active[0], state.field), '');
				} finally { game.battle.destroy(); }
			});
		}

		for (const item of ['', 'Ability Shield']) {
			it(`${gameType}: Neutralizing Gas, ${item || 'no shield'}, Magic Room and switching match PS`, () => {
				const gas = { species: 'Weezing', ability: 'Neutralizing Gas', moves: ['splash'] };
				const victim = { species: 'Bronzong', ability: 'Levitate', item, moves: ['magicroom', 'splash'] };
				const reserve = { species: 'Snorlax', ability: 'Immunity', moves: ['splash'] };
				const game = fixture(gameType, gas, victim, undefined, undefined, reserve);
				try {
					const verify = () => {
						const state = game.build();
						const target = state.self.active[0];
						const simulated = game.battle.p2.active[0];
						assert.equal(toID(target.ability), simulated.ability);
						assert.equal(effectiveAbility(target, state.field), simulated.ignoringAbility() ? '' : simulated.ability);
						assert.equal(grounded(target, state.field), !!simulated.isGrounded());
						const move = buildAIMove({ id: 'earthquake' }, 1);
						assert.equal(calculateDamage(state.opponent.active[0], target, move, state.field).average === 0,
							!simulated.runImmunity('Ground'));
						return state;
					};
					assert(verify().field.neutralizingGas);
					game.play('move 1', 'move 1');
					assert(verify().field.magicroom);
					game.play(gameType === 'doubles' ? 'switch 3' : 'switch 2', 'move 2');
					assert.equal(verify().field.neutralizingGas, false);
				} finally { game.battle.destroy(); }
			});
		}

		it(`${gameType}: Early Bird counts each sleep action with the ability effective at that time`, () => {
			const user = { species: 'Mew', ability: 'Synchronize', moves: ['splash', 'worryseed'] };
			const sleeper = { species: 'Snorlax', ability: 'Early Bird', moves: ['rest', 'splash'] };
			const game = fixture(gameType, user, sleeper);
			try {
				game.battle.p2.active[0].hp = Math.floor(game.battle.p2.active[0].maxhp / 2);
				game.build();
				game.play('move 1', 'move 1');
				game.build();
				game.play('move 1', 'move 2');
				let state = game.build();
				assert.equal(game.battle.p2.active[0].statusState.time, 1);
				assert.equal(state.self.active[0].sleepTurns, 1);
				// Suppress Early Bird between sleep checks; the already-counted decrement stays 2.
				game.battle.p2.active[0].addVolatile('gastroacid', game.battle.p1.active[0]);
				state = game.build();
				assert.equal(effectiveAbility(state.self.active[0], state.field), '');
				assert.equal(state.self.active[0].sleepTurns, 1);
				game.play('move 1', 'move 2');
				assert.equal(game.build().self.active[0].status, '');
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: Gas removal by Gastro Acid restores other abilities without forgetting the source`, () => {
			const gas = { species: 'Weezing', ability: 'Neutralizing Gas', moves: ['splash'] };
			const user = { species: 'Bronzong', ability: 'Levitate', moves: ['gastroacid'] };
			const game = fixture(gameType, gas, user);
			try {
				assert(game.build().field.neutralizingGas);
				game.play('move 1', 'move 1 1');
				const state = game.build();
				assert(game.battle.p1.active[0].ignoringAbility());
				assert(!state.field.neutralizingGas);
				assert.equal(toID(state.opponent.active[0].ability), 'neutralizinggas');
				assert.equal(effectiveAbility(state.self.active[0], state.field), 'levitate');
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: removing our Gas source in a projected switch restores the incoming ability`, () => {
			const gas = { species: 'Weezing', ability: 'Neutralizing Gas', moves: ['splash'] };
			const victim = { species: 'Bronzong', ability: 'Levitate', moves: ['splash'] };
			const game = fixture(gameType, victim, gas, undefined, undefined, victim);
			try {
				const state = game.build();
				const outgoing = state.self.active[0];
				const incoming = state.self.reserve[0];
				const projected = replaceActivePokemon(state, outgoing, incoming);
				assert(state.field.neutralizingGas, 'Projection must not mutate the current state');
				assert(!projected.field.neutralizingGas);
				assert.equal(effectiveAbility(incoming, projected.field), 'levitate');
				game.play('move 1', gameType === 'doubles' ? 'switch 3' : 'switch 2');
				const actual = game.build();
				assert.equal(effectiveAbility(actual.self.active[0], actual.field), 'levitate');
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: berry healing cannot restore a consumed item, and Poltergeist respects public itemlessness`, () => {
			const victim = { species: 'Mew', ability: 'Synchronize', item: 'Sitrus Berry', moves: ['splash', 'recycle'] };
			const attacker = { species: 'Mew', ability: 'Synchronize', moves: ['seismictoss', 'poltergeist', 'splash'] };
			const game = fixture(gameType, victim, attacker);
			try {
				game.build();
				game.battle.p1.active[0].hp = Math.floor(game.battle.p1.active[0].maxhp / 2) + 20;
				game.play('move 1', 'move 1 1');
				let state = game.build();
				let target = state.opponent.active[0];
				assert(game.battle.log.some(l => l.includes('|-heal|') && l.includes('item: Sitrus Berry')));
				assert.equal(game.battle.p1.active[0].item, '');
				assert.equal(target.item, '');
				assert(target.itemLost);
				assert.equal(target.recyclableItem, 'sitrusberry');
				assert(target.volatiles.has('itemlost'), 'Healing must not erase the Unburden activation fact');
				const move = buildAIMove({ id: 'poltergeist' }, 1);
				assert.equal(calculateDamage(state.self.active[0], target, move, state.field).average, 0);
				assert.equal(new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
					.scoreMove(state, state.self.active[0], move, target).score, 0);
				game.play('move 1', 'move 2 1');
				assert(game.battle.log.slice(-10).some(l => l.startsWith('|-fail|')));
				game.build();
				game.play('move 2', 'move 3');
				state = game.build();
				target = state.opponent.active[0];
				assert.equal(game.battle.p1.active[0].item, 'sitrusberry');
				assert.equal(toID(target.item), 'sitrusberry', 'Explicit Recycle really does restore the held item');
				assert(!target.itemLost);
				assert(calculateDamage(state.self.active[0], target, move, state.field).average > 0);
			} finally { game.battle.destroy(); }
		});

		for (const moveId of ['fakeout', 'firstimpression']) {
			it(`${gameType}: ${moveId} availability resets only after switching`, () => {
				const player = { species: 'Blissey', ability: 'Natural Cure', moves: [moveId, 'splash'] };
				const npc = { species: 'Smeargle', ability: 'Own Tempo', moves: [moveId, 'splash'] };
				const reserve = { species: 'Snorlax', ability: 'Immunity', moves: ['splash'] };
				const game = fixture(gameType, player, npc, undefined, undefined, reserve);
				try {
					let state = game.build();
					const move = buildAIMove({ id: moveId }, 1);
					const score = () => new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
						.scoreMove(state, state.self.active[0], move, state.opponent.active[0]);
					assert(!score().flags.hasNoEffect);
					game.play('move 2', 'move 2');
					state = game.build();
					assert.equal(score().score, 0);
					assert.equal(score().flags.isImmune, false);
					assert.equal(calculateDamage(state.opponent.active[0], state.self.active[0], move, state.field).max, 0);
					const cursor = game.battle.log.length;
					game.play('move 1 1', 'move 1 1');
					assert.equal(game.battle.log.slice(cursor).filter(l => l.startsWith('|-fail|')).length, 2);
					game.build();
					const choice = gameType === 'doubles' ? 'switch 3' : 'switch 2';
					game.play(choice, choice);
					state = game.build();
					assert.equal(state.opponent.reserve.find(p => p.species === 'Blissey').lastMove, '');
					game.play(choice, choice);
					state = game.build();
					assert(!score().flags.hasNoEffect);
				} finally { game.battle.destroy(); }
			});
		}

		for (const spec of [
			{ move: 'substitute', lowHP: true }, { move: 'substitute', volatile: 'substitute' },
			{ move: 'leechseed', target: 'Venusaur' }, { move: 'leechseed', volatile: 'leechseed' },
		]) {
			it(`${gameType}: guaranteed volatile-effect failure scores zero: ${JSON.stringify(spec)}`, () => {
				const player = { species: spec.target || 'Blissey', ability: 'Natural Cure', moves: ['splash'] };
				const npc = { species: 'Smeargle', ability: 'Own Tempo', moves: [spec.move, 'tackle'] };
				const game = fixture(gameType, player, npc);
				try {
					game.build();
					const source = game.battle.p2.active[0], target = game.battle.p1.active[0];
					if (spec.lowHP) source.hp = Math.floor(source.maxhp / 4);
					if (spec.volatile) (spec.move === 'substitute' ? source : target).addVolatile(spec.volatile, source);
					game.battle.makeRequest('move');
					const state = game.build();
					const score = new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
						.scoreMove(state, state.self.active[0], buildAIMove({ id: spec.move }, 1), state.opponent.active[0]);
					assert.equal(score.score, 0);
					assert.equal(score.breakdown.positives, 0);
					const cursor = game.battle.log.length;
					game.play('move 1', spec.move === 'substitute' ? 'move 1' : 'move 1 1');
					assert(game.battle.log.slice(cursor).some(l => /^\|-(fail|immune)\|/.test(l)));
				} finally { game.battle.destroy(); }
			});
		}

		for (const formatId of ['gen4customgame', 'gen5customgame']) {
			it(`${gameType}/${formatId}: consumed-item ownership on switching matches PS`, () => {
				const mon = { species: 'Blissey', ability: 'Natural Cure', item: 'Iron Ball', moves: ['fling', 'splash'] };
				const reserve = { species: 'Snorlax', ability: 'Immunity', moves: ['splash'] };
				const game = fixture(gameType, mon, mon, undefined, undefined, reserve, formatId);
				try {
					game.build();
					game.play('move 1 1', 'move 1 1');
					game.build();
					const choice = gameType === 'doubles' ? 'switch 3' : 'switch 2';
					game.play(choice, choice);
					const state = game.build();
					for (const [side, owner] of [['self', 'p2'], ['opponent', 'p1']]) {
						assert.equal(state[side].active[0].recyclableItem, game.battle[owner].active[0].lastItem);
						assert.equal(state[side].reserve.find(p => p.species === 'Blissey').recyclableItem,
							game.battle[owner].pokemon.find(p => p.species.name === 'Blissey').lastItem);
					}
				} finally { game.battle.destroy(); }
			});
		}

		for (const formatId of ['gen4customgame', 'gen5customgame']) {
			it(`${gameType}/${formatId}: Knock Off's item-exchange restriction follows the format`, () => {
				const player = { species: 'Blissey', ability: 'Natural Cure', item: 'Iron Ball', moves: ['splash'] };
				const npc = { species: 'Smeargle', ability: 'Own Tempo', item: 'Leftovers', moves: ['knockoff', 'trick'] };
				const game = fixture(gameType, player, npc, undefined, undefined, undefined, formatId);
				try {
					game.build();
					game.play('move 1', 'move 1 1');
					const state = game.build();
					const gen4 = formatId === 'gen4customgame';
					assert.equal(!!state.opponent.active[0].itemKnockedOff, gen4);
					const score = new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
						.scoreMove(state, state.self.active[0], buildAIMove({ id: 'trick' }, 2, formatId), state.opponent.active[0]);
					assert.equal(!!score.flags.hasNoEffect, gen4);
					const cursor = game.battle.log.length;
					game.play('move 1', 'move 2 1');
					assert.equal(game.battle.log.slice(cursor).some(l => l.startsWith('|-fail|p2')), gen4);
				} finally { game.battle.destroy(); }
			});
		}

		it(`${gameType}: acquiring and losing another item preserves the last consumed item`, () => {
			const player = { species: 'Smeargle', ability: 'Own Tempo', item: 'Leftovers', moves: ['splash', 'trick', 'knockoff'] };
			const npc = { species: 'Blissey', ability: 'Natural Cure', item: 'Iron Ball', moves: ['fling', 'recycle', 'splash'] };
			const game = fixture(gameType, player, npc);
			try {
				game.build();
				game.play('move 1', 'move 1 1');
				game.build();
				game.play('move 2 1', 'move 3');
				let state = game.build();
				assert.equal(state.self.active[0].item, 'leftovers');
				assert.equal(state.self.active[0].recyclableItem, 'ironball');
				assert.equal(state.opponent.active[0].originalItem, 'Leftovers');
				assert.equal(state.opponent.active[0].itemChanged, true);
				game.play('move 3 1', 'move 3');
				state = game.build();
				assert.equal(state.self.active[0].item, '');
				assert.equal(state.self.active[0].recyclableItem, 'ironball');
				assert.equal(game.battle.p2.active[0].lastItem, 'ironball');
				game.play('move 1', 'move 2');
				state = game.build();
				assert.equal(state.self.active[0].item, 'ironball');
				assert.equal(state.self.active[0].recyclableItem, '');
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: Transform does not change the species that binds an item`, () => {
			const player = { species: 'Charizard', ability: 'Blaze', item: 'Charizardite X', moves: ['fling'] };
			const npc = { species: 'Ditto', ability: 'Limber', item: 'Charizardite X', moves: ['transform'] };
			const game = fixture(gameType, player, npc);
			try {
				game.build();
				game.play('move 1 1', 'move 1 1');
				const state = game.build();
				const actor = state.self.active[0], target = state.opponent.active[0];
				assert.equal(actor.species, 'Charizard');
				assert.equal(actor.baseSpecies, 'Ditto');
				const move = buildAIMove({ id: 'fling' }, 1);
				const score = new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn)).scoreMove(state, actor, move, target);
				assert(!score.flags.hasNoEffect);
				assert(calculateDamage(actor, target, move, state.field).max > 0);
				game.play('move 1 1', 'move 1 1');
				assert.equal(game.build().self.active[0].item, '');
			} finally { game.battle.destroy(); }
		});

		for (const [moveId, item] of [['knockoff', 'Oran Berry'], ['incinerate', 'Oran Berry'], ['pluck', 'Oran Berry'], ['tackle', 'Air Balloon']]) {
			it(`${gameType}: ${moveId} removing ${item} does not create a recyclable item`, () => {
				const player = { species: 'Smeargle', ability: 'Own Tempo', moves: [moveId] };
				const npc = { species: 'Blissey', ability: 'Natural Cure', item, moves: ['splash', 'recycle'] };
				const game = fixture(gameType, player, npc);
				try {
					game.build();
					game.play(moveId === 'incinerate' ? 'move 1' : 'move 1 1', 'move 1');
					const state = game.build();
					assert.equal(state.self.active[0].item, '');
					assert.equal(state.self.active[0].recyclableItem, '');
					assert.equal(game.battle.p2.active[0].lastItem, '');
					const score = new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
						.scoreMove(state, state.self.active[0], buildAIMove({ id: 'recycle' }, 2), state.opponent.active[0]);
					assert.equal(score.score, 0);
				} finally { game.battle.destroy(); }
			});
		}

		it(`${gameType}: Natural Gift consumption is confirmed by our request, not an opponent's hidden item`, () => {
			const player = { species: 'Blissey', ability: 'Natural Cure', item: 'Oran Berry', moves: ['naturalgift', 'splash'] };
			const npc = { species: 'Chansey', ability: 'Natural Cure', item: 'Oran Berry', moves: ['naturalgift', 'recycle'] };
			const game = fixture(gameType, player, npc);
			try {
				game.build();
				game.play('move 1 1', 'move 1 1');
				const state = game.build();
				assert.equal(state.self.active[0].recyclableItem, 'oranberry');
				assert.equal(state.self.active[0].item, '');
				assert.equal(state.opponent.active[0].recyclableItem, undefined);
				assert.equal(state.opponent.active[0].itemKnown, false);
			} finally { game.battle.destroy(); }
		});

		for (const [moveId, formatId] of ['gen4customgame', 'gen5pokemmorandombattle', 'gen7customgame', 'gen9customgame']
			.flatMap(format => ['futuresight', 'doomdesire'].map(move => [move, format]))) {
			it(`${gameType}/${formatId}: ${moveId} occupies the target position through switching and expires after impact`, () => {
				const player = { species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] };
				const npc = { species: 'Slowbro', ability: 'Own Tempo', moves: [moveId, 'splash'] };
				const reserve = { species: 'Snorlax', ability: 'Immunity', moves: ['splash'] };
				const game = fixture(gameType, player, npc, undefined, undefined, reserve, formatId);
				try {
					game.build();
					game.play('move 1', 'move 1 1');
					let state = game.build();
					assert.equal(state.opponent.conditions.futureMoves[1], 2);
					assert(!state.self.active[0].volatiles.has(moveId));
					const score = target => new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
						.scoreMove(state, state.self.active[0], buildAIMove({ id: moveId }, 1, formatId), target);
					assert.equal(score(state.opponent.active[0]).score, 0);
					if (gameType !== 'singles') assert(!score(state.opponent.active[1]).flags.hasNoEffect, JSON.stringify(score(state.opponent.active[1])));
					const cursor = game.battle.log.length;
					game.play(gameType === 'doubles' ? 'switch 3' : 'switch 2', 'move 1 1');
					state = game.build();
					assert(game.battle.log.slice(cursor).some(l => l.startsWith('|-fail|p2')));
					assert.equal(state.opponent.active[0].species, 'Snorlax');
					assert.equal(state.opponent.conditions.futureMoves[1], 1);
					assert.equal(score(state.opponent.active[0]).score, 0);
					game.play('move 1', 'move 2');
					state = game.build();
					assert.equal(state.opponent.conditions.futureMoves[1], 0);
					assert(!score(state.opponent.active[0]).flags.hasNoEffect);
				} finally { game.battle.destroy(); }
			});
		}

		it(`${gameType}: consumed items survive switching, and Recycle clears consumption history`, () => {
			const player = { species: 'Smeargle', ability: 'Own Tempo', item: 'Iron Ball', moves: ['fling', 'recycle', 'splash'] };
			const npc = { species: 'Blissey', ability: 'Natural Cure', item: 'Iron Ball', moves: ['fling', 'recycle', 'splash'] };
			const reserve = { species: 'Snorlax', ability: 'Immunity', moves: ['splash'] };
			const game = fixture(gameType, player, npc, undefined, undefined, reserve);
			try {
				let state = game.build();
				const scoreRecycle = () => new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(state.turn))
					.scoreMove(state, state.self.active[0], buildAIMove({ id: 'recycle' }, 2), state.opponent.active[0]);
				assert.equal(scoreRecycle().score, 0);
				game.play('move 1 1', 'move 1 1');
				state = game.build();
				for (const side of ['self', 'opponent']) {
					assert.equal(state[side].active[0].recyclableItem, 'ironball');
					assert.equal(state[side].active[0].item, '');
				}
				assert(!scoreRecycle().flags.hasNoEffect);
				const switchChoice = gameType === 'doubles' ? 'switch 3' : 'switch 2';
				game.play(switchChoice, switchChoice);
				state = game.build();
				assert.equal(state.self.active[0].recyclableItem, '');
				game.play(switchChoice, switchChoice);
				state = game.build();
				assert.equal(state.self.active[0].recyclableItem, 'ironball');
				assert.equal(state.opponent.active[0].recyclableItem, 'ironball');
				game.play('move 2', 'move 2');
				state = game.build();
				for (const side of ['self', 'opponent']) {
					assert.equal(state[side].active[0].recyclableItem, '');
					assert.equal(toID(state[side].active[0].item), 'ironball');
				}
				assert.equal(scoreRecycle().score, 0);
			} finally { game.battle.destroy(); }
		});

		for (const moveId of ['sunnyday', 'electricterrain', 'spikes', 'toxicspikes', 'stealthrock',
			'stickyweb', 'reflect', 'lightscreen', 'tailwind', 'safeguard', 'wish']) {
			it(`${gameType}: an existing ${moveId} effect cannot earn repeat-use rewards`, () => {
				const player = { species: 'Smeargle', ability: 'Own Tempo', moves: ['splash'] };
				const npc = { species: 'Blissey', ability: 'Natural Cure', moves: [moveId, 'seismictoss'] };
				const game = fixture(gameType, player, npc);
				try {
					game.build();
					const layers = moveId === 'spikes' ? 3 : moveId === 'toxicspikes' ? 2 : 1;
					for (let i = 0; i < layers; i++) {
						game.play('move 1', 'move 1');
						game.build();
					}
					const state = game.build();
					const score = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: 'gen9customgame' }, createAICache(state.turn))
						.scoreMove(state, state.self.active[0], buildAIMove({ id: moveId }, 1), state.opponent.active[0]);
					assert.equal(score.score, 0, JSON.stringify(score.breakdown));
					assert.equal(score.flags.hasNoEffect, true);
					assert.equal(score.breakdown.positives, 0);
					const cursor = game.battle.log.length;
					game.play('move 1', 'move 1');
					assert(game.battle.log.slice(cursor).some(line => line.startsWith('|-fail|p2')));
				} finally { game.battle.destroy(); }
			});
		}

		it(`${gameType}: Transform copies public changed types and subsequent type changes override the copy`, () => {
			const player = { species: 'Smeargle', ability: 'Own Tempo', moves: ['soak', 'transform', 'splash'] };
			const npc = { species: 'Charizard', ability: 'Blaze', moves: ['splash', 'forestscurse'] };
			const game = fixture(gameType, player, npc);
			try {
				game.build();
				game.play('move 1 1', 'move 1');
				game.build();
				game.play('move 2 1', 'move 1');
				assert.deepEqual(game.build().opponent.active[0].types, ['Water']);
				game.play('move 1', 'move 2 1');
				assert.deepEqual(game.build().opponent.active[0].types, game.battle.p1.active[0].getTypes());
				assert.deepEqual(game.build().opponent.active[0].types, ['Water', 'Grass']);
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: public type changes and added types agree with PS and reset on switching`, () => {
			const mon = { species: 'Mew', ability: 'Pressure', moves: ['soak', 'trickortreat', 'forestscurse', 'reflecttype'] };
			const partner = { name: 'Partner', species: 'Mew', ability: 'Pressure', moves: ['splash'] };
			const game = fixture(gameType, mon, mon, partner, partner,
				{ species: 'Snorlax', ability: 'Pressure', moves: ['splash'] });
			try {
				const inspect = () => {
					const state = game.build();
					assert.deepEqual(state.self.active[0].types, game.battle.p2.active[0].getTypes());
					assert.deepEqual(state.opponent.active[0].types, game.battle.p1.active[0].getTypes());
				};
				inspect();
				for (const move of [1, 2, 3, 4]) {
					game.play(`move ${move} 1`, `move ${move} 1`);
					inspect();
				}
				game.play(`switch ${gameType === 'doubles' ? 3 : 2}`, `switch ${gameType === 'doubles' ? 3 : 2}`);
				inspect();
				const state = game.build();
				assert.deepEqual(state.opponent.reserve[0].types, ['Psychic']);
				game.play(`switch ${gameType === 'doubles' ? 3 : 2}`, `switch ${gameType === 'doubles' ? 3 : 2}`);
				inspect();
				assert.deepEqual(game.build().opponent.active[0].types, ['Psychic']);
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: Slow Start public start/end controls speed and Attack`, () => {
			const mon = { species: 'Regigigas', ability: 'Slow Start', moves: ['splash'] };
			const game = fixture(gameType, mon, mon);
			try {
				const inspect = active => {
					const state = game.build();
					for (const side of ['self', 'opponent']) {
						const actor = state[side].active[0];
						assert.equal(actor.volatiles.has('slowstart'), active);
						assert.equal(getEffectiveSpeed(actor, state.field), Math.floor(actor.baseStats.spe * (active ? 0.5 : 1)));
					}
					const actor = state.self.active[0];
					assert.equal(getAttackStat(actor, buildAIMove({ id: 'tackle' }, 1), state.field), game.battle.p2.active[0].getStat('atk'));
				};
				inspect(true);
				for (let turn = 0; turn < 5; turn++) game.play('move 1', 'move 1');
				inspect(false);
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: both teams expose Quark Drive activation and expiry`, () => {
			const mon = { species: 'Iron Bundle', ability: 'Quark Drive', moves: ['electricterrain', 'splash'] };
			const game = fixture(gameType, mon, mon);
			try {
				game.play('move 1', 'move 1');
				const active = game.build();
				for (const side of ['self', 'opponent']) assert.equal(active[side].active[0].abilityStatMod.stat, 'spe');
				for (let turn = 0; turn < 5; turn++) game.play('move 2', 'move 2');
				const expired = game.build();
				for (const side of ['self', 'opponent']) assert.equal(expired[side].active[0].abilityStatMod.stat, null);
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: public screens affect Normal KO checks and Hard damage consistently`, () => {
			const game = fixture(gameType, { species: 'Mew', ability: 'Pressure', moves: ['reflect', 'safeguard'] },
				{ species: 'Mew', ability: 'Pressure', moves: ['splash', 'tackle', 'toxic'] });
			try {
				game.play('move 1', 'move 1');
				game.play('move 2', 'move 1');
				const state = game.build();
				const actor = state.self.active[0];
				const target = state.opponent.active[0];
				assert(state.opponent.conditions.safeguard);
				const move = buildAIMove({ id: 'tackle' }, 1, state.field.formatId);
				const context = { isDoubles: state.isDoubles, numAliveTargets: 1,
					defenderSideConditions: state.opponent.conditions };
				const cache = createAICache(state.turn);
				const plain = calculateDamage(actor, target, move, state.field, cache);
				const screened = calculateDamage(actor, target, move, state.field, cache, context);
				assert(screened.average < plain.average);
				const hard = new HardEvaluation(state, state.field.formatId);
				assert.equal(hard.damage(actor, target, move).average, screened.average);
				const wounded = { ...target, hp: Math.ceil((plain.average + screened.average) / 2) };
				const ai = new NormalAI({ write() {} });
				ai.battleState = state;
				assert.equal(ai.canKOWithAverageDamage(actor, wounded, move), false);
				const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: state.field.formatId }, createAICache(state.turn));
				assert.equal(engine.scoreMove(state, actor, buildAIMove({ id: 'toxic' }, 1), target).score, 0);
			} finally { game.battle.destroy(); }
		});

		if (gameType !== 'singles') for (const [ability, moveId, species] of [
			['Sweet Veil', 'hypnosis', 'Mew'], ['Flower Veil', 'toxic', 'Tangela'], ['Aroma Veil', 'taunt', 'Mew'],
		]) it(`${gameType}: public ${ability} protects an ally`, () => {
			const game = fixture(gameType, { species, ability: 'Pressure', moves: ['splash'] },
				{ species: 'Mew', ability: 'Pressure', moves: [moveId] },
				{ species: 'Mew', ability, moves: ['splash'] });
			try {
				game.battle.p2.active[0].boosts.accuracy = 6;
				game.play('move 1', 'move 1 1');
				const state = game.build();
				assert.equal(toID(state.opponent.active[1].ability), toID(ability));
				const result = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: state.field.formatId }, createAICache(state.turn))
					.scoreMove(state, state.self.active[0], buildAIMove({ id: moveId }, 1), state.opponent.active[0]);
				assert.equal(result.score, 0);
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: gravity removes Flying immunity consistently in public state, damage and scoring`, () => {
			const game = fixture(gameType,
				{ species: 'Charizard', ability: 'Blaze', moves: ['splash'] },
				{ species: 'Mew', ability: 'Synchronize', moves: ['gravity', 'earthquake'] }, undefined,
				{ species: 'Charizard', ability: 'Blaze', moves: ['splash'] });
			try {
				const inspect = immune => {
					const state = game.build();
					assert.equal(state.field.formatId, 'gen9customgame');
					const actor = state.self.active[0];
					const target = state.opponent.active[0];
					const move = buildAIMove({ id: 'earthquake' }, 1, state.field.formatId);
					const result = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: state.field.formatId }, createAICache(state.turn))
						.scoreMove(state, actor, move, target);
					assert.equal(result.flags.isImmune, immune);
					if (!immune && gameType !== 'singles') {
						assert(result.breakdown.details.some(d => d.reason.startsWith('Spread move') && d.amount < 0));
					}
					assert.equal(calculateDamage(actor, target, move, state.field).average === 0, immune);
					assert.equal(new HardEvaluation(state, state.field.formatId).damage(actor, target, move).average === 0, immune);
				};
				inspect(true);
				game.play('move 1', 'move 1');
				inspect(false);
				const hp = game.battle.p1.active[0].hp;
				game.play('move 1', 'move 2');
				assert(game.battle.p1.active[0].hp < hp);
			} finally { game.battle.destroy(); }
		});

		if (gameType !== 'singles') it(`${gameType}: public Armor Tail protects its ally in scoring and both threat evaluators`, () => {
			const game = fixture(gameType,
				{ species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] },
				{ species: 'Mew', ability: 'Synchronize', moves: ['quickattack'] },
				{ species: 'Farigiraf', ability: 'Armor Tail', moves: ['splash'] });
			try {
				game.play('move 1', 'move 1 1');
				assert.equal(game.battle.p1.active[0].hp, game.battle.p1.active[0].maxhp);
				const state = game.build();
				const actor = state.self.active[0];
				const target = state.opponent.active[0];
				assert.equal(toID(state.opponent.active[1].ability), 'armortail');
				const move = buildAIMove({ id: 'quickattack' }, 1, state.field.formatId);
				const result = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: state.field.formatId }, createAICache(state.turn))
					.scoreMove(state, actor, move, target);
				assert.equal(result.score, 0);
				assert.equal(result.flags.canKO, false);
				assert.equal(new HardEvaluation(state, state.field.formatId).damage(actor, target, move).average, 0);
				const ai = new NormalAI({ write() {} });
				ai.battleState = { ...state, self: state.opponent, opponent: state.self };
				assert.equal(ai.getIncomingThreat(target, [actor]), 0);
				const reserve = { ...target, active: false, slot: 3 };
				const protector = state.opponent.active[1];
				assert(ai.getIncomingThreat(reserve, [actor], protector) > 0,
					'An outgoing Armor Tail holder cannot protect its replacement');
				const evaluation = new HardEvaluation(ai.battleState, state.field.formatId);
				const predictions = new Map([[actor, [{ user: actor, move, weight: 1 }]]]);
				const sheltered = evaluation.scoreSwitch(reserve, predictions, false, target);
				const exposed = evaluation.scoreSwitch(reserve, predictions, false, protector);
				assert(sheltered.reasons[0].includes('damage 0.0 HP'));
				assert(!exposed.reasons[0].includes('damage 0.0 HP'));
				const cache = createAICache(state.turn);
				assert(calculateDamage(actor, target, move, state.field, cache).average > 0);
				assert.equal(calculateDamage(actor, target, move, state.field, cache,
					{ isDoubles: true, numAliveTargets: 1, defenderAllies: state.opponent.active }).average, 0);
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: public Quark Drive speed matches the simulator`, () => {
			const game = fixture(gameType, { species: 'Mew', moves: ['splash'] },
				{ species: 'Iron Bundle', ability: 'Quark Drive', item: 'Booster Energy', moves: ['splash'] });
			try {
				const state = game.build();
				const actor = state.self.active[0];
				assert.equal(actor.abilityStatMod.stat, 'spe');
				assert.equal(getEffectiveSpeed(actor, state.field), game.battle.p2.active[0].getStat('spe'));
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: scoring consumes the team's public Tailwind`, () => {
			const fast = { species: 'Jolteon', ability: 'Volt Absorb', moves: ['splash'] };
			const setter = { species: 'Jirachi', ability: 'Serene Grace', moves: ['tailwind', 'psychic'] };
			const game = fixture(gameType, fast, setter, fast, setter);
			try {
				const goesFirst = () => {
					const state = game.build();
					const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: 'gen9customgame' }, createAICache(state.turn));
					return engine.scoreMove(state, state.self.active[0], buildAIMove({ id: 'psychic' }, 1, 'gen9customgame'),
						state.opponent.active[0]).flags.goesFirst;
				};
				assert.equal(goesFirst(), false);
				game.play('move 1', 'move 1');
				assert.equal(goesFirst(), true);
			} finally { game.battle.destroy(); }
		});

		it(`${gameType}: keeps Wish on its field position and does not refresh a failed repeated Wish`, () => {
			const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
			const wisher = { species: 'Jirachi', ability: 'Serene Grace', moves: ['wish', 'protect'] };
			const game = fixture(gameType, passive, gameType === 'singles' ? wisher : passive, passive, wisher);
			try {
				game.play('move 1', 'move 1');
				const state = game.build();
				const slot = gameType === 'singles' ? 1 : 2;
				assert.equal(state.self.conditions.wishes[slot], 1);
				assert.equal(state.self.conditions.wishes[slot === 1 ? 2 : 1] || 0, 0);
				assert.deepEqual(state.opponent.conditions.wishes, {});
				const evaluation = new HardEvaluation(state, 'gen9customgame');
				for (const original of state.self.active) {
					const actor = { ...original, hp: original.maxHp / 2, hpPercent: 50 };
					const result = evaluation.scoreMoves(actor, [buildAIMove({ id: 'protect' }, 1, 'gen9customgame')],
						state.opponent.active[0], new Map())[0];
					const protection = result.breakdown.details.find(d => d.reason.startsWith('CFRU ShouldProtect'));
					assert.equal(protection.amount, actor.slot === slot ? 40 : -12);
				}
				if (gameType !== 'singles') {
					const wounded = state.self.active.map(p => p.slot === 2 ? { ...p, hp: p.maxHp / 2, hpPercent: 50 } : p);
					const healingState = { ...state, self: { ...state.self, active: wounded, team: wounded } };
					const result = new HardEvaluation(healingState, 'gen9customgame').scoreMoves(wounded[0],
						[buildAIMove({ id: 'wish' }, 1, 'gen9customgame')], state.opponent.active[0], new Map())[0];
					assert.equal(result.breakdown.details.find(d => d.reason.startsWith('CFRU Wish')).amount, -90,
						'A healthy actor cannot use Wish to heal the other active position');
				}
				game.play('move 1', 'move 1');
				const expired = game.build();
				assert(game.battle.log.some(line => line.startsWith('|-fail|') && line.includes('Jirachi')));
				assert.equal(expired.self.conditions.wishes[slot], 0);
			} finally { game.battle.destroy(); }
		});

		for (const own of [false, true]) {
			it(`${gameType}: applies Transform to ${own ? 'our Pokemon' : 'the opponent'} through the shared builder`, () => {
				const ditto = { species: 'Ditto', level: 87, ability: 'Limber', item: 'Choice Scarf', moves: ['transform'] };
				const jolteon = { species: 'Jolteon', level: 77, ability: 'Volt Absorb', moves: ['calmmind'] };
				const game = fixture(gameType, own ? jolteon : ditto, own ? ditto : jolteon);
				try {
					game.build();
					game.play(own ? 'move 1' : 'move 1 1', own ? 'move 1 1' : 'move 1');
					const state = game.build();
					const actor = (own ? state.self : state.opponent).active.find(p => p.slot === 1);
					const simulated = game.battle[own ? 'p2' : 'p1'].active[0];
					assert(simulated.transformed);
					assert.equal(actor.species, simulated.species.name);
					assert.deepEqual(actor.types, simulated.getTypes());
					assert.equal(toID(actor.ability), simulated.ability);
					assert.equal(actor.boosts.spa, simulated.boosts.spa);
					assert.equal(actor.boosts.spd, simulated.boosts.spd);
					assert.equal(actor.level, 87);
					if (!own) for (const stat of ['atk', 'def', 'spa', 'spd', 'spe']) {
						assert.equal(actor.baseStats[stat], simulated.storedStats[stat], stat);
					}
					assert.equal(state.self.active.length, gameType === 'singles' ? 1 : 2);
				} finally { game.battle.destroy(); }
			});
		}

		it(`${gameType}: reads terrain, rooms, gravity and both teams' screens from protocol`, () => {
			const setter = { species: 'Mew', ability: 'Synchronize',
				moves: ['electricterrain', 'magicroom', 'gravity', 'wonderroom'] };
			const screen = { species: 'Mew', ability: 'Synchronize', moves: ['reflect', 'lightscreen'] };
			const game = fixture(gameType, setter, setter, screen, screen);
			try {
				game.play('move 1', 'move 2', 'move 1', 'move 2');
				game.play('move 3', 'move 4', 'move 1', 'move 2');
				let state = game.build();
				assert.equal(state.field.terrain, 'electric');
				for (const field of ['gravity', 'magicroom', 'wonderroom']) {
					assert.equal(state.field[field], !!game.battle.field.getPseudoWeather(field), field);
				}
				if (gameType !== 'singles') {
					assert.equal(!!state.opponent.conditions.reflect, !!game.battle.p1.sideConditions.reflect);
					assert.equal(!!state.self.conditions.lightscreen, !!game.battle.p2.sideConditions.lightscreen);
					assert.equal(state.self.conditions.reflect, 0, 'p3 Reflect must not be assigned to our team');
				}
				game.play('move 1', 'move 2');
				state = game.build();
				assert.equal(state.field.magicroom, false);
			} finally { game.battle.destroy(); }
		});
	}

	it('does not share damage, speed or knockout cache entries between equal ally/opponent slots', () => {
		const { state } = decision();
		const actor = state.self.active[0];
		const target = { ...state.opponent.active[0], slot: 2, hp: 150, maxHp: 150, types: ['Fire'],
			baseStats: { ...state.opponent.active[0].baseStats, spe: 100 } };
		const ally = { ...target, types: ['Grass'], baseStats: { ...target.baseStats, spe: 500 } };
		const move = buildAIMove({ id: 'flamethrower' }, 1);
		const cache = createAICache(1);
		for (const pokemon of [target, ally]) {
			assert.deepEqual(calculateDamage(actor, pokemon, move, state.field, cache), calculateDamage(actor, pokemon, move, state.field));
			assert.equal(isFaster(actor, pokemon, state.field, cache), isFaster(actor, pokemon, state.field));
			assert.deepEqual(analyzeKnockout(actor, pokemon, move, [], state.field, cache),
				analyzeKnockout(actor, pokemon, move, [], state.field));
		}
		isFaster(actor, ally, state.field, cache, { tailwind: 1 }, {});
		assert.equal(isFaster(actor, ally, state.field, cache), false, 'Tailwind must not pollute the unscreened speed cache');
	});
});
