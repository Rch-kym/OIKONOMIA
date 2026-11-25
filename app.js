import { parseOFX, looksLikeOFX } from './src/ofx.js';
import { parseCSV } from './src/csv.js';
import { CATS_IN, CATS_OUT } from './src/rules.js';
import { setFatura, ignoreSuggestion, removeRecurring, saveRecurring, setSkip, addManual, addSim, clearSims, removeSim, confirmGroup, importParsed, moveToAccount, newState, removeTxn, reviewGroups, updateTxn } from './src/ledger.js';
import { currentBalance, monthPlan, monthView, nextFaturaDue, reconcile } from './src/summary.js';
import { forecast, podeGastar } from './src/forecast.js';
import { coverage, isSalary, monthItems, payWindow } from './src/recurring.js';
import { audit, keywordFor, matchPreview, suggestFixed } from './src/audit.js';
import { filterTxns, hasFilter } from './src/filter.js';
import { localAsk, AJUDA } from './src/local.js';
import { DEFAULT_MODEL, applyTool, ask as askAI } from './src/assistant.js';
import { pullState, pushState } from './src/sheets.js';
import { parsePDF } from './src/pdf.js';
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
let fx = { q: '', from: '', to: '', cat: '', type: '', acct: '', status: '', min: '', max: '', sort: 'date' };
const AI_KEY = 'conc-ai-v1';
const aiCfg = () => { try { return JSON.parse(localStorage.getItem(AI_KEY) || '{}'); } catch { return {}; } };
let chat = { history: [], log: [], pending: [], busy: false };
const picked = {}; // categoria escolhida por grupo de revisão

const $app = document.getElementById('app');

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* sem armazenamento */ } }
function commit(next, msg) { state = { ...next, savedAt: new Date().toISOString() }; persist(); if (msg) toast(msg); render(); scheduleSync(); }

/* ---- sincronização automática entre aparelhos (via planilha do Google) ----
   Envia 1,5 s depois de cada alteração e confere se há versão mais nova ao abrir e ao voltar para o app.
   Vale a versão salva por último; não mistura edições feitas ao mesmo tempo em dois aparelhos. */
const syncCfg = () => { const c = sheetsCfg(); return c.url && c.token ? c : null; };
let syncTimer = null, syncing = false;
function scheduleSync() {
  if (!syncCfg()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try { await pushState(syncCfg(), state); setSync('ok'); } catch { setSync('erro'); }
  }, 1500);
}
function setSync(st) { window.__sync = st; document.querySelectorAll('.syncdot').forEach((el) => { el.dataset.s = st; el.title = st === 'ok' ? 'Sincronizado com a planilha' : st === 'erro' ? 'Sem conexão com a planilha. Tenta de novo na próxima alteração.' : st ? 'Sincronizando...' : ''; }); }
async function pullIfNewer() {
  const cfg = syncCfg(); if (!cfg || syncing || modal) return;
  syncing = true; setSync('...');
  try {
    const out = await pullState(cfg);
    const mine = state.savedAt || '';
    if (out.state && out.updatedAt && out.updatedAt > mine) {
      state = { ...out.state, savedAt: out.updatedAt }; persist(); render(); toast('Atualizado com os dados do outro aparelho');
    } else if (mine && (!out.updatedAt || mine > out.updatedAt)) {
      await pushState(cfg, state);
    }
    setSync('ok');
  } catch { setSync('erro'); } finally { syncing = false; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullIfNewer(); });
const sheetsCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch { return {}; } };

async function readFileText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
function parseAny(text) { return looksLikeOFX(text) ? parseOFX(text) : parseCSV(text); }

