-- =====================================================================
-- Marketing Operations Marketplace — schema + RBAC  (slice 1)
--
-- New self-contained app on the shared foundation. All objects live in a
-- `mkt_` namespace so they never collide with the ops or storefront tables.
-- Reads the existing shared catalog (toolkit_items) through v_mkt_items;
-- everything else is net-new per Marketing_Ops_Marketplace_Spec.docx §3.
--
-- Auth is Supabase auth.users; the spec's `users` table becomes mkt_members
-- (a profile keyed to the auth user, mirroring customer_profiles).
--
-- RLS model: STRICT and role-scoped (unlike the permissive ops tables).
--   admin            → full access everywhere
--   program_manager  → programs they own + demand/reports on those
--   requester        → programs open in a relevant phase + their own data
-- service_role (server functions: invoicing, reminders) bypasses RLS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type mkt_role           as enum ('admin','program_manager','requester');
create type mkt_program_phase  as enum ('draft','demand_open','review','confirm_open','closed');
create type mkt_demand_status  as enum ('draft','submitted','confirmed','removed');
create type mkt_order_status   as enum ('confirmed','shipped','invoiced');
create type mkt_invoice_status as enum ('issued','void');
create type mkt_comm_type      as enum ('reminder_demand','reminder_confirm','phase_notice','invoice','mass');

-- ---------------------------------------------------------------------
-- 3.1 mkt_members  (spec: users)
--   cost_center is required for requesters. Enforced in the admin UI rather
--   than a hard DB check so invite/onboarding can create the row first, then
--   set the cost center. Revisit if we want a deferred constraint.
-- ---------------------------------------------------------------------
create table mkt_members (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  email       text unique,
  role        mkt_role not null default 'requester',
  cost_center text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_mkt_members_role on mkt_members(role);

-- ---------------------------------------------------------------------
-- 3.2 catalog: reuse toolkit_items via a read view  (spec: items)
--   security_invoker so the caller's RLS on toolkit_items applies (matches
--   toolkit_wide / v_shop_items). `active` = "has a portal price"; refine
--   if a dedicated catalog-active flag is wanted later.
-- ---------------------------------------------------------------------
create view v_mkt_items with (security_invoker = true) as
select
  i.id                    as item_id,
  i.pos_number            as sku,
  i.item_description      as name,
  i.description_extended  as description,
  i.shop_image_url        as image_url,
  i.portal_price          as unit_price,
  (i.portal_price is not null) as active
from toolkit_items i;

-- ---------------------------------------------------------------------
-- 3.3 mkt_programs
-- ---------------------------------------------------------------------
create table mkt_programs (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  phase                mkt_program_phase not null default 'draft',
  demand_deadline      timestamptz,                 -- optional Phase 1 auto-close
  confirm_deadline     timestamptz,                 -- optional Phase 2 auto-close
  description          text,
  owner_id             uuid references mkt_members(id),
  prices_hidden_phase1 boolean not null default true,   -- spec 4.1 per-program toggle
  unconfirmed_policy   text not null default 'lapse',    -- 'lapse' | 'bulk_confirm' (spec 4.1)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint mkt_programs_unconfirmed_policy_chk
    check (unconfirmed_policy in ('lapse','bulk_confirm'))
);
create index idx_mkt_programs_owner on mkt_programs(owner_id);
create index idx_mkt_programs_phase on mkt_programs(phase);

-- ---------------------------------------------------------------------
-- 3.4 mkt_program_items
-- ---------------------------------------------------------------------
create table mkt_program_items (
  program_id uuid not null references mkt_programs(id) on delete cascade,
  item_id    uuid not null references toolkit_items(id),
  min_qty    integer,
  max_qty    integer,
  primary key (program_id, item_id)
);

