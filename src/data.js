"use strict";

// Guarda o ultimo pacote de dados recebido do script de sincronizacao
// (sync/sync_to_cloud.py) e oferece funcoes simples de busca para montar
// o contexto que vai para a IA a cada pergunta no WhatsApp.
//
// Isto e' deliberadamente simples (busca por texto, sem banco vetorial):
// funciona bem para ate' alguns milhares de clientes/produtos. Se a base
// crescer muito, vale trocar por um banco de verdade (Postgres) com indices.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SNAPSHOT_PATH = path.join(DATA_DIR, "snapshot.json");
const HISTORICO_PATH = path.join(DATA_DIR, "historico_pedidos.json");
const ESTOQUE_SC_HIST_PATH = path.join(DATA_DIR, "estoque_sc_historico.json");

// Quantos dias de historico de estoque SC guardar (poda o que for mais
// velho que isso a cada sync, pra nao crescer pra sempre).
const NOVIDADES_JANELA_DIAS = 10;
const ESTOQUE_SC_HIST_RETENCAO_DIAS = 20;

let snapshot = null;

// Historico diario do estoque SC (filial 06), usado pra descobrir "Novidades"
// - produtos que passaram a ter estoque SC nos ultimos N dias. Formato:
// { "AAAA-MM-DD": { "<cod_prod>": estoque_sc, ... }, ... } - uma entrada por
// dia (a ultima sync daquele dia sobrescreve a entrada do dia).
let estoqueScHistorico = {};

// Base separada e permanente de pedidos. O MEX3000 local (SFA.DB) so' guarda
// os ultimos pedidos de cada cliente (uma janela rolante) - pedidos mais
// antigos vao sumindo da sincronizacao com o tempo. Aqui a gente ACUMULA:
// todo pedido que ja apareceu numa sincronizacao fica guardado pra sempre
// (mesmo depois de sumir do MEX3000), atualizando so' os campos (status,
// valor etc.) enquanto ele ainda aparecer nos envios.
// Formato: { "<cod_ped>": {...campos do pedido, primeira_vez_visto, ultima_atualizacao} }
let historico = {};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFromDisk() {
  ensureDataDir();
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try {
      const raw = fs.readFileSync(SNAPSHOT_PATH, "utf-8");
      snapshot = JSON.parse(raw);
      console.log(
        `[data] snapshot carregado do disco (gerado em ${snapshot.gerado_em_hora || snapshot.gerado_em}), ` +
          `${snapshot.clientes?.length || 0} clientes.`
      );
    } catch (e) {
      console.error("[data] falha ao carregar snapshot salvo:", e.message);
    }
  } else {
    console.log("[data] nenhum snapshot salvo ainda. Aguardando primeira sincronizacao.");
  }

  if (fs.existsSync(HISTORICO_PATH)) {
    try {
      const raw = fs.readFileSync(HISTORICO_PATH, "utf-8");
      historico = JSON.parse(raw);
      console.log(`[data] historico de pedidos carregado: ${Object.keys(historico).length} pedidos acumulados.`);
    } catch (e) {
      console.error("[data] falha ao carregar historico salvo:", e.message);
      historico = {};
    }
  } else {
    console.log("[data] nenhum historico de pedidos salvo ainda.");
  }

  if (fs.existsSync(ESTOQUE_SC_HIST_PATH)) {
    try {
      const raw = fs.readFileSync(ESTOQUE_SC_HIST_PATH, "utf-8");
      estoqueScHistorico = JSON.parse(raw);
      console.log(
        `[data] historico de estoque SC carregado: ${Object.keys(estoqueScHistorico).length} dias.`
      );
    } catch (e) {
      console.error("[data] falha ao carregar historico de estoque SC:", e.message);
      estoqueScHistorico = {};
    }
  } else {
    console.log("[data] nenhum historico de estoque SC salvo ainda.");
  }
}

// Data de hoje no formato AAAA-MM-DD (fuso do servidor).
function hojeISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

