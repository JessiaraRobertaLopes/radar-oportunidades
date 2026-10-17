"""
RADAR DE OPORTUNIDADES v2 - ROBÔ DE CAPTAÇÃO
Fluxo:
  1. DESCOBRIR   candidatos nas fontes fixas e na busca web
  2. BARRAR      repetidos pelo link canônico (antes de gastar IA)
  3. LER         a página e o PDF do edital e extrair os dados com evidência
  4. BARRAR      repetidos pela chave órgão + número; descartar encerrados
  5. SALVAR      só editais abertos, de fluxo contínuo ou com situação indefinida
"""
import hashlib
import re
from datetime import date
from difflib import SequenceMatcher

from bs4 import BeautifulSoup

import comum as c

ANO = date.today().year

# ---------------------------------------------------------------------
# Fontes fixas (páginas de listagem de editais)
# ---------------------------------------------------------------------
FONTES_FIXAS = [
    {
        "nome": "Ministério da Saúde | Chamamentos públicos",
        "url": f"https://www.gov.br/saude/pt-br/acesso-a-informacao/participacao-social/chamamentos-publicos/{ANO}",
        "palavras": ["chamamento", "edital", "chamada", "seleção", "convocação"],
    },
    {
        "nome": "FAPEMIG | Chamadas e editais",
        "url": "https://fapemig.br/oportunidades/chamadas-e-editais",
        "palavras": ["chamada", "edital", "seleção", "programa"],
    },
]

# Busca web: poucos termos, sem sobreposição, sempre pedindo inscrições abertas
TERMOS_BUSCA = [
    "edital com inscrições abertas para hospitais filantrópicos SUS",
    "chamamento público inovação e saúde digital inscrições abertas",
    "edital financiamento infraestrutura e equipamentos hospitalares entidades filantrópicas",
    "edital pesquisa clínica e formação de profissionais de saúde inscrições abertas",
    "edital ESG sustentabilidade e inclusão social para organizações de saúde sem fins lucrativos",
    "edital fundações e institutos privados apoio a hospitais filantrópicos Minas Gerais",
]

PROMPT_LEITURA = """Você recebe trechos de uma página e/ou documento de edital. Extraia os dados SOMENTE do texto fornecido.

REGRAS OBRIGATÓRIAS
- Nunca invente. Se o dado não estiver no texto, use null (ou "indefinido" nos campos de situação).
- Para cada data, valor ou elegibilidade informada, copie em "evidencias" o trecho LITERAL do texto de onde tirou o dado (até 200 caracteres).
- Datas no formato AAAA-MM-DD. "prazo_inscricao" é a data final para enviar a proposta/inscrição.
- "situacao": "aberto" (inscrições abertas hoje, {hoje}), "encerrado" (prazo já passou ou o texto diz encerrado/resultado final),
  "fluxo_continuo" (sem prazo final: programa permanente, linha de crédito, credenciamento contínuo) ou "indefinido".
- "aceita_filantropico": "sim" se hospitais filantrópicos/entidades privadas sem fins lucrativos/Santas Casas podem participar,
  "nao" se o público é exclusivamente outro (ex.: só municípios, só pessoas físicas, só empresas com fins lucrativos), senão "indefinido".
- "eh_edital": false se o texto não for de uma oportunidade de financiamento/seleção (ex.: notícia, portaria de reajuste, resultado, página de menu).

Responda APENAS com JSON:
{{
  "eh_edital": true,
  "titulo_oficial": "...",
  "orgao": "órgão ou instituição responsável",
  "numero_edital": "ex.: 01/2026 ou null",
  "situacao": "aberto|encerrado|fluxo_continuo|indefinido",
  "data_abertura": "AAAA-MM-DD ou null",
  "prazo_inscricao": "AAAA-MM-DD ou null",
  "valor": "texto curto com o valor total ou por proposta, ou null",
  "publico_elegivel": "quem pode participar, em 1 frase, ou null",
  "aceita_filantropico": "sim|nao|indefinido",
  "resumo": "2 a 3 frases objetivas sobre o que o edital financia",
  "evidencias": {{"prazo_inscricao": "...", "data_abertura": "...", "valor": "...", "publico_elegivel": "...", "situacao": "..."}}
}}

LINK: {url}
TEXTO:
{texto}"""

