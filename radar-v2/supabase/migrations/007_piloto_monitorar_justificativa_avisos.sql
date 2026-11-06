-- =====================================================================
-- RADAR v2 - Migração 007: ajustes pedidos na reunião com a Captação
--   1) Justificativa obrigatória ao descartar, reprovar e recuperar
--   2) Captação pode recuperar edital reprovado (volta para "Em análise")
--   3) Monitorar / favoritar edital (da equipe, inclusive descartado ou vencido)
--   4) Avisos: registro de cada aviso (encaminhado, aprovado, reprovado)
--      e envio para o Teams (fluxo do Power Automate com gatilho de webhook)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 e 2) Justificativa + recuperar
-- ---------------------------------------------------------------------
alter table public.pipeline add column if not exists justificativa text;

create or replace function public.regras_fluxo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  papel text := public.papel_atual();
  antes text := case when tg_op = 'UPDATE' then old.status else null end;
  mudou boolean := (tg_op = 'INSERT' or new.status is distinct from antes);
  recuperando boolean := (antes in ('descartado', 'reprovado') and new.status = 'em_analise');
begin
  -- Quem pode mover o quê
  if auth.uid() is not null and papel is distinct from 'admin' then
    if papel = 'projetos' then
      if tg_op = 'INSERT' or antes not in ('encaminhado', 'aprovado', 'reprovado')
         or new.status not in ('encaminhado', 'aprovado', 'reprovado') then
        raise exception 'O Setor de Projetos só decide editais encaminhados (aprovar ou reprovar).';
      end if;
    elsif papel = 'captacao' then
      if new.status in ('aprovado', 'reprovado') and new.status is distinct from antes then
        raise exception 'Aprovar ou reprovar é decisão do Setor de Projetos.';
      end if;
      if antes = 'aprovado' and new.status is distinct from antes then
        raise exception 'Este edital já foi aprovado pelo Setor de Projetos.';
      end if;
      if antes = 'reprovado' and new.status is distinct from antes and not recuperando then
        raise exception 'Edital reprovado só pode voltar para "Em análise" (recuperar).';
      end if;
    else
      raise exception 'Perfil sem permissão para alterar a gestão.';
    end if;
  end if;

  -- Justificativa obrigatória
  if mudou and (new.status in ('descartado', 'reprovado') or recuperando) then
    if char_length(trim(coalesce(new.justificativa, ''))) < 10 then
      raise exception 'Escreva uma justificativa (pelo menos 10 caracteres) para %.',
        case when recuperando then 'recuperar o edital'
             when new.status = 'descartado' then 'descartar'
             else 'reprovar' end;
    end if;
  elsif mudou then
    new.justificativa := null;   -- etapas sem justificativa não herdam a anterior
  end if;

  -- Carimbos
  if mudou then
    new.etapa_desde := now();
    if new.status = 'encaminhado' then
      new.encaminhado_por := coalesce(auth.uid(), new.encaminhado_por);
      new.encaminhado_em := now();
    end if;
    if new.status in ('aprovado', 'reprovado') then
      new.decidido_por := coalesce(auth.uid(), new.decidido_por);
      new.decidido_em := now();
    else
      new.decidido_por := null;
      new.decidido_em := null;
    end if;
  end if;
  return new;
end;
$$;

-- A justificativa vira anotação no edital, para todo mundo ler depois
create or replace function public.justificativa_vira_anotacao()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  rotulo text;
begin
  if new.justificativa is not null
     and (tg_op = 'INSERT' or new.status is distinct from old.status)
     and auth.uid() is not null then
    rotulo := case
      when new.status = 'descartado' then 'Descartado'
      when new.status = 'reprovado' then 'Reprovado por Projetos'
      when new.status = 'em_analise' then 'Recuperado para nova análise'
      else 'Etapa alterada' end;
    insert into public.anotacoes (opportunity_id, autor_id, texto)
    values (new.opportunity_id, auth.uid(), rotulo || ': ' || new.justificativa);
  end if;
  return new;
end;
$$;

drop trigger if exists pipeline_justificativa on public.pipeline;
create trigger pipeline_justificativa
  after insert or update on public.pipeline
  for each row execute function public.justificativa_vira_anotacao();

-- ---------------------------------------------------------------------
-- 3) Monitorar / favoritar (da equipe)
-- ---------------------------------------------------------------------
create table if not exists public.monitorados (
  opportunity_id uuid primary key references public.opportunities(id) on delete cascade,
  motivo text check (motivo is null or char_length(motivo) <= 300),
  marcado_por uuid references public.perfis(id) on delete set null default auth.uid(),
  marcado_em timestamptz not null default now()
);

alter table public.monitorados enable row level security;

drop policy if exists "ativos leem monitorados" on public.monitorados;
create policy "ativos leem monitorados" on public.monitorados
  for select to authenticated using (public.ve_edital(opportunity_id));

