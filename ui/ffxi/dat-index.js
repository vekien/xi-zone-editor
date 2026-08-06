// dat-index.js — FFXI DAT file index: maps categories to ROM paths and item ID ranges.
//
// Sources:
//   Item DATs:       category→ROM path + item ID range (JP and EN variants)
//   DMSG DATs:       d_msg string tables (JP and EN)
//   Resource DATs:   UI/title/metadata (may share JP==EN)
//   EventMessage:    event-message string tables (JP and EN)
//
// Usage:
//   import { DatIndex } from '../ffxi/dat-index.js';
//   const idx = new DatIndex('en');
//   idx.itemDatFor(12000)          // → 'ROM/0/7.DAT'  (Armor_1)
//   idx.path('Key_Items')          // → 'ROM/175/35.DAT'
//   idx.category('Spell_Names')    // → { jp:'ROM/181/69.DAT', en:'ROM/181/73.DAT', type:'dmsg' }
//   idx.allCategories()            // → array of all category descriptors

// ── Raw tables ────────────────────────────────────────────────────────────────

// Item DATs — each entry has [idStart, idEnd] (inclusive) plus jp/en DAT paths.
// Categories with the same jp/en DAT share the binary (e.g. Custom_Items overlaps Monstrosity_1).
const ITEM_DATS = [
  // category               idStart  idEnd   jp DAT                  en DAT
  { cat: 'Items_1',                   s:     0, e:  4095, jp: 'ROM/0/4.DAT',      en: 'ROM/118/106.DAT' },
  { cat: 'Consumable_Items',          s:  4096, e:  8191, jp: 'ROM/0/5.DAT',      en: 'ROM/118/107.DAT' },
  { cat: 'Puppet_Items',              s:  8192, e:  8703, jp: 'ROM/0/8.DAT',      en: 'ROM/118/110.DAT' },
  { cat: 'Items_2',                   s:  8704, e: 10239, jp: 'ROM/301/114.DAT',  en: 'ROM/301/115.DAT' },
  { cat: 'Armor_1',                   s: 10240, e: 16383, jp: 'ROM/0/7.DAT',      en: 'ROM/118/109.DAT' },
  { cat: 'Weapons',                   s: 16384, e: 23039, jp: 'ROM/0/6.DAT',      en: 'ROM/118/108.DAT' },
  { cat: 'Armor_2',                   s: 23040, e: 28671, jp: 'ROM/286/72.DAT',   en: 'ROM/286/73.DAT'  },
  { cat: 'Moblin_Maze_Mongers',       s: 28672, e: 29695, jp: 'ROM/217/20.DAT',   en: 'ROM/217/21.DAT'  },
  { cat: 'Monstrosity_1',             s: 29696, e: 30719, jp: 'ROM/288/79.DAT',   en: 'ROM/288/80.DAT'  },
  { cat: 'Custom_Items',              s: 30720, e: 57343, jp: 'ROM/288/79.DAT',   en: 'ROM/288/80.DAT'  },
  { cat: 'Records_of_Eminence_Objectives', s: 57344, e: 61431, jp: 'ROM/307/15.DAT', en: 'ROM/307/16.DAT' },
  { cat: 'Items_3',                   s: 61432, e: 61439, jp: 'ROM/314/89.DAT',   en: 'ROM/314/89.DAT'  },
  { cat: 'Monstrosity_2',             s: 61440, e: 61951, jp: 'ROM/288/66.DAT',   en: 'ROM/288/67.DAT'  },
  { cat: 'Records_of_Eminence_Categories', s: 61952, e: 62975, jp: 'ROM/307/23.DAT', en: 'ROM/307/24.DAT' },
  { cat: 'Items_4',                   s: 62976, e: 62995, jp: 'ROM/320/26.DAT',   en: 'ROM/320/26.DAT'  },
  { cat: 'Items_5',                   s: 63008, e: 63023, jp: 'ROM/332/47.DAT',   en: 'ROM/332/49.DAT'  },
  { cat: 'Items_6',                   s: 63024, e: 63263, jp: 'ROM/332/46.DAT',   en: 'ROM/332/48.DAT'  },
  { cat: 'Gil',                       s: 65535, e: 65535, jp: 'ROM/0/9.DAT',      en: 'ROM/174/48.DAT'  },
];

