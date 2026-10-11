export const Conditions: import('../../../sim/dex-conditions').ModdedConditionDataTable = {
	brn: {
		inherit: true,
		onResidual(pokemon) {
			this.damage(pokemon.baseMaxhp / 16);
		},
	},
	par: {
		inherit: true,
		onModifySpe(spe, pokemon) {
			// Paralysis occurs after all other Speed modifiers, so evaluate all modifiers up to this point first
			spe = this.finalModify(spe);
			if (!pokemon.hasAbility('quickfeet')) {
				spe = Math.floor(spe * 50 / 100);
			}
			return spe;
		},
	},
	slp: {
		inherit: true,
		onSwitchIn() {},
	},
	confusion: {
		inherit: true,
		onBeforeMove(pokemon) {
			pokemon.volatiles['confusion'].time--;
			if (!pokemon.volatiles['confusion'].time) {
				pokemon.removeVolatile('confusion');
				return;
			}
			this.add('-activate', pokemon, 'confusion');
			if (!this.randomChance(33, 100)) {
				return;
			}
			this.activeTarget = pokemon;
			const damage = this.actions.getConfusionDamage(pokemon, 40);
			if (typeof damage !== 'number') throw new Error("Confusion damage not dealt");
			const activeMove = { id: this.toID('confused'), effectType: 'Move', type: '???' };
			this.damage(damage, pokemon, pokemon, activeMove as ActiveMove);
			return false;
		},
	},
	gem: {
		duration: 1,
		affectsFainted: true,
		onBasePower(basePower, user, target, move) {
			this.debug('Gem Boost');
			return this.chainModify(1.5);
		},
	},
	raindance: {
		inherit: true,
		onFieldStart(field, source, effect) {
			if (effect?.effectType === 'Ability') {
				this.add('-weather', 'RainDance', '[from] ability: ' + effect.name, `[of] ${source}`);
			} else {
				this.add('-weather', 'RainDance');
			}
		},
	},
	sunnyday: {
		inherit: true,
		onFieldStart(battle, source, effect) {
			if (effect?.effectType === 'Ability') {
				this.add('-weather', 'SunnyDay', '[from] ability: ' + effect.name, `[of] ${source}`);
			} else {
				this.add('-weather', 'SunnyDay');
			}
		},
	},
	sandstorm: {
		inherit: true,
		onFieldStart(field, source, effect) {
			if (effect?.effectType === 'Ability') {
				this.add('-weather', 'Sandstorm', '[from] ability: ' + effect.name, `[of] ${source}`);
			} else {
				this.add('-weather', 'Sandstorm');
			}
		},
	},
	hail: {
		inherit: true,
		onFieldStart(field, source, effect) {
			if (effect?.effectType === 'Ability') {
				this.add('-weather', 'Hail', '[from] ability: ' + effect.name, `[of] ${source}`);
			} else {
				this.add('-weather', 'Hail');
			}
		},
	},
};
