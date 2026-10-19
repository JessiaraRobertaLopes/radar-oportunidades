// =====================================================================
// RADAR DE OPORTUNIDADES v2 - Edge Function "busca-ia"
// Recebe a descrição de um projeto e devolve os editais mais aderentes:
//   1) da base do Radar (sempre; modelo Haiku, barato)
//   2) da web (opcional; modelo Sonnet + web_search, mais caro)
// A chave da Anthropic fica só aqui (secret ANTHROPIC_API_KEY).
// Roda com o login de quem chamou: o RLS do banco continua valendo.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MODELO_BASE = Deno.env.get("MODELO_BUSCA_BASE") ?? "claude-haiku-4-5";
const MODELO_WEB = Deno.env.get("MODELO_BUSCA_WEB") ?? "claude-sonnet-4-5";
const LIMITE_POR_HORA = Number(Deno.env.get("LIMITE_BUSCAS_HORA") ?? "20");
const INSTITUICAO = Deno.env.get("NOME_INSTITUICAO") ??
  "Santa Casa BH, hospital filantrópico 100% SUS de Belo Horizonte (MG), com ensino e pesquisa";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Lê o primeiro objeto JSON da resposta da IA
function extrairJson(texto: string) {
  const ini = texto.indexOf("{");
  if (ini < 0) throw new Error("Resposta da IA sem JSON");
  for (let fim = texto.lastIndexOf("}"); fim > ini; fim = texto.lastIndexOf("}", fim - 1)) {
    try { return JSON.parse(texto.slice(ini, fim + 1)); } catch { /* tenta um fechamento antes */ }
  }
  throw new Error("JSON inválido na resposta da IA");
}