// Registra o estoque SC (filial 06) de hoje no historico, sobrescrevendo a
// entrada do dia se ja existir (cada sync do dia atualiza pra versao mais
// recente). Poda entradas mais velhas que ESTOQUE_SC_HIST_RETENCAO_DIAS.
function registrarEstoqueScDoDia(listaEstoque) {
  if (!Array.isArray(listaEstoque)) return;
  const hoje = hojeISO();
  const mapaHoje = {};
  for (const item of listaEstoque) {
    if (item == null || item.cod_prod == null) continue;
    mapaHoje[item.cod_prod] = item.estoque_sc || 0;
  }
  estoqueScHistorico[hoje] = mapaHoje;

  const limite = new Date(Date.now() - ESTOQUE_SC_HIST_RETENCAO_DIAS * 86400000);
  for (const dia of Object.keys(estoqueScHistorico)) {
    if (new Date(dia + "T00:00:00") < limite) {
      delete estoqueScHistorico[dia];
    }
  }

  fs.writeFileSync(ESTOQUE_SC_HIST_PATH, JSON.stringify(estoqueScHistorico), "utf-8");
}

// "Novidades": produtos com estoque SC > 0 hoje que nao tinham estoque SC
// (zero ou ausentes) na base de comparacao - o snapshot mais antigo dentro
// da janela dos ultimos NOVIDADES_JANELA_DIAS dias. Se ainda nao tivermos
// historico suficiente (menos de NOVIDADES_JANELA_DIAS dias acumulados),
// usa o snapshot mais antigo que tivermos, e avisa isso no retorno
// (base_incompleta) pra a tela poder deixar claro que a comparacao ainda
// nao cobre os 10 dias inteiros.
function getNovidadesEstoqueSC(listaEstoqueAtual) {
  if (!Array.isArray(listaEstoqueAtual)) {
    return { itens: [], base_data: null, base_incompleta: true };
  }

  const dias = Object.keys(estoqueScHistorico).sort();
  if (dias.length === 0) {
    return { itens: [], base_data: null, base_incompleta: true };
  }

  const hoje = hojeISO();
  const alvo = new Date(Date.now() - NOVIDADES_JANELA_DIAS * 86400000);

  // dia mais recente que seja <= alvo (ou seja, com pelo menos ~10 dias);
  // se nenhum for velho o suficiente, usa o mais antigo que existir.
  let baseDia = dias.find((d) => new Date(d + "T00:00:00") <= alvo);
  let baseIncompleta = false;
  if (!baseDia) {
    baseDia = dias[0];
    baseIncompleta = baseDia !== hoje ? true : true;
  }

  const mapaBase = estoqueScHistorico[baseDia] || {};
  const itens = [];
  for (const p of listaEstoqueAtual) {
    if (p == null || p.cod_prod == null) continue;
    const scAtual = p.estoque_sc || 0;
    if (scAtual <= 0) continue;
    const scBase = mapaBase[p.cod_prod] || 0;
    if (scBase <= 0) {
      itens.push({ cod_prod: p.cod_prod, descricao: p.descricao, estoque_sc: scAtual });
    }
  }
  itens.sort((a, b) => (a.descricao || "").localeCompare(b.descricao || ""));

  return { itens, base_data: baseDia, base_incompleta: baseIncompleta };
}

// Mescla os pedidos de uma nova sincronizacao no historico acumulado.
// Pedido novo -> entra com "primeira_vez_visto" agora. Pedido ja conhecido
// -> atualiza os campos (posicao, valor etc.) mas preserva a data em que foi
// visto pela primeira vez. Pedidos que ja sairam da janela do MEX3000 e nao
// vieram nesta sincronizacao continuam intactos no historico (nunca sao
// apagados por aqui).
function mergeHistorico(pedidosNovos) {
  if (!Array.isArray(pedidosNovos)) return;
  const agora = new Date().toISOString();
  let novos = 0;
  let atualizados = 0;
  for (const p of pedidosNovos) {
    if (p == null || p.cod_ped == null) continue;
    const chave = String(p.cod_ped);
    if (!historico[chave]) {
      historico[chave] = { ...p, primeira_vez_visto: agora, ultima_atualizacao: agora };
      novos++;
    } else {
      historico[chave] = {
        ...historico[chave],
        ...p,
        primeira_vez_visto: historico[chave].primeira_vez_visto,
        ultima_atualizacao: agora,
      };
      atualizados++;
    }
  }
  fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico), "utf-8");
  console.log(
    `[data] historico atualizado: ${novos} pedidos novos, ${atualizados} ja conhecidos. ` +
      `Total acumulado: ${Object.keys(historico).length}.`
  );
}

