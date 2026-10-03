

export function defaultStoreyRank(rawName, offset) {
  const name = String(rawName).trim().toUpperCase();

  if (/^SITE$/.test(name)) return null;
  if (/^\d+$/.test(name)) return null;

  if (/^LGF\s*\/\s*B1$/.test(name)) return -10;
  if (/^LGF$/.test(name)) return -5;
  const bas = name.match(/^B\s*(\d+)$/);
  if (bas) return -10 * Number(bas[1]);
  if (/^U?GF$/.test(name)) return 0;

  const pod = name.match(/^(\d+)(?:ST|ND|RD|TH)?\s+PODIUM/);
  if (pod) return Number(pod[1]);

  const flr = name.match(/^(\d+)(?:ST|ND|RD|TH)?\s+FLOOR/);
  if (flr) return Number(flr[1]) + offset;

  return null;
}

export function isTerrace(name) {
  return /TERRACE|^ROOF/i.test(String(name).trim());
}

export function buildStoreyMap(storeys, offset, rankFn = defaultStoreyRank) {
  const rows = storeys.map((s) => ({
    storey: s,
    rank: rankFn(s.name, offset),
    terrace: isTerrace(s.name),
  }));
  const top = rows.reduce((a, r) => (r.rank != null && r.rank > a ? r.rank : a), -Infinity);
  for (const r of rows) {
    if (r.rank == null && r.terrace && Number.isFinite(top)) r.rank = top + 1;
  }
  return rows;
}


export function makeTradeCategories(rules = []) {
  const categoriesForTrade = (tradeName) => {
    for (const [re, cats] of rules) if (re.test(tradeName)) return cats;
    return null;
  };

  const categoriesForSelection = (trades) => {
    const cats = new Set();
    let any = false;
    for (const t of trades) {
      const c = categoriesForTrade(t.name);
      if (c) { any = true; for (const x of c) cats.add(x); }
    }
    return { cats, modelled: any };
  };

  return { categoriesForTrade, categoriesForSelection };
}


export function groupBelongs(def, group) {
  if (!def.wing) return true;
  if (group.wing === def.wing) return true;
  return Boolean(def.takesShared) && (!group.wing || group.wing === 'SHARED');
}

export const CATEGORY_LABEL = {
  SLAB: 'Slab', BEAM: 'Beam', WALL: 'Wall / column', COLUMN: 'Column',
  STAIR: 'Stair', FOUNDATION: 'Foundation', OTHER: 'Other', FINISH: 'Finish',
  OPENING: 'Opening', FACADE: 'Facade',
};
