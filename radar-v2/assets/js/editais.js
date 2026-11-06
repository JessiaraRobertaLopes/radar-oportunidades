/* =====================================================================
   EDITAIS: leitura do banco, regras de visão e gestão da equipe
   Fontes: qualifications (nota da IA) + opportunities (edital)
           + sources (fonte) + pipeline (gestão) + anotacoes + perfis
   ===================================================================== */
(function () {
  const { sb } = window.Radar;
  const DIA = 86400000;

  function hoje() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

  function diasAtePrazo(prazo) {
    if (!prazo) return null;
    // "AAAA-MM-DD" é lido como data local (evita perder um dia no fuso de Brasília)
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(prazo));
    const v = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(prazo);
    if (isNaN(v)) return null;
    v.setHours(0, 0, 0, 0);
    return Math.round((v - hoje()) / DIA);
  }

  // Programas permanentes, linhas de crédito e credenciamentos sem prazo = fluxo contínuo.
  // O robô v2 já grava a situação; para os registros antigos, a regra abaixo deduz pelo título.
  const RE_CONTINUO = /programa|linha de cr[eé]dito|cr[eé]dito|credenciamento|fluxo cont[ií]nuo|permanente|fundo de investimento/i;
  function classificarSituacao(o) {
    if (o.situacao && o.situacao !== 'indefinido') return o.situacao;
    if (!o.deadline && RE_CONTINUO.test(o.title || '')) return 'fluxo_continuo';
    return 'indefinido';
  }

  // Áreas: remove explicações entre parênteses que a IA às vezes acrescenta
  function limparArea(a) {
    return String(a || '').replace(/\s*\(.*$/, '').replace(/\s+-\s+.*$/, '').trim();
  }

  // ---------------------------------------------------------------------
  // Leitura principal
  // ---------------------------------------------------------------------
  async function carregar() {
    const [qual, gestao, monit] = await Promise.all([
      sb.from('qualifications')
        .select('*, opportunities(*, sources(name))')
        .order('score', { ascending: false })
        .limit(1000),
      sb.from('pipeline').select('opportunity_id, status, responsavel_id, prazo_interno, valor_estimado, atualizado_em, etapa_desde, encaminhado_por, encaminhado_em, decidido_por, decidido_em'),
      sb.from('monitorados').select('opportunity_id, motivo, marcado_por, marcado_em')
    ]);
    if (qual.error) throw qual.error;
    if (gestao.error) throw gestao.error;

    const gestaoPor = new Map((gestao.data || []).map(g => [g.opportunity_id, g]));
    // monitorados: se a tabela ainda não existir, o resto do Radar continua funcionando
    const monitPor = new Map(((monit && !monit.error && monit.data) || []).map(m => [m.opportunity_id, m]));
    const vistos = new Set();
    const lista = [];

    for (const q of qual.data || []) {
      const o = q.opportunities || {};
      const id = o.id || q.opportunity_id;
      if (!id || vistos.has(id)) continue; // um card por edital
      if (o.duplicado_de) continue;        // repetido marcado pela limpeza
      vistos.add(id);
      const g = gestaoPor.get(id) || {};
      const m = monitPor.get(id);
      lista.push({
        id,
        titulo: o.title || 'Edital sem título',
        url: o.url || null,
        linkDocumento: o.link_documento || null,
        fonte: (o.sources && o.sources.name) || 'Fonte não informada',
        orgao: o.orgao || null,
        numero: o.numero_edital || null,
        prazo: o.deadline || null,
        dias: diasAtePrazo(o.deadline),
        dataAbertura: o.data_abertura || null,
        encontradoEm: o.created_at || q.created_at,
        situacao: classificarSituacao(o),
        valor: o.valor || null,
        publicoElegivel: o.publico_elegivel || null,
        aceitaFilantropico: o.aceita_filantropico || 'indefinido',
        resumo: o.resumo || null,
        descricao: o.description || null,
        evidencias: o.evidencias || null,
        justificativa: q.justification || null,
        prioridade: q.tier || 'D',
        aderencia: Math.round(Number(q.score) || 0),
        areas: [...new Set((Array.isArray(q.matched_areas) ? q.matched_areas : []).map(limparArea).filter(Boolean))],
        status: g.status || 'novo',
        responsavelId: g.responsavel_id || null,
        prazoInterno: g.prazo_interno || null,
        valorEstimado: g.valor_estimado ?? null,
        gestaoAtualizadaEm: g.atualizado_em || null,
        temGestao: !!g.status,
        etapaDesde: g.etapa_desde || null,
        encaminhadoPor: g.encaminhado_por || null,
        encaminhadoEm: g.encaminhado_em || null,
        decididoPor: g.decidido_por || null,
        decididoEm: g.decidido_em || null,
        monitorado: !!m,
        monitoradoPor: m ? m.marcado_por : null,
        monitoradoEm: m ? m.marcado_em : null,
        motivoMonitorar: m ? m.motivo : null
      });
    }
    return lista;
  }

  const ativo = e => e.situacao !== 'encerrado' && (e.dias === null || e.dias >= 0);
  const pontual = e => ativo(e) && e.situacao !== 'fluxo_continuo';

  // Visões das abas
  const VISOES = {
    'recentes': l => l.filter(pontual)
      .sort((a, b) => new Date(b.encontradoEm) - new Date(a.encontradoEm)),
    'prioridade-a': l => l.filter(e => pontual(e) && e.prioridade === 'A')
      .sort((a, b) => b.aderencia - a.aderencia),
    'prazo': l => l.filter(e => e.dias !== null && e.dias >= 0 && e.dias <= 7)
      .sort((a, b) => a.dias - b.dias),
    'em-analise': l => l.filter(e => ativo(e) && e.status === 'em_analise')
      .sort((a, b) => (a.dias ?? 9999) - (b.dias ?? 9999)),
    'fluxo-continuo': l => l.filter(e => ativo(e) && e.situacao === 'fluxo_continuo')
      .sort((a, b) => b.aderencia - a.aderencia),
    // monitorados aparecem mesmo vencidos ou descartados
    'monitorando': l => l.filter(e => e.monitorado)
      .sort((a, b) => new Date(b.monitoradoEm) - new Date(a.monitoradoEm))
  };

  function filtrarTexto(lista, termo) {
    const t = (termo || '').trim().toLowerCase();
    if (!t) return lista;
    return lista.filter(e =>
      e.titulo.toLowerCase().includes(t) ||
      e.fonte.toLowerCase().includes(t) ||
      (e.orgao || '').toLowerCase().includes(t) ||
      e.areas.some(a => String(a).toLowerCase().includes(t)));
  }

  const ROTULO_STATUS = {
    novo: 'Novo', em_analise: 'Em análise', descartado: 'Descartado',
    encaminhado: 'Encaminhado a Projetos', aprovado: 'Aprovado por Projetos', reprovado: 'Reprovado por Projetos'
  };

  // Quem pode levar o edital para cada etapa (o banco confere de novo)
  const ETAPAS_POR_PAPEL = {
    captacao: ['novo', 'em_analise', 'descartado', 'encaminhado'],
    projetos: ['encaminhado', 'aprovado', 'reprovado'],
    admin: ['novo', 'em_analise', 'descartado', 'encaminhado', 'aprovado', 'reprovado']
  };

  // Dias úteis (seg a sex) desde uma data até hoje
  function diasUteisDesde(iso) {
    if (!iso) return null;
    const d = new Date(iso); d.setHours(0, 0, 0, 0);
    const fim = hoje();
    let n = 0;
    while (d < fim) { d.setDate(d.getDate() + 1); const s = d.getDay(); if (s !== 0 && s !== 6) n++; }
    return n;
  }

  // Alertas de gargalo
  const LIMITE_ANALISE_DIAS_UTEIS = 5;   // Captação
  const LIMITE_PRAZO_PROJETOS_DIAS = 10; // Projetos
  function alerta(e) {
    if (e.status === 'em_analise') {
      const n = diasUteisDesde(e.etapaDesde);
      if (n !== null && n > LIMITE_ANALISE_DIAS_UTEIS) return { com: 'Captação', texto: `Em análise há ${n} dias úteis` };
    }
    if (e.status === 'encaminhado' && e.dias !== null && e.dias >= 0 && e.dias <= LIMITE_PRAZO_PROJETOS_DIAS) {
      return { com: 'Projetos', texto: e.dias === 0 ? 'Prazo vence hoje e Projetos ainda não decidiu' : `Faltam ${e.dias} dia${e.dias > 1 ? 's' : ''} e Projetos ainda não decidiu` };
    }
    return null;
  }
  const ROTULO_SITUACAO = {
    aberto: 'Inscrições abertas', encerrado: 'Encerrado',
    fluxo_continuo: 'Fluxo contínuo', indefinido: 'Situação não confirmada'
  };
  const ROTULO_FILANTROPICO = { sim: 'Sim', nao: 'Não', indefinido: 'Não informado' };

  // ---------------------------------------------------------------------
  // Gestão da equipe
  // ---------------------------------------------------------------------
  let _perfis = null;
  async function perfis() {
    if (_perfis) return _perfis;
    const { data, error } = await sb.from('perfis').select('id, nome, ativo').eq('ativo', true).order('nome');
    if (error) throw error;
    _perfis = data || [];
    return _perfis;
  }

  async function monitorar(opportunityId, motivo) {
    const { error } = await sb.from('monitorados').insert({ opportunity_id: opportunityId, motivo: motivo || null });
    if (error) throw error;
  }
  async function deixarDeMonitorar(opportunityId) {
    const { error } = await sb.from('monitorados').delete().eq('opportunity_id', opportunityId);
    if (error) throw error;
  }

  // Atualiza se o edital já tem gestão; cria se ainda não tem.
  // (não usa upsert: o banco aplica regras diferentes para criar e para mudar de etapa)
  async function salvarGestao(opportunityId, campos, jaExiste) {
    const registro = {
      status: campos.status,
      responsavel_id: campos.responsavelId || null,
      prazo_interno: campos.prazoInterno || null,
      valor_estimado: campos.valorEstimado === '' || campos.valorEstimado == null ? null : Number(campos.valorEstimado)
    };
    // justificativa só vai quando a etapa muda (o banco exige ao descartar, reprovar e recuperar)
    if (campos.justificativa !== undefined) registro.justificativa = campos.justificativa || null;
    const { data, error } = jaExiste
      ? await sb.from('pipeline').update(registro).eq('opportunity_id', opportunityId).select().single()
      : await sb.from('pipeline').insert({ opportunity_id: opportunityId, ...registro }).select().single();
    if (error) throw error;
    return data;
  }

  async function anotacoes(opportunityId) {
    const { data, error } = await sb.from('anotacoes')
      .select('id, texto, criado_em, editado_em, autor_id, perfis(nome)')
      .eq('opportunity_id', opportunityId)
      .order('criado_em', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function adicionarAnotacao(opportunityId, autorId, texto) {
    const { error } = await sb.from('anotacoes').insert({ opportunity_id: opportunityId, autor_id: autorId, texto });
    if (error) throw error;
  }

  async function excluirAnotacao(id) {
    const { error } = await sb.from('anotacoes').delete().eq('id', id);
    if (error) throw error;
  }

  // ---------------------------------------------------------------------
  // Arquivo: editais encerrados (sem os descartados que não eram edital)
  // ---------------------------------------------------------------------
  const RE_NAO_EDITAL = /página de menu|não é um edital|link inválido/i;
  async function arquivo() {
    const { data, error } = await sb.from('opportunities')
      .select('id, title, url, deadline, orgao, resumo, sources(name)')
      .eq('situacao', 'encerrado')
      .is('duplicado_de', null)
      .order('deadline', { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) throw error;
    return (data || [])
      .filter(o => !RE_NAO_EDITAL.test(o.resumo || ''))
      .map(o => ({
        id: o.id, titulo: o.title, url: o.url,
        orgao: o.orgao || (o.sources && o.sources.name) || '',
        prazo: o.deadline,
        motivo: /link fora do ar/i.test(o.resumo || '') ? 'Página fora do ar' : 'Encerrado'
      }));
  }

  window.Editais = {
    arquivo,
    carregar, VISOES, filtrarTexto, diasAtePrazo,
    ROTULO_STATUS, ROTULO_SITUACAO, ROTULO_FILANTROPICO, ETAPAS_POR_PAPEL,
    diasUteisDesde, alerta,
    perfis, salvarGestao, monitorar, deixarDeMonitorar, anotacoes, adicionarAnotacao, excluirAnotacao
  };
})();
