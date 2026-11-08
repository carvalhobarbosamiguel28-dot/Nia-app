-- Cole no Supabase: SQL Editor -> New query -> Run

create table if not exists public.noticias (
  id           bigint generated always as identity primary key,
  link         text not null unique,
  fonte        text not null,
  tag          text not null,
  empresa      text not null,
  titulo       text not null,
  resumo       text not null,
  publicado_em timestamptz not null,
  criado_em    timestamptz not null default now()
);

create index if not exists noticias_publicado_idx on public.noticias (publicado_em desc);

-- Segurança: o site (chave "anon") só pode LER. Quem grava é o script, com a chave secreta.
alter table public.noticias enable row level security;

drop policy if exists "leitura publica" on public.noticias;
create policy "leitura publica" on public.noticias for select using (true);
