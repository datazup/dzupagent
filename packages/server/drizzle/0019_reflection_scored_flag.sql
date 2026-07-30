-- Distinguish an unscored reflection from a perfect one.
--
-- `quality_score` is computed by subtracting evidence-driven penalties from a
-- 1.0 seed, so a run that produced no workflow events kept the full 1.0 and was
-- stored as a flawless run. Consumers filtering for low quality therefore
-- skipped precisely the runs nothing was known about, and the run that was
-- never observed ranked above every run that was.
--
-- DEFAULT TRUE is deliberate for the back-fill. Every existing row was written
-- by a scorer with no way to express "unscored", so its score is the best
-- measurement that scorer could produce. Back-filling FALSE would relabel real
-- measurements as absent ones; the ambiguity only exists going forward, where
-- the writer can now state which it is.

ALTER TABLE "run_reflections"
  ADD COLUMN IF NOT EXISTS "scored" boolean NOT NULL DEFAULT true;
