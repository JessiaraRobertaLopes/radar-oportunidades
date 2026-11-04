-- =====================================================================
-- RADAR v2 - Migração 005: perfil Setor de Projetos + novo fluxo da Gestão
--
-- Fluxo:
--   Captação:  novo -> em_analise -> descartado | encaminhado
--   Projetos:  encaminhado -> aprovado | reprovado   (não devolve)
--   Admin:     pode mover qualquer etapa (correções)
-- Visão:
--   Captação e Admin veem tudo; Projetos vê só o que foi encaminhado.
-- Registro: quando entrou na etapa, quem encaminhou e quem decidiu.
-- =====================================================================

-- 1) Papéis: captacao | projetos | admin
alter table public.perfis drop constraint if exists perfis_papel_check;
alter table public.perfis add constraint perfis_papel_check
  check (papel in ('captacao', 'projetos', 'admin'));

create or replace function public.papel_atual()
returns text
language sql stable security definer set search_path = public
as $$
  select papel from public.perfis where id = auth.uid() and ativo;
$$;

-- 2) Etapas: "inscrito" vira "encaminhado"
alter table public.pipeline drop constraint if exists pipeline_status_check;
update public.pipeline set status = 'encaminhado' where status = 'inscrito';
alter table public.pipeline add constraint pipeline_status_check
  check (status in ('novo', 'em_analise', 'descartado', 'encaminhado', 'aprovado', 'reprovado'));

-- 3) Registro de quem e quando
alter table public.pipeline add column if not exists etapa_desde timestamptz not null default now();
alter table public.pipeline add column if not exists encaminhado_por uuid references public.perfis(id) on delete set null;
alter table public.pipeline add column if not exists encaminhado_em timestamptz;
alter table public.pipeline add column if not exists decidido_por uuid references public.perfis(id) on delete set null;
alter table public.pipeline add column if not exists decidido_em timestamptz;

-- registros antigos: a data da última alteração é a melhor estimativa
update public.pipeline set etapa_desde = atualizado_em;

-- 4) Regras de quem pode mover o quê + carimbos automáticos
create or replace function public.regras_fluxo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  papel text := public.papel_atual();
  antes text := case when tg_op = 'UPDATE' then old.status else null end;
begin
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
      if antes in ('aprovado', 'reprovado') and new.status is distinct from antes then
        raise exception 'Este edital já foi decidido pelo Setor de Projetos.';
      end if;
    else
      raise exception 'Perfil sem permissão para alterar a gestão.';
    end if;
  end if;

  if tg_op = 'INSERT' or new.status is distinct from antes then
    new.etapa_desde := now();
    if new.status = 'encaminhado' then
      new.encaminhado_por := coalesce(auth.uid(), new.encaminhado_por);
      new.encaminhado_em := now();
    end if;
    if new.status in ('aprovado', 'reprovado') then
      new.decidido_por := coalesce(auth.uid(), new.decidido_por);
      new.decidido_em := now();
    else
      new.decidido_por := null;   -- voltou para antes da decisão (correção do Admin)
      new.decidido_em := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists pipeline_fluxo on public.pipeline;
create trigger pipeline_fluxo
  before insert or update on public.pipeline
  for each row execute function public.regras_fluxo();

-- 5) Quem vê o quê
create or replace function public.ve_edital(opp uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.eh_ativo() and (
    public.papel_atual() <> 'projetos'
    or exists (select 1 from public.pipeline p
               where p.opportunity_id = opp and p.status in ('encaminhado', 'aprovado', 'reprovado'))
  );
$$;

drop policy if exists "ativos leem editais" on public.opportunities;
create policy "ativos leem editais" on public.opportunities
  for select to authenticated using (public.ve_edital(id));

drop policy if exists "ativos leem notas" on public.qualifications;
create policy "ativos leem notas" on public.qualifications
  for select to authenticated using (public.ve_edital(opportunity_id));

drop policy if exists "ativos leem pipeline" on public.pipeline;
create policy "ativos leem pipeline" on public.pipeline
  for select to authenticated using (public.ve_edital(opportunity_id));

drop policy if exists "ativos leem anotacoes" on public.anotacoes;
create policy "ativos leem anotacoes" on public.anotacoes
  for select to authenticated using (public.ve_edital(opportunity_id));

drop policy if exists "ativos criam anotacoes" on public.anotacoes;
create policy "ativos criam anotacoes" on public.anotacoes
  for insert to authenticated
  with check (public.ve_edital(opportunity_id) and autor_id = auth.uid());

-- Conferência
select status, count(*) from public.pipeline group by status order by status;
