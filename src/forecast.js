// Projeção do saldo dia a dia e o número "pode gastar até o fim do mês".
import { avulsoRate, bankBalanceAt, dizimoFor, fatura } from './summary.js';
import { coverage, occurrences } from './recurring.js';
import { addDays, addMonths, dateInMonth, diffDays, endOfMonth, monthOf, round2 } from './util.js';

function futureEvents(state, fromExclusive, toInclusive) {
  const ev = new Map(); // data -> [{label, amount}]
  const push = (d, label, amount) => { if (!ev.has(d)) ev.set(d, []); ev.get(d).push({ label, amount: round2(amount) }); };

  // previstos de conta corrente que o extrato ainda não trouxe
  for (const { rec, due } of occurrences(state, fromExclusive, toInclusive)) {
    if (state.txns.some((t) => t.rec === rec.id && t.recDue === due)) continue;
    if (rec.type === 'in' && rec.cat === 'Vale Alimentação') continue;
    push(due, rec.desc, rec.type === 'in' ? rec.amount : -rec.amount);
  }
  // dízimo
  for (let ym = monthOf(fromExclusive); ym <= monthOf(toInclusive); ym = addMonths(ym, 1)) {
    const dz = dizimoFor(state, ym);
    if (dz && !dz.paid && dz.amount > 0 && dz.due > fromExclusive && dz.due <= toInclusive) push(dz.due, 'Dízimo (automático)', -dz.amount);
  }
  // faturas do cartão
  const due = state.config.cardDueDay ?? 16;
  for (let ym = monthOf(fromExclusive); ym <= monthOf(toInclusive); ym = addMonths(ym, 1)) {
    const d = dateInMonth(ym, due);
    if (d > fromExclusive && d <= toInclusive) {
      const f = fatura(state, d);
      const paga = f.pago > 0;
      if (!paga && f.total > 0) push(d, 'Fatura do cartão', -f.total);
    }
  }
  return ev;
}

export function forecast(state, today, days = 60) {
  const cov = coverage(state);
  const start = cov < today ? cov : today;
  const end = addDays(today, days);
  const rate = avulsoRate(state);
  const ev = futureEvents(state, cov, end);
  let bal = bankBalanceAt(state, cov);
  const series = [];
  if (cov >= today) series.push({ date: cov, balance: bal, events: [] });
  for (let d = addDays(cov, 1); d <= end; d = addDays(d, 1)) {
    const events = ev.get(d) || [];
    for (const e of events) bal = round2(bal + e.amount);
    bal = round2(bal - rate);
    if (d >= today) series.push({ date: d, balance: bal, events });
  }
  const neg = series.find((s) => s.balance < 0) || null;
  const min = series.reduce((m, s) => (s.balance < m.balance ? s : m), series[0]);
  const back = neg ? series.find((s) => s.date > min.date && s.balance >= 0) || null : null;
  return { series, start, rate, negativeFrom: neg?.date || null, backPositive: back?.date || null, min };
}

// Pode gastar = saldo atual + o que entra − o que está previsto sair até o fim do mês.
export function podeGastar(state, today) {
  const cov = coverage(state);
  const eom = endOfMonth(monthOf(today));
  const bal = bankBalanceAt(state, cov);
  const ev = futureEvents(state, cov, eom);
  let net = 0;
  for (const list of ev.values()) for (const e of list) net += e.amount;
  const value = round2(bal + net);
  const left = Math.max(1, diffDays(eom, today) + 1);
  return { value, perDay: round2(value / left), daysLeft: left, balance: bal, committed: round2(-net) };
}
