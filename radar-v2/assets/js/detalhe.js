/* =====================================================================
   PAINEL DE DETALHE DO EDITAL + GESTÃO DA EQUIPE
   Abre pela lateral ao clicar num card. Mostra os dados lidos do
   documento (com evidências), a nota e permite gerir o edital:
   status, responsável, prazo interno, valor estimado e anotações.
   ===================================================================== */
(function () {
  const esc = Radar.escapar;
  const I = Radar.ICONES;
  let perfilAtual = null;
  let aoSalvar = () => {};
  let editalAtual = null;
  let ultimoFoco = null;

  const ROTULO_EVIDENCIA = {
    prazo_inscricao: 'Prazo de inscrição', data_abertura: 'Abertura',
    valor: 'Valor', publico_elegivel: 'Quem pode participar', situacao: 'Situação'
  };
  const NOME_PRIORIDADE = { A: 'Alta', B: 'Boa', C: 'Média', D: 'Baixa' };

  function dataBR(iso) {
    if (!iso) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : new Date(iso).toLocaleDateString('pt-BR');
  }

  function textoPrazo(e) {
    if (e.situacao === 'fluxo_continuo') return 'Fluxo contínuo';
    if (!e.prazo) return 'Não informado';
    const base = dataBR(e.prazo);
    if (e.dias === null) return base;
    if (e.dias < 0) return `${base} (encerrado)`;
    if (e.dias === 0) return `${base} (vence hoje)`;
    return `${base} (faltam ${e.dias} dia${e.dias > 1 ? 's' : ''})`;
  }

  // ---------- Estrutura (criada uma vez) ----------
  function montar() {
    const fundo = document.createElement('div');
    fundo.className = 'gaveta-fundo oculto';
    fundo.id = 'gaveta-fundo';
    const gaveta = document.createElement('aside');
    gaveta.className = 'gaveta';
    gaveta.id = 'gaveta';
    gaveta.setAttribute('role', 'dialog');
    gaveta.setAttribute('aria-modal', 'true');
    gaveta.setAttribute('aria-labelledby', 'g-titulo');
    gaveta.setAttribute('aria-hidden', 'true');
    document.body.append(fundo, gaveta);
    fundo.addEventListener('click', fechar);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && gaveta.classList.contains('aberta')) fechar(); });
  }

  function fechar() {
    document.getElementById('gaveta').classList.remove('aberta');
    document.getElementById('gaveta').setAttribute('aria-hidden', 'true');
    document.getElementById('gaveta-fundo').classList.add('oculto');
    document.body.style.overflow = '';
    editalAtual = null;
    if (ultimoFoco) ultimoFoco.focus();
  }

  // ---------- Conteúdo ----------
  function fato(rotulo, valor, destaque) {
    return `<div class="fato"><span>${esc(rotulo)}</span><strong class="${destaque || ''}">${esc(valor || 'Não informado')}</strong></div>`;
  }

  function htmlEvidencias(e) {
    const ev = e.evidencias && typeof e.evidencias === 'object' ? e.evidencias : {};
    const itens = Object.entries(ev).filter(([, v]) => v);
    if (!itens.length) return '';
    return `
      <details class="g-secao evidencias">
        <summary>Trechos do documento que comprovam os dados (${itens.length})</summary>
        ${itens.map(([k, v]) => `<blockquote><span>${esc(ROTULO_EVIDENCIA[k] || k)}</span>${esc(v)}</blockquote>`).join('')}
      </details>`;
  }

  async function htmlGestao(e) {
    let opcoesResp = '<option value="">Sem responsável</option>';
    try {
      const lista = await Editais.perfis();
      opcoesResp += lista.map(p => `<option value="${esc(p.id)}" ${p.id === e.responsavelId ? 'selected' : ''}>${esc(p.nome)}</option>`).join('');
    } catch (err) { console.error(err); }
    const opcoesStatus = Object.entries(Editais.ROTULO_STATUS)
      .map(([v, r]) => `<option value="${v}" ${v === e.status ? 'selected' : ''}>${esc(r)}</option>`).join('');
    return `
      <section class="g-secao">
        <h3>Gestão da equipe</h3>
        <form id="g-form" class="g-form" novalidate>
          <div class="campo"><label for="g-status">Status</label>
            <select class="entrada" id="g-status">${opcoesStatus}</select></div>
          <div class="campo"><label for="g-resp">Responsável</label>
            <select class="entrada" id="g-resp">${opcoesResp}</select></div>
          <div class="campo"><label for="g-prazo">Prazo interno</label>
            <input class="entrada" id="g-prazo" type="date" value="${esc(e.prazoInterno || '')}"></div>
          <div class="campo"><label for="g-valor">Valor estimado (R$)</label>
            <input class="entrada" id="g-valor" type="number" min="0" step="0.01" inputmode="decimal" value="${e.valorEstimado ?? ''}" placeholder="0,00"></div>
          <div class="g-form-acoes">
            <span id="g-msg" class="texto-3" role="status" aria-live="polite"></span>
            <button class="btn btn-primario" type="submit" id="g-salvar">Salvar gestão</button>
          </div>
        </form>
      </section>`;
  }

  function htmlAnotacoes() {
    return `
      <section class="g-secao">
        <h3>Anotações da equipe</h3>
        <form id="a-form" class="a-form" novalidate>
          <label class="sr" for="a-texto">Nova anotação</label>
          <textarea class="entrada" id="a-texto" rows="3" maxlength="4000" placeholder="Ex.: Liguei no órgão, o prazo pode ser prorrogado."></textarea>
          <div class="g-form-acoes">
            <span id="a-msg" class="texto-3" role="status" aria-live="polite"></span>
            <button class="btn btn-secundario" type="submit" id="a-enviar">Adicionar anotação</button>
          </div>
        </form>
        <div id="a-lista" class="a-lista"><p class="texto-3">Carregando anotações</p></div>
      </section>`;
  }

  async function renderAnotacoes(e) {
    const caixa = document.getElementById('a-lista');
    if (!caixa) return;
    try {
      const itens = await Editais.anotacoes(e.id);
      if (editalAtual !== e) return;
      if (!itens.length) { caixa.innerHTML = '<p class="texto-3">Nenhuma anotação ainda.</p>'; return; }
      caixa.innerHTML = itens.map(a => {
        const podeExcluir = a.autor_id === perfilAtual.id || perfilAtual.papel === 'admin';
        const quando = new Date(a.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
        return `
          <article class="anotacao">
            <header><strong>${esc(a.perfis ? a.perfis.nome : 'Usuário')}</strong><span class="texto-3">${esc(quando)}</span>
              ${podeExcluir ? `<button class="btn btn-fantasma a-excluir" type="button" data-id="${esc(a.id)}">Excluir</button>` : ''}</header>
            <p>${esc(a.texto)}</p>
          </article>`;
      }).join('');
    } catch (err) {
      console.error(err);
      caixa.innerHTML = '<p class="texto-3">Não foi possível carregar as anotações.</p>';
    }
  }

  async function abrir(e, origem) {
    editalAtual = e;
    ultimoFoco = origem || document.activeElement;
    const gaveta = document.getElementById('gaveta');
    const linkEdital = /^https?:\/\//i.test(e.url || '') ? e.url : null;
    const linkDoc = /^https?:\/\//i.test(e.linkDocumento || '') ? e.linkDocumento : null;
    const urgente = e.dias !== null && e.dias >= 0 && e.dias <= 7;
    const conferir = (e.resumo || '').startsWith('Página não pôde ser lida');
    const resumo = conferir ? null : (e.resumo || e.descricao);

    gaveta.innerHTML = `
      <header class="g-topo">
        <div class="g-selos">
          <span class="edital-prioridade p-${esc(e.prioridade)} mini"><strong>${esc(e.prioridade)}</strong></span>
          <span class="selo ${e.situacao === 'aberto' ? '' : 'selo-neutro'}">${esc(Editais.ROTULO_SITUACAO[e.situacao] || e.situacao)}</span>
          ${conferir ? '<span class="selo selo-neutro">Conferir no site</span>' : ''}
        </div>
        <button class="btn-icone" type="button" id="g-fechar" aria-label="Fechar">${I.fechar}</button>
      </header>
      <div class="g-corpo">
        <h2 id="g-titulo" class="titulo-l">${esc(e.titulo)}</h2>
        <p class="g-orgao">${I.predio}${esc(e.orgao || e.fonte)}${e.numero ? ` · Nº ${esc(e.numero)}` : ''}</p>

        <div class="g-acoes">
          ${linkEdital ? `<a class="btn btn-primario" href="${esc(linkEdital)}" target="_blank" rel="noopener">Abrir edital</a>` : ''}
          ${linkDoc && linkDoc !== linkEdital ? `<a class="btn btn-secundario" href="${esc(linkDoc)}" target="_blank" rel="noopener">${I.documento}Documento</a>` : ''}
        </div>

        <div class="fatos">
          ${fato('Prazo de inscrição', textoPrazo(e), urgente ? 'urgente' : '')}
          ${fato('Aceita filantrópico', Editais.ROTULO_FILANTROPICO[e.aceitaFilantropico])}
          ${fato('Valor', e.valor)}
          ${fato('Aderência', `${e.aderencia}% · Prioridade ${e.prioridade} (${NOME_PRIORIDADE[e.prioridade] || ''})`)}
          ${fato('Abertura', dataBR(e.dataAbertura))}
          ${fato('Encontrado em', dataBR(e.encontradoEm))}
        </div>

        ${conferir ? `<div class="alerta alerta-info">${I.alerta}<span>O robô não conseguiu ler esta página automaticamente. Confira prazo e regras direto no site do edital.</span></div>` : ''}
        ${resumo ? `<section class="g-secao"><h3>Resumo</h3><p>${esc(resumo)}</p></section>` : ''}
        ${e.publicoElegivel ? `<section class="g-secao"><h3>Quem pode participar</h3><p>${esc(e.publicoElegivel)}</p></section>` : ''}
        ${e.justificativa ? `<section class="g-secao"><h3>Por que esta nota</h3><p>${esc(e.justificativa)}</p>
          ${e.areas.length ? `<div class="edital-tags">${e.areas.map(a => `<span class="selo selo-neutro">${esc(a)}</span>`).join('')}</div>` : ''}</section>` : ''}
        ${htmlEvidencias(e)}
        <div id="g-gestao"><p class="texto-3">Carregando gestão</p></div>
        ${htmlAnotacoes()}
      </div>`;

    document.getElementById('gaveta-fundo').classList.remove('oculto');
    gaveta.classList.add('aberta');
    gaveta.setAttribute('aria-hidden', 'false');
    gaveta.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    document.getElementById('g-fechar').addEventListener('click', fechar);
    document.getElementById('g-fechar').focus();

    // Gestão
    document.getElementById('g-gestao').innerHTML = await htmlGestao(e);
    if (editalAtual !== e) return;
    document.getElementById('g-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      const btn = document.getElementById('g-salvar');
      const msg = document.getElementById('g-msg');
      const campos = {
        status: document.getElementById('g-status').value,
        responsavelId: document.getElementById('g-resp').value,
        prazoInterno: document.getElementById('g-prazo').value,
        valorEstimado: document.getElementById('g-valor').value
      };
      btn.disabled = true; msg.textContent = 'Salvando';
      try {
        await Editais.salvarGestao(e.id, campos);
        Object.assign(e, {
          status: campos.status, responsavelId: campos.responsavelId || null,
          prazoInterno: campos.prazoInterno || null,
          valorEstimado: campos.valorEstimado === '' ? null : Number(campos.valorEstimado)
        });
        msg.textContent = 'Gestão salva.';
        aoSalvar(e);
      } catch (err) {
        console.error(err);
        msg.textContent = 'Não foi possível salvar. Tente de novo.';
      } finally { btn.disabled = false; }
    });

    // Anotações
    document.getElementById('a-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      const campo = document.getElementById('a-texto');
      const msg = document.getElementById('a-msg');
      const texto = campo.value.trim();
      if (!texto) { msg.textContent = 'Escreva a anotação antes de adicionar.'; return; }
      const btn = document.getElementById('a-enviar');
      btn.disabled = true; msg.textContent = 'Salvando';
      try {
        await Editais.adicionarAnotacao(e.id, perfilAtual.id, texto);
        campo.value = ''; msg.textContent = '';
        await renderAnotacoes(e);
      } catch (err) {
        console.error(err);
        msg.textContent = 'Não foi possível salvar a anotação.';
      } finally { btn.disabled = false; }
    });
    document.getElementById('a-lista').addEventListener('click', async ev => {
      const b = ev.target.closest('.a-excluir');
      if (!b || !confirm('Excluir esta anotação?')) return;
      try { await Editais.excluirAnotacao(b.dataset.id); await renderAnotacoes(e); }
      catch (err) { console.error(err); alert('Não foi possível excluir a anotação.'); }
    });
    renderAnotacoes(e);
  }

  window.Detalhe = {
    iniciar({ perfil, quandoSalvar }) { perfilAtual = perfil; aoSalvar = quandoSalvar || aoSalvar; montar(); },
    abrir,
    fechar
  };
})();
