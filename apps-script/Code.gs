/**
 * OIKONOMIA Conciliação — ponte com a planilha do Google.
 *
 * Como instalar (uma vez):
 *  1. Abra a sua planilha "Planejamento e Finanças" > Extensões > Apps Script.
 *  2. Cole este arquivo inteiro no lugar do conteúdo padrão e salve.
 *  3. Engrenagem "Configurações do projeto" > Propriedades do script > Adicionar propriedade:
 *       TOKEN = uma senha que você inventar (a mesma será digitada no app, em Ajustes).
 *  4. Implantar > Nova implantação > tipo "App da Web":
 *       Executar como: Eu  ·  Quem pode acessar: Qualquer pessoa
 *     Copie o endereço que termina em /exec e cole no app, em Ajustes > Planilha do Google.
 *
 * O app envia e recebe um único pacote JSON. Aqui ele é guardado na aba Conc_Estado (backup)
 * e espelhado em duas abas legíveis: Conc_Lancamentos e Conc_Regras.
 * Nenhuma das suas abas atuais (Painel, Outubro, Novembro...) é alterada.
 */

var TAB_STATE = 'Conc_Estado';
var TAB_TXNS = 'Conc_Lancamentos';
var TAB_RULES = 'Conc_Regras';
var CHUNK = 40000; // o limite de uma célula é 50.000 caracteres

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token) return out_({ ok: false, error: 'Defina a propriedade TOKEN no Apps Script.' });
    if (body.token !== token) return out_({ ok: false, error: 'Senha incorreta.' });
    if (body.action === 'push') return out_(push_(body));
    if (body.action === 'pull') return out_(pull_());
    return out_({ ok: false, error: 'Ação desconhecida.' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return out_({ ok: true, info: 'OIKONOMIA Conciliação: use POST.' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function push_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 1) backup: o JSON do estado, cortado em pedaços (uma linha por pedaço)
    var st = sheet_(TAB_STATE);
    st.clear();
    var json = String(body.state || '');
    var rows = [['atualizado_em', String(body.updatedAt || '')]];
    for (var i = 0; i < json.length; i += CHUNK) rows.push(['parte', json.substring(i, i + CHUNK)]);
    st.getRange(1, 1, rows.length, 2).setValues(rows);

    // 2) espelho legível
    write_(TAB_TXNS, body.lancamentos);
    write_(TAB_RULES, body.regras);
    return { ok: true, linhas: (body.lancamentos || []).length - 1 };
  } finally {
    lock.releaseLock();
  }
}

function write_(name, table) {
  var sh = sheet_(name);
  sh.clear();
  if (!table || !table.length) return;
  var width = table[0].length;
  sh.getRange(1, 1, table.length, width).setValues(table);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function pull_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_STATE);
  if (!sh || sh.getLastRow() < 2) return { ok: true, state: null };
  var vals = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  var json = '';
  for (var i = 1; i < vals.length; i++) json += String(vals[i][1]);
  return { ok: true, state: json, updatedAt: String(vals[0][1]) };
}