-- ---------------------------------------------------------------------
-- 3.5 mkt_addresses
--   Dedicated table (not the shop's shipping_addresses) so marketplace
--   members stay independent of storefront customers. Soft delete only.
-- ---------------------------------------------------------------------
create table mkt_addresses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references mkt_members(id) on delete cascade,
  label      text,
  recipient  text,
  street     text,
  city       text,
  state      text,
  zip        text,
  country    text default 'US',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_mkt_addresses_user on mkt_addresses(user_id);

-- ---------------------------------------------------------------------
-- 3.6 mkt_demand_lines  (the two-phase core)
--   qty_phase1 and qty_final on one row so the Phase 1 vs. final delta
--   report is a trivial query and the full audit trail is preserved.
-- ---------------------------------------------------------------------
create table mkt_demand_lines (
  id                  uuid primary key default gen_random_uuid(),
  program_id          uuid not null references mkt_programs(id) on delete cascade,
  user_id             uuid not null references mkt_members(id),
  item_id             uuid not null references toolkit_items(id),
  address_id          uuid references mkt_addresses(id),
  qty_phase1          integer not null default 0,
  qty_final           integer,                 -- null until confirmed
  unit_price_snapshot numeric,                 -- copied from catalog at confirm_open
  status              mkt_demand_status not null default 'draft',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_mkt_demand_program on mkt_demand_lines(program_id);
create index idx_mkt_demand_user    on mkt_demand_lines(user_id);
create index idx_mkt_demand_item    on mkt_demand_lines(item_id);

-- ---------------------------------------------------------------------
-- 3.7 mkt_orders  (one per user per program, created at Phase 2 confirm)
-- ---------------------------------------------------------------------
create table mkt_orders (
  id            uuid primary key default gen_random_uuid(),
  program_id    uuid not null references mkt_programs(id),
  user_id       uuid not null references mkt_members(id),
  status        mkt_order_status not null default 'confirmed',
  shipping_cost numeric,                       -- entered by admin post-close
  shipped_date  date,
  subtotal      numeric,                       -- sum of confirmed lines at snapshot prices
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (program_id, user_id)
);
create index idx_mkt_orders_program on mkt_orders(program_id);
create index idx_mkt_orders_user    on mkt_orders(user_id);

-- ---------------------------------------------------------------------
-- 3.8 mkt_invoices  (internal chargeback; sequential CB-YYYY-NNNNN)
-- ---------------------------------------------------------------------
create sequence mkt_invoice_seq;
create table mkt_invoices (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references mkt_orders(id),
  invoice_number text unique,                  -- assigned by trigger below
  cost_center    text,                         -- snapshot of member.cost_center at generation
  subtotal       numeric,
  shipping       numeric,
  total          numeric,                      -- subtotal + shipping; no tax
  issued_date    date not null default current_date,
  status         mkt_invoice_status not null default 'issued',
  pdf_url        text,
  created_at     timestamptz not null default now()
);
create index idx_mkt_invoices_order on mkt_invoices(order_id);

-- Assign a global sequential invoice number on insert when not supplied.
create or replace function mkt_assign_invoice_number()
returns trigger language plpgsql as $$
begin
  if new.invoice_number is null then
    new.invoice_number :=
      'CB-' || to_char(new.issued_date, 'YYYY') || '-' ||
      lpad(nextval('mkt_invoice_seq')::text, 5, '0');
  end if;
  return new;
end;
$$;
create trigger trg_mkt_invoices_number
  before insert on mkt_invoices
  for each row execute function mkt_assign_invoice_number();

-- ---------------------------------------------------------------------
-- 3.9 mkt_communications  (one row per recipient; delivery log)
-- ---------------------------------------------------------------------
create table mkt_communications (
  id           uuid primary key default gen_random_uuid(),
  type         mkt_comm_type not null,
  program_id   uuid references mkt_programs(id),
  recipient_id uuid references mkt_members(id),
  subject      text,
  body         text,
  sent_at      timestamptz not null default now()
);
create index idx_mkt_comm_recipient on mkt_communications(recipient_id);
create index idx_mkt_comm_program   on mkt_communications(program_id);

-- ---------------------------------------------------------------------
-- updated_at touch triggers (reuse the shared set_updated_at())
-- ---------------------------------------------------------------------
create trigger trg_mkt_members_updated_at    before update on mkt_members    for each row execute function set_updated_at();
create trigger trg_mkt_programs_updated_at   before update on mkt_programs   for each row execute function set_updated_at();
create trigger trg_mkt_addresses_updated_at  before update on mkt_addresses  for each row execute function set_updated_at();
create trigger trg_mkt_demand_updated_at     before update on mkt_demand_lines for each row execute function set_updated_at();
create trigger trg_mkt_orders_updated_at     before update on mkt_orders     for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- RBAC helper — the caller's marketplace role.
--   SECURITY DEFINER so it reads mkt_members regardless of RLS (avoids
--   policy recursion). Locked search_path.
-- ---------------------------------------------------------------------
create or replace function mkt_role()
returns mkt_role
language sql
stable
security definer
set search_path = public
as $$
  select role from mkt_members where id = auth.uid() and active
$$;
grant execute on function mkt_role() to authenticated;

-- =====================================================================
-- Row-level security
-- =====================================================================
alter table mkt_members       enable row level security;
alter table mkt_programs      enable row level security;
alter table mkt_program_items enable row level security;
alter table mkt_addresses     enable row level security;
alter table mkt_demand_lines  enable row level security;
alter table mkt_orders        enable row level security;
alter table mkt_invoices      enable row level security;
alter table mkt_communications enable row level security;

-- ----- members: admin full; everyone sees their own row -----
create policy mkt_members_admin_all on mkt_members for all to authenticated
  using (mkt_role() = 'admin') with check (mkt_role() = 'admin');
create policy mkt_members_self_sel on mkt_members for select to authenticated
  using (id = auth.uid());

-- ----- programs: admin full; PM owns; requesters see open phases -----
create policy mkt_programs_admin_all on mkt_programs for all to authenticated
  using (mkt_role() = 'admin') with check (mkt_role() = 'admin');
create policy mkt_programs_pm_sel on mkt_programs for select to authenticated
  using (owner_id = auth.uid());
create policy mkt_programs_pm_ins on mkt_programs for insert to authenticated
  with check (mkt_role() = 'program_manager' and owner_id = auth.uid());
create policy mkt_programs_pm_upd on mkt_programs for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy mkt_programs_requester_sel on mkt_programs for select to authenticated
  using (phase in ('demand_open','confirm_open'));

-- ----- program_items: writable by admin / owner PM; readable when program visible -----
create policy mkt_program_items_admin_all on mkt_program_items for all to authenticated
  using (mkt_role() = 'admin') with check (mkt_role() = 'admin');
create policy mkt_program_items_pm_all on mkt_program_items for all to authenticated
  using (exists (select 1 from mkt_programs p where p.id = program_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from mkt_programs p where p.id = program_id and p.owner_id = auth.uid()));
create policy mkt_program_items_visible_sel on mkt_program_items for select to authenticated
  using (exists (select 1 from mkt_programs p where p.id = program_id and p.phase in ('demand_open','confirm_open')));

-- ----- addresses: owner full; admin full (manage any user's) -----
create policy mkt_addresses_admin_all on mkt_addresses for all to authenticated
  using (mkt_role() = 'admin') with check (mkt_role() = 'admin');
create policy mkt_addresses_owner_all on mkt_addresses for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- demand_lines: owner full; admin full; owner PM read -----
create policy mkt_demand_admin_all on mkt_demand_lines for all to authenticated
  using (mkt_role() = 'admin') with check (mkt_role() = 'admin');
create policy mkt_demand_owner_all on mkt_demand_lines for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mkt_demand_pm_sel on mkt_demand_lines for select to authenticated
  using (exists (select 1 from mkt_programs p where p.id = program_id and p.owner_id = auth.uid()));

-- ----- orders: owner select/insert own; admin full; owner PM read -----
create policy mkt_orders_admin_all on mkt_orders for all to authenticated
  using (mkt_role() = 'admin') with check (mkt_role() = 'admin');
create policy mkt_orders_owner_sel on mkt_orders for select to authenticated
  using (user_id = auth.uid());
create policy mkt_orders_owner_ins on mkt_orders for insert to authenticated
  with check (user_id = auth.uid());
create policy mkt_orders_pm_sel on mkt_orders for select to authenticated
  using (exists (select 1 from mkt_programs p where p.id = program_id and p.owner_id = auth.uid()));

-- ----- invoices: order owner reads; admin full (generation is server-side) -----
create policy mkt_invoices_admin_all on mkt_invoices for all to authenticated
  using (mkt_role() = 'admin') with check (mkt_role() = 'admin');
create policy mkt_invoices_owner_sel on mkt_invoices for select to authenticated
  using (exists (select 1 from mkt_orders o where o.id = order_id and o.user_id = auth.uid()));

-- ----- communications: recipient reads own; admin full -----
create policy mkt_comm_admin_all on mkt_communications for all to authenticated
  using (mkt_role() = 'admin') with check (mkt_role() = 'admin');
create policy mkt_comm_recipient_sel on mkt_communications for select to authenticated
  using (recipient_id = auth.uid());
