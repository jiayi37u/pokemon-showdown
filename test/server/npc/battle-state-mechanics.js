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
const { getEffectiveSpeed, isFaster } = require('../../../dist/server/npc/ai/cfru/util/speed');
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

describe('Shared public state pipeline across game types', () => {
	function fixture(gameType, team1, team2, partner1, partner2) {
		const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
		const multi = gameType === 'multi';
		const battle = new Battle({
			format: { ...Dex.formats.get('gen9customgame'), gameType, playerCount: multi ? 4 : 2 }, seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: gameType === 'doubles' ? [team1, partner1 || passive] : [team1] },
			p2: { name: 'NPC', team: gameType === 'doubles' ? [team2, partner2 || passive] : [team2] },
			...(multi ? { p3: { name: 'Player2', team: [partner1 || passive] },
				p4: { name: 'NPC2', team: [partner2 || passive] } } : {}),
		});
		battle.makeChoices();
		const tracker = createBattleTracker('p2', multi);
		tracker.setFormat('gen9customgame');
		let cursor = 0;
		const build = () => {
			tracker.parseMessage(battle.log.slice(cursor).join('\n'));
			cursor = battle.log.length;
			const config = { ...DEFAULT_AI_CONFIG, formatId: 'gen9customgame', isDoubles: gameType !== 'singles' };
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
