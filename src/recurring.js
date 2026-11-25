// Previstos (aba Recorrentes): gera as ocorrências de cada mês e dá baixa quando o extrato traz o débito.
import { addDays, addMonths, dateInMonth, diffDays, endOfMonth, merchantKey, monthOf, normDesc, round2 } from './util.js';

// Início/fim (meses "AAAA-MM") e "não teve neste mês" de cada conta fixa.
export const inRange = (rec, ym) => (!rec.from || ym >= rec.from) && (!rec.until || ym <= rec.until);
export const skipKey = (rec, due) => `${rec.id}|${due}`;
export const isSkipped = (state, rec, due) => (state.skips || []).includes(skipKey(rec, due));

export function occurrences(state, fromExclusive, toInclusive, { includeCard = false } = {}) {
  const out = [];
  let ym = monthOf(fromExclusive);
  const last = monthOf(toInclusive);
  for (let guard = 0; ym <= last && guard < 40; guard++, ym = addMonths(ym, 1)) {
    for (const rec of state.recurring) {
      if (!rec.active) continue;
      if (rec.card && !includeCard) continue;
      if (!inRange(rec, ym)) continue;
      const due = dateInMonth(ym, rec.day);
      if (isSkipped(state, rec, due)) continue;
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

// Salário: o do mês M cai entre o dia `salaryFrom` (padrão 26) do mês anterior e o dia do previsto (padrão 5) do mês M.
// Ex.: o salário de dezembro cai de 26/11 a 05/12 e vale como "salário de dezembro", mesmo que chegue em novembro.
export const isSalary = (rec) => rec.type === 'in' && rec.cat === 'Salário';
export function payWindow(state, rec, due) {
  if (!isSalary(rec)) return null;
  const from = Math.max(1, Math.min(28, state.config?.salaryFrom ?? 26));
  // dia do salário a partir de salaryFrom (ex.: 28): ele já cai no próprio mês e vale para o mês seguinte
  const mesmoMes = rec.day >= from;
  return { from: dateInMonth(mesmoMes ? monthOf(due) : addMonths(monthOf(due), -1), from), to: addDays(due, 3) };
}
// Mês a que o salário pertence: se cai a partir do dia salaryFrom, é o salário do mês seguinte.
export function salaryComp(state, rec, due) {
  const from = Math.max(1, Math.min(28, state.config?.salaryFrom ?? 26));
  return rec.day >= from ? addMonths(monthOf(due), 1) : monthOf(due);
}
const ruledAs = (state, rec, t) => state.rules.some((r) => r.key === merchantKey(t.desc) && r.cat === rec.cat);

// Recalcula, do zero, qual lançamento do extrato pagou qual previsto. Determinístico.
export function applyMatches(state) {
  for (const t of state.txns) { t.rec = null; t.recDiff = 0; }
  const cov = coverage(state);
  const occ = occurrences(state, state.baseline.date, cov);
  // salário que chega antes do vencimento (ex.: 30/11 para o salário de dezembro)
  for (const o of occurrences(state, cov, addDays(cov, 40))) {
    const w = payWindow(state, o.rec, o.due);
    if (w && w.from <= cov) occ.push(o);
  }
  occ.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  for (const { rec, due } of occ) {
    const key = rec.match ? normDesc(rec.match) : '';
    let best = null;
    for (const t of state.txns) {
      if (t.acct !== 'banco' || t.rec || t.kind === 'transfer' || t.kind === 'cardpay') continue;
      if ((rec.type === 'in') !== (t.amount > 0)) continue;
      const days = Math.abs(diffDays(t.date, due));
      const w = payWindow(state, rec, due);
      if (w ? (t.date < w.from || t.date > w.to) : days > WINDOW) continue;
      const a = Math.abs(t.amount);
      const tol = Math.max(0.5, 0.02 * rec.amount);
      const exact = Math.abs(a - rec.amount) <= tol;
      const kw = key && normDesc(t.desc).includes(key);
      const ratio = a / rec.amount;
      const ruled = w && ruledAs(state, rec, t); // você confirmou este remetente como salário
      if (!exact && !ruled && !(kw && ratio >= 0.3 && ratio <= 3)) continue;
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
    if (!rec.active || rec.card || !inRange(rec, ym)) continue;
    const due = dateInMonth(ym, rec.day);
    if (due <= state.baseline.date) continue; // antes do saldo inicial: já está nele
    const txn = state.txns.find((t) => t.rec === rec.id && t.recDue === due) || null;
    let status;
    if (isSkipped(state, rec, due)) status = 'pulada';
    else if (txn) status = txn.recDiff && !rec.variable ? 'diferente' : 'paga';
    else if (due <= cov) status = 'sem débito';
    else status = 'a vencer';
    items.push({ rec, due, txn, status, planned: rec.amount });
  }
  void today;
  return items.sort((a, b) => (a.due < b.due ? -1 : 1));
}
export { endOfMonth };
