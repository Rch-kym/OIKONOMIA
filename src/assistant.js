// Assistente de conversa: usa a chave de API do próprio usuário (guardada só neste navegador).
// Ele LÊ os dados livremente, mas qualquer mudança vira uma PROPOSTA que o usuário confirma com um toque.
import { CATS_IN, CATS_OUT } from './rules.js';
import { confirmGroup, removeRecurring, removeTxn, saveRecurring, setFatura, setSkip, updateTxn } from './ledger.js';
import { filterTxns } from './filter.js';
import { monthView, currentBalance, reconcile } from './summary.js';
import { audit } from './audit.js';
import { brl, merchantKey } from './util.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const str = (d) => ({ type: 'string', description: d });
const FILTROS = {
  texto: str('palavras da descrição (sem acento), ex.: "ifood"'), de: str('data inicial AAAA-MM-DD'), ate: str('data final AAAA-MM-DD'),
  categoria: str('categoria exata'), tipo: { type: 'string', enum: ['in', 'out'], description: 'in = entradas, out = saídas' },
  conta: { type: 'string', enum: ['banco', 'cartao', 'dinheiro'] }, situacao: { type: 'string', enum: ['review', 'ok'], description: 'review = ainda sem categoria confirmada' },
  valor_min: { type: 'number' }, valor_max: { type: 'number' },
};
export const TOOLS = [
  { name: 'buscar_lancamentos', description: 'Procura lançamentos (extrato) com filtros. Devolve até 40 linhas e os totais de tudo que bateu.', input_schema: { type: 'object', properties: FILTROS } },
  { name: 'resumo_do_mes', description: 'Resumo de um mês: entradas, fixos, gastos avulsos por categoria, fatura do cartão e pontos de atenção do fechamento.', input_schema: { type: 'object', properties: { mes: str('AAAA-MM, vazio = mês atual') } } },
  { name: 'listar_contas_fixas', description: 'Lista as contas fixas cadastradas (id, valor, dia, palavra-chave).', input_schema: { type: 'object', properties: {} } },
  { name: 'categorizar', description: 'PROPOSTA: define a categoria de lançamentos. Com lembrar=true cria regra para o mesmo estabelecimento.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } }, categoria: str('uma das categorias válidas'), lembrar: { type: 'boolean' } }, required: ['ids', 'categoria'] } },
  { name: 'criar_conta_fixa', description: 'PROPOSTA: cadastra uma conta fixa (saída ou entrada que se repete todo mês).', input_schema: { type: 'object', properties: { nome: str(''), tipo: { type: 'string', enum: ['in', 'out'] }, valor: { type: 'number' }, dia: { type: 'number' }, categoria: str(''), palavra_chave: str('como aparece no extrato'), no_cartao: { type: 'boolean' }, valor_varia: { type: 'boolean' }, inicio: str('AAAA-MM'), fim: str('AAAA-MM, para parcelas') }, required: ['nome', 'tipo', 'valor', 'dia'] } },
  { name: 'editar_conta_fixa', description: 'PROPOSTA: altera campos de uma conta fixa existente (use o id de listar_contas_fixas).', input_schema: { type: 'object', properties: { id: str(''), nome: str(''), valor: { type: 'number' }, dia: { type: 'number' }, categoria: str(''), palavra_chave: str(''), valor_varia: { type: 'boolean' }, ativa: { type: 'boolean' }, fim: str('AAAA-MM') }, required: ['id'] } },
  { name: 'nao_teve_neste_mes', description: 'PROPOSTA: marca que uma conta fixa não teve cobrança num vencimento.', input_schema: { type: 'object', properties: { id: str(''), vencimento: str('AAAA-MM-DD') }, required: ['id', 'vencimento'] } },
  { name: 'apagar_lancamento', description: 'PROPOSTA: apaga um lançamento (ex.: duplicado).', input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'definir_fatura', description: 'PROPOSTA: informa o valor real da fatura do cartão que vence numa data (valor 0 remove).', input_schema: { type: 'object', properties: { vencimento: str('AAAA-MM-DD'), valor: { type: 'number' } }, required: ['vencimento', 'valor'] } },
];
const WRITE = new Set(['categorizar', 'criar_conta_fixa', 'editar_conta_fixa', 'nao_teve_neste_mes', 'apagar_lancamento', 'definir_fatura']);

const row = (t) => ({ id: t.id, data: t.date, valor: t.amount, descricao: String(t.desc).slice(0, 80), categoria: t.cat || '', conta: t.acct, situacao: t.status === 'review' ? 'review' : 'ok' });

export function readTool(state, name, inp, today) {
  if (name === 'buscar_lancamentos') {
    const r = filterTxns(state, { q: inp.texto, from: inp.de, to: inp.ate, cat: inp.categoria, type: inp.tipo, acct: inp.conta, status: inp.situacao, min: inp.valor_min, max: inp.valor_max });
    return { total_encontrado: r.count, soma_entradas: r.entradas, soma_saidas: r.saidas, saldo_do_filtro: r.total, mostrando: Math.min(40, r.count), lancamentos: r.list.slice(0, 40).map(row) };
  }
  if (name === 'resumo_do_mes') {
    const ym = inp.mes || today.slice(0, 7); const v = monthView(state, ym, today); const a = audit(state, ym, today);
    return { mes: ym, entradas_recebidas: v.entradas, fixos_total: v.fixosTotal, avulsos_por_categoria: v.avulsos, avulsos_total: v.avulsosTotal, fatura: { vencimento: v.fatura.due, total: v.fatura.total, digitada: v.fatura.manual != null }, atencao: a.items.filter((i) => i.level !== 'ok').map((i) => ({ nivel: i.level, titulo: i.title, detalhe: i.detail })) };
  }
  if (name === 'listar_contas_fixas') return state.recurring.map((r) => ({ id: r.id, nome: r.desc, tipo: r.type, valor: r.amount, dia: r.day, categoria: r.cat, palavra_chave: r.match || '', no_cartao: !!r.card, valor_varia: !!r.variable, ativa: r.active !== false, inicio: r.from || '', fim: r.until || '' }));
  return { erro: 'ferramenta desconhecida' };
}

// Texto curto, em português, do que a proposta fará.
export function describe(state, name, inp) {
  const t = (id) => state.txns.find((x) => x.id === id);
  if (name === 'categorizar') { const ls = (inp.ids || []).map(t).filter(Boolean); return `Categorizar ${ls.length} lançamento(s) como "${inp.categoria}"${inp.lembrar ? ' e lembrar para os próximos' : ''}: ${ls.slice(0, 3).map((x) => `${x.date.slice(8)}/${x.date.slice(5, 7)} ${String(x.desc).slice(0, 28)} ${brl(x.amount)}`).join('; ')}${ls.length > 3 ? '…' : ''}`; }
  if (name === 'criar_conta_fixa') return `Criar conta fixa "${inp.nome}" (${inp.tipo === 'in' ? 'entrada' : 'saída'}) de ${brl(inp.valor)} todo dia ${inp.dia}${inp.palavra_chave ? `, extrato: "${inp.palavra_chave}"` : ''}${inp.no_cartao ? ', no cartão' : ''}${inp.fim ? `, até ${inp.fim}` : ''}`;
  if (name === 'editar_conta_fixa') { const r = state.recurring.find((x) => x.id === inp.id); return `Alterar a conta fixa "${r ? r.desc : inp.id}": ${Object.entries(inp).filter(([k]) => k !== 'id').map(([k, v]) => `${k} = ${v}`).join(', ')}`; }
  if (name === 'nao_teve_neste_mes') { const r = state.recurring.find((x) => x.id === inp.id); return `Marcar que "${r ? r.desc : inp.id}" não teve cobrança em ${inp.vencimento}`; }
  if (name === 'apagar_lancamento') { const x = t(inp.id); return x ? `Apagar o lançamento ${x.date.slice(8)}/${x.date.slice(5, 7)} "${String(x.desc).slice(0, 40)}" ${brl(x.amount)}` : `Apagar o lançamento ${inp.id} (não encontrado)`; }
  if (name === 'definir_fatura') return inp.valor > 0 ? `Fatura que vence em ${inp.vencimento}: ${brl(inp.valor)}` : `Voltar a fatura de ${inp.vencimento} para a estimativa`;
  return name;
}

// Aplica uma proposta já confirmada. Devolve { state, msg }.
export function applyTool(state, name, inp) {
  if (name === 'categorizar') {
    const valid = new Set([...CATS_IN, ...CATS_OUT]);
    if (!valid.has(inp.categoria)) return { state, msg: `Categoria inválida: ${inp.categoria}` };
    let s = state; const ids = (inp.ids || []).filter((id) => s.txns.some((t) => t.id === id));
    for (const id of ids) s = updateTxn(s, id, { cat: inp.categoria });
    if (inp.lembrar && ids.length) { const x = s.txns.find((t) => t.id === ids[0]); s = confirmGroup(s, merchantKey(x.desc), inp.categoria, x.amount >= 0 ? 'in' : 'out'); }
    return { state: s, msg: `${ids.length} lançamento(s) categorizado(s)` };
  }
  if (name === 'criar_conta_fixa') return { state: saveRecurring(state, { desc: inp.nome, type: inp.tipo, amount: inp.valor, day: inp.dia, cat: inp.categoria || 'Outros', match: inp.palavra_chave || '', card: !!inp.no_cartao, variable: !!inp.valor_varia, active: true, from: inp.inicio || '', until: inp.fim || '' }), msg: 'Conta fixa criada' };
  if (name === 'editar_conta_fixa') {
    const r = state.recurring.find((x) => x.id === inp.id); if (!r) return { state, msg: 'Conta fixa não encontrada' };
    return { state: saveRecurring(state, { ...r, desc: inp.nome ?? r.desc, amount: inp.valor ?? r.amount, day: inp.dia ?? r.day, cat: inp.categoria ?? r.cat, match: inp.palavra_chave ?? r.match, variable: inp.valor_varia ?? r.variable, active: inp.ativa ?? r.active, until: inp.fim ?? r.until }), msg: 'Conta fixa atualizada' };
  }
  if (name === 'nao_teve_neste_mes') return { state: setSkip(state, inp.id, inp.vencimento, true), msg: 'Marcado: não teve neste mês' };
  if (name === 'apagar_lancamento') return { state: removeTxn(state, inp.id), msg: 'Lançamento apagado' };
  if (name === 'definir_fatura') return { state: setFatura(state, inp.vencimento, inp.valor), msg: 'Fatura atualizada' };
  return { state, msg: 'Nada a fazer' };
}

export function systemPrompt(state, today) {
  const rec = state.recurring.filter((r) => r.active !== false).length;
  return `Você é o assistente do app OIKONOMIA Conciliação, de finanças pessoais de um usuário brasileiro. Responda sempre em português do Brasil, curto e direto.
Hoje é ${today}. Saldo calculado da conta: ${brl(currentBalance(state))}. Há ${state.txns.length} lançamentos, ${state.txns.filter((t) => t.status === 'review').length} esperando revisão e ${rec} contas fixas ativas.
Regras: (1) use as ferramentas de leitura para olhar os dados em vez de supor; (2) tudo que muda dados é uma PROPOSTA que o usuário confirma com um toque, então nunca diga que já foi feito, diga "propus" e peça para tocar em Aplicar; (3) agrupe propostas parecidas numa única chamada (vários ids); (4) não invente lançamentos, valores nem categorias; (5) se faltar informação, pergunte.
Categorias de saída: ${CATS_OUT.join(', ')}. Categorias de entrada: ${CATS_IN.join(', ')}.
Salário cai entre o dia ${state.config.salaryFrom ?? 26} do mês anterior e o dia 5, e conta como salário do mês seguinte. "Pagto cartão crédito" no extrato é o pagamento da fatura, não gasto novo. Valores: saídas negativas, entradas positivas.`;
}

// Uma rodada de conversa. history: mensagens no formato da API. Devolve { text, proposals, history }.
export async function ask({ state, history, apiKey, model, today, fetchImpl = fetch, maxRounds = 6 }) {
  const msgs = history.slice(); const proposals = []; let text = '';
  for (let round = 0; round < maxRounds; round++) {
    const res = await fetchImpl(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, max_tokens: 1500, system: systemPrompt(state, today), tools: TOOLS, messages: msgs }) });
    if (!res.ok) {
      let detail = ''; try { detail = (await res.json()).error?.message || ''; } catch { /* ignora */ }
      const e = new Error(res.status === 401 ? 'Chave inválida. Confira a chave em Ajustes.' : res.status === 429 ? 'Limite de uso da chave atingido. Tente em instantes.' : `Erro ${res.status} ${detail}`.trim()); e.status = res.status; throw e;
    }
    const data = await res.json();
    msgs.push({ role: 'assistant', content: data.content });
    text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const uses = data.content.filter((b) => b.type === 'tool_use');
    if (!uses.length || data.stop_reason !== 'tool_use') break;
    const results = uses.map((u) => {
      let out;
      if (WRITE.has(u.name)) { proposals.push({ name: u.name, input: u.input, label: describe(state, u.name, u.input) }); out = { ok: true, aviso: 'Proposta registrada. O usuário ainda precisa tocar em Aplicar; não diga que foi feito.' }; }
      else { try { out = readTool(state, u.name, u.input || {}, today); } catch (e) { out = { erro: String(e.message || e) }; } }
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) };
    });
    msgs.push({ role: 'user', content: results });
  }
  return { text, proposals, history: msgs };
}
