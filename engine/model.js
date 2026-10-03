
import { shownStatus } from './palette.js';

export const C = {
  F: 0, T: 1, N: 2, DONE: 3, ACT: 4, BC: 5, EV: 6, PV: 7,
  PS: 8, FA: 9, LA: 10, PSTART: 11, PEND: 12, AOP: 13,
  TOFF: 14, TN: 15,
};

const DAY = 86400000;
export const dayToDate = (d) => (d >= 0 ? new Date(d * DAY) : null);

export function decode(raw) {
  const trades = raw.trades.map(([key, name, group, seq], idx) => ({ key, name, group, seq, idx }));
  const groups = raw.groups;
  const statuses = (raw.statuses || []).map(shownStatus);
  const structures = raw.structures.map((s) => {
    const floors = s.floors.map(([id, name, short, rank, isFloor], idx) => ({
      id, name, short, rank, isFloor: isFloor === 1, idx,
    }));
    const byTrade = new Map();
    for (const c of s.cells) {
      let arr = byTrade.get(c[C.T]);
      if (!arr) byTrade.set(c[C.T], (arr = []));
      arr.push(c);
    }
    return { ...s, floors, byTrade, tradeIdxs: new Set(byTrade.keys()), statuses };
  });

  return {
    ...raw,
    statuses,
    trades,
    groups,
    structures,
    structureById: new Map(structures.map((s) => [s.id, s])),
    groupById: new Map(groups.map((g) => [g.id, g])),
    today: raw.asOfDay,
  };
}

const emptyFloor = () => ({
  n: 0, done: 0, active: 0, budget: 0, earned: 0, pv: 0, aop: 0, pctSum: 0,
  fa: -1, la: -1, pStart: -1, pEnd: -1, trades: new Map(),
});

export function sliceStructure(structure, tradeIdxs) {
  const floors = structure.floors.map(() => null);
  const totals = emptyFloor();

  for (const t of tradeIdxs) {
    const cells = structure.byTrade.get(t);
    if (!cells) continue;
    for (const c of cells) {
      const fi = c[C.F];
      let f = floors[fi];
      if (!f) floors[fi] = f = emptyFloor();
      accumulate(f, c);
      accumulate(totals, c);
      f.trades.set(t, c);
    }
  }

  const rows = structure.floors.map((meta, i) => {
    const agg = floors[i] || emptyFloor();
    return { ...meta, ...agg, pct: pctOf(agg), planPct: planPctOf(agg) };
  });

  return {
    id: structure.id,
    name: structure.name,
    short: structure.short,
    kind: structure.kind,
    pkg: structure.pkg,
    rows,
    storeys: rows.filter((r) => r.isFloor),
    totals: { ...totals, pct: pctOf(totals), planPct: planPctOf(totals) },
  };
}

function accumulate(f, c) {
  f.n += c[C.N];
  f.done += c[C.DONE];
  f.active += c[C.ACT];
  f.budget += c[C.BC];
  f.earned += c[C.EV];
  f.pv += c[C.PV];
  f.aop += c[C.AOP];
  f.pctSum += c[C.PS];
  if (c[C.FA] >= 0) f.fa = f.fa < 0 ? c[C.FA] : Math.min(f.fa, c[C.FA]);
  if (c[C.LA] >= 0) f.la = Math.max(f.la, c[C.LA]);
  if (c[C.PSTART] >= 0) f.pStart = f.pStart < 0 ? c[C.PSTART] : Math.min(f.pStart, c[C.PSTART]);
  if (c[C.PEND] >= 0) f.pEnd = Math.max(f.pEnd, c[C.PEND]);
}

export function pctOf(a) {
  if (a.budget > 0) return (a.earned / a.budget) * 100;
  return a.n > 0 ? a.pctSum / a.n : 0;
}
export function planPctOf(a) {
  if (a.budget > 0) return (a.pv / a.budget) * 100;
  return null;
}

export function statusOf(r) {
  if (r.n === 0) return 'none';
  if (r.pct >= 99.5 || (r.done === r.n && r.n > 0)) return 'done';
  if (r.active > 0 || r.pct > 0) return 'wip';
  return 'none';
}

export function buildLadder(slices) {
  const byRank = new Map();
  for (const s of slices) {
    for (const r of s.storeys) {
      const cur = byRank.get(r.rank);
      if (!cur) byRank.set(r.rank, { rank: r.rank, name: r.name, short: r.short, count: 1 });
      else {
        cur.count++;
        if (r.name.length < cur.name.length) { cur.name = r.name; cur.short = r.short; }
      }
    }
  }
  const rungs = [...byRank.values()].sort((a, b) => a.rank - b.rank);
  rungs.forEach((r, i) => { r.y = i; });
  return { rungs, indexOf: new Map(rungs.map((r) => [r.rank, r.y])) };
}

