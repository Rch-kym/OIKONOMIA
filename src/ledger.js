// Estado do app, importação de extrato (com deduplicação), regras aprendidas e lançamentos manuais.
import { classify } from './rules.js';
import { applyMatches } from './recurring.js';
import { diffDays, merchantKey, normDesc, round2 } from './util.js';

export function newState(seed) {
  return {
    v: 1,
    baseline: { ...seed.baseline },
    config: { ...seed.config },
    recurring: structuredClone(seed.recurring),
    rules: [],
    txns: [],
    imports: [],
    bank: null, // { amount, date } = saldo informado pelo banco no último arquivo
    nextId: 1,
  };
}

const keyOf = (t) => `${t.acct}|${t.date}|${t.amount.toFixed(2)}|${normDesc(t.desc)}`;

// Reaplica baixa de previstos e classificação em todos os lançamentos (determinístico).
export function reclassify(state) {
  applyMatches(state);
  const recById = new Map(state.recurring.map((r) => [r.id, r]));
  for (const t of state.txns) {
    if (t.locked) continue;
    if (t.rec) {
      const r = recById.get(t.rec);
      t.cat = r.cat; t.kind = r.type === 'in' ? 'in' : 'out'; t.status = 'ok'; t.guess = '';
      continue;
    }
    const c = classify(t.desc, t.amount, state, t.acct);
    t.cat = c.cat; t.kind = c.kind; t.status = c.status; t.guess = c.guess;
  }
  return state;
}

export function importParsed(stateIn, parsed, meta = {}) {
  const state = structuredClone(stateIn);
  const acct = parsed.account === 'cartao' || meta.asCard ? 'cartao' : 'banco';
  const report = { file: meta.file || '', acct, found: parsed.txns.length, added: 0, duplicates: 0, before: 0, confirmedManual: 0, auto: 0, review: 0, balance: parsed.balance || null };

  const existing = new Map();
  for (const t of state.txns) existing.set(keyOf(t), (existing.get(keyOf(t)) || 0) + 1);
  const seenInFile = new Map();

  for (const p of parsed.txns) {
    const t = { id: 0, date: p.date, amount: round2(p.amount), desc: p.desc, acct };
    if (acct === 'banco' && t.date <= state.baseline.date) { report.before++; continue; }
    const k = keyOf(t);
    const occ = (seenInFile.get(k) || 0) + 1;
    seenInFile.set(k, occ);
    if (occ <= (existing.get(k) || 0)) { report.duplicates++; continue; }

    // Se você já tinha anotado este gasto à mão, o extrato só confirma (não duplica).
    if (acct === 'banco') {
      const man = state.txns.find((m) => m.manual && m.acct === 'banco' && !m.confirmed && Math.abs(m.amount - t.amount) < 0.005 && Math.abs(diffDays(m.date, t.date)) <= 3);
      if (man) { man.confirmed = true; man.date = t.date; man.desc = `${man.desc} (${t.desc})`; report.confirmedManual++; continue; }
    }
    t.id = state.nextId++;
    t.cat = ''; t.kind = t.amount >= 0 ? 'in' : 'out'; t.status = 'review'; t.guess = ''; t.rec = null;
    state.txns.push(t);
    report.added++;
  }

  if (acct === 'banco' && parsed.balance && parsed.balance.date) state.bank = { amount: parsed.balance.amount, date: parsed.balance.date };
  reclassify(state);

  const fresh = state.txns.slice(state.txns.length - report.added);
  report.auto = fresh.filter((t) => t.status === 'ok').length;
  report.review = fresh.filter((t) => t.status === 'review').length;
  state.imports.push({ at: meta.at || new Date().toISOString(), file: meta.file || '', acct, added: report.added, duplicates: report.duplicates });
  return { state, report };
}

// Grupos de lançamentos que esperam uma categoria sua (agrupados por estabelecimento).
export function reviewGroups(state) {
  const map = new Map();
  for (const t of state.txns) {
    if (t.status !== 'review') continue;
    const k = merchantKey(t.desc);
    let g = map.get(k);
    if (!g) { g = { key: k, desc: t.desc, count: 0, total: 0, kind: t.kind, guess: t.guess, acct: t.acct, ids: [], firstDate: t.date, lastDate: t.date }; map.set(k, g); }
    g.count++; g.total = round2(g.total + t.amount); g.ids.push(t.id);
    if (t.date < g.firstDate) g.firstDate = t.date;
    if (t.date > g.lastDate) g.lastDate = t.date;
    if (!g.guess && t.guess) g.guess = t.guess;
  }
  return [...map.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

// "Confirmar e lembrar": cria a regra e reclassifica tudo do mesmo estabelecimento.
export function confirmGroup(stateIn, key, cat, kind) {
  const state = structuredClone(stateIn);
  const sample = state.txns.find((t) => merchantKey(t.desc) === key);
  const k = kind || sample?.kind || 'out';
  state.rules = state.rules.filter((r) => r.key !== key);
  state.rules.push({ key, cat, kind: k });
  reclassify(state);
  return state;
}

export function addManual(stateIn, { date, amount, desc, cat, acct = 'dinheiro' }) {
  const state = structuredClone(stateIn);
  const t = { id: state.nextId++, date, amount: round2(amount), desc, acct, cat, kind: amount >= 0 ? 'in' : 'out', status: 'ok', guess: '', rec: null, manual: true, locked: true };
  state.txns.push(t);
  return { state, txn: t };
}

export function moveToAccount(stateIn, id, acct) {
  const state = structuredClone(stateIn);
  const t = state.txns.find((x) => x.id === id);
  if (t) t.acct = acct;
  return state;
}
export function removeTxn(stateIn, id) {
  const state = structuredClone(stateIn);
  state.txns = state.txns.filter((x) => x.id !== id);
  reclassify(state);
  return state;
}

// Edição de um lançamento: categoria e conta. Quem edita à mão "trava" o lançamento (as regras não mexem mais).
export function updateTxn(stateIn, id, patch) {
  const state = structuredClone(stateIn);
  const t = state.txns.find((x) => x.id === id);
  if (!t) return state;
  if (patch.acct) t.acct = patch.acct;
  if (patch.cat !== undefined) { t.cat = patch.cat; t.locked = true; t.status = 'ok'; t.guess = ''; }
  reclassify(state);
  return state;
}
