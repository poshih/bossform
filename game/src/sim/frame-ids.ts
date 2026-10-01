/**
 * The robot designs by id: three originals (versatile, fast, heavy), three ranged specialists (sniper, beam, arsenal) and
 * three close-range specialists (duelist, stealth, brawler). Ids are wire format (match configuration, lobby payloads) and
 * index every per-frame table (FRAME_STATS, PRIMARY_WEAPONS, ALT_ABILITIES, FORMS). A leaf module, so a robot's data module
 * can name its frame without importing the tables that list it.
 */
export const Frame = { Vanguard: 0, Gale: 1, Juggernaut: 2, Longbow: 3, Prism: 4, Hailstorm: 5, Ronin: 6, Shade: 7, Gauntlet: 8 } as const;
export const FRAME_COUNT = 9;
