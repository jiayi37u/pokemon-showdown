'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { Search } = require('../../../dist/server/npc/ai/hard/search');
const { hp, projectEntry } = require('../../../dist/server/npc/ai/hard/projection');
const { projectedState } = require('./helpers/hard-state');

describe('Hard surviving entries beside a partial advantage', () => {
	const battles = [];
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	function fixture() {
		const battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
			p1: { name: 'Own', team: [
				{ species: 'Excadrill', ability: 'Mold Breaker', item: 'Leftovers',
					moves: ['swordsdance', 'earthquake', 'ironhead', 'rapidspin'] },
				{ species: 'Gyarados', ability: 'Intimidate', item: 'Gyaradosite',
					moves: ['dragondance', 'crunch', 'waterfall', 'substitute'] },
				{ species: 'Serperior', ability: 'Contrary', item: 'Lum Berry',
					moves: ['glare', 'synthesis', 'leafstorm', 'hiddenpowerfire'] },
				{ species: 'Cresselia', ability: 'Levitate', item: 'Rocky Helmet',
					moves: ['lunardance', 'icebeam', 'toxic', 'moonlight'] },
			] },
			p2: { name: 'Foe', team: [{ species: 'Skarmory', ability: 'Sturdy', item: 'Rocky Helmet',
				moves: ['spikes', 'roost', 'ironhead', 'bravebird'] }] } });
		battles.push(battle); battle.makeChoices();
		const state = projectedState(battle);
		const stats = [
			[369, 316, 170, 122, 198, 302], [331, 383, 195, 140, 236, 261],
			[351, 139, 226, 189, 226, 356], [443, 130, 324, 194, 296, 244],
		];
		for (const [i, pokemon] of state.self.team.entries()) {
			const [maxHp, atk, def, spa, spd, spe] = stats[i];
			pokemon.maxHp = maxHp; pokemon.baseStats = { hp: maxHp, atk, def, spa, spd, spe };
			hp(pokemon, i ? maxHp : 44);
		}
		const actor = state.self.active[0], foe = state.opponent.active[0];
		actor.boosts.atk = 6;
		foe.maxHp = 334; foe.baseStats = { hp: 334, atk: 196, def: 416, spa: 104, spd: 177, spe: 176 };
		hp(foe, 287); state.self.conditions.spikes = 1;
		const entries = () => new Search(new MatchupEvaluator()).entryChoices(state, 'self', 'switch');
		return { state, actor, foe, entries, names: () => entries().map(p => p.species) };
	}
	it('retains a survivable offensive entry when a partial defensive answer also exists', () => {
		const { state, names } = fixture(), evaluator = new MatchupEvaluator();
		const pair = evaluator.pairs(state, [[3, 0]])[0];
		assert(pair.self.counter > 0 && pair.self.counter < 1);
		assert.equal(pair.opponent.check, 0);
		assert(names().includes('Gyarados'), 'A partial counter cannot exclude a cheaper surviving route when staying can faint');
	});
	it('does not expand partial-advantage alternatives when the active can survive', () => {
		const { actor, names } = fixture();
		actor.boosts.atk = 0; hp(actor, 296);
		assert.deepEqual(names(), ['Cresselia']);
	});
	it('preserves a proven favorable stay for a low-HP first-strike finish', () => {
		const { state, foe, names } = fixture();
		foe.item = 'leftovers'; hp(foe, 91);
		assert(new Search(new MatchupEvaluator()).favorableStay(state, 'self'));
		assert.deepEqual(names(), ['Cresselia']);
	});
	it('preserves reliable advantageous recipients', () => {
		const { state, foe, names } = fixture();
		foe.moves = ['ironhead']; foe.item = 'leftovers';
		assert.equal(new MatchupEvaluator().pairs(state, [[3, 0]])[0].self.counter, 1);
		assert.deepEqual(names(), ['Gyarados', 'Serperior', 'Cresselia']);
	});
	it('retains a necessary lethal-entry sacrifice alongside surviving recipients', () => {
		const { state, names } = fixture(), sacrifice = state.self.reserve.find(p => p.species === 'Serperior');
		state.self.conditions.stealthrock = true; hp(sacrifice, 1);
		assert.equal(projectEntry(sacrifice, state.self.conditions, state.field).hp, 0);
		assert(names().includes('Serperior'));
	});
});
