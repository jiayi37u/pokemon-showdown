const rocks: Record<string, string> = {
	raindance: 'damprock', sunnyday: 'heatrock', sandstorm: 'smoothrock', hail: 'icyrock', snowscape: 'icyrock',
};

export function weatherDuration(weather: string, hasItem: (item: string) => boolean, gen: number, mod: string, ability: boolean) {
	if (ability && gen <= 5 && mod !== 'mmo') return 0;
	return hasItem(rocks[weather]) ? 8 : 5;
}
