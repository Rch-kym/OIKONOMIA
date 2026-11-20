import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOFX } from '../src/ofx.js';
import { parseCSV } from '../src/csv.js';
import { brNumber, merchantKey, round2 } from '../src/util.js';
import { addManual, confirmGroup, importParsed, moveToAccount, newState, reviewGroups } from '../src/ledger.js';
import { monthItems } from '../src/recurring.js';
import { avulsoRate, bankBalanceAt, fatura, monthView, reconcile } from '../src/summary.js';
import { forecast, podeGastar } from '../src/forecast.js';
import { cardDueFor } from '../src/card.js';

const seed = JSON.parse(readFileSync(new URL('../seed.json', import.meta.url)));
const ofx = readFileSync(new URL('../samples/extrato-exemplo.ofx', import.meta.url), 'latin1');
const csv = readFileSync(new URL('../samples/extrato-exemplo.csv', import.meta.url), 'utf8');
const csvCols = readFileSync(new URL('../samples/extrato-exemplo-colunas.csv', import.meta.url), 'utf8');
const TODAY = '2026-11-19';

const loaded = () => importParsed(newState(seed), parseOFX(ofx), { file: 'extrato.ofx' });

test('números brasileiros', () => {
  assert.equal(brNumber('1.234,56'), 1234.56);
  assert.equal(brNumber('-R$ 50,00'), -50);
  assert.equal(brNumber('50,00-'), -50);
  assert.equal(brNumber('(50,00)'), -50);
  assert.equal(brNumber('1234.56'), 1234.56);
  assert.equal(brNumber('1.234.567'), 1234567);
  assert.equal(brNumber('12,5 D'), -12.5);
  assert.ok(Number.isNaN(brNumber('abc')));
});

test('OFX: lançamentos, sinais e saldo', () => {
  const p = parseOFX(ofx);
  assert.equal(p.txns.length, 24);
  assert.equal(p.balance.amount, 599.7);
  assert.equal(p.balance.date, '2026-11-19');
  assert.equal(p.txns.find((t) => t.desc === 'CREDITO SALARIO').amount, 1497.43);
  assert.equal(p.txns.find((t) => t.desc === 'ACADEMIA FITNESS CLUB').amount, -169.9);
  assert.equal(p.txns[0].date, '2026-10-24');
});

test('CSV estilo BB (valor + C/D, linhas de saldo)', () => {
  const p = parseCSV(csv);
  assert.equal(p.txns.length, 24);
  assert.equal(p.balance.amount, 599.7);
  assert.equal(p.txns.find((t) => t.desc === 'CREDITO SALARIO').amount, 1497.43);
  assert.equal(p.txns.find((t) => t.desc === 'ACADEMIA FITNESS CLUB').amount, -169.9);
});

test('CSV com colunas Entrada/Saída e saldo', () => {
  const p = parseCSV(csvCols);
  assert.equal(p.txns.length, 24);
  assert.equal(p.balance.amount, 599.7);
  assert.equal(p.txns.reduce((s, t) => round2(s + t.amount), 0), 597.29);
});

test('CSV sem cabeçalho e com vírgula', () => {
  const p = parseCSV('05/11/2026,Padaria,"-12,50"\n06/11/2026,Salario,"1.000,00"\n');
  assert.equal(p.txns.length, 2);
  assert.equal(p.txns[0].amount, -12.5);
  assert.equal(p.txns[1].amount, 1000);
});

test('importar OFX: o saldo calculado bate com o do banco', () => {
  const { state, report } = loaded();
  assert.equal(report.added, 24);
  assert.equal(bankBalanceAt(state, '2026-11-19'), 599.7);
  const r = reconcile(state);
  assert.equal(r.status, 'ok');
  assert.equal(r.diff, 0);
});

test('importar de novo ou em outro formato não duplica', () => {
  const a = loaded().state;
  const again = importParsed(a, parseOFX(ofx));
  assert.equal(again.report.added, 0);
  assert.equal(again.report.duplicates, 24);
  const other = importParsed(a, parseCSV(csv));
  assert.equal(other.report.added, 0);
  assert.equal(other.state.txns.length, 24);
});

test('duas compras iguais no mesmo dia continuam sendo duas', () => {
  const { state } = loaded();
  assert.equal(state.txns.filter((t) => t.desc === 'Lanchonete Sabor').length, 2);
});

