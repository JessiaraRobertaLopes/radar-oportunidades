-- =====================================================================
-- RADAR v2 - Migração 006: administração sem chamado para a TI
--   1) Sites fixos e termos de busca editáveis pelo Admin (o robô lê daqui)
--   2) Admin ativa/desativa pessoas e troca o papel (captacao | projetos | admin)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Configuração do robô
-- ---------------------------------------------------------------------
create table if not exists public.config_fontes (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 3 and 120),
  url text not null unique check (url ~* '^https?://'),   -- pode usar {ANO} para o ano atual
  palavras text[] not null default '{edital,chamada,chamamento}',
  ativo boolean not null default true,
  ultima_execucao timestamptz,
  ultimo_total integer,
  ultimo_erro text,
  criado_por uuid references public.perfis(id) on delete set null default auth.uid(),
  criado_em timestamptz not null default now()
);

create table if not exists public.config_termos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('web', 'noticias')),
  texto text not null check (char_length(texto) between 3 and 200),
  ativo boolean not null default true,
  criado_por uuid references public.perfis(id) on delete set null default auth.uid(),
  criado_em timestamptz not null default now(),
  unique (tipo, texto)
);

-- Limite de 10 termos web ativos (cada um custa ~US$0,15 a 0,20 por execução)
create or replace function public.limite_termos_web()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.tipo = 'web' and new.ativo and (
       select count(*) from public.config_termos
       where tipo = 'web' and ativo and id <> new.id) >= 10 then
    raise exception 'Limite de 10 termos de busca na web ativos. Desative um antes de ativar outro.';
  end if;
  return new;
end;
$$;

drop trigger if exists termos_web_limite on public.config_termos;
create trigger termos_web_limite
  before insert or update on public.config_termos
  for each row execute function public.limite_termos_web();

alter table public.config_fontes enable row level security;
alter table public.config_termos enable row level security;

drop policy if exists "admin gerencia fontes" on public.config_fontes;
create policy "admin gerencia fontes" on public.config_fontes
  for all to authenticated using (public.eh_admin()) with check (public.eh_admin());

drop policy if exists "admin gerencia termos" on public.config_termos;
create policy "admin gerencia termos" on public.config_termos
  for all to authenticated using (public.eh_admin()) with check (public.eh_admin());

-- Listas atuais do robô (só entram se as tabelas estiverem vazias)
insert into public.config_fontes (nome, url, palavras)
select * from (values
  ('Ministério da Saúde | Chamamentos públicos',
   'https://www.gov.br/saude/pt-br/acesso-a-informacao/participacao-social/chamamentos-publicos/{ANO}',
   '{chamamento,edital,chamada,seleção,convocação}'::text[]),
  ('FAPEMIG | Chamadas e editais',
   'https://fapemig.br/oportunidades/chamadas-e-editais',
   '{chamada,edital,seleção,programa}'::text[])
) v(nome, url, palavras)
where not exists (select 1 from public.config_fontes);

insert into public.config_termos (tipo, texto)
select * from (values
  ('web', 'edital com inscrições abertas para hospitais filantrópicos SUS'),
  ('web', 'chamamento público inovação e saúde digital inscrições abertas'),
  ('web', 'edital financiamento infraestrutura e equipamentos hospitalares entidades filantrópicas'),
  ('web', 'edital pesquisa clínica e formação de profissionais de saúde inscrições abertas'),
  ('web', 'edital ESG sustentabilidade e inclusão social para organizações de saúde sem fins lucrativos'),
  ('web', 'edital fundações e institutos privados apoio a hospitais filantrópicos Minas Gerais'),
  ('noticias', '"chamamento público" saúde'),
  ('noticias', 'edital hospital filantrópico'),
  ('noticias', '"Ministério da Saúde" edital OR chamamento OR portaria recursos'),
  ('noticias', 'emenda parlamentar hospital Minas Gerais'),
  ('noticias', 'FAPEMIG chamada OR edital'),
  ('noticias', 'BNDES saúde hospitais programa'),
  ('noticias', 'edital pesquisa clínica OR inovação em saúde'),
  ('noticias', 'fundação edital saúde OR "responsabilidade social"'),
  ('noticias', '"Santa Casa" recursos OR edital OR programa'),
  ('noticias', 'PRONON OR PRONAS')
) v(tipo, texto)
where not exists (select 1 from public.config_termos);

-- ---------------------------------------------------------------------
-- 2) Usuários: cadastro novo aguarda liberação; Admin libera, desativa e troca papel
-- ---------------------------------------------------------------------
-- liberado_em vazio = nunca liberado ("aguardando liberação")
alter table public.perfis add column if not exists liberado_em timestamptz;
update public.perfis set liberado_em = criado_em where ativo and liberado_em is null;

-- Cadastro novo entra desativado, aguardando o Admin
create or replace function public.criar_perfil_novo_usuario()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if split_part(lower(new.email), '@', 2) <> 'santacasabh.org.br' then
    raise exception 'Cadastro permitido apenas com e-mail @santacasabh.org.br';
  end if;

  insert into public.perfis (id, nome, email, ativo)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', split_part(new.email, '@', 1)),
    lower(new.email),
    false
  );
  return new;
end;
$$;
drop policy if exists "admin edita perfis" on public.perfis;
create policy "admin edita perfis" on public.perfis
  for update to authenticated using (public.eh_admin()) with check (public.eh_admin());

-- Proteções: ninguém tira o próprio acesso ou o próprio papel de Admin
-- (evita ficar sem nenhum administrador por engano)
create or replace function public.protege_perfis()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and new.id = auth.uid()
     and (new.ativo is distinct from old.ativo or new.papel is distinct from old.papel) then
    raise exception 'Você não pode desativar a própria conta nem mudar o próprio papel.';
  end if;
  if auth.uid() is not null and (new.email is distinct from old.email or new.id is distinct from old.id) then
    raise exception 'O e-mail não pode ser alterado por aqui.';
  end if;
  if new.ativo and not old.ativo and new.liberado_em is null then
    new.liberado_em := now();   -- primeira liberação
  end if;
  return new;
end;
$$;

drop trigger if exists perfis_protecao on public.perfis;
create trigger perfis_protecao
  before update on public.perfis
  for each row execute function public.protege_perfis();

-- Lista de pessoas com o último acesso (só Admin)
drop function if exists public.admin_usuarios();
create or replace function public.admin_usuarios()
returns table (id uuid, nome text, email text, papel text, ativo boolean,
               criado_em timestamptz, liberado_em timestamptz, ultimo_acesso timestamptz)
language sql stable security definer set search_path = public
as $$
  select p.id, p.nome, p.email, p.papel, p.ativo, p.criado_em, p.liberado_em, u.last_sign_in_at
  from public.perfis p left join auth.users u on u.id = p.id
  where public.eh_admin()
  order by (p.liberado_em is null) desc, p.ativo desc, p.nome;
$$;

revoke all on function public.admin_usuarios() from public, anon;
grant execute on function public.admin_usuarios() to authenticated;

-- Conferência
select 'fontes' as lista, count(*) from public.config_fontes
union all select 'termos web', count(*) from public.config_termos where tipo = 'web'
union all select 'termos noticias', count(*) from public.config_termos where tipo = 'noticias'
union all select 'pessoas liberadas', count(*) from public.perfis where liberado_em is not null;
