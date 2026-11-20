import { parseOFX, looksLikeOFX } from './src/ofx.js';
import { parseCSV } from './src/csv.js';
import { CATS_IN, CATS_OUT } from './src/rules.js';
import { addManual, confirmGroup, importParsed, moveToAccount, newState, removeTxn, reviewGroups, updateTxn } from './src/ledger.js';
import { currentBalance, monthPlan, monthView, nextFaturaDue, reconcile } from './src/summary.js';
import { forecast, podeGastar } from './src/forecast.js';
import { coverage } from './src/recurring.js';
import { pullState, pushState } from './src/sheets.js';
import { MESES, addMonths, brl, ddmm, isoDate, monthOf, round2 } from './src/util.js';

const KEY = 'conc-state-v1';
const CFG_KEY = 'conc-sheets-v1';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new URLSearchParams(location.search).get('hoje') || isoDate(new Date());
const ACCT = { banco: 'Conta', cartao: 'Cartão', dinheiro: 'Dinheiro' };

let state = null;
let view = location.hash.replace('#/', '') || 'inicio';
let monthYM = null;
let modal = null; // { type, ... }
let filter = 'todos';
const picked = {}; // categoria escolhida por grupo de revisão

const $app = document.getElementById('app');

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* sem armazenamento */ } }
function commit(next, msg) { state = next; persist(); if (msg) toast(msg); render(); }
const sheetsCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch { return {}; } };

async function readFileText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
function parseAny(text) { return looksLikeOFX(text) ? parseOFX(text) : parseCSV(text); }

async function importText(text, name, asCard) {
  try {
    const parsed = parseAny(text);
    if (!parsed.txns.length) throw new Error('Não encontrei lançamentos neste arquivo.');
    if (asCard) parsed.account = 'cartao';
    const { state: next, report } = importParsed(state, parsed, { file: name });
    state = next; persist();
    modal = { type: 'import', report };
    view = 'inicio'; render();
  } catch (e) {
    modal = { type: 'erro', msg: e.message };
    render();
  }
}

/* ---------- peças de tela ---------- */
const check = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const bang = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5v5.5M8 12v.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';

function banner(rec, compact = false) {
  if (rec.status === 'ok') {
    return `<div class="banner ok"><div class="title"><span class="dot">${check}</span>Conciliado: a planilha bate com o banco</div>
      <div class="bigs"><div><div class="small mute">Saldo calculado</div><div class="n num">${brl(rec.expected)}</div></div>
      <div><div class="small mute">Saldo no extrato (${ddmm(rec.bank.date)})</div><div class="n num">${brl(rec.bank.amount)}</div></div></div>
      ${compact ? '' : '<div class="small mute">Diferença: <strong class="pos">R$ 0,00</strong></div>'}</div>`;
  }
  if (rec.status === 'diff') {
    const s = rec.suspects[0];
    const more = rec.diff > 0 ? 'a mais' : 'a menos';
    let sug = '<div class="small">Não achei um lançamento com esse valor. Confira as saídas e entradas do período.</div>';
    if (s) {
      sug = `<div class="card" style="background:var(--card)"><div class="small mute">${ddmm(s.date)} · ${esc(ACCT[s.acct])}${s.manual ? ' · lançado por você' : ''}</div>
        <div style="font-weight:600;margin:2px 0 4px">${esc(s.desc)} — ${brl(Math.abs(s.amount))}</div>
        <div class="small mute">O valor é igual à diferença${s.manual ? '. Nenhuma saída igual apareceu no extrato do banco.' : '.'}</div>
        <div class="row" style="margin-top:10px">
        ${s.manual ? `<button class="btn primary sm" data-act="to-cash" data-id="${s.id}">Foi em dinheiro: mover para Dinheiro</button>` : ''}
        <button class="btn sm danger" data-act="del" data-id="${s.id}">${s.manual ? 'Foi engano: apagar' : 'Apagar este lançamento'}</button></div></div>`;
    }
    return `<div class="banner diff"><div class="title"><span class="dot">${bang}</span>Não bate: a planilha tem ${brl(Math.abs(rec.diff))} ${more} que o banco</div>
      <div class="small">Calculado ${brl(rec.expected)} · Extrato ${brl(rec.bank.amount)} (${ddmm(rec.bank.date)})</div>
      <div class="bigs"><div class="n num pos" style="color:var(--red-d)">${brl(-rec.diff)}</div></div>
      <div style="font-weight:600">Achei ${rec.suspects.length ? 'um lançamento que pode explicar' : 'nada que explique'} a diferença</div>${sug}</div>`;
  }
  return `<div class="banner none"><div class="title">Sem saldo do banco para conferir</div>
    <div class="bigs"><div><div class="small mute">Saldo calculado</div><div class="n num">${brl(rec.expected)}</div></div></div>
    <div class="small mute">Importe um extrato que traga o saldo, ou informe o saldo em Ajustes.</div></div>`;
}

