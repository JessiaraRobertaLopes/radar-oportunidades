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
A Santa Casa BH é o maior complexo hospitalar de Minas Gerais,
maior hospital do Brasil em internações SUS, com 125 anos de história,
1.153 leitos, 194 UTIs, mais de 7.000 colaboradores e modelo 100% SUS.

ÁREAS PRIORITÁRIAS:
- Assistência à saúde de alta complexidade e SUS
- Inovação e tecnologia em saúde (IA, digitalização, automação)
- Educação e formação de profissionais de saúde
- Sustentabilidade, ESG e agenda ambiental
- Infraestrutura hospitalar e equipamentos médicos
- Inclusão social, acessibilidade e comunidade surda
- Pesquisa clínica e estudos científicos
- Responsabilidade social e terceiro setor

PALAVRAS-CHAVE PRIORITÁRIAS:
SUS, saúde pública, hospital filantrópico, terceiro setor, inovação,
tecnologia em saúde, inteligência artificial, digitalização, ESG,
sustentabilidade, acessibilidade, inclusão, equipamentos médicos,
reforma hospitalar, pesquisa clínica, educação em saúde,
Minas Gerais, Belo Horizonte, filantropia, ODS.
"""

def qualify_opportunity(title, description, url):
    prompt = f"""Você é especialista em captação de recursos para a Santa Casa BH.

Analise esta oportunidade e avalie a aderência ao perfil institucional.

OPORTUNIDADE:
Título: {title}
Descrição: {description}
URL: {url}

PERFIL:
{PERFIL_SANTA_CASA}

Responda APENAS com JSON válido sem texto adicional:
{{
  "score": <número de 0 a 100>,
  "tier": "<A, B, C ou D>",
  "justification": "<2-3 frases>",
  "matched_areas": ["<área 1>", "<área 2>"],
  "matched_keywords": ["<palavra 1>", "<palavra 2>"]
}}

Critérios:
- Tier A (80-100): altíssima aderência, notificar imediatamente
- Tier B (60-79): boa aderência, analisar com atenção
- Tier C (40-59): aderência moderada, vale monitorar
- Tier D (0-39): baixa aderência, arquivar"""

    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}]
    )

    text = response.content[0].text.strip()
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
