-- =====================================================================
-- Marketplace — state-machine RPCs + member self-registration (slice 2)
--
-- The phase engine and order confirmation live server-side as SECURITY
-- DEFINER functions so snapshot discipline and transition rules cannot be
-- bypassed by client code:
--   mkt_advance_phase(program, new_phase) — admin/owner-PM only; snapshots
--     catalog prices onto demand lines whenever the program enters
--     confirm_open (spec §4: prices frozen at confirmation open; re-entering
--     review and advancing again re-snapshots per §4.1).
--   mkt_confirm_order(program)            — requester Phase 2 confirm:
--     defaults qty_final to qty_phase1, marks lines confirmed/removed,
--     computes subtotal at snapshot prices, creates the one-per-user order.
--   mkt_generate_invoice(order)           — admin post-close: voids any prior
--     issued invoice (regeneration policy §6), snapshots the member's cost
--     center, computes totals (no tax), marks the order invoiced.
-- =====================================================================

-- Members may register themselves, but only as requesters; admins set roles.
create policy mkt_members_self_ins on mkt_members for insert to authenticated
  with check (id = auth.uid() and role = 'requester');

-- ---------------------------------------------------------------------
create or replace function mkt_advance_phase(p_program uuid, p_phase mkt_program_phase)
returns mkt_programs
language plpgsql security definer set search_path = public as $$
declare
  prog mkt_programs;
begin
  select * into prog from mkt_programs where id = p_program for update;
  if prog.id is null then
    raise exception 'program not found';
  end if;
  if not (mkt_role() = 'admin' or prog.owner_id = auth.uid()) then
    raise exception 'not allowed: admin or owning program manager only';
  end if;
  if prog.phase = p_phase then
    return prog;
  end if;

  update mkt_programs set phase = p_phase where id = p_program;

  -- Entering confirm_open freezes prices onto the demand lines.
  if p_phase = 'confirm_open' then
    update mkt_demand_lines dl
       set unit_price_snapshot = i.portal_price
      from toolkit_items i
     where i.id = dl.item_id
       and dl.program_id = p_program
       and dl.status in ('draft','submitted');
  end if;

  select * into prog from mkt_programs where id = p_program;
  return prog;
end;
$$;
grant execute on function mkt_advance_phase(uuid, mkt_program_phase) to authenticated;

-- ---------------------------------------------------------------------
create or replace function mkt_confirm_order(p_program uuid)
returns mkt_orders
language plpgsql security definer set search_path = public as $$
declare
  prog  mkt_programs;
  ord   mkt_orders;
  v_sub numeric;
begin
  select * into prog from mkt_programs where id = p_program;
  if prog.id is null or prog.phase <> 'confirm_open' then
    raise exception 'program is not open for confirmation';
  end if;
  if exists (select 1 from mkt_orders where program_id = p_program and user_id = auth.uid()) then
    raise exception 'already confirmed for this program';
  end if;

  -- Default final qty to the Phase 1 ask, then settle line statuses.
  update mkt_demand_lines
     set qty_final = coalesce(qty_final, qty_phase1)
   where program_id = p_program and user_id = auth.uid()
     and status in ('draft','submitted');

  update mkt_demand_lines
     set status = case when coalesce(qty_final,0) > 0 then 'confirmed'::mkt_demand_status
                       else 'removed'::mkt_demand_status end
   where program_id = p_program and user_id = auth.uid()
     and status in ('draft','submitted');

  select coalesce(sum(qty_final * coalesce(unit_price_snapshot,0)),0) into v_sub
    from mkt_demand_lines
   where program_id = p_program and user_id = auth.uid() and status = 'confirmed';

  if not exists (select 1 from mkt_demand_lines
                  where program_id = p_program and user_id = auth.uid() and status = 'confirmed') then
    raise exception 'nothing to confirm — all lines are empty or removed';
  end if;

  insert into mkt_orders (program_id, user_id, subtotal)
  values (p_program, auth.uid(), v_sub)
  returning * into ord;
  return ord;
end;
$$;
grant execute on function mkt_confirm_order(uuid) to authenticated;

-- ---------------------------------------------------------------------
create or replace function mkt_generate_invoice(p_order uuid)
returns mkt_invoices
language plpgsql security definer set search_path = public as $$
declare
  ord mkt_orders;
  inv mkt_invoices;
  cc  text;
begin
  if mkt_role() <> 'admin' then
    raise exception 'not allowed: admin only';
  end if;
  select * into ord from mkt_orders where id = p_order for update;
  if ord.id is null then
    raise exception 'order not found';
  end if;
  if ord.shipping_cost is null then
    raise exception 'enter shipping cost before generating the invoice';
  end if;

  -- Regeneration voids the prior issued invoice (kept for audit).
  update mkt_invoices set status = 'void' where order_id = p_order and status = 'issued';

  select cost_center into cc from mkt_members where id = ord.user_id;

  insert into mkt_invoices (order_id, cost_center, subtotal, shipping, total)
  values (p_order, cc, ord.subtotal, ord.shipping_cost, coalesce(ord.subtotal,0) + ord.shipping_cost)
  returning * into inv;

  update mkt_orders set status = 'invoiced' where id = p_order;
  return inv;
end;
$$;
grant execute on function mkt_generate_invoice(uuid) to authenticated;
