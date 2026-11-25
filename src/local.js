// Assistente local: entende comandos em português SEM internet e SEM chave (grátis e privado).
// Mesma regra do assistente com IA: só lê; mudanças viram propostas que você confirma.
import { CATS_IN, CATS_OUT } from './rules.js';
import { filterTxns } from './filter.js';
import { reviewGroups } from './ledger.js';
import { monthPlan, monthView, currentBalance, nextFaturaDue } from './summary.js';
import { podeGastar } from './forecast.js';
import { audit } from './audit.js';
import { addMonths, brl, merchantKey, monthOf } from './util.js';
import { describe } from './assistant.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const CATS = [...new Set([...CATS_OUT, ...CATS_IN])];
const num = (s) => { const t = String(s).replace(/[^\d.,]/g, ''); if (!t) return NaN; return Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); };
const cap = (s) => s.replace(/(^|\s)\S/g, (m) => m.toUpperCase());

function findCat(txt) {
  const n = norm(txt).replace(/[."']/g, '');
  if (!n) return null;
  return CATS.find((c) => norm(c) === n) || CATS.find((c) => norm(c).includes(n) || n.includes(norm(c))) || CATS.find((c) => norm(c).split(/[ /]/).some((w) => w.length > 3 && n.startsWith(w.slice(0, 5))));
}
function period(n, today) {
  const ym = monthOf(today);
  if (/\bhoje\b/.test(n)) return { from: today, to: today, label: 'hoje' };
  if (/(mes passado|mes anterior)/.test(n)) { const p = addMonths(ym, -1); return { from: p + '-01', to: p + '-31', label: 'no mês passado' }; }
  if (/(ultimos 30|30 dias)/.test(n)) { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - 30); return { from: d.toISOString().slice(0, 10), to: today, label: 'nos últimos 30 dias' }; }
  if (/(tudo|sempre|todo o periodo|desde o inicio)/.test(n)) return { from: '', to: '', label: 'em todo o período' };
  return { from: ym + '-01', to: ym + '-31', label: 'neste mês' };
}
const strip = (n) => n.replace(/\b(neste mes|este mes|mes passado|mes anterior|ultimos 30 dias|30 dias|hoje|sempre|tudo|no mes|do mes)\b/g, ' ').replace(/\s+/g, ' ').trim();
const lines = (list, n = 8) => list.slice(0, n).map((t) => `• ${t.date.slice(8)}/${t.date.slice(5, 7)}  ${String(t.desc).slice(0, 42)}  ${brl(t.amount)}${t.cat ? ' · ' + t.cat : ''}`).join('\n') + (list.length > n ? `\n… e mais ${list.length - n}` : '');

export const AJUDA = `Posso ajudar com (sem internet e sem custo):
• "o que falta revisar?"
• "quanto gastei com mercado este mês?" (também: mês passado, últimos 30 dias)
• "mostra o iFood" / "busca pix"
• "marca tudo do iFood como Alimentação"
• "cria conta fixa Netflix 55,90 dia 12" (acrescente "no cartão" se for o caso)
• "apagar duplicados"
• "fatura 1234,56" (valor real da fatura que vence)
• "saldo", "resumo do mês", "quanto posso gastar"`;

export function localAsk(state, textRaw, today) {
  const text = String(textRaw || '').trim(); const n = norm(text).replace(/[?!]+/g, '').replace(/\s+/g, ' ').trim();
  const out = (t, proposals = []) => ({ text: t, proposals: proposals.map((p) => ({ ...p, label: describe(state, p.name, p.input) })) });
  if (!n) return out(AJUDA);
  if (/^(ajuda|help|oi|ola|o que voce faz|comandos)/.test(n)) return out(AJUDA);

  // marcar / categorizar
  let m = n.match(/(?:marca|marque|categoriza|categorize|classifica|classifique|coloca|ponha|poe)\s+(?:tudo\s+)?(?:que\s+)?(?:(?:do|da|de|dos|das|o|a|os|as)\s+)?(.+?)\s+(?:como|em|para|pra)\s+(.+)$/);
  if (m) {
    const cat = findCat(m[2]);
    if (!cat) return out(`Não achei a categoria "${m[2]}". Categorias: ${CATS.join(', ')}.`);
    const r = filterTxns(state, { q: m[1], sort: 'date' });
    const alvo = r.list.filter((t) => (t.cat || '') !== cat && ((cat === 'Salário' || CATS_IN.includes(cat)) ? t.amount > 0 : t.amount < 0 || CATS_IN.includes(cat) === false));
    if (!r.count) return out(`Não encontrei lançamentos com "${m[1]}".`);
    if (!alvo.length) return out(`Os ${r.count} lançamento(s) de "${m[1]}" já estão como ${cat}.`);
    return out(`Achei ${alvo.length} lançamento(s) de "${m[1]}":\n${lines(alvo)}\n\nPropus marcar como ${cat} e lembrar para os próximos. Toque em Aplicar para confirmar.`, [{ name: 'categorizar', input: { ids: alvo.map((t) => t.id), categoria: cat, lembrar: true } }]);
  }

  // conta fixa
  m = n.match(/conta fixa\s+(?:de\s+|do\s+|da\s+)?(.+?)\s+(?:de\s+)?(?:r\$\s*)?(\d[\d.,]*)(?:\s*reais)?(?:\s+(?:todo\s+)?dia\s+(\d{1,2}))?(.*)$/);
  if (m) {
    const nome = cap(m[1].replace(/\s+(de|no|na|em)$/, '')); const valor = num(m[2]); const dia = m[3] ? Number(m[3]) : null; const resto = m[4] || '';
    if (!(valor > 0)) return out('Qual o valor da conta? Ex.: "cria conta fixa Netflix 55,90 dia 12".');
    if (!dia || dia < 1 || dia > 31) return out(`Em que dia do mês "${nome}" costuma vir? Ex.: "cria conta fixa ${nome} ${String(valor).replace('.', ',')} dia 12".`);
    const entrada = /(entrada|recebo|receber|renda)/.test(n);
    return out(`Propus cadastrar a conta fixa. Confira e toque em Aplicar. Depois, em Fixas, você pode ajustar a palavra-chave do extrato.`, [{ name: 'criar_conta_fixa', input: { nome, tipo: entrada ? 'in' : 'out', valor, dia, categoria: entrada ? 'Outros' : (/netflix|spotify|youtube|disney|prime|assinatura/.test(n) ? 'Assinaturas' : 'Outros'), palavra_chave: norm(nome), no_cartao: /cartao/.test(resto + n.replace(/conta fixa/, '')) } }]);
  }

  // duplicados
  if (/(duplicad|repetid)/.test(n)) {
    const g = new Map();
    for (const t of state.txns) { if (t.acct !== 'banco') continue; const k = `${t.date}|${t.amount}|${merchantKey(t.desc)}`; (g.get(k) || g.set(k, []).get(k)).push(t); }
    const extras = []; for (const l of g.values()) if (l.length > 1) extras.push(...l.slice(1));
    if (!extras.length) return out('Não achei lançamentos repetidos (mesma data, valor e estabelecimento).');
    return out(`Achei ${extras.length} possível(is) duplicado(s):\n${lines(extras)}\n\nCuidado: duas compras iguais no mesmo dia podem ser reais. Confira cada proposta antes de aplicar.`, extras.slice(0, 6).map((t) => ({ name: 'apagar_lancamento', input: { id: t.id } })));
  }

  // fatura
  m = n.match(/fatura.*?(?:r\$\s*)?(\d[\d.,]*)/);
  if (m && num(m[1]) > 0 && !/quanto|qual|vence/.test(n)) {
    const due = nextFaturaDue(state, today);
    return out(`Propus registrar a fatura que vence em ${due.slice(8)}/${due.slice(5, 7)} como ${brl(num(m[1]))}.`, [{ name: 'definir_fatura', input: { vencimento: due, valor: num(m[1]) } }]);
  }

  // revisar
  if (/(revis|falta|pendente|sem categoria)/.test(n)) {
    const gs = reviewGroups(state); const total = gs.reduce((s, g) => s + g.count, 0);
    if (!total) return out('Nada esperando revisão. 🎉');
    return out(`${total} lançamento(s) esperando revisão, em ${gs.length} grupo(s). Os primeiros:\n${gs.slice(0, 6).map((g) => `• ${g.firstDate.slice(8)}/${g.firstDate.slice(5, 7)}  ${String(g.desc).slice(0, 40)}  (${g.count}x, ${brl(g.total)})`).join('\n')}\n\nDica: diga "marca tudo do <nome> como <categoria>" ou use a aba Revisar.`);
  }

  // quanto gastei / recebi
  if ((/(quanto|total).*(gast|recebi|entrou|saiu)/.test(n) && !/(posso|pode)/.test(n)) || /^gastos? (com|em|de)/.test(n)) {
    const p = period(n, today); const recebeu = /(recebi|entrou)/.test(n);
    const q = strip(n.replace(/.*?\b(?:com|em|no|na|de|do|da|nos|nas)\s+/, '')).replace(/\b(gastei|recebi|gastos?|este|neste)\b/g, '').trim();
    const cat = q ? findCat(q) : null;
    const r = filterTxns(state, { q: cat ? '' : q, cat: cat || '', from: p.from, to: p.to, type: recebeu ? 'in' : 'out' });
    const alvo = q ? `com ${cat || q}` : '';
    if (!r.count) return out(`Não encontrei ${recebeu ? 'entradas' : 'gastos'} ${alvo} ${p.label}.`);
    return out(`${recebeu ? 'Recebeu' : 'Gastou'} ${brl(Math.abs(recebeu ? r.entradas : r.saidas))} ${alvo} ${p.label} (${r.count} lançamento${r.count > 1 ? 's' : ''}).\n${lines(r.list, 6)}`);
  }

  // mostrar / buscar
  m = n.match(/^(?:mostra|mostre|busca|buscar|procura|procure|ver|lista|liste|achar|acha)\s+(?:os\s+|as\s+|o\s+|a\s+|tudo\s+(?:do|da|de)\s+)?(.+)$/);
  if (m) {
    const p = period(n, today); const q = strip(m[1]); const cat = findCat(q);
    const r = filterTxns(state, { q: cat ? '' : q, cat: cat || '', from: /(mes|hoje|dias)/.test(n) ? p.from : '', to: /(mes|hoje|dias)/.test(n) ? p.to : '' });
    if (!r.count) return out(`Não encontrei nada com "${q}".`);
    return out(`${r.count} lançamento(s) com "${q}" — entradas ${brl(r.entradas)}, saídas ${brl(r.saidas)}:\n${lines(r.list, 10)}`);
  }

  // saldo / resumo / pode gastar
  if (/(vai sobrar|quanto sobra|sobrara|sobra prevista)/.test(n)) {
    const ym = addMonths(monthOf(today), 1); const mp = monthPlan(state, ym); const nm = ym.slice(5) + '/' + ym.slice(0, 4);
    return out(`Previsão de ${nm}:\nEntradas ${brl(mp.totalEntradas)} − contas fixas ${brl(mp.totalFixos)} − fatura do cartão ${brl(mp.cartao)} = sobra das contas ${brl(mp.sobraContas)}.\nDepois do dízimo (${brl(mp.dizimo)}) e dos gastos do dia a dia (${brl(mp.avulsos)}), sobra final ${brl(mp.sobra)}.`);
  }
  if (/(quanto posso|posso gastar|pode gastar)/.test(n)) {
    const g = podeGastar(state, today);
    return out(`Até o fim do mês você pode gastar cerca de ${brl(g.value)} (${brl(g.perDay)} por dia, ${g.daysLeft} dias).\nConta: saldo ${brl(g.balance)}${g.reservado ? ` − ${brl(g.reservado)} do salário do mês que vem, que já caiu mas é para as contas de lá` : ''} − ${brl(g.committed)} que ainda vai sair neste mês.`);
  }
  if (/(resumo|fechamento|como estou|situacao)/.test(n)) {
    const ym = monthOf(today); const v = monthView(state, ym, today); const a = audit(state, ym, today);
    const att = a.items.filter((i) => i.level !== 'ok' && i.level !== 'info').slice(0, 5).map((i) => `• ${i.title}`).join('\n');
    return out(`Mês ${ym.slice(5)}/${ym.slice(0, 4)}: recebido até agora ${brl(v.entradas)} (só o já revisado), contas fixas ${brl(v.fixosTotal)}, dia a dia ${brl(v.avulsosTotal)}, fatura prevista ${brl(v.fatura.total)}.${att ? `\nAtenção:\n${att}` : '\nTudo em ordem no fechamento.'}`);
  }
  if (/saldo/.test(n)) return out(`Saldo calculado da conta: ${brl(currentBalance(state))}${state.bank ? `. Saldo informado pelo banco em ${state.bank.date.slice(8)}/${state.bank.date.slice(5, 7)}: ${brl(state.bank.amount)}` : ''}.`);

  // última tentativa: busca simples pelo texto
  const q = strip(n); const r = q.length > 2 ? filterTxns(state, { q }) : { count: 0 };
  if (r.count) return out(`Não entendi o comando, mas achei ${r.count} lançamento(s) com "${q}":\n${lines(r.list, 6)}\n\nDigite "ajuda" para ver o que sei fazer.`);
  return out(`Não entendi. ${AJUDA}`);
}
