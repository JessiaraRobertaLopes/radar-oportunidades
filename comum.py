"""
RADAR DE OPORTUNIDADES v2 - funções comuns do robô
- Conexões (Supabase e Anthropic)
- Normalização de link e chave do edital (checagem de repetidos)
- Download e leitura de página/PDF
- Recorte dos trechos relevantes (reduz custo de IA)
- Chamada à IA com resposta em JSON
"""
import io
import json
import os
import re
import unicodedata
from datetime import date, datetime, timezone
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------
# Configuração (tudo por variável de ambiente, para facilitar a migração)
# ---------------------------------------------------------------------
MODELO_LEITURA = os.environ.get("MODELO_LEITURA", "claude-haiku-4-5")
MODELO_BUSCA = os.environ.get("MODELO_BUSCA", "claude-sonnet-4-5")
MODELO_QUALIFICACAO = os.environ.get("MODELO_QUALIFICACAO", "claude-haiku-4-5")
MAX_LEITURAS = int(os.environ.get("MAX_LEITURAS", "25"))        # editais lidos por execução
MAX_CARACTERES_TRECHOS = int(os.environ.get("MAX_CARACTERES_TRECHOS", "6000"))
USER_AGENT = "Mozilla/5.0 (compatible; RadarOportunidades/2.0)"

_supabase = None
_anthropic = None


def supabase():
    global _supabase
    if _supabase is None:
        from supabase import create_client
        _supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    return _supabase


def ia():
    global _anthropic
    if _anthropic is None:
        from anthropic import Anthropic
        _anthropic = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _anthropic


def agora_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------
# Texto
# ---------------------------------------------------------------------
def sem_acento(t):
    return unicodedata.normalize("NFKD", str(t or "")).encode("ascii", "ignore").decode()


def normalizar_texto(t):
    t = sem_acento(t).lower()
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


# ---------------------------------------------------------------------
# Link canônico: o mesmo edital com ?utm, #ancora, / no final ou
# maiúsculas diferentes vira o mesmo link
# ---------------------------------------------------------------------
PARAMS_DESCARTAVEIS = re.compile(r"^(utm_|fbclid|gclid|mc_|ref$|source$)", re.I)


def url_canonica(url):
    if not url:
        return None
    url = url.strip()
    p = urlsplit(url)
    if p.scheme not in ("http", "https"):
        return None
    host = p.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    caminho = re.sub(r"/+", "/", p.path or "/")
    # páginas do gov.br que repetem o último trecho: /x/x -> /x
    partes = [x for x in caminho.split("/") if x]
    if len(partes) >= 2 and partes[-1] == partes[-2]:
        partes = partes[:-1]
    for sufixo in ("view", "index.html", "index.php"):
        if partes and partes[-1].lower() == sufixo:
            partes = partes[:-1]
    caminho = "/" + "/".join(partes)
    query = urlencode(sorted((k, v) for k, v in parse_qsl(p.query) if not PARAMS_DESCARTAVEIS.match(k)))
    return urlunsplit(("https", host, caminho.lower(), query, ""))


def dominio(url):
    try:
        h = urlsplit(url).netloc.lower()
        return h[4:] if h.startswith("www.") else h
    except Exception:
        return ""


# ---------------------------------------------------------------------
# Chave do edital: sigla/órgão + número/ano
# Ex.: "Chamamento Público nº 01/2026 - SEIDIGI" -> "seidigi|1/2026"
# ---------------------------------------------------------------------
RE_NUMERO = re.compile(r"\b(?:n[º°o.]?|numero|nº)\s*\.?\s*(?<![\d.])0*(\d{1,4})\s*/\s*(20\d\d)\b", re.I)
RE_NUMERO_SOLTO = re.compile(r"(?<![\d.])0*(\d{1,4})\s*/\s*(20\d\d)\b")
SIGLAS_IGNORADAS = {"MS", "SUS", "PDF", "ESG", "ODS", "FGTS", "BH", "MG", "CNPJ", "LGPD", "PET", "MP", "DO"}
RE_SIGLA = re.compile(r"\b([A-Z]{2,8})\b")


