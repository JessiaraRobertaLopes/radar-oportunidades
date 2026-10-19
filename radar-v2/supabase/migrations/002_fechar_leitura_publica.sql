-- =====================================================================
-- RADAR v2 - Migração 002: fecha a leitura pública dos editais
-- Antes: qualquer pessoa com a chave pública lia sources, opportunities
--        e qualifications (políticas pub_* da v1).
-- Depois: só colaboradores logados e com perfil ativo leem.
-- O robô usa a chave de serviço e não é afetado pelo RLS.
-- Efeito esperado: o painel antigo (v1, GitHub Pages) para de mostrar dados.
-- =====================================================================

drop policy if exists pub_opportunities on public.opportunities;
drop policy if exists pub_qualifications on public.qualifications;
drop policy if exists pub_sources on public.sources;

alter table public.opportunities enable row level security;
alter table public.qualifications enable row level security;
alter table public.sources enable row level security;

create policy "ativos leem editais" on public.opportunities
  for select to authenticated using (public.eh_ativo());

create policy "ativos leem notas" on public.qualifications
  for select to authenticated using (public.eh_ativo());

create policy "ativos leem fontes" on public.sources
  for select to authenticated using (public.eh_ativo());

-- Conferência: deve listar só as 3 políticas novas
select tablename, policyname, roles
from pg_policies
where schemaname = 'public' and tablename in ('opportunities', 'qualifications', 'sources')
order by tablename;
