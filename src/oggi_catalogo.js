"use strict";

// Catálogo de fotos/ficha técnica da OGGI (134 páginas, ~37 modelos, um PDF
// por página: cada modelo tem N páginas de foto - uma por cor - seguidas de
// UMA página de "ficha técnica completa". Ver README, seção "OGGI / StreetGo
// / Yoo", pra como o índice (config/oggi/catalogo/catalog_index.json) foi
// montado (o título de cada modelo é um desenho/gráfico, não texto - não dá
// pra extrair com pdftotext, então foi lido visualmente página por página).
//
// Mesmo princípio de config/ vs data/ do resto do projeto: o catálogo é
// estático (vem pronto com o código), então mora em config/ - nunca em
// data/, senão o volume do Railway esconde ele depois do primeiro deploy
// (ver README).
//
// Ao contrário do catálogo da Isapa (catalog.js), aqui cada página já É a
// foto inteira (bike + fundo branco) - não precisa recortar uma região, só
// renderizar a página e mandar como imagem.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

const CATALOGO_DIR = path.join(__dirname, "..", "config", "oggi", "catalogo");
const INDEX_PATH = path.join(CATALOGO_DIR, "catalog_index.json");
const PDF_PATH = path.join(CATALOGO_DIR, "catalogo.pdf");
const TMP_DIR = path.join(CATALOGO_DIR, "tmp");

const DPI = 150;

let indice = [];

function carregar() {
  if (fs.existsSync(INDEX_PATH) && fs.existsSync(PDF_PATH)) {
    indice = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    console.log(`[oggi_catalogo] índice carregado: ${indice.length} modelos.`);
  } else {
    console.log("[oggi_catalogo] catalog_index.json/catalogo.pdf não encontrados - fotos/ficha técnica da OGGI indisponíveis.");
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

// Busca por nome de modelo - todas as palavras da busca precisam aparecer no
// texto do modelo (mesmo critério do catalog.js da Isapa).
function buscar(termo, limite = 10) {
  const t = normaliza(termo).trim();
  if (!t) return [];
  const palavras = t.split(/\s+/).filter((w) => w.length >= 2);
  if (palavras.length === 0) return [];
  const encontrados = indice.filter((m) => palavras.every((p) => m.texto_busca.includes(p)));
  return encontrados.slice(0, limite);
}

async function renderizarPagina(pagina) {
  const destPrefix = path.join(TMP_DIR, `pagina-${pagina}`);
  const destPng = `${destPrefix}.png`;
  if (fs.existsSync(destPng)) return destPng;

  await execFileAsync("pdftoppm", ["-f", String(pagina), "-l", String(pagina), "-r", String(DPI), "-png", PDF_PATH, destPrefix]);

  const dir = fs.readdirSync(TMP_DIR);
  const gerado = dir.find((f) => f.startsWith(`pagina-${pagina}-`) && f.endsWith(".png"));
  if (!gerado) throw new Error(`pdftoppm não gerou imagem para a página ${pagina}`);
  const gerowPath = path.join(TMP_DIR, gerado);
  if (gerowPath !== destPng) fs.renameSync(gerowPath, destPng);
  return destPng;
}

// Retorna um Buffer PNG de uma página inteira do catálogo (foto ou ficha técnica).
async function paginaComoImagem(pagina) {
  const destPng = await renderizarPagina(pagina);
  return fs.readFileSync(destPng);
}

module.exports = { carregar, temCatalogo, buscar, paginaComoImagem };