drop policy if exists "captacao marca monitorados" on public.monitorados;
create policy "captacao marca monitorados" on public.monitorados
  for insert to authenticated
  with check (public.papel_atual() in ('captacao', 'admin') and marcado_por = auth.uid());

drop policy if exists "captacao desmarca monitorados" on public.monitorados;
create policy "captacao desmarca monitorados" on public.monitorados
  for delete to authenticated using (public.papel_atual() in ('captacao', 'admin'));

drop policy if exists "captacao edita monitorados" on public.monitorados;
create policy "captacao edita monitorados" on public.monitorados
  for update to authenticated
  using (public.papel_atual() in ('captacao', 'admin'))
  with check (public.papel_atual() in ('captacao', 'admin'));

-- ---------------------------------------------------------------------
-- 4) Avisos (registro + envio ao Teams)
-- ---------------------------------------------------------------------
-- Configurações de integração: ninguém lê pela tela (só o banco e o robô)
create table if not exists public.config_integracoes (
  chave text primary key,
  valor text not null,
  atualizado_em timestamptz not null default now()
);
alter table public.config_integracoes enable row level security;
-- (sem políticas: nenhum usuário lê ou altera pela API)

insert into public.config_integracoes (chave, valor)
values ('app_url', 'https://jessiararobertalopes.github.io/radar-oportunidades/radar-v2/app.html')
on conflict (chave) do nothing;

create table if not exists public.notificacoes (
  id uuid primary key default gen_random_uuid(),
  evento text not null check (evento in ('encaminhado', 'aprovado', 'reprovado', 'resumo_diario')),
  para text not null,                       -- 'Setor de Projetos' | 'Captação'
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  payload jsonb not null,                   -- exatamente o que vai para o Teams
  enviado_em timestamptz,
  erro text,
  criado_em timestamptz not null default now()
);
alter table public.notificacoes enable row level security;

drop policy if exists "admin le notificacoes" on public.notificacoes;
create policy "admin le notificacoes" on public.notificacoes
  for select to authenticated using (public.eh_admin());

-- Envio pelo Supabase (extensão pg_net). Na migração, o backend da Santa Casa BH
-- faz o mesmo: POST do payload, em JSON, para o endereço do webhook do Teams.
create extension if not exists pg_net;

create or replace function public.enviar_notificacao(n public.notificacoes)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  destino text;
begin
  select valor into destino from public.config_integracoes where chave = 'teams_webhook_url';
  if destino is null or destino = '' then
    return;   -- sem webhook configurado: o aviso fica só registrado
  end if;
  perform net.http_post(
    url := destino,
    body := n.payload,
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  update public.notificacoes set enviado_em = now() where id = n.id;
exception when others then
  update public.notificacoes set erro = left(sqlerrm, 300) where id = n.id;
end;
$$;

create or replace function public.avisar_mudanca_etapa()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  o record;
  quem text;
  base_url text;
  n public.notificacoes;
begin
  if not (new.status in ('encaminhado', 'aprovado', 'reprovado')
          and (tg_op = 'INSERT' or new.status is distinct from old.status)) then
    return new;
  end if;

  select title, orgao, deadline into o from public.opportunities where id = new.opportunity_id;
  select nome into quem from public.perfis where id = auth.uid();
  select valor into base_url from public.config_integracoes where chave = 'app_url';

  insert into public.notificacoes (evento, para, opportunity_id, payload)
  values (
    new.status,
    case when new.status = 'encaminhado' then 'Setor de Projetos' else 'Captação' end,
    new.opportunity_id,
    jsonb_build_object(
      'evento', new.status,
      'para', case when new.status = 'encaminhado' then 'Setor de Projetos' else 'Captação' end,
      'titulo', coalesce(o.title, 'Edital'),
      'orgao', coalesce(o.orgao, ''),
      'prazo', coalesce(to_char(o.deadline, 'DD/MM/YYYY'), 'Sem prazo informado'),
      'dias_para_prazo', case when o.deadline is null then null else (o.deadline - current_date) end,
      'quem', coalesce(quem, 'Radar'),
      'potencial', case when new.valor_estimado is null then ''
                        else 'R$ ' || translate(to_char(new.valor_estimado, 'FM999,999,999,990.00'), ',.', '.,') end,
      'justificativa', coalesce(new.justificativa, ''),
      'link', coalesce(base_url, '') || '#gestao',
      'itens', '[]'::jsonb
    )
  )
  returning * into n;

  perform public.enviar_notificacao(n);
  return new;
exception when others then
  return new;   -- aviso nunca impede a mudança de etapa
end;
$$;

drop trigger if exists pipeline_avisos on public.pipeline;
create trigger pipeline_avisos
  after insert or update on public.pipeline
  for each row execute function public.avisar_mudanca_etapa();

-- Conferência
select
  (select count(*) from public.pipeline) as editais_em_gestao,
  (select count(*) from public.monitorados) as monitorados,
  (select count(*) from public.notificacoes) as avisos,
  (select count(*) from pg_extension where extname = 'pg_net') as pg_net_ativo;