// DMSG DATs — d_msg string tables (indexed by category name).
const DMSG_DATS = [
  // category                              jp DAT                  en DAT
  { cat: 'Job_Names',                      jp: 'ROM/165/86.DAT',   en: 'ROM/165/86.DAT'  },
  { cat: 'Help_Desk',                      jp: 'ROM/165/71.DAT',   en: 'ROM/165/72.DAT'  },
  { cat: 'Search_Description',            jp: 'ROM/165/74.DAT',   en: 'ROM/165/75.DAT'  },
  { cat: 'POL_Messages',                   jp: 'ROM/165/70.DAT',   en: 'ROM/165/70.DAT'  },
  { cat: 'Server_Names',                   jp: 'ROM/333/33.DAT',   en: 'ROM/333/34.DAT'  },
  { cat: 'Heading_Names',                  jp: 'ROM/165/67.DAT',   en: 'ROM/165/81.DAT'  },
  { cat: 'Equipment_Slot_Names',           jp: 'ROM/175/32.DAT',   en: 'ROM/175/33.DAT'  },
  { cat: 'Blue_Mage_Spell_Help_Text',      jp: 'ROM/166/115.DAT',  en: 'ROM/166/116.DAT' },
  { cat: 'Augment_Attributes',             jp: 'ROM/220/57.DAT',   en: 'ROM/220/58.DAT'  },
  { cat: 'Menu_Merit_Points',              jp: 'ROM/169/74.DAT',   en: 'ROM/169/75.DAT'  },
  { cat: 'Menu_Job_Points',               jp: 'ROM/314/61.DAT',   en: 'ROM/314/62.DAT'  },
  { cat: 'Menu_Job_Point_Gifts',           jp: 'ROM/324/58.DAT',   en: 'ROM/324/59.DAT'  },
  { cat: 'Soulplate_Attributes',           jp: 'ROM/187/67.DAT',   en: 'ROM/187/70.DAT'  },
  { cat: 'Trust_Messages',                 jp: 'ROM/311/73.DAT',   en: 'ROM/311/74.DAT'  },
  { cat: 'Emote_Help_Text',               jp: 'ROM/327/123.DAT',  en: 'ROM/327/124.DAT' },
  { cat: 'Chat_Window_Command_Help_Text',  jp: 'ROM/173/88.DAT',   en: 'ROM/173/89.DAT'  },
  { cat: 'Monster_Family_Names',           jp: 'ROM/188/37.DAT',   en: 'ROM/188/38.DAT'  },
  { cat: 'Moblin_Maze_Mongers_Rune_Help_Text', jp: 'ROM/219/85.DAT', en: 'ROM/219/86.DAT' },
  { cat: 'Titles',                         jp: 'ROM/180/77.DAT',   en: 'ROM/180/78.DAT'  },
  { cat: 'Key_Items',                      jp: 'ROM/175/34.DAT',   en: 'ROM/175/35.DAT'  },
  { cat: 'Status_Names_with_Adjectives',   jp: 'ROM/180/101.DAT',  en: 'ROM/180/102.DAT' },
  { cat: 'Spell_Names',                    jp: 'ROM/181/69.DAT',   en: 'ROM/181/73.DAT'  },
  { cat: 'Spell_Help_Text',               jp: 'ROM/181/71.DAT',   en: 'ROM/181/75.DAT'  },
  { cat: 'Ability_Names',                  jp: 'ROM/181/68.DAT',   en: 'ROM/181/72.DAT'  },
  { cat: 'Ability_Help_Text',             jp: 'ROM/181/70.DAT',   en: 'ROM/181/74.DAT'  },
  { cat: 'Mount_Names',                    jp: 'ROM/351/82.DAT',   en: 'ROM/351/84.DAT'  },
  { cat: 'Mount_Help_Text',               jp: 'ROM/351/83.DAT',   en: 'ROM/351/85.DAT'  },
  // Quests
  { cat: 'Quests_SandOria',               jp: 'ROM/176/46.DAT',   en: 'ROM/176/60.DAT'  },
  { cat: 'Quests_Bastok',                 jp: 'ROM/176/47.DAT',   en: 'ROM/176/61.DAT'  },
  { cat: 'Quests_Windurst',               jp: 'ROM/176/48.DAT',   en: 'ROM/176/62.DAT'  },
  { cat: 'Quests_Jeuno',                  jp: 'ROM/176/49.DAT',   en: 'ROM/176/63.DAT'  },
  { cat: 'Quests_Other_Areas',            jp: 'ROM/176/50.DAT',   en: 'ROM/176/64.DAT'  },
  { cat: 'Quests_Treasures_of_Aht_Urhgan', jp: 'ROM/176/52.DAT', en: 'ROM/176/66.DAT'  },
  { cat: 'Quests_Wings_of_the_Goddess',   jp: 'ROM/196/3.DAT',    en: 'ROM/196/6.DAT'   },
  { cat: 'Quests_Abyssea',               jp: 'ROM/242/63.DAT',   en: 'ROM/242/64.DAT'  },
  { cat: 'Quests_Assault',               jp: 'ROM/176/58.DAT',   en: 'ROM/176/72.DAT'  },
  { cat: 'Quests_Campaign_Ops',           jp: 'ROM/196/5.DAT',    en: 'ROM/196/8.DAT'   },
  { cat: 'Quests_Seekers_of_Adoulin',     jp: 'ROM/293/67.DAT',   en: 'ROM/293/70.DAT'  },
  { cat: 'Quests_Coalition_Assignments',  jp: 'ROM/293/68.DAT',   en: 'ROM/293/71.DAT'  },
  // Missions
  { cat: 'Missions_SandOria',             jp: 'ROM/176/53.DAT',   en: 'ROM/176/67.DAT'  },
  { cat: 'Missions_Bastok',               jp: 'ROM/176/54.DAT',   en: 'ROM/176/68.DAT'  },
  { cat: 'Missions_Windurst',             jp: 'ROM/176/55.DAT',   en: 'ROM/176/69.DAT'  },
  { cat: 'Missions_Rise_of_the_Zilart',   jp: 'ROM/176/56.DAT',   en: 'ROM/176/70.DAT'  },
  { cat: 'Missions_Chains_of_Promathia',  jp: 'ROM/176/57.DAT',   en: 'ROM/176/71.DAT'  },
  { cat: 'Missions_Treasures_of_Aht_Urhgan', jp: 'ROM/176/59.DAT', en: 'ROM/176/73.DAT' },
  { cat: 'Missions_Wings_of_the_Goddess', jp: 'ROM/196/4.DAT',    en: 'ROM/196/7.DAT'   },
  { cat: 'Missions_A_Crystalline_Prophecy', jp: 'ROM/222/17.DAT', en: 'ROM/222/18.DAT'  },
  { cat: 'Missions_A_Moogle_Kupo_dEtat',  jp: 'ROM/223/10.DAT',   en: 'ROM/223/12.DAT'  },
  { cat: 'Missions_A_Shantotto_Ascension', jp: 'ROM/223/11.DAT',  en: 'ROM/223/13.DAT'  },
  { cat: 'Missions_Seekers_of_Adoulin',   jp: 'ROM/293/66.DAT',   en: 'ROM/293/69.DAT'  },
  { cat: 'Missions_Rhapsodies_of_Vanadiel', jp: 'ROM/333/3.DAT',  en: 'ROM/333/4.DAT'   },
];

