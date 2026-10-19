-- RADAR v2 - Migração 004: notícias sem repetição e com prazo
alter table public.noticias add column if not exists chave text;
alter table public.noticias add column if not exists prazo date;
create unique index if not exists noticias_chave_unica on public.noticias (chave) where chave is not null;
-- Limpa a primeira leva (tinha repetidas); o robô grava de novo, já sem repetição
delete from public.noticias;
select count(*) as noticias from public.noticias;
