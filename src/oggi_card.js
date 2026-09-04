"use strict";

// Card visual de estoque da OGGI (imagem PNG mandada no WhatsApp) - padrão
// aprovado pelo Felipe num projeto anterior: card branco arredondado, título
// com o modelo, duas seções (ITAJAÍ/17 = vendável, UBERLÂNDIA/09 = só
// referência), tabela por cor (bolinha colorida + nome) x tamanho, negativo
// em vermelho, "—" quando aquele tamanho não existe pra aquela cor.
//
// Depende só do "sharp" (já é dependência do projeto, usado pra recortar
// fotos do catálogo Isapa) - ele converte SVG -> PNG sem precisar de
// Chromium/puppeteer, o que seria muito mais pesado pra rodar no Railway.

const sharp = require("sharp");

// ---------------------------------------------------------------------------
// Cores: os PDFs de estoque abreviam em português (ex: "AZ/CINZA",
// "VD/VERM/CINZA", "GRAF/VD/AMAR"). Aqui a gente expande pra nome completo e
// escolhe uma cor de bolinha aproximada pra cada pedaço.
// ---------------------------------------------------------------------------
const CORES = {
  AZ: { nome: "Azul", hex: "#2563eb" },
  CINZA: { nome: "Cinza", hex: "#9ca3af" },
  VERM: { nome: "Vermelho", hex: "#dc2626" },
  VERMELHO: { nome: "Vermelho", hex: "#dc2626" },
  BCO: { nome: "Branco", hex: "#ffffff", borda: "#d1d5db" },
  BRANCO: { nome: "Branco", hex: "#ffffff", borda: "#d1d5db" },
  VD: { nome: "Verde", hex: "#16a34a" },
  VERDE: { nome: "Verde", hex: "#16a34a" },
  PTO: { nome: "Preto", hex: "#111827" },
  PRT: { nome: "Preto", hex: "#111827" },
  PRETO: { nome: "Preto", hex: "#111827" },
  AMAR: { nome: "Amarelo", hex: "#eab308" },
  AMARELO: { nome: "Amarelo", hex: "#eab308" },
  LAR: { nome: "Laranja", hex: "#f97316" },
  LARANJA: { nome: "Laranja", hex: "#f97316" },
  GRAF: { nome: "Grafite", hex: "#4b5563" },
  GRAFITE: { nome: "Grafite", hex: "#4b5563" },
  ROSA: { nome: "Rosa", hex: "#ec4899" },
  MILIT: { nome: "Militar", hex: "#4d7c0f" },
  ECR: { nome: "Ecrú", hex: "#e7e0c9", borda: "#d1d5db" },
  VNH: { nome: "Vinho", hex: "#7f1d1d" },
};

function corDoToken(token) {
  const t = (token || "").toUpperCase();
  return CORES[t] || { nome: token, hex: "#9ca3af" };
}

// "AZ/CINZA" -> { nomeCompleto: "Azul/Cinza", partes: [{nome,hex,borda?}, ...] }
function expandirCodigoCor(codigo) {
  const partes = codigo.split("/").map(corDoToken);
  return { nomeCompleto: partes.map((p) => p.nome).join("/"), partes };
}

