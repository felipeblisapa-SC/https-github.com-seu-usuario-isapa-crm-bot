"use strict";

// Dados oficiais do EDI (Evolucao Desempenho Individual) da Isapa - relatorio
// oficial do representante, usado como fonte de verdade pra ranking/faturamento
// (o banco local SFA.DB e limitado por cliente, entao isso complementa).
//
// Gerado uma vez (extraido dos PDFs oficiais que o Felipe mandou) e salvo em
// config/edi_oficial.json. Pra atualizar, repita a extracao com um EDI mais
// recente e regenere esse arquivo (nao ha automatizacao disso ainda).

const fs = require("fs");
const path = require("path");

// NAO fica em data/ de proposito: o volume persistente do Railway e'
// montado em /app/data, o que ESCONDE qualquer arquivo que esteja em data/
// dentro da imagem (mesmo motivo documentado em grupos.js). edi_oficial.json
// e' configuracao estatica, entao mora em config/ pra nao ser engolida pelo
// volume.
const EDI_PATH = path.join(__dirname, "..", "config", "edi_oficial.json");

let dados = null;

function carregar() {
  if (!fs.existsSync(EDI_PATH)) {
    console.log("[edi] edi_oficial.json nao encontrado - dados oficiais do EDI indisponiveis.");
    return;
  }
  try {
    dados = JSON.parse(fs.readFileSync(EDI_PATH, "utf-8"));
    console.log(
      `[edi] dados oficiais carregados: ${dados.por_cliente.length} clientes, ${Object.keys(dados.por_grupo || {}).length} grupos, ${dados.periodo_label}.`
    );
  } catch (e) {
    console.error("[edi] falha ao carregar edi_oficial.json:", e.message);
    dados = null;
  }
}

function todosDados() {
  return dados;
}

module.exports = { carregar, todosDados };
