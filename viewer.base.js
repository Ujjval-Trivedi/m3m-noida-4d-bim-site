
export default {

  eyebrow: 'M3M Noida · The Cullinan 94',
  title: '4D BIM Progress',
  stageHeading: false,
  loadingText: 'Loading the structural model…',
  loadingSub: 'Towers A1, A2, B, C1 and C2',

  logos: [
    { light: '/brand/visilean-light.png', dark: '/brand/visilean-dark.png', alt: 'VisiLean — Construction, simplified', height: 36 },
    { light: '/brand/m3m-light.png', dark: '/brand/m3m-dark.png', alt: 'M3M', height: 32 },
  ],

  favicon: '/brand/visilean-icon.png',

  refreshUrl: '/api/refresh',

  themeKey: 'm3m-theme',
  defaultTheme: 'light',
  speedKey: 'm3m-play-speed',
  sidebarKey: 'm3m-sidebar',
  timeline: 'dock',

  modelUrl: '/api/model',
  packsBase: '/models',

  towers: [
    { id: 'TA1', name: 'Tower A1', short: 'A1', pack: 'm3m-residential-towers-str-tower-a-1-typical-ver1' },
    { id: 'TA2', name: 'Tower A2', short: 'A2', pack: 'm3m-residential-towers-str-tower-a2-typical-ver1' },
    { id: 'TB',  name: 'Tower B',  short: 'B',  pack: 'm3m-residential-towers-str-tower-b-typical-ver2' },

    {
      id: 'TC1', name: 'Tower C1', short: 'C1',
      pack: 'm3m-residential-towers-str-tower-c-typical-ver1',
      wing: 'TOWER-C1', takesShared: true,
    },
    {
      id: 'TC2', name: 'Tower C2', short: 'C2',
      pack: 'm3m-residential-towers-str-tower-c-typical-ver1',
      wing: 'TOWER-C2',
    },
  ],

  storeyOffset: 1,

  tradeCategories: [
    [/column\s+(reinforcement|shuttering|rcc)/i, ['WALL']],
    [/slab\s+(reinforcement|panelling|shuttering|rcc)/i, ['SLAB', 'BEAM']],
    [/^staircase$|stair/i, ['STAIR']],
    [/tremix|vacuum dewatering/i, ['SLAB']],
    [/masonry|blockwork/i, ['WALL']],
    [/retaining wall|skin wall|d-?wall/i, ['WALL']],
    [/raft|footing|pile|pcc|grade slab|earthwork/i, ['FOUNDATION', 'SLAB']],
  ],

  view: { bearing: 90, elevation: 25, sweep: 0 },

  initialTowers: ['TA1', 'TA2', 'TB', 'TC1', 'TC2'],
  towerSelect: 'single',
  levelSelect: 'single',
  tradeSelect: 'single',
  levelGroups: [
    { name: 'Sub-structure', match: /^(Foundation|Raft|Basement|Lower Ground|LGF)\b/i },
    { name: 'Podium', match: /^Ground Floor|Podium/i },
    { name: 'Club & Service', match: /^(Club|Service Floor)\b/i },
    { name: 'Residential floors', match: /^\d+(st|nd|rd|th)\s+Floor/i },
    { name: 'Terrace', match: /Terrace|Roof|Mumty|Machine/i },
  ],
  actsModelOnly: true,
  initialGroup: 'STRUCTURE',
  hiddenGroups: ['EXTDEV', 'NONCON', 'POSTCON', 'OTHERS', 'CONTINGENCY', 'ESCALATION'],
  compareLayer: { styles: ['lines', 'band', 'both'], style: 'lines' },
};
