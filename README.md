# Buscador de Fornecedores Amazon

> Painel que lê uma lista de anúncios da Amazon dos EUA, consulta preço e estoque em fornecedores, calcula o preço de venda e grava o resultado no Google Sheets. É um robô que desenvolvi para substituir uma pesquisa de revenda feita à mão, pensado para rodar no meu homelab.

[![testes](https://github.com/mateus-bonette00/buscador-fornecedores-amazon/actions/workflows/ci.yml/badge.svg)](https://github.com/mateus-bonette00/buscador-fornecedores-amazon/actions/workflows/ci.yml)
[![Python 3.12](https://img.shields.io/badge/python-3.12-blue.svg)](https://www.python.org/downloads/)
[![JavaScript](https://img.shields.io/badge/JavaScript-sem%20framework-F7DF1E.svg)](web/app.js)
[![Google Sheets API](https://img.shields.io/badge/Google%20Sheets-API%20v4-34A853.svg)](https://developers.google.com/workspace/sheets/api)
[![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-4285F4.svg)](chrome-extension/manifest.json)

![Painel do app em modo simulação](docs/painel.png)

A imagem mostra o modo Simulação, que usa dados de exemplo. Os testes automatizados também usam respostas simuladas. O repositório não tem dados nem nomes do negócio original.

## Roda no meu homelab

Eu rodo minhas automações e robôs no meu homelab, para o notebook de trabalho ficar livre. Quis que este projeto funcionasse do mesmo jeito: no notebook fica o painel, e o servidor faz o trabalho.

- O Chrome abre as abas dos fornecedores no servidor, sem tomar a minha tela.
- A VPN, as chaves e a credencial do Google usadas nos lotes ficam no servidor.
- O lote e o teste de fornecedor vão por SSH, com login por chave e conferência do `known_hosts`. O app não abre porta nova para a rede.
- O progresso volta para o painel produto por produto.

Há dois modos. No primeiro, o painel roda no notebook e envia o trabalho por SSH, e o notebook precisa ficar conectado até o lote terminar. No segundo, o painel inteiro vira um serviço no homelab, acessado por túnel SSH, e o lote continua mesmo com o notebook desligado. Os comandos estão em [Instalar no homelab](#instalar-no-homelab).

## O que ele faz

O app só grava um produto quando consegue confirmar a oferta. Se o título tem mais de um código possível, se um dos fornecedores não confirma o código exato ou se falta estoque, o produto fica pendente no painel com o motivo escrito.

Quando dá para confirmar, ele:

- separa o código da peça e o tamanho do pack em títulos como `Pack of 10 KQ2F11-35A`
- compara os fornecedores e escolhe um pelas regras de estoque
- calcula o preço de venda
- atualiza a linha do ASIN na planilha, ou cria uma nova, e relê para conferir preço e margem

Os lotes rodam em segundo plano, com três produtos consultados por vez, e o histórico fica em SQLite.

## Como foi feito

O backend usa só a biblioteca padrão do Python, então não há pacote para instalar com `pip`. O painel é HTML, CSS e JavaScript sem framework.

A integração com o Google Sheets não usa SDK. O app assina o JWT da conta de serviço com o `openssl` e chama a API REST.

Para ler páginas de fornecedores no navegador, fiz uma extensão do Chrome que conversa com o Python por Native Messaging e um socket Unix. Ela envia apenas os campos que o app precisa ler.

O painel atende em `127.0.0.1`, confere os cabeçalhos `Host` e `Origin`, define uma Content Security Policy e recusa redirecionamento para outro domínio. Também dá para deixar o painel no seu computador e executar os lotes em um servidor por SSH.

## Decisões de engenharia

**Recusar em caso de dúvida.** Preferi deixar um produto pendente a gravar uma oferta errada na planilha. Por isso cada pendência mostra o motivo.

**Sem dependências no backend.** Escrevi tudo com a biblioteca padrão do Python. Assim o projeto roda sem ambiente virtual e a superfície de manutenção fica menor.

**JWT assinado com OpenSSL.** Em vez de instalar o SDK do Google, eu monto o JWT da conta de serviço e chamo a API REST diretamente. São poucas linhas, e o fluxo fica visível no código.

**Extensão para páginas que exigem navegador.** Algumas páginas de fornecedor só respondem bem com uma sessão aberta no Chrome. Então ligo a extensão ao Python por Native Messaging e socket Unix.

**Limitações que eu conheço.** O cálculo assume que o pacote da loja tem o mesmo tamanho do anúncio. O leitor genérico depende do que cada site publica: sem a quantidade em estoque ou com uma faixa de preço, o produto fica pendente. Os testes usam respostas simuladas. Se eu retomasse o projeto, trocaria a leitura de páginas por catálogos oficiais.

## Arquitetura

![Diagrama com o painel web, o orquestrador em Python, os conectores de fornecedores, a extensão do Chrome, o SQLite e o Google Sheets](docs/arquitetura.png)

O arquivo editável do diagrama é o [`docs/arquitetura.html`](docs/arquitetura.html).

### Fluxo de uma pesquisa

1. Você informa a marca, escolhe os fornecedores e a origem: CSV, ASINs, links da Amazon ou uma consulta no Keepa.
2. O painel envia o lote para a API local, que coloca o pedido na fila.
3. Com uma chave do Keepa, o app busca os títulos que faltam. Se ainda faltar um título, tenta ler a página do anúncio na Amazon.
4. De cada título saem o código da peça e o tamanho do pack.
5. Os conectores consultam os fornecedores por HTTPS ou por uma aba do Chrome.
6. O app escolhe o fornecedor e calcula o preço de venda.
7. No fim do lote, os produtos aprovados vão para o Google Sheets, um por linha.
8. O app relê as linhas e só marca um produto como gravado se o preço e a margem baterem.

### Regras de negócio

| Tema | Regra |
|---|---|
| Código da peça | Precisa ser exato. Códigos parecidos são ignorados |
| Estoque mínimo | 11, ou o tamanho do pack quando ele for maior |
| Escolha entre as lojas | Motion, até o estoque da SMC chegar a 2,4 vezes o da Motion |
| Prazo | 5 dias na Motion. Na SMC, 6 com envio no mesmo dia e 7 com envio no dia seguinte |
| Frete | US$ 40 na Motion e US$ 70 na SMC |
| Preço de venda | Margem de cerca de 24%, com taxa de 15% da Amazon e US$ 7 de preparo |

Um exemplo com a Motion: o custo de US$ 17,85, mais US$ 7 de preparo e US$ 40 de frete, dá US$ 64,85. O app calcula a venda em US$ 106,31. Descontada a taxa de cerca de US$ 15,95, o lucro fica perto de US$ 25,51.

Os fornecedores usados aqui vendem por pacote, por isso o preço exibido já é o custo do pack. O app parte do princípio de que o pacote da loja é igual ao do anúncio. Ele não consulta o preço dos concorrentes.

## Como rodar

### Pré-requisitos

- Linux e Python 3 (testado no 3.12)
- Node.js, opcional, para `npm start` e `npm test`
- `openssl` e uma conta de serviço do Google Cloud, para gravar na planilha
- Google Chrome 120 ou mais recente, para a extensão
- Chave da API do Keepa, para buscar produtos por lá

### 1. Clonar

```bash
git clone https://github.com/mateus-bonette00/buscador-fornecedores-amazon.git
cd buscador-fornecedores-amazon
```

### 2. Testar com a simulação

```bash
python3 app.py      # ou: npm start
```

Abra `http://127.0.0.1:8746`, deixe a origem em Simulação e clique em "Iniciar simulação". Devem aparecer 2 produtos simulados e 1 pendente. Não precisa de conta nem de chave.

### 3. Conectar a planilha

```bash
mkdir -p ~/.config/buscador-fornecedores-amazon
cp examples/settings.example.json ~/.config/buscador-fornecedores-amazon/settings.json
```

Preencha `spreadsheet_id` e `sheet_id`. O [`docs/PLANILHA.md`](docs/PLANILHA.md) explica as colunas e como criar a conta de serviço.

### 4. Escolher de onde vêm os produtos

Sem a API do Keepa, importe um CSV com a coluna `ASIN` ou cole um ASIN ou link da `amazon.com` por linha. O arquivo [`examples/produtos-exemplo.csv`](examples/produtos-exemplo.csv) mostra o formato, com ASINs fictícios.

Para usar a API, salve a chave em `~/.config/buscador-fornecedores-amazon/keepa.key` e escolha "Consulta no Keepa" no painel. Você pode buscar pela marca ou colar o JSON de *Show API query* do Product Finder.

### 5. Adicionar os fornecedores

No painel, cole os links dos sites onde o robô deve procurar. Pode ser a página inicial, uma busca, uma categoria ou a página de um produto, com até 10 links por site e 8 sites por lote. Os links do mesmo site viram um fornecedor, com frete e prazo próprios. A lista fica salva no navegador.

![Fornecedores adicionados por link no painel](docs/fornecedores.png)

Antes do lote, use "Testar" com um part number que o site venda. O painel mostra o preço e a quantidade que leu, ou o motivo de não ter conseguido. Se você colar o link de uma busca feita com esse mesmo código, o teste troca o código por `{part}` e o robô passa a repetir a busca para cada produto.

Motion e SMC têm leitores próprios. Os outros sites passam pelo leitor genérico, que só confirma uma oferta quando a página traz:

- o código exato da peça, nos dados `schema.org` ou num rótulo como `Part Number`
- um único preço em dólar
- a quantidade em estoque (só "In stock" não basta)

O leitor genérico faz a leitura sem navegador. Sites que bloqueiam robôs ou montam a página com JavaScript ficam pendentes, e muitas lojas não publicam a quantidade.

A Motion costuma recusar a leitura direta, então use a extensão do Chrome. Registre o host local:

```bash
python3 ops/setup_chrome.py
```

Depois, em `chrome://extensions`, ative o modo do desenvolvedor, clique em "Carregar sem compactação" e selecione a pasta `chrome-extension/`. Adicione `"supplier_chrome": true` ao `settings.json` e deixe o Chrome aberto durante o lote.

A consulta à SMC precisa sair por um IP dos Estados Unidos. Você pode informar um proxy HTTP em `smc_proxy` ou usar `"smc_proton_manual": true` e conectar o Proton VPN antes de começar. O app confere a conexão pelo `nmcli`. Ligar e desligar a VPN continua com você.

## Estrutura do projeto

```
buscador-fornecedores-amazon/
├── app.py                       # Painel local, fila de lotes, SQLite e escolha do fornecedor
├── suppliers.py                 # Leitores da Motion, da SMC e leitor genérico
├── sheets.py                    # Preço de venda e gravação no Google Sheets
├── vpn.py                       # Confere a VPN antes de consultar a SMC
├── chrome_native.py             # Ponte entre o Python e a extensão
├── test_app.py                  # Testes
├── chrome-extension/
│   ├── manifest.json            # Manifest V3
│   └── worker.js                # Abre a aba, lê os campos e fecha
├── web/                         # Painel em HTML, CSS e JavaScript
├── ops/
│   ├── start.sh                 # Inicia o app, local ou com servidor remoto
│   ├── setup_chrome.py          # Registra o host da extensão
│   └── buscador-fornecedores-amazon.service
├── docs/                        # Planilha, diagrama e imagens
├── examples/                    # CSV, planilha modelo e configuração de exemplo
├── .github/workflows/ci.yml     # Testes no GitHub Actions
└── package.json
```

## Personalização

| Para mudar | Edite |
|---|---|
| Planilha de destino | `spreadsheet_id` e `sheet_id` no `settings.json` |
| Frete e prazo | Campos de cada fornecedor no painel |
| Estoque mínimo | `supplier_rules` no `app.py`, ou `suppliers` no `settings.json` para Motion e SMC |
| Preparo de um produto já gravado | Coluna "Preparo (US$)" da planilha |
| Preparo padrão | `app.py` e `sheets.py` |
| Margem e taxa da Amazon | `sheets.py`: `sold_for`, `formulas` e a conferência da margem |
| Regra entre Motion e SMC | Função `choose` no `app.py` |
| Colunas da planilha | `sheets.py` e `docs/PLANILHA.md` |
| Leitor próprio para outro site | `DRIVERS` no `suppliers.py` e `KNOWN_DOMAINS` no `app.py` |
| Visual do painel | `web/style.css` |
| Porta | `python3 app.py --port 9000` |

## Testes

```bash
npm test                    # testes em Python e sintaxe do app.js
python3 -m unittest -v      # só os testes em Python
```

São 16 testes. Um cobre o teste de fornecedor no homelab. Cinco cobrem os links de fornecedor: leitor genérico, agrupamento e bloqueio de endereços internos. Seis cobrem leitura do título, preço de venda, escolha do fornecedor, prazo da SMC, código exato na Motion e ASINs repetidos. Dois cobrem a gravação na planilha e dois, a checagem da VPN. O GitHub Actions roda os testes a cada push e pull request.

Eles não abrem o painel nem a extensão. A leitura das lojas depende do layout das páginas, e um site pode recusar consultas automáticas. Nesses casos o produto fica pendente. Respeite os termos de uso de cada site.

## Roadmap

- [ ] Testes automatizados do painel e da extensão no navegador
- [ ] Gravar um GIF de demonstração
- [ ] Exportar o resultado em CSV pelo painel

## Instalar no homelab

Copie o projeto para o servidor, trocando `meu-homelab` pelo seu alias SSH com login por chave, já registrado no `known_hosts`:

```bash
ssh meu-homelab 'mkdir -p ~/.local/share/buscador-fornecedores-amazon'
rsync -a --exclude .git ./ meu-homelab:.local/share/buscador-fornecedores-amazon/
```

As credenciais e o `settings.json` também ficam no servidor. Para usar a extensão, o servidor precisa de uma sessão gráfica com o Chrome aberto.

### Modo 1: painel no notebook, trabalho no homelab

```bash
WORKER_HOST=meu-homelab npm start
```

### Modo 2: tudo no homelab

```bash
# no servidor
cd ~/.local/share/buscador-fornecedores-amazon
mkdir -p ~/.config/systemd/user
cp ops/buscador-fornecedores-amazon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now buscador-fornecedores-amazon
loginctl enable-linger "$USER"   # mantém o serviço ativo sem sessão aberta

# no seu computador
ssh -L 8746:127.0.0.1:8746 meu-homelab
```

Com o túnel aberto, acesse `http://127.0.0.1:8746`.

## Licença

© 2026 Mateus de Freitas Bonette. O código está publicado como portfólio, sem licença de código aberto, com todos os direitos reservados.

Projeto independente, sem vínculo com Amazon, Keepa, Motion, SMC, Google ou Proton. Os nomes pertencem aos respectivos donos.

## Stack

[Python](https://www.python.org) · [SQLite](https://www.sqlite.org) · [Google Sheets API](https://developers.google.com/workspace/sheets/api) · [Keepa API](https://keepa.com/#!api) · [Chrome Extensions](https://developer.chrome.com/docs/extensions) · [OpenSSL](https://www.openssl.org) · [GitHub Actions](https://docs.github.com/actions)