function chart(fc) {
  const W = 760, H = 210, L = 46, R = 10, T = 10, B = 26;
  const vals = fc.series.map((s) => s.balance);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals) * 1.08 || 1;
  const n = fc.series.length;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, n - 1);
  const y = (v) => T + ((max - v) * (H - T - B)) / (max - min || 1);
  const pts = fc.series.map((s, i) => `${x(i).toFixed(1)},${y(s.balance).toFixed(1)}`).join(' ');
  const ticks = [0, 15, 30, 45, 60].filter((i) => i < n);
  const nf = fc.negativeFrom ? fc.series.findIndex((s) => s.date === fc.negativeFrom) : -1;
  const label = (v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10} mil`.replace('.', ',') : String(Math.round(v)));
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Saldo projetado para os próximos ${n - 1} dias. ${fc.negativeFrom ? `Fica negativo em ${ddmm(fc.negativeFrom)}.` : 'Não fica negativo.'}">
    ${min < 0 ? `<rect x="${L}" y="${y(0)}" width="${W - L - R}" height="${H - B - y(0)}" fill="var(--red-bg)"/>` : ''}
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--mute)" stroke-dasharray="4 4"/>
    <text x="${L - 6}" y="${y(0) + 4}" text-anchor="end" font-size="12" fill="var(--mute)">0</text>
    <text x="${L - 6}" y="${T + 10}" text-anchor="end" font-size="12" fill="var(--mute)">${label(max)}</text>
    ${min < 0 ? `<text x="${L - 6}" y="${y(min) + 4}" text-anchor="end" font-size="12" fill="var(--mute)">${label(min)}</text>` : ''}
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"/>
    ${nf >= 0 ? `<circle cx="${x(nf)}" cy="${y(fc.series[nf].balance)}" r="6" fill="var(--red)" stroke="var(--card)" stroke-width="2"/>` : ''}
    ${ticks.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" font-size="12" fill="var(--mute)">${ddmm(fc.series[i].date)}</text>`).join('')}
  </svg>`;
}

/* ---------- telas ---------- */
function inicio() {
  const t = today();
  const rec = reconcile(state);
  const pg = podeGastar(state, t);
  const fc = forecast(state, t, 60);
  const ym = addMonths(monthOf(t), 1);
  const mp = monthPlan(state, ym);
  const groups = reviewGroups(state);
  const last = state.imports[state.imports.length - 1];
  const next7 = fc.series.filter((s) => s.date > t && s.date <= isoDate(new Date(new Date(t + 'T12:00:00').getTime() + 7 * 86400000))).flatMap((s) => s.events.map((e) => ({ date: s.date, ...e })));
  let alert = '';
  if (fc.negativeFrom) {
    alert = `<div class="alert"><strong>Atenção em ${ddmm(fc.negativeFrom)}:</strong> o saldo projetado fica negativo (pior dia ${ddmm(fc.min.date)}, ${brl(fc.min.balance)}).${fc.backPositive ? ` Volta ao positivo em ${ddmm(fc.backPositive)}.` : ' Não volta ao positivo nos próximos 60 dias.'}</div>`;
  } else {
    alert = `<div class="alert" style="background:var(--green-bg);border-color:var(--green-line);color:var(--green-d)">Sem saldo negativo nos próximos 60 dias. Menor saldo previsto: ${brl(fc.min.balance)} em ${ddmm(fc.min.date)}.</div>`;
  }
  return `
  <div class="pagehead"><div><div class="small mute">${t.slice(8, 10)} de ${MESES[Number(t.slice(5, 7)) - 1]} de ${t.slice(0, 4)}</div><h1>Início</h1></div>
    <button class="btn primary" data-act="pick-file">Importar extrato</button></div>
  <div class="grid gtop" style="margin-bottom:16px">
    ${banner(rec)}
    <div class="card kpi"><div class="label">Última importação</div>
      <div class="value" style="font-size:20px">${last ? esc(new Date(last.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(', ', ' ').replace(',', '')) : 'Nenhuma ainda'}</div>
      <div class="sub">${last ? `${last.added} lançamentos novos` : 'Importe o extrato do banco'}${groups.length ? `<br><strong style="color:var(--amber-d)">${groups.length} esperando você</strong>` : ''}</div>
      ${groups.length ? `<button class="btn sm" style="margin-top:10px" data-view="revisar">Revisar agora</button>` : ''}</div>
    <div class="card kpi"><div class="label">Pode gastar até o fim do mês</div>
      <div class="value num ${pg.value < 0 ? 'neg' : ''}">${brl(pg.value)}</div>
      <div class="sub">${pg.value >= 0 ? `cerca de ${brl(pg.perDay)} por dia` : 'o previsto passa do saldo'} · saldo ${brl(pg.balance)}, previsto sair ${brl(pg.committed)}</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><div class="between"><h2>Saldo projetado, próximos 60 dias</h2><span class="small mute">fixos + cartão + gasto médio de ${brl(fc.rate)}/dia</span></div>
      <div style="margin:8px 0">${chart(fc)}</div>${alert}</div>
    <div class="card"><h2>${MESES[Number(ym.slice(5)) - 1][0].toUpperCase() + MESES[Number(ym.slice(5)) - 1].slice(1)}, como vai ficar</h2>
      <div style="margin-top:10px">
      <div class="line"><span>Entradas previstas</span><strong class="num">${brl(mp.totalEntradas)}</strong></div>
      <div class="line"><span>Contas fixas</span><strong class="num neg">${brl(-mp.totalFixos)}</strong></div>
      <div class="line"><span>Fatura do cartão (${ddmm(mp.cartaoDue)})</span><strong class="num neg">${brl(-mp.cartao)}</strong></div>
      <div class="line"><span>Dízimo</span><strong class="num neg">${brl(-mp.dizimo)}</strong></div>
      <div class="line"><span>Gastos do dia a dia (média)</span><strong class="num neg">${brl(-mp.avulsos)}</strong></div>
      <div class="line"><strong>Sobra prevista</strong><strong class="num ${mp.sobra < 0 ? 'neg' : 'pos'}">${brl(mp.sobra)}</strong></div></div>
      ${next7.length ? `<div class="sep"></div><div class="small mute" style="margin-bottom:4px">Próximos 7 dias</div>${next7.map((e) => `<div class="line"><span>${ddmm(e.date)} · ${esc(e.label)}</span><strong class="num ${e.amount < 0 ? 'neg' : 'pos'}">${brl(e.amount)}</strong></div>`).join('')}` : ''}
    </div>
  </div>`;
}

const catsFor = (kind) => (kind === 'in' ? CATS_IN : CATS_OUT);
function revisar() {
  const groups = reviewGroups(state);
  const head = `<div class="pagehead"><div><div class="small mute">${groups.length ? 'Confirme uma vez; o app lembra nas próximas' : 'Nada pendente'}</div><h1>Revisar${groups.length ? ` (${groups.length})` : ''}</h1></div></div>`;
  if (!groups.length) return head + '<div class="card empty">Tudo revisado. Os próximos extratos entram sozinhos com as regras que você já confirmou.</div>';
  return head + `<div class="grid" style="gap:14px">${groups.map((g) => {
    const quick = [...new Set([g.guess, ...(g.kind === 'in' ? ['Freelance', 'Salário', 'Rendimentos', 'Outros'] : ['Alimentação', 'Transporte', 'Saúde', 'Lazer', 'Outros'])].filter(Boolean))].slice(0, 5);
    const sel = picked[g.key] ?? g.guess ?? '';
    return `<div class="card rv">
      <div class="between"><div><div class="small mute">${g.count > 1 ? `${g.count} lançamentos · ${ddmm(g.firstDate)} a ${ddmm(g.lastDate)}` : `${ddmm(g.firstDate)} · ${esc(ACCT[g.acct])}`}</div><h3>${esc(g.desc)}</h3></div>
        <strong class="num ${g.total < 0 ? 'neg' : 'pos'}" style="font-size:20px">${brl(g.total)}</strong></div>
      <div class="small mute">${g.guess ? 'Palpite: ' + esc(g.guess) + '. Toque em Confirmar ou escolha outra.' : 'Escolha a categoria.'}</div>
      <div class="chips">${quick.map((c) => `<button class="chip" aria-pressed="${sel === c}" data-act="pick-cat" data-key="${esc(g.key)}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        <select class="field" style="width:auto;min-width:130px" aria-label="Outra categoria" data-sel-key="${esc(g.key)}"><option value="">Outra…</option>${catsFor(g.kind).filter((c) => !quick.includes(c)).map((c) => `<option ${sel === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="row"><button class="btn primary" ${sel ? '' : 'disabled'} data-act="confirm" data-key="${esc(g.key)}">Confirmar e lembrar</button>
      <span class="small mute">Da próxima vez, "${esc(g.desc)}" entra direto${sel ? ' em ' + esc(sel) : ''}.</span></div></div>`;
  }).join('')}</div>`;
}

function statusPill(i) {
  if (i.status === 'paga') return '<span class="pill ok">paga</span>';
  if (i.status === 'diferente') return `<span class="pill info">paga, ${i.txn.recDiff > 0 ? '+' : '−'}${brl(Math.abs(i.txn.recDiff)).replace('− ', '')}</span>`;
  if (i.status === 'sem débito') return '<span class="pill warn">sem débito</span>';
  return '<span class="pill" style="background:var(--line2);color:var(--mute)">a vencer</span>';
}
function mes() {
  const t = today();
  const ym = monthYM || monthOf(t);
  const v = monthView(state, ym, t);
  const f = v.fatura;
  const nm = MESES[Number(ym.slice(5)) - 1];
  const cats = Object.entries(v.avulsos).sort((a, b) => b[1] - a[1]);
  const prev = v.avulsosPrevisto;
  return `
  <div class="pagehead"><div><div class="small mute">Para onde vai o dinheiro</div><h1>${nm[0].toUpperCase() + nm.slice(1)} de ${ym.slice(0, 4)}</h1></div>
    <div class="row"><button class="btn sm" data-act="month" data-d="-1" aria-label="Mês anterior">‹</button><button class="btn sm" data-act="month" data-d="1" aria-label="Próximo mês">›</button></div></div>
  <div class="grid g3">
    <div class="card"><div class="between"><h2>1 · Fixos</h2><span class="small mute">aba Recorrentes</span></div>
      <div class="small mute" style="margin:4px 0 8px">O débito no extrato dá baixa sozinho.</div>
      ${v.fixos.length ? v.fixos.map((i) => `<div class="line"><span>${i.due.slice(8)} · ${esc(i.rec.desc)}</span><span class="row" style="gap:8px;flex-wrap:nowrap"><strong class="num">${brl(i.planned)}</strong>${statusPill(i)}</span></div>`).join('') : '<div class="empty">Nenhum fixo neste mês depois do saldo inicial.</div>'}
      <div class="sep"></div><div class="between"><strong>Total do mês</strong><strong class="num">${brl(v.fixosTotal)}</strong></div>
      ${v.fixosAPagar > 0 ? `<div class="small mute" style="margin-top:4px">Ainda sem baixa: ${brl(v.fixosAPagar)}</div>` : ''}</div>
    <div class="card"><div class="between"><h2>2 · Avulsos</h2><span class="small mute">vêm do extrato</span></div>
      <div class="small mute" style="margin:4px 0 8px">Não precisam de cadastro. Previsto na planilha: ${brl(prev)}/mês.</div>
      ${cats.length ? cats.map(([c, a]) => `<div style="margin-bottom:12px"><div class="between"><span>${esc(c)}</span><strong class="num">${brl(a)}</strong></div><div class="bar"><i class="${a > prev ? 'over' : ''}" style="width:${Math.min(100, (a / prev) * 100).toFixed(0)}%"></i></div></div>`).join('') : '<div class="empty">Sem gastos avulsos neste mês.</div>'}
      <div class="sep"></div><div class="between"><strong>Até agora</strong><strong class="num">${brl(v.avulsosTotal)} de ${brl(prev)}</strong></div></div>
    <div class="card"><div class="between"><h2>3 · Cartão</h2><span class="small mute">vence ${ddmm(f.due)}</span></div>
      <div class="small mute" style="margin:4px 0 8px">Só pesa no banco no dia do pagamento.</div>
      <div class="line"><span>Assinaturas (${f.subs.length})</span><strong class="num">${brl(f.totalSubs)}</strong></div>
      ${f.subs.length ? `<div class="tiny mute" style="margin:-4px 0 6px">${f.subs.map((s) => esc(s.desc)).join(', ')}</div>` : ''}
      <div class="line"><span>Compras no cartão (${f.compras.length})</span><strong class="num">${brl(f.totalCompras)}</strong></div>
      ${f.pago ? `<div class="alert" style="margin-top:8px;background:var(--green-bg);border-color:var(--green-line);color:var(--green-d)">Pagamento encontrado no extrato: ${brl(f.pago)}</div>` : ''}
      <div class="sep"></div><div class="between"><strong>Fatura</strong><strong class="num">${brl(f.total)}</strong></div></div>
  </div>
  <div class="card" style="margin-top:16px;font-size:14px;color:var(--ink2)"><strong style="color:var(--ink)">Como as três se somam:</strong> o saldo do banco cai quando fixos e avulsos são debitados, e uma vez só, em ${ddmm(f.due)}, quando o cartão é pago. O "pagamento da fatura" no extrato não conta como gasto novo.
    ${v.dizimo ? `<br>Dízimo automático de ${ddmm(v.dizimo.due)}: ${brl(v.dizimo.amount)}${v.dizimo.paid ? ' (já pago)' : ''}.` : ''}</div>`;
}

function lancamentos() {
  const list = state.txns.filter((t) => (filter === 'todos' ? true : filter === 'revisar' ? t.status === 'review' : t.acct === filter)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)).slice(0, 300);
  const chips = [['todos', 'Todos'], ['revisar', 'Revisar'], ['banco', 'Conta'], ['cartao', 'Cartão'], ['dinheiro', 'Dinheiro']];
  return `<div class="pagehead"><div><div class="small mute">${state.txns.length} no total</div><h1>Lançamentos</h1></div></div>
  <div class="chips" style="margin-bottom:14px">${chips.map(([k, l]) => `<button class="chip" aria-pressed="${filter === k}" data-act="filter" data-f="${k}">${l}</button>`).join('')}</div>
  <div class="card tight">${list.length ? list.map((t) => `<button class="line" style="width:100%;background:none;border:0;border-bottom:1px solid var(--line2);text-align:left;cursor:pointer" data-act="edit" data-id="${t.id}">
    <span style="min-width:0"><span class="small mute">${ddmm(t.date)} · ${esc(ACCT[t.acct])}${t.rec ? ' · previsto' : ''}</span><br><span style="font-weight:600">${esc(t.desc)}</span><br>${t.status === 'review' ? '<span class="pill warn">revisar</span>' : `<span class="small mute">${esc(t.cat || '')}</span>`}</span>
    <strong class="num ${t.amount < 0 ? 'neg' : 'pos'}" style="white-space:nowrap">${brl(t.amount)}</strong></button>`).join('') : '<div class="empty">Nada por aqui. Importe um extrato para começar.</div>'}</div>`;
}

function ajustes() {
  const c = state.config; const s = sheetsCfg();
  return `<div class="pagehead"><div><div class="small mute">Importar, conferir e configurar</div><h1>Ajustes</h1></div></div>
  <div class="grid g2" style="align-items:start">
  <div class="grid">
    <div class="card"><h2>Importar extrato</h2><p class="small mute">Arquivo OFX ou CSV do banco. Pelo celular, também dá para compartilhar o arquivo direto para este app.</p>
      <label class="small row" style="margin:6px 0"><input type="checkbox" id="asCard"> É a fatura do cartão</label>
      <button class="btn primary" data-act="pick-file">Escolher arquivo</button></div>
    <div class="card"><h2>Saldo do banco</h2><p class="small mute">Sem arquivo? Digite o saldo que o app do banco mostra agora, para conferir.</p>
      <label class="lab" for="bk">Saldo atual no banco (R$)</label><input class="field" id="bk" inputmode="decimal" placeholder="ex.: 599,70">
      <div class="row" style="margin-top:10px"><button class="btn" data-act="set-bank">Conferir</button></div></div>
    <div class="card"><h2>Configurações</h2>
      <label class="lab" for="cc">Fecha a fatura no dia</label><input class="field" id="cc" type="number" min="1" max="28" value="${c.cardCloseDay}">
      <label class="lab" for="cd">Vence no dia</label><input class="field" id="cd" type="number" min="1" max="28" value="${c.cardDueDay}">
      <label class="lab" for="av">Gastos do dia a dia previstos por mês (R$)</label><input class="field" id="av" inputmode="decimal" value="${String(c.avulsosMensal).replace('.', ',')}">
      <label class="lab" for="dz">Dízimo (% das entradas, 0 para desligar)</label><input class="field" id="dz" inputmode="decimal" value="${c.dizimoAuto ? String(round2(c.dizimoPct * 100)).replace('.', ',') : '0'}">
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="save-cfg">Salvar</button></div></div>
  </div>
  <div class="grid">
    <div class="card"><h2>Planilha do Google</h2><p class="small mute">Opcional. Guarda uma cópia legível na planilha e permite abrir em outro aparelho.</p>
      <label class="lab" for="su">Endereço do Apps Script</label><input class="field" id="su" value="${esc(s.url || '')}" placeholder="https://script.google.com/macros/s/…/exec">
      <label class="lab" for="st">Senha (token)</label><input class="field" id="st" type="password" value="${esc(s.token || '')}">
      <div class="row" style="margin-top:12px"><button class="btn" data-act="sheet-push">Enviar para a planilha</button><button class="btn" data-act="sheet-pull">Baixar da planilha</button></div></div>
    <div class="card"><h2>Previstos (fixos e entradas)</h2><p class="small mute">Vêm da sua aba Recorrentes. Desligue o que acabou.</p>
      ${state.recurring.map((r) => `<div class="line"><label class="row" style="gap:8px;flex-wrap:nowrap"><input type="checkbox" data-act="toggle-rec" data-id="${r.id}" ${r.active ? 'checked' : ''}> <span>${r.day < 10 ? '0' : ''}${r.day} · ${esc(r.desc)}${r.card ? ' (cartão)' : ''}</span></label><strong class="num ${r.type === 'in' ? 'pos' : ''}">${brl(r.amount)}</strong></div>`).join('')}</div>
    <div class="card"><h2>Cópia de segurança</h2><div class="row" style="margin-top:8px"><button class="btn" data-act="export">Baixar cópia</button><button class="btn" data-act="pick-backup">Restaurar cópia</button><button class="btn danger" data-act="reset">Apagar tudo</button></div></div>
  </div></div>
  <input type="file" id="bfile" accept=".json,application/json" hidden>`;
}

function modalHTML() {
  if (!modal) return '';
  if (modal.type === 'erro') return `<div class="scrim" data-act="close"><div class="sheet" role="dialog" aria-modal="true"><h2>Não consegui ler o arquivo</h2><p>${esc(modal.msg)}</p><p class="small mute">Se for um extrato do seu banco, me mande um exemplo (com os valores apagados) para eu ajustar o leitor.</p><button class="btn primary" data-act="close">Fechar</button></div></div>`;
  if (modal.type === 'import') {
    const r = modal.report; const rec = reconcile(state); const n = reviewGroups(state).length;
    return `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Extrato recebido"><div class="small mute">${r.acct === 'cartao' ? 'Fatura do cartão' : 'Extrato do banco'}</div><h2 style="font-size:22px;margin:2px 0 12px">Extrato recebido</h2>
      <div class="card" style="margin-bottom:12px;padding:12px 14px"><strong>${esc(r.file || 'arquivo')}</strong></div>
      ${r.acct === 'cartao' ? '' : banner(rec, true)}
      <div class="card" style="margin:12px 0"><div class="line"><span>Lançamentos novos</span><strong>${r.added}</strong></div><div class="line"><span>Categorizados sozinhos</span><strong>${r.auto}</strong></div><div class="line"><span>Já existiam (ignorados)</span><strong>${r.duplicates}</strong></div>${r.before ? `<div class="line"><span>Antes do saldo inicial (ignorados)</span><strong>${r.before}</strong></div>` : ''}${r.confirmedManual ? `<div class="line"><span>Anotados por você e confirmados</span><strong>${r.confirmedManual}</strong></div>` : ''}<div class="line"><span>Esperando você</span><strong style="color:var(--amber-d)">${n}</strong></div></div>
      <div class="grid" style="gap:8px">${n ? `<button class="btn primary" style="height:50px" data-act="close" data-go="revisar">Revisar ${n === 1 ? 'o 1' : 'os ' + n} agora</button>` : ''}<button class="btn" data-act="close">${n ? 'Deixar para depois' : 'Fechar'}</button></div></div></div>`;
  }
  if (modal.type === 'add') {
    const m = modal;
    return `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Novo lançamento"><h2 style="font-size:20px">${m.entrada ? 'Nova entrada' : 'Novo gasto'}</h2>
      <div class="seg" style="margin:10px 0"><button class="chip" aria-pressed="${!m.entrada}" data-act="add-kind" data-v="0">Gasto</button><button class="chip" aria-pressed="${m.entrada}" data-act="add-kind" data-v="1">Entrada</button></div>
      <label class="lab" for="av1">Valor (R$)</label><input class="field" id="av1" inputmode="decimal" placeholder="0,00" autofocus>
      <label class="lab" for="ad1">O que foi</label><input class="field" id="ad1" placeholder="ex.: almoço, farmácia">
      <label class="lab" for="ac1">Categoria</label><select class="field" id="ac1">${catsFor(m.entrada ? 'in' : 'out').map((c) => `<option>${esc(c)}</option>`).join('')}</select>
      <label class="lab">Onde</label><div class="seg">${[['dinheiro', 'Dinheiro'], ['cartao', 'Cartão'], ['banco', 'Conta']].map(([k, l]) => `<button class="chip" aria-pressed="${m.acct === k}" data-act="add-acct" data-v="${k}">${l}</button>`).join('')}</div>
      <label class="lab" for="adt">Data</label><input class="field" id="adt" type="date" value="${today()}">
      <p class="small mute">${m.acct === 'banco' ? 'Na conta: quando o extrato trouxer este gasto, ele só confirma, sem duplicar.' : m.acct === 'cartao' ? 'No cartão: entra na fatura, não no saldo do banco.' : 'Dinheiro: fica numa conta própria e não entra na conferência com o banco.'}</p>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="add-save">Salvar</button><button class="btn" data-act="close">Cancelar</button></div></div></div>`;
  }
  if (modal.type === 'edit') {
    const t = state.txns.find((x) => x.id === modal.id); if (!t) return '';
    return `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Editar lançamento"><div class="small mute">${ddmm(t.date)}${t.rec ? ' · previsto' : ''}</div><h2 style="font-size:20px">${esc(t.desc)}</h2><div class="num ${t.amount < 0 ? 'neg' : 'pos'}" style="font-size:24px;font-weight:700">${brl(t.amount)}</div>
      <label class="lab" for="ec">Categoria</label><select class="field" id="ec">${['', ...catsFor(t.amount < 0 ? 'out' : 'in')].map((c) => `<option value="${esc(c)}" ${t.cat === c ? 'selected' : ''}>${c || '(sem categoria)'}</option>`).join('')}</select>
      <label class="lab" for="ea">Conta</label><select class="field" id="ea">${Object.entries(ACCT).map(([k, l]) => `<option value="${k}" ${t.acct === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-act="edit-save" data-id="${t.id}">Salvar</button><button class="btn danger" data-act="del" data-id="${t.id}">Excluir</button><button class="btn" data-act="close">Cancelar</button></div></div></div>`;
  }
  return '';
}

function render() {
  const groups = state ? reviewGroups(state).length : 0;
  const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const tabs = [['inicio', 'Início', ic('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>')], ['revisar', 'Revisar', ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>')], ['mes', 'Mês', ic('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>')], ['lancamentos', 'Lançamentos', ic('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>')], ['ajustes', 'Ajustes', ic('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>')]];
  const nav = (cls) => tabs.map(([k, l, i]) => `<button class="tab" data-view="${k}" ${view === k ? 'aria-current="page"' : ''}>${i}<span>${l}</span>${k === 'revisar' && groups ? `<span class="badge">${groups}</span>` : ''}</button>`).join('');
  const body = { inicio, revisar, mes, lancamentos, ajustes }[view] || inicio;
  $app.innerHTML = `<div class="shell">
    <header class="topbar"><div class="brand"><img src="icons/icon-192.png" alt=""><div><b>OIKONOMIA</b><span>Conciliação</span></div></div><nav class="tabs" aria-label="Seções">${nav()}</nav></header>
    <div class="mobilebrand"><div class="brand"><img src="icons/icon-192.png" alt=""><div><b>OIKONOMIA</b><span>Conciliação</span></div></div></div>
    <main>${body()}</main>
    <nav class="bottomnav" aria-label="Seções">${nav()}</nav>
    <button class="fab" data-act="add" aria-label="Novo gasto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Gasto</button>
    <input type="file" id="file" accept=".ofx,.csv,.txt,text/csv,text/plain,application/x-ofx,application/octet-stream" hidden>
    ${modalHTML()}</div>`;
  document.title = 'Conciliação — OIKONOMIA';
}

/* ---------- ações ---------- */
const num = (id) => { const v = document.getElementById(id)?.value ?? ''; const n = Number(String(v).replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const numRaw = (id) => { const v = document.getElementById(id)?.value ?? ''; return Number(String(v).replace(',', '.')); };

const actions = {
  'pick-file': () => document.getElementById('file').click(),
  'pick-backup': () => document.getElementById('bfile').click(),
  close: (el) => { const go = el.dataset.go; modal = null; if (go) { view = go; location.hash = '#/' + go; } render(); },
  'pick-cat': (el) => { picked[el.dataset.key] = el.dataset.cat; render(); },
  confirm: (el) => {
    const key = el.dataset.key; const cat = picked[key]; if (!cat) return;
    const g = reviewGroups(state).find((x) => x.key === key);
    delete picked[key];
    commit(confirmGroup(state, key, cat, g?.kind), `Anotado: ${g?.desc || 'lançamento'} → ${cat}`);
  },
  filter: (el) => { filter = el.dataset.f; render(); },
  month: (el) => { monthYM = addMonths(monthYM || monthOf(today()), Number(el.dataset.d)); render(); },
  add: () => { modal = { type: 'add', entrada: false, acct: 'dinheiro' }; render(); },
  'add-kind': (el) => { modal.entrada = el.dataset.v === '1'; render(); },
  'add-acct': (el) => { modal.acct = el.dataset.v; render(); },
  'add-save': () => {
    const v = num('av1'); const d = document.getElementById('ad1').value.trim();
    if (!(v > 0)) return toast('Digite o valor.');
    if (!d) return toast('Diga o que foi.');
    const amount = modal.entrada ? v : -v;
    const { state: next } = addManual(state, { date: document.getElementById('adt').value || today(), amount, desc: d, cat: document.getElementById('ac1').value, acct: modal.acct });
    modal = null; commit(next, 'Lançamento salvo');
  },
  edit: (el) => { modal = { type: 'edit', id: Number(el.dataset.id) }; render(); },
  'edit-save': (el) => {
    const id = Number(el.dataset.id);
    const next = updateTxn(state, id, { cat: document.getElementById('ec').value, acct: document.getElementById('ea').value });
    modal = null; commit(next, 'Salvo');
  },
  del: (el) => { const id = Number(el.dataset.id); modal = null; commit(removeTxn(state, id), 'Lançamento apagado'); },
  'to-cash': (el) => commit(moveToAccount(state, Number(el.dataset.id), 'dinheiro'), 'Movido para a conta Dinheiro'),
  'set-bank': () => {
    const v = numRaw('bk'); if (!Number.isFinite(v)) return toast('Digite o saldo do banco.');
    const s = structuredClone(state); s.bank = { amount: round2(v), date: coverage(state) };
    commit(s, 'Saldo informado'); view = 'inicio'; location.hash = '#/inicio'; render();
  },
  'save-cfg': () => {
    const s = structuredClone(state);
    s.config.cardCloseDay = Math.max(1, Math.min(28, Number(document.getElementById('cc').value) || 8));
    s.config.cardDueDay = Math.max(1, Math.min(28, Number(document.getElementById('cd').value) || 16));
    s.config.avulsosMensal = num('av') >= 0 ? num('av') : 400;
    const dz = numRaw('dz'); s.config.dizimoAuto = dz > 0; if (dz > 0) s.config.dizimoPct = dz / 100;
    commit(s, 'Configurações salvas');
  },
  'toggle-rec': (el) => { const s = structuredClone(state); const r = s.recurring.find((x) => x.id === el.dataset.id); r.active = el.checked; commit(s); },
  export: () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }));
    a.download = `conciliacao-${today()}.json`; a.click(); toast('Cópia baixada');
  },
  reset: async () => {
    if (!confirm('Apagar todos os lançamentos e regras deste aparelho? Os previstos voltam ao padrão da planilha.')) return;
    const seed = await (await fetch('seed.json')).json();
    commit(newState(seed), 'Tudo apagado');
  },
  'sheet-push': async () => {
    const cfg = { url: document.getElementById('su').value.trim(), token: document.getElementById('st').value };
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    if (!cfg.url) return toast('Cole o endereço do Apps Script.');
    try { await pushState(cfg, state); toast('Enviado para a planilha'); } catch (e) { toast(e.message); }
  },
  'sheet-pull': async () => {
    const cfg = { url: document.getElementById('su').value.trim(), token: document.getElementById('st').value };
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    if (!cfg.url) return toast('Cole o endereço do Apps Script.');
    try {
      const out = await pullState(cfg);
      if (!out.state) return toast('A planilha ainda não tem uma cópia.');
      if (confirm('Substituir os dados deste aparelho pela cópia da planilha?')) commit(out.state, 'Dados baixados da planilha');
    } catch (e) { toast(e.message); }
  },
};

document.addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]');
  if (v) { view = v.dataset.view; location.hash = '#/' + view; window.scrollTo(0, 0); render(); return; }
  if (e.target.classList?.contains('scrim') && modal && modal.type !== 'import') { modal = null; render(); return; }
  const a = e.target.closest('[data-act]');
  if (!a || a.tagName === 'INPUT') return;
  actions[a.dataset.act]?.(a, e);
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'file' && t.files[0]) {
    const f = t.files[0]; const asCard = document.getElementById('asCard')?.checked;
    const text = await readFileText(f); t.value = '';
    await importText(text, f.name, asCard);
  } else if (t.id === 'bfile' && t.files[0]) {
    try { const s = JSON.parse(await readFileText(t.files[0])); if (!s.txns || !s.baseline) throw new Error('arquivo inválido'); commit(s, 'Cópia restaurada'); } catch { toast('Esse arquivo não é uma cópia deste app.'); }
  } else if (t.dataset?.selKey) {
    picked[t.dataset.selKey] = t.value || ''; render();
  } else if (t.dataset?.act === 'toggle-rec') {
    actions['toggle-rec'](t);
  }
});
window.addEventListener('hashchange', () => { const v = location.hash.replace('#/', ''); if (v && v !== view) { view = v; render(); } });

/* ---------- arquivo compartilhado pelo celular (Web Share Target) ---------- */
async function takeSharedFile() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('conc-share');
    const res = await cache.match('shared-file');
    if (!res) return;
    const name = decodeURIComponent(res.headers.get('x-file-name') || 'extrato');
    const blob = await res.blob();
    await cache.delete('shared-file');
    const text = await readFileText(new File([blob], name));
    await importText(text, name, false);
  } catch { /* nada compartilhado */ }
}

async function start() {
  try { const raw = localStorage.getItem(KEY); if (raw) state = JSON.parse(raw); } catch { state = null; }
  if (!state) { const seed = await (await fetch('seed.json')).json(); state = newState(seed); persist(); }
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && (!new URLSearchParams(location.search).has('hoje') || new URLSearchParams(location.search).has('sw'))) navigator.serviceWorker.register('sw.js').catch(() => {});
  await takeSharedFile();
}
window.__app = { get state() { return state; }, importText: (t, n, c) => importText(t, n, c), render };
start();
