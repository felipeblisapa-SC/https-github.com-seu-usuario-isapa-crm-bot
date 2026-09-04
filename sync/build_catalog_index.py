"""
Constroi o indice do catalogo de produtos (PDF) da Isapa.

O que faz: le o PDF do catalogo (o mesmo que a Isapa manda com fotos e
descricoes dos produtos por marca/categoria) e monta um indice
JSON com, para cada produto: codigo, texto do catalogo (descricao + marca +
origem) e a posicao exata da foto na pagina (para recorte sob demanda depois).

Quando rodar de novo: sempre que a Isapa mandar uma versao nova do catalogo
(o nome do arquivo costuma vir com a data, ex: "Catalogo ISAPA_10 de Agosto
de 2026.pdf"). Rode este script apontando pro PDF novo, e substitua os dois
arquivos gerados (catalogo.pdf e catalog_index.json) na pasta config/catalogo/
do projeto do bot (NAO em data/catalogo/ - ver README, secao "Adicionar um
volume persistente", pra entender por que isso importa).

Uso:
    python build_catalog_index.py "Catalogo ISAPA_XX.pdf" config/catalogo/

Requisitos: poppler-utils instalado (comando `pdftotext` disponivel no PATH).
"""

import sys
import re
import json
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from collections import defaultdict

NS = {"h": "http://www.w3.org/1999/xhtml"}
CODE_RE = re.compile(r"^\d{3,7}$")


def extrair_bbox(pdf_path, out_xml):
    subprocess.run(["pdftotext", "-bbox", str(pdf_path), str(out_xml)], check=True)


def palavras(page):
    out = []
    for w in page.findall(".//h:word", NS):
        out.append(
            {
                "x0": float(w.get("xMin")),
                "y0": float(w.get("yMin")),
                "x1": float(w.get("xMax")),
                "y1": float(w.get("yMax")),
                "text": (w.text or "").strip(),
            }
        )
    return out


def agrupa_linhas(words):
    words = sorted(words, key=lambda w: (round(w["y0"] / 2), w["x0"]))
    lines, cur, cur_y = [], [], None
    for w in words:
        if cur_y is None or abs(w["y0"] - cur_y) <= 2.0:
            cur.append(w)
            cur_y = w["y0"] if cur_y is None else cur_y
        else:
            lines.append(cur)
            cur, cur_y = [w], w["y0"]
    if cur:
        lines.append(cur)
    for l in lines:
        l.sort(key=lambda w: w["x0"])
    lines.sort(key=lambda l: l[0]["y0"])

    # separa linhas que colam 2+ colunas na mesma altura: quebra sempre que
    # aparece um novo codigo no meio da linha.
    split_lines = []
    for l in lines:
        seg = [l[0]]
        for w in l[1:]:
            if CODE_RE.match(w["text"]) and (w["x0"] - seg[-1]["x1"]) > 15:
                split_lines.append(seg)
                seg = [w]
            else:
                seg.append(w)
        split_lines.append(seg)
    split_lines.sort(key=lambda l: (l[0]["y0"], l[0]["x0"]))
    return split_lines


def processa_pagina(page, pnum, catalogo):
    w = palavras(page)
    if not w:
        return
    page_w = float(page.get("width"))
    lines = agrupa_linhas(w)

    code_lines_idx = []
    for i, l in enumerate(lines):
        toks = [t["text"] for t in l if t["text"] and t["text"] != "*"]
        if toks and CODE_RE.match(toks[0]):
            code_lines_idx.append(i)
    if not code_lines_idx:
        return

    starts = sorted(set(round(lines[i][0]["x0"]) for i in code_lines_idx))
    col_starts = []
    for s in starts:
        if not col_starts or s - col_starts[-1] > 40:
            col_starts.append(s)

    def col_of(x0):
        return min(col_starts, key=lambda c: abs(c - x0))

    col_starts_sorted = sorted(col_starts)
    col_bounds = {}
    for idx, cs in enumerate(col_starts_sorted):
        nxt = col_starts_sorted[idx + 1] if idx + 1 < len(col_starts_sorted) else page_w - 10
        col_bounds[cs] = (max(0, cs - 8), nxt - 4)

    content_top = 70.0
    for l in lines:
        txt = "".join(t["text"] for t in l)
        if txt.startswith("Data:"):
            content_top = max(content_top, l[0]["y1"] + 5)

    col_blocks = defaultdict(list)
    cur_block, cur_col = None, None
    for l in lines:
        toks_clean = [t["text"] for t in l if t["text"] and t["text"] != "*"]
        is_code_line = bool(toks_clean) and CODE_RE.match(toks_clean[0])
        if is_code_line:
            if cur_block is not None:
                col_blocks[cur_col].append(cur_block)
            cur_col = col_of(l[0]["x0"])
            cur_block = {
                "code": toks_clean[0],
                "words": list(l),
                "y0": min(t["y0"] for t in l),
                "y1": max(t["y1"] for t in l),
            }
        elif cur_block is not None:
            lx = l[0]["x0"]
            if abs(col_of(lx) - cur_col) < 1:
                cur_block["words"].extend(l)
                cur_block["y1"] = max(cur_block["y1"], max(t["y1"] for t in l))
    if cur_block is not None:
        col_blocks[cur_col].append(cur_block)

    for col, blocks in col_blocks.items():
        blocks.sort(key=lambda b: b["y0"])
        prev_bottom = content_top
        xb0, xb1 = col_bounds.get(col, (col - 8, col + 140))
        for b in blocks:
            desc = " ".join(x["text"] for x in b["words"] if x["text"] != "*")
            desc = re.sub(r"^\d{3,7}\s*-\s*", "", desc).strip()
            catalogo.append(
                {
                    "cod_prod": b["code"],
                    "texto_catalogo": desc,
                    "pagina": pnum,
                    "photo_bbox": [round(xb0, 1), round(prev_bottom, 1), round(xb1, 1), round(b["y0"] - 2, 1)],
                    "page_width": page_w,
                    "page_height": float(page.get("height")),
                }
            )
            prev_bottom = b["y1"] + 4


def main():
    if len(sys.argv) < 3:
        print("Uso: python build_catalog_index.py <catalogo.pdf> <pasta_saida>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        xml_path = Path(tmp) / "bbox.xml"
        print("Extraindo texto com posicoes (pdftotext -bbox)...")
        extrair_bbox(pdf_path, xml_path)

        tree = ET.parse(xml_path)
        pages = tree.getroot().findall(".//h:page", NS)
        print(f"{len(pages)} paginas encontradas.")

        catalogo = []
        for pnum, page in enumerate(pages, start=1):
            processa_pagina(page, pnum, catalogo)

    print(f"{len(catalogo)} produtos indexados.")

    index_path = out_dir / "catalog_index.json"
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(catalogo, f, ensure_ascii=False)
    print(f"Indice salvo em {index_path}")

    pdf_dest = out_dir / "catalogo.pdf"
    shutil.copy(pdf_path, pdf_dest)
    print(f"PDF copiado para {pdf_dest}")


if __name__ == "__main__":
    main()
