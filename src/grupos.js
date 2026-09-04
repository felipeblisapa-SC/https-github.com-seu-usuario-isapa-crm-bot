"use strict";

// Grupos de clientes: varios cadastros (CNPJs) do MEX3000 que na pratica sao
// o mesmo cliente/loja comprando por mais de uma razao social (ex: GRUPO BR
// BALANCE). Isso NAO existe no banco local (SFA.DB) - o campo que poderia
// guardar isso (CLIENTES.COD_REDE) esta sempre vazio - entao mantemos essa
// lista manualmente aqui, alimentada aos poucos pelo Felipe a partir dos
// relatorios oficiais da Isapa (EDI - Evolucao Desempenho Individual).
//
// Para adicionar um grupo novo, edite config/grupos_clientes.json:
//   { "nome": "GRUPO EXEMPLO", "clientes": [ {"cod_cli": 123, "razao": "..."} ] }

const fs = require("fs");
const path = require("path");

// NAO fica em data/ de proposito: o volume persistente do Railway e'
// montado em /app/data (ver README, secao "Adicionar um volume
// persistente"), o que ESCONDE qualquer arquivo que esteja em data/ dentro
// da imagem (o volume, vazio ou desatualizado, substitui o conteudo da
// pasta inteira no container). grupos_clientes.json e' configuracao
// estatica que faz parte do codigo, entao mora em config/ pra nao ser
// engolida pelo volume.
const GRUPOS_PATH = path.join(__dirname, "..", "config", "grupos_clientes.json");

let grupos = [];
// mapa cod_cli (numero) -> grupo, montado a partir de "grupos" pra busca rapida
let porCliente = new Map();

function carregar() {
  if (!fs.existsSync(GRUPOS_PATH)) {
    console.log("[grupos] grupos_clientes.json nao encontrado - nenhum grupo de clientes configurado.");
    return;
  }
  try {
    grupos = JSON.parse(fs.readFileSync(GRUPOS_PATH, "utf-8"));
    porCliente = new Map();
    for (const g of grupos) {
      for (const c of g.clientes || []) {
        porCliente.set(Number(c.cod_cli), g);
      }
    }
    console.log(`[grupos] ${grupos.length} grupo(s) de clientes carregado(s), ${porCliente.size} cadastros mapeados.`);
  } catch (e) {
    console.error("[grupos] falha ao carregar grupos_clientes.json:", e.message);
    grupos = [];
    porCliente = new Map();
  }
}

function getGrupoDoCliente(codCli) {
  return porCliente.get(Number(codCli)) || null;
}

function todosGrupos() {
  return grupos;
}

module.exports = { carregar, getGrupoDoCliente, todosGrupos };
