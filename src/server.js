"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const data = require("./data");
const ai = require("./ai");
const whatsapp = require("./whatsapp");
const catalog = require("./catalog");
const grupos = require("./grupos");
const edi = require("./edi");
const oggi = require("./oggi");
const oggiCatalogo = require("./oggi_catalogo");
const oggiCard = require("./oggi_card");

const MAX_FOTOS_POR_PEDIDO = 8;

const PORT = process.env.PORT || 3000;
const SYNC_TOKEN = process.env.SYNC_TOKEN;

// Numeros autorizados a receber respostas com dados do CRM (voce + a equipe).
// Formato: DDI+DDD+numero, sem espacos/simbolos, separados por virgula.
// Ex: ALLOWED_NUMBERS=5548999990000,5548988887777
// Se ficar vazio, o bot responde a qualquer numero - NAO recomendado, porque
// os dados incluem preco, condicao de credito e contato de clientes.
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || "")
  .split(",")
  .map((n) => n.replace(/\D/g, ""))
  .filter(Boolean);

function numeroAutorizado(numero) {
  if (ALLOWED_NUMBERS.length === 0) return true; // sem lista configurada = aberto (nao recomendado)
  const limpo = numero.replace(/\D/g, "");
  return ALLOWED_NUMBERS.some((n) => limpo.endsWith(n) || n.endsWith(limpo));
}

// Usuario/senha do painel web (crm_isapa_bike). Isso protege os dados de
// clientes/precos/estoque de ficarem abertos pra qualquer um que descobrir
// o link do Railway - SEM isso configurado, a rota /painel fica bloqueada
// por padrao (nao aberta), pra nunca vazar dado sem querer.
const PAINEL_USER = process.env.PAINEL_USER || "";
const PAINEL_SENHA = process.env.PAINEL_SENHA || "";

function exigirLoginDoPainel(req, res, next) {
  if (!PAINEL_USER || !PAINEL_SENHA) {
    return res
      .status(503)
      .send(
        "Painel ainda nao configurado: defina PAINEL_USER e PAINEL_SENHA nas variaveis de ambiente do servidor."
      );
  }
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Basic ")) {
    const [user, senha] = Buffer.from(auth.slice(6), "base64").toString("utf-8").split(":");
    if (user === PAINEL_USER && senha === PAINEL_SENHA) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Painel Isapa Bike"');
  return res.status(401).send("Login necessario.");
}

const app = express();
app.use(express.json({ limit: "15mb" }));

// Serve o Chart.js localmente (empacotado com o projeto via package.json)
// em vez de depender de um CDN externo - alguns navegadores/redes bloqueiam
// CDNs (cdnjs, jsdelivr etc.), o que deixava os graficos do painel em branco
// sem nenhum erro visivel.
app.get("/vendor/chart.js", (req, res) => {
  // O package.json do chart.js restringe (via "exports") quais subcaminhos
  // podem ser carregados com require() - nem "./dist/chart.umd.js" nem
  // "./package.json" estao na lista, entao require.resolve() com esses
  // subcaminhos sempre falha. Em vez disso, montamos o caminho do arquivo
  // diretamente a partir da pasta node_modules do projeto (o arquivo existe
  // fisicamente em disco mesmo nao estando "exportado" pelo Node).
  const candidatos = [
    path.join(__dirname, "..", "node_modules", "chart.js", "dist", "chart.umd.js"),
  ];
  try {
    // fallback: usa o "." (permitido) so' pra achar a pasta dist, caso a
    // estrutura de pastas do deploy seja diferente da esperada acima.
    candidatos.push(path.join(path.dirname(require.resolve("chart.js")), "chart.umd.js"));
  } catch (e) {
    // ignora - fica so' com o candidato fixo acima
  }
  const encontrado = candidatos.find((p) => fs.existsSync(p));
  if (!encontrado) {
    console.error("[server] nao encontrei o chart.js empacotado. Tentei:", candidatos);
    return res.status(404).send("chart.js nao encontrado");
  }
  res.set("Content-Type", "application/javascript; charset=utf-8");
  return res.sendFile(encontrado);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    tem_dados: data.temDados(),
    resumo: data.resumo(),
    whatsapp_conectado: whatsapp.conexaoAtiva(),
  });
});

