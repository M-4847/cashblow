/**
 * CashFlowIQ — Express.js API Server
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in Supabase values
 *   2. npm install
 *   3. node server.js
 *   4. In cashflowiq.html set: window.CFIQ_API_BASE = 'http://localhost:4000'
 */

require('dotenv').config();
const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const XLSX     = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const JWT_SECRET  = process.env.JWT_SECRET || 'cfiq-dev-secret-change-in-prod';
const JWT_EXPIRES = '7d';

const app  = express();
const port = process.env.PORT || 4000;

// ── Database (Supabase PostgreSQL) ──────────────────────────────────────────
// Supabase requires SSL — rejectUnauthorized:false accepts their self-signed cert
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase requires this in all environments
});

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());
app.use(requestLogger);

function requestLogger(req, _res, next) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
}

// Auth middleware — verifies JWT token
function auth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

// ============================================================
//  AUTH
// ============================================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1 AND is_active=true', [email.toLowerCase().trim()]);
    if (!rows.length) return res.status(401).json({ message: 'Invalid email or password' });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ message: 'Invalid email or password' });
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name, companyId: user.company_id },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
    await db.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, companyId: user.company_id } });
  } catch(e) {
    console.error(e);
    res.status(500).json({ message: 'Login failed' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, email, name, company_id FROM users WHERE id=$1', [req.user.userId]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    res.json(rows[0]);
  } catch(e) {
    res.status(500).json({ message: 'Failed to fetch user' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', auth, (_req, res) => {
  res.status(204).send();
});

// POST /api/auth/register  (public — self-registration)
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, companyName } = req.body;
  if (!email || !password || !name || !companyName)
    return res.status(400).json({ message: 'email, password, name and companyName required' });
  if (password.length < 6)
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  try {
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (existing.rows.length) return res.status(409).json({ message: 'An account with this email already exists' });
    const companyRes = await db.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [companyName]);
    const companyId = companyRes.rows[0].id;
    const hash = await bcrypt.hash(password, 10);
    const userRes = await db.query(
      `INSERT INTO users (email, password_hash, name, company_id) VALUES ($1,$2,$3,$4) RETURNING id, email, name, company_id`,
      [email.toLowerCase().trim(), hash, name, companyId]
    );
    const user = userRes.rows[0];
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name, companyId: user.company_id },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, companyId: user.company_id } });
  } catch(e) {
    console.error(e);
    res.status(500).json({ message: 'Registration failed' });
  }
});

