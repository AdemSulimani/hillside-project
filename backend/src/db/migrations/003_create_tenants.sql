CREATE TABLE IF NOT EXISTS tenants (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(255)  NOT NULL,
  niche             VARCHAR(255)  NOT NULL,
  description       TEXT,
  delivery_methods  JSONB         NOT NULL DEFAULT '[]'::jsonb,
  country           VARCHAR(100)  NOT NULL,
  currency          VARCHAR(10)   NOT NULL DEFAULT 'USD',
  logo_url          VARCHAR(512),
  plan              VARCHAR(50)   NOT NULL DEFAULT 'free',
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