// Endpoint chamado pelo sync/sync_to_cloud.py, 2x ao dia.
app.post("/sync", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!SYNC_TOKEN) {
    return res.status(500).json({ ok: false, erro: "SYNC_TOKEN nao configurado no servidor." });
  }
  if (token !== SYNC_TOKEN) {
    return res.status(401).json({ ok: false, erro: "Token invalido." });
  }

  const pacote = req.body;
  if (!pacote || !Array.isArray(pacote.clientes)) {
    return res.status(400).json({ ok: false, erro: "Payload invalido: esperado campo 'clientes'." });
  }

  data.saveSnapshot(pacote);
  return res.json({ ok: true, clientes_recebidos: pacote.clientes.length });
});

const PAINEL_TEMPLATE_PATH = path.join(__dirname, "painel", "template.html");

// Painel visual do CRM (mesmo formato do arquivo local, mas sempre com os
// dados mais recentes que a Claudia recebeu). Protegido por login basico.
app.get("/painel", exigirLoginDoPainel, (req, res) => {
  const pacote = data.getSnapshotParaPainel();
  if (!pacote) {
    return res
      .status(503)
      .send("Ainda nao chegou nenhuma sincronizacao de dados do CRM. Tente novamente em instantes.");
  }
  // Grupos de clientes (varios CNPJs = mesmo cliente na pratica) nao vem do
  // MEX3000 - sao mantidos a parte em config/grupos_clientes.json.
  pacote.grupos = grupos.todosGrupos();
  // Dados oficiais do EDI (relatorio da Isapa) - complementa o ranking/faturamento
  // calculado localmente, que e' limitado aos clientes que existem no SFA.DB.
  pacote.edi = edi.todosDados();
  try {
    const template = fs.readFileSync(PAINEL_TEMPLATE_PATH, "utf-8");
    const html = template.replace("__DATA_JSON__", JSON.stringify(pacote));
    // Sem cache: o painel e' montado na hora com os dados mais recentes -
    // sem isso, o navegador as vezes reaproveita uma versao antiga da pagina
    // (com o HTML/JS de um deploy anterior) mesmo depois de recarregar.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (e) {
    console.error("[server] erro ao montar o painel:", e);
    return res.status(500).send("Erro ao montar o painel.");
  }
});

// Baixa o historico COMPLETO de pedidos acumulado (nao so' o que o MEX3000
// mostra hoje - o SFA.DB local so' guarda os ultimos pedidos de cada
// cliente, entao pedidos antigos vao sumindo de la; aqui a gente acumula
// tudo que ja passou por uma sincronizacao e nunca apaga). Formato CSV,
// pra abrir direto no Excel. Protegido pelo mesmo login do painel.
app.get("/historico.csv", exigirLoginDoPainel, (req, res) => {
  const pedidos = data.getPedidosHistorico();
  const colunas = [
    "cod_ped", "cod_cli", "nome_cliente", "data_emissao", "valor",
    "posicao", "pedido_cliente_ref", "primeira_vez_visto", "ultima_atualizacao",
  ];
  const escapar = (v) => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",;\n]/.test(s) ? `"${s}"` : s;
  };
  const linhas = [colunas.join(";")];
  const ordenados = [...pedidos].sort((a, b) => (b.data_emissao || "").localeCompare(a.data_emissao || ""));
  for (const p of ordenados) {
    linhas.push(colunas.map((c) => escapar(p[c])).join(";"));
  }
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="historico_pedidos_isapa.csv"');
  return res.send("﻿" + linhas.join("\n"));
});

const GATILHOS_FOTO = ["foto", "fotos", "imagem", "imagens", "manda a foto", "envia a foto"];

function pareceProdidoDeFoto(texto) {
  const t = data.normaliza(texto);
  return GATILHOS_FOTO.some((g) => t.includes(g));
}

const GATILHOS_FICHA_TECNICA = ["ficha tecnica", "ficha técnica", "especificacao", "especificação", "especificacoes", "especificações"];
function pareceFichaTecnica(texto) {
  const t = data.normaliza(texto);
  return GATILHOS_FICHA_TECNICA.some((g) => t.includes(data.normaliza(g)));
}

