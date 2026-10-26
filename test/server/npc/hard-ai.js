'use strict';

const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { HardAI } = require('../../../dist/server/npc/ai/hard');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { fightingStyle, hardMove, inferOpponent, predictOpponent } = require('../../../dist/server/npc/ai/hard/opponent-model');
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

describe('Hard user-authorized team preset rules', () => {
	function evaluate(game, format = 'gen6ou') {
		const state = buildBattleStateWithTracker(battle.p2.activeRequest, null, game.ai.getTracker(), { formatId: format });
		const evaluator = new HardEvaluation(state, format);
		const models = species => evaluator.opponentModels([...state.opponent.team, ...(state.opponent.preview || [])]
			.find(p => p.species === species));
		return { state, evaluator, models };
	}
	function start(species, format = 'gen6ou') {
		return setup(species.map(s => mon(s, ['splash'])), [mon('Mew', ['splash'])], { format });
	}
	for (const teammate of ['Tyranitar', 'Hippowdon', 'Mew']) {
		it(`uses the sand-team prior with ${teammate} in public preview`, () => {
			const game = start(['Excadrill', teammate]);
			const { models } = evaluate(game);
			assert(models('Excadrill').length);
			assert(models('Excadrill').every(m => (m.name === 'Sand Rush') === (teammate !== 'Mew')));
			assert(Math.abs(models('Excadrill').reduce((n, m) => n + m.weight, 0) - 1) < 1e-9);
			if (teammate !== 'Mew') {
				game.ai.getTracker().parseMessage(`|switch|p1a: ${teammate}|${teammate}, M|100/100\n|faint|p1a: ${teammate}`);
				game.ai.getTracker().parseMessage('|switch|p1a: Excadrill|Excadrill, M|100/100');
				assert(evaluate(game).models('Excadrill').every(m => m.name === 'Sand Rush'), 'Fainting does not change team composition');
			}
		});
	}
	it('lets public ability evidence override the sand-team prior', () => {
		const game = start(['Excadrill', 'Tyranitar']);
		game.ai.getTracker().parseMessage('|-ability|p1a: Excadrill|Mold Breaker');
		assert(evaluate(game).models('Excadrill').every(m => m.pokemon.ability === 'Mold Breaker'));
	});
	for (const format of ['gen6ou', 'gen7ou']) {
		it(`uses only Mega Stone presets for a sole candidate in ${format}`, () => {
			const game = start(['Latias', 'Mew'], format);
			const { state, models } = evaluate(game, format);
			assert(models('Latias').length);
			assert(models('Latias').every(m => m.pokemon.item === 'latiasite' && m.pokemon.species === 'Latias'));
			assert(!state.opponent.active[0].itemKnown, 'A team prior is not a public item observation');
		});
	}
	it('reassigns the Mega role to Garchomp after the alternative reveals a non-Mega item', () => {
		const game = start(['Latias', 'Garchomp']);
		let result = evaluate(game);
		assert(result.models('Latias').every(m => m.pokemon.item === 'latiasite'));
		assert(result.models('Garchomp').every(m => m.pokemon.item !== 'garchompite'));
		game.ai.getTracker().parseMessage('|-item|p1a: Latias|Life Orb');
		result = evaluate(game);
		assert(result.models('Latias').every(m => Dex.toID(m.pokemon.item) === 'lifeorb'));
		assert(result.models('Garchomp').every(m => m.pokemon.item === 'garchompite'));
		assert(result.models('Garchomp').length > 0);
	});
	it('does not mistake an acquired item for the original Mega role', () => {
		const game = start(['Latias', 'Garchomp']);
		game.ai.getTracker().parseMessage('|-item|p1a: Latias|Life Orb|[from] move: Trick');
		const { models } = evaluate(game);
		assert(models('Garchomp').every(m => m.pokemon.item !== 'garchompite'));
	});
	it('keeps other Mega candidates ambiguous while excluding Garchomp with three candidates', () => {
		const game = start(['Latias', 'Garchomp', 'Tyranitar']);
		const { models } = evaluate(game);
		assert(models('Garchomp').every(m => m.pokemon.item !== 'garchompite'));
		assert(models('Latias').some(m => m.pokemon.item === 'latiasite'));
		assert(models('Latias').some(m => m.pokemon.item !== 'latiasite'));
	});
	it('keeps a publicly revealed Garchompite despite the Garchomp preference', () => {
		const game = start(['Garchomp', 'Latias']);
		game.ai.getTracker().parseMessage('|-item|p1a: Garchomp|Garchompite');
		const { models } = evaluate(game);
		assert(models('Garchomp').every(m => Dex.toID(m.pokemon.item) === 'garchompite'));
		assert(models('Latias').some(m => m.pokemon.item !== 'latiasite'));
	});
	it('does not count a tier-banned Mega as an alternative', () => {
		const game = start(['Garchomp', 'Metagross'], 'gen7ou');
		assert(evaluate(game, 'gen7ou').models('Garchomp').every(m => m.pokemon.item === 'garchompite'));
	});
	it('keeps both legal Mega formes when Charizard is the only eligible species', () => {
		const game = start(['Charizard', 'Mew']);
		const { models } = evaluate(game);
		assert.deepEqual(new Set(models('Charizard').map(m => m.pokemon.item)), new Set(['charizarditex', 'charizarditey']));
		assert(models('Charizard').every(m => m.pokemon.species === 'Charizard'));
	});
	it('does not apply constructed-team priors outside gen6ou and gen7ou', () => {
		const game = start(['Latias', 'Mew'], 'gen9nationaldex');
		const { models } = evaluate(game, 'gen9nationaldex');
		assert(models('Latias').every(m => m.pokemon.item !== 'latiasite'));
	});
	it('does not share a Mega slot between Multi trainers', () => {
		const game = start(['Garchomp', 'Latias']);
		const { state } = evaluate(game);
		state.isDoubles = true;
		for (const p of [...state.opponent.preview, ...state.opponent.roster]) {
			if (p.species === 'Latias') p.ownerSide = 'p3';
		}
		const evaluator = new HardEvaluation(state, 'gen6ou');
		assert(evaluator.opponentModels(state.opponent.active[0]).every(m => m.pokemon.item === 'garchompite'));
		assert(evaluator.opponentModels(state.opponent.preview[0]).every(m => m.pokemon.item === 'latiasite'));
	});
});

