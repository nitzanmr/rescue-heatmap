-- 0020_logistics_layers.sql — fuel and markets as first-class aid_site kinds.
--
-- WHY a migration and not just an import. `aid_site.kind` carries a CHECK
-- constraint (0008). Loading a GeoJSON with kind='fuel' against an unmigrated
-- database does not warn and does not partially succeed — it raises on the
-- first row, and the operator reads "import failed" with no clue that the
-- schema is one version behind. Class D/E in the bug ledger: the environment
-- must be told, not guessed.
--
-- WHY these two kinds and not "logistics". A delegation asks two questions
-- before its first tasking — where do we refuel, and where do we buy food and
-- water — and asks them again every morning. They are different answers with
-- different failure modes (a closed pump strands a vehicle; a closed shop costs
-- an hour), so they are two kinds, filterable separately.
--
-- WHAT THIS IS NOT. These are institutions from OpenStreetMap: unverified by
-- construction, `status` unknown, and after an earthquake a pump with no power
-- is a pump that is closed. The map draws them dashed and the popup says
-- confirm before travelling. We are publishing a *starting list*, not a claim
-- that anything is open.
--
-- Append-only: 0008 is not edited. The CHECK is replaced by name, which is the
-- one safe way to widen an enumerated column without rewriting history.

ALTER TABLE aid_site DROP CONSTRAINT IF EXISTS aid_site_kind_check;

ALTER TABLE aid_site ADD CONSTRAINT aid_site_kind_check CHECK (kind IN (
  'shelter', 'shelter_candidate', 'medical', 'pharmacy',
  'responder', 'supply', 'water', 'morgue', 'info_point',
  -- new in 0020
  'fuel', 'market',
  'other'));

-- public.aid_sites() filters by kind and needs no change: it already accepts an
-- arbitrary text[]. Re-declared here only so a reader of the newest migration
-- can see what the public map is allowed to read, without opening 0008.
--
-- (No CREATE OR REPLACE — the body is unchanged, and replacing a function to
-- say "unchanged" is how a body silently drifts from the one that was tested.)
