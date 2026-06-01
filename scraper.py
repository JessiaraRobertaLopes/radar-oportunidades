import os
import hashlib
import requests
from bs4 import BeautifulSoup
from supabase import create_client
from anthropic import Anthropic
from datetime import datetime
import json

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
client = Anthropic(api_key=ANTHROPIC_KEY)

FONTES_ESPECIFICAS = [
    {
        "name": "Ministério da Saúde — Chamamentos 2026",
        "url": "https://www.gov.br/saude/pt-br/acesso-a-informacao/participacao-social/chamamentos-publicos/2026",
        "scrape_type": "html_static"
    },
    {
        "name": "FAPEMIG — Chamadas e Editais",
        "url": "https://fapemig.br/oportunidades/chamadas-e-editais",
        "scrape_type": "html_static"
    },
]

TERMOS_BUSCA = [
    "edital aberto saúde SUS hospital filantrópico 2026",
    "chamamento público inovação saúde tecnologia hospitalar 2026",
    "financiamento acessibilidade inclusão saúde 2026",
    "edital ESG sustentabilidade saúde hospital 2026",
    "chamada pública digitalização transformação digital saúde 2026",
    "financiamento infraestrutura equipamentos hospitalares SUS 2026",
    "edital formação educação profissionais saúde 2026",
    "chamamento público pesquisa clínica inovação Brasil 2026",
    "financiamento terceiro setor filantropia saúde Minas Gerais 2026",
    "edital ODS saúde bem estar desenvolvimento sustentável 2026",
    "chamada pública inteligência artificial saúde 2026",
    "financiamento reforma ampliação hospital SUS 2026",
    "edital segurança paciente qualidade hospitalar 2026",
    "chamamento emenda parlamentar saúde Minas Gerais 2026",
    "financiamento internacional saúde Brasil OMS OPAS 2026",
]

def make_hash(title, url):
    return hashlib.sha256(f"{title}{url}".encode()).hexdigest()

def get_or_create_source(name, url, scrape_type="html_static"):
    result = supabase.table("sources").select("id").eq("url", url).execute()
    if result.data:
        return result.data[0]["id"]
    inserted = supabase.table("sources").insert({
        "name": name,
        "url": url,
        "scrape_type": scrape_type,
        "frequency": "daily",
        "active": True
    }).execute()
    return inserted.data[0]["id"]

def save_opportunity(source_id, title, url, description="", deadline=None):
    if not title or len(title.strip()) < 10:
        return False
    h = make_hash(title, url)
    existing = supabase.table("opportunities").select("id").eq("hash", h).execute()
    if existing.data:
        return False
    supabase.table("opportunities").insert({
        "source_id": source_id,
        "title": title.strip(),
        "url": url,
        "description": description[:500] if description else "",
        "deadline": deadline,
        "hash": h,
        "updated_at": datetime.utcnow().isoformat()
    }).execute()
    return True

def scrape_ministerio_saude(source):
    print(f"Raspando: {source['name']}")
    source_id = get_or_create_source(source["name"], source["url"])
    count = 0
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; RadarBot/1.0)"}
        response = requests.get(source["url"], headers=headers, timeout=30)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        for link in soup.find_all("a", href=True):
            title = link.get_text(strip=True)
            href = link["href"]
            if len(title) < 15:
                continue
            if not any(kw in title.lower() for kw in ["chamamento", "edital", "chamada", "seleção", "convocação"]):
                continue
            if href.startswith("/"):
                href = "https://www.gov.br" + href
            elif not href.startswith("http"):
                continue
            parent = link.find_parent()
            desc = parent.get_text(strip=True)[:300] if parent else ""
            if save_opportunity(source_id, title, href, desc):
                count += 1
                print(f"  ✅ {title[:60]}")
        supabase.table("sources").update({
            "last_scraped_at": datetime.utcnow().isoformat()
        }).eq("id", source_id).execute()
    except Exception as e:
        print(f"  ❌ Erro: {e}")
    print(f"  → {count} novos editais encontrados")
    return count

