// Projeção do saldo dia a dia e o número "pode gastar até o fim do mês".
import { avulsoRate, bankBalanceAt, dizimoFor, fatura } from './summary.js';
import { coverage, isSalary, occurrences } from './recurring.js';
import { addDays, addMonths, dateInMonth, diffDays, endOfMonth, monthOf, round2 } from './util.js';

// Salário que cai a partir do dia "salaryFrom" (ex.: 26) é o salário do mês seguinte: não é dinheiro livre deste mês.
function salarioDoProximoMes(state, rec, due, today) {
  return isSalary(rec) && due.slice(0, 7) === monthOf(today) && Number(due.slice(8)) >= (state.config?.salaryFrom ?? 26);
}
function futureEvents(state, fromExclusive, toInclusive, opts = {}) {
  const ev = new Map(); // data -> [{label, amount}]
  const push = (d, label, amount) => { if (!ev.has(d)) ev.set(d, []); ev.get(d).push({ label, amount: round2(amount) }); };

  // previstos de conta corrente que o extrato ainda não trouxe
  for (const { rec, due } of occurrences(state, fromExclusive, toInclusive)) {
    if (state.txns.some((t) => t.rec === rec.id && t.recDue === due)) continue;
    if (rec.type === 'in' && rec.cat === 'Vale Alimentação') continue;
    if (opts.livre && salarioDoProximoMes(state, rec, due, opts.livre)) { opts.livre_skip = (opts.livre_skip || 0) + rec.amount; continue; }
    push(due, rec.desc, rec.type === 'in' ? rec.amount : -rec.amount);
  }
  // gastos/entradas que você anotou na conta e o extrato ainda não trouxe
  for (const t of state.txns) {
    if (t.acct !== 'banco' || !t.manual || t.confirmed || t.date <= fromExclusive || t.date > toInclusive) continue;
    push(t.date, `Anotado: ${t.desc}`, t.amount);
  }
  // dízimo
  for (let ym = monthOf(fromExclusive); ym <= monthOf(toInclusive); ym = addMonths(ym, 1)) {
    const dz = dizimoFor(state, ym);
    // "pode gastar": o dízimo do salário do mês seguinte fica para as contas de lá
    const amt = dz && opts.livre ? Math.max(0, round2(dz.amount - dz.pct * ((opts.livre_skip || 0) + (opts.reservado || 0)))) : dz?.amount;
    if (dz && !dz.paid && amt > 0 && dz.due > fromExclusive && dz.due <= toInclusive) push(dz.due, 'Dízimo (automático)', -amt);
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
  // simulações ("e se eu gastar/receber X"): só entram na projeção, nunca no saldo nem na conferência
  if (!opts.noSims) {
    for (const sm of state.sims || []) {
      const d = sm.date > fromExclusive ? sm.date : addDays(fromExclusive, 1);
      if (d <= toInclusive) push(d, `Simulação: ${sm.label}`, sm.amount);
    }
  }
  return ev;
}

export function forecast(state, today, days = 60, opts = {}) {
  const cov = coverage(state);
  const start = cov < today ? cov : today;
  const end = addDays(today, days);
  const rate = avulsoRate(state);
  const ev = futureEvents(state, cov, end, opts);
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
export function podeGastar(state, today, opts = {}) {
  const cov = coverage(state);
  const eom = endOfMonth(monthOf(today));
  const bal = bankBalanceAt(state, cov);
  // salário do mês seguinte que já caiu na conta: está no saldo, mas já tem dono (as contas do próximo mês)
  let reservado = 0;
  for (const t of state.txns) {
    if (t.acct !== 'banco' || !t.rec || t.date.slice(0, 7) !== monthOf(today) || t.date > cov) continue;
    const rec = state.recurring.find((r) => r.id === t.rec);
    if (rec && salarioDoProximoMes(state, rec, t.date, today)) reservado += t.amount;
  }
  reservado = round2(reservado);
  const o = { ...opts, livre: today, reservado };
  const ev = futureEvents(state, cov, eom, o);
  let net = 0;
  for (const list of ev.values()) for (const e of list) net += e.amount;
  const itens = [...ev.entries()].flatMap(([d, l]) => l.map((e) => ({ date: d, ...e }))).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const value = round2(bal - reservado + net);
  const left = Math.max(1, diffDays(eom, today) + 1);
  return { value, perDay: round2(value / left), daysLeft: left, balance: bal, committed: round2(-net), reservado, itens };
}