test('lançamentos até a data do saldo inicial são ignorados', () => {
  const p = { format: 'csv', account: 'banco', txns: [{ date: '2026-10-20', amount: -10, desc: 'Antigo' }, { date: '2026-10-24', amount: -5, desc: 'Novo' }], balance: null };
  const { state, report } = importParsed(newState(seed), p);
  assert.equal(report.before, 1);
  assert.equal(state.txns.length, 1);
});

test('previstos recebem baixa pelo extrato', () => {
  const { state } = loaded();
  const items = monthItems(state, '2026-11', TODAY);
  const by = Object.fromEntries(items.map((i) => [i.rec.desc, i.status]));
  assert.equal(by['Academia'], 'paga');
  assert.equal(by['Tim'], 'paga');
  assert.equal(by['Faculdade Anhanguera'], 'paga');
  assert.equal(by['Ajuda na internet'], 'paga');
  assert.equal(by['Empréstimo BB'], 'paga');
  assert.equal(by['Corte de cabelo (2x/mês)'], 'paga');
  assert.equal(by['Odonto'], 'sem débito');
  const sal = state.txns.find((t) => t.desc === 'CREDITO SALARIO');
  assert.equal(sal.cat, 'Salário');
  assert.equal(sal.status, 'ok');
});

test('transferência própria, fatura e juros entram sem revisão', () => {
  const { state } = loaded();
  const own = state.txns.filter((t) => /Hebert Akym/.test(t.desc));
  assert.ok(own.every((t) => t.kind === 'transfer' && t.status === 'ok'));
  const card = state.txns.find((t) => /CARTAO DE CREDITO/.test(t.desc));
  assert.equal(card.kind, 'cardpay');
  assert.equal(state.txns.find((t) => /Juros/.test(t.desc)).status, 'ok');
});

test('revisão por estabelecimento: confirmar uma vez cria regra para todos', () => {
  let { state } = loaded();
  const g = reviewGroups(state).find((x) => x.key === merchantKey('Supermercado Central'));
  assert.equal(g.count, 3);
  assert.equal(g.guess, 'Alimentação');
  assert.equal(g.total, -146.25);
  state = confirmGroup(state, g.key, 'Alimentação');
  assert.ok(state.txns.filter((t) => /Supermercado/.test(t.desc)).every((t) => t.status === 'ok' && t.cat === 'Alimentação'));
  assert.equal(reviewGroups(state).some((x) => x.key === g.key), false);
  // um próximo extrato com o mesmo lugar já entra categorizado
  const next = importParsed(state, { format: 'csv', account: 'banco', balance: null, txns: [{ date: '2026-11-20', amount: -30, desc: 'Supermercado Central' }] });
  assert.equal(next.report.auto, 1);
  assert.equal(next.report.review, 0);
});

test('divergência: lançamento manual sem par no banco aparece como suspeito', () => {
  const { state } = loaded();
  const m = addManual(state, { date: '2026-11-17', amount: -86.4, desc: 'Farmácia', cat: 'Saúde', acct: 'banco' });
  const r = reconcile(m.state);
  assert.equal(r.status, 'diff');
  assert.equal(r.diff, -86.4);
  assert.equal(r.suspects[0].id, m.txn.id);
  const fixed = moveToAccount(m.state, m.txn.id, 'dinheiro');
  assert.equal(reconcile(fixed).status, 'ok');
});

test('o que você anotou antes é confirmado pelo extrato, sem duplicar', () => {
  let s = newState(seed);
  s = addManual(s, { date: '2026-11-03', amount: -42.3, desc: 'Farmácia', cat: 'Saúde', acct: 'banco' }).state;
  const { state, report } = importParsed(s, parseOFX(ofx));
  assert.equal(report.confirmedManual, 1);
  assert.equal(state.txns.filter((t) => Math.abs(t.amount + 42.3) < 0.001).length, 1);
  assert.equal(reconcile(state).status, 'ok');
});

test('ciclo do cartão: fecha dia 8, vence dia 16', () => {
  assert.equal(cardDueFor('2026-11-16', seed.config), '2026-12-16');
  assert.equal(cardDueFor('2026-11-08', seed.config), '2026-11-16');
  assert.equal(cardDueFor('2026-11-09', seed.config), '2026-12-16');
  assert.equal(cardDueFor('2026-12-20', seed.config), '2027-01-16');
});