def numero_edital(texto):
    m = RE_NUMERO.search(texto or "") or RE_NUMERO_SOLTO.search(texto or "")
    return f"{int(m.group(1))}/{m.group(2)}" if m else None


def siglas_do_titulo(*textos):
    vistas = []
    for t in textos:
        for s in RE_SIGLA.findall(t or ""):
            if s not in SIGLAS_IGNORADAS and s not in vistas:
                vistas.append(s)
    return vistas


def chave_edital(titulo, orgao=None, numero=None, url=None):
    """Chave = sigla do órgão + número/ano. Só usa sigla que aparece em MAIÚSCULAS no título/órgão."""
    numero = numero or numero_edital(titulo) or numero_edital(url or "")
    if not numero:
        return None
    siglas = siglas_do_titulo(titulo, orgao)
    base = None
    # a sigla presente no link é a mais confiável (ex.: .../chamamento-publico-no-01-2026-seidigi)
    if url and siglas:
        tokens = [t.upper() for t in re.split(r"[-_/]", urlsplit(url).path.lower()) if t.isalpha()]
        em_comum = [s for s in siglas if s in tokens]
        base = em_comum[-1].lower() if em_comum else None
    if not base and siglas:
        base = siglas[0].lower()
    if base and base.startswith("cg") and len(base) > 4:   # CGFIIS e FIIS são o mesmo programa
        base = base[2:]
    if not base and orgao:
        base = normalizar_texto(orgao)[:30]
    return f"{base}|{numero}" if base else None


# ---------------------------------------------------------------------
# Download e leitura
# ---------------------------------------------------------------------
CABECALHOS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.6",
}


def baixar(url, timeout=30):
    """Baixa a página como um navegador comum; tenta 2 vezes se a conexão cair."""
    for tentativa in range(2):
        try:
            r = requests.get(url, headers=CABECALHOS, timeout=timeout, allow_redirects=True)
            r.raise_for_status()
            return r
        except (requests.ConnectionError, requests.Timeout):
            if tentativa == 1:
                raise


def texto_de_pdf(conteudo, max_paginas=15):
    from pypdf import PdfReader
    leitor = PdfReader(io.BytesIO(conteudo))
    partes = []
    for i, pagina in enumerate(leitor.pages):
        if i >= max_paginas:
            break
        try:
            partes.append(pagina.extract_text() or "")
        except Exception:
            continue
    return "\n".join(partes)


def texto_de_html(html, url_base):
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript", "form", "aside"]):
        tag.decompose()
    principal = soup.find("main") or soup.find(id="content") or soup.find(class_="documentFirstHeading") or soup.body or soup
    texto = principal.get_text("\n", strip=True)
    # links para documentos (PDF) do edital
    pdfs = []
    for a in soup.find_all("a", href=True):
        href = urljoin(url_base, a["href"])
        rotulo = a.get_text(" ", strip=True).lower()
        if href.lower().split("?")[0].endswith(".pdf") or "@@download" in href or "/file" in href.lower():
            prioridade = 0 if re.search(r"edital|chamamento|chamada|regulamento", rotulo + href.lower()) else 1
            pdfs.append((prioridade, href))
    pdfs.sort()
    return texto, [h for _, h in pdfs]


def ler_documento(url):
    """Retorna (texto, link_documento_pdf_ou_None). Lê a página e o PDF principal."""
    r = baixar(url)
    tipo = r.headers.get("content-type", "").lower()
    if "pdf" in tipo or url.lower().split("?")[0].endswith(".pdf"):
        return texto_de_pdf(r.content), url
    texto, pdfs = texto_de_html(r.text, r.url)
    link_pdf = None
    for pdf in pdfs[:2]:
        try:
            rp = baixar(pdf)
            if "pdf" in rp.headers.get("content-type", "").lower() or pdf.lower().endswith(".pdf"):
                texto += "\n\n=== DOCUMENTO DO EDITAL ===\n" + texto_de_pdf(rp.content)
                link_pdf = pdf
                break
        except Exception:
            continue
    return texto, link_pdf


