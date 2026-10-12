# PokeMMO vs Mainline - Complete Differences

Every mechanic, move, ability, item, stat, and rule difference between PokeMMO's competitive metagame and standard mainline/Smogon Pokemon.

## Core Premise

PokeMMO runs a hybrid ruleset that doesn't exist anywhere else:

- Gen 5 Pokemon - only Gen 1 through 5 (up to Unova) are available

- Gen 6+ battle mechanics - the engine uses modern battle logic, not Gen 5's

- No Fairy type - 17 types total, Steel still resists Dark and Ghost

- Level 50 cap - all standard formats at Lv50 (LC at Lv5), not Lv100

- Own tier system - PokeMMO tiers (OU/UU/NU/UT) are based on in-game usage, not Smogon's

## Battle Mechanics

These are the specific mechanical differences from standard Gen 5 and standard Gen 9.

| Mechanic | PokeMMO | Gen 5 | Gen 9 |
| --- | --- | --- | --- |
| Weather duration (summoned by ability) | 5-8 turns | Infinite | 5-8 turns |
| Rapid Spin | Boosts speed by 1 stage | Doesn't boost speed | Boosts speed by 1 stage |
| Teleport | Switches user out | Fails if used | Switches user out |
| Sleep Clause | Sleep moves are one-time use | Removed | Removed in most formats |
| Critical hit multiplier | 1.5x | 2x | 1.5x |
| Paralysis speed | 50% reduction | 75% reduction | 50% reduction |
| Partial trapping | 1/8 per turn | 1/16 per turn | 1/8 per turn |
| Sleep turns | 1-3 turns, no reset | 1-3 turns, reset if switched out | 1-3 turns, no reset |
| Gem boost | 1.5x (one-time) | 1.5x | 1.3x |
| Prankster vs Dark | Status moves fail | No immunity | Status moves fail |
| Fairy type | Does not exist | Does not exist | Exists |
| Snow weather | 1.5x Def for Ice-types | N/A (Hail only) | 1.5x Def for Ice-types |
| Intimidate blocking | Inner Focus/Own Tempo/Oblivious/Scrappy | Only Inner Focus | All four |
| Oblivious | Blocks Taunt + Attract + Captivate | Blocks Attract + Captivate | Same as PokeMMO |
| Toxic (Poison types) | Never misses | 90% | Never misses |
| Facade | Ignores burn Atk reduction | Does not ignore | Ignores |
| Iron Barbs/Rough Skin | Suppressed by Mold Breaker | Not suppressed | Suppressed |
| Rage Powder | Grass + Overcoat immune | Grass immune | Grass + Overcoat immune |
| Ghost trapping immunity | Ghosts immune to trapping | Not immune | Immune |
| Soul Dew | 1.2x Dragon/Psychic BP (Lati twins) | 1.5x SpA/SpD flat | 1.2x Dragon/Psychic BP |
| Screens (doubles) | 1/3 reduction | 1/2 reduction | 1/3 reduction |
| Hidden Power IVs | Not enforced (any IVs, any type) | IVs determine type + power | Fixed 60 BP, IVs determine type |
| Level cap | Lv50 for singles tiers | Lv100 for singles tiers | Lv100 for singles tiers (Smogon) |

## Move Base Power Changes

PokeMMO-specific BP values. Many align with Gen 6+ updates, but some (like Knock Off) are unique. This list covers ~75+ moves.

| Move | PokeMMO BP | Gen 5 BP | Gen 9 BP |
| --- | --- | --- | --- |
| Knock Off | 20 (flat, no item boost) | 20 | 65 (1.5x w/ item) |
| Outrage | 90 | 120 | 120 |
| Sucker Punch | 70 | 80 | 70 |
| Hidden Power | 60 (flat) | 30-70 | 60 |
| Dark Void | 50 accuracy | 80 accuracy | 50 accuracy |
| Luster Purge / Mist Ball | 95 | 70 | 95 |
| Thunderbolt / Ice Beam / Flamethrower / Surf | 90 | 95 | 90 |
| Fire Blast / Thunder / Blizzard / Hydro Pump / Hurricane | 110 | 120 | 110 |
| Overheat / Draco Meteor / Leaf Storm | 130 | 140 | 130 |
| Rapid Spin | 50 | 20 | 50 |
| Leech Life | 80 | 20 | 80 |
| Future Sight | 120 | 100 | 120 |
| Energy Ball | 90 | 80 | 90 |
| Aura Sphere | 80 | 90 | 80 |
| Dragon Pulse | 85 | 90 | 85 |
| Heat Wave | 95 | 100 | 95 |
| Crabhammer | 100 | 90 | 100 |
| Meteor Mash | 90 | 100 | 90 |
| Hex | 65 | 50 | 65 |
| Magma Storm | 100 | 120 | 100 |
| Skull Bash | 130 | 100 | 130 |
| Synchronoise | 120 | 70 | 120 |
| Techno Blast | 120 | 85 | 120 |
| Pin Missile | 25 | 14 | 25 |
| Muddy Water | 90 | 95 | 90 |
| Pledges (Fire/Grass/Water) | 80 | 50 | 80 |