// Tira do texto as palavras de comando ("claudia", "me envie", "foto de", etc)
// pra sobrar so a descricao do produto que a pessoa quer ver.
function limparTermoBusca(texto) {
  const remover = [
    "claudia", "por favor", "pfv", "me envie", "envie", "manda", "mandar", "envia",
    "me manda", "a foto", "as fotos", "foto de", "fotos de", "foto do", "fotos do",
    "foto da", "fotos da", "imagem de", "imagem do", "imagem da", "imagens de",
    "que temos em estoque", "em estoque", "todos os", "todas as", "todo o", "toda a",
  ];
  let t = " " + data.normaliza(texto) + " ";
  for (const r of remover) {
    t = t.split(" " + r + " ").join(" ");
  }
  return t.trim();
}

// Extrai só o "nome do modelo" de uma pergunta de estoque da OGGI (ex: "tem
// 7.3 deore em estoque?" -> "7.3 deore"). Diferente de limparTermoBusca
// (que só tira frases fixas de comando tipo "manda a foto") - aqui a
// pergunta costuma vir em formato de pergunta normal ("qual", "quanto tem",
// "?"), então tira um conjunto maior de palavras soltas de parada, senão a
// busca no catálogo falha (oggiCatalogo.buscar exige que TODA palavra do
// termo apareça no nome do modelo - uma palavra de pergunta sobrando quebra
// a busca inteira).
const STOPWORDS_ESTOQUE_OGGI = new Set([
  "tem", "tenho", "quanto", "quantos", "quantas", "qual", "quais", "estoque",
  "disponivel", "disponiveis", "tamanho", "tamanhos", "de", "do", "da", "dos",
  "das", "no", "na", "nos", "nas", "em", "o", "a", "os", "as", "pra", "para",
  "bicicleta", "bicicletas", "bike", "bikes", "modelo", "oggi", "ai", "claudia",
  "por", "favor", "voce", "vc", "me", "diz", "fala", "manda", "mandar", "envia",
]);
function termoModeloOggi(texto) {
  // "Big Wheel" -> "BW", que é como o catálogo nomeia essa linha - senão a
  // busca não bate (catálogo não conhece o nome comercial por extenso).
  let t = data.normaliza(texto).replace(/\bbig\s*wheel\b/g, "bw");
  const palavras = t
    .split(/\s+/)
    .map((w) => w.replace(/^[?!.,;:()"']+|[?!.,;:()"']+$/g, ""))
    .filter((w) => w && !STOPWORDS_ESTOQUE_OGGI.has(w));
  return palavras.join(" ");
}

async function tratarPedidoDeFoto(numero, texto) {
  if (!catalog.temCatalogo()) {
    return "Ainda nao tenho o catalogo de fotos carregado aqui. Avisa o Felipe pra conferir o arquivo do catalogo no servidor.";
  }

  const somenteComEstoque = data.normaliza(texto).includes("estoque");
  const termo = limparTermoBusca(texto);
  let encontrados = catalog.buscar(termo, 200);

  if (somenteComEstoque) {
    encontrados = encontrados.filter((e) => {
      const est = data.getEstoquePorCodigo(e.cod_prod);
      return est && est.estoque_sc + est.estoque_sp + est.estoque_es > 0;
    });
  }

  if (encontrados.length === 0) {
    return `Não encontrei nenhum produto no catálogo que bata com "${termo}". Pode tentar com o código exato ou outra descrição?`;
  }

  const total = encontrados.length;
  const paraEnviar = encontrados.slice(0, MAX_FOTOS_POR_PEDIDO);

  const intro =
    total > paraEnviar.length
      ? `Encontrei ${total} produtos, mandando os ${paraEnviar.length} primeiros:`
      : `Encontrei ${total} produto${total > 1 ? "s" : ""}, mandando a${total > 1 ? "s fotos" : " foto"}:`;
  await whatsapp.enviarTexto(numero, intro);

  for (const item of paraEnviar) {
    try {
      const preco = data.getPrecoPorCodigo(item.cod_prod);
      const est = data.getEstoquePorCodigo(item.cod_prod);
      const linhasPreco = preco != null ? `\nPreço: R$ ${preco.toFixed(2)}` : "";
      const linhasEstoque = est
        ? `\nEstoque - SC: ${est.estoque_sc} | SP: ${est.estoque_sp} | ES: ${est.estoque_es}`
        : "";
      const legenda = `Código ${item.cod_prod} — ${item.texto_catalogo}${linhasPreco}${linhasEstoque}`;
      const buffer = await catalog.fotoDoProduto(item);
      await whatsapp.enviarImagem(numero, buffer, legenda);
    } catch (e) {
      console.error(`[server] erro ao enviar foto do produto ${item.cod_prod}:`, e);
      await whatsapp.enviarTexto(numero, `(não consegui recortar a foto do código ${item.cod_prod}, mas ele está no catálogo)`);
    }
  }

  return null; // ja mandamos tudo direto, nao precisa de mais texto
}

const MAX_FOTOS_OGGI = 6;

// Foto (uma por cor) e/ou ficha tecnica de um modelo da OGGI/StreetGo/Yoo -
// ver oggi_catalogo.js. So manda a ficha tecnica se a pessoa pediu
// especificamente (regra do Felipe: nunca junto de uma consulta comum).
async function tratarPedidoDeFotoOggi(numero, texto) {
  if (!oggiCatalogo.temCatalogo()) {
    return "Ainda não tenho o catálogo da OGGI carregado aqui. Avisa o Felipe pra conferir o arquivo do catálogo no servidor.";
  }

  const termo = limparTermoBusca(texto);
  const encontrados = oggiCatalogo.buscar(termo, 5);
  if (encontrados.length === 0) {
    return `Não encontrei nenhum modelo da OGGI que bata com "${termo}". Pode tentar com um nome mais parecido com o do catálogo (ex: "BW 8.2 CUES 10V")?`;
  }

  const quiseramFicha = pareceFichaTecnica(texto);
  const modelo = encontrados[0];
  if (encontrados.length > 1) {
    await whatsapp.enviarTexto(
      numero,
      `Encontrei ${encontrados.length} modelos parecidos, mandando o mais próximo: *${modelo.modelo}*. Se não for esse, manda o nome mais completo.`
    );
  }

  const paginasFotos = modelo.paginas_fotos.slice(0, MAX_FOTOS_OGGI);
  await whatsapp.enviarTexto(
    numero,
    `*${modelo.modelo}* - mandando ${paginasFotos.length} foto${paginasFotos.length > 1 ? "s" : ""}${quiseramFicha ? " + ficha técnica" : ""}:`
  );

  for (const pagina of paginasFotos) {
    try {
      const buffer = await oggiCatalogo.paginaComoImagem(pagina);
      await whatsapp.enviarImagem(numero, buffer, modelo.modelo);
    } catch (e) {
      console.error(`[server] erro ao renderizar página ${pagina} do catálogo OGGI:`, e);
    }
  }

  if (quiseramFicha) {
    try {
      const buffer = await oggiCatalogo.paginaComoImagem(modelo.pagina_ficha_tecnica);
      await whatsapp.enviarImagem(numero, buffer, `Ficha técnica — ${modelo.modelo}`);
    } catch (e) {
      console.error(`[server] erro ao renderizar ficha técnica do modelo ${modelo.modelo}:`, e);
    }
  }

  return null;
}

const GATILHOS_ESTOQUE_OGGI = ["estoque", "quanto tem", "tem quanto", "disponivel", "disponível", "tamanho"];
function pareceEstoqueOggi(texto) {
  const t = data.normaliza(texto);
  return GATILHOS_ESTOQUE_OGGI.some((g) => t.includes(g));
}

// Card visual (imagem) de estoque de UM modelo específico da OGGI - padrão
// aprovado pelo Felipe (ver oggi_card.js). Só funciona quando dá pra
// identificar um modelo único no catálogo E existem linhas dele no PDF de
// estoque mais recente; qualquer coisa fora disso (pergunta genérica tipo
// "o que tem em estoque", modelo ambíguo, ainda sem PDF recebido) devolve
// false pra cair no fluxo de texto livre normal (oggi.responder). Devolve
// true quando a imagem já foi mandada (pra quem chamou NÃO mandar mais
// nada em texto por cima).
async function tratarPedidoDeEstoqueOggi(numero, texto) {
  const termo = termoModeloOggi(texto);
  const encontrados = oggiCatalogo.buscar(termo, 3);
  if (encontrados.length !== 1) return false; // ambiguo ou nao achou - deixa a IA tratar em texto

  const textoEstoque = oggi.obterTextoEstoqueBruto();
  if (!textoEstoque) return false; // ainda sem PDF de estoque - deixa a IA explicar isso em texto

  const modelo = encontrados[0];
  const textoPrecos = oggi.obterTextoPrecoOggi(); // null se ainda nao tem tabela - card so' de estoque nesse caso
  let resultado;
  try {
    resultado = await oggiCard.gerarCardEstoque(textoEstoque, modelo.modelo, textoPrecos);
  } catch (e) {
    console.error(`[server] erro gerando card de estoque OGGI (${modelo.modelo}):`, e);
    return false; // deixa a IA tentar responder em texto em vez de travar
  }
  if (!resultado) return false; // catalogo bate mas nao achei linha de estoque desse modelo - deixa a IA explicar

  await whatsapp.enviarImagem(numero, resultado.buffer, `Estoque — ${resultado.dados.modeloExibicao}`);
  return true; // ja mandamos a imagem, nao precisa de mais texto
}

async function tratarMensagemWhatsapp(numero, texto) {
  if (!numeroAutorizado(numero)) {
    console.log(`[server] mensagem ignorada de numero nao autorizado: ${numero}`);
    return "Oi! Esse numero de assistente e' de uso interno da equipe Isapa Bike. Se voce faz parte do time, peca pra te adicionarem na lista de acesso.";
  }

  const saudacoes = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "menu", "ajuda"];
  if (saudacoes.includes(data.normaliza(texto))) {
    return (
      "Oi! Aqui e' a Claudia. Eu respondo dois assuntos por aqui:\n\n" +
      "*CRM Isapa Bike* - pode perguntar coisas como:\n" +
      '- "quem esta sem visita?"\n' +
      '- "qual o telefone da [nome do cliente]?"\n' +
      '- "qual a condicao de pagamento do [cliente]?"\n' +
      '- "qual o preco do [produto]?"\n' +
      '- "qual a posicao do pedido do [cliente]?" ou "posicao do pedido [numero]"\n' +
      '- "qual o estoque do produto [codigo ou nome]?"\n' +
      '- "me manda a foto do [codigo ou descricao]"\n\n' +
      "*OGGI / StreetGo / Yoo* - pode perguntar coisas como:\n" +
      '- "qual o estoque do [modelo] no 17?"\n' +
      '- "qual o preco sugerido do [modelo]?"\n' +
      '- "me manda a foto e ficha tecnica do [modelo]"\n' +
      "(pra atualizar o estoque, so reenviar o PDF que a Amanda manda por email aqui mesmo)"
    );
  }

  // Roteamento por domínio primeiro (OGGI/StreetGo/Yoo x CRM Isapa), e só
  // depois decide se é pedido de foto ou pergunta geral - assim uma frase
  // tipo "manda a foto do BW 8.2" cai no catálogo certo.
  if (oggi.pareceOggi(texto)) {
    if (pareceProdidoDeFoto(texto) || pareceFichaTecnica(texto)) {
      try {
        return await tratarPedidoDeFotoOggi(numero, texto);
      } catch (e) {
        console.error("[server] erro ao processar pedido de foto (oggi):", e);
        return "Deu um erro aqui tentando buscar a foto/ficha técnica. Pode tentar de novo?";
      }
    }
    // Pergunta de estoque com um modelo identificável -> manda o card visual
    // (imagem) e para por aqui. Se não der (modelo ambíguo, sem PDF, pergunta
    // genérica tipo "o que tem em estoque"), cai no fluxo de texto normal
    // (oggi.responder) logo abaixo, sem perder a resposta.
    if (pareceEstoqueOggi(texto)) {
      try {
        const jaRespondeuComImagem = await tratarPedidoDeEstoqueOggi(numero, texto);
        if (jaRespondeuComImagem) return null;
      } catch (e) {
        console.error("[server] erro ao gerar card de estoque (oggi):", e);
      }
    }
    try {
      return await oggi.responder(texto, numero);
    } catch (e) {
      console.error("[server] erro ao chamar a IA (oggi):", e);
      return "Deu um erro aqui do meu lado tentando montar a resposta sobre OGGI/StreetGo/Yoo. Pode tentar de novo em instantes?";
    }
  }

  if (pareceProdidoDeFoto(texto)) {
    if (!data.temDados()) {
      return "Ainda nao recebi nenhuma sincronizacao de dados do CRM. Assim que o primeiro envio automatico acontecer, ja posso responder.";
    }
    try {
      return await tratarPedidoDeFoto(numero, texto);
    } catch (e) {
      console.error("[server] erro ao processar pedido de foto:", e);
      return "Deu um erro aqui tentando buscar as fotos. Pode tentar de novo?";
    }
  }

  if (!data.temDados()) {
    return "Ainda nao recebi nenhuma sincronizacao de dados do CRM. Assim que o primeiro envio automatico acontecer, ja posso responder.";
  }

  try {
    return await ai.responder(texto, numero);
  } catch (e) {
    console.error("[server] erro ao chamar a IA:", e);
    return "Deu um erro aqui do meu lado tentando montar a resposta. Pode tentar de novo em instantes?";
  }
}

// PDF recebido por WhatsApp - hoje so' usado pro estoque diario da OGGI
// (reenviado manualmente, ja que o servidor nao le o Gmail diretamente -
// ver README.md, secao "OGGI / StreetGo / Yoo"). Documentos que nao parecem
// um arquivo de estoque sao apenas confirmados, sem tentar processar.
async function tratarDocumentoWhatsapp(numero, buffer, nomeArquivo) {
  if (!numeroAutorizado(numero)) {
    console.log(`[server] documento ignorado de numero nao autorizado: ${numero}`);
    return null;
  }

  const nomeNorm = data.normaliza(nomeArquivo || "");
  const pareceEstoque = nomeNorm.includes("estoque");
  if (!pareceEstoque) {
    return `Recebi o arquivo "${nomeArquivo}", mas hoje eu so sei processar automaticamente os PDFs de estoque da OGGI (nome com "ESTOQUE"). Esse aqui eu so guardei, nao usei em nada.`;
  }

  try {
    const resultado = await oggi.registrarEstoquePdf(buffer, nomeArquivo);
    return `Estoque atualizado a partir de "${nomeArquivo}" (armazém ${resultado.destino}). Já pode perguntar sobre estoque da OGGI.`;
  } catch (e) {
    console.error("[server] erro processando PDF de estoque OGGI:", e);
    return `Recebi "${nomeArquivo}" mas deu erro tentando ler o conteúdo. Pode confirmar se é mesmo um PDF (não foto/print)?`;
  }
}

async function main() {
  data.loadFromDisk();
  catalog.carregar();
  grupos.carregar();
  edi.carregar();
  oggi.carregar();
  oggiCatalogo.carregar();

  app.listen(PORT, () => {
    console.log(`[server] escutando na porta ${PORT}`);
    if (ALLOWED_NUMBERS.length === 0) {
      console.log(
        "[server] ATENCAO: ALLOWED_NUMBERS nao configurado - o bot vai responder a QUALQUER numero que mandar mensagem. Configure essa variavel de ambiente com os numeros da equipe."
      );
    } else {
      console.log(`[server] numeros autorizados: ${ALLOWED_NUMBERS.length}`);
    }
  });

  // O WhatsApp fica desligado ate' termos o numero/celular prontos pra
  // escanear o QR code. Enquanto isso, nao tenta conectar (evita ficar
  // reimprimindo QR code a cada deploy/restart). Quando estiver pronto,
  // basta configurar a variavel de ambiente WHATSAPP_ATIVO=true no Railway.
  const WHATSAPP_ATIVO = String(process.env.WHATSAPP_ATIVO || "").toLowerCase() === "true";
  if (WHATSAPP_ATIVO) {
    await whatsapp.iniciarConexao(tratarMensagemWhatsapp, tratarDocumentoWhatsapp);
  } else {
    console.log(
      "[server] WhatsApp desativado por enquanto (sem numero/celular ainda). " +
        "Quando estiver pronto, configure WHATSAPP_ATIVO=true no Railway pra ativar."
    );
  }
}

main().catch((e) => {
  console.error("[server] erro fatal ao iniciar:", e);
  process.exit(1);
});