function getPedidosHistorico() {
  return Object.values(historico);
}

function saveSnapshot(pacote) {
  ensureDataDir();
  snapshot = pacote;
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(pacote), "utf-8");
  console.log(
    `[data] novo snapshot salvo: ${pacote.clientes?.length || 0} clientes, ` +
      `gerado em ${pacote.gerado_em_hora || pacote.gerado_em}.`
  );
  mergeHistorico(pacote.pedidos);
  registrarEstoqueScDoDia(pacote.estoque);
}

function getSnapshot() {
  return snapshot;
}

function temDados() {
  return !!snapshot;
}

function normaliza(txt) {
  return (txt || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function resumo() {
  if (!snapshot) return null;
  const clientes = snapshot.clientes || [];
  const porStatus = { ok: 0, atencao: 0, critico: 0, sem_registro: 0 };
  let valorTotal = 0;
  for (const c of clientes) {
    porStatus[c.status] = (porStatus[c.status] || 0) + 1;
    valorTotal += c.valor_total_historico || 0;
  }
  return {
    gerado_em: snapshot.gerado_em,
    total_clientes: clientes.length,
    ...porStatus,
    valor_total_historico: Math.round(valorTotal * 100) / 100,
  };
}

function buscarClientesPorTexto(termo, limite = 10) {
  if (!snapshot) return [];
  const t = normaliza(termo);
  if (!t) return [];
  return (snapshot.clientes || [])
    .filter((c) => normaliza(c.nome).includes(t) || normaliza(c.nome_abrev).includes(t) || normaliza(c.cidade).includes(t))
    .slice(0, limite);
}

function clientesCriticos(limite = 20) {
  if (!snapshot) return [];
  return (snapshot.clientes || [])
    .filter((c) => c.status === "critico")
    .sort((a, b) => (b.dias_sem_visita || b.dias_sem_pedido || 0) - (a.dias_sem_visita || a.dias_sem_pedido || 0))
    .slice(0, limite);
}

function clientesPorCidade(cidade, limite = 30) {
  if (!snapshot) return [];
  const c = normaliza(cidade);
  return (snapshot.clientes || []).filter((cli) => normaliza(cli.cidade).includes(c)).slice(0, limite);
}

function buscarProdutosPorTexto(termo, limite = 10) {
  if (!snapshot) return [];
  const t = normaliza(termo);
  if (!t) return [];
  return (snapshot.lista_precos || []).filter((p) => normaliza(p.descricao).includes(t)).slice(0, limite);
}

function topProdutos(limite = 15) {
  if (!snapshot) return [];
  return (snapshot.top_produtos || []).slice(0, limite);
}

// Pedidos que baterem com o nome do cliente, razao social, codigo de cliente
// ou numero do pedido. Ordenado do mais recente para o mais antigo. Usa o
// historico acumulado (mais completo que o snapshot mais recente, que so'
// traz os ultimos pedidos de cada cliente segundo o MEX3000).
function buscarPedidosPorTexto(termo, limite = 10) {
  const t = normaliza(termo);
  if (!t) return [];
  return getPedidosHistorico()
    .filter(
      (p) =>
        normaliza(p.nome_cliente).includes(t) ||
        String(p.cod_cli).includes(t) ||
        String(p.cod_ped).includes(t)
    )
    .sort((a, b) => (b.data_emissao || "").localeCompare(a.data_emissao || ""))
    .slice(0, limite);
}

// Todos os pedidos em aberto (nao expedidos, nao cancelados) de um cliente
// especifico (por codigo de cliente). Usa o historico acumulado.
function pedidosAbertosDoCliente(codCli, limite = 10) {
  return getPedidosHistorico()
    .filter((p) => p.cod_cli === codCli && p.posicao !== "EXPEDIDO" && p.posicao !== "PEDIDO CANCELADO")
    .slice(0, limite);
}

// Estoque por codigo ou nome de produto, nas 3 filiais usadas para clientes
// de Santa Catarina (SC = filial 06, SP = filial 02, ES = filial 03).
function getPrecoPorCodigo(codProd) {
  if (!snapshot) return null;
  const item = (snapshot.lista_precos || []).find((p) => p.cod_prod === codProd);
  return item ? item.preco : null;
}

function getEstoquePorCodigo(codProd) {
  if (!snapshot) return null;
  return (snapshot.estoque || []).find((e) => e.cod_prod === codProd) || null;
}

function buscarEstoquePorTexto(termo, limite = 10) {
  if (!snapshot) return [];
  const t = normaliza(termo);
  if (!t) return [];
  return (snapshot.estoque || [])
    .filter((e) => String(e.cod_prod) === termo.trim() || normaliza(e.descricao).includes(t))
    .slice(0, limite);
}

function pedidosEmAberto(limite = 30) {
  return getPedidosHistorico()
    .filter((p) => p.posicao !== "EXPEDIDO" && p.posicao !== "PEDIDO CANCELADO")
    .slice(0, limite);
}

// Monta o objeto de dados que o painel HTML (crm_isapa_bike) espera, com um
// campo "stats" calculado em cima do snapshot atual (o script de sync nao
// manda esse campo pronto). Usado pela rota /painel pra sempre mostrar os
// dados mais recentes que a Claudia recebeu, sem precisar gerar um HTML
// novo toda vez.
function getSnapshotParaPainel() {
  if (!snapshot) return null;
  const clientes = snapshot.clientes || [];
  const porStatus = { ok: 0, atencao: 0, critico: 0, sem_registro: 0 };
  let valorTotal = 0;
  for (const c of clientes) {
    porStatus[c.status] = (porStatus[c.status] || 0) + 1;
    valorTotal += c.valor_total_historico || 0;
  }
  // pedidos: usa o historico acumulado (mais completo que o snapshot mais
  // recente) ordenado do mais novo pro mais antigo.
  const pedidos = getPedidosHistorico().sort((a, b) => (b.data_emissao || "").localeCompare(a.data_emissao || ""));
  const novidadesEstoqueSc = getNovidadesEstoqueSC(snapshot.estoque);
  return {
    ...snapshot,
    pedidos,
    novidades_estoque_sc: novidadesEstoqueSc.itens,
    novidades_estoque_sc_base_data: novidadesEstoqueSc.base_data,
    novidades_estoque_sc_base_incompleta: novidadesEstoqueSc.base_incompleta,
    stats: {
      n_clientes: clientes.length,
      n_ok: porStatus.ok,
      n_atencao: porStatus.atencao,
      n_critico: porStatus.critico,
      n_sem_registro: porStatus.sem_registro,
      valor_total_historico: Math.round(valorTotal * 100) / 100,
      n_pedidos: pedidos.length,
    },
  };
}

module.exports = {
  loadFromDisk,
  saveSnapshot,
  getSnapshot,
  getSnapshotParaPainel,
  getPedidosHistorico,
  getNovidadesEstoqueSC,
  temDados,
  resumo,
  buscarClientesPorTexto,
  clientesCriticos,
  clientesPorCidade,
  buscarProdutosPorTexto,
  topProdutos,
  buscarPedidosPorTexto,
  pedidosAbertosDoCliente,
  pedidosEmAberto,
  buscarEstoquePorTexto,
  getPrecoPorCodigo,
  getEstoquePorCodigo,
  normaliza,
};
