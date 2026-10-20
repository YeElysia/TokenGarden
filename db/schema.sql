-- Safe to run for both a fresh database and the original TokenGarden schema.
-- Existing rows are assigned to CCS; adjust their source first if needed.
BEGIN;
CREATE TABLE IF NOT EXISTS usage_daily (
 date DATE NOT NULL,
 source TEXT NOT NULL DEFAULT 'ccs',
 device TEXT NOT NULL,
 client TEXT NOT NULL,
 model TEXT NOT NULL,
 input_tokens BIGINT NOT NULL CHECK(input_tokens >= 0),
 output_tokens BIGINT NOT NULL CHECK(output_tokens >= 0),
 cached_input_tokens BIGINT NOT NULL CHECK(cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
 request_count INTEGER CHECK(request_count >= 0),
 PRIMARY KEY(date,source,device,client,model)
);
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ccs';
ALTER TABLE usage_daily ALTER COLUMN request_count DROP NOT NULL;
ALTER TABLE usage_daily DROP CONSTRAINT IF EXISTS usage_daily_source_check;
ALTER TABLE usage_daily ADD CONSTRAINT usage_daily_source_check CHECK(source IN ('ccs','dsh'));
ALTER TABLE usage_daily DROP CONSTRAINT IF EXISTS usage_daily_pkey;
ALTER TABLE usage_daily ADD PRIMARY KEY(date,source,device,client,model);

-- One row serializes a channel/device/day merge; revision records the maximum seen version.
CREATE TABLE IF NOT EXISTS usage_uploads (
 date DATE NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('ccs','dsh')),
 device TEXT NOT NULL,
 revision BIGINT NOT NULL CHECK(revision > 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(date,source,device)
);

CREATE OR REPLACE FUNCTION replace_usage_snapshot(
 p_source TEXT, p_device TEXT, p_date DATE, p_revision BIGINT, p_rows JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE changed_rows INTEGER;
BEGIN
 IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
  RAISE EXCEPTION 'rows must be an array';
 END IF;
 -- The conflicting upload row is locked until the transaction completes.
 INSERT INTO usage_uploads(date,source,device,revision,updated_at)
 VALUES(p_date,p_source,p_device,p_revision,clock_timestamp())
 ON CONFLICT(date,source,device) DO UPDATE
 SET revision=GREATEST(usage_uploads.revision,EXCLUDED.revision), updated_at=EXCLUDED.updated_at;

 INSERT INTO usage_daily(date,source,device,client,model,input_tokens,output_tokens,cached_input_tokens,request_count)
 SELECT p_date,p_source,p_device,r.client,r.model,r.input,r.output,r.cached,r.requests
 FROM jsonb_to_recordset(p_rows) AS r(client TEXT,model TEXT,input BIGINT,output BIGINT,cached BIGINT,requests INTEGER)
 ON CONFLICT(date,source,device,client,model) DO UPDATE
 SET input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens,
     cached_input_tokens=EXCLUDED.cached_input_tokens, request_count=EXCLUDED.request_count
 WHERE EXCLUDED.input_tokens+EXCLUDED.output_tokens > usage_daily.input_tokens+usage_daily.output_tokens;
 GET DIAGNOSTICS changed_rows = ROW_COUNT;
 RETURN changed_rows > 0;
END;
$$;
COMMIT;
