'use strict';

const assert = require('assert').strict;
const { Dex } = require('../../../dist/sim');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { trackedPokemonToAIPokemon } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { hardMove, inferOpponent } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { calculateDamage } = require('../../../dist/server/npc/ai/hard/damage');
const { modelsFor } = require('../../../dist/server/npc/ai/hard/projection');
const { computeStatsFromPreset, getOpponentPreset } = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');

function infer(species, format, events = []) {
	const tracker = createBattleTracker('p2');
	tracker.setFormat(format);
	tracker.parseMessage(`|switch|p1a: Foe|${species}, L100|100/100\n${events.join('\n')}`);
	const pokemon = trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, format);
	return inferOpponent(pokemon, format);
}

describe('Hard local tier presets', () => {
	for (const format of ['gen4ou', 'gen5ou', 'gen5uu', 'gen6ou', 'gen6uu', 'gen7ou', 'gen7uu', 'gen9ou']) {
		it(`loads every source species in ${format} without falling back`, () => {
			const data = require(`../../../data/npc/strategies/${format}.json`);
			for (const id of Object.keys(data.species)) {
				const species = Dex.forFormat(format).species.get(id);
				assert(!species.isMega, `${format}: ${id} must stay under its source species`);
				const models = infer(species.name, format);
				assert(models.length && models.every(m => m.matched), `${format}: ${id}`);
				assert(Math.abs(models.reduce((sum, m) => sum + m.weight, 0) - 1) < 1e-9);
			}
		});
	}

	it('uses public ability evidence when a source set leaves the ability unspecified', () => {
		for (const [format, species, ability, name] of [
			['gen4ou', 'Alakazam', 'Synchronize', 'Substitute + 3 Attacks'],
			['gen5uu', 'Lilligant', 'Own Tempo', 'Quiver Dance'],
		]) {
			const models = infer(species, format, [`|-ability|p1a: Foe|${ability}`]);
			assert(models.some(m => m.name === name && m.matched));
			assert(models.every(m => Dex.toID(m.pokemon.ability) === Dex.toID(ability)));
		}
	});

	it('interprets explicit noitem as an empty held item', () => {
		const models = infer('Tornadus', 'gen6uu', ['|-ability|p1a: Foe|Defiant']);
		assert(models.length && models.every(m => m.matched && m.pokemon.item === ''));
		assert(models.some(m => m.moves.some(move => move.id === 'acrobatics')));
		const [model] = modelsFor({ ...models[0].pokemon, itemAssumed: false, presetModels: models });
		const attacker = model.pokemon;
		assert(!attacker.itemKnown);
		const damage = user => calculateDamage(user, attacker, hardMove('acrobatics', 1, 'gen6uu'), { formatId: 'gen6uu', weather: '' }).average;
		assert.equal(damage(attacker), damage({ ...attacker, itemKnown: true }));
		assert(damage(attacker) > damage({ ...attacker, itemAssumed: false }));
	});

	it('removes tier bans before weighting alternatives, but retains observed moves', () => {
		const uxie = infer('Uxie', 'gen4ou');
		assert(uxie.every(model => !model.moves.some(move => move.id === 'yawn')));
		assert(uxie.some(model => model.moves.some(move => move.id === 'knockoff' && move.availability === 0.5)));
		const volbeat = infer('Volbeat', 'gen5uu');
		assert(volbeat.every(model => !model.moves.some(move => move.id === 'batonpass')));
		const revealed = infer('Volbeat', 'gen5uu', ['|move|p1a: Foe|Baton Pass|p1a: Foe']);
		assert(revealed.every(model => model.moves.some(move => move.id === 'batonpass' && move.availability === 1)));
	});

	it('keeps the generic and average-EV fallback chain', () => {
		const [generic] = infer('Scrafty', 'gen7uu');
		assert.equal(generic.name, 'default');
		assert.deepEqual(generic.pokemon.baseStats,
			computeStatsFromPreset(Dex.forFormat('gen7uu').species.get('Scrafty').baseStats, 100, getOpponentPreset('Scrafty')));
		const [missing] = infer('Magikarp', 'gen7uu', ['|move|p1a: Foe|Splash|p2a: NPC']);
		assert.equal(missing.name, 'unmatched');
		assert.deepEqual(missing.pokemon.baseStats,
			computeStatsFromPreset(Dex.forFormat('gen7uu').species.get('Magikarp').baseStats, 100, {}));
		assert.deepEqual(missing.moves.map(m => m.id), ['splash']);
		assert.equal(infer('Garchomp', 'gen9nationaldex')[0].name, 'default');
	});
});