// POST /api/auth/create-user  (admin only — protected by ADMIN_SECRET header)
app.post('/api/auth/create-user', async (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== process.env.ADMIN_SECRET) return res.status(403).json({ message: 'Forbidden' });
  const { email, password, name, company_id } = req.body;
  if (!email || !password || !name) return res.status(400).json({ message: 'email, password and name required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, name, company_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET password_hash=$2, name=$3 RETURNING id, email, name`,
      [email.toLowerCase().trim(), hash, name, company_id || null]
    );
    res.json({ user: rows[0], message: 'User created successfully' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to create user' });
  }
});

// ============================================================
//  ONBOARDING — Excel Import Wizard
// ============================================================

let _idCounter = 0;
function genId(prefix) {
  _idCounter++;
  return `${prefix}${Date.now().toString(36)}${_idCounter}`.toUpperCase().slice(0, 20);
}

// Header keyword dictionary for auto column detection.
// Checked in this priority order so e.g. "Outstanding Amount" maps to
// `outstanding` rather than being stolen by the generic `amount` field.
const ONBOARD_FIELD_ORDER = ['outstanding', 'dueDate', 'issuedDate', 'paymentDate', 'invoice', 'buyer', 'sector', 'state', 'creditDays', 'amount'];
const ONBOARD_KEYWORDS = {
  outstanding:  ['outstandingamount', 'outstandingbalance', 'balancedue', 'pendingamount', 'closingbalance', 'outstanding', 'balance', 'pending', 'dues'],
  dueDate:      ['duedate', 'paymentduedate', 'duein', 'due'],
  issuedDate:   ['invoicedate', 'billdate', 'voucherdate', 'docdate', 'date'],
  paymentDate:  ['paymentdate', 'paiddate', 'paidon', 'settleddate', 'clearancedate', 'payment'],
  invoice:      ['invoiceno', 'invoicenumber', 'billno', 'voucherno', 'referenceno', 'docno', 'invoice', 'voucher', 'bill'],
  buyer:        ['partyname', 'buyername', 'customername', 'accountname', 'ledgername', 'customer', 'party', 'buyer', 'client', 'name'],
  sector:       ['sector', 'industry', 'category', 'segment', 'businesstype', 'type'],
  state:        ['state', 'province', 'region', 'location', 'city', 'place'],
  creditDays:   ['creditdays', 'creditperiod', 'paymentterms', 'termsdays', 'credit'],
  amount:       ['invoiceamount', 'billamount', 'totalamount', 'grossamount', 'invoicevalue', 'amount', 'value'],
};

function detectColumns(headers) {
  const used = new Set();
  const map = {};
  for (const field of ONBOARD_FIELD_ORDER) {
    const kws = ONBOARD_KEYWORDS[field];
    const found = headers.find(h => {
      if (used.has(h)) return false;
      const norm = h.toLowerCase().replace(/[^a-z0-9]/g, '');
      return kws.some(kw => norm.includes(kw));
    });
    if (found) { map[field] = found; used.add(found); }
  }
  return map;
}

function toAmount(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const cleaned = String(v).trim().replace(/[,₹$\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? new Date(d.y, d.m - 1, d.d) : null;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = '20' + y;
    return new Date(+y, +b - 1, +a); // DD-MM-YYYY — standard for Tally/Busy/Vyapar exports
  }
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

// POST /api/onboarding/import
// Multipart upload (field "file") — parses a Tally / Busy / Vyapar / generic Excel
// ledger or receivables export, auto-detects columns, computes risk + cash-flow
// metrics, and auto-creates buyers/invoices/receivables/collections/alerts.
app.post('/api/onboarding/import', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  const cid = req.user.companyId;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return res.status(400).json({ message: 'The file has no data rows' });

    const headers = Object.keys(rows[0]);
    const map = detectColumns(headers);
    if (!map.buyer) return res.status(400).json({ message: 'Could not detect a buyer/customer/party name column', headers });
    if (!map.outstanding && !map.amount) return res.status(400).json({ message: 'Could not detect an amount/outstanding column', headers });

    /* ── Wipe all previous data for this company before fresh import ── */
    // All tables have company_id — delete in FK-safe order (children first)
    await db.query(`DELETE FROM collections WHERE company_id=$1`, [cid]);
    await db.query(`DELETE FROM receivables WHERE company_id=$1`, [cid]);
    await db.query(`DELETE FROM invoices    WHERE company_id=$1`, [cid]);
    try{ await db.query(`DELETE FROM alerts  WHERE company_id=$1`, [cid]); }catch(_){}
    await db.query(`DELETE FROM buyers      WHERE company_id=$1`, [cid]);
    console.log('[import] cleared old data for company', cid);

    const today = new Date();
    const buyerAgg = new Map(); // buyerName -> { outstanding, invoices, overdueCount, totalDelay, maxDelay, sector, state }

    rows.forEach(r => {
      const buyerName = String(r[map.buyer] || '').trim();
      if (!buyerName) return;

      const invoiceValue  = toAmount(r[map.amount] || 0);
      // Only treat Outstanding Amount as explicitly 0 if the cell is non-empty
      const outstandingRaw = map.outstanding ? r[map.outstanding] : null;
      const outstandingExplicit = outstandingRaw !== null && outstandingRaw !== '';
      const outstandingAmt = outstandingExplicit ? toAmount(outstandingRaw) : null;

      const paymentDate = map.paymentDate ? toDate(r[map.paymentDate]) : null;

      // Invoice is PAID if: has a Payment Date OR Outstanding Amount is explicitly 0
      const isPaid = paymentDate != null || (outstandingExplicit && outstandingAmt === 0);

      // Outstanding = Outstanding Amount if explicitly set, else Invoice Value for unpaid
      const amount = isPaid ? 0 : (outstandingAmt !== null && outstandingAmt > 0 ? outstandingAmt : invoiceValue);

      const histAmount = invoiceValue || (outstandingAmt || 0);
      if (!histAmount) return;

      const issued = map.issuedDate ? toDate(r[map.issuedDate]) : null;
      let due = map.dueDate ? toDate(r[map.dueDate]) : null;
      const creditDays = map.creditDays ? parseInt(r[map.creditDays]) || 30 : 30;
      if (!due) due = issued ? new Date(issued.getTime() + creditDays * 86400000) : new Date(today.getTime() - 86400000);
      const invoiceNo = map.invoice ? String(r[map.invoice] || '').trim() : '';

      // Days overdue: only for unpaid invoices past due date
      const daysOverdue = (!isPaid && due < today) ? Math.max(0, Math.round((today - due) / 86400000)) : 0;

      // Late payment: paid but after due date — critical for accurate risk scoring
      const isLatePaid = isPaid && paymentDate && due && paymentDate > due;
      const daysLate   = isLatePaid ? Math.max(0, Math.round((paymentDate - due) / 86400000)) : 0;

      const sector = map.sector ? String(r[map.sector] || '').trim() : '';
      const state  = map.state  ? String(r[map.state]  || '').trim() : '';

      if (!buyerAgg.has(buyerName)) {
        buyerAgg.set(buyerName, {
          outstanding: 0, invoices: [],
          overdueCount: 0, totalDelay: 0, maxDelay: 0,
          latePayCount: 0, latePayDelay: 0,
          sector: '', state: '',
        });
      }
      const agg = buyerAgg.get(buyerName);
      agg.outstanding += amount;
      if (sector && !agg.sector) agg.sector = sector;
      if (state  && !agg.state)  agg.state  = state;
      agg.invoices.push({ invoiceNo, amount: histAmount, issued, due, daysOverdue, isPaid, paymentDate, isLatePaid, daysLate });

      if (daysOverdue > 0) {
        agg.overdueCount++;
        agg.totalDelay += daysOverdue;
        agg.maxDelay = Math.max(agg.maxDelay, daysOverdue);
      }
      if (isLatePaid && daysLate > 0) {
        agg.latePayCount++;
        agg.latePayDelay += daysLate;
        agg.maxDelay = Math.max(agg.maxDelay, daysLate);
      }
    });

    if (!buyerAgg.size) return res.status(400).json({ message: 'No usable rows found — check the buyer name and amount columns', headers, detectedColumns: map });

    const buyersOut = [];
    let totalOutstanding = 0, totalOverdueAmt = 0, totalInvoices = 0, totalDelaySum = 0, delayedBuyerCount = 0, expectedCollections = 0;

    for (const [name, agg] of buyerAgg) {
      const invCount = agg.invoices.length;
      // Count BOTH currently overdue AND historically late-paid as "not on time"
      const badCount  = agg.overdueCount + agg.latePayCount;
      const onTimeCount = invCount - badCount;
      const onTimeRate = invCount ? Math.round((onTimeCount / invCount) * 100) : 100;

      // Average delay across ALL delayed invoices (overdue + late-paid)
      const totalDelayAll   = agg.totalDelay + agg.latePayDelay;
      const totalDelayCount = agg.overdueCount + agg.latePayCount;
      const avgDelay = totalDelayCount ? Math.round(totalDelayAll / totalDelayCount) : 0;
      const highestDelay = agg.maxDelay;

      // Risk Score — 0-100 where 100 = perfect, 0 = worst
      // paymentBehaviour (40%): on-time rate
      // delayScore (30%): avg days late penalised heavily
      // overdueScore (30%): current overdue invoice burden
      const paymentBehaviourScore = onTimeRate;
      const avgDelayScore  = Math.max(0, 100 - avgDelay * 1.5);
      const overdueScore   = invCount ? Math.max(0, 100 - (agg.overdueCount / invCount) * 200) : 100;
      const riskScore = Math.min(100, Math.max(0, Math.round(
        paymentBehaviourScore * 0.40 +
        avgDelayScore         * 0.30 +
        overdueScore          * 0.30
      )));

      const collectionConfidence = Math.min(100, Math.max(0, Math.round(
        onTimeRate   * 0.50 +
        avgDelayScore * 0.30 +
        overdueScore  * 0.20
      )));

      const buyerId = genId('BUY');
      const code = (name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'GEN').padEnd(3, 'X');

      await db.query(
        `INSERT INTO buyers (id, company_id, name, code, industry, cluster, trade_term, risk_score, credit_limit, outstanding)
         VALUES ($1,$2,$3,$4,$5,$6,'Credit',$7,$8,$9)`,
        [buyerId, cid, name, code, agg.sector||null, agg.state||null, riskScore, Math.round(agg.outstanding * 1.5), agg.outstanding]
      );

      for (const inv of agg.invoices) {
        const invId = genId('INV');
        const isPaidInv = inv.isPaid || false;
        const status = isPaidInv ? 'Paid' : (inv.daysOverdue > 0 ? 'Overdue' : 'Pending');
        await db.query(
          `INSERT INTO invoices (id, buyer_id, buyer_name, amount, issued_date, due_date, paid_date, trade_term, status, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Credit',$8,$9)`,
          [invId, buyerId, name, inv.amount, inv.issued || inv.due, inv.due, inv.paymentDate||null, status, cid]
        );
        const recId = genId('REC');
        await db.query(
          `INSERT INTO receivables (id, buyer_id, buyer_name, invoice_id, amount, due_date, days_overdue, status, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [recId, buyerId, name, invId, inv.amount, inv.due, inv.daysOverdue, status, cid]
        );
        await db.query(
          `INSERT INTO collections (id, buyer_id, invoice_id, receivable_id, amount, scheduled_date, status, collection_confidence, delay_days, company_id)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'Pending',$6,$7,$8)`,
          [buyerId, invId, recId, inv.amount, inv.due, collectionConfidence, inv.daysOverdue, cid]
        );
      }

      totalOutstanding += agg.outstanding;
      totalOverdueAmt   += agg.invoices.filter(i => i.daysOverdue > 0).reduce((s, i) => s + i.amount, 0);
      totalInvoices     += invCount;
      if (avgDelay > 0) { totalDelaySum += avgDelay; delayedBuyerCount++; }
      expectedCollections += agg.outstanding * (collectionConfidence / 100);

      buyersOut.push({ id: buyerId, name, outstanding: agg.outstanding, riskScore, avgDelay, invoiceCount: invCount });
    }

    const highRiskBuyers = buyersOut.filter(b => b.riskScore < 45);
    const maxBuyer = buyersOut.reduce((m, b) => b.outstanding > (m?.outstanding||0) ? b : m, null);
    const maxBuyerOutstanding = maxBuyer ? maxBuyer.outstanding : 0;
    const highRiskOutstanding = highRiskBuyers.reduce((s, b) => s + b.outstanding, 0);

    // Cash Stress Score = OverdueRatio×0.50 + HighRiskRatio×0.35 + ConcentrationRatio×0.15
    const overdueRatio  = totalOutstanding ? Math.round((totalOverdueAmt / totalOutstanding) * 100) : 0;
    const highRiskRatio = totalOutstanding ? Math.round((highRiskOutstanding / totalOutstanding) * 100) : 0;
    const concRatio     = totalOutstanding ? Math.round((maxBuyerOutstanding / totalOutstanding) * 100) : 0;
    const stressScore   = Math.round(overdueRatio * 0.50 + highRiskRatio * 0.35 + concRatio * 0.15);
    const stressLabel   = stressScore >= 70 ? 'Critical' : stressScore >= 40 ? 'Elevated' : 'Healthy';
    const avgDelayOverall = delayedBuyerCount ? Math.round(totalDelaySum / delayedBuyerCount) : 0;

    // ── Business Intelligence Score ──────────────────────────────────────────
    // BIScore = CollectionConf×0.30 + AvgRisk×0.25 + StressInverse×0.25 + ConcInverse×0.20
    const avgWeightedRisk = totalOutstanding > 0
      ? buyersOut.reduce((s, b) => s + b.riskScore * b.outstanding, 0) / totalOutstanding
      : buyersOut.reduce((s, b) => s + b.riskScore, 0) / (buyersOut.length || 1);
    const avgCollConf = totalOutstanding > 0
      ? buyersOut.reduce((s, b) => s + (Math.round(80 * 0.30 + (b.riskScore*0.4||0) * 0.30 + Math.max(0,100-(b.avgDelay||0)*2) * 0.20 + 100 * 0.20)) * b.outstanding, 0) / totalOutstanding
      : 70;
    const stressInverse = Math.max(0, 100 - stressScore);
    const concInverse   = Math.max(0, 100 - concRatio);
    const biScore = Math.min(100, Math.max(0, Math.round(
      avgCollConf   * 0.30 +
      avgWeightedRisk * 0.25 +
      stressInverse * 0.25 +
      concInverse   * 0.20
    )));
    const biLabel = biScore >= 90 ? 'Excellent' : biScore >= 75 ? 'Healthy' : biScore >= 60 ? 'Needs Attention' : 'High Risk';
    const biColor = biScore >= 90 ? '#16a34a' : biScore >= 75 ? '#2563eb' : biScore >= 60 ? '#d97706' : '#dc2626';

    // Key Drivers
    const buyerRiskLevel  = avgWeightedRisk >= 70 ? 'Low' : avgWeightedRisk >= 50 ? 'Medium' : 'High';
    const cashStressLevel = stressScore >= 60 ? 'High' : stressScore >= 30 ? 'Medium' : 'Low';
    const collConfLevel   = avgCollConf >= 70 ? 'High' : avgCollConf >= 50 ? 'Medium' : 'Low';
    const exposureLevel   = concRatio >= 40 ? 'High' : concRatio >= 20 ? 'Medium' : 'Low';

    // Explore Why insights
    const topBuyers = [...buyersOut].sort((a, b) => b.outstanding - a.outstanding).slice(0, 3);
    const top3Pct   = totalOutstanding ? Math.round(topBuyers.reduce((s,b)=>s+b.outstanding,0)/totalOutstanding*100) : 0;
    const daysUntilStress = stressScore > 15 ? Math.round(Math.max(7, 90 * (1 - stressScore/100))) : 90;
    const slowerBuyers = buyersOut.filter(b => b.avgDelay > 30).length;
    const riskiestBuyer = [...buyersOut].sort((a,b)=>a.riskScore-b.riskScore)[0];
    const fmt = n => n >= 100000 ? `₹${Math.round(n/100000*10)/10}L` : `₹${Math.round(n/1000)}K`;

    const exploreWhy = [];
    if (top3Pct > 30) exploreWhy.push({
      icon:'⚠', severity:'high',
      title:`${topBuyers.length} buyers create ${top3Pct}% of your risk`,
      desc:`${topBuyers.slice(0,2).map(b=>b.name).join(' and ')} account for most of your outstanding exposure — high concentration risk.`,
      module:'buyerRiskProfiles', moduleLabel:'Buyer Intelligence',
    });
    if (stressScore > 15) exploreWhy.push({
      icon:'⚠', severity:'high',
      title:`Cash stress expected in ${daysUntilStress} days`,
      desc:`${overdueRatio}% of your receivables are overdue. Without action, working capital will tighten significantly.`,
      module:'riskReports', moduleLabel:'Risk & Forecast',
    });
    if (totalOverdueAmt > 0) exploreWhy.push({
      icon:'⚠', severity:'critical',
      title:`${fmt(totalOverdueAmt)} collections at risk`,
      desc:`Overdue invoices from ${buyersOut.filter(b=>b.overdueCount>0).length} buyers need immediate follow-up before they age further.`,
      module:'receivables', moduleLabel:'Receivables Center',
    });
    if (slowerBuyers > 0) exploreWhy.push({
      icon:'⚠', severity:'medium',
      title:`${slowerBuyers} buyer${slowerBuyers>1?'s':''} paying slower than expected`,
      desc:`Average delay exceeds 30 days. Review credit terms and escalate collection for these accounts.`,
      module:'buyerRiskProfiles', moduleLabel:'Buyer Intelligence',
    });
    if (concRatio > 35) exploreWhy.push({
      icon:'⚠', severity:'high',
      title:`Exposure concentration at ${concRatio}% — above safe threshold`,
      desc:`${maxBuyer?.name||'Top buyer'} holds ${fmt(maxBuyerOutstanding)} (${concRatio}% of total). A single default would cause severe cash stress.`,
      module:'exposureAnalysis', moduleLabel:'Exposure Analysis',
    });

    // Recommended Actions per module
    const recommendedActions = {
      buyerIntelligence: riskiestBuyer ? {
        insight:`${riskiestBuyer.name} shows the highest payment risk in your portfolio`,
        reason:`Risk score ${riskiestBuyer.riskScore}/100 with ${Math.round(riskiestBuyer.avgDelay)} days average payment delay and ${fmt(riskiestBuyer.outstanding)} outstanding`,
        action:`Reduce credit terms for ${riskiestBuyer.name} from 60 days to 30 days and require post-dated cheques on next order`,
        outcome:`Reduces bad debt probability by ~40% and improves monthly cash predictability`,
      } : null,
      receivables: {
        insight: totalOverdueAmt > 0 ? `${fmt(totalOverdueAmt)} in overdue receivables requires immediate action` : 'Set up proactive payment reminders to prevent future overdue',
        reason:`${buyersOut.filter(b=>b.overdueCount>0).length} buyers have invoices past their credit period — delay compounding interest in working capital cost`,
        action: totalOverdueAmt > 0 ? `Call the top 3 overdue buyers this week. Start with the highest outstanding amount. Offer a 2% discount for payment within 7 days.` : 'Schedule automated reminders 7 days before each invoice due date',
        outcome:`Potential recovery of ${fmt(totalOverdueAmt*0.65)} within 30 days with a structured weekly follow-up cadence`,
      },
      riskForecast: {
        insight: concRatio > 30 ? `Buyer concentration at ${concRatio}% creates single-point-of-failure risk` : `Cash stress score is ${stressScore}/100 — ${stressLabel}`,
        reason:`Top buyer accounts for ${concRatio}% of total outstanding — safe maximum is 25%. One default cascades into working capital crisis.`,
        action: concRatio > 30 ? `Collect from ${maxBuyer?.name||'top buyer'} aggressively this month to bring concentration below 30%. Pause new orders until overdue is cleared.` : 'Monitor overdue ratio weekly — escalate if it crosses 20%',
        outcome:`Reduces portfolio risk score by ~15 points and improves your financing eligibility rating`,
      },
      decisionCenter: {
        insight: riskiestBuyer ? `New orders from ${riskiestBuyer.name} carry elevated acceptance risk` : 'Evaluate each new order against buyer risk profile before accepting',
        reason:`Low risk score and existing overdue signals high probability of delayed payment — accepting more orders without conditions worsens exposure`,
        action: riskiestBuyer ? `Accept future orders from ${riskiestBuyer.name} only with 20% advance payment and maximum 30-day credit terms` : 'Use the Order Simulator to score every new order before acceptance',
        outcome:`Protects ₹${Math.round(totalOutstanding*0.15/1000)}K+ in working capital and reduces order default probability by ~35%`,
      },
    };

    for (const b of highRiskBuyers) {
      await db.query(
        `INSERT INTO alerts (type, severity, title, message, buyer_id, company_id)
         VALUES ('risk','high',$1,$2,$3,$4)`,
        [`High risk buyer: ${b.name}`, `Risk score ${b.riskScore}/100 — ${fmt(b.outstanding)} outstanding with ${Math.round(b.avgDelay)} day avg delay`, b.id, cid]
      );
    }

    res.json({
      source: req.body.source || 'Generic Excel',
      detectedColumns: map,
      rowsProcessed: rows.length,
      biScore, biLabel, biColor,
      keyDrivers: { buyerRisk: buyerRiskLevel, cashStress: cashStressLevel, collectionConfidence: collConfLevel, exposureConcentration: exposureLevel },
      exploreWhy,
      recommendedActions,
      summary: {
        buyersAnalyzed:       buyersOut.length,
        outstandingExposure:  Math.round(totalOutstanding),
        highRiskBuyers:       highRiskBuyers.length,
        avgDelay:             avgDelayOverall,
        expectedCollections:  Math.round(expectedCollections),
        cashStressScore:      stressScore,
        cashStressLabel:      stressLabel,
        totalInvoices,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Import failed: ' + err.message });
  }
});

// ============================================================
//  DASHBOARD
// ============================================================

// GET /api/dashboard/summary
// Called by: DashboardAPI.load()
app.get('/api/dashboard/summary', auth, async (req, res) => {
  const cid = req.user.companyId;
  try {
    const [ordersRes, invoicesRes, buyersRes, receivablesRes] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(total_value),0) AS active_order_value FROM orders WHERE status NOT IN ('Cancelled') AND company_id=$1`, [cid]),
      db.query(`SELECT COUNT(*) AS total,
                       COALESCE(SUM(CASE WHEN status='Overdue' THEN amount ELSE 0 END),0) AS overdue_val,
                       COALESCE(SUM(CASE WHEN status='Paid' THEN amount ELSE 0 END),0) AS paid_val,
                       COALESCE(SUM(CASE WHEN status='Pending' THEN amount ELSE 0 END),0) AS pending_val,
                       COUNT(CASE WHEN status='Overdue' THEN 1 END) AS overdue_count,
                       COUNT(CASE WHEN status='Pending' THEN 1 END) AS pending_count,
                       COUNT(CASE WHEN status='Paid' THEN 1 END) AS paid_count
                FROM invoices WHERE company_id=$1`, [cid]),
      db.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN risk_score < 45 THEN 1 END) AS high_risk FROM buyers WHERE company_id=$1`, [cid]),
      db.query(`SELECT COALESCE(SUM(amount),0) AS total_overdue FROM receivables WHERE status='Overdue' AND company_id=$1`, [cid]),
    ]);
    const o = ordersRes.rows[0];
    const inv = invoicesRes.rows[0];
    const b = buyersRes.rows[0];
    const rec = receivablesRes.rows[0];
    const totalIA = parseInt(inv.total || 0);
    const acceptanceRate = totalIA > 0 ? Math.round(parseInt(inv.paid_count || 0) / totalIA * 100) : 0;
    res.json({
      totalReceivables:     parseFloat(o.active_order_value),
      overdueReceivables:   parseFloat(rec.total_overdue),
      paidThisMonth:        parseFloat(inv.paid_val),
      pendingValue:         parseFloat(inv.pending_val),
      cashPosition:         null,
      highRiskBuyerCount:   parseInt(b.high_risk),
      totalInvoices:        parseInt(inv.total),
      pendingCount:         parseInt(inv.pending_count),
      pendingVal:           parseFloat(inv.pending_val),
      verifiedCount:        parseInt(inv.paid_count),
      verifiedVal:          parseFloat(inv.paid_val),
      disputedCount:        0,
      overdueCount:         parseInt(inv.overdue_count),
      acceptanceRate,
      avgAcceptTime:        3,
      collectionConfidence: 78,
      upcomingCollections:  0,
      insights:             [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load dashboard summary' });
  }
});

// ============================================================
//  BUYERS
// ============================================================

// GET /api/buyers
app.get('/api/buyers', auth, async (req, res) => {
  const { cluster, tradeTerm, minRisk, maxRisk, limit = 100, offset = 0 } = req.query;
  const cid = req.user.companyId;
  try {
    let q = 'SELECT * FROM buyers WHERE company_id=$1';
    const params = [cid];
    if (cluster)  { params.push(cluster);  q += ` AND cluster=$${params.length}`; }
    if (tradeTerm){ params.push(tradeTerm); q += ` AND trade_term=$${params.length}`; }
    if (minRisk)  { params.push(minRisk);   q += ` AND risk_score>=$${params.length}`; }
    if (maxRisk)  { params.push(maxRisk);   q += ` AND risk_score<=$${params.length}`; }
    params.push(limit, offset);
    q += ` ORDER BY name LIMIT $${params.length-1} OFFSET $${params.length}`;
    const { rows, rowCount } = await db.query(q, params);
    res.json({ items: rows, total: rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load buyers' });
  }
});

// GET /api/buyers/:id
app.get('/api/buyers/:id', auth, async (req, res) => {
  const cid = req.user.companyId;
  try {
    const { rows } = await db.query('SELECT * FROM buyers WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    if (!rows[0]) return res.status(404).json({ message: 'Buyer not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load buyer' });
  }
});

// GET /api/buyers/:id/intelligence
// Called by: OrderSimulatorAPI.getBuyerIntel()
// Returns full risk profile used by OASEngine
app.get('/api/buyers/:id/intelligence', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM v_buyer_risk_profile WHERE id=$1', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Buyer not found' });

    const b = rows[0];

    // ── Buyer Risk Score formula ──────────────────────────────────────
    // BuyerRisk = PaymentBehaviour×0.40 + AvgDelay×0.20 +
    //             AcceptanceRate×0.15 + ExposureUtil×0.15 + DisputeFreq×0.10
    const paymentBehaviourScore = parseFloat(b.on_time_rate_pct) || 0;
    const avgDelayScore         = Math.max(0, 100 - (parseFloat(b.avg_delay_days) || 0) * 2);
    const acceptanceScore       = parseFloat(b.acceptance_rate_pct) || 0;
    const exposureScore         = Math.max(0, 100 - (parseFloat(b.credit_utilisation_pct) || 0));
    const disputeScore          = Math.max(0, 100 - (parseFloat(b.dispute_freq_pct) || 0) * 5);

    const riskScore = Math.round(
      paymentBehaviourScore * 0.40 +
      avgDelayScore         * 0.20 +
      acceptanceScore       * 0.15 +
      exposureScore         * 0.15 +
      disputeScore          * 0.10
    );

    // Update stored risk score
    await db.query('UPDATE buyers SET risk_score=$1, updated_at=NOW() WHERE id=$2', [riskScore, b.id]);

    // Late payment probability (logistic approximation)
    const latePaymentProb = Math.round(Math.max(0, Math.min(99,
      100 - paymentBehaviourScore * 0.6 - avgDelayScore * 0.4
    )));

    res.json({
      buyer: {
        id:        b.id,
        name:      b.name,
        code:      b.code,
        industry:  b.industry,
        cluster:   b.cluster,
        tradeTerm: b.trade_term,
        contact:   b.contact_name,
      },
      riskScore,
      latePaymentProb,
      avgDelay:               parseFloat(b.avg_delay_days)         || 0,
      highestDelay:           parseFloat(b.max_delay_days)         || 0,
      onTimeRatio:            parseFloat(b.on_time_rate_pct)       || 0,
      utilization:            parseFloat(b.credit_utilisation_pct) || 0,
      outstandingBalance:     parseFloat(b.outstanding)            || 0,
      acceptanceRate:         parseFloat(b.acceptance_rate_pct)    || 0,
      avgAcceptDays:          parseFloat(b.avg_accept_days)        || 0,
      disputeFreq:            parseFloat(b.dispute_freq_pct)       || 0,
      paymentReliabilityScore: paymentBehaviourScore,
      tradeTermAbuseScore:    Math.max(0, parseFloat(b.avg_delay_days) - (parseFloat(b.avg_accept_days)||30)),
      category: riskScoreToCategory(riskScore),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load buyer intelligence' });
  }
});

function riskScoreToCategory(score) {
  if (score >= 75) return { label: 'Excellent', cls: 'risk-excellent', color: '#16a34a' };
  if (score >= 60) return { label: 'Stable',    cls: 'risk-stable',    color: '#2563eb' };
  if (score >= 45) return { label: 'Watchlist', cls: 'risk-watchlist', color: '#d97706' };
  return                  { label: 'Critical',  cls: 'risk-critical',  color: '#dc2626' };
}

// POST /api/buyers
app.post('/api/buyers', auth, async (req, res) => {
  const { id, name, code, industry, cluster, trade_term, credit_limit, contact_name, contact_email, gstin } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO buyers (id,name,code,industry,cluster,trade_term,credit_limit,contact_name,contact_email,gstin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, name, code, industry, cluster, trade_term, credit_limit, contact_name, contact_email, gstin]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create buyer' });
  }
});

// PATCH /api/buyers/:id
app.patch('/api/buyers/:id', auth, async (req, res) => {
  const fields = ['name','code','industry','cluster','trade_term','credit_limit','outstanding','contact_name','contact_email','gstin'];
  const updates = [];
  const params  = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f}=$${params.length}`); }
  });
  if (!updates.length) return res.status(400).json({ message: 'No fields to update' });
  params.push(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE buyers SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ message: 'Buyer not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update buyer' });
  }
});