# ---------------------------------------------------------------------
# Recorte: só os trechos que importam (prazo, valor, elegibilidade...)
# ---------------------------------------------------------------------
PALAVRAS_CHAVE = re.compile(
    r"prazo|inscri|submiss|cronograma|encerr|abertur|vig[eê]ncia|at[eé] o dia|"
    r"\d{1,2}/\d{1,2}/\d{2,4}|\d{1,2} de [a-zç]+ de \d{4}|"
    r"valor|r\$|recurso|or[cç]amento|teto|limite|"
    r"eleg[ií]ve|poder[aã]o participar|proponente|institui[cç][oõ]es|entidade|filantr[oó]p|sem fins lucrativos|"
    r"objeto|objetivo|finalidade|fluxo cont[ií]nuo|permanente",
    re.I,
)


def recortar_trechos(texto, limite=None):
    limite = limite or MAX_CARACTERES_TRECHOS
    linhas = [l.strip() for l in re.split(r"\n+", texto or "") if l.strip()]
    if not linhas:
        return ""
    escolhidas = set(range(min(8, len(linhas))))  # início: título e apresentação
    for i, l in enumerate(linhas):
        if PALAVRAS_CHAVE.search(l):
            escolhidas.update({i - 1, i, i + 1})
    saida, total = [], 0
    for i in sorted(x for x in escolhidas if 0 <= x < len(linhas)):
        l = linhas[i][:500]
        if total + len(l) > limite:
            break
        saida.append(l)
        total += len(l) + 1
    return "\n".join(saida)


def evidencia_confere(trecho, texto):
    """Só aceita um dado se o trecho citado existir de verdade no documento."""
    if not trecho:
        return False
    a = normalizar_texto(trecho)
    b = normalizar_texto(texto)
    if len(a) < 6:
        return False
    if a in b:
        return True
    # tolera pequenas diferenças: 80% das palavras do trecho em sequência
    palavras = a.split()
    janela = max(4, int(len(palavras) * 0.8))
    return any(" ".join(palavras[i:i + janela]) in b for i in range(0, len(palavras) - janela + 1))


# ---------------------------------------------------------------------
# IA com resposta JSON
# ---------------------------------------------------------------------
def extrair_json(texto):
    """Lê o primeiro objeto JSON da resposta e ignora qualquer texto depois dele."""
    t = (texto or "").strip()
    if "```" in t:
        for parte in t.split("```"):
            if "{" in parte:
                t = parte[4:] if parte.startswith("json") else parte
                break
    ini = t.find("{")
    if ini < 0:
        raise ValueError("Resposta da IA sem JSON")
    objeto, _ = json.JSONDecoder().raw_decode(t[ini:])
    return objeto


CUSTO = {"entrada": 0, "saida": 0, "chamadas": 0}


def perguntar(modelo, mensagem, sistema=None, max_tokens=1200, ferramentas=None, cache_sistema=False):
    params = {"model": modelo, "max_tokens": max_tokens, "messages": [{"role": "user", "content": mensagem}]}
    if sistema:
        params["system"] = (
            [{"type": "text", "text": sistema, "cache_control": {"type": "ephemeral"}}] if cache_sistema else sistema
        )
    if ferramentas:
        params["tools"] = ferramentas
    resp = ia().messages.create(**params)
    CUSTO["chamadas"] += 1
    CUSTO["entrada"] += getattr(resp.usage, "input_tokens", 0) or 0
    CUSTO["saida"] += getattr(resp.usage, "output_tokens", 0) or 0
    return "".join(getattr(b, "text", "") for b in resp.content)


def data_valida(valor):
    """Converte 'AAAA-MM-DD' em date; qualquer outra coisa vira None."""
    if not valor or not isinstance(valor, str):
        return None
    try:
        d = date.fromisoformat(valor[:10])
        return d if 2020 <= d.year <= date.today().year + 3 else None
    except ValueError:
        return None


def resumo_custo():
    return f"{CUSTO['chamadas']} chamadas de IA | {CUSTO['entrada']:,} tokens de entrada | {CUSTO['saida']:,} tokens de saída"
