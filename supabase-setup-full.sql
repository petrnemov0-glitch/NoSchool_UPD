-- ===========================================================
-- NoSchool CRM — ФИНАЛЬНАЯ схема БД (под все 4 роли из ТЗ)
-- Выполните этот скрипт целиком в новом проекте Supabase →
-- SQL Editor → New query → Run
--
-- Важно: прямо сейчас приложение использует только роль
-- «репетитор». Остальные роли (родитель/ученик/администратор)
-- будут подключаться поэтапно к этой же схеме — переделывать
-- таблицы заново не понадобится, только добавлять новые
-- политики доступа и экраны.
-- ===========================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------
-- ОРГАНИЗАЦИИ И ЧЛЕНСТВО
-- -----------------------------------------------------------
create type org_type as enum ('individual', 'school');

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type org_type not null default 'individual',
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create type user_role as enum ('admin', 'tutor', 'parent', 'student');

create table memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role user_role not null,
  unique (organization_id, user_id, role)
);

-- -----------------------------------------------------------
-- ПРОФИЛИ РОЛЕЙ
-- -----------------------------------------------------------
create table tutors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  subjects text[],
  hourly_rate numeric,
  status text not null default 'active',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, organization_id)
);

create table parents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  full_name text,
  phone text,
  email text,
  payment_details text,
  notes text,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------
-- ПОМОЩНИКИ ДЛЯ RLS
-- Клиенту не нужно самому знать/передавать tutor_id или
-- organization_id — эти функции подставляют их автоматически
-- через default-значения колонок и используются в политиках.
-- -----------------------------------------------------------
create or replace function current_tutor_id()
returns uuid
language sql stable
as $$
  select id from tutors where user_id = auth.uid() limit 1;
$$;

create or replace function current_organization_id()
returns uuid
language sql stable
as $$
  select organization_id from memberships
  where user_id = auth.uid() and role = 'tutor'
  limit 1;
$$;

-- -----------------------------------------------------------
-- БУТСТРАП: создаёт организацию + членство + профиль репетитора
-- для только что зарегистрированного пользователя. Идемпотентна —
-- повторный вызов для того же пользователя просто вернёт
-- существующий tutor_id, ничего не дублируя.
-- -----------------------------------------------------------
create or replace function bootstrap_individual_tutor()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_tutor_id uuid;
begin
  select id into v_tutor_id from tutors where user_id = auth.uid() limit 1;
  if v_tutor_id is not null then
    return v_tutor_id;
  end if;

  insert into organizations (name, type, owner_id)
  values ('Мой кабинет', 'individual', auth.uid())
  returning id into v_org_id;

  insert into memberships (organization_id, user_id, role)
  values (v_org_id, auth.uid(), 'tutor');

  insert into tutors (user_id, organization_id)
  values (auth.uid(), v_org_id)
  returning id into v_tutor_id;

  return v_tutor_id;
end;
$$;

grant execute on function bootstrap_individual_tutor() to authenticated;
grant execute on function current_tutor_id() to authenticated;
grant execute on function current_organization_id() to authenticated;

