import { Abilities as ModernAbilities } from '../../abilities';

export const Abilities: import('../../../sim/dex-abilities').ModdedAbilityDataTable = {
	innerfocus: {
		inherit: true,
		rating: 1.5,
		onTryBoost(boost, target, source, effect) {
			if (effect.name === 'Intimidate') {
				delete boost.atk;
				this.add('-fail', target, 'unboost', 'Attack', '[from] ability: Inner Focus', `[of] ${target}`);
			}
		},
	},
	oblivious: {
		inherit: true,
		onTryBoost(boost, target, source, effect) {
			if (effect.name === 'Intimidate') {
				delete boost.atk;
				this.add('-fail', target, 'unboost', 'Attack', '[from] ability: Oblivious', `[of] ${target}`);
			}
		},
	},
	drizzle: {
		inherit: true,
		onStart(source) {
			if (this.field.weather !== 'raindance') {
				this.field.setWeather('raindance');
			}
		},
	},
	drought: {
		inherit: true,
		onStart(source) {
			if (this.field.weather !== 'sunnyday') {
				this.field.setWeather('sunnyday');
			}
		},
	},
	sandstream: {
		inherit: true,
		onStart(source) {
			if (this.field.weather !== 'sandstorm') {
				this.field.setWeather('sandstorm');
			}
		},
	},
	snowwarning: {
		inherit: true,
		onStart(source) {
			if (this.field.weather !== 'snowscape') {
				this.field.setWeather('snowscape');
			}
		},
	},
	overcoat: {
		inherit: true,
		onTryHit(target, source, move) {
			if (move.flags['powder'] && target !== source && this.dex.getImmunity('powder', target)) {
				this.add('-immune', target, '[from] ability: Overcoat');
				return null;
			}
		},
	},
};

for (const id of ['competitive', 'neutralizinggas', 'protean', 'sharpness', 'slushrush', 'windrider'] as const) {
	Abilities[id] = { inherit: true, gen: 5, isNonstandard: null };
}
// Restore snow support and modern protection against Intimidate and Taunt.
for (const id of ['slushrush', 'icebody', 'snowcloak', 'forecast', 'owntempo', 'scrappy', 'oblivious'] as const) {
	Abilities[id] = { ...ModernAbilities[id], ...Abilities[id] };
}
