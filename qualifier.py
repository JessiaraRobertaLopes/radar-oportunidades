import os
import json
from supabase import create_client
from anthropic import Anthropic
from datetime import datetime

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
client = Anthropic(api_key=ANTHROPIC_KEY)

PERFIL_SANTA_CASA = """
A Santa Casa de Misericórdia de Belo Horizonte é o maior complexo hospitalar de Minas Gerais,
maior hospital do Brasil em internações SUS, com 125 anos de história, 1.153 leitos, 194 UTIs,
mais de 7.000 colaboradores e modelo 100% SUS.

ÁREAS PRIORITÁRIAS (alta aderência):
- Oncologia adulto e pediátrico
- Materno-infantil, UTI Neonatal, pediatria
- Nefrologia, hemodiálise, diálise peritoneal
- Oftalmologia: glaucoma, catarata, ceratocone, transplante de córnea
- Alta complexidade cirúrgica e transplantes
- Terapia intensiva UTI adulto e pediátrica
- Inteligência artificial aplicada à saúde
- Impressão 3D para uso assistencial
- Pesquisa clínica nacional e internacional
- Formação de profissionais de saúde
- Residência médica e multiprofissional
- Sustentabilidade e agenda ASG
- Infraestrutura hospitalar e equipamentos médicos
- Inclusão social e acessibilidade
- Comunidade surda e Libras

FONTES COM HISTÓRICO DE APROVAÇÃO:
Leis de incentivo fiscal, emendas parlamentares, Ministério Público MG,
parcerias corporativas, convênios públicos, pesquisa clínica.

PALAVRAS-CHAVE PRIORITÁRIAS:
SUS, oncologia, materno-infantil, UTI neonatal, hemodiálise, nefrologia,
oftalmologia, alta complexidade, transplante, filantropia hospitalar,
terceiro setor, saúde pública, equipamentos médicos, reforma hospitalar,
inteligência artificial em saúde, pesquisa clínica, inivação, inclusão.
"""

def qualify_opportunity(title, description, url):
    prompt = f"""Você é um especialista em captação de recursos para hospitais filantrópicos.

Analise esta oportunidade de edital/financiamento e avalie a aderência ao perfil institucional da Santa Casa BH.

OPORTUNIDADE:
Título: {title}
Descrição: {description}
URL: {url}

PERFIL INSTITUCIONAL:
{PERFIL_SANTA_CASA}

Responda APENAS com um JSON válido, sem texto adicional, neste formato exato:
{{
  "score": <número de 0 a 100>,
  "tier": "<A, B, C ou D>",
  "justification": "<explicação em 2-3 frases>",
  "matched_areas": ["<área 1>", "<área 2>"],
  "matched_keywords": ["<palavra 1>", "<palavra 2>"]
}}

Critérios de tier:
- Tier A (score 80-100): altíssima aderência, notificar imediatamente
- Tier B (score 60-79): boa aderência, analisar com atenção
- Tier C (score 40-59): aderência moderada, vale monitorar
- Tier D (score 0-39): baixa aderência, arquivar
"""

    response = client.messages.create(
       model="claude-sonnet-4-5",
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}]
    )
    text = response.content[0].text.strip()
if "```" in text:
    text = text.split("```")[1]
    if text.startswith("json"):
        text = text[4:]
result = json.loads(text.strip())
    return result

def main():
    result = supabase.table("opportunities").select(
        "id, title, description, url"
    ).execute()

    all_opps = result.data
    qualified_result = supabase.table("qualifications").select("opportunity_id").execute()
    qualified_ids = {q["opportunity_id"] for q in qualified_result.data}
    pending = [o for o in all_opps if o["id"] not in qualified_ids]

    print(f"Oportunidades para qualificar: {len(pending)}")

    for opp in pending:
        print(f"Qualificando: {opp['title'][:60]}...")
        try:
            result = qualify_opportunity(
                opp["title"],
                opp.get("description") or "",
                opp.get("url") or ""
            )
            supabase.table("qualifications").insert({
                "opportunity_id": opp["id"],
                "score": result["score"],
                "tier": result["tier"],
                "justification": result["justification"],
                "matched_areas": result.get("matched_areas", []),
                "matched_keywords": result.get("matched_keywords", []),
                "notification_status": "pending",
                "updated_at": datetime.utcnow().isoformat()
            }).execute()
            print(f"  → Tier {result['tier']} | Score {result['score']}")
        except Exception as e:
            print(f"  → Erro: {e}")

    print("\nQualificação concluída!")

if __name__ == "__main__":
    main()
