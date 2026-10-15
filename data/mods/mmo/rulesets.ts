import { PokeMMOLearnsets } from './learnsets-data';

export const Rulesets: import('../../../sim/dex-formats').ModdedFormatDataTable = {
	pokemmostandard: {
		effectType: 'Rule',
		name: 'PokeMMO Standard',
		ruleset: [
			'Species Clause', 'Stadium Sleep Clause', 'PokeMMO Hidden Power', 'No Event Abilities',
			'OHKO Clause', 'Evasion Moves Clause', 'Team Preview',
			'Obtainable Moves', 'Obtainable Abilities', 'Obtainable Formes', 'EV Limit = 510',
			'HP Percentage Mod', 'Cancel Mod', 'Endless Battle Clause', 'Adjust Level = 50',
			'Dynamax Clause',
		],
		banlist: [
			'Nonexistent', 'Uber', 'Landorus', 'Landorus-Therian', 'Thundurus', 'Thundurus-Therian',
			'Latios', 'Latias', 'Regice', 'Regirock', 'Registeel', 'Regigigas', 'Shaymin-Sky', 'Meloetta-Pirouette',
			'Heavy-Duty Boots', 'Dugtrio + Arena Trap', 'Blaziken + Speed Boost', 'Gallade + Sharpness', 'Moody',
		],
		checkCanLearn(move, species) {
			// MMO tutors and breeding have no cartridge transfer/event-source incompatibilities.
			if (species.id === 'smeargle' && !move.flags['nosketch'] && move.id !== 'struggle') return null;
			// Evolution retains moves taught to pre-evolutions (including MMO event tutors).
			for (let current = species; current.exists; current = this.dex.species.get(current.prevo)) {
				if (PokeMMOLearnsets[current.id]?.includes(move.id)) return null;
				if (!current.prevo) break;
			}
			return ` can't learn ${move.name} in PokeMMO.`;
		},
		onValidateSet(set) {
			const moves = set.moves.map(move => this.dex.moves.get(move).id);
			if (new Set(moves).size !== moves.length) {
				return [`${set.species} cannot have duplicate moves (including different Hidden Power types).`];
			}
		},
		onBattleStart() {
			this.gen = 8;
		},
	},
	pokemmohiddenpower: {
		effectType: 'Rule',
		name: 'PokeMMO Hidden Power',
		desc: 'Hidden Power has 60 power and its type can be chosen independently of IVs.',
		onValidateSet(set) {
			if (set.hpType && !this.dex.types.get(set.hpType).HPivs) {
				return [`${set.hpType} is not an available Hidden Power type.`];
			}
		},
	},
	noeventabilities: {
		effectType: 'Rule',
		name: 'No Event Abilities',
		desc: 'Event-exclusive (S slot) abilities are unavailable.',
		onValidateSet(set) {
			const species = this.dex.species.get(set.species);
			const ability = this.dex.toID(set.ability);
			const regularAbilities = [species.abilities[0], species.abilities[1], species.abilities.H];
			if (species.abilities.S && ability === this.dex.toID(species.abilities.S) &&
				!regularAbilities.some(name => name && this.dex.toID(name) === ability)) {
				return [`${species.name}'s ${species.abilities.S} is an event-exclusive ability.`];
			}
		},
	},
};