PROMPT_BUSCA = """Hoje é {hoje}. Busque na web: "{termo}".

Quero apenas editais, chamamentos ou programas de financiamento com INSCRIÇÕES ABERTAS HOJE ou de FLUXO CONTÍNUO,
aos quais um hospital filantrópico 100% SUS de Belo Horizonte (MG) possa se candidatar.
Ignore notícias, resultados, editais encerrados e editais de anos anteriores.
Para cada um, informe o link da PÁGINA OFICIAL do edital no site do órgão responsável (não links de notícia ou agregadores).

Responda APENAS com JSON (até 5 itens):
{{"editais": [{{"titulo": "...", "orgao": "...", "url": "https://..."}}]}}
Se não houver nada, responda {{"editais": []}}."""


# ---------------------------------------------------------------------
# Memória do que já existe no banco (para barrar repetidos)
# ---------------------------------------------------------------------
class Memoria:
    def __init__(self):
        dados = c.supabase().table("opportunities").select("id, title, url, url_canonica, chave_edital").execute().data
        self.urls = set()
        self.chaves = set()
        self.titulos = []
        for o in dados:
            self.urls.add(o.get("url_canonica") or c.url_canonica(o.get("url")))
            if o.get("chave_edital"):
                self.chaves.add(o["chave_edital"])
            else:
                ch = c.chave_edital(o.get("title"), url=o.get("url"))
                if ch:
                    self.chaves.add(ch)
            self.titulos.append(c.normalizar_texto(o.get("title")))
        self.urls.discard(None)

    def link_conhecido(self, url):
        return c.url_canonica(url) in self.urls

    def edital_conhecido(self, chave, titulo):
        if chave and chave in self.chaves:
            return True
        t = c.normalizar_texto(titulo)
        # sem número de edital: compara o título com os existentes
        return not chave and any(SequenceMatcher(None, t, x).ratio() >= 0.88 for x in self.titulos)

    def registrar(self, url, chave, titulo):
        self.urls.add(c.url_canonica(url))
        if chave:
            self.chaves.add(chave)
        self.titulos.append(c.normalizar_texto(titulo))


# ---------------------------------------------------------------------
# Fontes (tabela sources): uma por fonte fixa e uma por domínio na web
# ---------------------------------------------------------------------
_fontes_cache = {}


def fonte_id(nome, url, tipo):
    if url in _fontes_cache:
        return _fontes_cache[url]
    sb = c.supabase()
    achou = sb.table("sources").select("id").eq("url", url).execute().data
    if achou:
        _fontes_cache[url] = achou[0]["id"]
    else:
        novo = sb.table("sources").insert(
            {"name": nome, "url": url, "scrape_type": tipo, "frequency": "manual", "active": True}
        ).execute().data
        _fontes_cache[url] = novo[0]["id"]
    return _fontes_cache[url]


# ---------------------------------------------------------------------
# 1. DESCOBRIR
# ---------------------------------------------------------------------
def descobrir_fontes_fixas():
    candidatos = []
    for f in FONTES_FIXAS:
        print(f"Fonte fixa: {f['nome']}")
        try:
            r = c.baixar(f["url"])
            soup = BeautifulSoup(r.text, "html.parser")
            for a in soup.find_all("a", href=True):
                titulo = a.get_text(" ", strip=True)
                if len(titulo) < 15 or not any(p in titulo.lower() for p in f["palavras"]):
                    continue
                href = c.urljoin(r.url, a["href"])
                if href.startswith("http"):
                    candidatos.append({"titulo": titulo, "url": href, "fonte_nome": f["nome"], "fonte_url": f["url"], "tipo": "html_static"})
            c.supabase().table("sources").update({"last_scraped_at": c.agora_iso()}).eq("url", f["url"]).execute()
        except Exception as e:
            print(f"  erro: {e}")
    return candidatos


