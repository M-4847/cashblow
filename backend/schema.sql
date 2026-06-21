-- ============================================================
--  CashFlowIQ — PostgreSQL Schema
--  Generated from frontend data model + canonical formula registry
--  Compatible with PostgreSQL 14+
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  1. COMPANY  (your entity — the seller)
-- ============================================================
CREATE TABLE IF NOT EXISTS companies (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(255)    NOT NULL,
    gstin               VARCHAR(15),
    pan                 VARCHAR(10),
    address             TEXT,
    industry            VARCHAR(100),
    working_capital     NUMERIC(15,2)   DEFAULT 0,   -- used in WC utilisation formulas
    cost_of_equity      NUMERIC(5,2)    DEFAULT 12.00, -- % p.a., used in financing cost calcs
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  2. BUYERS
-- ============================================================
CREATE TABLE IF NOT EXISTS buyers (
    id                  VARCHAR(20)     PRIMARY KEY,  -- e.g. BUY-001
    company_id          UUID            REFERENCES companies(id) ON DELETE SET NULL,
    name                VARCHAR(255)    NOT NULL,
    code                VARCHAR(10)     NOT NULL,     -- short code e.g. RAL
    industry            VARCHAR(100),
    cluster             VARCHAR(100),
    trade_term          VARCHAR(20)     CHECK (trade_term IN ('Credit','Advance','LC','Hybrid')),
    risk_score          NUMERIC(5,2),                -- computed: Buyer Risk Score formula
    credit_limit        NUMERIC(15,2)   DEFAULT 0,
    outstanding         NUMERIC(15,2)   DEFAULT 0,   -- live outstanding balance
    contact_name        VARCHAR(255),
    contact_email       VARCHAR(255),
    contact_phone       VARCHAR(20),
    gstin               VARCHAR(15),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  3. ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
    id                  VARCHAR(20)     PRIMARY KEY,  -- e.g. ORD-001
    buyer_id            VARCHAR(20)     REFERENCES buyers(id) ON DELETE SET NULL,
    buyer_name          VARCHAR(255),
    product             VARCHAR(255),
    quantity            INTEGER         DEFAULT 1,
    unit_price          NUMERIC(15,2),
    total_value         NUMERIC(15,2)   NOT NULL,
    order_date          DATE,
    expected_delivery   DATE,
    status              VARCHAR(50)     CHECK (status IN ('Pending','Processing','Confirmed','Delivered','Cancelled')),
    payment_terms       VARCHAR(50),
    po_number           VARCHAR(50),
    cluster             VARCHAR(100),
    -- Snapshot of simulator decision at time of acceptance (optional)
    sim_snapshot        JSONB,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  4. INVOICES
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
    id                  VARCHAR(20)     PRIMARY KEY,  -- e.g. INV-001
    order_id            VARCHAR(20)     REFERENCES orders(id) ON DELETE SET NULL,
    buyer_id            VARCHAR(20)     REFERENCES buyers(id) ON DELETE SET NULL,
    buyer_name          VARCHAR(255),
    amount              NUMERIC(15,2)   NOT NULL,
    issued_date         DATE            NOT NULL,
    due_date            DATE            NOT NULL,
    trade_term          VARCHAR(20),
    status              VARCHAR(50)     CHECK (status IN ('Pending','Paid','Overdue','Disputed','Verified','Accepted')),
    paid_date           DATE,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  5. INVOICE ACCEPTANCES  (Invoice Acceptance Hub)
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_acceptances (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id          VARCHAR(20)     NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    buyer_id            VARCHAR(20)     REFERENCES buyers(id) ON DELETE SET NULL,
    status              VARCHAR(30)     CHECK (status IN ('Pending','Verified','Disputed','Overdue')),
    accepted_date       DATE,
    dispute_reason      TEXT,
    accepted_terms_days INTEGER,        -- agreed credit period in days
    actual_pay_days     INTEGER,        -- how long buyer actually took
    verification_score  NUMERIC(5,2),  -- computed: IAH verification score
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  6. RECEIVABLES
-- ============================================================
CREATE TABLE IF NOT EXISTS receivables (
    id                  VARCHAR(20)     PRIMARY KEY,  -- e.g. REC-001
    buyer_id            VARCHAR(20)     REFERENCES buyers(id) ON DELETE SET NULL,
    buyer_name          VARCHAR(255),
    invoice_id          VARCHAR(20)     REFERENCES invoices(id) ON DELETE SET NULL,
    amount              NUMERIC(15,2)   NOT NULL,
    due_date            DATE,
    days_overdue        INTEGER         DEFAULT 0,
    status              VARCHAR(50),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  7. COLLECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS collections (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id            VARCHAR(20)     REFERENCES buyers(id) ON DELETE SET NULL,
    invoice_id          VARCHAR(20)     REFERENCES invoices(id) ON DELETE SET NULL,
    receivable_id       VARCHAR(20)     REFERENCES receivables(id) ON DELETE SET NULL,
    amount              NUMERIC(15,2)   NOT NULL,
    scheduled_date      DATE,
    collected_date      DATE,
    status              VARCHAR(30)     CHECK (status IN ('Pending','Collected','Partial','Delayed','Failed')),
    collection_confidence NUMERIC(5,2), -- computed: Collection Confidence formula
    delay_days          INTEGER         DEFAULT 0,
    notes               TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  8. TRADE AGREEMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS trade_agreements (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            VARCHAR(20)     REFERENCES orders(id) ON DELETE SET NULL,
    buyer_id            VARCHAR(20)     REFERENCES buyers(id) ON DELETE SET NULL,
    buyer_name          VARCHAR(255),
    buyer_email         VARCHAR(255),
    order_value         NUMERIC(15,2),
    order_date          DATE,
    delivery_period     VARCHAR(255),
    delivery_location   VARCHAR(255),
    payment_terms       VARCHAR(255),
    advance_payment     VARCHAR(255),
    credit_period       VARCHAR(255),
    late_payment_clause TEXT,
    inspection_period   VARCHAR(255),
    warranty_period     VARCHAR(255),
    special_conditions  TEXT,
    status              VARCHAR(30)     CHECK (status IN ('draft','sent','viewed','accepted','rejected','changes-requested')),
    sent_at             TIMESTAMPTZ,
    viewed_at           TIMESTAMPTZ,
    responded_at        TIMESTAMPTZ,
    sim_score           NUMERIC(5,2),   -- order impact score from simulator
    risk_score          NUMERIC(5,2),   -- buyer risk score at time of agreement
    from_simulator      BOOLEAN         DEFAULT FALSE,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  9. PAYMENT HISTORY  (per-payment record for each buyer)
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_history (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id            VARCHAR(20)     NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
    invoice_id          VARCHAR(20)     REFERENCES invoices(id) ON DELETE SET NULL,
    amount              NUMERIC(15,2)   NOT NULL,
    due_date            DATE            NOT NULL,
    paid_date           DATE,
    delay_days          INTEGER         DEFAULT 0,
    on_time             BOOLEAN,        -- paid_date <= due_date
    trade_term          VARCHAR(20),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  10. ALERTS
-- ============================================================
CREATE TABLE IF NOT EXISTS alerts (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    type                VARCHAR(50)     CHECK (type IN ('overdue','risk','concentration','cashflow','acceptance','collection')),
    severity            VARCHAR(20)     CHECK (severity IN ('low','medium','high','critical')),
    title               VARCHAR(255)    NOT NULL,
    message             TEXT,
    buyer_id            VARCHAR(20)     REFERENCES buyers(id) ON DELETE SET NULL,
    invoice_id          VARCHAR(20)     REFERENCES invoices(id) ON DELETE SET NULL,
    order_id            VARCHAR(20)     REFERENCES orders(id) ON DELETE SET NULL,
    is_read             BOOLEAN         DEFAULT FALSE,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  11. SIMULATION LOG  (every Order Simulator run is stored)
-- ============================================================
CREATE TABLE IF NOT EXISTS simulation_log (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id                VARCHAR(20) REFERENCES buyers(id) ON DELETE SET NULL,
    order_value             NUMERIC(15,2),
    credit_terms_days       INTEGER,
    gross_margin            NUMERIC(5,2),
    working_capital         NUMERIC(15,2),
    current_credit_exposure NUMERIC(15,2),
    decision                VARCHAR(100),
    order_impact_score      INTEGER,
    risk_score_at_sim       NUMERIC(5,2),
    result_snapshot         JSONB,      -- full engine output stored for audit
    accepted                BOOLEAN     DEFAULT FALSE,
    order_id                VARCHAR(20) REFERENCES orders(id) ON DELETE SET NULL,
    simulated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
--  INDEXES  (performance for common query patterns)
-- ============================================================

-- Buyers
CREATE INDEX IF NOT EXISTS idx_buyers_company    ON buyers(company_id);
CREATE INDEX IF NOT EXISTS idx_buyers_risk       ON buyers(risk_score);
CREATE INDEX IF NOT EXISTS idx_buyers_cluster    ON buyers(cluster);

-- Orders
CREATE INDEX IF NOT EXISTS idx_orders_buyer      ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date       ON orders(order_date DESC);

-- Invoices
CREATE INDEX IF NOT EXISTS idx_invoices_buyer    ON invoices(buyer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due      ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_order    ON invoices(order_id);

-- Invoice Acceptances
CREATE INDEX IF NOT EXISTS idx_ia_invoice        ON invoice_acceptances(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ia_buyer          ON invoice_acceptances(buyer_id);
CREATE INDEX IF NOT EXISTS idx_ia_status         ON invoice_acceptances(status);

-- Receivables
CREATE INDEX IF NOT EXISTS idx_rec_buyer         ON receivables(buyer_id);
CREATE INDEX IF NOT EXISTS idx_rec_overdue       ON receivables(days_overdue);

-- Collections
CREATE INDEX IF NOT EXISTS idx_col_buyer         ON collections(buyer_id);
CREATE INDEX IF NOT EXISTS idx_col_status        ON collections(status);
CREATE INDEX IF NOT EXISTS idx_col_sched         ON collections(scheduled_date);

-- Payment History
CREATE INDEX IF NOT EXISTS idx_ph_buyer          ON payment_history(buyer_id);
CREATE INDEX IF NOT EXISTS idx_ph_due            ON payment_history(due_date);

-- Alerts
CREATE INDEX IF NOT EXISTS idx_alerts_buyer      ON alerts(buyer_id);
CREATE INDEX IF NOT EXISTS idx_alerts_unread     ON alerts(is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_alerts_severity   ON alerts(severity);

-- Simulation Log
CREATE INDEX IF NOT EXISTS idx_sim_buyer         ON simulation_log(buyer_id);
CREATE INDEX IF NOT EXISTS idx_sim_at            ON simulation_log(simulated_at DESC);

-- ============================================================
--  VIEWS  (pre-built for dashboard + engine queries)
-- ============================================================

-- Dashboard summary view
CREATE OR REPLACE VIEW v_dashboard_summary AS
SELECT
    (SELECT COALESCE(SUM(total_value),0) FROM orders WHERE status NOT IN ('Cancelled','Delivered')) AS active_order_value,
    (SELECT COALESCE(SUM(amount),0)      FROM receivables WHERE days_overdue > 0)                  AS overdue_receivables,
    (SELECT COALESCE(SUM(amount),0)      FROM invoices WHERE status = 'Paid'
        AND DATE_TRUNC('month', paid_date) = DATE_TRUNC('month', NOW()))                           AS collected_this_month,
    (SELECT COALESCE(SUM(amount),0)      FROM invoices WHERE status IN ('Pending','Overdue'))       AS pending_clearance,
    (SELECT COUNT(*)                     FROM buyers WHERE risk_score < 45)                        AS high_risk_buyer_count,
    (SELECT COUNT(*)                     FROM invoices)                                             AS total_invoices,
    (SELECT COUNT(*)                     FROM invoice_acceptances WHERE status = 'Pending')        AS pending_acceptance_count,
    (SELECT COALESCE(SUM(i.amount),0)    FROM invoice_acceptances ia JOIN invoices i ON ia.invoice_id=i.id WHERE ia.status='Pending') AS pending_acceptance_value,
    (SELECT COUNT(*)                     FROM invoice_acceptances WHERE status = 'Verified')       AS verified_count,
    (SELECT COALESCE(SUM(i.amount),0)    FROM invoice_acceptances ia JOIN invoices i ON ia.invoice_id=i.id WHERE ia.status='Verified') AS verified_value,
    (SELECT COUNT(*)                     FROM invoice_acceptances WHERE status = 'Disputed')       AS disputed_count,
    (SELECT COUNT(*)                     FROM invoice_acceptances WHERE status = 'Overdue')        AS overdue_count;

-- Buyer risk profile view  (feeds RiskEngine + OASEngine)
CREATE OR REPLACE VIEW v_buyer_risk_profile AS
SELECT
    b.id,
    b.name,
    b.code,
    b.industry,
    b.cluster,
    b.trade_term,
    b.credit_limit,
    b.outstanding,
    b.risk_score,
    COALESCE(ph.total_payments, 0)                                      AS total_payments,
    COALESCE(ph.on_time_count, 0)                                       AS on_time_count,
    COALESCE(ph.avg_delay, 0)                                           AS avg_delay_days,
    COALESCE(ph.max_delay, 0)                                           AS max_delay_days,
    CASE WHEN ph.total_payments > 0
         THEN ROUND(ph.on_time_count::NUMERIC / ph.total_payments * 100, 1)
         ELSE 0 END                                                     AS on_time_rate_pct,
    COALESCE(ia.acceptance_rate, 0)                                     AS acceptance_rate_pct,
    COALESCE(ia.avg_accept_days, 0)                                     AS avg_accept_days,
    COALESCE(ia.dispute_freq, 0)                                        AS dispute_freq_pct,
    CASE WHEN b.credit_limit > 0
         THEN ROUND(b.outstanding / b.credit_limit * 100, 1)
         ELSE 0 END                                                     AS credit_utilisation_pct
FROM buyers b
LEFT JOIN (
    SELECT buyer_id,
           COUNT(*)                             AS total_payments,
           COUNT(*) FILTER (WHERE on_time)     AS on_time_count,
           ROUND(AVG(delay_days)::NUMERIC, 1)  AS avg_delay,
           MAX(delay_days)                      AS max_delay
    FROM payment_history
    GROUP BY buyer_id
) ph ON ph.buyer_id = b.id
LEFT JOIN (
    SELECT ia.buyer_id,
           ROUND(COUNT(*) FILTER (WHERE ia.status='Verified')::NUMERIC / NULLIF(COUNT(*),0) * 100, 1) AS acceptance_rate,
           ROUND(AVG(ia.actual_pay_days)::NUMERIC, 1)                                                  AS avg_accept_days,
           ROUND(COUNT(*) FILTER (WHERE ia.status='Disputed')::NUMERIC / NULLIF(COUNT(*),0) * 100, 1) AS dispute_freq
    FROM invoice_acceptances ia
    GROUP BY ia.buyer_id
) ia ON ia.buyer_id = b.id;

-- Receivables aging view  (feeds CashFlowForecast + OASEngine)
CREATE OR REPLACE VIEW v_receivables_aging AS
SELECT
    buyer_id,
    SUM(amount) FILTER (WHERE days_overdue = 0)                        AS current_amt,
    SUM(amount) FILTER (WHERE days_overdue BETWEEN 1  AND 30)          AS overdue_1_30,
    SUM(amount) FILTER (WHERE days_overdue BETWEEN 31 AND 60)          AS overdue_31_60,
    SUM(amount) FILTER (WHERE days_overdue > 60)                       AS overdue_60_plus,
    SUM(amount)                                                         AS total_outstanding
FROM receivables
GROUP BY buyer_id;

-- Portfolio position view  (feeds OASEngine.getPortfolioPosition)
CREATE OR REPLACE VIEW v_portfolio_position AS
SELECT
    SUM(r.amount)                                                        AS total_receivables,
    SUM(r.amount) FILTER (WHERE r.days_overdue > 0)                    AS delayed_collections,
    SUM(r.amount) FILTER (WHERE r.days_overdue > 60)                   AS at_risk_amount,
    SUM(o.total_value) FILTER (WHERE o.status IN ('Pending','Processing')) AS open_orders_total,
    SUM(r.amount) FILTER (WHERE b.risk_score < 45)                     AS high_risk_exposure,
    COUNT(DISTINCT r.buyer_id)                                          AS active_buyers
FROM receivables r
LEFT JOIN buyers b ON b.id = r.buyer_id
LEFT JOIN orders o ON o.buyer_id = r.buyer_id;

-- ============================================================
--  CANONICAL FORMULA COMMENTS  (reference for backend engine)
-- ============================================================

COMMENT ON VIEW v_buyer_risk_profile IS
'Buyer Risk Score = PaymentBehaviour×0.40 + AvgDelay×0.20 + AcceptanceRate×0.15 + ExposureUtil×0.15 + DisputeFreq×0.10';

COMMENT ON TABLE collections IS
'Collection Confidence = AcceptanceRate×0.30 + HistoricalCollections×0.30 + DelayTrend×0.20 + DisputeRate×0.20';

COMMENT ON TABLE simulation_log IS
'Order Acceptance Score = BuyerRisk×0.35 + WCImpact×0.20 + PortfolioHealth×0.20 + ExposureImpact×0.10 + DelayProb×0.15
 Cash Stress Score = OverdueRatio×0.50 + HighRiskRatio×0.35 + ConcentRatio×0.15
 Financing Readiness = ReceivableConf×0.55 + CollectionConf×0.45';