describe('Hard CFRU tactical decisions', () => {
	it('does not admit an ineffective status move merely because the opponent may switch', () => {
		const game = setup([mon('Skarmory', ['splash', 'tackle', 'growl', 'leer']), mon('Blissey', ['splash'])],
			[mon('Mew', ['toxic', 'psychic'])], { format: 'gen6customgame' });
		game.reveal();
		let reasoning;
		game.ai.getLogger().logMoveDecision = (...args) => { reasoning = args[5]; };
		game.decide();
		assert(reasoning.some(r => r.startsWith('Two-turn search') && !r.includes('move 1=')), JSON.stringify(reasoning));
		game.ai.getTracker().parseMessage('|-damage|p1a: Skarmory|1/100');
		game.decide();
		assert(reasoning.some(r => r.includes('prediction: switch')), JSON.stringify(reasoning));
		assert(reasoning.some(r => r.startsWith('Two-turn search') && !r.includes('move 1=')), JSON.stringify(reasoning));
	});
	it('preserves Hidden Power Ice through the controller and chooses its finishing attack', () => {
		const game = setup([mon('Landorus-Therian', ['splash', 'tackle', 'growl', 'leer'])],
			[mon('Tornadus-Therian', ['hiddenpowerice', 'hurricane'], { nature: 'Timid', evs: { spa: 252, spe: 252 } })],
			{ format: 'gen6customgame' });
		game.reveal();
		battle.p1.active[0].hp = 250; battle.makeRequest('move');
		game.ai.getTracker().parseMessage('|-damage|p1a: Landorus-Therian|78/100');
		let reasoning;
		game.ai.getLogger().logMoveDecision = (...args) => { reasoning = args[5]; };
		assert.equal(game.decide(), 'move 1');
		assert(reasoning.some(r => r.startsWith('Two-turn search')), JSON.stringify(reasoning));
	});
	it('predicts a hypothesized Mega priority attack without changing public form or Gen 6 action speed', () => {
		const game = setup([mon('Metagross', ['bulletpunch'], { item: 'Metagrossite' })],
			[mon('Medicham-Mega', ['highjumpkick', 'zenheadbutt', 'fakeout', 'bulletpunch'],
				{ ability: 'Pure Power', nature: 'Adamant', evs: { atk: 252, spe: 252 } })], { format: 'gen6ou' });
		battle.p2.active[0].hp = 116;
		battle.makeRequest('move');
		game.ai.getTracker().parseMessage('|-damage|p1a: Metagross|95/100');
		const state = buildBattleStateWithTracker(battle.p2.activeRequest, null, game.ai.getTracker(), { formatId: 'gen6ou' });
		const foe = state.opponent.active[0], actor = state.self.active[0];
		actor.lastMove = 'bulletpunch'; actor.activeMoveActions = 3;
		const before = JSON.stringify(foe);
		const e = new HardEvaluation(state, 'gen6ou'), actions = e.predictions(actor).get(foe);
		const punch = actions.filter(a => a.move?.id === 'bulletpunch');
		assert(punch.reduce((n, a) => n + a.weight, 0) > 0.3);
		assert(punch.every(a => a.user.species === 'Metagross-Mega' && a.modelUser.species === 'Metagross'));
		assert(punch.every(a => a.user.queuedSpeed === a.modelUser.baseStats.spe));
		assert.equal(JSON.stringify(foe), before);
		state.opponent.megaUsedByOwner = { p1: true };
		assert(new HardEvaluation(state, 'gen6ou').predictions(actor).get(foe)
			.every(a => a.user.species === 'Metagross'));
	});

	it('uses replacement search when the public state omits the fainted active', () => {
		const game = setup([mon('Gengar', ['shadowball'], { nature: 'Timid', evs: { spa: 252, spe: 252 } })],
			[mon('Magikarp', ['splash']), mon('Alakazam', ['psychic'], { nature: 'Timid', evs: { spa: 252, spe: 252 } }),
				mon('Snorlax', ['tackle'])], { format: 'gen6customgame' });
		game.reveal();
		const original = battle.log.length;
		battle.makeChoices('move 1', 'move 1');
		game.ai.getTracker().parseMessage(battle.log.slice(original).join('\n'));
		assert.equal(battle.requestState, 'switch');
		let reason;
		game.ai.getLogger().logSwitchDecision = (...args) => { reason = args[4]; };
		assert.equal(game.decide(), 'switch 2');
		assert(reason.startsWith('Replacement search'), reason);
	});

	it('keeps redundant hazard checks when simulator search is enabled', () => {
		const game = setup([mon('Talonflame', ['bravebird', 'swordsdance', 'roost'], { ability: 'Gale Wings' }),
			mon('Serperior', ['leafstorm'], { ability: 'Contrary' })],
		[mon('Heatran', ['stealthrock', 'roar', 'magmastorm'], { ability: 'Flash Fire', item: 'Leftovers' })],
		{ format: 'gen6customgame' });
		game.reveal();
		game.ai.getTracker().parseMessage('|-sidestart|p1: Player|Stealth Rock');
		game.ai.getTracker().parseMessage('|-boost|p1a: Talonflame|atk|2');
		assert.notEqual(game.decide(), 'move 1');
	});

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

	it('uses a surviving priority pivot before switching, but does not attempt one that is too slow', () => {
		const game = setup([mon('Kyogre', ['surf'])], [
			mon('Grimmsnarl', ['partingshot', 'tackle'], { ability: 'Prankster' }),
			mon('Gastrodon', ['earthpower'], { ability: 'Storm Drain' }),
		]);
		battle.p2.active[0].hp = 1;
		battle.makeRequest('move');
		game.reveal(['surf']);
		assert.equal(game.decide(), 'move 1');
		const request = structuredClone(battle.p2.activeRequest);
		request.side.pokemon[0].ability = 'frisk';
		game.ai.getTracker().parseMessage('|-ability|p2a: Grimmsnarl|Frisk');
		let choice;
		game.ai.choose = value => { choice = value; };
		game.ai.receiveRequest(request);
		assert.equal(choice, 'switch 2');
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
		const game = setup([mon('Shuckle', ['shellsmash'], { item: 'Leftovers' })], [mon('Crobat', ['taunt', 'absorb'])]);
		game.reveal();
		game.ai.getTracker().parseMessage('|-item|p1a: Shuckle|Leftovers');
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

	it('retains Landorus spreads after a revealed move and respects a consumed item', () => {
		const game = setup([mon('Landorus-Therian', ['earthquake'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		const infer = () => inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		const names = [...new Set(infer().map(h => h.name))];
		assert(names.length > 1);
		game.reveal(['swordsdance']);
		assert.deepEqual([...new Set(infer().map(h => h.name))], names);
		game.ai.getTracker().parseMessage('|-enditem|p1a: Landorus-Therian|Flyinium Z');
		assert(infer().every(h => h.pokemon.item === ''));
		assert.deepEqual(game.ai.getTracker().getActiveOpponent().knownMoves, ['Swords Dance']);
	});

	it('uses only the four public moves once all slots are occupied', () => {
		const game = setup([mon('Landorus-Therian', ['earthquake'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		game.reveal(['swordsdance', 'stealthrock', 'earthquake', 'fly']);
		const models = inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		assert(models.every(h => h.moves.length === 4 && !h.moves.some(m => m.id === 'stoneedge')));
	});

	it('keeps tier spreads when four public moves differ from their preset candidates', () => {
		const game = setup([mon('Garchomp', ['earthquake'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		game.reveal(['surf', 'flamethrower', 'dragonclaw', 'rest']);
		const models = inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		assert(models.length > 1);
		assert(models.every(model => model.matched));
		for (const model of models) {
			assert.deepEqual(model.moves.map(m => m.id), ['surf', 'flamethrower', 'dragonclaw', 'rest']);
		}
	});

	it('retains Choice Band and Scarf uncertainty until an item is publicly revealed', () => {
		const game = setup([mon('Kartana', ['leafblade'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		game.reveal(['leafblade', 'smartstrike', 'knockoff', 'sacredsword']);
		let models = inferOpponent(snapshot(game).opponent.active[0], 'gen7ou');
		assert(models.some(h => h.pokemon.item === 'choiceband'));
		assert(models.some(h => h.pokemon.item === 'choicescarf'));
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

	it('expands Sleep Talk into public callable moves while preserving its priority and Taunt vulnerability', () => {
		const game = setup([mon('Snorlax', ['rest', 'sleeptalk', 'bodyslam', 'whirlwind'])],
			[mon('Mew', ['taunt', 'roar'])]);
		game.reveal();
		const state = snapshot(game, 'gen9customgame'), foe = state.opponent.active[0], actor = state.self.active[0];
		foe.status = 'slp'; foe.sleepTurns = 2;
		const e = new HardEvaluation(state, 'gen9customgame');
		const predictions = e.predictions(actor), actions = predictions.get(foe);
		assert.deepEqual(new Set(actions.map(a => a.move.id)), new Set(['rest', 'bodyslam', 'whirlwind']));
		assert(actions.every(a => a.selectedMove.id === 'sleeptalk'));
		assert(Math.abs(actions.reduce((n, a) => n + a.weight, 0) - 1) < 1e-9);
		assert(e.incoming(actor, predictions) > 0, 'Sleep Talk can deal real damage');
		const phazing = actions.find(a => a.move.id === 'whirlwind');
		assert.equal(e.responseFirst(actor, foe, hardMove('roar', 1, 'gen9customgame'), phazing), 0,
			'Called Whirlwind uses Sleep Talk priority, ahead of ordinary Roar');
		const taunt = e.scoreMoves(actor, [hardMove('taunt', 1, 'gen9customgame')], foe, predictions)[0];
		assert.equal(taunt.breakdown.details.find(d => d.reason.includes('interrupt predicted status')).amount, 25);
		foe.volatiles.add('mustrecharge');
		assert(new HardEvaluation(state, 'gen9customgame').predictions(actor).get(foe).every(a => !a.move));
	});

	it('does not predict a Multi opponent switching into another player\'s reserves', () => {
		const game = setup([mon('Garchomp', ['earthquake'])], [mon('Blissey', ['icebeam'])]);
		const state = snapshot(game), foe = state.opponent.active[0];
		state.isDoubles = true;
		state.opponent.active.push({ ...foe, ownerSide: 'p3', slot: 2, ident: 'p3a: Garchomp' });
		state.opponent.reserve = [{ ...foe, ownerSide: 'p3', active: false, ident: 'p3: Garchomp' }];
		state.opponent.remaining = 3; state.opponent.remainingByOwner = { p1: 1, p3: 2 };
		const predict = () => predictOpponent(state, foe, state.self.active[0], 'gen9customgame',
			(s, user, moves) => moves.map(move => ({ move, score: 60, flags: {} })));
		assert(!predict().some(a => a.switching));
		state.opponent.remainingByOwner.p1 = 2;
		assert(predict().some(a => a.switching));
	});

	it('retains attack risk even when CFRU predicts a switch', () => {
		const game = setup([mon('Garchomp', ['earthquake'])], [mon('Blissey', ['icebeam'])], { format: 'gen7customgame' });
		const state = snapshot(game);
		const foe = state.opponent.active[0];
		state.opponent.reserve = [{ ...foe, active: false }];
		const actions = predictOpponent(state, foe, state.self.active[0], 'gen7ou', (s, a, moves) =>
			moves.map(move => ({ move, score: 90, flags: {} })));
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

	it('keeps a winning matchup instead of switching only to pass a pending Wish', () => {
		const game = setup([mon('Magikarp', ['splash'])], [
			mon('Jirachi', ['wish', 'tackle']), mon('Blissey', ['seismictoss']),
		], { format: 'gen7customgame' });
		battle.p2.pokemon[1].hp = Math.floor(battle.p2.pokemon[1].maxhp / 3);
		battle.makeRequest('move');
		game.reveal(['splash']);
		game.ai.getTracker().parseMessage('|turn|1\n|move|p2a: Jirachi|Wish|p2a: Jirachi\n|turn|2');
		assert.equal(game.decide(), 'move 2');
	});

	for (const AI of [NormalAI, HardAI]) {
		it(`${AI.name}: stays to Protect a pending Wish instead of fleeing a blockable KO`, () => {
			const game = setup([mon('Kyogre', ['surf'])], [
				mon('Glaceon', ['wish', 'protect', 'icebeam']), mon('Gastrodon', ['earthpower'], { ability: 'Storm Drain' }),
			], { AI });
			battle.p2.active[0].hp = Math.floor(battle.p2.active[0].maxhp / 3);
			battle.makeRequest('move');
			game.reveal(['surf']);
			game.ai.getTracker().parseMessage('|turn|1\n|move|p2a: Glaceon|Wish|p2a: Glaceon\n|turn|2');
			assert.equal(game.decide(), 'move 2');
			game.ai.getTracker().parseMessage('|move|p2a: Glaceon|Protect|p2a: Glaceon');
			assert.equal(game.decide(), 'switch 2', 'Repeated Protect must not force staying');
		});
	}

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
		let reasoning;
		game.ai.getLogger().logMoveDecision = (...args) => { reasoning = args[5]; };
		assert(/ mega$/.test(game.decide()));
		const search = reasoning.find(r => r.startsWith('Two-turn search'));
		assert(/move 1 mega(?:>=|=|;)/.test(search), search);
		assert(!search.includes('move 1='), 'Do not search staying without Mega');
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

	it('keeps tier spreads and candidates when an unlisted move occupies a slot', () => {
		const game = setup([mon('Garchomp', ['surf'])], [mon('Blissey', ['icebeam'])], { format: 'gen7ou' });
		const before = inferOpponent(snapshot(game, 'gen7ou').opponent.active[0], 'gen7ou');
		game.reveal(['surf']);
		const state = snapshot(game, 'gen7ou');
		const after = inferOpponent(state.opponent.active[0], 'gen7ou');
		assert.equal(after.length, before.length);
		after.forEach((model, i) => {
			assert.equal(model.matched, true);
			assert.deepEqual(model.pokemon.baseStats, before[i].pokemon.baseStats);
			assert.equal(model.pokemon.item, before[i].pokemon.item);
			assert.deepEqual(model.pokemon.moveKnowledge.revealedMoves, ['surf']);
			assert.equal(model.pokemon.moveKnowledge.remainingSlots, 3);
			assert(model.moves.some(m => m.id === 'surf'));
			assert(model.moves.every(m => m.id === 'surf' || before[i].moves.some(old => old.id === m.id)));
		});
	});

	it('replaces an unlisted public item across Tornadus presets without inventing spreads or moves', () => {
		const game = setup([mon('Tornadus-Therian', ['airslash'])], [mon('Blissey', ['icebeam'])], { format: 'gen6ou' });
		const before = inferOpponent(snapshot(game, 'gen6ou').opponent.active[0], 'gen6ou');
		assert.equal(before.length, 3);
		game.reveal(['airslash']);
		game.ai.getTracker().parseMessage('|-item|p1a: Tornadus-Therian|Leftovers');
		const after = inferOpponent(snapshot(game, 'gen6ou').opponent.active[0], 'gen6ou');
		assert.equal(after.length, before.length);
		after.forEach((model, i) => {
			assert.equal(model.name, before[i].name);
			assert.deepEqual(model.pokemon.baseStats, before[i].pokemon.baseStats);
			assert.equal(model.pokemon.item, 'Leftovers');
			assert(model.moves.some(m => m.id === 'airslash'));
		});
	});

	it('keeps an Assault Vest preset after an unlisted attack is revealed', () => {
		const game = setup([mon('Tornadus-Therian', ['airslash'])], [mon('Blissey', ['icebeam'])], { format: 'gen6ou' });
		game.reveal(['airslash']);
		game.ai.getTracker().parseMessage('|-item|p1a: Tornadus-Therian|Assault Vest');
		const models = inferOpponent(snapshot(game, 'gen6ou').opponent.active[0], 'gen6ou');
		assert.equal(models.length, 2);
		assert(models.every(m => m.name === 'Assault Vest Pivot' && m.moves.some(move => move.id === 'airslash')));
	});

	it('does not look up learnsets or invent attacks when no preset supplies them', () => {
		const game = setup([mon('Caterpie', ['stringshot'])], [mon('Blissey', ['icebeam'])], { format: 'gen6ou' });
		const dex = Dex.forFormat('gen6ou');
		const lookup = dex.species.getLearnsetData;
		dex.species.getLearnsetData = () => { throw new Error('AI must not read learnsets'); };
		try {
			const unseen = inferOpponent(snapshot(game, 'gen6ou').opponent.active[0], 'gen6ou');
			assert(unseen.every(model => !model.moves.length));
			game.reveal(['stringshot']);
			const seen = inferOpponent(snapshot(game, 'gen6ou').opponent.active[0], 'gen6ou');
			assert(seen.every(model => model.moves.length === 1 && model.moves[0].id === 'stringshot'));
		} finally {
			dex.species.getLearnsetData = lookup;
		}
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
			return moves.map(move => ({ move, score: 100, flags: {} }));
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
			const base = computeStatsFromPreset(Dex.species.get('Venusaur').baseStats, 100, models[0].spread);
			assert(models.every(h => h.pokemon.species === 'Venusaur' && h.pokemon.ability !== 'thickfat'));
			for (const model of models) assert.deepEqual(model.pokemon.baseStats,
				computeStatsFromPreset(Dex.species.get('Venusaur').baseStats, 100, model.spread));
			assert.equal(Dex.toID(models[0].pokemon.item),
				format === 'gen7ou' ? 'venusaurite' : Dex.toID(getOpponentPreset('Venusaur').item));
			game.ai.getTracker().parseMessage('|detailschange|p1a: Venusaur|Venusaur-Mega, M');
			state = snapshot(game, format);
			models = inferOpponent(state.opponent.active[0], format);
			assert(models.every(h => h.pokemon.species === 'Venusaur-Mega' && h.pokemon.baseStats.def > base.def));
			assert(models.every(h => Dex.toID(h.pokemon.item) === 'venusaurite'));
		});
	}
});
