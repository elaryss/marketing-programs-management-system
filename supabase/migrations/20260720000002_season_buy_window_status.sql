-- Add a "Buy Window" lifecycle status to seasons.
--
-- A season in this status is "open to the storefront": the customer-facing
-- shop (site/shop.html) lists items belonging to any season whose status is
-- 'Buy Window'. This is the switch the ops team flips to publish a season for
-- ordering.
--
-- Kept as its own migration because a newly-added enum value cannot be USED in
-- the same transaction that adds it (Postgres restriction). The storefront
-- tables + view that reference it live in the next migration.

ALTER TYPE season_status ADD VALUE IF NOT EXISTS 'Buy Window';
