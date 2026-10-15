'use strict';

const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { HardAI } = require('../../../dist/server/npc/ai/hard');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { fightingStyle, hardMove, inferOpponent, predictOpponent, compatibleSlots } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { buildBattleStateWithTracker, buildPokemonFromRequest } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');

const mon = (species, moves, extra = {}) => ({ species, moves, ...extra });
let battle;
afterEach(() => { battle?.destroy(); battle = undefined; });

function setup(foes, team, { doubles = false, AI = HardAI, format = '' } = {}) {
	battle = new Battle({
		formatid: format || (doubles ? 'gen9doublescustomgame' : 'gen9customgame'), seed: [1, 2, 3, 4],
		p1: { name: 'Player', team: foes }, p2: { name: 'NPC', team },
	});
	battle.makeChoices(); // Team preview only.
	let choice;
	const ai = new AI({ write() {} }, { seed: [1, 2, 3, 4] });
	ai.choose = value => { choice = value; };
	const room = { format: battle.format.id, turn: battle.turn };
	Object.defineProperty(room, 'sides', { get() { throw new Error('AI cannot inspect hidden simulator sides'); } });
	// Hard only needs the public room turn and format, not simulator objects.
	ai.setBattle(room);
	ai.getTracker().parseMessage(battle.log.join('\n'));
	const reveal = (moves = foes[0].moves) => {
		for (const move of moves) ai.getTracker().parseMessage(`|move|p1a: ${foes[0].species}|${Dex.moves.get(move).name}|p2a: NPC`);
	};
	return { ai, reveal, decide() { ai.receiveRequest(battle.p2.activeRequest); return choice; } };
}

