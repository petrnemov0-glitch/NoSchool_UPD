-- ===========================================================
-- NoSchool CRM — Этап A: схема для одного репетитора
-- Выполните этот скрипт целиком в Supabase → SQL Editor → New query → Run
-- ===========================================================

-- Расширение для генерации uuid (в Supabase обычно уже включено)
create extension if not exists pgcrypto;

-- -----------------------------------------------------------
-- УЧЕНИКИ
-- -----------------------------------------------------------
create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  grade text,
  price numeric not null default 0,
  duration int not null default 60,
  phone text,
  telegram text,
  comment text,
  status text not null default 'active', -- active | paused
  created_at timestamptz not null default now()
);

alter table students enable row level security;

create policy "students_select_own" on students
  for select using (owner_id = auth.uid());
create policy "students_insert_own" on students
  for insert with check (owner_id = auth.uid());
create policy "students_update_own" on students
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "students_delete_own" on students
  for delete using (owner_id = auth.uid());

-- -----------------------------------------------------------
-- ЗАНЯТИЯ
-- -----------------------------------------------------------
create table if not exists lessons (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  date date not null,
  time time not null,
  status text not null default 'planned', -- planned | done | cancelled | moved
  paid boolean not null default false,
  homework text default '',
  hw_done boolean not null default false,
  comment text default '',
  price numeric not null default 0,
  created_at timestamptz not null default now()
);

alter table lessons enable row level security;

create policy "lessons_select_own" on lessons
  for select using (owner_id = auth.uid());
create policy "lessons_insert_own" on lessons
  for insert with check (owner_id = auth.uid());
create policy "lessons_update_own" on lessons
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "lessons_delete_own" on lessons
  for delete using (owner_id = auth.uid());

-- -----------------------------------------------------------
-- РАСХОДЫ
-- -----------------------------------------------------------
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  amount numeric not null,
  date date not null,
  created_at timestamptz not null default now()
);

alter table expenses enable row level security;

create policy "expenses_select_own" on expenses
  for select using (owner_id = auth.uid());
create policy "expenses_insert_own" on expenses
  for insert with check (owner_id = auth.uid());
create policy "expenses_update_own" on expenses
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "expenses_delete_own" on expenses
  for delete using (owner_id = auth.uid());

-- -----------------------------------------------------------
-- Полезные индексы
-- -----------------------------------------------------------
create index if not exists idx_lessons_owner_date on lessons(owner_id, date);
create index if not exists idx_lessons_student on lessons(student_id);
create index if not exists idx_expenses_owner_date on expenses(owner_id, date);

-- Готово. owner_id заполняется автоматически значением auth.uid() —
-- поэтому из приложения его передавать не нужно, а Row Level Security
-- гарантирует, что каждый репетитор видит и меняет только свои данные,
-- даже если запрос к базе придёт в обход самого приложения.