def descobrir_busca_web():
    candidatos = []
    hoje = date.today().strftime("%d/%m/%Y")
    for termo in TERMOS_BUSCA:
        print(f"Busca web: {termo}")
        try:
            resposta = c.perguntar(
                c.MODELO_BUSCA,
                PROMPT_BUSCA.format(hoje=hoje, termo=termo),
                max_tokens=1500,
                ferramentas=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
            )
            for e in c.extrair_json(resposta).get("editais", []):
                url = (e.get("url") or "").strip()
                if url.startswith("http") and e.get("titulo"):
                    dom = c.dominio(url)
                    candidatos.append({
                        "titulo": e["titulo"], "url": url,
                        "fonte_nome": f"Web | {e.get('orgao') or dom}", "fonte_url": f"https://{dom}",
                        "tipo": "web_search",
                    })
        except Exception as ex:
            print(f"  erro: {ex}")
    return candidatos


# ---------------------------------------------------------------------
# 3. LER o edital
# ---------------------------------------------------------------------
def ler_edital(candidato):
    texto, link_pdf = c.ler_documento(candidato["url"])
    trechos = c.recortar_trechos(texto)
    if len(trechos) < 200:
        raise ValueError("página sem conteúdo suficiente")
    hoje = date.today().isoformat()
    dados = c.extrair_json(c.perguntar(
        c.MODELO_LEITURA,
        PROMPT_LEITURA.format(hoje=hoje, url=candidato["url"], texto=trechos),
        max_tokens=1200,
    ))
    ev = dados.get("evidencias") or {}

    # Só aceita o que tem evidência real no documento
    for campo in ("prazo_inscricao", "data_abertura", "valor", "publico_elegivel"):
        if dados.get(campo) and not c.evidencia_confere(ev.get(campo), texto):
            dados[campo] = None
            ev.pop(campo, None)

    prazo = c.data_valida(dados.get("prazo_inscricao"))
    situacao = dados.get("situacao") if dados.get("situacao") in ("aberto", "encerrado", "fluxo_continuo", "indefinido") else "indefinido"
    if prazo and prazo < date.today():
        situacao = "encerrado"
    elif prazo and situacao == "indefinido":
        situacao = "aberto"

    return {
        "eh_edital": dados.get("eh_edital", True) is not False,
        "titulo": (dados.get("titulo_oficial") or candidato["titulo"]).strip()[:400],
        "orgao": dados.get("orgao"),
        "numero": dados.get("numero_edital"),
        "situacao": situacao,
        "prazo": prazo.isoformat() if prazo else None,
        "data_abertura": (c.data_valida(dados.get("data_abertura")) or None),
        "valor": dados.get("valor"),
        "publico_elegivel": dados.get("publico_elegivel"),
        "aceita_filantropico": dados.get("aceita_filantropico") if dados.get("aceita_filantropico") in ("sim", "nao", "indefinido") else "indefinido",
        "resumo": dados.get("resumo"),
        "evidencias": ev or None,
        "link_documento": link_pdf,
        "trechos": trechos,
    }


# ---------------------------------------------------------------------
# 5. SALVAR
# ---------------------------------------------------------------------
def salvar(candidato, lido, chave):
    url = candidato["url"]
    registro = {
        "source_id": fonte_id(candidato["fonte_nome"], candidato["fonte_url"], candidato["tipo"]),
        "title": lido["titulo"],
        "url": url,
        "url_canonica": c.url_canonica(url),
        "description": (lido["resumo"] or lido["trechos"][:500])[:1000],
        "deadline": lido["prazo"],
        "hash": hashlib.sha256((chave or c.url_canonica(url)).encode()).hexdigest(),
        "orgao": lido["orgao"],
        "numero_edital": lido["numero"],
        "chave_edital": chave,
        "situacao": lido["situacao"],
        "data_abertura": lido["data_abertura"].isoformat() if lido["data_abertura"] else None,
        "valor": lido["valor"],
        "publico_elegivel": lido["publico_elegivel"],
        "aceita_filantropico": lido["aceita_filantropico"],
        "resumo": lido["resumo"],
        "evidencias": lido["evidencias"],
        "link_documento": lido["link_documento"],
        "lido_em": c.agora_iso(),
        "updated_at": c.agora_iso(),
    }
    c.supabase().table("opportunities").insert(registro).execute()


