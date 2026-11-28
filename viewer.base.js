
export default {

  eyebrow: 'M3M Noida · The Cullinan 94',
  title: '4D BIM Progress',
  stageHeading: false,
  loadingText: 'Loading the structural model…',
  loadingSub: 'Towers A1–D2, podium and substructure (Revit exports of 26 Nov 2026)',

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
    { id: 'TA1', name: 'Tower A1', short: 'A1', pack: 'm3m-site-ta1', wing: 'TA1' },
    { id: 'TA2', name: 'Tower A2', short: 'A2', pack: 'm3m-site-ta2', wing: 'TA2' },
    { id: 'TB', name: 'Tower B', short: 'B', pack: 'm3m-site-tb', wing: 'TB' },
    { id: 'TC1', name: 'Tower C1', short: 'C1', pack: 'm3m-site-tc1', wing: 'TC1' },
    { id: 'TC2', name: 'Tower C2', short: 'C2', pack: 'm3m-site-tc2', wing: 'TC2' },
    { id: 'TD1', name: 'Tower D1', short: 'D1', pack: 'm3m-site-td1', wing: 'TD1' },
    { id: 'TD2', name: 'Tower D2', short: 'D2', pack: 'm3m-site-td2', wing: 'TD2' },
    { id: 'NTA_RETAIL', name: 'NTA Retail', short: 'NTA Retail', pack: 'm3m-site-nta-retail', wing: 'NTA_RETAIL' },
    { id: 'NTA_MALL', name: 'NTA Mall', short: 'NTA Mall', pack: 'm3m-site-nta-mall', wing: 'NTA_MALL' },
    { id: 'NTA_MLCP', name: 'NTA Multi-Level Car Park', short: 'MLCP', pack: 'm3m-site-nta-mlcp', wing: 'NTA_MLCP' },
    { id: 'NTA_NONRETAIL', name: 'NTA Non-Retail', short: 'Non-Retail', pack: 'm3m-site-nta-nonretail', wing: 'NTA_NONRETAIL' },
    { id: 'OTHER', name: 'Perimeter walls', short: 'Perimeter', pack: 'm3m-site-perimeter', wing: 'PERIMETER' },
    { id: 'UNLINKED', name: 'Not yet linked', short: 'Not yet linked', pack: 'm3m-site-unlinked', wing: 'UNLINKED', noSchedule: true },
    { id: 'SITE-OTHER', name: 'Other (ramps, stairs, STP)', short: 'Other', pack: 'm3m-site-site-other', wing: 'SITE-OTHER', noSchedule: true },
  ],

  storeyOffset: 1,

  tradeCategories: [
    [/column\s+(reinforcement|shuttering|rcc)/i, ['WALL', 'COLUMN']],
    [/slab\s+(reinforcement|panelling|shuttering|rcc)/i, ['SLAB', 'BEAM']],
    [/^staircase$|stair/i, ['STAIR']],
    [/tremix|vacuum dewatering/i, ['SLAB']],
    [/masonry|blockwork/i, ['WALL']],
    [/retaining wall|skin wall|d-?wall/i, ['WALL']],
    [/raft|footing|pile|pcc|grade slab|earthwork/i, ['FOUNDATION', 'SLAB']],
  ],

  view: { bearing: 90, elevation: 25, sweep: 0 },

  initialTowers: ['TA1', 'TA2', 'TB', 'TC1', 'TC2', 'TD1', 'TD2', 'NTA_RETAIL', 'NTA_MALL', 'NTA_MLCP', 'NTA_NONRETAIL', 'OTHER',
    'UNLINKED', 'SITE-OTHER'],
  towerSelect: 'single',
  captions: { chips: ['TA1', 'TA2', 'TB', 'TC1', 'TC2', 'TD1', 'TD2'], compactAbove: 5 },
  ladderTicks: 7,
  ladderFrom: 'TA1',
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