// Nomes de linha abreviados no texto do estoque -> nome comercial completo
// pro título do card (ex: "BW 7.3 DEORE 12V" -> "Big Wheel 7.3 Deore 12V" -
// mesmo padrão de capitalização do card aprovado pelo Felipe: só a primeira
// letra maiúscula em cada palavra, exceto tokens que começam com número
// (versão/aro, ex: "12V", "7.3", "S1000" ficam como estão).
function nomeExibicaoModelo(modelo) {
  const expandido = modelo.replace(/\bBW\b/i, "Big Wheel");
  return expandido
    .split(" ")
    .map((tok) => (/^\d/.test(tok) ? tok : tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase()))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Extração: acha as linhas do texto bruto (pdftotext -layout) que pertencem
// ao modelo pedido, e organiza por cor x tamanho.
//
// Cada linha tem o formato (larguras variam, mas a ORDEM das colunas é fixa -
// confirmado comparando com um card aprovado pelo Felipe):
//   CODIGO   BIC OGGI <aro> <MODELO...> <COR> <TAMANHO> <ANO>   disp.UBER  antec.UBER  disp.ITAJAI  antec.ITAJAI
// ---------------------------------------------------------------------------
const RE_LINHA = /(BA\d{6})\s+BIC OGGI \d+ ([A-Z0-9 /.\-]+?) ([A-Z]{2,6}(?:\/[A-Z]{2,6}){0,3}) (\d{1,2},\d|\d{1,2}|S|M|L|XL|U) 20\d\d\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/g;

const ORDEM_TAMANHOS_LETRA = ["PP", "P", "S", "M", "L", "XL", "XXL", "U"];

function ordenarTamanhos(tamanhos) {
  return [...tamanhos].sort((a, b) => {
    const na = parseFloat(String(a).replace(",", "."));
    const nb = parseFloat(String(b).replace(",", "."));
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    const ia = ORDEM_TAMANHOS_LETRA.indexOf(a);
    const ib = ORDEM_TAMANHOS_LETRA.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    return String(a).localeCompare(String(b));
  });
}

// Extrai os dados estruturados de UM modelo a partir do texto bruto do
// estoque. `nomeModelo` é o campo "modelo" do catálogo (ex: "BW 7.3 DEORE
// 12V") - comparamos ignorando espaços/acentos/maiúsculas.
function extrairDadosModelo(textoEstoque, nomeModelo) {
  const alvoNorm = nomeModelo
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const porCor = new Map(); // codigoCor -> { nomeCompleto, partes, porTamanho: {tam:{uber,itajai}} }
  const tamanhosVistos = new Set();
  let match;
  RE_LINHA.lastIndex = 0;
  while ((match = RE_LINHA.exec(textoEstoque)) !== null) {
    const [, , descModelo, codigoCor, tamanho, uberDisp, , itajaiDisp] = match;
    const descNorm = descModelo
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!descNorm.includes(alvoNorm)) continue;

    if (!porCor.has(codigoCor)) {
      porCor.set(codigoCor, { ...expandirCodigoCor(codigoCor), codigo: codigoCor, porTamanho: {} });
    }
    porCor.get(codigoCor).porTamanho[tamanho] = {
      uberlandia: parseInt(uberDisp, 10),
      itajai: parseInt(itajaiDisp, 10),
    };
    tamanhosVistos.add(tamanho);
  }

  if (porCor.size === 0) return null;

  return {
    modelo: nomeModelo,
    modeloExibicao: nomeExibicaoModelo(nomeModelo),
    tamanhos: ordenarTamanhos([...tamanhosVistos]),
    cores: [...porCor.values()],
  };
}

// ---------------------------------------------------------------------------
// Preços: config/oggi/precos/oggi_custos.txt (extraído de uma planilha em
// PDF - "pdftotext -layout"). Cada modelo aparece como um "bloco" de até 3
// pedaços de texto:
//   1. uma linha de valores ANTES do nome (a "tabela" - preço de lista,
//      sem ajuste automático do dia) - só existe pra alguns modelos;
//   2. opcionalmente "Promocional - R$X,XX DIAMANTE" logo depois dela -
//      esse é o sinal de que o modelo está PROMOCIONADO;
//   3. a linha "BICICLETA OGGI ... (COMPONENTE) ANO" com o nome do modelo -
//      às vezes os valores vêm JUNTO nessa mesma linha (modelos sem
//      ajuste automático nem promoção, ex: CATTURA FLAIR SQUADRA);
//   4. quando não vêm juntos, a PRÓXIMA linha não-vazia traz "(Automático
//      Sistema - X%)" + os valores atualizados do dia - essa é a linha que
//      a gente usa como preço ATUAL (mais recente que a "tabela" estática).
//
// Cada linha de valores tem até 6 números com R$ (o 1º, quando existe além
// dos 5 de sempre, é só um eco da coluna TABELAS/PROMOÇÃO igual ao valor de
// OURO - confirmado comparando linhas onde essa coluna vem em branco "-" -
// por isso sempre pegamos só os ÚLTIMOS 5: Bronze, Prata, Ouro, Platinum,
// e por fim o preço Sugerido (sem %). O Diamante nunca aparece como uma 6ª
// coluna própria - só existe via a linha "Promocional - ... DIAMANTE".
// ---------------------------------------------------------------------------
const RE_VALOR_PCT = /R\$\s*([\d.,]+)(?:\s*(-?\d+)%)?/g;