def scrape_fapemig(source):
    print(f"Raspando: {source['name']}")
    source_id = get_or_create_source(source["name"], source["url"])
    count = 0
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; RadarBot/1.0)"}
        response = requests.get(source["url"], headers=headers, timeout=30)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        for link in soup.find_all("a", href=True):
            title = link.get_text(strip=True)
            href = link["href"]
            if len(title) < 10:
                continue
            if not any(kw in title.lower() for kw in ["chamada", "edital", "seleção", "apoio", "programa", "pesquisa"]):
                continue
            if href.startswith("/"):
                href = "https://fapemig.br" + href
            elif not href.startswith("http"):
                continue
            parent = link.find_parent()
            desc = parent.get_text(strip=True)[:300] if parent else ""
            if save_opportunity(source_id, title, href, desc):
                count += 1
                print(f"  ✅ {title[:60]}")
        supabase.table("sources").update({
            "last_scraped_at": datetime.utcnow().isoformat()
        }).eq("id", source_id).execute()
    except Exception as e:
        print(f"  ❌ Erro: {e}")
    print(f"  → {count} novos editais encontrados")
    return count

def busca_web_claude(termo):
    print(f"🔍 Buscando na web: {termo}")
    source_name = f"Busca Web — {termo[:40]}"
    source_url = f"https://busca-web/{hashlib.md5(termo.encode()).hexdigest()}"
    source_id = get_or_create_source(source_name, source_url, "web_search")
    count = 0
    try:
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=2000,
            tools=[{"type": "web_search_20250305", "name": "web_search"}],
            messages=[{
                "role": "user",
                "content": f"""Faça uma busca web por: "{termo}"

Encontre editais, chamamentos públicos ou oportunidades de financiamento REAIS e ATUAIS (2025-2026) relevantes para a Santa Casa BH (hospital filantrópico 100% SUS em Belo Horizonte, MG).

Retorne APENAS um JSON válido com até 5 resultados:
{{
  "editais": [
    {{
      "titulo": "título completo do edital",
      "fonte": "nome da organização",
      "url": "URL completa e real",
      "descricao": "descrição em 1-2 frases",
      "prazo": "data de encerramento no formato YYYY-MM-DD ou null"
    }}
  ]
}}

Inclua APENAS editais reais com URLs válidas. Se não encontrar nada relevante, retorne {{"editais": []}}"""
            }]
        )
        text = ""
        for block in response.content:
            if hasattr(block, "text"):
                text += block.text
        if not text.strip():
            return 0
        text = text.strip()
        if "```" in text:
            parts = text.split("```")
            for part in parts:
                if "{" in part:
                    text = part
                    if text.startswith("json"):
                        text = text[4:]
                    break
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            text = text[start:end]
        data = json.loads(text)
        editais = data.get("editais", [])
        for edital in editais:
            titulo = edital.get("titulo", "")
            url = edital.get("url", "")
            descricao = edital.get("descricao", "")
            fonte = edital.get("fonte", "")
            prazo = edital.get("prazo")
            if not titulo or not url or not url.startswith("http"):
                continue
            src_id = get_or_create_source(
                f"Web — {fonte}" if fonte else source_name,
                url,
                "web_search"
            )
            if save_opportunity(src_id, titulo, url, descricao, prazo):
                count += 1
                print(f"  ✅ {titulo[:60]}")
    except Exception as e:
        print(f"  ❌ Erro na busca web: {e}")
    print(f"  → {count} novos editais encontrados")
    return count

def main():
    total = 0
    print("=" * 50)
    print("RADAR DE OPORTUNIDADES — Santa Casa BH")
    print(f"Iniciado em: {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    print("=" * 50)

    print("\n📡 FONTES ESPECÍFICAS")
    total += scrape_ministerio_saude(FONTES_ESPECIFICAS[0])
    total += scrape_fapemig(FONTES_ESPECIFICAS[1])

    print("\n🌐 BUSCA WEB")
    for termo in TERMOS_BUSCA:
        total += busca_web_claude(termo)

    print("\n" + "=" * 50)
    print(f"✅ TOTAL: {total} novos editais encontrados")
    print("=" * 50)

if __name__ == "__main__":
    main()
