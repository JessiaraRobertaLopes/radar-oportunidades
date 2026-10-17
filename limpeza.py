"""
RADAR DE OPORTUNIDADES v2 - LIMPEZA ÚNICA DOS EDITAIS ANTIGOS (sem IA, custo zero)
- Calcula link canônico, número e chave de cada edital
- Marca como "encerrado" quem tem prazo vencido
- Agrupa repetidos (mesmo link canônico ou mesma chave) e marca os extras com duplicado_de
Nada é apagado. Por padrão só mostra o relatório; para gravar, rode com APLICAR=sim.
"""
import os
from collections import defaultdict
from datetime import date
from difflib import SequenceMatcher

import comum as c

APLICAR = os.environ.get("APLICAR", "nao").lower() == "sim"


def agrupar(opps):
    """Retorna dict id_mantido -> [ids repetidos]. Mantém o registro mais completo (com prazo) e mais antigo."""
    pai = {o["id"]: o["id"] for o in opps}

    def raiz(x):
        while pai[x] != x:
            pai[x] = pai[pai[x]]
            x = pai[x]
        return x

    def unir(a, b):
        ra, rb = raiz(a), raiz(b)
        if ra != rb:
            pai[rb] = ra

    # 1) mesma chave (órgão + número) = mesmo edital
    por_chave = defaultdict(list)
    for o in opps:
        if o["_chave"]:
            por_chave[o["_chave"]].append(o["id"])
    for grupo in por_chave.values():
        for outro in grupo[1:]:
            unir(grupo[0], outro)

    # 2) mesmo link: junta, exceto quando os registros têm números de edital diferentes
    #    (a busca antiga às vezes gravou editais distintos com o mesmo link)
    por_url = defaultdict(list)
    for o in opps:
        if o["_url"]:
            por_url[o["_url"]].append(o)
    for grupo in por_url.values():
        chaves = {o["_chave"] for o in grupo if o["_chave"]}
        if len(chaves) <= 1:
            for o in grupo[1:]:
                unir(grupo[0]["id"], o["id"])

    # 3) sem número de edital: títulos quase idênticos no mesmo site
    sem_chave = [o for o in opps if not o["_chave"]]
    for i, a in enumerate(sem_chave):
        for b in sem_chave[i + 1:]:
            if c.dominio(a.get("url")) == c.dominio(b.get("url")) and \
               SequenceMatcher(None, c.normalizar_texto(a["title"]), c.normalizar_texto(b["title"])).ratio() >= 0.9:
                unir(a["id"], b["id"])

    grupos = defaultdict(list)
    for o in opps:
        grupos[raiz(o["id"])].append(o)
    resultado = {}
    for membros in grupos.values():
        if len(membros) < 2:
            continue
        membros.sort(key=lambda o: (o.get("deadline") is None, o.get("created_at") or ""))
        resultado[membros[0]["id"]] = [m["id"] for m in membros[1:]]
    return resultado


def preparar(opps):
    hoje = date.today().isoformat()
    for o in opps:
        o["_url"] = c.url_canonica(o.get("url"))
        o["_numero"] = c.numero_edital(o.get("title") or "") or c.numero_edital(o.get("url") or "")
        o["_chave"] = c.chave_edital(o.get("title"), url=o.get("url"))
        o["_situacao"] = "encerrado" if (o.get("deadline") and o["deadline"][:10] < hoje) else (o.get("situacao") or "indefinido")
    return opps


def main():
    sb = c.supabase()
    opps = preparar(sb.table("opportunities").select("id, title, url, deadline, created_at, situacao").execute().data)
    grupos = agrupar(opps)
    repetidos = sum(len(v) for v in grupos.values())
    encerrados = sum(1 for o in opps if o["_situacao"] == "encerrado")
    titulo = {o["id"]: o["title"] for o in opps}

    print(f"Editais no banco: {len(opps)}")
    print(f"Repetidos a marcar: {repetidos} (em {len(grupos)} grupos)")
    print(f"Editais distintos após a limpeza: {len(opps) - repetidos}")
    print(f"Marcados como encerrados (prazo vencido): {encerrados}\n")
    for manter, extras in sorted(grupos.items(), key=lambda x: -len(x[1]))[:15]:
        print(f"[{len(extras) + 1}x] mantém: {titulo[manter][:90]}")
        for e in extras[:3]:
            print(f"        repetido: {titulo[e][:85]}")

    if not APLICAR:
        print("\nMODO RELATÓRIO: nada foi gravado. Para aplicar, rode de novo com APLICAR=sim.")
        return

    duplicado_de = {e: manter for manter, extras in grupos.items() for e in extras}
    for o in opps:
        sb.table("opportunities").update({
            "url_canonica": o["_url"],
            "numero_edital": o["_numero"],
            "chave_edital": o["_chave"],
            "situacao": o["_situacao"],
            "duplicado_de": duplicado_de.get(o["id"]),
        }).eq("id", o["id"]).execute()
    print(f"\nLIMPEZA APLICADA em {len(opps)} registros.")


if __name__ == "__main__":
    main()
