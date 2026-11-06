"""
RADAR DE OPORTUNIDADES v2 - Resumo diário de prazos (Teams)
Todo dia útil de manhã, junta numa mensagem só o que está parado e com prazo
chegando, e envia para o fluxo do Teams (Power Automate, gatilho de webhook).
Não usa IA: custo zero.

Regras (as mesmas do quadro "Onde está parado"):
  Captação:  Prioridade A ou B, ainda "Novo" (ninguém pegou), prazo em 10 dias ou menos
  Captação:  "Em análise" há mais de 5 dias úteis
  Projetos:  "Encaminhado", sem decisão, prazo em 10 dias ou menos
Se não houver nada, não envia nada.
"""
from datetime import date, datetime

import requests

from comum import agora_iso, supabase

LIMITE_PRAZO_DIAS = 10
LIMITE_ANALISE_DIAS_UTEIS = 5


def dias_uteis_desde(iso):
    if not iso:
        return 0
    inicio = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).date()
    hoje, n, d = date.today(), 0, inicio
    while d < hoje:
        d = date.fromordinal(d.toordinal() + 1)
        if d.weekday() < 5:
            n += 1
    return n


def data_br(iso):
    return datetime.fromisoformat(str(iso)[:10]).strftime("%d/%m/%Y") if iso else "Sem prazo informado"


def main():
    sb = supabase()
    cfg = {c["chave"]: c["valor"] for c in (sb.table("config_integracoes").select("chave, valor").execute().data or [])}
    destino, app_url = cfg.get("teams_webhook_url"), cfg.get("app_url", "")

    opps = {o["id"]: o for o in (sb.table("opportunities")
            .select("id, title, orgao, deadline, situacao, duplicado_de").execute().data or [])}
    notas = {q["opportunity_id"]: q["tier"] for q in (sb.table("qualifications").select("opportunity_id, tier").execute().data or [])}
    gestao = {g["opportunity_id"]: g for g in (sb.table("pipeline").select("*").execute().data or [])}
    nomes = {p["id"]: p["nome"] for p in (sb.table("perfis").select("id, nome").execute().data or [])}

    hoje = date.today()
    itens = []
    for oid, o in opps.items():
        if o.get("duplicado_de") or o.get("situacao") == "encerrado":
            continue
        dias = (date.fromisoformat(o["deadline"]) - hoje).days if o.get("deadline") else None
        if dias is not None and dias < 0:
            continue
        g = gestao.get(oid) or {}
        status = g.get("status", "novo")
        base = {"titulo": o["title"], "orgao": o.get("orgao") or "", "prazo": data_br(o.get("deadline")), "dias_para_prazo": dias}
        if status == "novo" and notas.get(oid) in ("A", "B") and dias is not None and dias <= LIMITE_PRAZO_DIAS:
            itens.append({**base, "para": "Captação", "motivo": f"Prioridade {notas[oid]}, ninguém pegou ainda e faltam {dias} dia(s)"})
        elif status == "em_analise" and dias_uteis_desde(g.get("etapa_desde")) > LIMITE_ANALISE_DIAS_UTEIS:
            quem = nomes.get(g.get("responsavel_id"), "sem responsável")
            itens.append({**base, "para": "Captação", "motivo": f"Em análise há {dias_uteis_desde(g.get('etapa_desde'))} dias úteis ({quem})"})
        elif status == "encaminhado" and dias is not None and dias <= LIMITE_PRAZO_DIAS:
            itens.append({**base, "para": "Setor de Projetos", "motivo": f"Encaminhado e sem decisão; faltam {dias} dia(s)"})

    print(f"Itens no resumo: {len(itens)}")
    if not itens:
        print("Nada parado com prazo curto. Nenhuma mensagem enviada.")
        return

    itens.sort(key=lambda x: (x["dias_para_prazo"] if x["dias_para_prazo"] is not None else 999))
    texto = "\n".join(f"• [{i['para']}] {i['titulo']} | prazo {i['prazo']} | {i['motivo']}" for i in itens)
    payload = {
        "evento": "resumo_diario", "para": "Captação e Setor de Projetos",
        "titulo": f"{len(itens)} edital(is) precisam de atenção hoje",
        "orgao": "", "prazo": "", "dias_para_prazo": None, "quem": "Radar",
        "potencial": "", "justificativa": texto, "link": app_url + "#dashboard", "itens": itens,
    }
    registro = sb.table("notificacoes").insert({"evento": "resumo_diario", "para": "Captação e Setor de Projetos",
                                                "payload": payload}).execute().data[0]
    if not destino:
        print("Sem endereço do Teams configurado: resumo só registrado no banco.")
        return
    try:
        r = requests.post(destino, json=payload, timeout=30)
        r.raise_for_status()
        sb.table("notificacoes").update({"enviado_em": agora_iso()}).eq("id", registro["id"]).execute()
        print("Resumo enviado ao Teams.")
    except Exception as erro:
        sb.table("notificacoes").update({"erro": str(erro)[:300]}).eq("id", registro["id"]).execute()
        print(f"Falha ao enviar ao Teams: {erro}")


if __name__ == "__main__":
    print(f"Resumo diário | {agora_iso()}")
    main()
