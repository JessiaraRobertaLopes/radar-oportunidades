import os
import hashlib
import requests
from bs4 import BeautifulSoup
from supabase import create_client
from datetime import datetime

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

SOURCES = [
    {"name": "Ministério da Saúde", "url": "https://www.gov.br/saude/pt-br/acesso-a-informacao/licitacoes-e-contratos/chamamentos", "scrape_type": "html_static"},
    {"name": "BNDES Chamadas", "url": "https://www.bndes.gov.br/wps/portal/site/home/transparencia/editais", "scrape_type": "html_static"},
    {"name": "FINEP Chamadas", "url": "https://www.finep.gov.br/chamadas-publicas", "scrape_type": "html_static"},
    {"name": "FAPEMIG Editais", "url": "https://fapemig.br/pt/menu/editais/", "scrape_type": "html_static"},
    {"name": "CNPq Chamadas", "url": "https://www.gov.br/cnpq/pt-br/acesso-a-informacao/acoes-e-programas/programas/chamadas-publicas", "scrape_type": "html_static"},
]

def make_hash(title, url):
    return hashlib.sha256(f"{title}{url}".encode()).hexdigest()

def get_or_create_source(source):
    result = supabase.table("sources").select("id").eq("url", source["url"]).execute()
    if result.data:
        return result.data[0]["id"]
    inserted = supabase.table("sources").insert({
        "name": source["name"],
        "url": source["url"],
        "scrape_type": source["scrape_type"],
        "frequency": "daily",
        "active": True
    }).execute()
    return inserted.data[0]["id"]

def scrape_source(source):
    print(f"Raspando: {source['name']}")
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; RadarBot/1.0)"}
        response = requests.get(source["url"], headers=headers, timeout=30)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        links = soup.find_all("a", href=True)
        opportunities = []
        keywords = ["edital", "chamamento", "chamada", "oportunidade", "financiamento", "convênio", "seleção", "saúde", "pesquisa"]
        for link in links:
            title = link.get_text(strip=True)
            href = link["href"]
            if len(title) < 10:
                continue
            if not any(kw in title.lower() for kw in keywords):
                continue
            if href.startswith("/"):
                base = "/".join(source["url"].split("/")[:3])
                href = base + href
            opportunities.append({"title": title, "url": href})
        return opportunities
    except Exception as e:
        print(f"Erro ao raspar {source['name']}: {e}")
        return []

def save_opportunity(source_id, opp):
    h = make_hash(opp["title"], opp["url"])
    existing = supabase.table("opportunities").select("id").eq("hash", h).execute()
    if existing.data:
        return False
    supabase.table("opportunities").insert({
        "source_id": source_id,
        "title": opp["title"],
        "url": opp["url"],
        "hash": h,
        "raw_text": opp.get("description", ""),
        "updated_at": datetime.utcnow().isoformat()
    }).execute()
    return True

def main():
    total_new = 0
    for source in SOURCES:
        source_id = get_or_create_source(source)
        opportunities = scrape_source(source)
        new_count = 0
        for opp in opportunities:
            if save_opportunity(source_id, opp):
                new_count += 1
        supabase.table("sources").update({"last_scraped_at": datetime.utcnow().isoformat()}).eq("id", source_id).execute()
        print(f"{source['name']}: {new_count} novas oportunidades")
        total_new += new_count
    print(f"\nTotal: {total_new} novas oportunidades encontradas")

if __name__ == "__main__":
    main()