// Resource DATs — UI, title screen, metadata.
const RESOURCE_DATS = [
  { cat: 'UI',                     jp: 'ROM/91/15.DAT',    en: 'ROM/119/51.DAT'  },
  { cat: 'Title_Screen',           jp: 'ROM/91/16.DAT',    en: 'ROM/119/50.DAT'  },
  { cat: 'Spell_Ability_Metadata', jp: 'ROM/118/114.DAT',  en: 'ROM/118/114.DAT' },
];

// EventMessage DATs — event-message string tables.
const EVENT_MESSAGE_DATS = [
  { cat: 'Skill_Names',     jp: 'ROM/27/65.DAT',     en: 'ROM/27/66.DAT'     },
  { cat: 'Modifier_Flags',  jp: 'ROM/27/67.DAT',     en: 'ROM/27/68.DAT'     },
  { cat: 'Emotes',          jp: 'ROM/27/69.DAT',     en: 'ROM/27/70.DAT'     },
  { cat: 'Ability_Messages', jp: 'ROM/27/71.DAT',    en: 'ROM/27/72.DAT'     },
  { cat: 'Status_Names',    jp: 'ROM/27/73.DAT',     en: 'ROM/27/74.DAT'     },
  { cat: 'System_Messages', jp: 'ROM/27/75.DAT',     en: 'ROM/27/76.DAT'     },
  { cat: 'Ability_Names_256', jp: 'ROM/27/79.DAT',   en: 'ROM/27/80.DAT'     },
  { cat: 'Unity_Messages',  jp: 'ROM/337/67.DAT',    en: 'ROM/337/68.DAT'    },
  { cat: 'Zones_1',         jp: 'ROM3/1/38.DAT',     en: 'ROM3/2/10.DAT'     },
  { cat: 'Zones_2',         jp: 'ROM9/5/77.DAT',     en: 'ROM9/5/101.DAT'    },
  { cat: 'Zones_3',         jp: 'ROM/186/103.DAT',   en: 'ROM/186/97.DAT'    },
  { cat: 'Zones_4',         jp: 'ROM/214/63.DAT',    en: 'ROM/214/64.DAT'    },
];