# ---------------------------------------------------------------------
# Execução
# ---------------------------------------------------------------------
def main():
    print("=" * 60)
    print(f"RADAR DE OPORTUNIDADES v2 | {date.today().strftime('%d/%m/%Y')}")
    print(f"Limite de leituras nesta execução: {c.MAX_LEITURAS}")
    print("=" * 60)

    memoria = Memoria()
    candidatos = descobrir_fontes_fixas() + descobrir_busca_web()
    print(f"\nCandidatos encontrados: {len(candidatos)}")

    # 2. BARRAR repetidos pelo link (e repetidos dentro da própria rodada)
    vistos, novos = set(), []
    for cand in candidatos:
        u = c.url_canonica(cand["url"])
        if not u or u in vistos or memoria.link_conhecido(cand["url"]):
            continue
        vistos.add(u)
        novos.append(cand)
    print(f"Links novos (não vistos antes): {len(novos)}")

    contagem = {"salvos": 0, "repetidos": 0, "encerrados": 0, "nao_edital": 0, "erros": 0}
    for cand in novos[: c.MAX_LEITURAS]:
        print(f"\nLendo: {cand['titulo'][:80]}")
        try:
            lido = ler_edital(cand)
        except Exception as e:
            contagem["erros"] += 1
            print(f"  não foi possível ler: {e}")
            continue

        if not lido["eh_edital"]:
            contagem["nao_edital"] += 1
            print("  ignorado: não é um edital")
            continue
        if lido["situacao"] == "encerrado":
            contagem["encerrados"] += 1
            print(f"  ignorado: encerrado (prazo {lido['prazo']})")
            continue

        chave = c.chave_edital(lido["titulo"], lido["orgao"], c.numero_edital(lido["numero"] or ""), cand["url"])
        if memoria.edital_conhecido(chave, lido["titulo"]):
            contagem["repetidos"] += 1
            print(f"  ignorado: edital já existe ({chave})")
            continue

        salvar(cand, lido, chave)
        memoria.registrar(cand["url"], chave, lido["titulo"])
        contagem["salvos"] += 1
        print(f"  SALVO | {lido['situacao']} | prazo {lido['prazo']} | filantrópico: {lido['aceita_filantropico']}")

    if len(novos) > c.MAX_LEITURAS:
        print(f"\n{len(novos) - c.MAX_LEITURAS} links ficaram para a próxima execução (limite de leituras).")

    print("\n" + "=" * 60)
    print(f"Salvos: {contagem['salvos']} | Repetidos barrados: {contagem['repetidos']} | "
          f"Encerrados descartados: {contagem['encerrados']} | Não eram edital: {contagem['nao_edital']} | Erros: {contagem['erros']}")
    print(c.resumo_custo())
    print("=" * 60)

# ---------------------------------------------------------------------
# RELEITURA: lê de novo os editais antigos (gravados antes do robô v2)
# para descobrir prazo e situação reais. Nota antiga é refeita com a régua.
# ---------------------------------------------------------------------
# Títulos genéricos que são páginas de menu, não editais
RE_TITULO_MENU = re.compile(
    r"^(oportunidades|explorar chamadas|financiamentos?|consulta a financiamentos|chamadas e editais|"
    r"programas institucionais.*|buscar por oportunidades|- ?conv[eê]nios|editais)$", re.I)

CONFERIR_NO_SITE = "Página não pôde ser lida automaticamente. Conferir prazo e regras no site do edital."


