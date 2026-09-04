"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const data = require("./data");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

let anthropic = null;
function client() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY nao configurada.");
    }
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

const SYSTEM_PROMPT = `
Voce e' a Claudia, assistente virtual do time comercial da Isapa Bike. Voce responde
por WhatsApp perguntas sobre clientes, visitas, pedidos, condicoes de pagamento e
precos de produtos, usando SOMENTE os dados fornecidos no contexto de cada mensagem.

Regras importantes:
- Se voce nao tiver a informacao no contexto fornecido, diga claramente que nao
  encontrou esse dado na base sincronizada - nunca invente nomes, numeros, precos
  ou datas.
- Os dados sao sincronizados do sistema da empresa 2x ao dia; se for relevante,
  lembre que a informacao pode ter algumas horas de defasagem.
- Seja direta e objetiva - respostas curtas, adequadas para leitura no celular.
  Evite formatacao excessiva (sem markdown pesado); WhatsApp usa *negrito* e
  _italico_ com um asterisco/underline so.
- Se alguem perguntar se voce e' uma inteligencia artificial ou um robo, responda
  honestamente que sim, voce e' uma assistente de IA.
- Voce nao tem acesso para alterar nada no sistema (nao pode marcar visita,
  fechar pedido, etc.) - so consulta e informa.
- Quando useful, sugira proximas acoes (ex: "vale ligar para esse cliente, esta
  ha 45 dias sem visita").

Sobre estoque: existem 3 filiais relevantes para os clientes de Santa Catarina -
SC (filial 06), SP (filial 02) e ES (filial 03). Ao responder sobre estoque de
um produto, sempre mostre a quantidade nas 3 filiais separadamente (nao some
tudo numa unica quantidade), a menos que perguntem o total.

Sobre posicao de pedidos: cada pedido tem uma posicao no fluxo interno, nesta
ordem tipica: ATENDIMENTO -> COMERCIAL -> COMERCIAL/FINANCEIRO -> FINANCEIRO ->
DEPOSITO -> EM SEPARACAO -> AGUARDANDO CORTE -> LIBERADO PARA FATURAMENTO ->
FATURADO -> EM EXPEDICAO -> EXPEDIDO (ou PEDIDO CANCELADO, fora do fluxo). Ao
responder sobre a posicao de um pedido, diga a posicao atual e, se for claro
pelo contexto, uma frase curta do que ela significa na pratica.
`.trim();

