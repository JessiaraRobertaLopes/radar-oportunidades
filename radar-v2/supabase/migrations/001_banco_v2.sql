-- =====================================================================
-- RADAR DE OPORTUNIDADES v2.0 - Santa Casa BH
-- Migração 001: estrutura do banco v2 (perfis, pipeline, anotações,
-- buscas IA, auditoria, notificações Teams)
--
-- Pré-requisito: tabelas da v1 já existentes
--   public.sources, public.opportunities, public.qualifications
-- Validado etapa a etapa em 17/10/2026.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ETAPA 1: perfis de usuário + regra de domínio
-- ---------------------------------------------------------------------
create table public.perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  email text not null unique,
  papel text not null default 'captacao' check (papel in ('captacao', 'admin')),
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

alter table public.perfis enable row level security;

create or replace function public.eh_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.perfis
    where id = auth.uid() and papel = 'admin' and ativo
  );
$$;

create policy "logados veem perfis"
  on public.perfis for select
  to authenticated
  using (true);

create or replace function public.criar_perfil_novo_usuario()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if split_part(lower(new.email), '@', 2) <> 'santacasabh.org.br' then
    raise exception 'Cadastro permitido apenas com e-mail @santacasabh.org.br';
  end if;

  insert into public.perfis (id, nome, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', split_part(new.email, '@', 1)),
    lower(new.email)
  );
  return new;
end;
$$;

create trigger ao_criar_usuario
  after insert on auth.users
  for each row execute function public.criar_perfil_novo_usuario();


-- ---------------------------------------------------------------------
-- ETAPA 2: pipeline de cada edital
-- (edital sem linha no pipeline = status "novo")
-- ---------------------------------------------------------------------
create or replace function public.eh_ativo()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.perfis
    where id = auth.uid() and ativo
  );
$$;

create table public.pipeline (
  opportunity_id uuid primary key references public.opportunities(id) on delete cascade,
  status text not null default 'novo'
    check (status in ('novo', 'em_analise', 'inscrito', 'aprovado', 'reprovado', 'descartado')),
  responsavel_id uuid references public.perfis(id) on delete set null,
  prazo_interno date,
  valor_estimado numeric(14,2),
  atualizado_por uuid references public.perfis(id) on delete set null default auth.uid(),
  atualizado_em timestamptz not null default now()
);

alter table public.pipeline enable row level security;

create policy "ativos leem pipeline"
  on public.pipeline for select
  to authenticated
  using (public.eh_ativo());

create policy "ativos criam pipeline"
  on public.pipeline for insert
  to authenticated
  with check (public.eh_ativo());

create policy "ativos editam pipeline"
  on public.pipeline for update
  to authenticated
  using (public.eh_ativo())
  with check (public.eh_ativo());

create or replace function public.carimbar_alteracao()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := coalesce(auth.uid(), new.atualizado_por);
  return new;
end;
$$;

create trigger pipeline_carimbo
  before update on public.pipeline
  for each row execute function public.carimbar_alteracao();


-- ---------------------------------------------------------------------
-- ETAPA 3: anotações da equipe em cada edital
-- ---------------------------------------------------------------------
create table public.anotacoes (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  autor_id uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  texto text not null check (char_length(texto) between 1 and 4000),
  criado_em timestamptz not null default now(),
  editado_em timestamptz
);

create index anotacoes_por_edital on public.anotacoes (opportunity_id, criado_em desc);

alter table public.anotacoes enable row level security;

create policy "ativos leem anotacoes"
  on public.anotacoes for select
  to authenticated
  using (public.eh_ativo());

create policy "ativos criam anotacoes"
  on public.anotacoes for insert
  to authenticated
  with check (public.eh_ativo() and autor_id = auth.uid());

create policy "autor edita anotacao"
  on public.anotacoes for update
  to authenticated
  using (autor_id = auth.uid())
  with check (autor_id = auth.uid());

create policy "autor ou admin apaga anotacao"
  on public.anotacoes for delete
  to authenticated
  using (autor_id = auth.uid() or public.eh_admin());

create or replace function public.marcar_edicao()
returns trigger
language plpgsql
as $$
begin
  new.editado_em := now();
  return new;
end;
$$;

create trigger anotacoes_edicao
  before update on public.anotacoes
  for each row execute function public.marcar_edicao();


-- ---------------------------------------------------------------------
-- ETAPA 5: histórico de buscas com IA
-- (a tabela legada public.search_requests está vazia e não é usada;
--  candidata a remoção na migração)
-- ---------------------------------------------------------------------
create table public.buscas_ia (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  tipo text not null default 'projeto'
    check (tipo in ('projeto', 'privados', 'noticias')),
  pergunta text not null check (char_length(pergunta) between 3 and 2000),
  resultados jsonb,
  total_resultados integer,
  modelo text,
  tokens_entrada integer,
  tokens_saida integer,
  criado_em timestamptz not null default now()
);

create index buscas_por_usuario on public.buscas_ia (usuario_id, criado_em desc);

alter table public.buscas_ia enable row level security;

create policy "dono ou admin le buscas"
  on public.buscas_ia for select
  to authenticated
  using (usuario_id = auth.uid() or public.eh_admin());

create policy "ativos registram buscas"
  on public.buscas_ia for insert
  to authenticated
  with check (public.eh_ativo() and usuario_id = auth.uid());


-- ---------------------------------------------------------------------
-- ETAPA 6: auditoria automática
-- ---------------------------------------------------------------------
create table public.auditoria (
  id bigint generated always as identity primary key,
  tabela text not null,
  acao text not null,
  registro_id text,
  usuario_id uuid,
  usuario_email text,
  dados_antes jsonb,
  dados_depois jsonb,
  criado_em timestamptz not null default now()
);

create index auditoria_por_data on public.auditoria (criado_em desc);

alter table public.auditoria enable row level security;

create policy "admin le auditoria"
  on public.auditoria for select
  to authenticated
  using (public.eh_admin());

create or replace function public.registrar_auditoria()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_linha jsonb;
begin
  v_linha := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  insert into public.auditoria
    (tabela, acao, registro_id, usuario_id, usuario_email, dados_antes, dados_depois)
  values (
    tg_table_name,
    tg_op,
    coalesce(v_linha->>'id', v_linha->>'opportunity_id'),
    auth.uid(),
    (select email from public.perfis where id = auth.uid()),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );

  return coalesce(new, old);
end;
$$;

create trigger auditoria_pipeline
  after insert or update or delete on public.pipeline
  for each row execute function public.registrar_auditoria();

create trigger auditoria_anotacoes
  after insert or update or delete on public.anotacoes
  for each row execute function public.registrar_auditoria();

create trigger auditoria_perfis
  after insert or update or delete on public.perfis
  for each row execute function public.registrar_auditoria();


-- ---------------------------------------------------------------------
-- ETAPA 7: controle de notificações do Teams
-- (gravação apenas pela automação, com a chave service_role)
-- ---------------------------------------------------------------------
create table public.notificacoes_teams (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  status text not null default 'pendente'
    check (status in ('pendente', 'enviado', 'erro')),
  tentativas integer not null default 0,
  ultimo_erro text,
  enviado_em timestamptz,
  criado_em timestamptz not null default now(),
  unique (opportunity_id)
);

alter table public.notificacoes_teams enable row level security;

create policy "ativos leem notificacoes"
  on public.notificacoes_teams for select
  to authenticated
  using (public.eh_ativo());

-- PENDENTE (migração 002, junto com o front v2):
-- fechar a leitura pública (anon) de sources, opportunities e qualifications.
