// Previstos (aba Recorrentes): gera as ocorrências de cada mês e dá baixa quando o extrato traz o débito.
import { addMonths, dateInMonth, diffDays, endOfMonth, monthOf, normDesc, round2 } from './util.js';

export function occurrences(state, fromExclusive, toInclusive, { includeCard = false } = {}) {
  const out = [];
  let ym = monthOf(fromExclusive);
  const last = monthOf(toInclusive);
  for (let guard = 0; ym <= last && guard < 40; guard++, ym = addMonths(ym, 1)) {
    for (const rec of state.recurring) {
      if (!rec.active) continue;
      if (rec.card && !includeCard) continue;
      const due = dateInMonth(ym, rec.day);
      if (due > fromExclusive && due <= toInclusive) out.push({ rec, due });
    }
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

export function coverage(state) {
  let c = state.baseline.date;
  for (const t of state.txns) if (t.acct === 'banco' && t.date > c) c = t.date;
  if (state.bank?.date && state.bank.date > c) c = state.bank.date;
  return c;
}

const WINDOW = 7;

// Recalcula, do zero, qual lançamento do extrato pagou qual previsto. Determinístico.
export function applyMatches(state) {
  for (const t of state.txns) { t.rec = null; t.recDiff = 0; }
  const cov = coverage(state);
  const occ = occurrences(state, state.baseline.date, cov);
  const maxMonthsBack = addMonths(monthOf(cov), 0);
  void maxMonthsBack;
  for (const { rec, due } of occ) {
    const key = rec.match ? normDesc(rec.match) : '';
    let best = null;
    for (const t of state.txns) {
      if (t.acct !== 'banco' || t.rec || t.kind === 'transfer' || t.kind === 'cardpay') continue;
      if ((rec.type === 'in') !== (t.amount > 0)) continue;
      const days = Math.abs(diffDays(t.date, due));
      if (days > WINDOW) continue;
      const a = Math.abs(t.amount);
      const tol = Math.max(0.5, 0.02 * rec.amount);
      const exact = Math.abs(a - rec.amount) <= tol;
      const kw = key && normDesc(t.desc).includes(key);
      const ratio = a / rec.amount;
      if (!exact && !(kw && ratio >= 0.3 && ratio <= 3)) continue;
      const score = days * 10 + Math.abs(a - rec.amount) / Math.max(1, rec.amount) + (exact ? 0 : 5);
      if (!best || score < best.score) best = { t, score, exact };
    }
    if (best) { best.t.rec = rec.id; best.t.recDue = due; best.t.recDiff = best.exact ? 0 : round2(Math.abs(best.t.amount) - rec.amount); }
  }
}

// Situação de cada ocorrência de um mês para exibir na tela.
export function monthItems(state, ym, today) {
  const cov = coverage(state);
  const items = [];
  for (const rec of state.recurring) {
    if (!rec.active || rec.card) continue;
    const due = dateInMonth(ym, rec.day);
    if (due <= state.baseline.date) continue; // antes do saldo inicial: já está nele
    const txn = state.txns.find((t) => t.rec === rec.id && t.recDue === due) || null;
    let status;
    if (txn) status = txn.recDiff ? 'diferente' : 'paga';
    else if (due <= cov) status = 'sem débito';
    else status = 'a vencer';
    items.push({ rec, due, txn, status, planned: rec.amount });
  }
  void today;
  return items.sort((a, b) => (a.due < b.due ? -1 : 1));
}
export { endOfMonth };