test('fatura de dezembro = assinaturas + compras no cartão', () => {
  let { state } = loaded();
  assert.equal(fatura(state, '2026-12-16').totalSubs, 333.13);
  state = addManual(state, { date: '2026-11-18', amount: -212.75, desc: 'Mercado', cat: 'Alimentação', acct: 'cartao' }).state;
  const f = fatura(state, '2026-12-16');
  assert.equal(f.totalCompras, 212.75);
  assert.equal(f.total, 545.88);
});

test('compras no cartão não mexem no saldo do banco', () => {
  const { state } = loaded();
  const m = addManual(state, { date: '2026-11-18', amount: -100, desc: 'Loja', cat: 'Casa', acct: 'cartao' });
  assert.equal(bankBalanceAt(m.state, TODAY), 599.7);
  assert.equal(reconcile(m.state).status, 'ok');
});

test('pode gastar: saldo menos o previsto até o fim do mês', () => {
  const { state } = loaded();
  const p = podeGastar(state, TODAY);
  // saldo 599,70 − dízimo 10% de (1.497,43 + 850,00) = 234,74
  assert.equal(p.balance, 599.7);
  assert.equal(p.committed, 234.74);
  assert.equal(p.value, 364.96);
  assert.equal(p.daysLeft, 12);
  assert.equal(p.perDay, round2(364.96 / 12));
});

test('projeção: conta fecha com as mesmas regras e acha o dia negativo', () => {
  const { state } = loaded();
  const f = forecast(state, TODAY, 60);
  assert.equal(f.series.length, 61);
  assert.equal(f.series[0].date, TODAY);
  const rate = avulsoRate(state);
  assert.ok(rate > 0 && rate < 100);
  // 19/11: só o gasto médio do dia
  assert.equal(f.series[0].balance, 599.7); // hoje já está no extrato
  // 20/11: saldo do banco menos o gasto médio do dia
  assert.equal(f.series[1].balance, round2(599.7 - rate));
});

test('projeção: eventos nos dias certos', () => {
  const { state } = loaded();
  const f = forecast(state, TODAY, 60);
  const day = (d) => f.series.find((s) => s.date === d);
  const labels = (d) => day(d).events.map((e) => e.label);
  assert.ok(labels('2026-11-30').includes('Dízimo (automático)'));
  assert.ok(labels('2026-12-05').includes('Salário líquido'));
  assert.ok(labels('2026-12-04').includes('Academia'));
  assert.ok(labels('2026-12-16').includes('Fatura do cartão'));
  const fat = day('2026-12-16').events.find((e) => e.label === 'Fatura do cartão');
  assert.equal(fat.amount, -333.13);
});

test('projeção: sem entrada de dinheiro o saldo fica negativo e volta com o salário', () => {
  const s = newState(seed);
  s.recurring.find((r) => r.desc === 'Salário líquido').amount = 200; // simula pouca renda
  const { state } = importParsed(s, parseOFX(ofx));
  const f = forecast(state, TODAY, 60);
  assert.ok(f.negativeFrom, 'deveria ficar negativo');
  assert.ok(f.negativeFrom > TODAY);
});

test('visão do mês', () => {
  const { state } = loaded();
  const v = monthView(state, '2026-11', TODAY);
  assert.equal(v.fixos.length, 7);
  assert.equal(v.fixosTotal, 805.82);
  assert.equal(v.fixosAPagar, 67.3);
  assert.equal(v.entradas, 2347.43);
  assert.ok(v.avulsosTotal > 0);
  assert.equal(v.fatura.due, '2026-12-16');
});

test('plano do mês seguinte', async () => {
  const { monthPlan } = await import('../src/summary.js');
  const { state } = loaded();
  const p = monthPlan(state, '2026-12');
  assert.equal(p.totalEntradas, 1497.43);
  assert.equal(p.totalFixos, 805.82);
  assert.equal(p.cartao, 333.13);
  assert.equal(p.dizimo, 149.74);
  assert.equal(p.sobra, round2(p.totalEntradas - p.totalFixos - p.cartao - p.dizimo - p.avulsos));
});
