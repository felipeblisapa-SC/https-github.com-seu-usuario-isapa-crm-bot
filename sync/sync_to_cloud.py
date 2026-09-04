"""
Script de sincronizacao do CRM Isapa Bike.

O que faz:
  1. Abre o banco local do MEX3000 (SFA.DB) em modo somente leitura.
  2. Monta o mesmo pacote de dados usado no painel CRM (clientes com status de
     visita/pedido, condicao de pagamento, produtos mais vendidos, tabela de precos).
  3. Envia esse pacote por HTTPS para o servidor na nuvem (Railway), autenticado
     por um token secreto.
  4. Registra o resultado (sucesso ou erro) num arquivo de log local.

Como usar:
  - Ajuste as variaveis SFA_DB_PATH, SERVER_URL e SYNC_TOKEN abaixo (ou defina
    como variaveis de ambiente com o mesmo nome).
  - Agende esse script para rodar 2x ao dia no Agendador de Tarefas do Windows
    (ver README.md para o passo a passo).

Este script SO LE o banco local (nunca escreve nele) e so envia dados para o
endereco configurado em SERVER_URL.
"""

import os
import sys
import json
import sqlite3
import logging
import urllib.request
import urllib.error
from datetime import datetime, date
from collections import defaultdict

# ---------------------------------------------------------------------------
# Configuracao (pode ser sobrescrita por variavel de ambiente)
# ---------------------------------------------------------------------------
SFA_DB_PATH = os.environ.get("SFA_DB_PATH", r"C:\MEX3000 -Isapa - Bike\SFA.DB")
SERVER_URL = os.environ.get("SERVER_URL", "https://isapa-oggi-sc-production.up.railway.app/sync")
SYNC_TOKEN = os.environ.get("SYNC_TOKEN", "2uWI_OFSUok0y0SfECt1ouFy884fG8lZyNUpV7fnWn8")
LOG_PATH = os.environ.get(
    "SYNC_LOG_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync_log.txt"),
)
LIMIAR_OK_DIAS = 15
LIMIAR_ATENCAO_DIAS = 30

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
console = logging.StreamHandler(sys.stdout)
console.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logging.getLogger().addHandler(console)


def pdate(v):
    if not v:
        return None
    try:
        return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()
    except Exception:
        return None


# Codigos de produto que realmente existem no catalogo em PDF da Isapa.
# So mostramos/enviamos produtos que estao no catalogo - codigos da base de
# dados que nao aparecem la (lixo de cadastro, frete, servico, etc.) ficam
# de fora do painel e do WhatsApp.
CATALOGO_INDEX_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "config", "catalogo", "catalog_index.json"
)


def carregar_codigos_catalogo():
    try:
        with open(CATALOGO_INDEX_PATH, encoding="utf-8") as f:
            idx = json.load(f)
        codigos = set(e["cod_prod"] for e in idx)
        logging.info(f"Catalogo carregado: {len(codigos)} codigos validos.")
        return codigos
    except Exception:
        logging.warning(
            f"Nao consegui carregar o indice do catalogo em {CATALOGO_INDEX_PATH} - "
            "seguindo SEM filtrar por catalogo (todos os codigos da base vao aparecer)."
        )
        return None