// ============================================================
//  ORDERS  (Decision History)
// ============================================================

// GET /api/orders
// Called by: DecisionHistoryAPI.load(), DashboardAPI.load() (recent orders)
app.get('/api/orders', auth, async (req, res) => {
  const { buyerId, status, sort = 'order_date', dir = 'desc', limit = 100, offset = 0 } = req.query;
  const safeSort = ['order_date','total_value','status','buyer_name'].includes(sort) ? sort : 'order_date';
  const safeDir  = dir === 'asc' ? 'ASC' : 'DESC';
  const cid = req.user.companyId;
  try {
    let q = 'SELECT * FROM orders WHERE company_id=$1';
    const params = [cid];
    if (buyerId) { params.push(buyerId); q += ` AND buyer_id=$${params.length}`; }
    if (status)  { params.push(status);  q += ` AND status=$${params.length}`; }
    params.push(limit, offset);
    q += ` ORDER BY ${safeSort} ${safeDir} LIMIT $${params.length-1} OFFSET $${params.length}`;
    const { rows } = await db.query(q, params);
    res.json({ items: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load orders' });
  }
});

// GET /api/orders/:id
app.get('/api/orders/:id', auth, async (req, res) => {
  const cid = req.user.companyId;
  try {
    const { rows } = await db.query('SELECT * FROM orders WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    if (!rows[0]) return res.status(404).json({ message: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load order' });
  }
});

// POST /api/orders
// Called by: OrderSimulatorAPI.acceptOrder()
app.post('/api/orders', auth, async (req, res) => {
  const { id, buyer_id, buyer_name, buyerId, buyerName, product, quantity, unit_price, unitPrice,
          total_value, totalValue, order_date, orderDate, expected_delivery, expectedDelivery,
          status, payment_terms, paymentTerms, po_number, cluster, sim_snapshot, _simSnapshot } = req.body;
  const cid = req.user.companyId;
  try {
    const { rows } = await db.query(
      `INSERT INTO orders
         (id, buyer_id, buyer_name, product, quantity, unit_price, total_value,
          order_date, expected_delivery, status, payment_terms, po_number, cluster, sim_snapshot, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         status=EXCLUDED.status, updated_at=NOW()
       RETURNING *`,
      [
        id,
        buyer_id   || buyerId,
        buyer_name || buyerName,
        product,
        quantity   || 1,
        unit_price || unitPrice,
        total_value|| totalValue,
        order_date || orderDate,
        expected_delivery || expectedDelivery,
        status     || 'Processing',
        payment_terms || paymentTerms,
        po_number,
        cluster,
        JSON.stringify(sim_snapshot || _simSnapshot || null),
        cid,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to save order' });
  }
});

// PATCH /api/orders/:id
app.patch('/api/orders/:id', auth, async (req, res) => {
  const { status, expected_delivery } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE orders SET status=$1, expected_delivery=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
      [status, expected_delivery, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update order' });
  }
});

// ============================================================
//  INVOICES
// ============================================================

// GET /api/invoices
app.get('/api/invoices', auth, async (req, res) => {
  const { buyerId, status, limit = 100, offset = 0 } = req.query;
  const cid = req.user.companyId;
  try {
    let q = 'SELECT * FROM invoices WHERE company_id=$1';
    const params = [cid];
    if (buyerId) { params.push(buyerId); q += ` AND buyer_id=$${params.length}`; }
    if (status)  { params.push(status);  q += ` AND status=$${params.length}`; }
    params.push(limit, offset);
    q += ` ORDER BY due_date DESC LIMIT $${params.length-1} OFFSET $${params.length}`;
    const { rows } = await db.query(q, params);
    res.json({ items: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load invoices' });
  }
});

// GET /api/invoices/:id
app.get('/api/invoices/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Invoice not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load invoice' });
  }
});

// POST /api/invoices
app.post('/api/invoices', auth, async (req, res) => {
  const { id, order_id, buyer_id, buyer_name, amount, issued_date, due_date, trade_term, status } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO invoices (id,order_id,buyer_id,buyer_name,amount,issued_date,due_date,trade_term,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, order_id, buyer_id, buyer_name, amount, issued_date, due_date, trade_term, status || 'Pending']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create invoice' });
  }
});

