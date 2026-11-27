# Planilha

## Montagem (uma vez)

1. Crie uma planilha no Google Sheets e uma aba chamada `Produtos`.
2. Importe `examples/planilha-modelo.csv` na célula A1.
3. Congele a linha 1, formate I:N como moeda em US$ e O:P como porcentagem.
4. Ative a API Google Sheets, crie uma conta de serviço e compartilhe a planilha com o e-mail dela como Editor.
5. Salve a credencial em `~/.config/buscador-fornecedores-amazon/google-sheets.json`.
6. Copie `examples/settings.example.json` para `~/.config/buscador-fornecedores-amazon/settings.json`. `spreadsheet_id` é o trecho da URL entre `/d/` e `/edit`. `sheet_id` é o número depois de `gid=`.

## Colunas

| Coluna | Nome | O que é | Quem preenche |
|---|---|---|---|
| A | ASIN | Código do anúncio na Amazon. É a chave: um por linha | App |
| B | Marca | Marca pesquisada | App |
| C | Peça | Part number | App |
| D | Pack | Unidades no anúncio | App |
| E | Fornecedor | Loja escolhida | App |
| F | Estoque | Saldo confirmado | App |
| G | Prazo (dias) | Tempo de manuseio | App |
| H | Link | Página do produto na loja | App |
| I | Custo (US$) | Preço exibido pela loja | App |
| J | Preparo (US$) | Padrão 7. Pode editar | App ou você |
| K | Frete (US$) | Frete do fornecedor | App |
| L | Preço de venda (US$) | Calculado para ~24% de margem | App |
| M | Taxa Amazon (US$) | `=L*15/100` | Fórmula |
| N | Lucro (US$) | `=L-I-J-K-M` | Fórmula |
| O | ROI | `=N/I` (formate como %) | Fórmula |
| P | Margem | `=N/L` (formate como %) | Fórmula |

## Regras de gravação

- ASIN existente atualiza a mesma linha. ASIN novo ocupa a primeira linha vazia ou entra no fim.
- ASIN repetido em duas linhas não é gravado.
- Cabeçalho alterado suspende a gravação. Colunas depois de P ficam livres para anotações.
- Fórmula diferente do esperado ou preparo inválido rejeitam a linha.
- Depois de gravar, o app relê a planilha e confere preço e margem.
