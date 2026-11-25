// Números das telas: saldo, conferência com o banco, mês (fixos/avulsos/cartão) e "pode gastar".
import { cardDueFor } from './card.js';
import { coverage, inRange, monthItems, occurrences } from './recurring.js';
import { addMonths, dateInMonth, daysInMonth, diffDays, endOfMonth, monthOf, round2 } from './util.js';

export function bankBalanceAt(state, dateISO) {
  let s = state.baseline.balance;
  for (const t of state.txns) if (t.acct === 'banco' && t.date <= dateISO) s += t.amount;
  return round2(s);
}
export const currentBalance = (state) => bankBalanceAt(state, coverage(state));

// Compara o saldo calculado com o saldo que o banco informou.
export function reconcile(state) {
  if (!state.bank) return { status: 'sem-saldo', expected: currentBalance(state), bank: null, diff: 0, suspects: [] };
  const expected = bankBalanceAt(state, state.bank.date);
  const diff = round2(expected - state.bank.amount);
  if (diff === 0) return { status: 'ok', expected, bank: state.bank, diff: 0, suspects: [] };
  const suspects = state.txns.filter((t) => t.acct === 'banco' && t.date <= state.bank.date && Math.abs(Math.abs(t.amount) - Math.abs(diff)) < 0.005 && (t.manual || t.date >= addDaysISO(state.bank.date, -45)));
  return { status: 'diff', expected, bank: state.bank, diff, suspects: suspects.sort((a, b) => (b.manual ? 1 : 0) - (a.manual ? 1 : 0)) };
}
function addDaysISO(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

export function avulsoRate(state) {
  // gasto médio diário de verdade (últimos 30 dias de dados); sem histórico suficiente, usa a previsão da planilha.
  const cov = coverage(state);
  const from = addDaysISO(cov, -29);
  const startData = state.baseline.date;
  const span = Math.min(30, diffDays(cov, startData));
  const monthly = state.config.avulsosMensal ?? 400;
  if (span < 20) return round2(monthly / 30);
  let sum = 0;
  for (const t of state.txns) {
    if (t.acct !== 'banco' || t.kind !== 'out' || t.rec || t.date < from || t.date > cov) continue;
    sum += -t.amount;
  }
  return round2(sum / span);
}

// Fatura que vence em dueISO: assinaturas (recorrentes no cartão) + compras no cartão.
export function fatura(state, dueISO) {
  const subs = [];
  let ym = addMonths(monthOf(dueISO), -2);
  for (let i = 0; i < 4; i++, ym = addMonths(ym, 1)) {
    for (const rec of state.recurring) {
      if (!rec.active || !rec.card || !inRange(rec, ym)) continue;
      const d = dateInMonth(ym, rec.day);
      if (cardDueFor(d, state.config) === dueISO) subs.push({ desc: rec.desc, amount: rec.amount, date: d });
    }
  }
  const compras = state.txns.filter((t) => t.acct === 'cartao' && t.amount < 0 && cardDueFor(t.date, state.config) === dueISO);
  const sSubs = round2(subs.reduce((s, x) => s + x.amount, 0));
  const sCompras = round2(compras.reduce((s, t) => s - t.amount, 0));
  const pago = state.txns.filter((t) => t.acct === 'banco' && t.kind === 'cardpay' && Math.abs(diffDays(t.date, dueISO)) <= 6).reduce((s, t) => s - t.amount, 0);
  const manual = state.faturas && state.faturas[dueISO] != null ? Number(state.faturas[dueISO]) : null;
  return { due: dueISO, subs, compras, totalSubs: sSubs, totalCompras: sCompras, estimado: round2(sSubs + sCompras), manual, total: manual != null ? round2(manual) : round2(sSubs + sCompras), pago: round2(pago) };
}
export function nextFaturaDue(state, fromISO) {
  let d = dateInMonth(monthOf(fromISO), state.config.cardDueDay ?? 16);
  if (d < fromISO) d = dateInMonth(addMonths(monthOf(fromISO), 1), state.config.cardDueDay ?? 16);
  return d;
}

export function dizimoFor(state, ym) {
  if (!state.config.dizimoAuto) return null;
  const due = endOfMonth(ym);
  let income = 0;
  for (const t of state.txns) if (t.acct === 'banco' && t.kind === 'in' && t.date.startsWith(ym) && t.cat !== 'Transferências e repasses') income += t.amount;
  const cov = coverage(state);
  for (const { rec, due: d } of occurrences(state, addMonths(ym, -0) + '-00', due)) {
    if (rec.type === 'in' && d > cov && !state.txns.some((t) => t.rec === rec.id && t.recDue === d) && rec.cat !== 'Vale Alimentação') income += rec.amount;
  }
  const paid = state.txns.find((t) => t.acct === 'banco' && t.amount < 0 && t.date.startsWith(ym) && /dizimo|oferta/.test(t.desc.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')));
  return { due, amount: round2(income * (state.config.dizimoPct ?? 0.1)), paid: !!paid };
}

export function monthView(state, ym, today) {
  const cov = coverage(state);
  const all = monthItems(state, ym, today);
  const fixos = all.filter((i) => i.rec.type === 'out');
  const entradasPrevistas = all.filter((i) => i.rec.type === 'in' && i.rec.cat !== 'Vale Alimentação');
  const avulsos = {};
  let avulsosTotal = 0;
  for (const t of state.txns) {
    if (t.acct !== 'banco' || !t.date.startsWith(ym) || t.kind !== 'out' || t.rec) continue;
    const c = t.cat || 'Sem categoria';
    avulsos[c] = round2((avulsos[c] || 0) - t.amount);
    avulsosTotal = round2(avulsosTotal - t.amount);
  }
  const entradas = state.txns.filter((t) => t.acct === 'banco' && t.date.startsWith(ym) && t.kind === 'in' && t.cat !== 'Transferências e repasses').reduce((s, t) => s + t.amount, 0);
  const dueISO = nextFaturaDue(state, today);
  return {
    ym, cov,
    fixos, entradasPrevistas,
    fixosTotal: round2(fixos.filter((i) => i.status !== 'pulada').reduce((s, i) => s + i.planned, 0)),
    fixosAPagar: round2(fixos.filter((i) => i.status !== 'paga' && i.status !== 'diferente' && i.status !== 'pulada').reduce((s, i) => s + i.planned, 0)),
    avulsos, avulsosTotal, avulsosPrevisto: state.config.avulsosMensal ?? 400,
    entradas: round2(entradas),
    fatura: fatura(state, dueISO),
    dizimo: dizimoFor(state, ym),
  };
}
export { daysInMonth };

// Como o mês (normalmente o próximo) deve fechar: entradas, fixos, cartão, dízimo e avulsos esperados.
export function monthPlan(state, ym) {
  const entradas = state.recurring.filter((r) => r.active && inRange(r, ym) && r.type === 'in' && r.cat !== 'Vale Alimentação').map((r) => ({ label: r.desc, amount: r.amount }));
  const fixos = state.recurring.filter((r) => r.active && inRange(r, ym) && r.type === 'out' && !r.card).map((r) => ({ label: r.desc, amount: r.amount }));
  const dueISO = dateInMonth(ym, state.config.cardDueDay ?? 16);
  const f = fatura(state, dueISO);
  const dz = dizimoFor(state, ym);
  const [y, m] = ym.split('-').map(Number);
  const avulsos = round2(avulsoRate(state) * daysInMonth(y, m));
  const sum = (a) => round2(a.reduce((s, x) => s + x.amount, 0));
  const totalEntradas = sum(entradas);
  const totalFixos = sum(fixos);
  const dizimo = dz ? dz.amount : 0;
  return { ym, entradas, fixos, totalEntradas, totalFixos, cartao: f.total, cartaoDue: dueISO, dizimo, avulsos, sobra: round2(totalEntradas - totalFixos - f.total - dizimo - avulsos) };
}