function montarContexto(pergunta) {
  const resumo = data.resumo();
  if (!resumo) {
    return "Ainda nao ha nenhum dado sincronizado da base. Avise que a primeira sincronizacao ainda nao aconteceu.";
  }

  const partes = [];
  partes.push(
    `RESUMO GERAL (gerado em ${resumo.gerado_em}): ${resumo.total_clientes} clientes ativos - ` +
      `${resumo.critico} criticos (>30 dias sem pedido/visita), ${resumo.atencao} em atencao (15-30 dias), ` +
      `${resumo.ok} em dia, ${resumo.sem_registro} sem registro. Valor historico total: R$ ${resumo.valor_total_historico}.`
  );

  const termosGatilhoCriticos = ["critic", "atrasad", "sem visita", "sem pedido", "quem esta", "quem está", "pendente"];
  const pnorm = data.normaliza(pergunta);
  if (termosGatilhoCriticos.some((t) => pnorm.includes(data.normaliza(t)))) {
    const criticos = data.clientesCriticos(20);
    if (criticos.length) {
      partes.push(
        "CLIENTES CRITICOS (ha mais de 30 dias sem pedido ou visita, ordenados do mais urgente):\n" +
          criticos
            .map(
              (c) =>
                `- ${c.nome} (${c.cidade || "cidade nao informada"}) - ${c.dias_sem_visita ?? "?"} dias sem visita, ` +
                `${c.dias_sem_pedido ?? "?"} dias sem pedido. Tel: ${c.telefone || "-"}.`
            )
            .join("\n")
      );
    }
  }

  // busca por palavras da pergunta (nomes de cliente, cidade, produto)
  const palavras = pergunta
    .split(/[^a-zA-Z0-9À-ÿ]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);

  const clientesEncontrados = new Map();
  for (const palavra of palavras) {
    for (const c of data.buscarClientesPorTexto(palavra, 5)) {
      clientesEncontrados.set(c.cod_cli, c);
    }
  }
  if (clientesEncontrados.size) {
    const lista = [...clientesEncontrados.values()].slice(0, 10);
    partes.push(
      "CLIENTES ENCONTRADOS (que podem ser relevantes para a pergunta):\n" +
        lista
          .map(
            (c) =>
              `- ${c.nome} | Cidade: ${c.cidade || "-"} | Tel: ${c.telefone || "-"} | ` +
              `Email: ${c.email || "-"} | Condicao pagto: ${c.condicao_pagamento || "-"} | ` +
              `Ultimo pedido: ${c.ultimo_pedido || "nunca"} (${c.dias_sem_pedido ?? "?"} dias) | ` +
              `Ultima visita: ${c.ultima_visita || "nunca"} (${c.dias_sem_visita ?? "?"} dias) | ` +
              `Situacao: ${c.status} | Valor historico: R$ ${c.valor_total_historico} | ` +
              `Sugestao de oferta: ${(c.sugestao_oferta || []).join("; ") || "-"} | ` +
              `Mais comprados: ${(c.top_comprados || []).map((p) => p.descricao).join("; ") || "-"}`
          )
          .join("\n")
    );
  }

  // pedidos: busca por numero direto (digitos na pergunta) e por cliente
  // encontrado acima, alem de palavras que batam com nome/codigo
  const termosGatilhoPedido = ["pedido", "posicao", "posição", "status do pedido", "onde esta", "onde está"];
  if (termosGatilhoPedido.some((t) => pnorm.includes(data.normaliza(t)))) {
    const pedidosEncontrados = new Map();

    // pedidos dos clientes ja encontrados pela pergunta
    for (const c of clientesEncontrados.values()) {
      for (const p of data.pedidosAbertosDoCliente(c.cod_cli, 10)) {
        pedidosEncontrados.set(p.cod_ped, p);
      }
    }
    // numero de pedido citado direto na pergunta (sequencia de 5+ digitos)
    const numerosPedido = pergunta.match(/\d{5,}/g) || [];
    for (const num of numerosPedido) {
      for (const p of data.buscarPedidosPorTexto(num, 5)) {
        pedidosEncontrados.set(p.cod_ped, p);
      }
    }
    // se nao achou nada especifico ainda, tambem tenta por palavra (nome de cliente)
    if (pedidosEncontrados.size === 0) {
      for (const palavra of palavras) {
        for (const p of data.buscarPedidosPorTexto(palavra, 5)) {
          pedidosEncontrados.set(p.cod_ped, p);
        }
      }
    }

    if (pedidosEncontrados.size) {
      const lista = [...pedidosEncontrados.values()].slice(0, 15);
      partes.push(
        "PEDIDOS ENCONTRADOS (numero / cliente / data / valor / posicao atual):\n" +
          lista
            .map(
              (p) =>
                `- Pedido ${p.cod_ped} | ${p.nome_cliente} | emitido em ${p.data_emissao} | ` +
                `R$ ${p.valor} | posicao atual: ${p.posicao}`
            )
            .join("\n")
      );
    } else {
      partes.push(
        "Nenhum pedido foi encontrado combinando com o que foi perguntado. Avise que nao " +
          "achou esse pedido/cliente na base, em vez de inventar uma posicao."
      );
    }
  }

  // estoque: gatilho por palavra-chave, busca por codigo exato (digitos) ou nome
  const termosGatilhoEstoque = ["estoque", "tem quanto", "quantidade disponivel", "quantidade disponível", "tenho quanto"];
  if (termosGatilhoEstoque.some((t) => pnorm.includes(data.normaliza(t)))) {
    const estoqueEncontrado = new Map();
    const numerosProduto = pergunta.match(/\d{3,}/g) || [];
    for (const num of numerosProduto) {
      for (const e of data.buscarEstoquePorTexto(num, 5)) {
        estoqueEncontrado.set(e.cod_prod, e);
      }
    }
    if (estoqueEncontrado.size === 0) {
      for (const palavra of palavras) {
        for (const e of data.buscarEstoquePorTexto(palavra, 5)) {
          estoqueEncontrado.set(e.cod_prod, e);
        }
      }
    }
    if (estoqueEncontrado.size) {
      const lista = [...estoqueEncontrado.values()].slice(0, 10);
      partes.push(
        "ESTOQUE ENCONTRADO (produto | codigo | SC filial 06 | SP filial 02 | ES filial 03):\n" +
          lista
            .map(
              (e) =>
                `- ${e.descricao} | cod ${e.cod_prod} | SC: ${e.estoque_sc} | SP: ${e.estoque_sp} | ES: ${e.estoque_es}`
            )
            .join("\n")
      );
    } else {
      partes.push(
        "Nenhum produto foi encontrado combinando com o codigo ou nome perguntado sobre estoque. " +
          "Avise que nao achou esse produto na base, em vez de inventar uma quantidade."
      );
    }
  }

  const produtosEncontrados = new Map();
  for (const palavra of palavras) {
    for (const p of data.buscarProdutosPorTexto(palavra, 5)) {
      produtosEncontrados.set(p.cod_prod, p);
    }
  }
  if (produtosEncontrados.size) {
    const lista = [...produtosEncontrados.values()].slice(0, 10);
    partes.push(
      "PRODUTOS ENCONTRADOS (nome / preco atual em R$):\n" +
        lista.map((p) => `- ${p.descricao}: R$ ${p.preco}`).join("\n")
    );
  }

  const termosProdutoMaisVendido = ["mais vendid", "top produto", "ranking", "carro chefe"];
  if (termosProdutoMaisVendido.some((t) => pnorm.includes(data.normaliza(t)))) {
    const top = data.topProdutos(15);
    partes.push(
      "PRODUTOS MAIS VENDIDOS (todo o historico, por valor faturado):\n" +
        top.map((p, i) => `${i + 1}. ${p.descricao} - qtde ${p.qtde}, R$ ${p.valor} faturado`).join("\n")
    );
  }

  if (clientesEncontrados.size === 0 && produtosEncontrados.size === 0) {
    partes.push(
      "Nenhum cliente ou produto especifico foi encontrado combinando com palavras da pergunta. " +
        "Se a pergunta menciona um nome, avise que nao achou esse cliente/produto na base e peca " +
        "para conferir a grafia, em vez de inventar uma resposta."
    );
  }

  return partes.join("\n\n");
}

async function responder(pergunta, telefoneRemetente) {
  const contexto = montarContexto(pergunta);
  const userContent = `Pergunta recebida no WhatsApp (de ${telefoneRemetente}):\n"${pergunta}"\n\nContexto de dados disponivel:\n${contexto}`;

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const texto = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return texto || "Desculpa, nao consegui montar uma resposta agora. Pode tentar de novo?";
}

module.exports = { responder, montarContexto };