function paraNumero(strBR) {
  if (!strBR) return null;
  const n = parseFloat(strBR.replace(/\./g, "").replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

function parseValoresLinha(linha) {
  const out = [];
  let m;
  RE_VALOR_PCT.lastIndex = 0;
  while ((m = RE_VALOR_PCT.exec(linha)) !== null) {
    out.push({ valor: paraNumero(m[1]), pct: m[2] != null ? parseInt(m[2], 10) : null });
  }
  return out;
}

function ultimosCinco(valores) {
  return valores.length >= 5 ? valores.slice(-5) : valores;
}

// Normaliza um nome de modelo (do catálogo OU do arquivo de preços) pra
// comparação: maiúsculas, sem acento, "BW" expandido pra "BIG WHEEL" (é
// assim que o arquivo de preços escreve por extenso), espaços colapsados.
function normalizarNomeModelo(nome) {
  return nome
    .replace(/\bBW\b/i, "BIG WHEEL")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Quebra o texto bruto do arquivo de preços em blocos, um por modelo (ver
// explicação do formato acima).
function extrairBlocosPrecos(textoPrecos) {
  const linhas = textoPrecos.split("\n");
  const blocos = [];

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha.trim().startsWith("BICICLETA")) continue;

    const valoresProprios = parseValoresLinha(linha);
    if (valoresProprios.length > 0) {
      // formato "tudo numa linha só" (sem promoção, sem ajuste automático)
      const nome = linha.replace(/\s{2,}.*$/, "").trim();
      blocos.push({
        nome,
        sistema: ultimosCinco(valoresProprios),
        sistemaPct: null,
        promoDiamante: null,
      });
      continue;
    }

    const nome = linha.replace(/\s+/g, " ").trim();
    let promoDiamante = null;
    let j = i - 1;
    if (j >= 0 && /promocional/i.test(linhas[j])) {
      const m = linhas[j].match(/Promocional\s*-\s*([\d.,]+)\s*DIAMANTE/i);
      if (m) promoDiamante = paraNumero(m[1]);
      j -= 1;
    }
    let tabela = null;
    if (j >= 0) {
      const valoresTabela = parseValoresLinha(linhas[j]);
      if (valoresTabela.length > 0) tabela = ultimosCinco(valoresTabela);
    }

    let sistema = null;
    let sistemaPct = null;
    let k = i + 1;
    while (k < linhas.length && !linhas[k].trim()) k += 1;
    if (k < linhas.length) {
      const mPct = linhas[k].match(/Autom[aá]tico Sistema\s*-\s*(-?[\d.,]+)%/i);
      if (mPct) sistemaPct = paraNumero(mPct[1]);
      const valoresSistema = parseValoresLinha(linhas[k]);
      if (valoresSistema.length > 0) sistema = ultimosCinco(valoresSistema);
    }

    blocos.push({ nome, tabela, sistema, sistemaPct, promoDiamante });
  }

  return blocos;
}

// Acha o bloco de preço de UM modelo: todo token relevante do nome do
// catálogo (ex: "BW 7.3 DEORE 12V" -> ["BIG","WHEEL","7.3","DEORE","12V"])
// precisa aparecer no nome do bloco de preço - mesmo critério "todas as
// palavras batem" usado na busca do catálogo de fotos (oggi_catalogo.js).
function encontrarBlocoPreco(blocos, nomeModelo) {
  const alvoNorm = normalizarNomeModelo(nomeModelo);
  const tokens = alvoNorm.split(" ").filter(Boolean);
  const candidatos = blocos.filter((b) => {
    const nomeNorm = normalizarNomeModelo(b.nome);
    return tokens.every((t) => nomeNorm.includes(t));
  });
  if (candidatos.length === 0) return null;
  // Se mais de um bater (raro), fica com o de nome mais curto - tende a ser
  // o match mais específico/exato (evita pegar uma variante "T-110" etc.
  // por engano quando existe um nome mais direto).
  candidatos.sort((a, b) => a.nome.length - b.nome.length);
  return candidatos[0];
}

// Devolve { ouro, platinum, diamante, sugerido, promocionado, percentualSistema }
// pro modelo pedido, usando a linha "sistema" (preço ajustado automático do
// dia) quando existir, senão a linha "tabela" (formato "tudo numa linha só").
// Cada valor de preço vem como {valor, pct} ou null.
function extrairPrecosModelo(textoPrecos, nomeModelo) {
  const blocos = extrairBlocosPrecos(textoPrecos);
  const bloco = encontrarBlocoPreco(blocos, nomeModelo);
  if (!bloco) return null;

  const linhaAtual = bloco.sistema || bloco.tabela;
  if (!linhaAtual || linhaAtual.length < 5) return null;

  const [, , ouro, platinum, sugerido] = linhaAtual; // [bronze, prata, ouro, platinum, sugerido]
  return {
    ouro,
    platinum,
    diamante: bloco.promoDiamante != null ? { valor: bloco.promoDiamante, pct: null } : null,
    sugerido,
    promocionado: bloco.promoDiamante != null,
    percentualSistema: bloco.sistemaPct,
  };
}

function fmtMoeda(valor) {
  if (valor == null) return "—";
  return "R$ " + valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Extrai a data (DD/MM) associada à coluna "ESTOQUE DISPONÍVEL (ITAJAÍ)" no
// cabeçalho do relatório - é essa data que aparece como referência no card,
// já que Itajaí é o armazém vendável (o que importa pra saber se está
// desatualizado).
function extrairDataBaseItajai(textoEstoque) {
  const cab = textoEstoque.slice(0, 600);
  const todasDatas = [...cab.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)].map((m2) => m2[1]);
  if (todasDatas.length >= 3) {
    const [dd, mm] = todasDatas[2].split("/");
    return `${dd}/${mm}`;
  }
  if (todasDatas.length >= 1) {
    const [dd, mm] = todasDatas[0].split("/");
    return `${dd}/${mm}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------
function escaparXml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function montarSvgCard(dados, dataBase, precos) {
  const W = 640;
  const PAD = 24;
  const COL_COR = 190;
  const larguraTabela = W - PAD * 2;
  const larguraColTamanho = (larguraTabela - COL_COR) / dados.tamanhos.length;

  let y = 0;
  const partes = [];

  // fundo do card
  partes.push(`<rect x="0" y="0" width="${W}" height="HEIGHT_PLACEHOLDER" rx="18" fill="#ffffff" stroke="#e5e7eb" stroke-width="1.5"/>`);

  y += 30;
  partes.push(
    `<text x="${PAD}" y="${y}" font-family="Arial, sans-serif" font-size="12" font-weight="600" fill="#6b7280" letter-spacing="1">OGGI · LINHA MTB</text>`
  );

  y += 30;
  partes.push(
    `<text x="${PAD}" y="${y}" font-family="Arial, sans-serif" font-size="23" font-weight="700" fill="#111827">${escaparXml(dados.modeloExibicao)}</text>`
  );

  y += 22;
  const subtitulo = dataBase
    ? `Base: PDF de ${dataBase} · ainda sem anexo mais recente`
    : "Base: PDF mais recente recebido";
  partes.push(
    `<text x="${PAD}" y="${y}" font-family="Arial, sans-serif" font-size="12.5" fill="#9ca3af">${escaparXml(subtitulo)}</text>`
  );

  // Aviso GRANDE de promoção - só aparece quando o modelo tem um preço
  // Diamante promocional cadastrado (ver extrairPrecosModelo). Faixa
  // vermelha/laranja cheia, impossível de não ver.
  if (precos && precos.promocionado) {
    y += 16;
    const alturaBanner = 40;
    partes.push(`<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${alturaBanner}" rx="8" fill="#dc2626"/>`);
    partes.push(
      `<text x="${W / 2}" y="${y + 26}" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#ffffff">🔥 BIKE PROMOCIONADA — DIAMANTE ${escaparXml(fmtMoeda(precos.diamante.valor))}</text>`
    );
    y += alturaBanner + 12;
  }

  // Chips de preço (Ouro / Platinum / Diamante) - só aparece quando achamos
  // o modelo na tabela de preços (config/oggi/precos/oggi_custos.txt).
  if (precos) {
    y += 14;
    const chips = [
      { rotulo: "OURO", cor: "#b45309", valor: precos.ouro ? precos.ouro.valor : null, pct: precos.ouro ? precos.ouro.pct : null },
      { rotulo: "PLATINUM", cor: "#475569", valor: precos.platinum ? precos.platinum.valor : null, pct: precos.platinum ? precos.platinum.pct : null },
      { rotulo: "DIAMANTE", cor: "#0e7490", valor: precos.diamante ? precos.diamante.valor : null, pct: precos.diamante ? precos.diamante.pct : null },
    ];
    const larguraChip = (W - PAD * 2 - 16) / 3;
    const alturaChip = 56;
    chips.forEach((chip, i) => {
      const cx = PAD + i * (larguraChip + 8);
      partes.push(`<rect x="${cx}" y="${y}" width="${larguraChip}" height="${alturaChip}" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1"/>`);
      partes.push(
        `<text x="${cx + larguraChip / 2}" y="${y + 20}" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="${chip.cor}" letter-spacing="0.5">${chip.rotulo}${chip.pct != null ? " · " + chip.pct + "%" : ""}</text>`
      );
      partes.push(
        `<text x="${cx + larguraChip / 2}" y="${y + 42}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#111827">${escaparXml(fmtMoeda(chip.valor))}</text>`
      );
    });
    y += alturaChip + 10;
    partes.push(
      `<text x="${PAD}" y="${y}" font-family="Arial, sans-serif" font-size="10.5" fill="#9ca3af">Preços de uso interno - não repassar ao cliente${precos.sugerido != null ? ` · Sugerido ao cliente: ${escaparXml(fmtMoeda(precos.sugerido.valor))}` : ""}</text>`
    );
    y += 6;
  }

  y += 22;
  partes.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`);

  function secaoTabela(titulo, chave) {
    y += 34;
    partes.push(
      `<text x="${PAD}" y="${y}" font-family="Arial, sans-serif" font-size="12.5" font-weight="700" fill="#374151" letter-spacing="0.5">${escaparXml(titulo)}</text>`
    );

    y += 24;
    // cabecalho da tabela
    partes.push(
      `<text x="${PAD}" y="${y}" font-family="Arial, sans-serif" font-size="11" font-weight="600" fill="#9ca3af">Cor</text>`
    );
    dados.tamanhos.forEach((tam, i) => {
      const cx = PAD + COL_COR + larguraColTamanho * i + larguraColTamanho - 8;
      partes.push(
        `<text x="${cx}" y="${y}" text-anchor="end" font-family="Arial, sans-serif" font-size="11" font-weight="600" fill="#9ca3af">${escaparXml(tam)}</text>`
      );
    });
    y += 10;
    partes.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#f0f1f3" stroke-width="1"/>`);

    for (const cor of dados.cores) {
      y += 30;
      // bolinhas (ate 2, sobrepostas tipo venn - se tiver 3+ partes so mostra as 2 primeiras)
      const partesCor = cor.partes.slice(0, 2);
      const cxBase = PAD + 7;
      partesCor.forEach((p, i) => {
        const cx = cxBase + i * 9;
        partes.push(
          `<circle cx="${cx}" cy="${y - 5}" r="7" fill="${p.hex}" stroke="${p.borda || (p.hex === "#ffffff" ? "#d1d5db" : "none")}" stroke-width="1"/>`
        );
      });
      const xNome = cxBase + partesCor.length * 9 + 6;
      partes.push(
        `<text x="${xNome}" y="${y}" font-family="Arial, sans-serif" font-size="13.5" fill="#111827">${escaparXml(cor.nomeCompleto)}</text>`
      );

      dados.tamanhos.forEach((tam, i) => {
        const cx = PAD + COL_COR + larguraColTamanho * i + larguraColTamanho - 8;
        const registro = cor.porTamanho[tam];
        if (!registro) {
          partes.push(
            `<text x="${cx}" y="${y}" text-anchor="end" font-family="Arial, sans-serif" font-size="13.5" fill="#d1d5db">—</text>`
          );
          return;
        }
        const valor = chave === "itajai" ? registro.itajai : registro.uberlandia;
        const negativo = valor < 0;
        partes.push(
          `<text x="${cx}" y="${y}" text-anchor="end" font-family="Arial, sans-serif" font-size="13.5" font-weight="${negativo ? "700" : "400"}" fill="${negativo ? "#dc2626" : "#111827"}">${valor}</text>`
        );
      });
    }
    y += 18;
  }

  secaoTabela("ITAJAÍ (17) — DISPONÍVEL PRA PEDIDO", "itajai");
  y += 8;
  partes.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`);
  secaoTabela("UBERLÂNDIA (09) — NÃO DISPONÍVEL PRA PEDIDO", "uberlandia");

  y += PAD;
  const H = y;
  partes[0] = partes[0].replace("HEIGHT_PLACEHOLDER", String(H));

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${W}" height="${H}" fill="#f3f4f6"/>${partes.join("\n")}</svg>`;
}