export function reachLines(slice, ladder, today) {
  let now = -1, plan = -1, aop = -1;
  for (const r of slice.storeys) {
    const y = ladder.indexOf.get(r.rank);
    if (y === undefined || r.n === 0) continue;
    if (r.pct > 0) now = Math.max(now, y);
    if (r.pStart >= 0 && today !== undefined && r.pStart <= today) plan = Math.max(plan, y);
    if (r.aop > 0) aop = Math.max(aop, y);
  }
  return { now, plan, aop };
}

export function tradesPresent(structures) {
  const s = new Set();
  for (const st of structures) for (const t of st.tradeIdxs) s.add(t);
  return s;
}


export const fmtCr = (rupees) => {
  const cr = rupees / 1e7;
  if (cr >= 1000) return cr.toFixed(0);
  if (cr >= 100) return cr.toFixed(0);
  if (cr >= 10) return cr.toFixed(1);
  return cr.toFixed(2);
};
export const fmtPct = (p) => (p === null || !Number.isFinite(p) ? '—' : `${p.toFixed(p >= 10 ? 0 : 1)}%`);
export const fmtInt = (n) => n.toLocaleString('en-IN');
export const fmtDate = (d) => {
  const dt = dayToDate(d);
  return dt ? dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '—';
};
export const fmtDateLong = (d) => {
  const dt = dayToDate(d);
  return dt ? dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
};
export const dayToISO = (d) => new Date(d * DAY).toISOString().slice(0, 10);
export const isoToDay = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY);


function actualFraction(as, ae, pc, t, today) {
  if (as < 0 || as > t) return 0;
  if (ae >= 0) return t >= ae ? 1 : (ae > as ? (t - as) / (ae - as) : 1);
  if (pc <= 0) return 0;
  const span = Math.max(1, today - as);
  return (pc / 100) * Math.min(1, Math.max(0, (t - as) / span));
}


export function forecastEnd(ps, pe, today) {
  if (pe < 0) return -1;
  if (pe > today) return pe;
  return today + (ps >= 0 && pe > ps ? pe - ps : 1);
}

export function forecastStart(as, ps, today) {
  if (as >= 0) return as;
  if (ps < 0) return -1;
  return ps > today ? ps : today;
}

export function earnedFraction(as, ae, pc, t, today, ps = -1, pe = -1) {
  if (t <= today) return actualFraction(as, ae, pc, t, today);
  const soFar = actualFraction(as, ae, pc, today, today);
  if (soFar >= 1) return 1;
  const fe = forecastEnd(ps, pe, today);
  if (fe < 0) return soFar;
  return Math.max(soFar, rampFraction(forecastStart(as, ps, today), fe, t));
}

export function rampFraction(s, e, t) {
  if (s < 0) return e >= 0 && t >= e ? 1 : 0;
  if (t < s) return 0;
  if (e < 0 || e <= s) return 1;
  return t >= e ? 1 : (t - s) / (e - s);
}

const emptyAt = () => ({
  n: 0, done: 0, active: 0, budget: 0, earned: 0, pv: 0, baseline: 0, baselineCost: 0,
  pctSum: 0, fa: -1, la: -1, pStart: -1, pEnd: -1, aop: 0,
  trades: new Map(),
  status: new Map(),
  planState: new Map(),
  baseState: new Map(),
});

const PRE_START = new Set(['not committed', 'not ready', 'ready', 'forced ready']);

export function isNotStarted(name) {
  return PRE_START.has(String(name).trim().toLowerCase());
}

export function statusAt(statuses, si, as, ae, day, today = day, ps = -1, pe = -1) {
  const recorded = statuses[si] || 'Unknown';
  if (ae >= 0 && ae <= day) return recorded;
  if (day > today) {
    const fe = forecastEnd(ps, pe, today);
    if (fe >= 0 && day >= fe) return 'Complete';
    const fs = forecastStart(as, ps, today);
    if (fs >= 0 && day >= fs) return 'Started';
  }
  if (as >= 0 && as <= day) return 'Started';
  return PRE_START.has(recorded.toLowerCase()) ? recorded : 'Not Committed';
}

