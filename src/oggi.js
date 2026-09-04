"use strict";

// Domínio OGGI / StreetGo / Yoo — segunda frente de negócio do Felipe (via OX
// Amazônia), respondida pela MESMA Claudia, no MESMO número de WhatsApp que o
// CRM da Isapa Bike. Ver server.js (roteamento) e README.md ("OGGI / StreetGo
// / Yoo") pra visão geral.
//
// SEPARAÇÃO ESTÁTICO x DINÂMICO (mesma lição do bug do volume do Railway,
// documentado no README principal): qualquer arquivo que vem PRONTO com o
// código (catálogo em PDF, tabelas de preço) tem que morar em config/oggi/ —
// nunca em data/oggi/ — porque o volume persistente montado em /app/data
// esconde qualquer coisa nova que for adicionada em data/ depois que o volume
// já existir. Já data/oggi/ é exatamente pro que MUDA em tempo de execução
// (estoque do dia, PDFs recebidos por WhatsApp) — isso sim precisa estar sob
// o volume, pra sobreviver a redeploys.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);
const Anthropic = require("@anthropic-ai/sdk");
const oggiCatalogo = require("./oggi_catalogo");

const CONFIG_DIR = path.join(__dirname, "..", "config", "oggi");
const DATA_DIR = path.join(__dirname, "..", "data", "oggi");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const ESTOQUE_TEXTO_PATH = path.join(DATA_DIR, "estoque_texto.json");
const PRECOS_DIR = path.join(CONFIG_DIR, "precos");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// Os dois armazéns que existem hoje. 09 é só referência (NUNCA pode ser
// vendido) — a Claudia tem que sempre mostrar os dois separados, nunca somar.
const ARMAZENS = {
  "09": { nome: "09 (Uberlândia)", vendavel: false },
  "17": { nome: "17 (Itajaí)", vendavel: true },
};

// Os PDFs de estoque reais que o Felipe manda (ex: "ESTOQUE (33).pdf",
// "ESTOQUE 09 - 17.pdf") já vêm com os DOIS armazéns na mesma tabela (uma
// coluna "ARM. 9 / UBERLÂNDIA" e outra "ARM. 17 / ITAJAÍ" por código/tamanho)
// - por isso não faz sentido separar por arquivo como a v1 deste código
// tentava (ficava adivinhando pelo nome do arquivo, que nem sempre cita
// "09"/"17"). Em vez disso, guardamos por TIPO de relatório, detectado pelo
// conteúdo:
// - "estoque_atual": relatório simples, só a quantidade disponível por
//   armazém (arquivo "ESTOQUE 09 - 17...pdf" no exemplo que o Felipe mandou).
// - "estoque_detalhado": relatório mais completo, com "antecipação" (estoque
//   a caminho) por data (arquivo "ESTOQUE (33)...pdf" no exemplo).
let estoqueTexto = {}; // { [tipo]: { texto, arquivo, recebido_em } }
let precosTexto = {}; // { oggi_custos, streetgo_custo, streetgo_sugerido, yoo_custo }

