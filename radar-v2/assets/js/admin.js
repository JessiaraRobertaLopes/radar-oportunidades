/* =====================================================================
   ADMINISTRAÇÃO (só perfil admin)
   - Usuários: ativar/desativar acesso, trocar papel, uso da IA no mês
   - Configurações do robô: sites fixos, termos de busca na web e de notícias
   As regras de verdade ficam no banco (RLS + gatilhos); a tela só ajuda.
   ===================================================================== */
(function () {
  const { sb, escapar: esc, ICONES: I } = window.Radar;
  const $ = id => document.getElementById(id);
  const PAPEIS = { captacao: 'Captação', projetos: 'Setor de Projetos', admin: 'Administração' };
  const CUSTO_TERMO_WEB = 0.18;   // US$ por termo a cada execução (estimativa)
  const LIMITE_WEB = 10;
  let perfil = null;

  const dataHora = iso => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'Nunca';
  const usd = v => 'US$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const erroBanco = (err, padrao) => (err && /Limite|não pode|permitido|duplicate|unique/i.test(err.message || ''))
    ? (/duplicate|unique/i.test(err.message) ? 'Esse item já está cadastrado.' : err.message) : padrao;

  function aviso(id, texto, tipo) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = texto ? `<div class="alerta ${tipo === 'ok' ? 'alerta-info' : 'alerta-erro'}">${tipo === 'ok' ? I.ok : I.alerta}<span>${esc(texto)}</span></div>` : '';
  }

  // =================================================================
  // USUÁRIOS
  // =================================================================
  function custoBusca(b) {
    const web = /sonnet/i.test(b.modelo || '');
    const ent = Number(b.tokens_entrada) || 0, sai = Number(b.tokens_saida) || 0;
    // Haiku: US$1 / US$5 por milhão; com web (Sonnet): US$3 / US$15 + até 3 buscas de US$0,01
    return web ? (ent * 3 + sai * 15) / 1e6 + 0.03 : (ent * 1 + sai * 5) / 1e6;
  }

  async function renderUsuarios() {
    const caixa = $('us-lista');
    caixa.innerHTML = '<div class="esqueleto"></div>';
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
    const [us, bus] = await Promise.all([
      sb.rpc('admin_usuarios'),
      sb.from('buscas_ia').select('usuario_id, modelo, tokens_entrada, tokens_saida').gte('criado_em', inicioMes.toISOString())
    ]);
    if (us.error) { console.error(us.error); caixa.innerHTML = ''; aviso('us-msg', 'Não foi possível carregar os usuários.'); return; }
    const lista = us.data || [];
    const buscas = bus.data || [];
    const porPessoa = new Map();
    buscas.forEach(b => porPessoa.set(b.usuario_id, (porPessoa.get(b.usuario_id) || 0) + 1));
    const ativos = lista.filter(u => u.ativo);
    const aguardando = lista.filter(u => !u.ativo && !u.liberado_em);
    const conta = p => ativos.filter(u => u.papel === p).length;

    $('us-kpis').innerHTML = [
      ['Aguardando liberação', aguardando.length, aguardando.length ? 'confira a lista abaixo' : 'nenhum cadastro novo', I.relogio],
      ['Pessoas com acesso', ativos.length, `${lista.length - ativos.length - aguardando.length} desativada${lista.length - ativos.length - aguardando.length === 1 ? '' : 's'}`, I.usuarios],
      ['Por papel', `${conta('captacao')} · ${conta('projetos')} · ${conta('admin')}`, 'Captação · Projetos · Admin', I.equipe],
      ['Buscas com IA no mês', buscas.length, `${buscas.filter(b => /sonnet/i.test(b.modelo || '')).length} com busca na web`, I.ia],
      ['Custo das buscas no mês', usd(buscas.reduce((s, b) => s + custoBusca(b), 0)), 'estimado; o robô aparece no GitHub', I.grafico]
    ].map(([r, v, a, ic]) => `<div class="kpi cartao"><span class="kpi-rotulo"><span class="kpi-ic">${ic}</span>${esc(r)}</span>
      <strong class="kpi-valor">${esc(v)}</strong><span class="texto-3">${esc(a)}</span></div>`).join('');

    caixa.innerHTML = `
      <div class="tabela-arquivo tabela-usuarios" role="table" aria-label="Usuários">
        <div class="linha cabeca" role="row"><span role="columnheader">Pessoa</span><span role="columnheader">Papel</span>
          <span role="columnheader">Último acesso</span><span role="columnheader">Buscas IA no mês</span><span role="columnheader">Acesso</span></div>
        ${lista.map(u => {
          const eu = u.id === perfil.id;
          const novo = !u.ativo && !u.liberado_em;
          return `
          <div class="linha ${u.ativo || novo ? '' : 'inativo'}" role="row" data-usuario="${esc(u.id)}">
            <span role="cell"><strong>${esc(u.nome)}${eu ? ' <span class="selo selo-neutro">você</span>' : ''}${novo ? ' <span class="selo">Aguardando liberação</span>' : ''}</strong><small class="texto-3">${esc(u.email)} · desde ${esc(new Date(u.criado_em).toLocaleDateString('pt-BR'))}</small></span>
            <span role="cell"><select class="entrada entrada-pequena us-papel" aria-label="Papel de ${esc(u.nome)}" ${eu ? 'disabled title="Você não pode mudar o próprio papel"' : ''}>
              ${Object.entries(PAPEIS).map(([v, r]) => `<option value="${v}" ${v === u.papel ? 'selected' : ''}>${r}</option>`).join('')}</select></span>
            <span role="cell" class="texto-3">${esc(dataHora(u.ultimo_acesso))}</span>
            <span role="cell">${porPessoa.get(u.id) || 0}</span>
            <span role="cell">${eu ? '<span class="texto-3">Ativo</span>' : `<button class="btn ${u.ativo ? 'btn-secundario' : 'btn-primario'} us-ativo" type="button" data-acao="${u.ativo ? 'desativar' : 'ativar'}">${u.ativo ? 'Desativar' : novo ? 'Liberar acesso' : 'Reativar'}</button>`}</span>
          </div>`;
        }).join('')}
      </div>`;
  }

  async function alterarUsuario(id, campos, okTexto) {
    aviso('us-msg', '');
    const { error } = await sb.from('perfis').update(campos).eq('id', id);
    if (error) { console.error(error); aviso('us-msg', erroBanco(error, 'Não foi possível salvar a alteração.')); }
    else aviso('us-msg', okTexto, 'ok');
    renderUsuarios();
  }

  function iniciarUsuarios() {
    $('us-lista').addEventListener('change', ev => {
      const s = ev.target.closest('.us-papel'); if (!s) return;
      const linha = s.closest('[data-usuario]');
      alterarUsuario(linha.dataset.usuario, { papel: s.value }, `Papel alterado para ${PAPEIS[s.value]}. Vale no próximo acesso da pessoa.`);
      // dica: defina o papel antes de liberar o acesso de um cadastro novo
    });
    $('us-lista').addEventListener('click', ev => {
      const b = ev.target.closest('.us-ativo'); if (!b) return;
      const linha = b.closest('[data-usuario]');
      const desativar = b.dataset.acao === 'desativar';
      if (desativar && !confirm('Desativar o acesso desta pessoa? Ela não consegue mais entrar no Radar até ser reativada.')) return;
      alterarUsuario(linha.dataset.usuario, { ativo: !desativar }, desativar ? 'Acesso desativado.' : 'Acesso liberado. A pessoa já pode entrar no Radar.');
    });
  }

  // =================================================================
  // CONFIGURAÇÕES DO ROBÔ
  // =================================================================
  async function renderConfig() {
    const [f, t] = await Promise.all([
      sb.from('config_fontes').select('*').order('criado_em'),
      sb.from('config_termos').select('*').order('criado_em')
    ]);
    if (f.error || t.error) { console.error(f.error || t.error); aviso('cf-msg', 'Não foi possível carregar as configurações.'); return; }

    $('cf-fontes').innerHTML = (f.data || []).length ? f.data.map(x => {
      const status = x.ultimo_erro ? `<span class="parado">${I.alerta}Erro na última leitura</span>`
        : x.ultima_execucao ? `<span class="texto-3">${x.ultimo_total} link${x.ultimo_total === 1 ? '' : 's'} na última execução (${esc(dataHora(x.ultima_execucao))})${x.ultimo_total === 0 ? ' · confira o site e as palavras' : ''}</span>`
        : '<span class="texto-3">Ainda não lida pelo robô</span>';
      return `
        <div class="cf-item ${x.ativo ? '' : 'inativo'}" data-tabela="config_fontes" data-id="${esc(x.id)}">
          <div class="cf-texto"><strong>${esc(x.nome)}</strong>
            <a class="texto-3" href="${esc(x.url.replace('{ANO}', new Date().getFullYear()))}" target="_blank" rel="noopener">${esc(x.url)}</a>
            <small class="texto-3">Palavras: ${esc((x.palavras || []).join(', '))}</small>${status}</div>
          <div class="cf-acoes">${botoes(x)}</div>
        </div>`;
    }).join('') : '<p class="texto-3">Nenhum site cadastrado. O robô usa a lista padrão.</p>';

    const termos = tipo => (t.data || []).filter(x => x.tipo === tipo);
    const lista = tipo => termos(tipo).length ? termos(tipo).map(x => `
      <div class="cf-item ${x.ativo ? '' : 'inativo'}" data-tabela="config_termos" data-id="${esc(x.id)}">
        <div class="cf-texto"><span>${esc(x.texto)}</span></div>
        <div class="cf-acoes">${botoes(x)}</div>
      </div>`).join('') : '<p class="texto-3">Nenhum termo cadastrado. O robô usa a lista padrão.</p>';
    $('cf-web').innerHTML = lista('web');
    $('cf-noticias').innerHTML = lista('noticias');

    const webAtivos = termos('web').filter(x => x.ativo).length;
    $('cf-web-info').textContent = `${webAtivos} de ${LIMITE_WEB} ativos · custo estimado de ${usd(webAtivos * CUSTO_TERMO_WEB)} por execução do robô`;
    $('cf-noticias-info').textContent = `${termos('noticias').filter(x => x.ativo).length} ativos · menos de US$ 0,05 por execução`;
  }

  function botoes(x) {
    return `<button class="btn btn-fantasma cf-alternar" type="button">${x.ativo ? 'Desativar' : 'Ativar'}</button>
      <button class="btn btn-fantasma cf-excluir" type="button" aria-label="Excluir">Excluir</button>`;
  }

  async function executar(promessa, okTexto, padrao) {
    aviso('cf-msg', '');
    const { error } = await promessa;
    if (error) { console.error(error); aviso('cf-msg', erroBanco(error, padrao)); return false; }
    aviso('cf-msg', okTexto, 'ok');
    renderConfig();
    return true;
  }

  function iniciarConfig() {
    $('tela-config').addEventListener('click', async ev => {
      const item = ev.target.closest('[data-tabela]');
      if (!item) return;
      const tabela = item.dataset.tabela, id = item.dataset.id;
      if (ev.target.closest('.cf-alternar')) {
        const ativar = ev.target.textContent.trim() === 'Ativar';
        executar(sb.from(tabela).update({ ativo: ativar }).eq('id', id), ativar ? 'Ativado.' : 'Desativado. O robô deixa de usar na próxima execução.', 'Não foi possível alterar.');
      }
      if (ev.target.closest('.cf-excluir') && confirm('Excluir de vez? Se for só por um tempo, prefira Desativar.')) {
        executar(sb.from(tabela).delete().eq('id', id), 'Excluído.', 'Não foi possível excluir.');
      }
    });

    $('cf-form-fonte').addEventListener('submit', async ev => {
      ev.preventDefault();
      const nome = $('cf-f-nome').value.trim(), url = $('cf-f-url').value.trim();
      const palavras = $('cf-f-palavras').value.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
      if (nome.length < 3 || !/^https?:\/\//i.test(url)) { aviso('cf-msg', 'Informe o nome e um endereço começando com https://'); return; }
      if (await executar(sb.from('config_fontes').insert({ nome, url, palavras: palavras.length ? palavras : ['edital', 'chamada', 'chamamento'] }),
        'Site adicionado. Ele entra na próxima execução do robô; depois confira aqui quantos links ele trouxe.', 'Não foi possível adicionar o site.')) ev.target.reset();
    });

    ['web', 'noticias'].forEach(tipo => $(`cf-form-${tipo}`).addEventListener('submit', async ev => {
      ev.preventDefault();
      const campo = $(`cf-${tipo}-texto`), texto = campo.value.trim();
      if (texto.length < 3) { aviso('cf-msg', 'Escreva o termo de busca.'); return; }
      if (await executar(sb.from('config_termos').insert({ tipo, texto }), 'Termo adicionado. Ele entra na próxima execução do robô.', 'Não foi possível adicionar o termo.')) campo.value = '';
    }));
  }

  window.Admin = {
    iniciar(p) { perfil = p; if (p.papel !== 'admin') return; iniciarUsuarios(); iniciarConfig(); },
    usuarios: renderUsuarios,
    config: renderConfig
  };
})();
