"use strict";

// Indice do catalogo de produtos (fotos) da Isapa. Ve o README para como
// gerar/atualizar catalog_index.json e catalogo.pdf quando chegar uma versao
// nova do catalogo.
//
// catalog_index.json e catalogo.pdf sao ESTATICOS (vem prontos com o codigo,
// gerados por sync/build_catalog_index.py) - por isso moram em config/catalogo/,
// nao em data/catalogo/. Mesmo motivo documentado em grupos.js/edi.js: o
// volume persistente do Railway e' montado em /app/data, o que esconde
// qualquer arquivo novo colocado em data/ depois que o volume ja existe (o
// catalogo original funcionava porque foi adicionado ANTES do volume
// existir - mas uma atualizacao de catalogo feita DEPOIS ficaria escondida
// se continuasse em data/, exatamente como aconteceu com grupos_clientes.json
// e edi_oficial.json). So o cache de paginas renderizadas (TMP_DIR, gerado
// em tempo de execucao, pode ser perdido sem problema) continua em data/.
//
// Recorta a foto do produto SOB DEMANDA (so quando alguem pergunta), usando
// pdftoppm (poppler-utils, precisa estar instalado no ambiente - ver
// nixpacks.toml) para renderizar so a pagina necessaria, e sharp para
// cortar a regiao exata da foto.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);
const sharp = require("sharp");

const CATALOGO_DIR = path.join(__dirname, "..", "config", "catalogo");
const INDEX_PATH = path.join(CATALOGO_DIR, "catalog_index.json");
const PDF_PATH = path.join(CATALOGO_DIR, "catalogo.pdf");
const TMP_DIR = path.join(__dirname, "..", "data", "catalogo", "tmp");

const DPI = 200;
const SCALE = DPI / 72;

let indice = [];

function carregar() {
  if (fs.existsSync(INDEX_PATH)) {
    indice = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    console.log(`[catalog] indice carregado: ${indice.length} produtos.`);
  } else {
    console.log("[catalog] catalog_index.json nao encontrado - fotos do catalogo indisponiveis.");
  }
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function temCatalogo() {
  return indice.length > 0 && fs.existsSync(PDF_PATH);
}

function normaliza(txt) {
  return (txt || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Busca por codigo exato ou por palavras da descricao do catalogo.
// Aceita descricao "generica" (varias palavras que precisam bater todas).
function buscar(termo, limite = 25) {
  const t = normaliza(termo).trim();
  if (!t) return [];

  // codigo exato
  const porCodigo = indice.filter((e) => e.cod_prod === termo.trim());
  if (porCodigo.length) return porCodigo.slice(0, limite);

  // todas as palavras da busca precisam aparecer no texto do catalogo
  const palavras = t.split(/\s+/).filter((w) => w.length >= 3);
  if (palavras.length === 0) return [];

  const encontrados = indice.filter((e) => {
    const desc = normaliza(e.texto_catalogo);
    return palavras.every((p) => desc.includes(p));
  });
  return encontrados.slice(0, limite);
}

// Renderiza a pagina (cache simples em disco) e retorna o caminho do PNG da pagina inteira.
async function renderizarPagina(pagina) {
  const destPrefix = path.join(TMP_DIR, `pagina-${pagina}`);
  const destPng = `${destPrefix}.png`;
  if (fs.existsSync(destPng)) return destPng;

  await execFileAsync("pdftoppm", [
    "-f", String(pagina),
    "-l", String(pagina),
    "-r", String(DPI),
    "-png",
    PDF_PATH,
    destPrefix,
  ]);

  // pdftoppm gera "<prefix>-<pagina>.png" (ou "-01" etc dependendo da versao) -
  // procura o arquivo que ele realmente criou.
  const dir = fs.readdirSync(TMP_DIR);
  const gerado = dir.find((f) => f.startsWith(`pagina-${pagina}-`) && f.endsWith(".png"));
  if (!gerado) throw new Error(`pdftoppm nao gerou imagem para a pagina ${pagina}`);
  const gerowPath = path.join(TMP_DIR, gerado);
  if (gerowPath !== destPng) fs.renameSync(gerowPath, destPng);
  return destPng;
}

// Retorna um Buffer PNG so com a foto do produto (recortada da pagina).
async function fotoDoProduto(entrada) {
  const paginaPng = await renderizarPagina(entrada.pagina);
  const [x0, y0, x1, y1] = entrada.photo_bbox;
  const left = Math.max(0, Math.round(x0 * SCALE));
  const top = Math.max(0, Math.round(y0 * SCALE));
  const width = Math.max(1, Math.round((x1 - x0) * SCALE));
  const height = Math.max(1, Math.round((y1 - y0) * SCALE));

  return sharp(paginaPng)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
}

module.exports = { carregar, temCatalogo, buscar, fotoDoProduto, normaliza };