const isPdf = (f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';

// Lê qualquer arquivo aceito (PDF, OFX ou CSV) e importa.
async function importFile(file, asCard) {
  try {
    let parsed;
    if (isPdf(file)) { toast('Lendo o PDF...'); parsed = await parsePDF(await file.arrayBuffer()); }
    else parsed = parseAny(await readFileText(file));
    finishImport(parsed, file.name, asCard);
  } catch (e) {
    modal = { type: 'erro', msg: e.message };
    render();
  }
}
function importText(text, name, asCard) {
  try { finishImport(parseAny(text), name, asCard); } catch (e) { modal = { type: 'erro', msg: e.message }; render(); }
}
function finishImport(parsed, name, asCard) {
  if (!parsed.txns.length) throw new Error('Não encontrei lançamentos neste arquivo.');
  if (asCard) parsed.account = 'cartao';
  const { state: next, report } = importParsed(state, parsed, { file: name });
  state = { ...next, savedAt: new Date().toISOString() }; persist(); scheduleSync();
  modal = { type: 'import', report };
  view = 'inicio'; render();
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

function chart(fc, base) {
  const W = 760, H = 210, L = 46, R = 10, T = 10, B = 26;
  const vals = fc.series.map((s) => s.balance).concat(base ? base.series.map((s) => s.balance) : []);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals) * 1.08 || 1;
  const n = fc.series.length;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, n - 1);
  const y = (v) => T + ((max - v) * (H - T - B)) / (max - min || 1);
  const bpts = base ? base.series.map((s, i) => `${x(i).toFixed(1)},${y(s.balance).toFixed(1)}`).join(' ') : '';
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
    ${base ? `<polyline points="${bpts}" fill="none" stroke="var(--mute)" stroke-width="2" stroke-dasharray="5 5" stroke-linejoin="round"/>` : ''}
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"/>
    ${nf >= 0 ? `<circle cx="${x(nf)}" cy="${y(fc.series[nf].balance)}" r="6" fill="var(--red)" stroke="var(--card)" stroke-width="2"/>` : ''}
    ${ticks.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" font-size="12" fill="var(--mute)">${ddmm(fc.series[i].date)}</text>`).join('')}
  </svg>`;
}

/* ---------- telas ---------- */
function simCard(sims, fc, base, pg, pgBase) {
  const end = fc.series[fc.series.length - 1], endB = base ? base.series[base.series.length - 1] : null;
  const list = sims.map((x) => `<div class="line"><span>${ddmm(x.date)} · ${esc(x.label)}</span><span class="row" style="gap:8px;flex-wrap:nowrap"><strong class="num ${x.amount < 0 ? 'neg' : 'pos'}">${brl(x.amount)}</strong><button class="btn sm danger" data-act="sim-del" data-id="${x.id}" aria-label="Remover simulação">Remover</button></span></div>`).join('');
  const diff = base ? `<div class="alert" style="margin:10px 0">Com a simulação: <strong>pode gastar ${brl(pg.value)}</strong> até o fim do mês (sem ela, ${brl(pgBase.value)}). Saldo daqui a 60 dias: <strong>${brl(end.balance)}</strong> (sem ela, ${brl(endB.balance)}).</div>` : '';
  return `<div class="card" style="margin-bottom:16px"><div class="between"><div><h2>Simulação</h2><div class="small mute">Teste um valor para ver como a projeção fica. Não entra no saldo nem na conferência com o banco.</div></div>
    <div class="row"><button class="btn sm primary" data-act="sim-add">Simular um valor</button>${sims.length ? '<button class="btn sm" data-act="sim-clear">Limpar tudo</button>' : ''}</div></div>${diff}${list}</div>`;
}

// Mostra de qual mês será o salário, pela janela (ex.: 30/11 vira "salário de dezembro")
function salaryHint(g) {
  const sal = state.recurring.find(isSalary); if (!sal) return '';
  const txns = state.txns.filter((t) => g.ids.includes(t.id));
  const rows = txns.map((t) => {
    for (const ym of [monthOf(t.date), addMonths(monthOf(t.date), 1)]) {
      const due = `${ym}-${String(sal.day).padStart(2, '0')}`; const w = payWindow(state, sal, due);
      if (w && t.date >= w.from && t.date <= w.to) { const [y, m] = ym.split('-'); return `${ddmm(t.date)} → salário de ${MESES[Number(m) - 1]}/${y}`; }
    }
    return `${ddmm(t.date)} → fora da janela do salário, fica só como entrada`;
  });
  return `<div class="small" style="color:var(--primary)">${rows.join('<br>')}</div>`;
}

const calcRow = (label, val, cls, why) => `<div class="calc"><div class="line" style="border:0;padding-bottom:0"><span>${label}</span><strong class="num ${cls}">${val}</strong></div><div class="tiny mute why">${why}</div></div>`;
function avulsoTxt(i) {
  const base = i.base === 'real' ? `Média real dos últimos ${i.dias} dias já revisados: ${brl(i.real)}/dia.` : `Sua previsão de ${brl(i.monthly)}/mês (${brl(i.plan)}/dia)${i.real != null ? `; a média real revisada (${brl(i.real)}/dia) é menor` : ''}.`;
  return base + (i.pendenteN ? ` ${i.pendenteN} saída(s) sem revisão (${brl(i.pendente)}) ainda não entram.` : '');
}
function pendBanner(mp) {
  const n = state.txns.filter((t) => t.status === 'review').length;
  if (!n) return '';
  return `<div class="alert" style="margin-top:10px"><strong>Previsão incompleta:</strong> ${n} lançamentos (${reviewGroups(state).length} estabelecimentos) sem revisão ficam de fora dos cálculos. <button class="btn sm" style="margin-left:6px" data-view="revisar">Revisar</button></div>`;
}
function inicio() {
  const t = today();
  const rec = reconcile(state);
  const sims = state.sims || [];
  const pg = podeGastar(state, t);
  const fc = forecast(state, t, 60);
  const base = sims.length ? forecast(state, t, 60, { noSims: true }) : null;
  const pgBase = sims.length ? podeGastar(state, t, { noSims: true }) : null;
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
  ${simCard(sims, fc, base, pg, pgBase)}
  <div class="grid g2">
    <div class="card"><div class="between"><h2>Saldo projetado, próximos 60 dias</h2><span class="small mute">fixos + cartão + gasto médio de ${brl(fc.rate)}/dia</span></div>
      <div style="margin:8px 0">${chart(fc, base)}</div>${base ? '<div class="small mute">Linha cheia: com a simulação. Tracejada: sem ela.</div>' : ''}${alert}
      ${next7.length ? `<div class="sep"></div><h3 style="margin:0 0 4px;font-size:15px">Próximos 7 dias</h3>${next7.map((e) => `<div class="line"><span>${ddmm(e.date)} · ${esc(e.label)}</span><strong class="num ${e.amount < 0 ? 'neg' : 'pos'}">${brl(e.amount)}</strong></div>`).join('')}` : '<div class="small mute" style="margin-top:12px">Nada previsto para os próximos 7 dias.</div>'}</div>
    <div class="card"><div class="between"><h2>${MESES[Number(ym.slice(5)) - 1][0].toUpperCase() + MESES[Number(ym.slice(5)) - 1].slice(1)}, como vai ficar</h2><span class="small mute">previsão</span></div>
      ${pendBanner(mp)}
      <div style="margin-top:6px">
      ${calcRow('Entradas previstas', brl(mp.totalEntradas), '', mp.entradas.length ? mp.entradas.map((e) => esc(e.label)).join(', ') + '. Só o que está cadastrado em Fixas.' : 'Nenhuma entrada fixa cadastrada.')}
      ${calcRow('Contas fixas', brl(-mp.totalFixos), 'neg', `${mp.fixos.length} conta${mp.fixos.length === 1 ? '' : 's'} no débito (aba Fixas).`)}
      ${calcRow(`Fatura do cartão (${ddmm(mp.cartaoDue)})`, brl(-mp.cartao), 'neg', mp.fatura.manual != null ? 'Valor que você digitou.' : `Estimativa: só as assinaturas (${brl(mp.fatura.totalSubs)}) e compras no cartão (${brl(mp.fatura.totalCompras)}). Digite o valor real na aba Mês quando a fatura fechar.`)}
      ${calcRow('Dízimo', brl(-mp.dizimo), 'neg', mp.dizimoInfo ? `${Math.round(mp.dizimoInfo.pct * 100)}% de ${brl(mp.dizimoInfo.base)} de entradas já conferidas${mp.dizimoInfo.pendenteN ? `. ${mp.dizimoInfo.pendenteN} entrada(s) sem revisão (${brl(mp.dizimoInfo.pendente)}) ainda não contam.` : '.'}` : 'Dízimo automático desligado.')}
      ${calcRow('Gastos do dia a dia', brl(-mp.avulsos), 'neg', avulsoTxt(mp.avulsoInfo))}
      <div class="line" style="border-top:2px solid var(--line);margin-top:4px"><strong>Sobra prevista</strong><strong class="num ${mp.sobra < 0 ? 'neg' : 'pos'}" style="font-size:18px">${brl(mp.sobra)}</strong></div>
      <div class="tiny mute" style="margin-top:4px">Sobra = entradas − fixas − fatura − dízimo − dia a dia.</div></div>
    </div>
  </div>`;
}

const catsFor = (kind) => (kind === 'in' ? CATS_IN : CATS_OUT);
let revMode = 'data'; // 'data' = um cartão por lançamento, em ordem de data · 'loja' = agrupado por estabelecimento
function revisar() {
  const grouped = reviewGroups(state);
  let groups = grouped;
  if (revMode === 'data') {
    const byId = new Map(state.txns.map((t) => [t.id, t]));
    groups = grouped.flatMap((g) => g.ids.map((id) => { const t = byId.get(id); return { ...g, count: 1, total: t.amount, firstDate: t.date, lastDate: t.date, same: g.count - 1 }; }))
      .sort((a, b) => (a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : 0));
  }
  const toggle = `<div class="seg" role="group" aria-label="Ordem"><button class="chip" aria-pressed="${revMode === 'data'}" data-act="rev-mode" data-v="data">Por data</button><button class="chip" aria-pressed="${revMode === 'loja'}" data-act="rev-mode" data-v="loja">Por estabelecimento</button></div>`;
  const head = `<div class="pagehead"><div><div class="small mute">${grouped.length ? 'Confirme uma vez; o app lembra nas próximas' : 'Nada pendente'}</div><h1>Revisar${groups.length ? ` (${groups.length})` : ''}</h1></div>${grouped.length ? toggle : ''}</div>`;
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
      <div class="row"><button class="btn primary" ${sel ? '' : 'disabled'} data-act="confirm" data-key="${esc(g.key)}">Confirmar e lembrar</button><button class="btn" data-act="fixa-from" data-id="${g.ids[0]}">É conta fixa</button>
      <span class="small mute">Da próxima vez, "${esc(g.desc)}" entra direto${sel ? ' em ' + esc(sel) : ''}.${g.same ? ` Vale também para mais ${g.same} ${g.same === 1 ? 'igual' : 'iguais'}.` : ''}</span></div>${sel === 'Salário' ? salaryHint(g) : ''}</div>`;
  }).join('')}</div>`;
}

function statusPill(i) {
  if (i.status === 'paga') return i.txn && i.txn.recDiff && i.rec.variable ? `<span class="pill ok">paga ${brl(Math.abs(i.txn.amount))}</span>` : '<span class="pill ok">paga</span>';
  if (i.status === 'diferente') return `<span class="pill warn" title="Valor diferente do cadastrado">pago ${brl(Math.abs(i.txn.amount)).replace('− ', '')} (${i.txn.recDiff > 0 ? '+' : '−'}${brl(Math.abs(i.txn.recDiff)).replace('− ', '')})</span>`;
  if (i.status === 'sem débito') return '<span class="pill warn">sem débito</span>';
  if (i.status === 'pulada') return '<span class="pill idle">não teve</span>';
  return '<span class="pill" style="background:var(--line2);color:var(--mute)">a vencer</span>';
}
const LV = { ok: ['ok', check], info: ['info', '<span style="font-weight:800">i</span>'], warn: ['warn', bang], bad: ['bad', bang] };
function auditCard(ym) {
  const a = audit(state, ym, today());
  const nm = MESES[Number(ym.slice(5)) - 1];
  const head = a.clean ? `<span class="pill ok">Tudo em ordem</span>` : `<span class="pill ${a.bad ? 'bad' : 'warn'}">${a.bad + a.warn} ponto${a.bad + a.warn > 1 ? 's' : ''} de atenção</span>`;
  const rows = a.items.map((i) => {
    const list = (i.list || []).slice(0, 5).map((l) => `<div class="tiny" style="display:flex;justify-content:space-between;gap:10px;margin-top:2px"><span class="mute">${ddmm(l.date)} · ${esc(l.label)}${l.extra ? ' · ' + esc(l.extra) : ''}</span><span class="num">${brl(l.amount)}</span></div>`).join('');
    const more = (i.list || []).length > 5 ? `<div class="tiny mute">e mais ${i.list.length - 5}</div>` : '';
    return `<div class="aud ${i.level}"><span class="auddot">${LV[i.level][1]}</span><div style="flex:1;min-width:0"><div><strong>${esc(i.title)}</strong>${i.amount != null && i.kind !== 'review' ? ` <span class="num mute">${brl(i.amount)}</span>` : ''}</div>${i.detail ? `<div class="small mute">${esc(i.detail)}</div>` : ''}${list}${more}</div>${i.go && i.go !== 'mes' ? `<button class="btn sm ghost" data-view="${i.go}">Ver</button>` : ''}</div>`;
  }).join('');
  return `<div class="card" style="margin-bottom:16px"><div class="between"><div><h2>Fechamento de ${nm}</h2><div class="small mute">Tudo que o extrato trouxe precisa ter um destino. O que sobrar aparece aqui.</div></div>${head}</div><div style="margin-top:10px">${rows}</div></div>`;
}

const fmtMonth = (ym) => (ym ? `${ym.slice(5)}/${ym.slice(0, 4)}` : '');
function fixas() {
  const t = today(); const ym = monthOf(t);
  const items = new Map(monthItems(state, ym, t).map((i) => [i.rec.id, i]));
  const recs = state.recurring.slice().sort((a, b) => a.day - b.day || a.desc.localeCompare(b.desc));
  const act = recs.filter((r) => r.active && (!r.until || r.until >= ym));
  const outs = act.filter((r) => r.type === 'out' && !r.card), ins = act.filter((r) => r.type === 'in' && r.cat !== 'Vale Alimentação'), cards = act.filter((r) => r.card);
  const paused = recs.filter((r) => !act.includes(r));
  const sum = (l) => round2(l.reduce((s2, r) => s2 + r.amount, 0));
  const renda = sum(ins), deb = sum(outs), cart = sum(cards);
  const row = (r) => {
    const it = items.get(r.id);
    const tags = [r.variable ? 'valor varia' : '', r.until ? `até ${fmtMonth(r.until)}` : '', r.from && r.from > ym ? `começa em ${fmtMonth(r.from)}` : '', !r.match && !r.card ? 'sem palavra-chave' : ''].filter(Boolean);
    const skip = it && it.status === 'sem débito' ? `<button class="btn sm ghost" data-act="fixa-skip" data-id="${r.id}" data-due="${it.due}">Não teve</button>` : it && it.status === 'pulada' ? `<button class="btn sm ghost" data-act="fixa-unskip" data-id="${r.id}" data-due="${it.due}">Desfazer</button>` : '';
    return `<div class="line" style="align-items:flex-start"><div style="min-width:0"><div><span class="mute num">${String(r.day).padStart(2, '0')}</span> · <strong>${esc(r.desc)}</strong></div><div class="tiny mute">${esc(r.cat)}${r.match ? ` · extrato: "${esc(r.match)}"` : ''}${tags.length ? ' · ' + tags.join(' · ') : ''}</div></div>
      <div class="row" style="gap:8px;flex-wrap:nowrap;justify-content:flex-end"><strong class="num">${r.variable ? '~' : ''}${brl(r.amount)}</strong>${it ? statusPill(it) : ''}${skip}<button class="btn sm" data-act="fixa-edit" data-id="${r.id}">Editar</button></div></div>`;
  };
  const group = (title, hint, list, total) => `<div class="card"><div class="between"><div><h2>${title}</h2><div class="small mute">${hint}</div></div><strong class="num">${brl(total)}</strong></div><div style="margin-top:8px">${list.length ? list.map(row).join('') : '<div class="empty">Nenhuma.</div>'}</div></div>`;
  const sug = suggestFixed(state);
  const sugCard = sug.length ? `<div class="card" style="margin-bottom:16px"><h2>O app encontrou ${sug.length} possível${sug.length > 1 ? 'is' : ''} conta${sug.length > 1 ? 's' : ''} fixa${sug.length > 1 ? 's' : ''}</h2><div class="small mute">Se repetem em meses diferentes e ainda não estão cadastradas.</div>
    ${sug.slice(0, 8).map((x, n) => `<div class="line"><div style="min-width:0"><strong>${esc(x.desc)}</strong><div class="tiny mute">dia ${x.day} · em ${x.months} meses${x.variable ? ' · valor varia' : ''}</div></div><div class="row" style="gap:8px;flex-wrap:nowrap"><strong class="num">${brl(x.amount)}</strong><button class="btn sm primary" data-act="sug-add" data-i="${n}">Cadastrar</button><button class="btn sm ghost" data-act="sug-ignore" data-key="${esc(x.key)}">Ignorar</button></div></div>`).join('')}</div>` : (state.hist || []).length ? '' : `<div class="card" style="margin-bottom:16px"><div class="small mute">Para o app sugerir contas fixas sozinho, importe também o extrato dos 2 ou 3 meses anteriores (em Ajustes). Eles só servem de histórico e não mexem no saldo.</div></div>`;
  return `<div class="pagehead"><div><div class="small mute">Tudo que se repete todo mês</div><h1>Contas fixas</h1></div><button class="btn primary" data-act="fixa-new">Nova conta fixa</button></div>
  <div class="grid g3" style="margin-bottom:16px">
    <div class="card kpi"><div class="label">Entra por mês</div><div class="value num pos">${brl(renda)}</div><div class="sub">${ins.length} entrada${ins.length === 1 ? '' : 's'} fixa${ins.length === 1 ? '' : 's'}</div></div>
    <div class="card kpi"><div class="label">Sai no débito por mês</div><div class="value num">${brl(deb)}</div><div class="sub">${renda > 0 ? Math.round((deb / renda) * 100) + '% da renda fixa' : 'sem renda fixa cadastrada'}</div></div>
    <div class="card kpi"><div class="label">Assinaturas no cartão</div><div class="value num">${brl(cart)}</div><div class="sub">somam na fatura, não no saldo</div></div></div>
  ${sugCard}
  <div class="grid g2" style="align-items:start">${group('Contas no débito', 'O débito no extrato dá baixa sozinho.', outs, deb)}${group('Entradas fixas', 'Salário e outras entradas que se repetem.', ins, renda)}</div>
  <div class="grid g2" style="align-items:start;margin-top:16px">${group('No cartão', 'Entram na fatura do cartão.', cards, cart)}${paused.length ? group('Pausadas ou encerradas', 'Não entram na projeção.', paused, 0) : ''}</div>`;
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
  ${auditCard(ym)}
  <div class="grid g3">
    <div class="card"><div class="between"><h2>1 · Fixos</h2><span class="small mute"><a href="#/fixas" data-view="fixas" style="color:inherit">editar em Fixas</a></span></div>
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
      <div class="sep"></div><div class="between"><strong>Fatura${f.manual != null ? ' (valor digitado)' : ' (estimada)'}</strong><strong class="num">${brl(f.total)}</strong></div>
      <label class="lab" for="fat">Valor real da fatura (R$)</label>
      <div class="row" style="gap:8px;flex-wrap:nowrap"><input class="field" id="fat" inputmode="decimal" placeholder="${f.manual != null ? String(f.manual).replace('.', ',') : 'do app do cartão'}" style="margin:0"><button class="btn sm primary" data-act="fatura-save" data-due="${f.due}">Salvar</button>${f.manual != null ? `<button class="btn sm ghost" data-act="fatura-clear" data-due="${f.due}">Limpar</button>` : ''}</div>
      <div class="tiny mute" style="margin-top:6px">Quando a fatura fechar, digite o valor aqui. A projeção passa a usar ele no lugar da estimativa.</div></div>
  </div>
  <div class="card" style="margin-top:16px;font-size:14px;color:var(--ink2)"><strong style="color:var(--ink)">Como as três se somam:</strong> o saldo do banco cai quando fixos e avulsos são debitados, e uma vez só, em ${ddmm(f.due)}, quando o cartão é pago. O "pagamento da fatura" no extrato não conta como gasto novo.
    ${v.dizimo ? `<br>Dízimo automático de ${ddmm(v.dizimo.due)}: ${brl(v.dizimo.amount)}${v.dizimo.paid ? ' (já pago)' : ''}.` : ''}</div>`;
}

function listaExtrato() {
  const r = filterTxns(state, fx); const shown = r.list.slice(0, 300);
  const rows = shown.length ? shown.map((t) => `<button class="line" style="width:100%;background:none;border:0;border-bottom:1px solid var(--line2);text-align:left;cursor:pointer" data-act="edit" data-id="${t.id}">
    <span style="min-width:0"><span class="small mute">${ddmm(t.date)} · ${esc(ACCT[t.acct])}${t.rec ? ' · previsto' : ''}</span><br><span style="font-weight:600">${esc(t.desc)}</span><br>${t.status === 'review' ? '<span class="pill warn">revisar</span>' : `<span class="small mute">${esc(t.cat || '')}</span>`}</span>
    <strong class="num ${t.amount < 0 ? 'neg' : 'pos'}" style="white-space:nowrap">${brl(t.amount)}</strong></button>`).join('') : `<div class="empty">${hasFilter(fx) ? 'Nenhum lançamento com esses filtros.' : 'Nada por aqui. Importe um extrato para começar.'}</div>`;
  const tot = `<div class="small" style="display:flex;gap:14px;flex-wrap:wrap;margin:0 0 10px"><span><b>${r.count}</b> lançamento${r.count === 1 ? '' : 's'}${r.count > 300 ? ' (mostrando 300)' : ''}</span><span class="pos">Entradas ${brl(r.entradas)}</span><span class="neg">Saídas ${brl(r.saidas)}</span><span>Saldo do filtro <b class="num">${brl(r.total)}</b></span></div>`;
  return tot + `<div class="card tight">${rows}</div>`;
}
function periodo(kind) {
  const t = today(); const ym = monthOf(t);
  if (kind === 'mes') return { from: ym + '-01', to: ym + '-31' };
  if (kind === 'ant') { const p = addMonths(ym, -1); return { from: p + '-01', to: p + '-31' }; }
  if (kind === '30') { const d = new Date(t + 'T12:00:00'); d.setDate(d.getDate() - 30); return { from: isoDate(d), to: t }; }
  return { from: '', to: '' };
}
function lancamentos() {
  const cats = [...new Set([...CATS_OUT, ...CATS_IN])];
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`;
  const sel = (id, cur, list) => `<select class="field" id="${id}" data-fx="${id.slice(1)}">${list.map(([v, l]) => opt(v, l, cur)).join('')}</select>`;
  const open = hasFilter({ ...fx, q: '' }) || fx.sort !== 'date';
  return `<div class="pagehead"><div><div class="small mute">${state.txns.length} no total</div><h1>Extrato</h1></div></div>
  <div class="card" style="margin-bottom:14px">
    <input class="field" id="fq" data-fx="q" type="search" placeholder="Buscar por nome, categoria ou valor (ex.: ifood, 68,50)" value="${esc(fx.q)}" autocomplete="off" style="margin:0">
    <div class="chips" style="margin:10px 0 0">${[['', 'Todo o período'], ['mes', 'Este mês'], ['ant', 'Mês passado'], ['30', 'Últimos 30 dias']].map(([k, l]) => `<button class="chip" data-act="fx-per" data-k="${k}" aria-pressed="${(k === '' ? !fx.from && !fx.to : JSON.stringify(periodo(k)) === JSON.stringify({ from: fx.from, to: fx.to }))}">${l}</button>`).join('')}
      <button class="chip" data-act="fx-rev" aria-pressed="${fx.status === 'review'}">Só para revisar</button></div>
    <details ${open ? 'open' : ''} style="margin-top:10px"><summary class="small" style="cursor:pointer;color:var(--primary);font-weight:600">Mais filtros</summary>
      <div class="grid g3" style="gap:10px;margin-top:10px">
        <div><label class="lab" for="ftype">Tipo</label>${sel('ftype', fx.type, [['', 'Entradas e saídas'], ['out', 'Só saídas'], ['in', 'Só entradas']])}</div>
        <div><label class="lab" for="facct">Conta</label>${sel('facct', fx.acct, [['', 'Todas'], ['banco', 'Conta'], ['cartao', 'Cartão'], ['dinheiro', 'Dinheiro']])}</div>
        <div><label class="lab" for="fcat">Categoria</label>${sel('fcat', fx.cat, [['', 'Todas'], ...cats.map((c) => [c, c])])}</div>
        <div><label class="lab" for="fstatus">Situação</label>${sel('fstatus', fx.status, [['', 'Todas'], ['review', 'Para revisar'], ['ok', 'Já categorizados'], ['rec', 'Baixa de conta fixa']])}</div>
        <div><label class="lab" for="ffromd">De</label><input class="field" id="ffromd" data-fx="from" type="date" value="${fx.from}"></div>
        <div><label class="lab" for="ftod">Até</label><input class="field" id="ftod" data-fx="to" type="date" value="${fx.to}"></div>
        <div><label class="lab" for="fmin">Valor a partir de (R$)</label><input class="field" id="fmin" data-fx="min" inputmode="decimal" value="${esc(fx.min)}"></div>
        <div><label class="lab" for="fmax">Valor até (R$)</label><input class="field" id="fmax" data-fx="max" inputmode="decimal" value="${esc(fx.max)}"></div>
        <div><label class="lab" for="fsort">Ordenar por</label>${sel('fsort', fx.sort, [['date', 'Data (mais novo primeiro)'], ['value', 'Valor (maior primeiro)']])}</div>
      </div>
      <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-act="fx-clear">Limpar filtros</button></div></details></div>
  <div id="lista">${listaExtrato()}</div>`;
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
      <label class="lab" for="sf">Salário: começa a cair no dia (do mês anterior)</label><input class="field" id="sf" type="number" min="1" max="28" value="${c.salaryFrom ?? 26}">
      <label class="lab" for="sd">Salário: cai até o dia</label><input class="field" id="sd" type="number" min="1" max="28" value="${(state.recurring.find(isSalary) || {}).day ?? 5}">
      <p class="small mute">O que entrar nessa janela conta como salário do mês seguinte. Ex.: de 26/11 a 05/12 é o salário de dezembro.</p>
      <label class="lab" for="av">Gastos do dia a dia previstos por mês (R$)</label><input class="field" id="av" inputmode="decimal" value="${String(c.avulsosMensal).replace('.', ',')}">
      <label class="lab" for="dz">Dízimo (% das entradas, 0 para desligar)</label><input class="field" id="dz" inputmode="decimal" value="${c.dizimoAuto ? String(round2(c.dizimoPct * 100)).replace('.', ',') : '0'}">
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="save-cfg">Salvar</button></div></div>
  </div>
  <div class="grid">
    <div class="card"><h2>Assistente</h2><p class="small mute">O botão ✦ já funciona de graça, sem internet: ele entende comandos como "marca tudo do iFood como Alimentação" ou "quanto gastei com mercado". <b>Opcional:</b> para conversa livre, cole uma chave de API da Anthropic. Ela fica só neste aparelho, o uso é cobrado na sua conta e os dados consultados são enviados à Anthropic. Sem chave, nada sai do seu aparelho.</p>
      <label class="lab" for="aik">Chave de API</label><input class="field" id="aik" type="password" autocomplete="off" placeholder="${aiCfg().key ? 'chave salva neste aparelho' : 'sk-ant-...'}">
      <label class="lab" for="aim">Modelo</label><input class="field" id="aim" value="${esc(aiCfg().model || DEFAULT_MODEL)}">
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="ai-save">Salvar</button>${aiCfg().key ? '<button class="btn ghost" data-act="ai-clear">Remover chave</button>' : ''}</div></div>
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

function previewText(d, pv) {
  if (!d.match) return 'Sem palavra-chave, só reconheço o pagamento pelo valor (com 2% de folga). Com a palavra-chave fica mais seguro.';
  if (!pv.count) return 'Nenhum lançamento já importado tem esse texto. Confira se a palavra-chave está escrita como no extrato.';
  return `Bate com ${pv.count} lançamento${pv.count > 1 ? 's' : ''} já importado${pv.count > 1 ? 's' : ''}: ${pv.sample.map((x) => `${ddmm(x.date)} ${brl(x.amount)}`).join(' · ')}`;
}
function modalHTML() {
  if (!modal) return '';
  if (modal.type === 'erro') return `<div class="scrim" data-act="close"><div class="sheet" role="dialog" aria-modal="true"><h2>Não consegui ler o arquivo</h2><p>${esc(modal.msg)}</p><p class="small mute">Se for um extrato do seu banco, me mande um exemplo (com os valores apagados) para eu ajustar o leitor.</p><button class="btn primary" data-act="close">Fechar</button></div></div>`;
  if (modal.type === 'import') {
    const r = modal.report; const rec = reconcile(state); const n = reviewGroups(state).length;
    return `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Extrato recebido"><div class="small mute">${r.acct === 'cartao' ? 'Fatura do cartão' : 'Extrato do banco'}</div><h2 style="font-size:22px;margin:2px 0 12px">Extrato recebido</h2>
      <div class="card" style="margin-bottom:12px;padding:12px 14px"><strong>${esc(r.file || 'arquivo')}</strong></div>
      ${r.rebased ? `<div class="alert" style="margin-bottom:12px">Saldo inicial ajustado para <strong>${brl(r.rebased.amount)}</strong> em ${ddmm(r.rebased.date)}, como diz o extrato. Os lançamentos anteriores a essa data não entram na conta.</div>` : ''}
      ${r.check ? (r.check.ok ? `<div class="small mute" style="margin-bottom:12px">PDF conferido: a soma dos ${r.check.count} lançamentos fecha com o saldo do extrato${r.check.days ? ` e com os ${r.check.days} saldos diários` : ''}.</div>` : `<div class="alert" style="margin-bottom:12px"><strong>Atenção:</strong> a soma dos lançamentos lidos (${brl(r.check.sum)}) não fecha com o saldo do PDF (${brl(r.check.expected)})${r.check.badDays?.length ? ` ou com o saldo dos dias ${r.check.badDays.map((d) => ddmm(d)).join(', ')}` : ''}. Algum lançamento pode não ter sido lido. Confira antes de seguir.</div>`) : ''}
      ${r.acct === 'cartao' ? '' : banner(rec, true)}
      <div class="card" style="margin:12px 0"><div class="line"><span>Lançamentos novos</span><strong>${r.added}</strong></div><div class="line"><span>Categorizados sozinhos</span><strong>${r.auto}</strong></div><div class="line"><span>Já existiam (ignorados)</span><strong>${r.duplicates}</strong></div>${r.removed && r.removed.length ? `<div class="line"><span>Removidos (não constam mais no extrato do banco)</span><strong>${r.removed.length}</strong></div>` : ''}${r.before ? `<div class="line"><span>Antes do saldo inicial (ignorados)</span><strong>${r.before}</strong></div>` : ''}${r.confirmedManual ? `<div class="line"><span>Anotados por você e confirmados</span><strong>${r.confirmedManual}</strong></div>` : ''}<div class="line"><span>Esperando você</span><strong style="color:var(--amber-d)">${n}</strong></div></div>
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
  if (modal.type === 'sim') {
    const m = modal;
    return `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Simular um valor"><h2 style="font-size:20px">Simular um valor</h2>
      <p class="small mute">Fica só na projeção. Pode remover depois, quando quiser.</p>
      <div class="seg" style="margin:10px 0"><button class="chip" aria-pressed="${!m.entrada}" data-act="sim-kind" data-v="0">Saída</button><button class="chip" aria-pressed="${m.entrada}" data-act="sim-kind" data-v="1">Entrada</button></div>
      <label class="lab" for="sv1">Valor (R$)</label><input class="field" id="sv1" inputmode="decimal" placeholder="0,00" autofocus>
      <label class="lab" for="sd1">O que é</label><input class="field" id="sd1" placeholder="ex.: celular novo, 13º">
      <label class="lab" for="sdt">Data</label><input class="field" id="sdt" type="date" value="${today()}">
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="sim-save">Simular</button><button class="btn" data-act="close">Cancelar</button></div></div></div>`;
  }
  if (modal.type === 'chat') {
    const cfg = aiCfg();
    const bub = (m) => m.role === 'user' ? `<div class="bub me">${esc(m.text)}</div>` : m.role === 'err' ? `<div class="bub err">${esc(m.text)}</div>` : `<div class="bub ai">${esc(m.text).replace(/\n/g, '<br>')}</div>`;
    const props = chat.pending.map((p, i) => `<div class="prop"><div class="small"><b>Proposta</b></div><div class="small">${esc(p.label)}</div><div class="row" style="margin-top:8px"><button class="btn sm primary" data-act="prop-ok" data-i="${i}">Aplicar</button><button class="btn sm ghost" data-act="prop-no" data-i="${i}">Descartar</button></div></div>`).join('');
    const body = `<div id="chatlog" class="chatlog">${chat.log.length ? chat.log.map(bub).join('') : `<div class="bub ai">Oi! Sou o assistente do app. Funciono sem internet e sem custo.<br><br>${esc(AJUDA).replace(/\n/g, '<br>')}</div>`}${chat.busy ? '<div class="bub ai mute">pensando…</div>' : ''}${props}</div>
        <div class="row" style="gap:8px;flex-wrap:nowrap;margin-top:10px"><input class="field" id="chatin" placeholder="Escreva um comando" autocomplete="off" style="margin:0" ${chat.busy ? 'disabled' : ''}><button class="btn primary" data-act="chat-send" ${chat.busy ? 'disabled' : ''}>Enviar</button></div>
        <div class="tiny mute" style="margin-top:8px">${cfg.key ? 'Conversa livre ligada (usa sua chave de API).' : 'Modo local: só entende os comandos acima.'} Só muda algo depois que você toca em Aplicar.</div>`;
    return `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Assistente"><div class="between"><h2 style="font-size:20px">Assistente</h2><div class="row" style="gap:6px">${chat.log.length ? '<button class="btn sm ghost" data-act="chat-new">Nova conversa</button>' : ''}<button class="btn sm" data-act="close">Fechar</button></div></div>${body}</div></div>`;
  }
  if (modal.type === 'fixa') {
    const d = modal.draft; const pv = matchPreview(state, d.match, d.type);
    const cats = catsFor(d.type === 'in' ? 'in' : 'out');
    return `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Conta fixa"><h2 style="font-size:20px">${modal.id ? 'Editar conta fixa' : 'Nova conta fixa'}</h2>
      <label class="lab" for="fn">Nome</label><input class="field" id="fn" value="${esc(d.desc)}" placeholder="ex.: Academia">
      <div class="row" style="gap:10px;margin-top:0"><div style="flex:1"><label class="lab" for="ft">Tipo</label><select class="field" id="ft" data-fixa-type><option value="out" ${d.type === 'out' ? 'selected' : ''}>Saída</option><option value="in" ${d.type === 'in' ? 'selected' : ''}>Entrada</option></select></div>
        <div style="flex:1"><label class="lab" for="fv">Valor (R$)</label><input class="field" id="fv" inputmode="decimal" value="${d.amount ? String(d.amount).replace('.', ',') : ''}" placeholder="0,00"></div>
        <div style="width:90px"><label class="lab" for="fd">Dia</label><input class="field" id="fd" type="number" min="1" max="31" value="${d.day}"></div></div>
      <label class="lab" for="fc">Categoria</label><select class="field" id="fc">${cats.map((c) => `<option ${d.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <label class="lab" for="fm">Como aparece no extrato (palavra-chave)</label><input class="field" id="fm" value="${esc(d.match)}" placeholder="ex.: academia forte" autocomplete="off">
      <div class="small mute" id="fprev" style="margin-top:4px">${previewText(d, pv)}</div>
      <div style="display:grid;gap:8px;margin:12px 0 4px">
        ${d.type === 'out' ? `<label class="row" style="gap:8px;flex-wrap:nowrap"><input type="checkbox" id="fcard" ${d.card ? 'checked' : ''}> <span>É cobrada no cartão de crédito (entra na fatura)</span></label>` : ''}
        <label class="row" style="gap:8px;flex-wrap:nowrap"><input type="checkbox" id="fvar" ${d.variable ? 'checked' : ''}> <span>O valor muda todo mês (luz, água...): não avisar diferença</span></label>
        <label class="row" style="gap:8px;flex-wrap:nowrap"><input type="checkbox" id="fact" ${d.active ? 'checked' : ''}> <span>Ativa</span></label></div>
      <div class="row" style="gap:10px"><div style="flex:1"><label class="lab" for="ffrom">Começa em (opcional)</label><input class="field" id="ffrom" type="month" value="${d.from}"></div><div style="flex:1"><label class="lab" for="funtil">Termina em (parcelas)</label><input class="field" id="funtil" type="month" value="${d.until}"></div></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-act="fixa-save">Salvar</button><button class="btn" data-act="close">Cancelar</button>${modal.id ? '<button class="btn danger" data-act="fixa-del">Apagar</button>' : ''}</div></div></div>`;
  }
  if (modal.type === 'edit') {
    const t = state.txns.find((x) => x.id === modal.id); if (!t) return '';
    return `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="Editar lançamento"><div class="small mute">${ddmm(t.date)}${t.rec ? ' · previsto' : ''}</div><h2 style="font-size:20px">${esc(t.desc)}</h2><div class="num ${t.amount < 0 ? 'neg' : 'pos'}" style="font-size:24px;font-weight:700">${brl(t.amount)}</div>
      <label class="lab" for="ec">Categoria</label><select class="field" id="ec">${['', ...catsFor(t.amount < 0 ? 'out' : 'in')].map((c) => `<option value="${esc(c)}" ${t.cat === c ? 'selected' : ''}>${c || '(sem categoria)'}</option>`).join('')}</select>
      <label class="lab" for="ea">Conta</label><select class="field" id="ea">${Object.entries(ACCT).map(([k, l]) => `<option value="${k}" ${t.acct === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-act="edit-save" data-id="${t.id}">Salvar</button><button class="btn" data-act="fixa-from" data-id="${t.id}">Tornar conta fixa</button><button class="btn danger" data-act="del" data-id="${t.id}">Excluir</button><button class="btn" data-act="close">Cancelar</button></div></div></div>`;
  }
  return '';
}

function render() {
  const groups = state ? reviewGroups(state).length : 0;
  const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const tabs = [['inicio', 'Início', ic('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>')], ['revisar', 'Revisar', ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>')], ['mes', 'Mês', ic('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>')], ['fixas', 'Fixas', ic('<path d="M4 7h16M4 12h16M4 17h10"/><path d="M18 15l2 2 3-3"/>')], ['lancamentos', 'Extrato', ic('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>')], ['ajustes', 'Ajustes', ic('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>')]];
  const nav = (cls) => tabs.map(([k, l, i]) => `<button class="tab" data-view="${k}" ${view === k ? 'aria-current="page"' : ''}>${i}<span>${l}</span>${k === 'revisar' && groups ? `<span class="badge">${groups}</span>` : ''}</button>`).join('');
  const body = { inicio, revisar, mes, fixas, lancamentos, ajustes }[view] || inicio;
  $app.innerHTML = `<div class="shell">
    <header class="topbar"><div class="brand"><img src="icons/icon-192.png" alt=""><div><b>OIKONOMIA</b><span>Conciliação <i data-s="" class="syncdot"></i></span></div></div><nav class="tabs" aria-label="Seções">${nav()}</nav></header>
    <div class="mobilebrand"><div class="brand"><img src="icons/icon-192.png" alt=""><div><b>OIKONOMIA</b><span>Conciliação <i data-s="" class="syncdot"></i></span></div></div></div>
    <main>${body()}</main>
    <nav class="bottomnav" aria-label="Seções">${nav()}</nav>
    <button class="fab ai" data-act="chat-open" aria-label="Abrir o assistente"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg></button>
    <button class="fab" data-act="add" aria-label="Novo gasto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Gasto</button>
    <input type="file" id="file" accept=".pdf,.ofx,.csv,.txt,application/pdf,text/csv,text/plain,application/x-ofx,application/octet-stream" hidden>
    ${modalHTML()}</div>`;
  document.title = 'Conciliação — OIKONOMIA';
  setSync(window.__sync || '');
}

/* ---------- ações ---------- */
const num = (id) => { const v = document.getElementById(id)?.value ?? ''; const n = Number(String(v).replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const numRaw = (id) => { const v = document.getElementById(id)?.value ?? ''; return Number(String(v).replace(',', '.')); };

const actions = {
  'pick-file': () => document.getElementById('file').click(),
  'pick-backup': () => document.getElementById('bfile').click(),
  close: (el) => { const go = el.dataset.go; modal = null; if (go) { view = go; location.hash = '#/' + go; } render(); },
  'fixa-new': () => { modal = { type: 'fixa', id: null, draft: { desc: '', type: 'out', amount: '', day: new Date().getDate(), cat: 'Outros', match: '', card: false, variable: false, active: true, from: '', until: '' } }; render(); },
  'fixa-edit': (el) => { const r = state.recurring.find((x) => x.id === el.dataset.id); if (!r) return; modal = { type: 'fixa', id: r.id, draft: { desc: r.desc, type: r.type, amount: r.amount, day: r.day, cat: r.cat, match: r.match || '', card: !!r.card, variable: !!r.variable, active: r.active !== false, from: r.from || '', until: r.until || '' } }; render(); },
  'fixa-from': (el) => {
    const t = state.txns.find((x) => x.id === Number(el.dataset.id)); if (!t) return;
    const parts = t.desc.split(' · '); const nome = (parts.length > 1 ? parts.slice(1).join(' ') : parts[0]).toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
    const type = t.amount > 0 ? 'in' : 'out';
    modal = { type: 'fixa', id: null, draft: { desc: nome, type, amount: Math.abs(t.amount), day: Number(t.date.slice(8)), cat: catsFor(type).includes(t.cat) ? t.cat : (type === 'in' ? 'Outros' : 'Outros'), match: keywordFor(t.desc), card: false, variable: false, active: true, from: '', until: '' } }; render();
  },
  'sug-add': (el) => { const x = suggestFixed(state)[Number(el.dataset.i)]; if (!x) return; modal = { type: 'fixa', id: null, draft: { desc: x.desc.split(' · ').slice(-1)[0], type: x.type, amount: x.amount, day: x.day, cat: catsFor(x.type).includes(x.cat) ? x.cat : 'Outros', match: x.match, card: false, variable: x.variable, active: true, from: '', until: '' } }; render(); },
  'sug-ignore': (el) => commit(ignoreSuggestion(state, el.dataset.key), 'Ignorado'),
  'fixa-save': () => {
    const v = numRaw('fv'); const nome = document.getElementById('fn').value.trim();
    if (!nome) return toast('Dê um nome para a conta.');
    if (!(v > 0)) return toast('Digite o valor.');
    const g = (id) => document.getElementById(id);
    const rec = { id: modal.id, desc: nome, type: g('ft').value, amount: v, day: Number(g('fd').value) || 1, cat: g('fc').value, match: g('fm').value, card: !!g('fcard')?.checked, variable: g('fvar').checked, active: g('fact').checked, from: g('ffrom').value, until: g('funtil').value };
    modal = null; commit(saveRecurring(state, rec), 'Conta fixa salva');
  },
  'fixa-del': () => { if (!confirm('Apagar esta conta fixa? Os lançamentos do extrato continuam, como gastos comuns.')) return; const id = modal.id; modal = null; commit(removeRecurring(state, id), 'Conta fixa apagada'); },
  'fixa-skip': (el) => commit(setSkip(state, el.dataset.id, el.dataset.due, true), 'Marcado: não teve neste mês'),
  'fixa-unskip': (el) => commit(setSkip(state, el.dataset.id, el.dataset.due, false), 'Voltou a valer'),
  'fatura-save': (el) => { const v = numRaw('fat'); if (!(v > 0)) return toast('Digite o valor da fatura.'); commit(setFatura(state, el.dataset.due, v), 'Fatura salva'); },
  'fatura-clear': (el) => commit(setFatura(state, el.dataset.due, 0), 'Voltou à estimativa'),
  'fx-per': (el) => { Object.assign(fx, periodo(el.dataset.k)); render(); },
  'fx-rev': () => { fx.status = fx.status === 'review' ? '' : 'review'; render(); },
  'fx-clear': () => { fx = { q: '', from: '', to: '', cat: '', type: '', acct: '', status: '', min: '', max: '', sort: 'date' }; render(); },
  'ai-save': () => { const k = document.getElementById('aik').value.trim(); const m = document.getElementById('aim').value.trim(); const c = aiCfg(); if (k) c.key = k; c.model = m || DEFAULT_MODEL; try { localStorage.setItem(AI_KEY, JSON.stringify(c)); } catch { /* sem armazenamento */ } toast('Assistente configurado'); render(); },
  'ai-clear': () => { try { localStorage.removeItem(AI_KEY); } catch { /* ok */ } toast('Chave removida'); render(); },
  'chat-open': () => { modal = { type: 'chat' }; render(); setTimeout(() => { const l = document.getElementById('chatlog'); if (l) l.scrollTop = l.scrollHeight; document.getElementById('chatin')?.focus(); }, 30); },
  'chat-new': () => { chat = { history: [], log: [], pending: [], busy: false }; render(); },
  'chat-send': async () => {
    const inp = document.getElementById('chatin'); const text = inp?.value.trim(); if (!text || chat.busy) return;
    chat.log.push({ role: 'user', text }); chat.busy = true; render(); scrollChat();
    const cfg = aiCfg();
    if (!cfg.key) { const r = localAsk(state, text, today()); chat.pending.push(...r.proposals); chat.log.push({ role: 'ai', text: r.text }); chat.busy = false; render(); scrollChat(); document.getElementById('chatin')?.focus(); return; }
    try {
      const r = await askAI({ state, history: [...chat.history, { role: 'user', content: text }], apiKey: cfg.key, model: cfg.model, today: today() });
      chat.history = r.history; chat.pending.push(...r.proposals); chat.log.push({ role: 'ai', text: r.text || (r.proposals.length ? 'Preparei estas mudanças. Confira abaixo.' : 'Sem resposta.') });
    } catch (e) { chat.log.push({ role: 'err', text: e.message || 'Não consegui falar com o assistente.' }); chat.history = chat.history.slice(); }
    chat.busy = false; render(); scrollChat(); document.getElementById('chatin')?.focus();
  },
  'prop-ok': (el) => { const p = chat.pending[Number(el.dataset.i)]; if (!p) return; const r = applyTool(state, p.name, p.input); chat.pending.splice(Number(el.dataset.i), 1); chat.log.push({ role: 'ai', text: '✓ ' + r.msg }); chat.history.push({ role: 'user', content: `[app] O usuário aplicou: ${p.label}` }, { role: 'assistant', content: [{ type: 'text', text: 'Anotado.' }] }); commit(r.state, r.msg); scrollChat(); },
  'prop-no': (el) => { const p = chat.pending.splice(Number(el.dataset.i), 1)[0]; if (p) chat.history.push({ role: 'user', content: `[app] O usuário descartou: ${p.label}` }, { role: 'assistant', content: [{ type: 'text', text: 'Ok, descartado.' }] }); render(); scrollChat(); },
  'rev-mode': (el) => { revMode = el.dataset.v; render(); },
  'pick-cat': (el) => { picked[el.dataset.key] = el.dataset.cat; render(); },
  confirm: (el) => {
    const key = el.dataset.key; const cat = picked[key]; if (!cat) return;
    const g = reviewGroups(state).find((x) => x.key === key);
    delete picked[key];
    commit(confirmGroup(state, key, cat, g?.kind), `Anotado: ${g?.desc || 'lançamento'} → ${cat}`);
  },
  filter: (el) => { filter = el.dataset.f; render(); },
  month: (el) => { monthYM = addMonths(monthYM || monthOf(today()), Number(el.dataset.d)); render(); },
  'sim-add': () => { modal = { type: 'sim', entrada: false }; render(); },
  'sim-kind': (el) => { modal.entrada = el.dataset.v === '1'; render(); },
  'sim-save': () => {
    const v = num('sv1');
    if (!(v > 0)) return toast('Digite o valor.');
    const next = addSim(state, { date: document.getElementById('sdt').value || today(), amount: modal.entrada ? v : -v, label: document.getElementById('sd1').value.trim() });
    modal = null; commit(next, 'Simulação adicionada');
  },
  'sim-del': (el) => commit(removeSim(state, Number(el.dataset.id)), 'Simulação removida'),
  'sim-clear': () => commit(clearSims(state), 'Simulações removidas'),
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
    s.config.salaryFrom = Math.max(1, Math.min(28, Number(document.getElementById('sf').value) || 26));
    const sal = s.recurring.find(isSalary); if (sal) sal.day = Math.max(1, Math.min(28, Number(document.getElementById('sd').value) || sal.day));
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
  if (v) { if (modal && modal.type === 'chat') modal = null; view = v.dataset.view; location.hash = '#/' + view; window.scrollTo(0, 0); render(); return; }
  if (e.target.classList?.contains('scrim') && modal && modal.type !== 'import') { modal = null; render(); return; }
  const a = e.target.closest('[data-act]');
  if (!a || a.tagName === 'INPUT') return;
  actions[a.dataset.act]?.(a, e);
});
function scrollChat() { setTimeout(() => { const l = document.getElementById('chatlog'); if (l) l.scrollTop = l.scrollHeight; }, 20); }
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'chatin') { e.preventDefault(); actions['chat-send'](); } });
// filtros do extrato: atualiza só a lista, sem perder o foco da busca
function onFx(e) {
  const k = e.target.dataset?.fx; if (!k || view !== 'lancamentos') return;
  fx[k] = e.target.value; const l = document.getElementById('lista'); if (l) l.innerHTML = listaExtrato();
}
document.addEventListener('input', onFx);
// guarda o que foi digitado na janela da conta fixa antes de redesenhá-la (ao trocar Saída/Entrada)
function captureFixa() {
  const g = (id) => document.getElementById(id); const d = modal.draft;
  d.desc = g('fn').value; d.type = g('ft').value; d.amount = numRaw('fv') || ''; d.day = Number(g('fd').value) || d.day; d.cat = g('fc').value; d.match = g('fm').value;
  d.card = !!g('fcard')?.checked; d.variable = g('fvar').checked; d.active = g('fact').checked; d.from = g('ffrom').value; d.until = g('funtil').value;
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'fm' && modal?.type === 'fixa') { const el = document.getElementById('fprev'); if (el) el.textContent = previewText({ match: e.target.value, type: document.getElementById('ft').value }, matchPreview(state, e.target.value, document.getElementById('ft').value)); }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset?.fx && view === 'lancamentos') { onFx(e); return; }
  if (t.dataset?.fixaType !== undefined && modal?.type === 'fixa') { captureFixa(); modal.draft.cat = modal.draft.type === 'in' ? 'Outros' : 'Outros'; render(); return; }
  if (t.id === 'file' && t.files[0]) {
    const f = t.files[0]; const asCard = document.getElementById('asCard')?.checked;
    t.value = '';
    await importFile(f, asCard);
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
    await importFile(new File([blob], name, { type: blob.type }), false);
  } catch { /* nada compartilhado */ }
}

async function start() {
  try { const raw = localStorage.getItem(KEY); if (raw) state = JSON.parse(raw); } catch { state = null; }
  if (!state) { const seed = await (await fetch('seed.json')).json(); state = newState(seed); persist(); }
  render();
  pullIfNewer();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && (!new URLSearchParams(location.search).has('hoje') || new URLSearchParams(location.search).has('sw'))) navigator.serviceWorker.register('sw.js').catch(() => {});
  await takeSharedFile();
}
window.__app = { get state() { return state; }, importText: (t, n, c) => importText(t, n, c), render };
start();