def classificar_erro(erro, titulo):
    """Decide o que fazer com um edital antigo que não pôde ser lido.
    Retorna (situacao, motivo) ou None para tentar de novo na próxima execução."""
    texto = str(erro)
    status = getattr(getattr(erro, "response", None), "status_code", None)
    if RE_TITULO_MENU.match((titulo or "").strip()):
        return "encerrado", "Descartado na releitura: página de menu, não é um edital."
    if status in (404, 410) or status == 401:
        return "encerrado", "Descartado na releitura: link fora do ar."
    if "No connection adapters" in texto or "Invalid URL" in texto:
        return "encerrado", "Descartado na releitura: link inválido."
    if status == 403 or "sem conteúdo suficiente" in texto:
        return "indefinido", CONFERIR_NO_SITE
    return None  # falha momentânea: tenta de novo


def releitura():
    sb = c.supabase()
    antigos = sb.table("opportunities").select("id, title, url").is_("lido_em", "null") \
        .is_("duplicado_de", "null").neq("situacao", "encerrado").execute().data
    print(f"Editais antigos para reler: {len(antigos)} (limite nesta execução: {c.MAX_LEITURAS})")
    contagem = {"atualizados": 0, "encerrados": 0, "nao_edital": 0, "conferir": 0, "erros": 0}

    for o in antigos[: c.MAX_LEITURAS]:
        print(f"\nRelendo: {o['title'][:80]}")
        try:
            lido = ler_edital({"titulo": o["title"], "url": o["url"]})
        except Exception as e:
            destino = classificar_erro(e, o["title"])
            if destino is None:
                contagem["erros"] += 1
                print(f"  não foi possível ler (fica para a próxima): {e}")
                continue
            situacao, motivo = destino
            sb.table("opportunities").update({
                "situacao": situacao, "resumo": motivo, "lido_em": c.agora_iso(), "updated_at": c.agora_iso(),
            }).eq("id", o["id"]).execute()
            sb.table("qualifications").delete().eq("opportunity_id", o["id"]).execute()
            contagem["conferir" if situacao == "indefinido" else "encerrados"] += 1
            print(f"  {motivo} ({e})")
            continue

        atualizacao = {
            "situacao": lido["situacao"],
            "deadline": lido["prazo"],
            "orgao": lido["orgao"],
            "numero_edital": lido["numero"],
            "data_abertura": lido["data_abertura"].isoformat() if lido["data_abertura"] else None,
            "valor": lido["valor"],
            "publico_elegivel": lido["publico_elegivel"],
            "aceita_filantropico": lido["aceita_filantropico"],
            "resumo": lido["resumo"],
            "evidencias": lido["evidencias"],
            "link_documento": lido["link_documento"],
            "lido_em": c.agora_iso(),
            "updated_at": c.agora_iso(),
        }
        if not lido["eh_edital"]:
            atualizacao["situacao"] = "encerrado"
            atualizacao["resumo"] = "Descartado na releitura: a página não é um edital."
            contagem["nao_edital"] += 1
        elif lido["situacao"] == "encerrado":
            contagem["encerrados"] += 1
        else:
            contagem["atualizados"] += 1

        sb.table("opportunities").update(atualizacao).eq("id", o["id"]).execute()
        # apaga a nota antiga para o qualifier.py refazer com a régua nova
        sb.table("qualifications").delete().eq("opportunity_id", o["id"]).execute()
        print(f"  {atualizacao['situacao']} | prazo {lido['prazo']} | filantrópico: {lido['aceita_filantropico']}")

    restantes = max(0, len(antigos) - c.MAX_LEITURAS)
    print("\n" + "=" * 60)
    print(f"Continuam valendo: {contagem['atualizados']} | Encerrados: {contagem['encerrados']} | "
          f"Não eram edital: {contagem['nao_edital']} | Conferir no site: {contagem['conferir']} | "
          f"Erros (tentar de novo): {contagem['erros']}")
    if restantes:
        print(f"Faltam {restantes} editais: rode a releitura de novo.")
    print(c.resumo_custo())
    print("=" * 60)


if __name__ == "__main__":
    import os
    if os.environ.get("MODO", "normal") == "releitura":
        releitura()
    else:
        main()
