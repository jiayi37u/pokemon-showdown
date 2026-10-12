import { Abilities as ModernAbilities } from '../../abilities';

export const Abilities: import('../../../sim/dex-abilities').ModdedAbilityDataTable = {
	// PokeMMO explicitly lets Mold Breaker suppress these contact abilities.
	// Mainline Gen 9 does not, so the breakable flag is an MMO override.
	ironbarbs: { ...ModernAbilities.ironbarbs, flags: { breakable: 1 } },
	roughskin: { ...ModernAbilities.roughskin, flags: { breakable: 1 } },
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
	overcoat: { ...ModernAbilities.overcoat },
};

for (const id of ['competitive', 'neutralizinggas', 'protean', 'sharpness', 'slushrush', 'windrider'] as const) {
	Abilities[id] = { inherit: true, gen: 5, isNonstandard: null };
}
// Restore snow support and modern protection against Intimidate and Taunt.
for (const id of ['slushrush', 'icebody', 'snowcloak', 'forecast', 'owntempo', 'scrappy', 'oblivious'] as const) {
	Abilities[id] = { ...ModernAbilities[id], ...Abilities[id] };
}
