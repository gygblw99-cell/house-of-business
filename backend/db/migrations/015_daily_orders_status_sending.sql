-- daily_orders.status's CHECK constraint never included 'sending', the interim
-- claim value order.sender.js's confirmAndSend() atomically sets to prevent a
-- double-click/retry from sending the same order twice. Every call to
-- confirmAndSend() throws a CHECK-violation 500 as a result — the entire
-- supplier order-send feature (both "confirm order" and "resend") is broken.
ALTER TABLE daily_orders DROP CONSTRAINT IF EXISTS daily_orders_status_check;
ALTER TABLE daily_orders ADD CONSTRAINT daily_orders_status_check
  CHECK (status IN ('pending','sending','sent','confirmed','skipped','cancelled'));