-- -----------------------------------------------------------
-- УЧЕНИКИ (используется приложением уже сейчас)
-- -----------------------------------------------------------
create table students (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_organization_id() references organizations(id) on delete cascade,
  tutor_id uuid not null default current_tutor_id() references tutors(id) on delete cascade,
  parent_id uuid references parents(id) on delete set null,
  name text not null,
  grade text,
  subject text,
  status text not null default 'active',
  price numeric not null default 0,
  duration int not null default 60,
  phone text,
  telegram text,
  comment text,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------
-- ЗАНЯТИЯ (используется приложением уже сейчас)
-- -----------------------------------------------------------
create table lessons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_organization_id() references organizations(id) on delete cascade,
  tutor_id uuid not null default current_tutor_id() references tutors(id) on delete cascade,
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

-- -----------------------------------------------------------
-- РАСХОДЫ (специфика MVP репетитора, вне общего ТЗ)
-- -----------------------------------------------------------
create table expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_organization_id() references organizations(id) on delete cascade,
  tutor_id uuid not null default current_tutor_id() references tutors(id) on delete cascade,
  title text not null,
  amount numeric not null,
  date date not null,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------
-- ЗАДЕЛ НА БУДУЩИЕ ЭТАПЫ (созданы сейчас, чтобы не менять схему
-- позже; приложение их пока не использует)
-- -----------------------------------------------------------
create table recurring_schedules (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  tutor_id uuid not null default current_tutor_id() references tutors(id) on delete cascade,
  weekday int not null,
  start_time time not null,
  duration int not null,
  repeat_type text not null default 'weekly',
  start_date date not null,
  end_date date
);

create table homework (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid references lessons(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  tutor_id uuid not null default current_tutor_id() references tutors(id) on delete cascade,
  description text not null,
  deadline date,
  status text not null default 'created', -- created | submitted | checking | completed
  created_at timestamptz not null default now()
);

create table homework_submissions (
  id uuid primary key default gen_random_uuid(),
  homework_id uuid not null references homework(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  comment text,
  submitted_at timestamptz not null default now()
);

create table lesson_reports (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  tutor_id uuid not null default current_tutor_id() references tutors(id) on delete cascade,
  topic text,
  what_covered text,
  successes text,
  mistakes text,
  recommendations text,
  is_draft boolean not null default false,
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_organization_id() references organizations(id) on delete cascade,
  lesson_id uuid not null references lessons(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  parent_id uuid references parents(id) on delete set null,
  amount numeric not null,
  status text not null default 'awaiting',
  paid_at timestamptz
);

create table penalties (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  amount numeric not null,
  reason text,
  created_by uuid references auth.users(id),
  status text not null default 'applied'
);

create table files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  related_entity text,
  related_id uuid,
  file_url text not null,
  file_type text,
  size int,
  created_at timestamptz not null default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text,
  file_id uuid references files(id),
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  message text not null,
  read_status boolean not null default false,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text,
  title text not null,
  status text not null default 'open',
  deadline timestamptz
);

create table activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  action text not null,
  entity text not null,
  entity_id uuid,
  changes jsonb,
  timestamp timestamptz not null default now()
);

-- ===========================================================
-- ROW LEVEL SECURITY
-- ===========================================================

alter table organizations enable row level security;
create policy "org_select_own" on organizations
  for select using (owner_id = auth.uid() or id = current_organization_id());

alter table memberships enable row level security;
create policy "membership_select_own" on memberships
  for select using (user_id = auth.uid());

alter table tutors enable row level security;
create policy "tutor_select_own" on tutors
  for select using (user_id = auth.uid());
create policy "tutor_update_own" on tutors
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table parents enable row level security;
create policy "parents_tutor_all" on parents
  for all using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());

-- Таблицы, которыми приложение реально пользуется прямо сейчас:
alter table students enable row level security;
create policy "students_tutor_all" on students
  for all using (tutor_id = current_tutor_id())
  with check (tutor_id = current_tutor_id());

alter table lessons enable row level security;
create policy "lessons_tutor_all" on lessons
  for all using (tutor_id = current_tutor_id())
  with check (tutor_id = current_tutor_id());

alter table expenses enable row level security;
create policy "expenses_tutor_all" on expenses
  for all using (tutor_id = current_tutor_id())
  with check (tutor_id = current_tutor_id());

-- Задел на будущее — доступ репетитора к своим данным уже настроен,
-- политики для родителя/ученика/администратора добавятся отдельными
-- миграциями на соответствующих этапах, не трогая эти:
alter table recurring_schedules enable row level security;
create policy "recurring_tutor_all" on recurring_schedules
  for all using (tutor_id = current_tutor_id()) with check (tutor_id = current_tutor_id());

alter table homework enable row level security;
create policy "homework_tutor_all" on homework
  for all using (tutor_id = current_tutor_id()) with check (tutor_id = current_tutor_id());

alter table homework_submissions enable row level security;
create policy "homework_sub_tutor_all" on homework_submissions
  for all using (
    homework_id in (select id from homework where tutor_id = current_tutor_id())
  ) with check (
    homework_id in (select id from homework where tutor_id = current_tutor_id())
  );

alter table lesson_reports enable row level security;
create policy "reports_tutor_all" on lesson_reports
  for all using (tutor_id = current_tutor_id()) with check (tutor_id = current_tutor_id());

alter table payments enable row level security;
create policy "payments_tutor_all" on payments
  for all using (organization_id = current_organization_id()) with check (organization_id = current_organization_id());

alter table penalties enable row level security;
create policy "penalties_tutor_all" on penalties
  for all using (
    lesson_id in (select id from lessons where tutor_id = current_tutor_id())
  ) with check (
    lesson_id in (select id from lessons where tutor_id = current_tutor_id())
  );

alter table files enable row level security;
create policy "files_owner_all" on files
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table documents enable row level security;
create policy "documents_owner_all" on documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table notifications enable row level security;
create policy "notifications_owner_all" on notifications
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table tasks enable row level security;
create policy "tasks_owner_all" on tasks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table activity_log enable row level security;
create policy "activity_owner_select" on activity_log
  for select using (user_id = auth.uid());

-- -----------------------------------------------------------
-- Индексы
-- -----------------------------------------------------------
create index idx_lessons_tutor_date on lessons(tutor_id, date);
create index idx_lessons_student on lessons(student_id);
create index idx_students_tutor on students(tutor_id);
create index idx_expenses_tutor_date on expenses(tutor_id, date);

-- Готово. Схема покрывает всю иерархию из ТЗ (organizations → memberships
-- → tutors/parents/students → lessons → homework/reports/payments и т.д.).
-- Прямо сейчас реально используются students/lessons/expenses под ролью
-- «репетитор» — остальные таблицы уже на месте и ждут своего этапа.
