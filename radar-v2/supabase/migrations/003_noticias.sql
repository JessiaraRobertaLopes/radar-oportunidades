-- =====================================================================
-- RADAR v2 - Migração 003: notícias pré-edital
-- Gravação só pelo robô (chave de serviço). Leitura: colaboradores ativos.
-- =====================================================================
create table if not exists public.noticias (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  url text not null unique,
  fonte text,
  publicado_em timestamptz,
  tipo text not null check (tipo in ('pre_edital', 'edital_aberto', 'programa')),
  relevancia integer not null check (relevancia between 0 and 100),
  orgao text,
  por_que text,
  termo text,
  criado_em timestamptz not null default now()
);

create index if not exists noticias_recentes on public.noticias (publicado_em desc nulls last);

alter table public.noticias enable row level security;

create policy "ativos leem noticias" on public.noticias
  for select to authenticated using (public.eh_ativo());

-- Conferência: deve mostrar a tabela com 0 linhas
select count(*) as noticias from public.noticias;
