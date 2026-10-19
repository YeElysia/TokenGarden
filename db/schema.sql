-- Public display projection. Input includes cached input; output includes reasoning.
CREATE TABLE IF NOT EXISTS usage_daily (
 date DATE NOT NULL,
 device TEXT NOT NULL,
 client TEXT NOT NULL,
 model TEXT NOT NULL,
 input_tokens BIGINT NOT NULL CHECK(input_tokens >= 0),
 output_tokens BIGINT NOT NULL CHECK(output_tokens >= 0),
 cached_input_tokens BIGINT NOT NULL CHECK(cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
 request_count INTEGER NOT NULL CHECK(request_count >= 0),
 PRIMARY KEY(date,device,client,model)
);
