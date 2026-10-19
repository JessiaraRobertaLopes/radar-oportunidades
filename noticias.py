"""
RADAR DE OPORTUNIDADES v2 - Notícias pré-edital
Lê manchetes do Google Notícias (RSS gratuito, sem chave), pede para a IA
(Haiku, barato) separar o que anuncia edital, chamamento ou programa de
financiamento útil para a Santa Casa BH, e grava na tabela "noticias".

Custo: só a IA lendo manchetes (centavos por execução).
"""
import os
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus

from comum import (MODELO_LEITURA, agora_iso, baixar, extrair_json, normalizar_texto,
                   perguntar, resumo_custo, supabase)

DIAS = int(os.environ.get("NOTICIAS_DIAS", "14"))           # janela de notícias
MAX_MANCHETES = int(os.environ.get("NOTICIAS_MAX", "120"))   # limite enviado à IA
NOTA_MINIMA = int(os.environ.get("NOTICIAS_NOTA_MINIMA", "55"))

TERMOS = [
    '"chamamento público" saúde',
    'edital hospital filantrópico',
    '"Ministério da Saúde" edital OR chamamento OR portaria recursos',
    'emenda parlamentar hospital Minas Gerais',
    'FAPEMIG chamada OR edital',
    'BNDES saúde hospitais programa',
    'edital pesquisa clínica OR inovação em saúde',
    'fundação edital saúde OR "responsabilidade social"',
    '"Santa Casa" recursos OR edital OR programa',
    'PRONON OR PRONAS',
]

PERFIL = ("Santa Casa BH: hospital filantrópico 100% SUS de Belo Horizonte (MG), maior complexo hospitalar "
          "de Minas Gerais, com ensino, residência e pesquisa clínica. Capta recursos por editais, "
          "chamamentos, emendas parlamentares, programas federais e estaduais, fundações e empresas.")

PROMPT = """Você ajuda a equipe de captação de recursos da instituição abaixo.
INSTITUIÇÃO: {perfil}

Abaixo estão manchetes recentes de notícias (n | data | veículo | manchete).
Marque só as que indicam uma oportunidade de recurso que a instituição poderia buscar:
- pre_edital: edital, chamamento ou programa anunciado que ainda vai abrir
- edital_aberto: edital ou chamamento com inscrições abertas agora
- programa: programa, linha de crédito, fundo ou emenda com recursos para hospitais/saúde
Ignore: resultados, listas de aprovados, política sem recurso, notícias de outros estados que não
servem para MG (a menos que o programa seja nacional), concursos de emprego, licitações de compra.

MANCHETES:
{lista}

Responda APENAS com JSON:
{{"noticias": [{{"n": 1, "tipo": "pre_edital|edital_aberto|programa", "relevancia": 0-100,
  "orgao": "quem oferece o recurso ou null", "por_que": "1 frase: o que é e por que interessa"}}]}}
Se nenhuma servir, responda {{"noticias": []}}."""


def ler_rss(termo):
    url = (f"https://news.google.com/rss/search?q={quote_plus(termo + f' when:{DIAS}d')}"
           "&hl=pt-BR&gl=BR&ceid=BR:pt-419")
    resp = baixar(url)
    raiz = ET.fromstring(resp.content)
    itens = []
    for item in raiz.iter("item"):
        titulo = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        fonte_el = item.find("source")
        fonte = (fonte_el.text or "").strip() if fonte_el is not None else ""
        # O Google acrescenta " - Veículo" no fim da manchete
        if fonte and titulo.endswith(" - " + fonte):
            titulo = titulo[: -len(" - " + fonte)].strip()
        try:
            publicado = parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            publicado = None
        if titulo and link:
            itens.append({"titulo": titulo, "url": link, "fonte": fonte, "publicado_em": publicado, "termo": termo})
    return itens


def main():
    sb = supabase()
    limite = datetime.now(timezone.utc) - timedelta(days=DIAS)

    # Manchetes já gravadas (não paga a IA duas vezes pela mesma notícia)
    existentes = sb.table("noticias").select("url, titulo").gte("criado_em", (limite - timedelta(days=30)).isoformat()).execute().data or []
    urls_vistas = {e["url"] for e in existentes}
    titulos_vistos = {normalizar_texto(e["titulo"]) for e in existentes}

    candidatas = []
    for termo in TERMOS:
        try:
            itens = ler_rss(termo)
        except Exception as erro:  # um termo com problema não para os outros
            print(f"  ! RSS falhou para {termo!r}: {erro}")
            continue
        novos = 0
        for it in itens:
            chave = normalizar_texto(it["titulo"])
            if it["url"] in urls_vistas or chave in titulos_vistos:
                continue
            if it["publicado_em"] and it["publicado_em"] < limite:
                continue
            urls_vistas.add(it["url"]); titulos_vistos.add(chave)
            candidatas.append(it); novos += 1
        print(f"  {termo}: {len(itens)} manchetes, {novos} novas")

    candidatas.sort(key=lambda x: x["publicado_em"] or limite, reverse=True)
    candidatas = candidatas[:MAX_MANCHETES]
    print(f"Manchetes novas para a IA avaliar: {len(candidatas)}")
    if not candidatas:
        print("Nada novo. " + resumo_custo())
        return

    gravadas = 0
    for ini in range(0, len(candidatas), 60):  # lotes de 60 manchetes
        lote = candidatas[ini:ini + 60]
        lista = "\n".join(
            f"{i + 1} | {c['publicado_em'].date().isoformat() if c['publicado_em'] else 's/d'} | {c['fonte']} | {c['titulo']}"
            for i, c in enumerate(lote))
        try:
            resposta = extrair_json(perguntar(MODELO_LEITURA, PROMPT.format(perfil=PERFIL, lista=lista), max_tokens=3000))
        except Exception as erro:
            print(f"  ! IA falhou neste lote: {erro}")
            continue
        for r in resposta.get("noticias", []):
            try:
                c = lote[int(r["n"]) - 1]
            except (KeyError, ValueError, IndexError, TypeError):
                continue
            nota = max(0, min(100, int(r.get("relevancia") or 0)))
            tipo = r.get("tipo")
            if nota < NOTA_MINIMA or tipo not in ("pre_edital", "edital_aberto", "programa"):
                continue
            registro = {
                "titulo": c["titulo"][:500], "url": c["url"], "fonte": c["fonte"] or None,
                "publicado_em": c["publicado_em"].isoformat() if c["publicado_em"] else None,
                "tipo": tipo, "relevancia": nota, "orgao": (r.get("orgao") or None),
                "por_que": (r.get("por_que") or "")[:400] or None, "termo": c["termo"],
            }
            try:
                sb.table("noticias").upsert(registro, on_conflict="url").execute()
                gravadas += 1
                print(f"  + [{tipo} {nota}] {c['titulo'][:90]}")
            except Exception as erro:
                print(f"  ! não gravou {c['titulo'][:60]}: {erro}")

    print(f"Notícias relevantes gravadas: {gravadas}")
    print(resumo_custo())


if __name__ == "__main__":
    print(f"Notícias pré-edital | {agora_iso()}")
    main()
