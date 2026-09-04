# Cláudia — assistente de CRM da Isapa Bike (WhatsApp)

O que este projeto faz: alguém do time manda uma pergunta pro número de WhatsApp
dedicado ("quem está sem visita?", "qual o telefone da Fulana Bikes?", "qual o
preço do produto X?") e a Cláudia responde usando os dados sincronizados do
MEX3000 (clientes, pedidos, visitas, condições de pagamento e preços).

## Como as peças se encaixam

```
[Computador novo, com MEX3000 instalado]
   SFA.DB (banco local)
        │
        │  2x ao dia (Agendador de Tarefas do Windows)
        ▼
   sync/sync_to_cloud.py  ──HTTPS──►  Servidor na nuvem (Railway)
                                            │
                                            ├─ guarda o snapshot mais recente
                                            │
                                            └─ conectado ao WhatsApp (Baileys)
                                                    │
                                          Equipe pergunta no WhatsApp
                                                    │
                                          Cláudia consulta os dados e
                                          responde usando a API da Anthropic
```

Nada disso fica "rodando sozinho no computador" fora de um agendamento — o
computador roda o script 2x ao dia e desliga a tela, o servidor na nuvem é
que fica ligado 24h respondendo o WhatsApp.

## Passo a passo para ativar

### 1. Criar a conta no Railway
Você já vai fazer isso. Depois de criada, crie um novo projeto vazio.

### 2. Subir este projeto para o Railway
Duas formas, escolha a mais fácil pra você:
- **Railway CLI**: instale (`npm i -g @railway/cli`), rode `railway login`,
  depois dentro desta pasta `railway init` e `railway up`.
- **GitHub**: suba esta pasta para um repositório (pode ser privado) e conecte
  o repositório ao projeto no Railway (Deploy from GitHub repo).

### 3. Configurar as variáveis de ambiente no Railway
Em Settings > Variables, adicione (veja `.env.example` para a lista completa):
- `ANTHROPIC_API_KEY` — pegue em console.anthropic.com (é preciso criar conta
  e cadastrar um cartão; o custo por mensagem respondida é bem baixo).
- `SYNC_TOKEN` — invente uma senha longa (ex: gere uma em
  https://1password.com/password-generator). Vai ser usada também no passo 5.
- `ALLOWED_NUMBERS` — os números de WhatsApp do time (você + os 4 colegas),
  formato `55DDDNUMERO`, separados por vírgula. **Sem isso, qualquer pessoa
  que descobrir o número do bot consegue ver dados de clientes e preços** —
  não pule esse passo.

### 4. Adicionar um volume persistente
Isso é essencial: sem volume, o Railway apaga a sessão do WhatsApp e os dados
sincronizados a cada novo deploy, e seria preciso escanear o QR code de novo
toda vez.
Em Settings > Volumes, crie um volume e monte em `/app/data`.

**Atenção:** como o volume é montado em cima de `data/` inteira, qualquer
arquivo que esteja em `data/` *dentro do código* (não gerado em tempo de
execução) fica escondido pelo volume depois do deploy - o servidor não
enxerga esse arquivo, mesmo ele existindo no repositório. Foi exatamente
isso que aconteceu com `grupos_clientes.json` e `edi_oficial.json`: por
isso eles moraram em `config/` (não em `data/`) - essa pasta não tem
volume montado em cima, então sempre vai junto no deploy. Qualquer novo
arquivo de configuração estática (não gerado pelo sync) deve ir em
`config/`, nunca em `data/`.

### 5. Configurar e testar o script de sincronização
No **computador novo** (o que tem o MEX3000/SFA.DB):
1. Instale o Python 3, se ainda não tiver (python.org/downloads).
2. Copie a pasta `sync/` para esse computador.
3. Abra `sync/sync_to_cloud.py` e ajuste, perto do topo:
   - `SFA_DB_PATH` — caminho real do SFA.DB nesse computador.
   - `SERVER_URL` — a URL pública que o Railway te deu, terminando em `/sync`
     (ex: `https://isapa-crm-bot-production.up.railway.app/sync`).
   - `SYNC_TOKEN` — a mesma senha que você colocou no passo 3.
4. Rode uma vez manualmente pra testar: `python sync_to_cloud.py`.
   Deve aparecer "Sincronizacao concluida com sucesso." e um arquivo
   `sync_log.txt` na mesma pasta.
5. Agende para rodar 2x ao dia:
   - Abra o **Agendador de Tarefas** do Windows (pesquise no menu iniciar).
   - Criar Tarefa Básica → nome "Sincronizar CRM Isapa" → Diariamente →
     defina o primeiro horário (ex: 08:00) → Ação: Iniciar um programa →
     Programa: `python` (ou o caminho completo do python.exe) → Argumentos:
     o caminho completo de `sync_to_cloud.py`.
   - Depois de criada, abra as Propriedades da tarefa → aba Gatilhos → Editar
     → em "Repetir a tarefa a cada" marque 1 dia e adicione um segundo
     gatilho para o horário da tarde (ex: 18:00) — ou simplesmente crie uma
     segunda tarefa igual com outro horário.

### 6. Conectar o WhatsApp (uma única vez)
1. Veja os logs do serviço no Railway (aba Deployments > Logs).
2. Assim que o servidor iniciar, um QR code vai aparecer nos logs.
3. No celular com o eSIM novo: WhatsApp → Configurações → Aparelhos conectados
   → Conectar um aparelho → escaneie o QR code que apareceu nos logs.
4. Vai aparecer "[whatsapp] conectado com sucesso." nos logs.

### 7. Testar
Mande uma mensagem do seu WhatsApp (o número precisa estar em
`ALLOWED_NUMBERS`) para o número novo: "oi". A Cláudia deve se apresentar.
Depois teste algo real, tipo "quem está sem visita em Florianópolis?".

## Automatizar a "Recepção de Dados" do MEX3000 (3x ao dia)

Isso automatiza a tela de login/conexão do MEX3000 (usuário, senha, marcar
"Recepção dos Dados", clicar Conectar) para não precisar fazer isso na mão.
**Atenção:** isso guarda sua senha do MEX3000 criptografada localmente na
máquina — só faça isso numa máquina de confiança.

**Escrevi esses scripts a partir de um vídeo da tela, sem poder testar num
Windows de verdade.** É bem provável que precise de ajuste na primeira
rodada — rode manualmente uma vez antes de agendar, e se der erro, me manda
o conteúdo de `sync/recepcao_log.txt` que eu ajusto o script.

1. **Configurar a senha (uma vez só):**
   ```
   powershell -ExecutionPolicy Bypass -File sync\configurar_credenciais.ps1
   ```
   Isso pede usuário e senha do MEX3000 e salva criptografado em
   `sync/credenciais_mex3000.xml`.

2. **Testar manualmente antes de agendar:**
   ```
   powershell -ExecutionPolicy Bypass -File sync\automatizar_recepcao_dados.ps1
   ```
   Acompanhe se ele realmente preenche a tela e clica em Conectar. Se travar
   ou não achar algum campo, confira `sync/recepcao_log.txt` e me envie.

3. **Agendar o ciclo completo (Recepção + envio pro servidor) 3x ao dia:**
   - Abra o **Agendador de Tarefas** do Windows.
   - Clique em **Criar Tarefa** (não "Criar Tarefa Básica", pra poder ter
     vários gatilhos) → aba Geral → nome "Ciclo Claudia CRM".
   - Aba **Gatilhos** → **Novo**, e crie **3 gatilhos separados**, um pra
     cada horário: **08:00**, **13:00** e **18:00** (Diariamente).
   - Aba **Ações** → **Nova** → Programa/script: `powershell` → Argumentos:
     `-ExecutionPolicy Bypass -File "CAMINHO\sync\executar_ciclo_completo.ps1"`
   - Marque "Executar estando o usuário conectado ou não" **NÃO** — como isso
     controla a tela do MEX3000, o Windows precisa estar com a sessão aberta
     (usuário logado, mesmo que a tela esteja bloqueada em alguns casos não
     funciona - teste primeiro com a tela desbloqueada).

## Manter o painel atualizado a cada 30 minutos

Essa é uma tarefa **separada e mais leve** da de cima: ela só roda
`sync_to_cloud.py` (lê o SFA.DB local e manda pro servidor), sem mexer na
tela do MEX3000. Por não controlar nenhuma janela, é seguro rodar com muito
mais frequência, mesmo com você usando o MEX3000 normalmente ao mesmo tempo.

1. Abra o **Agendador de Tarefas** do Windows.
2. Clique em **Criar Tarefa** → aba Geral → nome "Sincronizar Painel CRM (30
   min)".
3. Aba **Gatilhos** → **Novo** → Diariamente, horário de início (ex: 07:00) →
   marque **Repetir a tarefa a cada** → **30 minutos** → **durante** →
   **Indefinidamente** (ou "1 dia", já que o gatilho diário se repete todo
   dia de qualquer forma).
4. Aba **Ações** → **Nova** → Programa/script: `python` → Argumentos:
   `sync_to_cloud.py` → Iniciar em:
   `CAMINHO\isapa-crm-bot\sync` (a pasta onde o script está).
5. OK e, se pedir, a senha do Windows.

Isso não substitui a tarefa de "Recepção de Dados" 3x ao dia — ela continua
necessária pra trazer dados novos do servidor central pro SFA.DB local. Esta
tarefa de 30 min só garante que qualquer coisa que já esteja no SFA.DB chegue
rápido no painel, sem depender de você rodar `python sync_to_cloud.py` na
mão.

## Fotos de produtos (catálogo)

A Cláudia também responde pedidos como "me manda a foto do quadro Viking X-25
que temos em estoque" ou "foto do código 41274". Isso usa um índice montado a
partir do catálogo em PDF da Isapa (`config/catalogo/catalog_index.json` +
`config/catalogo/catalogo.pdf`), recortando a foto exata do produto sob demanda.

**Atenção:** esses dois arquivos moram em `config/`, não em `data/` - mesmo
motivo do resto do projeto (volume do Railway esconde qualquer coisa nova
colocada em `data/` depois que o volume já existe - ver seção "Adicionar um
volume persistente"). Já aconteceu de esse catálogo ficar em `data/catalogo/`
numa versão anterior deste projeto (funcionava por sorte, porque foi
adicionado antes do volume existir) - foi corrigido e movido pra `config/`
em agosto/2026, junto com a atualização pro catálogo de 17/08 (8398 produtos,
antes eram 7308).

**Quando a Isapa mandar uma versão nova do catálogo**, regenere o índice:
```
python sync/build_catalog_index.py "Catalogo ISAPA_novo.pdf" config/catalogo/
```
Isso substitui `config/catalogo/catalog_index.json` e `config/catalogo/catalogo.pdf`.
Faça o deploy de novo no Railway depois de atualizar (`railway up` ou push no
GitHub, dependendo de como você conectou o projeto).

**Requisito de ambiente:** o recorte usa o comando `pdftoppm` (poppler-utils).
Já deixei um `nixpacks.toml` no projeto pra o Railway instalar isso
automaticamente - não precisa fazer nada, só não apague esse arquivo.

O PDF do catálogo (uns 60MB) fica versionado dentro do projeto. Se isso deixar
o deploy lento ou o repositório grande demais, me avise que a gente troca por
outra forma de guardar esse arquivo.

## Rodando localmente para testar antes de colocar no Railway (opcional)
```
npm install
cp .env.example .env    # preencha as variáveis
npm start
```
O QR code aparece direto no terminal.

## OGGI / StreetGo / Yoo (mesma Claudia, mesmo WhatsApp)

Além do CRM da Isapa Bike, essa mesma Claudia também responde perguntas sobre
a outra frente de negócio do Felipe (OGGI, StreetGo e Yoo, via OX Amazônia),
no mesmo número de WhatsApp. Ver `src/oggi.js` pra todo o código.

**Como funciona o roteamento:** toda mensagem passa por `oggi.pareceOggi()`
em `server.js` — se citar "oggi", "streetgo", "yoo", "armazém 09/17" etc, a
pergunta é respondida com o prompt/contexto da OGGI (`src/oggi.js`); senão,
cai no fluxo normal do CRM Isapa (`src/ai.js`).

**O que já está pronto (testado com arquivos reais que o Felipe mandou):**
- **Tabelas de preço** (`config/oggi/precos/`): OGGI custos por faixa Bronze/
  Prata/Ouro/Platinum/Diamante, StreetGo custo, StreetGo sugerido, Yoo custo
  — texto extraído dos 4 PDFs de agosto/2026. Estático, mora em `config/`.
- **Catálogo de fotos/ficha técnica** (`config/oggi/catalogo/`): o PDF de 134
  páginas ("CATALOGO OGGI - JUNHO 2026 - REV 10") tem esse padrão — cada
  modelo é um grupo de páginas de foto (uma por cor) seguido de UMA página
  "ficha técnica completa". Como o título de cada página é um desenho (não
  texto), não dá pra extrair com pdftotext - o índice
  (`config/oggi/catalogo/catalog_index.json`, 37 modelos) foi montado lendo
  visualmente o título de cada grupo de páginas. Se a Isapa mandar uma versão
  nova do catálogo, esse índice precisa ser refeito à mão (não existe um
  script automático pra isso ainda, ao contrário do catálogo da Isapa).
  **Atenção:** o PDF original tem ~200MB (export do Canva) - o arquivo salvo
  aqui foi recomprimido com Ghostscript (`gs -dPDFSETTINGS=/ebook`) pra ~44MB,
  sem perda visível de qualidade nas fotos. Se mandar um catálogo novo,
  recomprimir do mesmo jeito antes de substituir, senão o deploy fica pesado.
- **Estoque**: os PDFs reais que a Amanda manda (ex: "ESTOQUE (33).pdf",
  "ESTOQUE 09 - 17.pdf") já trazem os DOIS armazéns na mesma tabela (colunas
  "ARM. 9 / UBERLÂNDIA" e "ARM. 17 / ITAJAÍ"), então o código não tenta mais
  adivinhar o armazém pelo nome do arquivo - ele detecta o TIPO de relatório
  pelo conteúdo ("estoque_detalhado" = tem colunas de antecipação/previsão de
  chegada, "estoque_atual" = só a quantidade disponível) e guarda os dois em
  `data/oggi/estoque_texto.json`. Já veio pré-carregado com os 2 exemplos que
  o Felipe mandou em 17/08/2026 (não precisa reenviar esses dois de novo).
  Isso é **dinâmico**, por isso mora em `data/` (precisa sobreviver a
  redeploys) - pra atualizar, é só reenviar o PDF novo aqui no WhatsApp.
- **Recebimento de PDF por WhatsApp**: o bot aceita documentos (não só
  texto) - se o nome do arquivo tiver "ESTOQUE", processa automaticamente.
- **Fotos e ficha técnica**: pedir "foto do BW 8.2" manda até 6 fotos (uma
  por cor); pedir "ficha técnica do BW 8.2" manda também a página de
  especificações. Busca por nome do modelo (todas as palavras da busca
  precisam bater, mesmo critério do catálogo da Isapa).
- Regras de negócio (armazém 09 nunca vendável e sempre separado do 17,
  detalhamento por tamanho obrigatório, confidencialidade dos custos - a
  própria tabela OGGI já vem com "OBS: NÃO ENVIAR PARA CLIENTES" impressa -,
  fotos só quando pedidas, Mercos só cria orçamento) estão todas codificadas
  no prompt de sistema (`SYSTEM_PROMPT_OGGI` em `src/oggi.js`).

**O que ainda falta:**
- A leitura de estoque hoje é a Claudia lendo o texto bruto da tabela
  (extraído com `pdftotext -layout`) e montando a resposta a partir dele -
  funciona bem nos 2 exemplos testados, mas vale acompanhar as primeiras
  respostas reais de estoque pra confirmar que ela não erra código/tamanho
  em tabelas muito longas (o relatório detalhado tem quase 90 mil
  caracteres de texto, e só uma parte cabe no contexto de cada resposta).
- Automação do Gmail direto no servidor (hoje só funciona se alguém
  reencaminhar o PDF da Amanda pelo WhatsApp) e integração com o Mercos
  (criar orçamento automaticamente) ainda não foram feitas - são passos
  futuros, mais trabalhosos, que dependem de credenciais e de decidir o nível
  de automação desejado.

## Limitações da v1 (vale saber)
- A busca de cliente/produto no meio da pergunta é por palavra-chave (nome,
  cidade, nome de produto) — não é uma busca "inteligente" ainda. Perguntas
  bem diretas ("telefone da Fulana Bikes") funcionam melhor que perguntas
  muito genéricas.
- O bot ignora mensagens de grupo por padrão (só responde em conversa individual).
- Se o WhatsApp desconectar sozinho (acontece de vez em quando com número não
  oficial), é preciso escanear o QR code de novo nos logs do Railway.
- A busca de fotos por descrição genérica exige que TODAS as palavras
  digitadas apareçam no texto do catálogo (nome do produto, cor, marca).
  Descrições muito vagas podem não achar nada ou achar produtos demais
  (nesse caso só os primeiros 8 são enviados, com aviso de quantos existem).