export function sliceStructureAt(structure, tradeIdxs, day, today, aopHorizon = Infinity) {
  const T = structure.tasks;
  if (!T) return sliceStructure(structure, tradeIdxs);
  const rows = structure.floors.map(() => null);
  const totals = emptyAt();

  for (const t of tradeIdxs) {
    const cells = structure.byTrade.get(t);
    if (!cells) continue;
    for (const c of cells) {
      const fi = c[C.F];
      let f = rows[fi];
      if (!f) rows[fi] = f = emptyAt();
      f.trades.set(t, accumulateAt(f, totals, c, T, day, today, aopHorizon, structure.statuses));
    }
  }

  const out = structure.floors.map((meta, i) => {
    const agg = rows[i] || emptyAt();
    return { ...meta, ...agg, pct: pctOf(agg), planPct: planPctOf(agg) };
  });

  return {
    id: structure.id,
    name: structure.name,
    short: structure.short,
    kind: structure.kind,
    pkg: structure.pkg,
    day,
    rows: out,
    storeys: out.filter((r) => r.isFloor),
    totals: { ...totals, pct: pctOf(totals), planPct: planPctOf(totals) },
  };
}

export function planStateFor(as, ae, s, day, today = day, ps = -1, pe = -1) {
  if (ae >= 0 && ae <= day) return 'done';
  if (as >= 0 && as <= day) return 'started';
  if (day > today) {
    const fe = forecastEnd(ps, pe, today);
    if (fe >= 0 && day >= fe) return 'done';
    const fs = forecastStart(as, ps, today);
    if (fs >= 0 && day >= fs) return 'started';
  }
  return s >= 0 && s <= day ? 'behind' : 'notdue';
}

export const PLAN_STATE_LABEL = {
  done: 'Complete',
  started: 'Started',
  behind: 'Planned, not started',
  notdue: 'Not due yet',
};

const PLAN_STATE_RANK = { behind: 0, started: 1, done: 2, notdue: 3 };

export function dominantPlanState(mix) {
  if (!mix || !mix.size) return null;
  let best = null, n = -1;
  for (const [k, v] of mix) {
    if (v > n || (v === n && PLAN_STATE_RANK[k] < PLAN_STATE_RANK[best])) { best = k; n = v; }
  }
  return best;
}

const ALERT_STATUS = ['Stopped', 'Rejected at quality check', 'Warning'];

export function dominantStatus(mix) {
  if (!mix || !mix.size) return null;
  for (const a of ALERT_STATUS) if (mix.get(a)) return a;
  let best = null, n = -1;
  for (const [k, v] of mix) if (v > n) { best = k; n = v; }
  return best;
}

function accumulateAt(f, totals, c, T, day, today, aopHorizon, statuses) {
  const off = c[C.TOFF];
  const end = off + c[C.TN];
  const mix = new Map();
  const planMix = new Map();
  const baseMix = new Map();
  let bc = 0, ev = 0, pv = 0, bl = 0, blc = 0, done = 0, active = 0, seen = 0, pctSum = 0;
  let fa = -1, la = -1, pS = -1, pE = -1, aop = 0;

  for (let i = off; i < end; i++) {
    const budget = T.bc[i];
    const as = T.as[i], ae = T.ae[i];
    const ps = T.ps[i], pe = T.pe[i];
    const ef = earnedFraction(as, ae, T.pc[i], day, today, ps, pe);
    const fcEnd = day > today ? forecastEnd(ps, pe, today) : -1;
    const finished = (ae >= 0 && ae <= day) || (fcEnd >= 0 && day >= fcEnd);
    const started = (as >= 0 && as <= day) || ef > 0;

    bc += budget;
    ev += budget * ef;
    pv += budget * rampFraction(T.ps[i], T.pe[i], day);
    blc += T.bl[i];
    bl += T.bl[i] * rampFraction(T.bs[i], T.be[i], day);
    if (finished) done++;
    else if (started && ef > 0) active++;
    seen++;
    pctSum += ef * 100;
    if (as >= 0 && as <= day) fa = fa < 0 ? as : Math.min(fa, as);
    if (ae >= 0 && ae <= day) la = Math.max(la, ae);
    if (ps >= 0) pS = pS < 0 ? ps : Math.min(pS, ps);
    if (pe >= 0) pE = Math.max(pE, pe);
    if (pe >= 0 && pe <= aopHorizon) aop += budget;
    if (statuses && T.st) {
      const nm = statusAt(statuses, T.st[i], as, ae, day, today, ps, pe);
      mix.set(nm, (mix.get(nm) || 0) + 1);
      f.status.set(nm, (f.status.get(nm) || 0) + 1);
      totals.status.set(nm, (totals.status.get(nm) || 0) + 1);
    }
    const psv = planStateFor(as, ae, ps, day, today, ps, pe);
    planMix.set(psv, (planMix.get(psv) || 0) + 1);
    f.planState.set(psv, (f.planState.get(psv) || 0) + 1);
    totals.planState.set(psv, (totals.planState.get(psv) || 0) + 1);
    const bsv = planStateFor(as, ae, T.bs[i], day, today, ps, pe);
    baseMix.set(bsv, (baseMix.get(bsv) || 0) + 1);
    f.baseState.set(bsv, (f.baseState.get(bsv) || 0) + 1);
    totals.baseState.set(bsv, (totals.baseState.get(bsv) || 0) + 1);
  }

  for (const o of [f, totals]) {
    o.n += seen; o.done += done; o.active += active;
    o.budget += bc; o.earned += ev; o.pv += pv;
    o.baseline += bl; o.baselineCost += blc;
    o.pctSum += pctSum; o.aop += aop;
    if (fa >= 0) o.fa = o.fa < 0 ? fa : Math.min(o.fa, fa);
    if (la >= 0) o.la = Math.max(o.la, la);
    if (pS >= 0) o.pStart = o.pStart < 0 ? pS : Math.min(o.pStart, pS);
    if (pE >= 0) o.pEnd = Math.max(o.pEnd, pE);
  }

  const cell = c.slice();
  cell[C.N] = seen; cell[C.DONE] = done; cell[C.ACT] = active;
  cell[C.BC] = bc; cell[C.EV] = ev; cell[C.PV] = pv; cell[C.PS] = pctSum;
  cell[C.FA] = fa; cell[C.LA] = la;
  cell.status = mix;
  cell.planState = planMix;
  cell.baseState = baseMix;
  return cell;
}

