# OIKONOMIA Conciliação — etapa 1

App web (celular e computador) que lê o extrato do banco, dá baixa nos previstos da sua planilha, confere o saldo com o banco e projeta os próximos 60 dias.

## O que já faz

- **Importar extrato** OFX ou CSV (também fatura do cartão). Ignora o que já entrou, mesmo se o arquivo se sobrepõe a um anterior ou vem em outro formato.
- **Conferência de saldo:** faixa verde quando o saldo calculado bate com o do banco; vermelha quando não bate, apontando o lançamento que explica a diferença.
- **Baixa automática dos previstos:** os fixos da sua aba Recorrentes (academia, Tim, faculdade...) viram "paga" quando o débito aparece no extrato. Sem débito, aparece "sem débito".
- **Fila de revisão por estabelecimento:** você confirma uma vez e o app lembra nas próximas.
- **Fixos, avulsos e cartão** separados, com o cartão pesando no banco só no dia da fatura.
- **Projeção de 60 dias**, aviso do dia em que o saldo fica negativo e "pode gastar até o fim do mês".
- **Gasto em dinheiro ou no cartão** lançado na hora (botão "+ Gasto"). O que você anota na conta é só confirmado quando o extrato chega, sem duplicar.
- **Instala no celular** e recebe o extrato pelo menu "Compartilhar" do Android.
- **Planilha do Google (opcional):** envia uma cópia legível para abas novas (`Conc_*`) sem mexer nas suas abas.

## Dados que vieram da sua planilha

- Saldo inicial: **R$ 2,41 em 23/10** (aba Extrato Out). Lançamentos até 23/10 são ignorados, porque já estão nesse saldo. No primeiro extrato, baixe de 24/10 até hoje.
- Previstos: os 17 itens da aba Recorrentes (Vale Alimentação continua desligado, como na planilha).
- Dízimo automático de 10% das entradas, no último dia do mês.
- Gastos do dia a dia previstos: R$ 400/mês, até o app ter 20 dias de histórico. Depois usa a sua média real dos últimos 30 dias.
- Cartão: vence dia 16 (da sua planilha) e **fecha dia 8 (suposição minha)**. Confira na sua fatura e ajuste em Ajustes. Isso define em qual mês cada compra cai.

## Como testar agora, no computador

Precisa do Node 20 ou mais novo.

    node serve.mjs          # abre em http://localhost:8080
    node --test tests/*.test.mjs   # 26 testes

Na tela, use **Importar extrato** e escolha `samples/extrato-exemplo.ofx` (dados inventados). Os valores dos testes (saldo R$ 599,70, fatura de R$ 333,13, dízimo de R$ 234,74) saem desse arquivo.

## Como publicar para usar no celular

O app é só arquivos estáticos, mas precisa de endereço **https** para instalar no celular e receber arquivos compartilhados.

1. Hospede a pasta inteira. Opções simples e gratuitas: Cloudflare Pages, Netlify ou GitHub Pages. A sua hospedagem da Locaweb também serve, se tiver certificado https.
2. **Atenção à privacidade:** `seed.json` contém os seus previstos (nomes das contas e valores, inclusive o salário). Hospedagem pública deixa esse arquivo acessível a quem tiver o endereço. Prefira hospedagem com senha/acesso restrito, ou troque os valores do `seed.json` por exemplos e acerte tudo depois em Ajustes.
3. No celular, abra o endereço no Chrome > menu ⋮ > **Instalar app**.
4. No app do banco, gere o extrato (OFX ou CSV) e use **Compartilhar > Conciliação**.

Os dados ficam no navegador de cada aparelho. Para usar em dois aparelhos, use a sincronização com a planilha ou **Ajustes > Baixar cópia**.

## Planilha do Google (opcional)

Passo a passo no topo do arquivo `apps-script/Code.gs`: colar o script na planilha, definir uma senha (propriedade `TOKEN`), publicar como app da web e colar o endereço e a senha em **Ajustes > Planilha do Google**.

## O que NÃO foi testado (leia antes de confiar)

- **Extrato real do BB:** só testei com arquivos de exemplo que eu mesmo criei, em OFX e em dois formatos de CSV. O formato real pode exigir um ajuste no leitor. Mande um exemplo (valores podem ser apagados).
- **Compartilhar pelo Android:** simulei o envio do arquivo ao app e funcionou. O menu "Compartilhar" do seu Chrome e do app do banco não foram testados. O Chrome do Android precisa ter instalado o app (passo 3).
- **Apps Script:** o código passa na verificação de sintaxe e o lado do app foi testado com um servidor simulado, mas não rodei contra uma planilha do Google de verdade.
- **Fatura do cartão em arquivo:** o leitor aceita, mas não foi testado com uma fatura real. Parcelas ainda não têm tela própria.
- Os números das capturas de tela e dos testes vêm de dados de exemplo.

## O que ainda não existe (próximas etapas)

Edição de previstos e criação de novos dentro do app (hoje só liga/desliga), parcelas do cartão, orçamento por categoria, gráficos de meses anteriores.

## Arquivos

- `index.html`, `app.css`, `app.js`: telas.
- `src/`: regras (leitura de OFX/CSV, baixa dos previstos, conferência, cartão, projeção).
- `tests/`: 26 testes automáticos.
- `sw.js`, `manifest.webmanifest`, `icons/`: instalação no celular e recebimento de arquivo.
- `apps-script/Code.gs`: ponte com a planilha.
- `samples/`: extratos de exemplo (dados inventados).
- `seed.json`: seus previstos e configurações, tirados da planilha.