describe('Hard CFRU tactical decisions', () => {
	it('keeps a guaranteed first-strike KO despite a lethal opposing move', () => {
		const game = setup([mon('Blastoise', ['surf'])], [
			mon('Pikachu', ['thunderbolt'], { ability: 'Static' }), mon('Gastrodon', ['earthpower'], { ability: 'Storm Drain' }),
		]);
		const foe = battle.p1.active[0];
		foe.hp = 1;
		game.ai.getTracker().parseMessage('|-damage|p1a: Blastoise|1/300');
		battle.p2.active[0].hp = 1;
		battle.makeRequest('move');
		game.reveal();
		assert.equal(game.decide(), 'move 1');
	});

	it('escapes a predicted KO into an absorbing reserve, and respects trapping', () => {
		const game = setup([mon('Kyogre', ['surf'])], [
			mon('Torkoal', ['flamethrower']), mon('Gastrodon', ['earthpower'], { ability: 'Storm Drain' }),
		]);
		game.reveal();
		assert.equal(game.decide(), 'switch 2');
		battle.p2.activeRequest.active[0].trapped = true;
		assert.equal(game.decide(), 'move 1');
	});

	it('does not sacrifice a replacement to entry hazards', () => {
		const game = setup([mon('Kyogre', ['surf'])], [
			mon('Torkoal', ['flamethrower']), mon('Gastrodon', ['earthpower'], { ability: 'Storm Drain' }),
		]);
		game.reveal();
		game.ai.getTracker().parseMessage('|-sidestart|p2: NPC|Spikes');
		battle.p2.pokemon[1].hp = 1;
		battle.makeRequest('move');
		assert.equal(game.decide(), 'move 1');
	});

	it('uses public Perish Song countdown and clears it after switching', () => {
		const game = setup([mon('Magikarp', ['splash'])], [mon('Blissey', ['seismictoss']), mon('Snorlax', ['bodyslam'])]);
		game.ai.getTracker().parseMessage('|-start|p2a: Blissey|perish1');
		assert.equal(game.decide(), 'switch 2');
		game.ai.getTracker().parseMessage('|switch|p2a: Snorlax|Snorlax|100/100');
		assert.equal(game.ai.getTracker().getVolatiles('a').size, 0);
	});

	it('prefers Taunt against a predicted setup, but never repeats it on a taunted target', () => {
		const game = setup([mon('Shuckle', ['shellsmash'])], [mon('Crobat', ['taunt', 'absorb'])]);
		game.reveal();
		assert.equal(game.decide(), 'move 1');
		game.ai.getTracker().parseMessage('|-start|p1a: Shuckle|move: Taunt');
		assert.equal(game.decide(), 'move 2');
		game.ai.getTracker().parseMessage('|-end|p1a: Shuckle|move: Taunt');
		assert.equal(game.decide(), 'move 1');
	});

	it('does not try a slower recovery when the predicted attack KOs first', () => {
		const game = setup([mon('Mewtwo', ['aurasphere'])], [mon('Blissey', ['softboiled', 'seismictoss'])]);
		game.reveal();
		battle.p2.active[0].hp = 1;
		battle.makeRequest('move');
		assert.equal(game.decide(), 'move 2');
	});

	it('uses a safe switch to clear Natural Cure status', () => {
		const game = setup([mon('Magikarp', ['splash'])], [
			mon('Blissey', ['seismictoss'], { ability: 'Natural Cure' }), mon('Snorlax', ['bodyslam']),
		]);
		battle.p2.active[0].setStatus('par');
		battle.makeRequest('move');
		game.reveal();
		assert.equal(game.decide(), 'switch 2');
	});

	it('switches away from Yawn but avoids consecutive nonurgent switches', () => {
		const game = setup([mon('Magikarp', ['splash'])], [mon('Blissey', ['seismictoss']), mon('Snorlax', ['bodyslam'])]);
		game.reveal();
		game.ai.getTracker().parseMessage('|-start|p2a: Blissey|move: Yawn');
		assert.equal(game.decide(), 'switch 2');
		assert.equal(game.decide(), 'move 1'); // Same turn: cooldown forbids another optional switch.
		game.ai.getTracker().parseMessage('|-start|p2a: Blissey|perish1');
		assert.equal(game.decide(), 'switch 2'); // Urgent countdown bypasses cooldown.
	});

	it('does not treat breaking a Substitute as preventing the opposing attack', () => {
		const game = setup([mon('Blastoise', ['surf'])], [
			mon('Pikachu', ['thunderbolt']), mon('Gastrodon', ['earthpower'], { ability: 'Storm Drain' }),
		]);
		game.reveal();
		game.ai.getTracker().parseMessage('|-damage|p1a: Blastoise|1/300\n|-start|p1a: Blastoise|Substitute');
		battle.p2.active[0].hp = 1;
		battle.makeRequest('move');
		assert.equal(game.decide(), 'switch 2');
	});

	it('chooses a forced replacement that survives hazards', () => {
		const game = setup([mon('Magikarp', ['splash'])], [
			mon('Blissey', ['seismictoss']), mon('Charizard', ['flamethrower']), mon('Snorlax', ['bodyslam']),
		]);
		battle.p2.pokemon[1].hp = 1;
		game.ai.getTracker().parseMessage('|-sidestart|p2: NPC|Stealth Rock');
		battle.p2.active[0].faint();
		battle.faintMessages();
		battle.p2.active[0].switchFlag = true;
		battle.makeRequest('switch');
		assert.equal(game.decide(), 'switch 3');
	});

	it('retains Normal strategy registration and threat thresholds', () => {
		const game = setup([mon('Kyogre', ['surf'])], [mon('Blissey', ['softboiled', 'seismictoss'])], { AI: NormalAI });
		assert.equal(game.ai.difficulty, 'normal');
		assert(game.ai.scoringEngine.positiveScorers.some(fn => fn.name === 'rewardTaunt'));
		assert.equal(NormalAI.SWITCH_THREAT_TRIGGER, 0.7);
		assert.equal(NormalAI.SWITCH_THREAT_LIMIT, 0.4);
	});
});