export function buildCurves(structures, tradeIdxs, day0, day1, today) {
  const weeks = Math.max(2, Math.ceil((day1 - day0) / 7) + 1);
  const bl = new Float64Array(weeks);
  const pv = new Float64Array(weeks);
  const ev = new Float64Array(weeks);
  const fc = new Float64Array(weeks);
  const clampIdx = (i) => (i < 0 ? 0 : i >= weeks ? weeks - 1 : i);

  const spread = (out, s, e, value) => {
    if (!(value > 0)) return;
    if (s < 0 && e < 0) return;
    if (s < 0 || e <= s) {
      out[clampIdx(Math.floor(((e >= 0 ? e : s) - day0) / 7))] += value;
      return;
    }
    const total = e - s;
    let d = s;
    while (d < e) {
      const w = Math.floor((d - day0) / 7);
      const chunk = Math.min(e, day0 + (w + 1) * 7);
      out[clampIdx(w)] += (value * (chunk - d)) / total;
      d = chunk;
    }
  };

  for (const st of structures) {
    const T = st.tasks;
    if (!T) continue;
    for (const t of tradeIdxs) {
      const cells = st.byTrade.get(t);
      if (!cells) continue;
      for (const c of cells) {
        const off = c[C.TOFF];
        const end = off + c[C.TN];
        for (let i = off; i < end; i++) {
          const budget = T.bc[i];
          spread(bl, T.bs[i], T.be[i], T.bl[i]);
          spread(pv, T.ps[i], T.pe[i], budget);
          const as = T.as[i], ae = T.ae[i];
          if (ae >= 0) {
            spread(ev, as, ae, budget);
            spread(fc, as, ae, budget);
            continue;
          }
          const soFar = as >= 0 && T.pc[i] > 0 ? (budget * T.pc[i]) / 100 : 0;
          if (soFar > 0) {
            spread(ev, as, today, soFar);
            spread(fc, as, today, soFar);
          }
          const rest = budget - soFar;
          const fe = forecastEnd(T.ps[i], T.pe[i], today);
          if (rest > 0 && fe >= 0) spread(fc, Math.max(forecastStart(as, T.ps[i], today), today), fe, rest);
        }
      }
    }
  }

  let a = 0, b = 0, c2 = 0, d2 = 0;
  for (let i = 0; i < weeks; i++) {
    bl[i] = a += bl[i];
    pv[i] = b += pv[i];
    ev[i] = c2 += ev[i];
    fc[i] = d2 += fc[i];
  }
  return { weeks, day0, step: 7, today, baseline: bl, plan: pv, earned: ev, forecast: fc };
}

export function curveAt(curve, arr, day) {
  const x = (day - curve.day0) / curve.step;
  if (x <= 0) return arr[0];
  if (x >= curve.weeks - 1) return arr[curve.weeks - 1];
  const i = Math.floor(x);
  return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
}