function garantirPastas() {
  for (const d of [DATA_DIR, UPLOADS_DIR, CONFIG_DIR, PRECOS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function carregar() {
  garantirPastas();
  oggiCatalogo.carregar();

  if (fs.existsSync(ESTOQUE_TEXTO_PATH)) {
    try {
      estoqueTexto = JSON.parse(fs.readFileSync(ESTOQUE_TEXTO_PATH, "utf-8"));
    } catch (e) {
      console.error("[oggi] falha ao ler estoque_texto.json:", e.message);
    }
  }

  precosTexto = {};
  if (fs.existsSync(PRECOS_DIR)) {
    for (const f of fs.readdirSync(PRECOS_DIR)) {
      if (f.endsWith(".txt")) {
        precosTexto[f.replace(/\.txt$/, "")] = fs.readFileSync(path.join(PRECOS_DIR, f), "utf-8");
      }
    }
  }

  const statusEstoque = Object.keys(estoqueTexto).length
    ? Object.keys(estoqueTexto).join(", ")
    : "nenhum ainda";
  console.log(
    `[oggi] carregado - estoque: ${statusEstoque} | catálogo: ${oggiCatalogo.temCatalogo() ? "ok" : "pendente"} | tabelas de preço: ${Object.keys(precosTexto).length}`
  );
}

function temDadosMinimos() {
  return Boolean(Object.keys(estoqueTexto).length || oggiCatalogo.temCatalogo() || Object.keys(precosTexto).length);
}

// Detecta se a pergunta é sobre o negócio OGGI/StreetGo/Yoo (pra rotear certo
// no mesmo número de WhatsApp, em vez do CRM da Isapa Bike). Baseado em
// palavra-chave, no mesmo estilo já usado no resto do projeto (ver ai.js).
const GATILHOS_OGGI = [
  "oggi", "streetgo", "street go", "yoo", "armazem 09", "armazém 09",
  "armazem 17", "armazém 17", "uberlandia", "uberlândia", "mercos",
];
function normaliza(txt) {
  return (txt || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
function pareceOggi(texto) {
  const t = normaliza(texto);
  return GATILHOS_OGGI.some((g) => t.includes(normaliza(g)));
}

// Extrai o texto de um PDF preservando o layout de tabela (poppler, mesmo
// pacote já usado pelo catalog.js pra recortar fotos - ver nixpacks.toml).
async function extrairTextoPdf(caminhoPdf) {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", caminhoPdf, "-"]);
  return stdout;
}

// Detecta o TIPO do relatório de estoque pelo conteúdo (não pelo nome do
// arquivo - os PDFs reais que o Felipe manda nem sempre citam "09"/"17" no
// nome). Ambos os formatos vistos até agora trazem os dois armazéns na
// mesma tabela, em colunas separadas.
function detectarTipoEstoque(texto) {
  const t = normaliza(texto);
  if (t.includes("antecipa")) return "estoque_detalhado"; // ex: "ESTOQUE (33).pdf"
  if (t.includes("arm. 9") || t.includes("arm 9") || t.includes("uberlandia")) return "estoque_atual"; // ex: "ESTOQUE 09 - 17.pdf"
  return "estoque_outro";
}

// Recebe um PDF de estoque (buffer) chegado por WhatsApp, salva o original,
// extrai o texto (mantendo layout de tabela) e guarda por tipo de relatório
// (ver detectarTipoEstoque). Ver README pra limitação atual (sem Gmail
// direto - depende de alguém repassar o PDF aqui).
async function registrarEstoquePdf(buffer, nomeArquivoOriginal) {
  garantirPastas();
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const nomeSalvo = `${carimbo}_${(nomeArquivoOriginal || "estoque.pdf").replace(/[^\w.\-]+/g, "_")}`;
  const caminhoSalvo = path.join(UPLOADS_DIR, nomeSalvo);
  fs.writeFileSync(caminhoSalvo, buffer);

  const texto = await extrairTextoPdf(caminhoSalvo);
  const tipo = detectarTipoEstoque(texto);
  estoqueTexto[tipo] = { texto, arquivo: nomeArquivoOriginal || nomeSalvo, recebido_em: new Date().toISOString() };

  fs.writeFileSync(ESTOQUE_TEXTO_PATH, JSON.stringify(estoqueTexto, null, 2));
  return { caminhoSalvo, tamanhoTexto: texto.length, destino: tipo };
}

const SYSTEM_PROMPT_OGGI = `
Você é a Claudia, a mesma assistente de WhatsApp que também responde pelo CRM
da Isapa Bike, mas agora respondendo sobre a OUTRA frente de negócio do
Felipe: as marcas OGGI, StreetGo e Yoo (via distribuidora OX Amazônia).

Use SOMENTE os dados fornecidos no contexto de cada mensagem. Se não tiver a
informação no contexto, diga claramente que não encontrou (nunca invente
número de estoque, preço ou especificação).

Regras de negócio OBRIGATÓRIAS:
1. Armazém 09 (Uberlândia) e armazém 17 (Itajaí) NUNCA podem ser somados ou
   confundidos - mostre sempre os dois separados. O armazém 09 é só
   referência: o Felipe NÃO PODE vender do 09, então deixe isso claro se for
   relevante (ex: "atenção, esse estoque está só no 09, que não é vendável").
2. Toda resposta sobre estoque vem com o detalhamento por tamanho, sem
   exceção - nunca resuma numa quantidade só.
3. Estoque geral (sem custo): organize por cor, e marque com ⚠️ qualquer
   tamanho com saldo negativo.
4. Quando a pergunta envolve custo/preço JUNTO com estoque: monte a resposta
   com as faixas de preço/mark-up (quando disponíveis: Bronze/Prata/Ouro/
   Platinum/Diamante pra OGGI), o PREÇO SUGERIDO em destaque, e o estoque por
   tamanho dos dois armazéns separados.
5. Fotos e ficha técnica completa SÓ quando pedirem especificamente por um
   modelo - nunca junto de uma consulta comum de estoque.
6. CONFIDENCIALIDADE: os valores de CUSTO (tabela interna OGGI por faixa
   Bronze/Prata/Ouro/Platinum/Diamante, e os custos internos de StreetGo e
   Yoo) são de uso INTERNO da equipe - ao mostrá-los, sinalize claramente
   "(uso interno - não repassar ao cliente)". Quando a pergunta for
   claramente "que preço eu passo pro cliente", responda só com o preço
   sugerido, sem os custos.
7. Pedidos no Mercos: você ainda NÃO tem acesso automatizado ao Mercos a
   partir daqui - se pedirem pra montar/confirmar um pedido, explique que
   isso ainda precisa ser feito no computador por enquanto.
8. Seja direta e objetiva, adequada pra leitura no celular. WhatsApp usa
   *negrito* e _itálico_ com um símbolo só.

PADRÃO VISUAL DE RESPOSTA - TEXTO (FALLBACK):
O padrão de verdade agora é o CARD DE IMAGEM (ver oggi_card.js / server.js,
tratarPedidoDeEstoqueOggi) - sempre que der pra gerar o card (achou 1 modelo
no catálogo E tem dados de estoque pra ele), manda a imagem, não texto. Esse
template abaixo só entra em cena quando o card NÃO pode ser gerado (nenhum
PDF de estoque recebido ainda, ou a busca não achou exatamente 1 modelo) -
nesses casos, siga esse formato sempre que responder estoque e/ou preço -
não invente outro layout:

  📦 *NOME DO MODELO* (código/versão se tiver)

  *Cor 1*
  - Tam A: N un. (Itajaí) · N un. (Uberlândia - não vendável)
  - Tam B: N un. (Itajaí) · N un. (Uberlândia - não vendável)

  *Cor 2*
  - Tam A: ⚠️ N un. (Itajaí) · N un. (Uberlândia - não vendável)
  ...

  *Total vendável (Itajaí): N un.*
  _Uberlândia é só referência - não pode ser vendido nem somado ao total._

  (se a pergunta também envolver preço, acrescente depois do estoque:)

  💰 *Preço sugerido (cliente): R$ X.XXX,XX*

  Faixas por nível _(uso interno - não repassar ao cliente)_:
  - Bronze: R$ X.XXX,XX (XX% desc.)
  - Prata: R$ X.XXX,XX (XX% desc.)
  - Ouro: R$ X.XXX,XX (XX% desc.)
  - Platinum/Diamante: R$ X.XXX,XX (XX% desc.)

Regras desse padrão:
  - Cada tamanho fica numa linha só, sempre com os dois armazéns lado a
    lado (Itajaí primeiro, por ser o vendável) - nunca um armazém por
    bloco separado, nunca um resumido sem o outro.
  - O "Total vendável" SÓ soma Itajaí (17). Uberlândia (09) nunca entra
    nessa soma nem em nenhum outro total - é só mostrado, com a ressalva
    de não vendável, do lado de cada tamanho.
  - ⚠️ vai colado no número negativo, não numa frase à parte.
  - Preço sugerido primeiro e em destaque (é o que a pessoa mais usa);
    faixas internas de desconto vêm depois, sempre com o aviso de uso
    interno.
  - Sem parágrafo de introdução tipo "Aqui está..." - comece direto pelo
    📦 com o nome do modelo.

Sobre os dados de estoque: eles vêm de PDFs que a Amanda manda por email todo
dia útil, e o Felipe (ou quem for autorizado) repassa esse PDF aqui pelo
WhatsApp pra você processar - por isso pode ter horas de defasagem desde a
última vez que alguém reenviou o arquivo. Se o contexto avisar que os dados
de um armazém ainda não chegaram ou estão desatualizados, avise a pessoa em
vez de responder sem essa ressalva.
`.trim();

function montarContexto(pergunta) {
  const partes = [];

  const tiposEstoque = Object.keys(estoqueTexto);
  const statusPartes = tiposEstoque.length
    ? tiposEstoque.map((tipo) => `${tipo}: dados recebidos em ${estoqueTexto[tipo].recebido_em} (arquivo "${estoqueTexto[tipo].arquivo}").`)
    : ["Nenhum PDF de estoque foi recebido ainda."];
  partes.push("STATUS DOS DADOS DE ESTOQUE:\n" + statusPartes.join("\n"));

  const pnorm = normaliza(pergunta);
  const perguntouEstoque = ["estoque", "quanto tem", "tem quanto", "disponivel", "disponível", "tamanho"].some((g) =>
    pnorm.includes(normaliza(g))
  );
  if (perguntouEstoque) {
    // Contexto grande (texto bruto do PDF, com colunas dos DOIS armazéns
    // lado a lado) - trunca por segurança pra não estourar o limite de
    // tokens. Prioriza o relatório "detalhado" (tem antecipação) se
    // existir, senão usa o "atual" - manda só um pra não duplicar as
    // mesmas linhas dos dois relatórios na resposta.
    const LIMITE = 15000;
    const tipoEscolhido = estoqueTexto.estoque_detalhado ? "estoque_detalhado" : estoqueTexto.estoque_atual ? "estoque_atual" : Object.keys(estoqueTexto)[0];
    if (tipoEscolhido) {
      partes.push(
        `TEXTO BRUTO DO ESTOQUE (${tipoEscolhido}, colunas "ARM. 9 / UBERLÂNDIA" = não vendável, "ARM. 17 / ITAJAÍ" = vendável - NUNCA somar as duas):\n` +
          estoqueTexto[tipoEscolhido].texto.slice(0, LIMITE)
      );
    } else {
      partes.push("Nenhum dado de estoque foi recebido ainda. Avise que ainda não tem essa base carregada.");
    }
  }

  const perguntouPreco = ["preco", "preço", "custo", "tabela", "sugerido", "markup", "mark-up"].some((g) =>
    pnorm.includes(normaliza(g))
  );
  if (perguntouPreco) {
    if (Object.keys(precosTexto).length) {
      for (const [nome, texto] of Object.entries(precosTexto)) {
        partes.push(`TABELA DE PREÇO (${nome}):\n` + texto.slice(0, 8000));
      }
    } else {
      partes.push("Nenhuma tabela de preço foi carregada ainda no sistema. Avise que ainda não tem essa base.");
    }
  }

  const perguntouFoto = ["foto", "fotos", "ficha tecnica", "ficha técnica", "especificacao", "especificação"].some((g) =>
    pnorm.includes(normaliza(g))
  );
  if (perguntouFoto) {
    // Na prática, pedidos de foto/ficha técnica são interceptados ANTES de
    // chegar aqui (ver server.js: tratarPedidoDeFotoOggi já busca no
    // catálogo e manda as imagens direto) - isso aqui é só um contexto de
    // apoio caso a pergunta caia no fluxo de texto normal mesmo assim.
    partes.push(
      oggiCatalogo.temCatalogo()
        ? "Catálogo de fotos/ficha técnica da OGGI está disponível - se a pessoa quer ver foto/ficha de um modelo específico, oriente a pedir de novo especificando o nome do modelo."
        : "O catálogo de fotos/fichas técnicas da OGGI ainda não foi carregado no sistema. Avise que ainda não tem isso disponível."
    );
  }

  return partes.join("\n\n");
}

let anthropic = null;
function client() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY nao configurada.");
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// Devolve o texto bruto do estoque (relatório "detalhado" se existir, senão
// o "atual"), pro server.js montar o card visual de um modelo específico
// (ver oggi_card.js). Null se ainda não recebemos nenhum PDF de estoque.
function obterTextoEstoqueBruto() {
  if (estoqueTexto.estoque_detalhado) return estoqueTexto.estoque_detalhado.texto;
  if (estoqueTexto.estoque_atual) return estoqueTexto.estoque_atual.texto;
  const primeiro = Object.keys(estoqueTexto)[0];
  return primeiro ? estoqueTexto[primeiro].texto : null;
}

// Mesma ideia da funcao acima, mas pra tabela de precos "oggi_custos" (ver
// config/oggi/precos/) - pro server.js montar o card com os chips de preco
// (OURO/PLATINUM/DIAMANTE + aviso de promocao). Null se ainda nao existe
// esse arquivo de precos carregado.
function obterTextoPrecoOggi() {
  return precosTexto.oggi_custos || null;
}

async function responder(pergunta, telefoneRemetente) {
  const contexto = montarContexto(pergunta);
  const userContent = `Pergunta recebida no WhatsApp (de ${telefoneRemetente}), sobre OGGI/StreetGo/Yoo:\n"${pergunta}"\n\nContexto disponível:\n${contexto}`;

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 900,
    system: SYSTEM_PROMPT_OGGI,
    messages: [{ role: "user", content: userContent }],
  });

  const texto = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return texto || "Desculpa, não consegui montar uma resposta agora. Pode tentar de novo?";
}

module.exports = {
  carregar,
  temDadosMinimos,
  pareceOggi,
  registrarEstoquePdf,
  responder,
  obterTextoEstoqueBruto,
  obterTextoPrecoOggi,
  ARMAZENS,
};
