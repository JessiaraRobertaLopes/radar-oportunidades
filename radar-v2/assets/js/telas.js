/* =====================================================================
   TELAS: Editais, Gestão, Arquivo e Dashboard + navegação por endereço
   (#inicio, #editais, #gestao, #arquivo, #dashboard)
   Usa os dados já carregados na tela inicial (App.editais()) e o
   painel de detalhe (Detalhe.abrir).
   ===================================================================== */
(function () {
  const esc = Radar.escapar;
  const I = Radar.ICONES;
  const TELAS = ['inicio', 'editais', 'gestao', 'arquivo', 'dashboard', 'busca-ia', 'noticias'];
  const ETAPAS = ['em_analise', 'inscrito', 'aprovado', 'reprovado', 'descartado'];
  const NOME_PRIORIDADE = { A: 'Alta', B: 'Boa', C: 'Média', D: 'Baixa' };
  let App = null;
  let telaAtual = 'inicio';
  let soMeus = false;
  let arquivoCache = null;

  const $ = id => document.getElementById(id);
  const ativo = e => e.situacao !== 'encerrado' && (e.dias === null || e.dias >= 0);
  const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const dataBR = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; };

  const plural = (n, palavra) => `${n} ${palavra}${n === 1 ? '' : 's'}`;

  function vazio(titulo, texto) {
    return `<div class="vazio"><div class="ic">${I.documento}</div><h3 class="titulo-m">${esc(titulo)}</h3><p>${esc(texto)}</p></div>`;
  }

  function abrirPorId(id, origem) {
    const e = App.editais().find(x => String(x.id) === String(id));
    if (e) Detalhe.abrir(e, origem);
  }

  // =================================================================
  // EDITAIS: lista completa com filtros
  // =================================================================
  function renderEditais() {
    const f = {
      termo: $('ed-busca').value,
      prioridade: $('ed-prioridade').value,
      situacao: $('ed-situacao').value,
      status: $('ed-status').value,
      ordem: $('ed-ordem').value
    };
    let l = App.editais().filter(ativo);
    if (f.prioridade) l = l.filter(e => e.prioridade === f.prioridade);
    if (f.situacao) l = l.filter(e => e.situacao === f.situacao);
    if (f.status) l = l.filter(e => e.status === f.status);
    l = Editais.filtrarTexto(l, f.termo);
    const ordens = {
      aderencia: (a, b) => b.aderencia - a.aderencia,
      prazo: (a, b) => (a.dias ?? 9999) - (b.dias ?? 9999),
      recentes: (a, b) => new Date(b.encontradoEm) - new Date(a.encontradoEm)
    };
    l.sort(ordens[f.ordem]);
    $('ed-contagem').textContent = `${l.length} edita${l.length === 1 ? 'l' : 'is'}`;
    $('ed-lista').innerHTML = l.length
      ? `<div class="lista-editais">${l.map(App.cardEdital).join('')}</div>`
      : vazio('Nenhum edital com esses filtros', 'Limpe algum filtro ou mude a busca.');
  }

  // =================================================================
  // GESTÃO: quadro por etapa
  // =================================================================
  async function renderGestao() {
    let nomes = new Map();
    try { nomes = new Map((await Editais.perfis()).map(p => [p.id, p.nome])); } catch (e) { console.error(e); }
    const meu = App.perfil().id;
    let l = App.editais().filter(e => e.status !== 'novo');
    if (soMeus) l = l.filter(e => e.responsavelId === meu);
    $('ge-quadro').innerHTML = ETAPAS.map(etapa => {
      const itens = l.filter(e => e.status === etapa).sort((a, b) => (a.dias ?? 9999) - (b.dias ?? 9999));
      return `
        <section class="coluna" aria-label="${esc(Editais.ROTULO_STATUS[etapa])}">
          <header><h3>${esc(Editais.ROTULO_STATUS[etapa])}</h3><span class="contador">${itens.length}</span></header>
          <div class="coluna-itens">
            ${itens.length ? itens.map(e => {
              const urgente = e.dias !== null && e.dias >= 0 && e.dias <= 7;
              const prazo = e.situacao === 'fluxo_continuo' ? 'Fluxo contínuo' : e.prazo ? dataBR(e.prazo) : 'Sem prazo';
              return `
                <button class="mini-card cartao-interativo" type="button" data-id="${esc(e.id)}">
                  <div class="mini-topo"><span class="edital-prioridade p-${esc(e.prioridade)} mini"><strong>${esc(e.prioridade)}</strong></span>
                    <span class="prazo ${urgente ? 'urgente' : ''}">${urgente ? I.relogio : I.calendario}${esc(prazo)}</span></div>
                  <strong class="mini-titulo">${esc(e.titulo)}</strong>
                  <span class="texto-3">${e.responsavelId ? esc(nomes.get(e.responsavelId) || 'Responsável') : 'Sem responsável'}${e.valorEstimado ? ' · ' + esc(moeda(e.valorEstimado)) : ''}</span>
                </button>`;
            }).join('') : '<p class="texto-3 coluna-vazia">Nenhum edital</p>'}
          </div>
        </section>`;
    }).join('');
  }

  // =================================================================
  // ARQUIVO: encerrados e vencidos
  // =================================================================
  async function renderArquivo() {
    const caixa = $('ar-lista');
    if (!arquivoCache) {
      caixa.innerHTML = '<div class="lista-editais"><div class="esqueleto"></div><div class="esqueleto"></div></div>';
      try { arquivoCache = await Editais.arquivo(); }
      catch (e) {
        console.error(e);
        caixa.innerHTML = `<div class="alerta alerta-erro">${I.alerta}<span>Não foi possível carregar o arquivo agora.</span></div>`;
        return;
      }
    }
    // junta os encerrados do banco com os que venceram depois da última leitura
    const vencidos = App.editais().filter(e => !ativo(e)).map(e => ({ id: e.id, titulo: e.titulo, url: e.url, orgao: e.orgao || e.fonte, prazo: e.prazo, motivo: 'Prazo encerrado' }));
    const ids = new Set(vencidos.map(v => String(v.id)));
    let l = vencidos.concat(arquivoCache.filter(a => !ids.has(String(a.id))));
    const termo = ($('ar-busca').value || '').trim().toLowerCase();
    if (termo) l = l.filter(a => (a.titulo + ' ' + (a.orgao || '')).toLowerCase().includes(termo));
    l.sort((a, b) => String(b.prazo || '').localeCompare(String(a.prazo || '')));
    $('ar-contagem').textContent = `${l.length} edita${l.length === 1 ? 'l' : 'is'} no arquivo`;
    caixa.innerHTML = l.length ? `
      <div class="tabela-arquivo" role="table" aria-label="Editais arquivados">
        <div class="linha cabeca" role="row"><span role="columnheader">Edital</span><span role="columnheader">Prazo</span><span role="columnheader">Motivo</span></div>
        ${l.map(a => `
          <div class="linha" role="row">
            <span role="cell"><strong>${/^https?:\/\//i.test(a.url || '') ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.titulo)}</a>` : esc(a.titulo)}</strong>
              <small class="texto-3">${esc(a.orgao || '')}</small></span>
            <span role="cell">${esc(dataBR(a.prazo))}</span>
            <span role="cell"><span class="selo selo-neutro">${esc(a.motivo)}</span></span>
          </div>`).join('')}
      </div>` : vazio('Arquivo vazio', 'Editais encerrados aparecem aqui para consulta.');
  }

  // =================================================================
  // DASHBOARD
  // =================================================================
  function barras(itens) {
    const max = Math.max(1, ...itens.map(i => i.valor));
    return `<div class="barras" role="list">${itens.map(i => `
      <div class="barra-linha" role="listitem" title="${esc(i.rotulo)}: ${i.valor}">
        <span class="barra-rotulo">${esc(i.rotulo)}</span>
        <span class="barra-trilho"><i style="width:${(i.valor / max) * 100}%"></i></span>
        <span class="barra-valor">${i.valor}</span>
      </div>`).join('')}</div>`;
  }

  function kpi(rotulo, valor, apoio, icone) {
    return `<div class="kpi cartao"><span class="kpi-rotulo">${icone ? `<span class="kpi-ic">${icone}</span>` : ''}${esc(rotulo)}</span>
      <strong class="kpi-valor">${esc(valor)}</strong>${apoio ? `<span class="texto-3">${esc(apoio)}</span>` : ''}</div>`;
  }

  function renderDashboard() {
    const todos = App.editais();
    const ativos = todos.filter(ativo);
    const emGestao = todos.filter(e => e.status !== 'novo');
    const vence7 = ativos.filter(e => e.dias !== null && e.dias <= 7);
    const potencial = emGestao.filter(e => ['em_analise', 'inscrito', 'aprovado'].includes(e.status)).reduce((s, e) => s + (Number(e.valorEstimado) || 0), 0);
    const aprovado = emGestao.filter(e => e.status === 'aprovado').reduce((s, e) => s + (Number(e.valorEstimado) || 0), 0);

    $('db-kpis').innerHTML = [
      kpi('Oportunidades ativas', ativos.length, `${ativos.filter(e => e.situacao === 'fluxo_continuo').length} de fluxo contínuo`, I.documento),
      kpi('Prioridade A', ativos.filter(e => e.prioridade === 'A').length, 'aderência de 80% ou mais', I.alerta2),
      kpi('Vencem em 7 dias', vence7.length, vence7.length ? 'atenção aos prazos' : 'nenhum prazo apertado', I.relogio),
      kpi('Em gestão pela equipe', emGestao.length, `${plural(emGestao.filter(e => e.status === 'inscrito').length, 'inscrito')} · ${plural(emGestao.filter(e => e.status === 'aprovado').length, 'aprovado')}`, I.pipeline),
      kpi('Valor em potencial', moeda(potencial), 'em análise, inscritos e aprovados', I.grafico),
      kpi('Valor aprovado', moeda(aprovado), 'editais com status aprovado', I.ok)
    ].join('');

    $('db-etapas').innerHTML = barras(ETAPAS.map(s => ({ rotulo: Editais.ROTULO_STATUS[s], valor: todos.filter(e => e.status === s).length })));
    $('db-prioridades').innerHTML = barras(['A', 'B', 'C', 'D'].map(p => ({ rotulo: `${p} · ${NOME_PRIORIDADE[p]}`, valor: ativos.filter(e => e.prioridade === p).length })));

    const proximos = ativos.filter(e => e.dias !== null).sort((a, b) => a.dias - b.dias).slice(0, 6);
    $('db-prazos').innerHTML = proximos.length ? `<ul class="prazos-lista">${proximos.map(e => `
      <li><button type="button" class="prazo-item" data-id="${esc(e.id)}">
        <span class="edital-prioridade p-${esc(e.prioridade)} mini"><strong>${esc(e.prioridade)}</strong></span>
        <span class="prazo-titulo">${esc(e.titulo)}</span>
        <span class="prazo ${e.dias <= 7 ? 'urgente' : ''}">${e.dias === 0 ? 'Hoje' : `${e.dias} dia${e.dias > 1 ? 's' : ''}`}</span>
      </button></li>`).join('')}</ul>` : '<p class="texto-3">Nenhum edital com prazo definido.</p>';

    const fontes = {};
    ativos.forEach(e => { const k = (e.orgao || e.fonte || 'Outros').replace(/^Web\s*[—|-]\s*/i, '').split(/[|/]/)[0].trim(); fontes[k] = (fontes[k] || 0) + 1; });
    $('db-fontes').innerHTML = barras(Object.entries(fontes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([rotulo, valor]) => ({ rotulo, valor })));
  }


  // =================================================================
  // BUSCA COM IA (Edge Function "busca-ia")
  // =================================================================
  const EXEMPLOS = [
    'Equipamentos para UTI Neonatal com novos leitos para atendimento SUS',
    'Pesquisa clínica em oncologia pediátrica',
    'Inteligência artificial para triagem e gestão de leitos',
    'Reforma e ampliação do bloco cirúrgico de alta complexidade',
    'Programa de inclusão e atendimento em Libras para a comunidade surda'
  ];

  function htmlResultados(r) {
    const base = r.da_base || [], web = r.da_web || [];
    let html = `<section class="secao-resultado"><h2 class="titulo-m">No Radar <span class="contador">${base.length}</span></h2>`;
    html += base.length ? `<div class="lista-editais">${base.map(b => `
      <button class="resultado cartao-interativo" type="button" data-id="${esc(b.id)}">
        <span class="edital-prioridade p-${esc(b.tier || 'D')} mini"><strong>${esc(b.tier || '–')}</strong></span>
        <span class="resultado-corpo"><strong>${esc(b.titulo)}</strong>
          <span class="texto-3">${esc(b.orgao || '')}${b.prazo ? ' · prazo ' + esc(dataBR(b.prazo)) : ''}</span>
          <span class="resultado-just">${esc(b.justificativa || '')}</span></span>
        <span class="selo">${esc(b.aderencia)}% para este projeto</span>
      </button>`).join('')}</div>` : '<p class="texto-3">Nenhum edital da base do Radar combina com este projeto.</p>';
    html += '</section>';
    if (r.incluiu_web) {
      html += `<section class="secao-resultado"><h2 class="titulo-m">Na web <span class="contador">${web.length}</span></h2>
        <p class="texto-3">Encontrados agora pela IA na internet. Ainda não foram lidos nem verificados pelo robô: confira prazo e regras no site.</p>`;
      if (r.erro_web) html += `<div class="alerta alerta-info">${I.alerta}<span>${esc(r.erro_web)}</span></div>`;
      html += web.length ? `<div class="lista-editais">${web.map(w => `
        <a class="resultado cartao-interativo" href="${esc(w.url)}" target="_blank" rel="noopener">
          <span class="kpi-ic">${I.lupa}</span>
          <span class="resultado-corpo"><strong>${esc(w.titulo)}</strong>
            <span class="texto-3">${esc(w.orgao || '')}${w.prazo ? ' · prazo ' + esc(dataBR(w.prazo)) : ''}</span>
            <span class="resultado-just">${esc(w.justificativa || '')}</span></span>
          <span class="selo selo-neutro">Abrir site</span>
        </a>`).join('')}</div>` : (r.erro_web ? '' : '<p class="texto-3">Nada encontrado na web desta vez.</p>');
      html += '</section>';
    }
    return html;
  }

  async function carregarHistorico() {
    const caixa = $('ia-historico');
    const { data, error } = await Radar.sb.from('buscas_ia')
      .select('id, pergunta, criado_em, total_resultados, resultados')
      .eq('usuario_id', App.perfil().id).order('criado_em', { ascending: false }).limit(10);
    if (error) { caixa.innerHTML = '<p class="texto-3">Não foi possível carregar o histórico.</p>'; return; }
    historico = data || [];
    caixa.innerHTML = historico.length ? historico.map(h => `
      <button class="historico-item" type="button" data-hist="${esc(h.id)}">
        <span>${esc(h.pergunta)}</span>
        <small class="texto-3">${esc(new Date(h.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))} · ${h.total_resultados ?? 0} resultado${h.total_resultados === 1 ? '' : 's'}</small>
      </button>`).join('') : '<p class="texto-3">Suas buscas aparecem aqui.</p>';
  }
  let historico = [];

  async function buscarIA(ev) {
    ev.preventDefault();
    const pergunta = $('ia-pergunta').value.trim();
    const msg = $('ia-msg');
    if (pergunta.length < 10) { msg.innerHTML = `<div class="alerta alerta-erro">${I.alerta}<span>Descreva o projeto com pelo menos 10 caracteres.</span></div>`; return; }
    const web = $('ia-web').checked;
    const btn = $('ia-buscar');
    btn.disabled = true; btn.classList.add('carregando'); btn.textContent = web ? 'Buscando na base e na web' : 'Buscando';
    msg.innerHTML = '';
    $('ia-resultados').innerHTML = '<div class="lista-editais"><div class="esqueleto"></div><div class="esqueleto"></div></div>';
    try {
      const { data, error } = await Radar.sb.functions.invoke('busca-ia', { body: { pergunta, incluir_web: web } });
      if (error) {
        let texto = 'Não foi possível concluir a busca agora.';
        try { const det = await error.context.json(); if (det && det.erro) texto = det.erro; } catch (e) { /* sem detalhe */ }
        throw new Error(texto);
      }
      $('ia-resultados').innerHTML = htmlResultados(data);
      carregarHistorico();
    } catch (err) {
      console.error(err);
      $('ia-resultados').innerHTML = '';
      msg.innerHTML = `<div class="alerta alerta-erro">${I.alerta}<span>${esc(err.message)}</span></div>`;
    } finally {
      btn.disabled = false; btn.classList.remove('carregando'); btn.textContent = 'Buscar editais';
    }
  }

  function iniciarBusca() {
    $('ia-exemplos').innerHTML = EXEMPLOS.map(t => `<button class="selo selo-neutro chip" type="button">${esc(t)}</button>`).join('');
    $('ia-exemplos').addEventListener('click', ev => { const c = ev.target.closest('.chip'); if (c) { $('ia-pergunta').value = c.textContent; $('ia-pergunta').focus(); } });
    $('ia-form').addEventListener('submit', buscarIA);
    $('ia-resultados').addEventListener('click', ev => { const a = ev.target.closest('button[data-id]'); if (a) abrirPorId(a.dataset.id, a); });
    $('ia-historico').addEventListener('click', ev => {
      const h = ev.target.closest('[data-hist]'); if (!h) return;
      const item = historico.find(x => String(x.id) === h.dataset.hist);
      if (item) { $('ia-pergunta').value = item.pergunta; $('ia-resultados').innerHTML = htmlResultados(item.resultados || {}); }
    });
  }


  // =================================================================
  // NOTÍCIAS PRÉ-EDITAL (tabela "noticias", gravada pelo robô)
  // =================================================================
  const ROTULO_TIPO = { pre_edital: 'Pré-edital', edital_aberto: 'Edital aberto', programa: 'Programa' };
  let noticias = null, filtroTipo = 'todas';

  function quando(iso) {
    if (!iso) return '';
    const d = new Date(iso), dias = Math.floor((Date.now() - d) / 86400000);
    if (dias <= 0) return 'hoje';
    if (dias === 1) return 'ontem';
    if (dias < 7) return `há ${dias} dias`;
    return d.toLocaleDateString('pt-BR');
  }

  function renderNoticias() {
    const caixa = $('nt-lista');
    if (!noticias) { caixa.innerHTML = '<div class="esqueleto"></div><div class="esqueleto"></div>'; return; }
    const lista = noticias.filter(n => filtroTipo === 'todas' || n.tipo === filtroTipo);
    document.querySelectorAll('#nt-filtros .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.tipo === filtroTipo)));
    $('nt-contagem').textContent = `${lista.length} notícia${lista.length === 1 ? '' : 's'}`;
    caixa.innerHTML = lista.length ? lista.map(n => `
      <a class="resultado cartao-interativo" href="${esc(n.url)}" target="_blank" rel="noopener">
        <span class="kpi-ic">${I.sino}</span>
        <span class="resultado-corpo"><strong>${esc(n.titulo)}</strong>
          <span class="texto-3">${esc(n.fonte || 'Veículo não informado')} · ${esc(quando(n.publicado_em || n.criado_em))}${n.orgao ? ' · ' + esc(n.orgao) : ''}${n.prazo ? ' · <strong>inscrições até ' + esc(dataBR(n.prazo)) + '</strong>' : ''}</span>
          ${n.por_que ? `<span class="resultado-just">${esc(n.por_que)}</span>` : ''}</span>
        <span class="selo ${n.tipo === 'edital_aberto' ? '' : 'selo-neutro'}">${esc(ROTULO_TIPO[n.tipo] || n.tipo)}</span>
      </a>`).join('') : `<div class="cartao vazio-nt"><strong>Nenhuma notícia por aqui ainda</strong>
        <p class="texto-3">O robô de notícias lê o Google Notícias e guarda só o que anuncia edital, chamamento ou programa com recursos para a Santa Casa BH.</p></div>`;
  }

  async function carregarNoticias() {
    const { data, error } = await Radar.sb.from('noticias')
      .select('id, titulo, url, fonte, publicado_em, criado_em, tipo, relevancia, orgao, por_que, prazo')
      .order('publicado_em', { ascending: false, nullsFirst: false }).limit(150);
    if (error) { console.error(error); $('nt-lista').innerHTML = `<div class="alerta alerta-erro">${I.alerta}<span>Não foi possível carregar as notícias.</span></div>`; return; }
    const hojeISO = new Date().toLocaleDateString('sv-SE');
    noticias = (data || []).filter(n => !n.prazo || n.prazo >= hojeISO); // esconde as que já venceram
    renderNoticias();
  }

  function iniciarNoticias() {
    $('nt-filtros').addEventListener('click', ev => {
      const c = ev.target.closest('.chip'); if (!c) return;
      filtroTipo = c.dataset.tipo; renderNoticias();
    });
  }

  // =================================================================
  // Navegação
  // =================================================================
  function mostrar(tela) {
    if (!TELAS.includes(tela)) tela = 'inicio';
    telaAtual = tela;
    document.querySelectorAll('[data-tela]').forEach(s => s.classList.toggle('oculto', s.dataset.tela !== tela));
    document.querySelectorAll('.nav-item[data-destino]').forEach(a => {
      if (a.dataset.destino === tela) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const titulos = { inicio: 'Início', editais: 'Editais', gestao: 'Gestão', arquivo: 'Arquivo', dashboard: 'Dashboard', 'busca-ia': 'Busca com IA', noticias: 'Notícias' };
    document.title = `${titulos[tela]} | Radar de Oportunidades`;
    atualizar();
    window.scrollTo(0, 0);
  }

  function atualizar() {
    if (telaAtual === 'editais') renderEditais();
    if (telaAtual === 'gestao') renderGestao();
    if (telaAtual === 'arquivo') renderArquivo();
    if (telaAtual === 'dashboard') renderDashboard();
    if (telaAtual === 'busca-ia') carregarHistorico();
    if (telaAtual === 'noticias') carregarNoticias();
  }

  function iniciar(app) {
    App = app;
    ['ed-busca', 'ed-prioridade', 'ed-situacao', 'ed-status', 'ed-ordem'].forEach(id =>
      $(id).addEventListener(id === 'ed-busca' ? 'input' : 'change', renderEditais));
    $('ar-busca').addEventListener('input', renderArquivo);
    document.querySelectorAll('#ge-filtro .aba').forEach(b => b.addEventListener('click', () => {
      soMeus = b.dataset.meus === 'sim';
      document.querySelectorAll('#ge-filtro .aba').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      renderGestao();
    }));
    // cliques que abrem o detalhe
    ['ed-lista', 'ge-quadro', 'db-prazos'].forEach(id => $(id).addEventListener('click', ev => {
      const alvo = ev.target.closest('[data-id]');
      if (alvo) abrirPorId(alvo.dataset.id, alvo);
    }));
    iniciarBusca();
    iniciarNoticias();
    window.addEventListener('hashchange', () => mostrar(location.hash.slice(1)));
    mostrar(location.hash.slice(1) || 'inicio');
  }

  window.Telas = { iniciar, atualizar, mostrar };
})();