async function perguntar(modelo: string, mensagem: string, ferramentas?: unknown[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: modelo, max_tokens: 1500,
      messages: [{ role: "user", content: mensagem }],
      ...(ferramentas ? { tools: ferramentas } : {}),
    }),
  });
  if (!r.ok) throw new Error(`API da IA respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const texto = (d.content ?? []).map((b: { text?: string }) => b.text ?? "").join("");
  return { texto, entrada: d.usage?.input_tokens ?? 0, saida: d.usage?.output_tokens ?? 0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);
  if (!ANTHROPIC_KEY) return json({ erro: "Chave da IA não configurada no servidor." }, 500);

  // Cliente com o login de quem chamou (RLS valendo)
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ erro: "Sessão inválida. Entre novamente." }, 401);

  let corpo: { pergunta?: string; incluir_web?: boolean };
  try { corpo = await req.json(); } catch { return json({ erro: "Requisição inválida." }, 400); }
  const pergunta = String(corpo.pergunta ?? "").trim();
  const incluirWeb = corpo.incluir_web === true;
  if (pergunta.length < 10 || pergunta.length > 2000) {
    return json({ erro: "Descreva o projeto com 10 a 2.000 caracteres." }, 400);
  }

  // Limite de uso por pessoa (protege o crédito da API)
  const umaHora = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await sb.from("buscas_ia").select("id", { count: "exact", head: true })
    .eq("usuario_id", user.id).gte("criado_em", umaHora);
  if ((count ?? 0) >= LIMITE_POR_HORA) {
    return json({ erro: `Limite de ${LIMITE_POR_HORA} buscas por hora atingido. Tente mais tarde.` }, 429);
  }

  // ---------- 1) Base do Radar ----------
  const { data: quals, error } = await sb.from("qualifications")
    .select("tier, score, opportunities(id, title, orgao, resumo, description, deadline, situacao, aceita_filantropico, duplicado_de)")
    .order("score", { ascending: false }).limit(300);
  if (error) return json({ erro: "Não foi possível ler a base do Radar." }, 500);

  const hoje = new Date().toISOString().slice(0, 10);
  const vistos = new Set<string>();
  const base: Record<string, unknown>[] = [];
  for (const q of quals ?? []) {
    // deno-lint-ignore no-explicit-any
    const o: any = (q as any).opportunities;
    if (!o || vistos.has(o.id) || o.duplicado_de || o.situacao === "encerrado") continue;
    if (o.deadline && o.deadline < hoje) continue;
    vistos.add(o.id);
    base.push({
      ref: `e${base.length + 1}`, id: o.id, titulo: o.title, orgao: o.orgao,
      prazo: o.deadline, situacao: o.situacao, aceita_filantropico: o.aceita_filantropico,
      resumo: String(o.resumo ?? o.description ?? "").slice(0, 220),
      tier: (q as { tier: string }).tier, score: (q as { score: number }).score,
    });
    if (base.length >= 80) break;
  }

  let entrada = 0, saida = 0;
  let daBase: Record<string, unknown>[] = [];
  if (base.length) {
    const lista = base.map((b) =>
      `${b.ref} | ${b.titulo} | ${b.orgao ?? ""} | prazo: ${b.prazo ?? "sem prazo"} | filantrópico: ${b.aceita_filantropico} | ${b.resumo}`
    ).join("\n");
    const r = await perguntar(MODELO_BASE,
`Você é especialista em captação de recursos para a ${INSTITUICAO}.

PROJETO QUE A EQUIPE QUER FINANCIAR:
"""${pergunta}"""

EDITAIS ATIVOS NA BASE DO RADAR (ref | título | órgão | prazo | aceita filantrópico | resumo):
${lista}

Escolha até 5 editais que realmente poderiam financiar ESTE projeto. Ignore os que não têm relação.
Responda APENAS com JSON:
{"resultados": [{"ref": "e1", "aderencia": 0-100, "justificativa": "1 a 2 frases ligando o edital ao projeto"}]}
Se nenhum servir, responda {"resultados": []}.`);
    entrada += r.entrada; saida += r.saida;
    const porRef = new Map(base.map((b) => [b.ref, b]));
    daBase = (extrairJson(r.texto).resultados ?? [])
      .filter((x: { ref: string }) => porRef.has(x.ref))
      .map((x: { ref: string; aderencia: number; justificativa: string }) => {
        const b = porRef.get(x.ref)!;
        return { id: b.id, titulo: b.titulo, orgao: b.orgao, prazo: b.prazo, tier: b.tier,
          aderencia: Math.max(0, Math.min(100, Math.round(Number(x.aderencia) || 0))), justificativa: x.justificativa };
      })
      .sort((a: { aderencia: number }, b: { aderencia: number }) => b.aderencia - a.aderencia);
  }

  // ---------- 2) Web (opcional) ----------
  let daWeb: Record<string, unknown>[] = [];
  let erroWeb: string | null = null;
  if (incluirWeb) {
    try {
      const r = await perguntar(MODELO_WEB,
`Hoje é ${hoje}. Busque na web editais, chamamentos ou programas de financiamento com INSCRIÇÕES ABERTAS
(ou de fluxo contínuo) que possam financiar este projeto da ${INSTITUICAO}:
"""${pergunta}"""
Ignore notícias, resultados e editais encerrados. Informe o link da página oficial do edital.
Responda APENAS com JSON (até 4 itens):
{"resultados": [{"titulo": "...", "orgao": "...", "url": "https://...", "prazo": "AAAA-MM-DD ou null", "justificativa": "1 a 2 frases"}]}`,
        [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
      entrada += r.entrada; saida += r.saida;
      daWeb = (extrairJson(r.texto).resultados ?? [])
        .filter((x: { url?: string }) => /^https?:\/\//i.test(x.url ?? ""))
        // descarta o que a IA trouxe já vencido (prazo antes de hoje)
        .filter((x: { prazo?: string | null }) => !/^\d{4}-\d{2}-\d{2}$/.test(String(x.prazo ?? "")) || String(x.prazo) >= hoje)
        .filter((x: { justificativa?: string }) => !/encerrad|vencid|expirad/i.test(x.justificativa ?? ""))
        .slice(0, 4);
    } catch (e) {
      console.error(e);
      erroWeb = "A busca na web não respondeu desta vez. Os resultados da base do Radar continuam válidos.";
    }
  }

  const resultados = { da_base: daBase, da_web: daWeb, erro_web: erroWeb, incluiu_web: incluirWeb };
  await sb.from("buscas_ia").insert({
    usuario_id: user.id, tipo: "projeto", pergunta,
    resultados, total_resultados: daBase.length + daWeb.length,
    modelo: incluirWeb ? `${MODELO_BASE} + ${MODELO_WEB}` : MODELO_BASE,
    tokens_entrada: entrada, tokens_saida: saida,
  });

  return json({ ...resultados, uso: { tokens_entrada: entrada, tokens_saida: saida } });
});