// ── Class ─────────────────────────────────────────────────────────────────────

export class DatIndex {
  // lang: 'en' | 'jp'  (default 'en')
  constructor(lang = 'en') {
    this._lang = lang === 'jp' ? 'jp' : 'en';

    // Flat category map: cat → { jp, en, type, s?, e? }
    this._map = new Map();
    for (const row of ITEM_DATS)
      this._map.set(row.cat, { jp: row.jp, en: row.en, type: 'item', s: row.s, e: row.e });
    for (const row of DMSG_DATS)
      this._map.set(row.cat, { jp: row.jp, en: row.en, type: 'dmsg' });
    for (const row of RESOURCE_DATS)
      this._map.set(row.cat, { jp: row.jp, en: row.en, type: 'resource' });
    for (const row of EVENT_MESSAGE_DATS)
      this._map.set(row.cat, { jp: row.jp, en: row.en, type: 'event_message' });
  }

  // ROM path for a named category in the current language.
  // Returns undefined if category is unknown.
  path(cat) {
    const entry = this._map.get(cat);
    return entry ? entry[this._lang] : undefined;
  }

  // Full descriptor for a category: { jp, en, type, s?, e? }.
  category(cat) {
    return this._map.get(cat);
  }

  // ROM path for the item DAT that contains the given item ID.
  // Returns undefined if no range covers the ID.
  itemDatFor(itemId) {
    for (const row of ITEM_DATS) {
      if (itemId >= row.s && itemId <= row.e)
        return row[this._lang];
    }
    return undefined;
  }

  // Category name for a given item ID. Returns undefined if unmatched.
  itemCategoryFor(itemId) {
    for (const row of ITEM_DATS) {
      if (itemId >= row.s && itemId <= row.e)
        return row.cat;
    }
    return undefined;
  }

  // All categories as an array of { cat, jp, en, type, s?, e? }.
  allCategories() {
    return [...this._map.entries()].map(([cat, v]) => ({ cat, ...v }));
  }

  // All categories of a given type: 'item' | 'dmsg' | 'resource' | 'event_message'
  byType(type) {
    return this.allCategories().filter(c => c.type === type);
  }

  // All item DAT entries with their ID ranges, sorted by start ID.
  itemRanges() {
    return ITEM_DATS.map(r => ({ cat: r.cat, s: r.s, e: r.e, jp: r.jp, en: r.en }))
      .sort((a, b) => a.s - b.s);
  }
}

// Singleton with default (EN) language — convenient for one-liner imports.
export const datIndex = new DatIndex('en');