// PATCH /api/invoices/:id/status
app.patch('/api/invoices/:id/status', auth, async (req, res) => {
  const { status, paid_date } = req.body;
  try {
    const { rows } = await db.query(
      'UPDATE invoices SET status=$1, paid_date=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
      [status, paid_date || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Invoice not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update invoice status' });
  }
});

// ============================================================
//  INVOICE ACCEPTANCES  (Buyer Acceptance Hub)
// ============================================================

// GET /api/invoice-acceptances
app.get('/api/invoice-acceptances', auth, async (req, res) => {
  const { buyerId, status } = req.query;
  try {
    let q = `SELECT ia.*, i.amount, i.due_date, i.issued_date, b.name AS buyer_name
             FROM invoice_acceptances ia
             JOIN invoices i ON ia.invoice_id = i.id
             JOIN buyers   b ON ia.buyer_id   = b.id
             WHERE 1=1`;
    const params = [];
    if (buyerId) { params.push(buyerId); q += ` AND ia.buyer_id=$${params.length}`; }
    if (status)  { params.push(status);  q += ` AND ia.status=$${params.length}`; }
    q += ' ORDER BY ia.created_at DESC';
    const { rows } = await db.query(q, params);
    res.json({ items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load acceptances' });
  }
});

// PATCH /api/invoice-acceptances/:id
app.patch('/api/invoice-acceptances/:id', auth, async (req, res) => {
  const { status, accepted_date, dispute_reason, verification_score } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE invoice_acceptances
       SET status=$1, accepted_date=$2, dispute_reason=$3, verification_score=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [status, accepted_date, dispute_reason, verification_score, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Acceptance not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update acceptance' });
  }
});

// ============================================================
//  RECEIVABLES
// ============================================================

// GET /api/receivables
app.get('/api/receivables', auth, async (req, res) => {
  const { buyerId, minOverdue } = req.query;
  const cid = req.user.companyId;
  try {
    let q = 'SELECT * FROM receivables WHERE company_id=$1';
    const params = [cid];
    if (buyerId)    { params.push(buyerId);    q += ` AND buyer_id=$${params.length}`; }
    if (minOverdue) { params.push(minOverdue); q += ` AND days_overdue>=$${params.length}`; }
    q += ' ORDER BY days_overdue DESC';
    const { rows } = await db.query(q, params);
    res.json({ items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load receivables' });
  }
});

// ============================================================
//  COLLECTIONS
// ============================================================

// GET /api/collections
app.get('/api/collections', auth, async (req, res) => {
  const { buyerId, status } = req.query;
  const cid = req.user.companyId;
  try {
    let q = 'SELECT * FROM collections WHERE company_id=$1';
    const params = [cid];
    if (buyerId) { params.push(buyerId); q += ` AND buyer_id=$${params.length}`; }
    if (status)  { params.push(status);  q += ` AND status=$${params.length}`; }
    q += ' ORDER BY scheduled_date ASC';
    const { rows } = await db.query(q, params);
    res.json({ items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load collections' });
  }
});

// PATCH /api/collections/:id/collect
app.patch('/api/collections/:id/collect', auth, async (req, res) => {
  const { collected_date, amount, status } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE collections SET status=$1, collected_date=$2, amount=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [status || 'Collected', collected_date, amount, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Collection not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update collection' });
  }
});

// ============================================================
//  PORTFOLIO  (OASEngine data)
// ============================================================

// GET /api/portfolio/position
// Called by: OrderSimulatorAPI.getPortfolio()
app.get('/api/portfolio/position', auth, async (_req, res) => {
  try {
    const [posRes, agingRes, exposureRes] = await Promise.all([
      db.query('SELECT * FROM v_portfolio_position'),
      db.query('SELECT * FROM v_receivables_aging'),
      db.query('SELECT buyer_id, SUM(amount) AS exposure FROM receivables GROUP BY buyer_id'),
    ]);

    const pos = posRes.rows[0] || {};
    const totalRec = parseFloat(pos.total_receivables) || 1;

    // Build aging buckets
    const aging = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    agingRes.rows.forEach(r => {
      aging['0-30']  += parseFloat(r.current_amt)  || 0;
      aging['31-60'] += parseFloat(r.overdue_1_30) || 0;
      aging['61-90'] += parseFloat(r.overdue_31_60)|| 0;
      aging['90+']   += parseFloat(r.overdue_60_plus)|| 0;
    });

    const buyerExposures = {};
    exposureRes.rows.forEach(r => { buyerExposures[r.buyer_id] = parseFloat(r.exposure) || 0; });

    const overdueTotal = parseFloat(pos.delayed_collections) || 0;
    const overdueRatio = Math.round(overdueTotal / totalRec * 100);
    const atRiskRatio  = Math.round((parseFloat(pos.at_risk_amount)||0) / totalRec * 100);

    // Portfolio health score (higher is better)
    const healthScore = Math.max(0, Math.round(
      100 - overdueRatio * 0.5 - atRiskRatio * 0.35
    ));

    res.json({
      totalReceivables:    parseFloat(pos.total_receivables)  || 0,
      delayedCollections:  parseFloat(pos.delayed_collections)|| 0,
      openOrdersTotal:     parseFloat(pos.open_orders_total)  || 0,
      highRiskExposure:    parseFloat(pos.high_risk_exposure) || 0,
      activeBuyers:        parseInt(pos.active_buyers)        || 0,
      overdueRatio,
      atRiskRatio,
      healthScore,
      aging,
      buyerExposures,
      upcomingCollections: 0, // TODO: SUM from collections WHERE scheduled_date <= NOW()+30d
      portfolioDSO:        0, // TODO: weighted avg days outstanding
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load portfolio position' });
  }
});

// ============================================================
//  ORDER SIMULATOR ENGINE
// ============================================================

// POST /api/order-simulator/run
// Called by: OrderSimulatorAPI.runSimulation()
// Runs the canonical Order Acceptance Score formula server-side
app.post('/api/order-simulator/run', auth, async (req, res) => {
  const { buyerId, orderValue, creditTerms, grossMargin, workingCapital, currentCreditExposure } = req.body;

  if (!buyerId || !orderValue) {
    return res.status(400).json({ message: 'buyerId and orderValue are required' });
  }

  try {
    // Fetch buyer intelligence
    const { rows: bRows } = await db.query('SELECT * FROM v_buyer_risk_profile WHERE id=$1', [buyerId]);
    if (!bRows[0]) return res.status(404).json({ message: 'Buyer not found' });
    const b = bRows[0];

    const OV  = parseFloat(orderValue);
    const CT  = parseInt(creditTerms)  || 30;
    const GM  = parseFloat(grossMargin)|| 20;
    const WC  = parseFloat(workingCapital) || 1000000;
    const COE = parseFloat(process.env.DEFAULT_COE) || 12; // cost of equity %

    // Fetch current portfolio
    const { rows: pRows } = await db.query('SELECT * FROM v_portfolio_position');
    const port = pRows[0] || {};
    const totalRec = parseFloat(port.total_receivables) || 0;

    // ── Order Acceptance Score formula ────────────────────────────────
    // OAS = BuyerRisk×0.35 + WCImpact×0.20 + PortfolioHealth×0.20 +
    //       ExposureImpact×0.10 + DelayProb×0.15

    const riskScore        = parseFloat(b.risk_score) || 50;
    const onTimeRate       = parseFloat(b.on_time_rate_pct) || 50;
    const avgDelay         = parseFloat(b.avg_delay_days)   || 15;
    const utilisation      = parseFloat(b.credit_utilisation_pct) || 0;
    const outstanding      = parseFloat(b.outstanding) || 0;

    const wcCommitted      = totalRec + parseFloat(port.open_orders_total||0);
    const wcUtilPre        = WC > 0 ? Math.min(999, Math.round(wcCommitted / WC * 100)) : 0;
    const wcUtilPost       = WC > 0 ? Math.min(999, Math.round((wcCommitted + OV) / WC * 100)) : 0;
    const wcHeadroom       = Math.max(0, WC - wcCommitted);
    const wcHeadroomPost   = Math.max(0, WC - wcCommitted - OV);

    const buyerExpPre      = outstanding;
    const buyerExpPost     = outstanding + OV;
    const concentrationPct = (totalRec + OV) > 0 ? Math.round(buyerExpPost / (totalRec + OV) * 100) : 0;
    const prevConcentration= totalRec > 0 ? Math.round(buyerExpPre / totalRec * 100) : 0;

    // Component scores (0–100, higher = better)
    const buyerRiskComp    = riskScore;
    const wcImpactComp     = Math.max(0, 100 - wcUtilPost);
    const portHealthComp   = parseFloat(port.health_score || 50);
    const exposureComp     = concentrationPct <= 20 ? 100 : concentrationPct <= 35 ? 60 : 20;
    const delayProbComp    = Math.max(0, 100 - avgDelay * 2);

    const orderImpactScore = Math.round(
      buyerRiskComp * 0.35 +
      wcImpactComp  * 0.20 +
      portHealthComp* 0.20 +
      exposureComp  * 0.10 +
      delayProbComp * 0.15
    );

    // Decision logic
    let decision, decisionReason;
    if (orderImpactScore >= 75 && riskScore >= 70 && concentrationPct <= 30) {
      decision       = 'ACCEPT';
      decisionReason = `Strong buyer profile (risk ${riskScore}/100), healthy portfolio concentration (${concentrationPct}%), and adequate working capital headroom (${wcUtilPost}% utilisation).`;
    } else if (wcUtilPost > 90 || riskScore < 35) {
      decision       = 'DO NOT ACCEPT';
      decisionReason = `Working capital utilisation reaches ${wcUtilPost}% and buyer risk score is ${riskScore}/100 — combined exposure is financially unviable at current terms.`;
    } else if (concentrationPct > 40) {
      decision       = 'ACCEPT WITH CONDITIONS — REQUIRE ADVANCE';
      decisionReason = `Buyer exposure reaches ${concentrationPct}% of portfolio — excessive concentration. Advance payment required to limit cash flow dependency.`;
    } else if (riskScore < 55 || wcUtilPost > 75) {
      decision       = 'ACCEPT WITH CONDITIONS';
      decisionReason = `Buyer risk (${riskScore}/100) or WC utilisation (${wcUtilPost}%) warrants protective conditions before acceptance.`;
    } else {
      decision       = 'ACCEPT';
      decisionReason = `Order profile is within acceptable risk bounds. Buyer risk ${riskScore}/100, concentration ${concentrationPct}%, WC utilisation ${wcUtilPost}%.`;
    }

    const impactCategory = orderImpactScore >= 75 ? 'Low Impact' : orderImpactScore >= 50 ? 'Moderate' : 'High Risk';
    const impactColor    = orderImpactScore >= 75 ? '#16a34a'    : orderImpactScore >= 50 ? '#d97706'   : '#dc2626';
    const impactBg       = orderImpactScore >= 75 ? '#f0fdf4'    : orderImpactScore >= 50 ? '#fffbeb'   : '#fef2f2';
    const decisionColor  = decision.includes('NOT') ? '#dc2626' : decision.includes('CONDITION') ? '#d97706' : '#16a34a';
    const decisionBg     = decision.includes('NOT') ? '#fef2f2' : decision.includes('CONDITION') ? '#fffbeb' : '#f0fdf4';
    const decisionBorder = decision.includes('NOT') ? '#fecaca' : decision.includes('CONDITION') ? '#fde68a' : '#bbf7d0';

    const grossProfit      = Math.round(OV * GM / 100);
    const financingCost    = Math.round(OV * (COE / 100) / 365 * CT);
    const predictedDelay   = Math.round(avgDelay * 0.8);
    const creditUtilPost   = outstanding > 0 && parseFloat(b.credit_limit) > 0
      ? Math.round(buyerExpPost / parseFloat(b.credit_limit) * 100) : utilisation;

    const result = {
      OV, CT, WC, GM, COE,
      orderImpactScore, impactCategory, impactColor, impactBg,
      decision, decisionColor, decisionBg, decisionBorder, decisionReason,
      decisionActions: [],
      wcUtilPre, wcUtilPost, wcHeadroom, wcHeadroomPost, wcCommitted,
      concentrationPct, prevConcentration,
      grossProfit, financingCost, predictedDelay,
      totalExposure: outstanding + OV,
      creditUtilPostOrder: creditUtilPost,
      portfolio: {
        totalReceivables:  totalRec,
        openOrdersTotal:   parseFloat(port.open_orders_total) || 0,
        overdueRatio:      parseInt(port.overdue_ratio || 0),
        healthScore:       portHealthComp,
        buyerExposures:    {},
        upcomingCollections: 0,
        delayedCollections: parseFloat(port.delayed_collections) || 0,
        highRiskExposure:  parseFloat(port.high_risk_exposure)   || 0,
        activeBuyers:      parseInt(port.active_buyers)          || 0,
        aging:             { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
        portfolioDSO:      0,
        atRiskRatio:       0,
        estimatedWC:       WC,
      },
      intel: {
        buyer:       { id: b.id, name: b.name, code: b.code, industry: b.industry, cluster: b.cluster, tradeTerm: b.trade_term },
        riskScore,
        avgDelay,
        highestDelay: parseFloat(b.max_delay_days) || 0,
        onTimeRatio:  onTimeRate,
        latePaymentProb: Math.max(0, Math.min(99, Math.round(100 - onTimeRate * 0.6 - Math.max(0,100-avgDelay*2)*0.4))),
        utilization:  utilisation,
        outstandingBalance: outstanding,
        category:     riskScoreToCategory(riskScore),
        paymentReliabilityScore: onTimeRate,
        tradeTermAbuseScore:     Math.max(0, avgDelay - (parseFloat(b.avg_accept_days)||30)),
      },
      scenarios: {
        best:       { paymentDays: Math.max(CT - 10, 1), prob: 25 },
        mostLikely: { paymentDays: CT + predictedDelay,  prob: 55 },
        worst:      { paymentDays: CT + predictedDelay + avgDelay, prob: 20 },
      },
      projections:   [],
      metrics:       [],
      warnings:      [],
      businessImpact: {
        portfolioRiskBefore: 50,
        portfolioRiskAfter:  Math.max(0, 50 + (100 - riskScore) * 0.1),
        totalExposureBefore: totalRec,
        totalExposureAfter:  totalRec + OV,
        creditUtilBefore:    utilisation,
        creditUtilAfter:     creditUtilPost,
        wcUtilBefore:        wcUtilPre,
        wcUtilAfter:         wcUtilPost,
        collCycleBefore:     30,
        collCycleAfter:      Math.round(30 + predictedDelay * 0.3),
        totalOutstandingBefore: totalRec,
        totalOutstandingAfter:  totalRec + OV,
      },
    };

    // Log the simulation
    await db.query(
      `INSERT INTO simulation_log
         (buyer_id, order_value, credit_terms_days, gross_margin, working_capital,
          current_credit_exposure, decision, order_impact_score, risk_score_at_sim, result_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [buyerId, OV, CT, GM, WC, currentCreditExposure, decision, orderImpactScore, riskScore, JSON.stringify(result)]
    );

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Simulation engine failed' });
  }
});

// ============================================================
//  ALERTS
// ============================================================

// GET /api/alerts
app.get('/api/alerts', auth, async (req, res) => {
  const { unreadOnly, severity, limit = 50 } = req.query;
  const cid = req.user.companyId;
  try {
    let q = 'SELECT * FROM alerts WHERE company_id=$1';
    const params = [cid];
    if (unreadOnly === 'true') { q += ' AND is_read=FALSE'; }
    if (severity)   { params.push(severity); q += ` AND severity=$${params.length}`; }
    params.push(limit);
    q += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows } = await db.query(q, params);
    res.json({ items: rows, unreadCount: rows.filter(r => !r.is_read).length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load alerts' });
  }
});

// PATCH /api/alerts/:id/read
app.patch('/api/alerts/:id/read', auth, async (req, res) => {
  try {
    await db.query('UPDATE alerts SET is_read=TRUE WHERE id=$1', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to mark alert as read' });
  }
});

// PATCH /api/alerts/read-all
app.patch('/api/alerts/read-all', auth, async (_req, res) => {
  try {
    await db.query('UPDATE alerts SET is_read=TRUE WHERE is_read=FALSE');
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to mark all alerts as read' });
  }
});

// ============================================================
//  TRADE AGREEMENTS
// ============================================================

// GET /api/trade-agreements
app.get('/api/trade-agreements', auth, async (req, res) => {
  const { buyerId, status } = req.query;
  try {
    let q = 'SELECT * FROM trade_agreements WHERE 1=1';
    const params = [];
    if (buyerId) { params.push(buyerId); q += ` AND buyer_id=$${params.length}`; }
    if (status)  { params.push(status);  q += ` AND status=$${params.length}`; }
    q += ' ORDER BY created_at DESC';
    const { rows } = await db.query(q, params);
    res.json({ items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to load trade agreements' });
  }
});

// POST /api/trade-agreements
app.post('/api/trade-agreements', auth, async (req, res) => {
  const fields = ['order_id','buyer_id','buyer_name','buyer_email','order_value','order_date',
    'delivery_period','delivery_location','payment_terms','advance_payment','credit_period',
    'late_payment_clause','inspection_period','warranty_period','special_conditions',
    'status','sim_score','risk_score','from_simulator'];
  const vals = fields.map(f => req.body[f] ?? null);
  const cols = fields.join(',');
  const placeholders = fields.map((_,i) => `$${i+1}`).join(',');
  try {
    const { rows } = await db.query(
      `INSERT INTO trade_agreements (${cols}) VALUES (${placeholders}) RETURNING *`, vals
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create trade agreement' });
  }
});

// PATCH /api/trade-agreements/:id/status
app.patch('/api/trade-agreements/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const timestamps = {
    sent:     'sent_at',
    viewed:   'viewed_at',
    accepted: 'responded_at',
    rejected: 'responded_at',
  };
  const tsCol = timestamps[status];
  try {
    const q = tsCol
      ? `UPDATE trade_agreements SET status=$1, ${tsCol}=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`
      : `UPDATE trade_agreements SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`;
    const { rows } = await db.query(q, [status, req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Agreement not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update agreement status' });
  }
});

// ============================================================
//  RISK ENGINE  (server-side calculation services)
// ============================================================

// GET /api/risk/buyer/:id
// Full BRP engine output — mirrors frontend BRPEngine.profile()
app.get('/api/risk/buyer/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM v_buyer_risk_profile WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Buyer not found' });
    const b = rows[0];

    // Buyer Risk Score
    const riskScore = Math.round(
      (parseFloat(b.on_time_rate_pct)||0)  * 0.40 +
      Math.max(0,100-(parseFloat(b.avg_delay_days)||0)*2) * 0.20 +
      (parseFloat(b.acceptance_rate_pct)||0)* 0.15 +
      Math.max(0,100-(parseFloat(b.credit_utilisation_pct)||0)) * 0.15 +
      Math.max(0,100-(parseFloat(b.dispute_freq_pct)||0)*5) * 0.10
    );

    // Late Payment Probability
    const latePaymentProb = Math.max(0, Math.min(99, Math.round(
      100 - (parseFloat(b.on_time_rate_pct)||0) * 0.6
          - Math.max(0,100-(parseFloat(b.avg_delay_days)||0)*2) * 0.4
    )));

    // Creditworthiness score (0-100)
    const creditworthiness = Math.round((riskScore * 0.6) + ((100 - latePaymentProb) * 0.4));

    // Financing Readiness component
    const acceptanceRate     = parseFloat(b.acceptance_rate_pct)   || 0;
    const historicalRate     = parseFloat(b.on_time_rate_pct)      || 0;
    const delayTrendScore    = Math.max(0, 100 - (parseFloat(b.avg_delay_days)||0));
    const disputeRateScore   = Math.max(0, 100 - (parseFloat(b.dispute_freq_pct)||0)*5);

    // Collection Confidence = AcceptanceRate×0.30 + HistoricalCollections×0.30 + DelayTrend×0.20 + DisputeRate×0.20
    const collectionConfidence = Math.round(
      acceptanceRate   * 0.30 +
      historicalRate   * 0.30 +
      delayTrendScore  * 0.20 +
      disputeRateScore * 0.20
    );

    res.json({
      buyerId:            b.id,
      riskScore,
      latePaymentProb,
      creditworthiness,
      collectionConfidence,
      creditLimit:        parseFloat(b.credit_limit)            || 0,
      outstanding:        parseFloat(b.outstanding)             || 0,
      creditLimitRecommendation: Math.round(creditworthiness / 100 * 5000000),
      avgDelay:           parseFloat(b.avg_delay_days)          || 0,
      maxDelay:           parseFloat(b.max_delay_days)          || 0,
      onTimeRate:         parseFloat(b.on_time_rate_pct)        || 0,
      acceptanceRate,
      disputeFreq:        parseFloat(b.dispute_freq_pct)        || 0,
      creditUtilisation:  parseFloat(b.credit_utilisation_pct)  || 0,
      category:           riskScoreToCategory(riskScore),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Risk engine failed' });
  }
});

// GET /api/risk/portfolio
app.get('/api/risk/portfolio', auth, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        AVG(risk_score)                                                     AS avg_risk_score,
        COUNT(*) FILTER (WHERE risk_score < 45)                            AS high_risk_count,
        COUNT(*) FILTER (WHERE risk_score BETWEEN 45 AND 60)               AS watchlist_count,
        COUNT(*) FILTER (WHERE risk_score > 75)                            AS excellent_count,
        SUM(outstanding)                                                    AS total_outstanding,
        SUM(outstanding) FILTER (WHERE risk_score < 45)                    AS high_risk_outstanding
      FROM buyers
    `);
    res.json(rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Portfolio risk engine failed' });
  }
});

// GET /api/risk/cash-flow-forecast
// Mirrors frontend CashFlowForecast engine
app.get('/api/risk/cash-flow-forecast', auth, async (req, res) => {
  const { days = 90 } = req.query;
  try {
    // Cash Stress Score = OverdueRatio×0.50 + HighRiskRatio×0.35 + ConcentRatio×0.15
    const { rows } = await db.query(`
      SELECT
        SUM(r.amount)                                                       AS total_receivables,
        SUM(r.amount) FILTER (WHERE r.days_overdue > 0)                    AS overdue_amount,
        SUM(r.amount) FILTER (WHERE b.risk_score < 45)                     AS high_risk_amount,
        MAX(r.amount) / NULLIF(SUM(r.amount),0) * 100                     AS top_buyer_concentration
      FROM receivables r LEFT JOIN buyers b ON b.id = r.buyer_id
    `);
    const d = rows[0] || {};
    const totalRec    = parseFloat(d.total_receivables)        || 1;
    const overdueRatio= (parseFloat(d.overdue_amount)||0) / totalRec * 100;
    const highRiskRatio=(parseFloat(d.high_risk_amount)||0) / totalRec * 100;
    const concRatio   = parseFloat(d.top_buyer_concentration)  || 0;

    const stressScore = Math.round(
      overdueRatio  * 0.50 +
      highRiskRatio * 0.35 +
      concRatio     * 0.15
    );

    res.json({
      stressScore,
      stressLabel: stressScore >= 70 ? 'Critical' : stressScore >= 40 ? 'Elevated' : 'Healthy',
      overdueRatio:   Math.round(overdueRatio),
      highRiskRatio:  Math.round(highRiskRatio),
      concRatio:      Math.round(concRatio),
      totalReceivables: parseFloat(d.total_receivables) || 0,
      forecastDays:   parseInt(days),
      projectedCash:  0, // TODO: model cash inflows from scheduled collections
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Forecast engine failed' });
  }
});

// GET /api/risk/financing-readiness
// Financing Readiness = ReceivableConf×0.55 + CollectionConf×0.45
app.get('/api/risk/financing-readiness', auth, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE ia.status='Verified')::FLOAT / NULLIF(COUNT(*),0) * 100  AS acceptance_rate,
        AVG(ph.on_time::INT) * 100                                                        AS historical_collection_rate
      FROM invoice_acceptances ia
      FULL OUTER JOIN payment_history ph ON ph.buyer_id = ia.buyer_id
    `);
    const d = rows[0] || {};
    const receivableConf  = parseFloat(d.acceptance_rate)            || 0;
    const collectionConf  = parseFloat(d.historical_collection_rate) || 0;
    const financingScore  = Math.round(receivableConf * 0.55 + collectionConf * 0.45);

    res.json({
      financingReadiness: financingScore,
      receivableConfidence: Math.round(receivableConf),
      collectionConfidence: Math.round(collectionConf),
      eligible: financingScore >= 65,
      label: financingScore >= 80 ? 'Strong' : financingScore >= 65 ? 'Eligible' : financingScore >= 50 ? 'Borderline' : 'Not Eligible',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Financing readiness engine failed' });
  }
});

// ============================================================
//  HEALTH CHECK
// ============================================================
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// 404 catch-all
app.use((_req, res) => res.status(404).json({ message: 'Endpoint not found' }));

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`CashFlowIQ API running on http://localhost:${port}`);
  console.log(`Health: http://localhost:${port}/health`);
});

module.exports = app;