This is a subset of the most relevant changes. There are 75+ total BP overrides. The [damage calculator](https://calc.mmoshowdown.cc) accounts for all of them.

## Move PP, Behavior, and Flags

**PP Nerfs (Recovery Moves)**

| Move | PokeMMO PP | Standard PP |
| --- | --- | --- |
| Recover | 8 | 16 |
| Rest | 8 | 16 |
| Slack Off | 8 | 16 |
| Softboiled | 8 | 16 |
| Roost | 8 | 16 |
| Milk Drink | 8 | 16 |

Key Behavior Changes

- Knock Off - flat 20 BP with no 1.5x boost when the target holds an item. Still removes the item.

- Follow Me / Rage Powder - both have priority +2. Rage Powder is blocked by Grass type and Overcoat.

## Abilities

**Backported Abilities (Gen 6+ available in PokeMMO)**

- Sharpness - 1.5x BP for slicing moves (Aerial Ace, Leaf Blade, Night Slash, Psycho Cut, Sacred Sword, X-Scissor, etc.)

- Competitive - +2 SpA when any stat is dropped (Empoleon has Competitive instead of Defiant)

- Wind Rider - boosts Attack in Tailwind, immune to wind moves

- Neutralizing Gas - suppresses all other abilities on the field. When the Gas user leaves, all active abilities re-trigger and re-announce (Drizzle, Intimidate, etc.)

- Slush Rush - doubles Speed in Hail/Snow

**Behavior Changes**

- Oblivious - blocks Taunt in addition to Attract and Captivate (Gen 9 behavior)

- Inner Focus / Own Tempo / Oblivious / Scrappy - all block Intimidate unconditionally (Gen 8+ behavior)

## Items

**Backported Items (Gen 6+ available in PokeMMO)**

- Assault Vest - 1.5x SpD, can't use status moves

- Clear Amulet - prevents stat drops

- Covert Cloak - blocks secondary effects

- Weakness Policy - +2 Atk/SpA after super-effective hit

- Heavy-Duty Boots - immune to entry hazards (banned in all tiers)

- Loaded Dice - multi-hit moves always hit 4-5 times

- Room Service - lowers Speed in Trick Room

- Safety Goggles - immune to powder moves and weather damage

- Punching Glove - 1.1x BP for punch moves, no contact

- Eject Pack - switches out on stat drop

- Throat Spray - +1 SpA after using a sound move

- Snowball - +1 Atk when hit by Ice

- Luminous Moss - +1 SpD when hit by Water

**Item Behavior Changes**

- Soul Dew - reworked from flat 1.5x SpA/SpD to 1.2x BP for Dragon and Psychic moves on Latios/Latias only

- Type Gems - 1.5x one-time boost (Gen 5 value). All type gems are legal.

## Base Stat Changes

55 Pokemon have updated base stats reflecting Gen 6-9 buffs. The full list:

Butterfree, Beedrill, Pidgeot, Pikachu, Raichu, Nidoqueen, Nidoking, Clefable, Wigglytuff, Vileplume, Poliwrath, Alakazam, Victreebel, Golem, Ampharos, Bellossom, Azumarill, Jumpluff, Beautifly, Exploud, Staraptor, Roserade, Stoutland, Unfezant, Gigalith, Seismitoad, Leavanny, Scolipede, Krookodile, Cresselia, Arbok, Dugtrio, Farfetch'd, Dodrio, Electrode, Exeggutor, Noctowl, Ariados, Qwilfish, Magcargo, Corsola, Mantine, Swellow, Pelipper, Masquerain, Delcatty, Volbeat, Lunatone, Solrock, Chimecho, Woobat, Crustle, Beartic, Cryogonal

## Bans and Clauses

**Combo Bans**

| Ban | Formats |
| --- | --- |
| Dugtrio + Arena Trap | Ubers, OU, UU, NU (not VGC) |
| Gallade + Sharpness | OU, UU, NU (not VGC) |
| Hydreigon + Draco Meteor | OU |
| Garchomp + Swords Dance | OU |
| Politoed + Lovely Kiss | VGC |

**Other Bans**

- **Moody** - banned in OU/UU/NU (not VGC)

- **Heavy-Duty Boots** - banned in all tiers

**Standard Clauses**

- **Species Clause** - all formats

- **Sleep Clause (MMO variant)** - when an opponent's Pokemon has been slept, the next sleep attempt fails. Not active in VGC.

- **OHKO Clause** - not active in VGC

- **Evasion Moves Clause** - not active in VGC

- **Duplicate Move Clause** - all formats

**VGC Specific**

- Item Clause = 1 (no duplicate items)

- Force Open Team Sheets

- Picked Team Size = 4 (bring 6, pick 4)

## Special Event Moves

Only in PokeMMO, certain pokémons have access to special moves that only existed in previous generation events that cannot be transferred to future generations.

Most of them were from in-person new york center distribution events, available only to gen 2 cartridges, thus not available in any generations other than that.

Below you can find a list of relevant special tutor moves:

- Golem evolution line has access to Rapid Spin.

- Nidoqueen evolution line has access to Moonlight.

- Weavile evolution line has access to Moonlight.

- Nidoking evolution line has access to Morning Sun.

- Zapdos, Moltres and Articuno have access to Extrasensory.

- Magnezone evolution line has access to Agility.

- Blissey evolution line has access to Wish.

- Jirachi has access to Follow Me

- Politoed evolution line has access to Lovely Kiss

- Nidoking evolution line has access to Lovely Kiss

- Victreebel evolution line has access to Lovely Kiss

- Magmar evolution line has access to Follow Me

- Electabuzz evolution line has access to Follow Me

PokeMMO Showdown is not affiliated or associated with any other company.

All logos, trademarks, and trade names used herein are the property of their respective owners.

created and developed by suhleam