async function gerarPng(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Ponto de entrada: dado o texto bruto do estoque + nome do modelo (campo
// "modelo" do catálogo, ex: "BW 7.3 DEORE 12V") + (opcional) o texto bruto
// da tabela de preços (config/oggi/precos/oggi_custos.txt), monta o card e
// devolve o PNG pronto pra mandar no WhatsApp. Devolve null se não achou
// nenhuma linha desse modelo no estoque (preço é opcional - sem ele, o card
// sai só com o estoque, sem os chips Ouro/Platinum/Diamante nem o aviso de
// promoção).
async function gerarCardEstoque(textoEstoque, nomeModelo, textoPrecos) {
  const dados = extrairDadosModelo(textoEstoque, nomeModelo);
  if (!dados) return null;
  const dataBase = extrairDataBaseItajai(textoEstoque);
  const precos = textoPrecos ? extrairPrecosModelo(textoPrecos, nomeModelo) : null;
  const svg = montarSvgCard(dados, dataBase, precos);
  const buffer = await gerarPng(svg);
  return { buffer, dados, precos, svg };
}

module.exports = {
  extrairDadosModelo,
  extrairDataBaseItajai,
  extrairBlocosPrecos,
  encontrarBlocoPreco,
  extrairPrecosModelo,
  montarSvgCard,
  gerarPng,
  gerarCardEstoque,
  nomeExibicaoModelo,
};
