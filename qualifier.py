"""
RADAR DE OPORTUNIDADES v2 - QUALIFICAÇÃO COM RÉGUA
Qualifica só editais lidos pelo robô v2, que não são repetidos e não estão encerrados.
A nota considera: alinhamento ao perfil, elegibilidade de filantrópico, situação e informação disponível.
"""
import json
from datetime import date

import comum as c

PERFIL = """A Santa Casa BH é o maior complexo hospitalar de Minas Gerais e o maior hospital do Brasil em internações SUS:
instituição filantrópica, 100% SUS, mais de 120 anos, cerca de 1.150 leitos e 190 UTIs, mais de 7.000 colaboradores,
com faculdade, ensino e pesquisa.

ÁREAS PRIORITÁRIAS
- Assistência de alta complexidade e SUS (oncologia, cardiologia, neurologia, transplantes, materno-infantil, UTI)
- Inovação e tecnologia em saúde (IA, saúde digital, automação)
- Educação e formação de profissionais de saúde; residências
- Pesquisa clínica
- Infraestrutura hospitalar, reforma, ampliação e equipamentos
- Sustentabilidade, ESG e agenda ambiental
- Inclusão social e acessibilidade (inclusive comunidade surda)
- Sustentabilidade financeira de hospitais filantrópicos"""

REGUA = """RÉGUA DE AVALIAÇÃO (siga rigorosamente)

1. Alinhamento (0 a 50): o objeto do edital financia algo que a instituição faz ou planeja fazer?
   45-50 direto e central | 30-44 relevante | 15-29 tangencial | 0-14 sem relação
2. Elegibilidade (0 a 30): a instituição pode se candidatar?
   aceita_filantropico = sim -> 25-30 | indefinido -> 10-18 | nao -> 0
3. Viabilidade (0 a 20): situação e prazo
   aberto com prazo >= 15 dias, ou fluxo contínuo -> 15-20 | aberto com prazo < 15 dias -> 8-14 | indefinido -> 3-8

score = soma. Prioridade: A >= 80 | B 60-79 | C 40-59 | D < 40
TRAVAS: se aceita_filantropico = "nao" -> tier D. Se aceita_filantropico = "indefinido" -> no máximo B.
Seja exigente: uma carteira saudável tem poucos A. Na dúvida entre duas faixas, escolha a menor.

Responda APENAS com JSON:
{"score": 0, "tier": "A|B|C|D", "justification": "2 a 3 frases citando alinhamento, elegibilidade e prazo",
 "matched_areas": ["áreas prioritárias atendidas"], "matched_keywords": ["palavras-chave"]}"""

SISTEMA = f"Você é especialista em captação de recursos para hospitais filantrópicos.\n\nPERFIL DA INSTITUIÇÃO\n{PERFIL}\n\n{REGUA}"


def aplicar_travas(resultado, opp):
    score = max(0, min(100, int(round(float(resultado.get("score", 0))))))
    if opp.get("aceita_filantropico") == "nao":
        score = min(score, 39)
    elif opp.get("aceita_filantropico") == "indefinido":
        score = min(score, 79)
    tier = "A" if score >= 80 else "B" if score >= 60 else "C" if score >= 40 else "D"
    resultado["score"], resultado["tier"] = score, tier
    return resultado


def main():
    sb = c.supabase()
    opps = sb.table("opportunities").select(
        "id, title, orgao, resumo, description, publico_elegivel, aceita_filantropico, situacao, deadline, valor"
    ).not_.is_("lido_em", "null").is_("duplicado_de", "null").neq("situacao", "encerrado").execute().data
    ja = {q["opportunity_id"] for q in sb.table("qualifications").select("opportunity_id").execute().data}
    pendentes = [o for o in opps if o["id"] not in ja]
    print(f"Editais para qualificar: {len(pendentes)}")

    for o in pendentes:
        ficha = {
            "titulo": o["title"], "orgao": o.get("orgao"), "resumo": o.get("resumo") or (o.get("description") or "")[:600],
            "publico_elegivel": o.get("publico_elegivel"), "aceita_filantropico": o.get("aceita_filantropico"),
            "situacao": o.get("situacao"), "prazo_inscricao": o.get("deadline"), "valor": o.get("valor"),
            "hoje": date.today().isoformat(),
        }
        try:
            resposta = c.perguntar(
                c.MODELO_QUALIFICACAO,
                "EDITAL\n" + json.dumps(ficha, ensure_ascii=False, indent=1),
                sistema=SISTEMA, max_tokens=600, cache_sistema=True,
            )
            r = aplicar_travas(c.extrair_json(resposta), o)
            sb.table("qualifications").insert({
                "opportunity_id": o["id"], "score": r["score"], "tier": r["tier"],
                "justification": r.get("justification"), "matched_areas": r.get("matched_areas", []),
                "matched_keywords": r.get("matched_keywords", []), "notification_status": "pending",
                "updated_at": c.agora_iso(),
            }).execute()
            print(f"  {r['tier']} | {r['score']} | {o['title'][:70]}")
        except Exception as e:
            print(f"  erro em '{o['title'][:60]}': {e}")

    print("\n" + c.resumo_custo())


if __name__ == "__main__":
    main()