describe('Hard public observations and prediction', () => {
	it('keeps observations for identical species on different Multi players separate', () => {
		const tracker = createBattleTracker('p2', true);
		tracker.parseMessage('|switch|p1a: Mew|Mew|100/100\n|switch|p3b: Mew|Mew|100/100\n|move|p1a: Mew|Taunt|p2a: NPC');
		assert.equal(tracker.getOpponentTeam().length, 2);
		assert.deepEqual(tracker.getActiveOpponents().find(p => p.position === 'p3b').pokemon.knownMoves, []);
	});

	it('passes tracked effects and our hazards into state construction', () => {
		const game = setup([mon('Mew', ['taunt'])], [mon('Blissey', ['softboiled'])]);
		game.ai.getTracker().parseMessage('|-start|p1a: Mew|Substitute\n|-start|p2a: Blissey|move: Taunt\n|-sidestart|p2: NPC|Spikes');
		const state = buildBattleStateWithTracker(battle.p2.activeRequest, null, game.ai.getTracker());
		assert(state.self.active[0].volatiles.has('taunt'));
		assert(state.opponent.active[0].volatiles.has('substitute'));
		assert.equal(state.self.conditions.spikes, 1);
		game.ai.getTracker().reset();
		assert.equal(game.ai.getTracker().getVolatiles('a').size, 0);
	});

	it('infers roles from moves and uses MMO move metadata', () => {
		const game = setup([mon('Mew', ['splash'])], [mon('Garchomp', ['swordsdance', 'earthquake'])]);
		const pokemon = buildPokemonFromRequest(battle.p2.activeRequest.side.pokemon[0], 1, true);
		assert.equal(fightingStyle(pokemon, 'gen9customgame'), 'setup');
		assert.equal(hardMove('outrage', 1, 'gen5pokemmoou').basePower, 90);
		assert.equal(game.ai.difficulty, 'hard');
	});

	it('predicts only observed/preset moves and does not mutate revealed information', () => {
		const game = setup([mon('Shuckle', ['splash', 'toxic'])], [mon('Blissey', ['seismictoss'])]);
		game.reveal(['toxic']);
		const state = buildBattleStateWithTracker(battle.p2.activeRequest, null, game.ai.getTracker());
		const evaluation = new HardEvaluation(state, 'gen9customgame');
		const foe = state.opponent.active[0];
		const moves = evaluation.predictions(state.self.active[0]).get(foe).filter(p => p.move).map(p => p.move.id);
		assert(moves.includes('toxic'));
		assert(!moves.includes('splash')); // Hidden simulator move is not a preset or observation.
		assert.deepEqual(game.ai.getTracker().getActiveOpponent().knownMoves, ['Toxic']);
	});
});

describe('CLI doubles opponent', () => {
	it('submits explicit live targets for max-damage moves', () => {
		const { MaxDamagePlayer } = require('../../../dist/test/npc/sim-battle/strategies');
		setup([mon('Pikachu', ['thunderbolt']), mon('Snorlax', ['bodyslam'])],
			[mon('Blastoise', ['surf']), mon('Blissey', ['seismictoss'])], { doubles: true });
		const player = new MaxDamagePlayer({ stream: { write() {} }, label: 'p1', trace: false });
		let choice;
		player.choose = value => { choice = value; };
		for (const line of battle.log) player.receiveLine(line);
		player.receiveRequest(battle.p1.activeRequest);
		assert(/^move [1-4] [12], move [1-4] [12]$/.test(choice), choice);
		assert(battle.choose('p1', choice), battle.p1.choice.error);
	});
});