def montar_pacote(con, hoje):
    cur = con.cursor()
    cur.row_factory = sqlite3.Row

    codigos_catalogo = carregar_codigos_catalogo()

    # condicoes de pagamento (descricao)
    cur.execute("SELECT COD_CONDPGTO, DESCRICAO FROM CADCONDPGTO")
    cond_map = {r["COD_CONDPGTO"]: (r["DESCRICAO"] or "").strip() for r in cur.fetchall()}

    # posicao do pedido (deposito, separacao, atendimento, comercial/financeiro,
    # financeiro, em expedicao, expedido, etc.)
    cur.execute("SELECT COD_POSPED, DESCRICAO FROM CADPOSICAOPED")
    pos_map = {r["COD_POSPED"]: r["DESCRICAO"] for r in cur.fetchall()}

    # pedidos por cliente + lista completa de pedidos com posicao atual.
    # DATAINCLUSAO tem hora/minuto/segundo reais (DATAEMISSAO so' tem a
    # data, sempre 00:00:00) - e' o campo certo pra saber a ordem real em
    # que os pedidos foram lancados/enviados, usado pra ordenar a lista no
    # painel (mais recente primeiro).
    cur.execute(
        "SELECT COD_PED, COD_CLI, DATAEMISSAO, DATAINCLUSAO, COD_CONDPGTO, VLPEDIDO, COD_POSPED, PEDCLIENTE "
        "FROM PEDIDOS WHERE INATIVO IS NULL OR INATIVO = 0"
    )
    cli_ped = {}
    pedidos_all = []
    for r in cur.fetchall():
        cod = r["COD_CLI"]
        d = pdate(r["DATAEMISSAO"])
        v = r["VLPEDIDO"] or 0
        info = cli_ped.setdefault(
            cod, {"n_pedidos": 0, "valor_total": 0.0, "ultima_data": None, "cond_pgto": None}
        )
        info["n_pedidos"] += 1
        info["valor_total"] += v
        if d and (info["ultima_data"] is None or d > info["ultima_data"]):
            info["ultima_data"] = d
            info["cond_pgto"] = r["COD_CONDPGTO"]
        pedidos_all.append(
            {
                "cod_ped": r["COD_PED"],
                "cod_cli": cod,
                "data_emissao": r["DATAEMISSAO"],
                "data_inclusao": r["DATAINCLUSAO"],
                "valor": round(v, 2),
                "posicao": pos_map.get(r["COD_POSPED"], f"(cod {r['COD_POSPED']})"),
                "pedido_cliente_ref": r["PEDCLIENTE"],
            }
        )

    # visitas por cliente
    #
    # Isso NAO pode ser so a tabela VISITAS (check-in explicito) - o proprio
    # MEX3000 considera "visitou" tambem quando o pedido foi lancado em campo
    # (ex: PEDIDO DESKTOP, COD_TIPOORIGEM=13) mesmo sem um check-in formal
    # vinculado (PEDIDOS.COD_VISITA fica nulo nesses casos, mas o relatorio
    # nativo do MEX3000 ainda mostra "Resultado: VISITOU E COMPROU"). Sem
    # isso, cliente comprado ha poucos dias aparecia como "60 dias sem
    # visita" no painel, o que nao bate com o sistema (caso real: AFJ BIKES,
    # pedido de 20/07/2026 sem COD_VISITA, mas o MEX3000 conta como visita).
    #
    # Exclui so COD_TIPOORIGEM=11 (HISTORICO, pedido antigo importado) e
    # =12 (PEDIDO WEB, cliente comprando sozinho online - nao e' visita).
    cur.execute("SELECT COD_CLI, DATAVISITA FROM VISITAS")
    cli_vis = {}
    for r in cur.fetchall():
        cod = r["COD_CLI"]
        d = pdate(r["DATAVISITA"])
        if d and (cod not in cli_vis or d > cli_vis[cod]):
            cli_vis[cod] = d
    cur.execute(
        "SELECT COD_CLI, DATAEMISSAO FROM PEDIDOS WHERE COD_TIPOORIGEM NOT IN (11, 12)"
    )
    for r in cur.fetchall():
        cod = r["COD_CLI"]
        d = pdate(r["DATAEMISSAO"])
        if d and (cod not in cli_vis or d > cli_vis[cod]):
            cli_vis[cod] = d

    # posicao financeira (titulos VENCIDOS - contas a receber que o cliente
    # ja deveria ter pago e nao pagou). A tabela TITULOS local so guarda
    # titulos ainda em aberto (assim que um titulo e' pago ele desaparece
    # dela), mas "em aberto" inclui titulo dentro do prazo tambem - por
    # isso filtramos so' VENCTO < hoje aqui, igual o filtro "Titulos
    # Vencidos" do proprio MEX3000 (ver tela de Titulos). VLSALDO e' o
    # saldo em aberto do titulo (menor que VLTITULO se houve pagamento
    # parcial); usamos VLTITULO como reserva se VLSALDO vier nulo.
    # "dias_atraso" e' calculado a partir do titulo mais atrasado do
    # cliente (pior caso), nao soma de todos - assim reflete ha quanto
    # tempo o cliente esta inadimplente, nao quantos titulos tem.
    cur.execute(
        "SELECT COD_CLI, VENCTO, VLSALDO, VLTITULO FROM TITULOS "
        "WHERE (INATIVO IS NULL OR INATIVO = 0) AND DTCANCEL IS NULL"
    )
    cli_fin = {}
    for r in cur.fetchall():
        cod = r["COD_CLI"]
        d = pdate(r["VENCTO"])
        if not d or d >= hoje:
            continue  # so' conta titulo VENCIDO (venceu antes de hoje), igual o
                      # filtro "Titulos Vencidos" do MEX3000 - titulo em aberto
                      # mas ainda dentro do prazo nao entra aqui.
        v = r["VLSALDO"] if r["VLSALDO"] is not None else (r["VLTITULO"] or 0)
        info = cli_fin.setdefault(cod, {"valor_vencido": 0.0, "dias_atraso": 0, "n_titulos": 0})
        info["valor_vencido"] += v or 0
        info["n_titulos"] += 1
        atraso = (hoje - d).days
        if atraso > info["dias_atraso"]:
            info["dias_atraso"] = atraso

    # produtos e precos
    cur.execute("SELECT COD_PROD, DESCRICAO FROM PRODUTOS")
    prod_map = {r["COD_PROD"]: r["DESCRICAO"] for r in cur.fetchall()}

    # Preco por produto, especifico do estado de Santa Catarina (COD_ESTADO
    # = 'SC'). O banco tem listas de preco separadas por estado (SC, SP, e
    # uma tabela "em branco"/generica) - sem esse filtro o preco de SP as
    # vezes ganhava por acaso (empate de data), dando valor errado pro
    # cliente de SC (ex: cod 5933 aparecia R$9,45 em vez de R$10,77 da SC).
    # Quando um produto nao tem preco especifico de SC cadastrado (raro,
    # ~90 produtos), cai para a tabela em branco como reserva.
    cur.execute(
        """
        SELECT COD_PROD, PRECO01, EMB, QT_EMB, QT_EMBMASTER FROM (
            SELECT COD_PROD, PRECO01, EMB, QT_EMB, QT_EMBMASTER,
                   ROW_NUMBER() OVER (
                       PARTITION BY COD_PROD
                       ORDER BY (CASE WHEN TRIM(COD_ESTADO) = 'SC' THEN 0 ELSE 1 END), DT_INIVAL DESC
                   ) rn
            FROM C_ITEMLISTAPRECOS
            WHERE COD_LISTA = '1' AND TRIM(COD_ESTADO) IN ('SC', '')
        ) WHERE rn = 1
        """
    )
    preco_map = {}
    embalagem_map = {}
    for r in cur.fetchall():
        preco_map[r["COD_PROD"]] = r["PRECO01"]
        embalagem_map[r["COD_PROD"]] = {
            "unidade": r["EMB"],
            "qtd_unidade": r["QT_EMB"],
            "qtd_caixa": r["QT_EMBMASTER"],
        }

    # clientes (inclui endereco completo, CNPJ e telefone celular pra
    # alimentar a ficha detalhada do cliente no painel)
    cur.execute(
        "SELECT COD_CLI, NOME, NOMEABREV, CNPJCPF, ENDERECO, NUMERO_END, COMPLEMENTO_END, "
        "CIDADE, BAIRRO, ESTADO, CEP, TELEFONE, TEL_CELULAR, EMAIL, INATIVO "
        "FROM CLIENTES"
    )
    clientes = []
    for r in cur.fetchall():
        cod = r["COD_CLI"]
        if r["INATIVO"]:
            continue
        ped = cli_ped.get(cod)
        ult_ped = ped["ultima_data"] if ped else None
        ult_vis = cli_vis.get(cod)
        dias_ped = (hoje - ult_ped).days if ult_ped else None
        dias_vis = (hoje - ult_vis).days if ult_vis else None
        dias_ref = min([d for d in [dias_ped, dias_vis] if d is not None], default=None)
        status = "sem_registro"
        if dias_ref is not None:
            status = (
                "ok"
                if dias_ref <= LIMIAR_OK_DIAS
                else ("atencao" if dias_ref <= LIMIAR_ATENCAO_DIAS else "critico")
            )
        cond_desc = cond_map.get(ped["cond_pgto"]) if ped and ped["cond_pgto"] else None
        fin = cli_fin.get(cod)
        clientes.append(
            {
                "cod_cli": cod,
                "nome": r["NOME"],
                "nome_abrev": r["NOMEABREV"],
                "cnpj": r["CNPJCPF"],
                "endereco": r["ENDERECO"],
                "numero_end": r["NUMERO_END"],
                "complemento_end": r["COMPLEMENTO_END"],
                "cidade": r["CIDADE"],
                "bairro": r["BAIRRO"],
                "estado": r["ESTADO"],
                "cep": r["CEP"],
                "telefone": r["TELEFONE"],
                "tel_celular": r["TEL_CELULAR"],
                "email": r["EMAIL"],
                "ultimo_pedido": ult_ped.isoformat() if ult_ped else None,
                "dias_sem_pedido": dias_ped,
                "ultima_visita": ult_vis.isoformat() if ult_vis else None,
                "dias_sem_visita": dias_vis,
                "n_pedidos_historico": ped["n_pedidos"] if ped else 0,
                "valor_total_historico": round(ped["valor_total"], 2) if ped else 0,
                "condicao_pagamento": cond_desc,
                "status": status,
                "valor_titulos_vencidos": round(fin["valor_vencido"], 2) if fin else 0,
                "dias_atraso_titulos": fin["dias_atraso"] if fin else 0,
                "n_titulos_vencidos": fin["n_titulos"] if fin else 0,
            }
        )

    # produtos mais vendidos (geral). Busca bem mais que 50 candidatos porque
    # depois filtramos pelos codigos que existem de verdade no catalogo -
    # sem essa folga, a lista final ficaria menor que 50.
    #
    # IMPORTANTE: excluimos COD_TIPOORIGEM=11 (HISTORICO, ver CADTIPOORIGEM).
    # Esses pedidos sao lixo de migracao/integracao - o cabecalho do pedido
    # (VLPEDIDO) fica com um valor pequeno e normal, mas os itens anexados a
    # ele nao tem nada a ver: um unico pedido "HISTORICO" pode ter 500-1500+
    # itens somando milhoes de reais (ex: pedido 4817168 tem VLPEDIDO=R$3.727
    # mas os itens somam R$2,26 milhoes - 608x o valor real do pedido).
    # Isso inflava artificialmente a "Qtde vendida" de varios produtos (ex:
    # cod. 54000 aparecia com 24.289 un. vendidas quando o real, somando so'
    # pedidos de verdade - tipos 12 Web, 13 Desktop, 14 Pocket, 19 Android -
    # e' 234 un). Felipe identificou o problema comparando com o que sabia
    # ser a venda real do produto 54000.
    cur.execute(
        """
        SELECT ip.COD_PROD, SUM(ip.QTDE) qtde, SUM(ip.VLTOTAL) valor
        FROM ITEMPEDIDO ip
        WHERE ip.COD_TIPOORIGEM != 11
        GROUP BY ip.COD_PROD
        ORDER BY valor DESC
        LIMIT 400
        """
    )
    top_produtos = []
    for r in cur.fetchall():
        cod = r["COD_PROD"]
        if codigos_catalogo is not None and cod not in codigos_catalogo:
            continue
        top_produtos.append(
            {
                "cod_prod": cod,
                "descricao": prod_map.get(cod, f"(cod. {cod})"),
                "qtde": r["qtde"],
                "valor": round(r["valor"], 2) if r["valor"] else 0,
                "preco_atual": preco_map.get(cod),
            }
        )
        if len(top_produtos) >= 50:
            break

    # produtos comprados por cliente (para sugestao de oferta). Mesmo filtro
    # de COD_TIPOORIGEM != 11 (HISTORICO) explicado acima, pra nao sugerir
    # oferta de produto baseado em quantidade fantasma de pedido lixo.
    cur.execute(
        """
        SELECT p.COD_CLI, ip.COD_PROD, SUM(ip.QTDE) qtde, SUM(ip.VLTOTAL) valor
        FROM ITEMPEDIDO ip
        JOIN PEDIDOS p ON p.COD_PED = ip.COD_PED AND p.COD_TIPOORIGEM = ip.COD_TIPOORIGEM
        WHERE ip.COD_TIPOORIGEM != 11
        GROUP BY p.COD_CLI, ip.COD_PROD
        """
    )
    cli_prod = defaultdict(list)
    for r in cur.fetchall():
        cli_prod[r["COD_CLI"]].append(
            {"cod_prod": r["COD_PROD"], "qtde": r["qtde"], "valor": r["valor"]}
        )

    top_geral_cods = [p["cod_prod"] for p in top_produtos]
    cliente_por_cod = {c["cod_cli"]: c for c in clientes}
    for cod_cli, items in cli_prod.items():
        if cod_cli not in cliente_por_cod:
            continue
        items_sorted = sorted(items, key=lambda x: -(x["valor"] or 0))
        comprados = set(i["cod_prod"] for i in items)
        cliente_por_cod[cod_cli]["top_comprados"] = [
            {"descricao": prod_map.get(i["cod_prod"], f"(cod. {i['cod_prod']})"), "qtde": i["qtde"]}
            for i in items_sorted[:5]
        ]
        cliente_por_cod[cod_cli]["sugestao_oferta"] = [
            prod_map.get(c, f"(cod. {c})") for c in top_geral_cods if c not in comprados
        ][:5]

    for c in clientes:
        c.setdefault("top_comprados", [])
        c.setdefault("sugestao_oferta", [])

    # nome do cliente em cada pedido (para busca por razao social no WhatsApp)
    nome_map = {c["cod_cli"]: c["nome"] for c in clientes}
    for p in pedidos_all:
        p["nome_cliente"] = nome_map.get(p["cod_cli"], f"(cod {p['cod_cli']})")
    pedidos_all.sort(key=lambda p: p["data_emissao"] or "", reverse=True)

    # tabela de precos completa (so' produtos que existem no catalogo em PDF)
    lista_precos = []
    for cod, desc in prod_map.items():
        if codigos_catalogo is not None and cod not in codigos_catalogo:
            continue
        preco = preco_map.get(cod)
        if preco is not None:
            emb = embalagem_map.get(cod, {})
            lista_precos.append(
                {
                    "cod_prod": cod,
                    "descricao": desc,
                    "preco": round(preco, 2),
                    "unidade": emb.get("unidade"),
                    "qtd_unidade": emb.get("qtd_unidade"),
                    "qtd_caixa": emb.get("qtd_caixa"),
                }
            )
    lista_precos.sort(key=lambda x: x["descricao"] or "")

    # estoque nas 3 filiais usadas para clientes de Santa Catarina:
    # filial 06 = SC, filial 02 = SP, filial 03 = ES
    cur.execute(
        "SELECT COD_PROD, COD_ESTAB, QTDEESTOQUE FROM ESTOQUE WHERE COD_ESTAB IN ('2','3','6')"
    )
    estoque_bruto = {}
    filial_key = {"6": "estoque_sc", "2": "estoque_sp", "3": "estoque_es"}
    for r in cur.fetchall():
        d = estoque_bruto.setdefault(r["COD_PROD"], {"estoque_sc": 0, "estoque_sp": 0, "estoque_es": 0})
        d[filial_key[r["COD_ESTAB"]]] = r["QTDEESTOQUE"] or 0

    lista_estoque = []
    for cod, d in estoque_bruto.items():
        if codigos_catalogo is not None and cod not in codigos_catalogo:
            continue
        tem_nome = cod in prod_map
        if not tem_nome and d["estoque_sc"] == 0 and d["estoque_sp"] == 0 and d["estoque_es"] == 0:
            continue
        lista_estoque.append(
            {
                "cod_prod": cod,
                "descricao": prod_map.get(cod, f"(cod {cod}) - fora do catalogo atual"),
                **d,
            }
        )
    lista_estoque.sort(key=lambda x: x["descricao"] or "")

    # Previsao de comissao: o Felipe recebe em um mes a comissao sobre os
    # titulos (contas a receber, tabela TITULOS) que VENCEM no mes anterior
    # (ex: titulos vencendo em agosto -> comissao recebida em setembro).
    # Formula confirmada com o Felipe, com exemplo real:
    #   titulos de agosto R$1.814.405,22 x 0,023 = R$41.731,32 (recebido em setembro)
    # A tabela TITULOS local so' guarda titulos ainda em aberto (nenhum
    # titulo ja pago aparece nela) - por isso a base de cada caixa e' sempre
    # o mes de VENCIMENTO (ainda nao passou / ainda esta completo na base),
    # nunca o mes de recebimento em si (que já teria titulos antigos
    # baixados/sumidos da tabela).
    PERCENTUAL_COMISSAO = 0.023  # 2,3% do valor do titulo
    MESES_NOME = [
        "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
        "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ]
    cur.execute(
        "SELECT substr(VENCTO,1,7) mes, SUM(VLTITULO) total FROM TITULOS "
        "WHERE INATIVO=0 AND DTCANCEL IS NULL AND VENCTO IS NOT NULL GROUP BY mes"
    )
    titulos_por_mes = {r["mes"]: (r["total"] or 0) for r in cur.fetchall()}
    comissao_prevista = []
    for i in range(6):
        idx0_venc = (hoje.month - 1 + i) % 12
        ano_venc = hoje.year + (hoje.month - 1 + i) // 12
        chave_venc = f"{ano_venc:04d}-{idx0_venc + 1:02d}"
        titulos_mes = round(titulos_por_mes.get(chave_venc, 0), 2)

        idx0_receb = (idx0_venc + 1) % 12
        ano_receb = ano_venc + (1 if idx0_venc == 11 else 0)

        comissao_prevista.append(
            {
                "mes_vencimento": chave_venc,
                "mes_vencimento_label": f"{MESES_NOME[idx0_venc]}/{str(ano_venc)[-2:]}",
                "mes_recebimento_label": f"{MESES_NOME[idx0_receb]}/{str(ano_receb)[-2:]}",
                "titulos_vencimento": titulos_mes,
                "comissao": round(titulos_mes * PERCENTUAL_COMISSAO, 2),
            }
        )

    # Cota mensal de faturamento (so' pedidos EXPEDIDO) - meta combinada com o
    # Felipe, nao vem de nenhuma tabela do SFA.DB (e' um numero de negocio,
    # nao um dado do banco). Mesmo padrao do PERCENTUAL_COMISSAO acima:
    # constante aqui no script, exposta no pacote pro painel desenhar a
    # linha de cota em paralelo com o faturamento realizado. Se a cota mudar
    # (revisao trimestral, etc.), atualizar so' esse numero.
    COTA_MENSAL_FATURAMENTO = 4_500_000.00  # setembro/2026 (atualizado 01/09/2026)

    return {
        "gerado_em": hoje.isoformat(),
        "gerado_em_hora": datetime.now().isoformat(timespec="seconds"),
        "clientes": clientes,
        "pedidos": pedidos_all,
        "top_produtos": top_produtos,
        "lista_precos": lista_precos,
        "estoque": lista_estoque,
        "comissao_percentual": PERCENTUAL_COMISSAO,
        "comissao_prevista": comissao_prevista,
        "cota_mensal_faturamento": COTA_MENSAL_FATURAMENTO,
    }


def enviar(pacote):
    body = json.dumps(pacote, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        SERVER_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {SYNC_TOKEN}",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")


def main():
    logging.info("Iniciando sincronizacao do CRM Isapa Bike")

    if not os.path.exists(SFA_DB_PATH):
        logging.error(f"Banco nao encontrado em: {SFA_DB_PATH}")
        sys.exit(1)

    if "COLOQUE_AQUI" in SYNC_TOKEN or "SEU-PROJETO" in SERVER_URL:
        logging.error(
            "Configure SERVER_URL e SYNC_TOKEN (no topo do script ou como variavel de "
            "ambiente) antes de rodar de verdade."
        )
        sys.exit(1)

    try:
        con = sqlite3.connect(f"file:{SFA_DB_PATH}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        pacote = montar_pacote(con, date.today())
        con.close()
    except Exception:
        logging.exception("Falha ao ler o banco local (SFA.DB)")
        sys.exit(1)

    n_cli = len(pacote["clientes"])
    n_crit = sum(1 for c in pacote["clientes"] if c["status"] == "critico")
    logging.info(f"Pacote montado: {n_cli} clientes ({n_crit} criticos), "
                 f"{len(pacote['pedidos'])} pedidos, "
                 f"{len(pacote['top_produtos'])} produtos em destaque, "
                 f"{len(pacote['lista_precos'])} precos, "
                 f"{len(pacote['estoque'])} itens de estoque.")

    try:
        status, resp_body = enviar(pacote)
        logging.info(f"Envio concluido. HTTP {status}. Resposta: {resp_body[:300]}")
    except urllib.error.HTTPError as e:
        logging.error(f"Servidor recusou o envio: HTTP {e.code} - {e.read().decode(errors='replace')[:300]}")
        sys.exit(1)
    except Exception:
        logging.exception("Falha ao enviar os dados para o servidor")
        sys.exit(1)

    logging.info("Sincronizacao concluida com sucesso.")


if __name__ == "__main__":
    main()
