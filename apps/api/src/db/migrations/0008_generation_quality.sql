-- Additive storage for card-generation quality scores and provider-call usage.

CREATE TABLE IF NOT EXISTS generation_quality_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  candidate_index INTEGER NOT NULL,
  clarity NUMERIC(3,2) NOT NULL,
  groundedness NUMERIC(3,2) NOT NULL,
  non_triviality NUMERIC(3,2) NOT NULL,
  drop_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generation_quality_scores_job_idx ON generation_quality_scores (job_id);

CREATE TABLE IF NOT EXISTS generation_provider_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS generation_provider_calls_user_idx ON generation_provider_calls (user_id, called_at);