describe('Hard gen7 OU inference and tactics', () => {
	function snapshot(game) {
		return buildBattleStateWithTracker(battle.p2.activeRequest, null, game.ai.getTracker(), { formatId: 'gen7ou' });
	}
	function evaluate(game) {
		const state = snapshot(game);
		const evaluator = new HardEvaluation(state, 'gen7ou');
		const actor = state.self.active[0];
		const foe = state.opponent.active[0];
		const predictions = evaluator.predictions(actor);
		const scores = evaluator.scoreMoves(actor, actor.moves.map((m, i) => hardMove(m, i + 1, 'gen7ou')), foe, predictions);
		return { state, evaluator, actor, foe, predictions, scores };
	}

	it('ships a complete local factual snapshot with valid gen7 IDs and move slots', () => {
		const data = require('../../../data/npc/strategies/gen7ou.json');
		const dex = Dex.forFormat('gen7ou');
		assert.equal(Object.keys(data.species).length, 104);
		assert.equal(Object.values(data.species).flat().length, 174);
		for (const [species, sets] of Object.entries(data.species)) {
			assert(dex.species.get(species).exists, species);
			for (const set of sets) {
				assert(set.moves.length > 0 && set.moves.length <= 4, `${species}: ${set.name}`);
				for (const move of set.moves.flat()) assert(dex.moves.get(move).exists, move);
				for (const item of set.items) assert(dex.items.get(item).exists, item);
				for (const ability of set.abilities) assert(dex.abilities.get(ability).exists, ability);
				for (const nature of set.natures) assert(dex.natures.get(nature).exists, nature);
			}
		}
	});

	it('narrows Landorus sets from revealed moves and a consumed item without mutating observations', () => {
		const game = setup([mon('Landorus-Therian', ['earthquake'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		const infer = () => inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		assert(new Set(infer().map(h => h.name)).size > 1);
		game.reveal(['swordsdance']);
		assert.deepEqual([...new Set(infer().map(h => h.name))], ['Swords Dance']);
		game.ai.getTracker().parseMessage('|-enditem|p1a: Landorus-Therian|Flyinium Z');
		assert(infer().every(h => h.pokemon.item === ''));
		assert.deepEqual(game.ai.getTracker().getActiveOpponent().knownMoves, ['Swords Dance']);
	});

	it('does not combine mutually exclusive options from the same move slot', () => {
		const slots = [['surf', 'hydropump'], ['icebeam'], ['toxic'], ['protect']];
		assert(!compatibleSlots(slots, ['surf', 'hydropump']));
		assert(compatibleSlots([['surf', 'hydropump'], ['surf'], ['toxic'], ['protect']], ['surf', 'hydropump']));
		const game = setup([mon('Landorus-Therian', ['earthquake'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		game.reveal(['swordsdance', 'stealthrock', 'earthquake', 'fly']);
		const models = inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		assert(models.every(h => h.moves.length === 4 && !h.moves.some(m => m.id === 'stoneedge')));
	});

	it('recognizes an out-of-book set instead of resurrecting contradicted preset moves', () => {
		const game = setup([mon('Garchomp', ['earthquake'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		game.reveal(['surf', 'flamethrower', 'dragonclaw', 'rest']);
		const models = inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		assert.equal(models.length, 1);
		assert.equal(models[0].matched, false);
		assert.deepEqual(models[0].moves.map(m => m.id), ['surf', 'flamethrower', 'dragonclaw', 'rest']);
	});

	it('retains Choice Band and Scarf uncertainty until an item is publicly revealed', () => {
		const game = setup([mon('Kartana', ['leafblade'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		game.reveal(['leafblade', 'smartstrike', 'knockoff', 'sacredsword']);
		let models = inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		assert.deepEqual([...new Set(models.map(h => h.pokemon.item))].sort(), ['choiceband', 'choicescarf']);
		assert(Math.abs(models.reduce((n, h) => n + h.weight, 0) - 1) < 1e-9);
		game.ai.getTracker().parseMessage('|-item|p1a: Kartana|Choice Scarf');
		models = inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		assert(models.every(h => h.pokemon.item === 'Choice Scarf' && h.name.includes('Choice Scarf')));
	});

	it('learns passive items and does not treat a Tricked item as evidence of the original set', () => {
		const game = setup([mon('Tapu Fini', ['surf'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		game.ai.getTracker().parseMessage('|-heal|p1a: Tapu Fini|100/100|[from] item: Leftovers');
		game.ai.getTracker().parseMessage('|-item|p1a: Tapu Fini|Choice Scarf|[from] move: Trick');
		const foe = snapshot(game).opponent.active[0];
		assert.equal(foe.originalItem, 'Leftovers');
		const models = inferOpponent(foe, 'gen7ou');
		assert(models.every(h => h.matched && h.pokemon.item === 'Choice Scarf'));
	});

	it('uses public Mega changes and excludes the other Mega form', () => {
		const game = setup([mon('Charizard', ['flamethrower'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		game.ai.getTracker().parseMessage('|detailschange|p1a: Charizard|Charizard-Mega-X, M');
		const foe = snapshot(game).opponent.active[0];
		assert.equal(foe.species, 'Charizard-Mega-X');
		assert(inferOpponent(foe, 'gen7ou').every(h => h.matched && h.pokemon.item === 'charizarditex'));
	});

	it('does not infer permanent moves from Z attacks or called moves', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Garchomp|Garchomp|100/100');
		tracker.parseMessage('|move|p1a: Garchomp|Continental Crush|p2a: NPC|[zeffect]');
		tracker.parseMessage('|move|p1a: Garchomp|Surf|p2a: NPC|[from] move: Metronome');
		assert.deepEqual(tracker.getActiveOpponent().knownMoves, []);
		tracker.parseMessage('|move|p1a: Garchomp|Earthquake|p2a: NPC');
		assert.deepEqual(tracker.getActiveOpponent().knownMoves, ['Earthquake']);
	});

	it('retains attack risk even when CFRU predicts a switch', () => {
		const game = setup([mon('Garchomp', ['earthquake'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		const state = snapshot(game);
		const foe = state.opponent.active[0];
		state.opponent.reserve = [{ ...foe, active: false }];
		const actions = predictOpponent(state, foe, state.self.active[0], 'gen7ou', (s, a, moves) =>
			moves.map(move => ({ move, score: 90 })));
		assert(actions.some(a => a.switching));
		assert(actions.some(a => a.move?.category !== 'Status' && a.weight > 0));
		assert(Math.abs(actions.reduce((n, a) => n + a.weight, 0) - 1) < 1e-9);
	});

	it('uses modeled Choice Scarf speed and Choice Band damage independently', () => {
		const game = setup([mon('Kartana', ['leafblade'])], [mon('Alakazam', ['psychic'], {
			evs: { spe: 252 }, nature: 'Timid',
		})], { format: 'gen7customgame' });
		game.reveal(['leafblade', 'smartstrike', 'knockoff', 'sacredsword']);
		const { evaluator, foe, actor } = evaluate(game);
		const models = inferOpponent(foe, 'gen7ou');
		const band = models.find(h => h.pokemon.item === 'choiceband').pokemon;
		const scarf = models.find(h => h.pokemon.item === 'choicescarf').pokemon;
		const leaf = hardMove('leafblade', 1, 'gen7ou');
		assert(evaluator.damage(band, actor, leaf).average > evaluator.damage(scarf, actor, leaf).average);
		const psychic = hardMove('psychic', 1, 'gen7ou');
		assert.equal(evaluator.first(actor, band, psychic, leaf), 1);
		assert.equal(evaluator.first(actor, scarf, psychic, leaf), 0);
	});

	it('uses Fake Out once and rejects it after a blocked action', () => {
		const game = setup([mon('Blissey', ['seismictoss'])], [mon('Lopunny', ['fakeout', 'tackle'])], { format: 'gen7customgame' });
		game.reveal();
		assert.equal(game.decide(), 'move 1');
		game.ai.getTracker().parseMessage('|cant|p2a: Lopunny|flinch');
		assert.equal(game.decide(), 'move 2');
	});

	it('uses Wish for missing HP and Protect while the Wish is pending', () => {
		const game = setup([mon('Magikarp', ['splash'])], [mon('Jirachi', ['wish', 'protect', 'tackle'])], { format: 'gen7customgame' });
		battle.p2.active[0].hp = Math.floor(battle.p2.active[0].maxhp / 2);
		battle.makeRequest('move');
		const initial = evaluate(game).scores;
		assert(initial[0].score > initial[1].score);
		game.ai.getTracker().parseMessage('|turn|1\n|move|p2a: Jirachi|Wish|p2a: Jirachi\n|turn|2');
		const pending = evaluate(game).scores;
		assert(pending[1].score > pending[0].score);
	});

	it('does not cast Wish when it will faint before acting even with an injured recipient', () => {
		const game = setup([mon('Mewtwo', ['aurasphere'])], [
			mon('Blissey', ['wish', 'seismictoss']), mon('Snorlax', ['bodyslam']),
		], { format: 'gen7customgame' });
		battle.p2.active[0].hp = 1;
		battle.p2.pokemon[1].hp = Math.floor(battle.p2.pokemon[1].maxhp / 3);
		battle.makeRequest('move');
		game.reveal(['aurasphere', 'psychic', 'icebeam', 'flamethrower']);
		assert.equal(evaluate(game).scores[0].score, 0);
	});

	it('passes a pending Wish to a safe injured reserve', () => {
		const game = setup([mon('Magikarp', ['splash'])], [
			mon('Jirachi', ['wish', 'tackle']), mon('Blissey', ['seismictoss']),
		], { format: 'gen7customgame' });
		battle.p2.pokemon[1].hp = Math.floor(battle.p2.pokemon[1].maxhp / 3);
		battle.makeRequest('move');
		game.reveal(['splash']);
		game.ai.getTracker().parseMessage('|turn|1\n|move|p2a: Jirachi|Wish|p2a: Jirachi\n|turn|2');
		assert.equal(game.decide(), 'switch 2');
	});

	it('uses public team size without inventing identities for unrevealed reserves', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|teamsize|p1|6\n|switch|p1a: Garchomp|Garchomp|100/100');
		assert.equal(tracker.getRemainingOpponents(), 6);
		assert.equal(tracker.getOpponentTeam().length, 1);
		tracker.parseMessage('|faint|p1a: Garchomp');
		assert.equal(tracker.getRemainingOpponents(), 5);
	});

	it('values weather-dependent recovery using the actual weather', () => {
		const game = setup([mon('Magikarp', ['splash'])], [mon('Venusaur', ['synthesis', 'tackle'])],
			{ format: 'gen7customgame' });
		battle.p2.active[0].hp = Math.floor(battle.p2.active[0].maxhp / 4);
		battle.makeRequest('move');
		const state = snapshot(game);
		const actor = state.self.active[0], foe = state.opponent.active[0];
		const score = weather => {
			state.field.weather = weather;
			const evaluator = new HardEvaluation(state, 'gen7ou');
			return evaluator.scoreMoves(actor, [hardMove('synthesis', 1, 'gen7ou')], foe, evaluator.predictions(actor))[0].score;
		};
		assert(score('sun') > score('rain'));
	});

	it('prioritizes the matching screen against an observed special attack', () => {
		const game = setup([mon('Mewtwo', ['psychic'])], [mon('Deoxys-Speed', ['reflect', 'lightscreen'])], { format: 'gen7customgame' });
		game.reveal(['psychic', 'psystrike', 'aurasphere', 'icebeam']);
		const { scores } = evaluate(game);
		assert(scores[1].score > scores[0].score);
	});

	it('preserves Return and Frustration power from our side request', () => {
		assert.equal(hardMove('frustration102', 1, 'gen7ou').basePower, 102);
		assert.equal(hardMove('return1', 1, 'gen7ou').basePower, 1);
	});

	it('uses Mega evolution and evaluates a physical Z attack from its base move', () => {
		const game = setup([mon('Blissey', ['seismictoss'])], [mon('Lopunny', ['return'], { item: 'Lopunnite' })], { format: 'gen7customgame' });
		assert(/ mega$/.test(game.decide()));
		battle.destroy(); battle = undefined;
		const z = setup([mon('Mew', ['psychic'])], [mon('Garchomp', ['earthquake'], {
			item: 'Groundium Z', nature: 'Adamant', evs: { atk: 252 },
		})], { format: 'gen7customgame' });
		const foe = battle.p1.active[0];
		foe.hp = Math.floor(foe.maxhp * 0.65);
		z.ai.getTracker().parseMessage(`|-damage|p1a: Mew|${foe.hp}/${foe.maxhp}`);
		assert(/ zmove$/.test(z.decide()));
	});
});

describe('NPC imported battle-only forms', () => {
	it('passes the normalized sample team to the actual battle room', async () => {
		const fs = require('fs');
		const path = require('path');
		const { Teams } = require('../../../dist/sim');
		const { NPC } = require('../../../dist/server/npc/manager');
		const { createNPCBattle } = require('../../../dist/server/npc/room');
		NPC.loadTemplates();
		const originalCreate = Rooms.createBattle;
		const originalSupport = NPC.supportsFormat;
		const originalTeam = NPC.getTeam;
		let options;
		try {
			Rooms.createBattle = value => { options = value; return { settings: {} }; };
			NPC.supportsFormat = () => true;
			NPC.getTeam = () => [{ species: 'Blissey', ability: 'Natural Cure', moves: ['Seismic Toss'] }];
			for (const [number, species, ability] of [[1, 'Lopunny', 'Limber'], [2, 'Charizard', 'Blaze']]) {
				const team = Teams.import(fs.readFileSync(path.resolve(__dirname,
					`../../npc/sim-battle/sample-teams/sample_team_${number}_gen7ou.txt`), 'utf8'));
				const result = await createNPCBattle({ user: { id: 'player', name: 'Player' },
					npcId: 'norman', format: 'gen7ou', difficulty: 'hard', team });
				assert.equal(result.success, true, result.error);
				const normalized = Teams.unpack(options.players[0].team);
				assert.equal(normalized[0].species, species);
				assert.equal(normalized[0].ability, ability);
			}
		} finally {
			Rooms.createBattle = originalCreate;
			NPC.supportsFormat = originalSupport;
			NPC.getTeam = originalTeam;
		}
	});
});

describe('Hard generic opponent presets', () => {
	const { getOpponentPreset, computeStatsFromPreset, canHaveOpponentMoves } =
		require('../../../dist/server/npc/ai/cfru/util/opponent-presets');
	const { getEffectiveSpeed } = require('../../../dist/server/npc/ai/cfru/util/speed');
	function snapshot(game, format) {
		return buildBattleStateWithTracker(battle.p2.activeRequest, null, game.ai.getTracker(), { formatId: format });
	}

	for (const format of ['gen5pokemmoou', 'gen6ou', 'gen7ou', 'gen9nationaldex']) {
		it(`uses default Fighting threats before Scrafty reveals a move in ${format}`, () => {
			const game = setup([mon('Scrafty', ['drainpunch', 'crunch'])], [
				mon('Tyranitar', ['dragondance', 'crunch'], { evs: { atk: 252, spe: 252 }, nature: 'Jolly' }),
				mon('Gliscor', ['earthquake', 'roost'], { evs: { hp: 252, def: 252 }, nature: 'Impish' }),
			], { format });
			const state = snapshot(game, format);
			const foe = state.opponent.active[0];
			const models = inferOpponent(foe, format);
			assert(models.every(h => !h.matched && h.name === 'default'));
			assert(models[0].moves.some(m => m.id === 'drainpunch'));
			assert.deepEqual(foe.moves, []);
			const evaluator = new HardEvaluation(state, format);
			const actor = state.self.active[0];
			const predictions = evaluator.predictions(actor);
			assert(evaluator.incomingRisk(actor, predictions) >= actor.hp);
			assert.equal(game.decide(), 'switch 2');
			assert.deepEqual(game.ai.getTracker().getActiveOpponent().knownMoves, []);
		});
	}

	it('falls back to generic stats and moves when a tier set is contradicted', () => {
		const game = setup([mon('Garchomp', ['surf'])], [mon('Blissey', ['icebeam'])], { format: 'gen7ou' });
		game.reveal(['surf']);
		const state = snapshot(game, 'gen7ou');
		const model = inferOpponent(state.opponent.active[0], 'gen7ou')[0];
		assert.equal(model.matched, false);
		assert.deepEqual(model.pokemon.baseStats,
			computeStatsFromPreset(Dex.species.get('Garchomp').baseStats, 100, getOpponentPreset('Garchomp')));
		assert.deepEqual(model.pokemon.moveKnowledge, { revealedMoves: ['surf'],
			presetCandidates: ['earthquake', 'dragonclaw'], remainingSlots: 3 });
		assert.equal(model.pokemon.item, '');
	});

	it('scores a 2+3 pool without inventing a five-move user or mutating public observations', () => {
		const game = setup([mon('Hawlucha', ['taunt', 'closecombat'])], [mon('Blissey', ['icebeam'])]);
		game.reveal();
		const state = snapshot(game, 'gen9customgame');
		const foe = state.opponent.active[0];
		const seen = [];
		const actions = predictOpponent(state, foe, state.self.active[0], 'gen9customgame', (s, user, moves) => {
			assert(user.moves.length <= 4);
			assert(canHaveOpponentMoves(user.moveKnowledge, user.moves));
			seen.push(...moves.map(m => m.id));
			return moves.map(move => ({ move, score: 100 }));
		});
		assert.deepEqual(new Set(seen), new Set(['taunt', 'closecombat', 'swordsdance', 'acrobatics', 'highjumpkick']));
		assert(Math.abs(actions.reduce((n, a) => n + a.weight, 0) - 1) < 1e-9);
		assert.deepEqual(foe.moves, ['Taunt', 'Close Combat']);
		assert.deepEqual(game.ai.getTracker().getActiveOpponent().knownMoves, ['Taunt', 'Close Combat']);
	});

	it('requires enough slots for a dual-screen role', () => {
		const game = setup([mon('Espeon', ['psychic', 'shadowball', 'dazzlinggleam'])], [mon('Blissey', ['icebeam'])]);
		game.reveal();
		const foe = snapshot(game, 'gen9customgame').opponent.active[0];
		const model = inferOpponent(foe, 'gen9customgame')[0];
		assert.equal(model.pokemon.moveKnowledge.remainingSlots, 1);
		assert(!canHaveOpponentMoves(model.pokemon.moveKnowledge, ['reflect', 'lightscreen']));
		assert.notEqual(fightingStyle(model.pokemon, 'gen9customgame'), 'screens');
	});

	it('does not double Acrobatics or activate Unburden for an unknown item', () => {
		const game = setup([mon('Hawlucha', ['acrobatics'], { ability: 'Unburden' })], [mon('Blissey', ['icebeam'])]);
		game.ai.getTracker().parseMessage('|-ability|p1a: Hawlucha|Unburden');
		let state = snapshot(game, 'gen9customgame');
		const evaluator = new HardEvaluation(state, 'gen9customgame');
		const actor = state.self.active[0];
		const foe = inferOpponent(state.opponent.active[0], 'gen9customgame')[0].pokemon;
		assert.equal(foe.item, '');
		assert.equal(foe.itemKnown, false);
		const speed = getEffectiveSpeed(foe, state.field, state.opponent.conditions);
		assert.equal(speed, foe.baseStats.spe);
		const move = hardMove('acrobatics', 1, 'gen9customgame');
		const unknown = evaluator.damage(foe, actor, move).average;
		assert.equal(unknown, evaluator.damage({ ...foe, item: 'Sitrus Berry' }, actor, move).average);
		game.ai.getTracker().parseMessage('|-enditem|p1a: Hawlucha|Sitrus Berry|[eat]');
		state = snapshot(game, 'gen9customgame');
		const consumed = inferOpponent(state.opponent.active[0], 'gen9customgame')[0].pokemon;
		assert(evaluator.damage(consumed, actor, move).average > unknown * 1.8);
		assert.equal(getEffectiveSpeed(consumed, state.field, state.opponent.conditions), speed * 2);
		game.ai.getTracker().parseMessage('|switch|p1a: Hawlucha|Hawlucha|100/100');
		state = snapshot(game, 'gen9customgame');
		const returned = inferOpponent(state.opponent.active[0], 'gen9customgame')[0].pokemon;
		assert.equal(getEffectiveSpeed(returned, state.field, state.opponent.conditions), speed);
		assert(evaluator.damage(returned, actor, move).average > unknown * 1.8);
	});

	it('still doubles our own Acrobatics when the request confirms no held item', () => {
		const game = setup([mon('Blissey', ['icebeam'])], [mon('Hawlucha', ['acrobatics'])]);
		const state = snapshot(game, 'gen9customgame');
		const evaluator = new HardEvaluation(state, 'gen9customgame');
		const actor = state.self.active[0];
		assert.equal(actor.itemKnown, true);
		const move = hardMove('acrobatics', 1, 'gen9customgame');
		assert(evaluator.damage(actor, state.opponent.active[0], move).average >
			evaluator.damage({ ...actor, item: 'Sitrus Berry' }, state.opponent.active[0], move).average * 1.8);
	});

	for (const format of ['gen7ou', 'gen9nationaldex']) {
		it(`uses Venusaur until public Mega evolution in ${format}`, () => {
			const game = setup([mon('Venusaur', ['gigadrain'], { item: 'Venusaurite' })], [mon('Blissey', ['icebeam'])], { format });
			let state = snapshot(game, format);
			let models = inferOpponent(state.opponent.active[0], format);
			const base = computeStatsFromPreset(Dex.species.get('Venusaur').baseStats, 100, getOpponentPreset('Venusaur'));
			assert(models.every(h => h.pokemon.species === 'Venusaur' && h.pokemon.ability !== 'thickfat'));
			assert.deepEqual(models[0].pokemon.baseStats, base);
			assert.equal(models[0].pokemon.item, getOpponentPreset('Venusaur').item);
			game.ai.getTracker().parseMessage('|detailschange|p1a: Venusaur|Venusaur-Mega, M');
			state = snapshot(game, format);
			models = inferOpponent(state.opponent.active[0], format);
			assert(models.every(h => h.pokemon.species === 'Venusaur-Mega' && h.pokemon.baseStats.def > base.def));
			assert(models.every(h => Dex.toID(h.pokemon.item) === 'venusaurite'));
		});
	}
});
