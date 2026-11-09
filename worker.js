const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...CORS, "Content-Type": "application/json" }
});

const now = () => new Date().toISOString();

async function initDB(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      balance REAL NOT NULL DEFAULT 25000,
      equity REAL NOT NULL DEFAULT 25000,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      lot REAL NOT NULL,
      entry REAL NOT NULL,
      stop_loss REAL NOT NULL,
      take_profit REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      pnl REAL NOT NULL DEFAULT 0,
      opened_at TEXT NOT NULL,
      closed_at TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      signal TEXT NOT NULL,
      reason TEXT NOT NULL,
      price REAL,
      provider TEXT,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS auto_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'DEMO_ONLY',
      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      lot REAL NOT NULL DEFAULT 0.01,
      max_trades INTEGER NOT NULL DEFAULT 25,
      risk_percent REAL NOT NULL DEFAULT 0.5,
      daily_loss_limit REAL NOT NULL DEFAULT 3,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS bot_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS engine_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      last_cycle_at TEXT
    )`
  ];

  for (const s of statements) {
    await db.prepare(s).run();
  }

  // Database migrations
  const migrations = [
    "ALTER TABLE auto_settings ADD COLUMN tp_distance REAL NOT NULL DEFAULT 0.40",
    "ALTER TABLE auto_settings ADD COLUMN sl_distance REAL NOT NULL DEFAULT 0.40",
    "ALTER TABLE auto_settings ADD COLUMN target_trades_per_minute INTEGER NOT NULL DEFAULT 5",
    "ALTER TABLE auto_settings ADD COLUMN allow_buy INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE auto_settings ADD COLUMN allow_sell INTEGER NOT NULL DEFAULT 1"
  ];

  for (const s of migrations) {
    try {
      await db.prepare(s).run();
    } catch (_) {}
  }

  await db.prepare(`
    INSERT OR IGNORE INTO accounts
    (id,balance,equity,currency,created_at)
    VALUES ('DEMO-001',25000,25000,'USD',?)
  `).bind(now()).run();

  await db.prepare(
    "INSERT OR IGNORE INTO auto_settings (id) VALUES (1)"
  ).run();

  await db.prepare(
    "INSERT OR IGNORE INTO engine_state (id,last_cycle_at) VALUES (1,NULL)"
  ).run();
}

function authorized(req, env) {
  return !!env.API_SECRET &&
    req.headers.get("Authorization") === `Bearer ${env.API_SECRET}`;
}

async function log(db, message) {
  await db.prepare(`
    INSERT INTO bot_events(message,created_at)
    VALUES(?,?)
  `).bind(String(message).slice(0, 500), now()).run();
}

// ==========================================
// MARKET DATA - TWELVE DATA
// ==========================================

async function goldCandles(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is not configured");
  }

  const u = new URL(
    "https://api.twelvedata.com/time_series"
  );

  u.searchParams.set("symbol", "XAU/USD");
  u.searchParams.set("interval", "1min");
  u.searchParams.set("outputsize", "100");
  u.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

  const r = await fetch(u);

  if (!r.ok) {
    throw new Error("Market data provider unavailable");
  }

  const d = await r.json();

  if (!Array.isArray(d.values)) {
    throw new Error(d.message || "No gold candles returned");
  }

  return d.values.reverse().map(x => ({
    open: +x.open,
    high: +x.high,
    low: +x.low,
    close: +x.close
  })).filter(x => Number.isFinite(x.close));
}

// ==========================================
// TECHNICAL ANALYSIS
// ==========================================

function ema(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function analyze(candles) {
  const values = candles.map(x => x.close);

  if (values.length < 30) {
    throw new Error("Not enough candles for analysis");
  }

  const fast = ema(values.slice(-30), 9);
  const slow = ema(values.slice(-30), 21);

  const last = values.at(-1);
  const previous = values.at(-2);

  let gains = 0;
  let losses = 0;

  for (let i = values.length - 14; i < values.length; i++) {
    const difference = values[i] - values[i - 1];

    if (difference > 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  const rs = gains / Math.max(losses, 1e-8);
  const rsi = 100 - (100 / (1 + rs));

  const momentum = last - previous;

  let signal = "WAIT";

  if (
    fast > slow &&
    momentum > 0 &&
    rsi >= 50 &&
    rsi <= 70
  ) {
    signal = "BUY";
  }

  else if (
    fast < slow &&
    momentum < 0 &&
    rsi >= 30 &&
    rsi <= 50
  ) {
    signal = "SELL";
  }

  const trend =
    fast > slow ? "BUY" :
    fast < slow ? "SELL" :
    "WAIT";

  return {
    symbol: "XAUUSD",
    signal,
    trend,
    price: last,
    rsi: +rsi.toFixed(2),
    ema9: +fast.toFixed(3),
    ema21: +slow.toFixed(3),
    momentum: +momentum.toFixed(4),

    reason:
      "EMA 9/21 + RSI 14 + 1-minute direction"
  };
}

// ==========================================
// CLOSE OPEN TRADES
// ==========================================

async function closeTrades(env, price) {
  const db = env.DB;

  const rows = await db.prepare(`
    SELECT *
    FROM trades
    WHERE status='OPEN'
    AND symbol='XAUUSD'
  `).all();

  for (const trade of rows.results || []) {

    let hit = null;

    if (trade.side === "BUY") {
      hit =
        price <= trade.stop_loss
          ? trade.stop_loss
          : price >= trade.take_profit
          ? trade.take_profit
          : null;
    }

    else if (trade.side === "SELL") {
      hit =
        price >= trade.stop_loss
          ? trade.stop_loss
          : price <= trade.take_profit
          ? trade.take_profit
          : null;
    }

    if (hit === null) continue;

    const pnl =
      (trade.side === "BUY"
        ? hit - trade.entry
        : trade.entry - hit
      ) * trade.lot * 100;

    const changed = await db.prepare(`
      UPDATE trades
      SET status='CLOSED',
          pnl=?,
          closed_at=?
      WHERE id=?
      AND status='OPEN'
    `).bind(pnl, now(), trade.id).run();

    if (changed.meta?.changes === 1) {

      await db.prepare(`
        UPDATE accounts
        SET balance=balance+?,
            equity=balance+?
        WHERE id='DEMO-001'
      `).bind(pnl, pnl).run();

      await log(
        db,
        `DEMO trade ${trade.id} closed at ${hit}; P/L ${pnl.toFixed(2)} USD`
      );
    }
  }
}

// ==========================================
// MAIN TRADING ENGINE
// ==========================================

async function runCycle(env) {
  const db = env.DB;

  const settings = await db.prepare(`
    SELECT *
    FROM auto_settings
    WHERE id=1
  `).first();

  if (
    !settings ||
    settings.enabled !== 1 ||
    settings.mode !== "DEMO_ONLY"
  ) {
    return { status: "DISABLED" };
  }

  // Cycle throttle
  const stamp = now();

  const cutoff = new Date(
    Date.now() - 1800
  ).toISOString();

  const lock = await db.prepare(`
    UPDATE engine_state
    SET last_cycle_at=?
    WHERE id=1
    AND (
      last_cycle_at IS NULL
      OR last_cycle_at<=?
    )
  `).bind(stamp, cutoff).run();

  if (lock.meta?.changes !== 1) {
    return {
      status: "CYCLE_THROTTLED",
      retry_after_ms: 2000
    };
  }

  // Fetch market data
  const candles = await goldCandles(env);

  // Analyze market
  const analysis = analyze(candles);

  await db.prepare(`
    INSERT INTO analyses
    (symbol,signal,reason,price,provider,created_at)
    VALUES(?,?,?,?,?,?)
  `).bind(
    "XAUUSD",
    analysis.signal,
    analysis.reason,
    analysis.price,
    "TWELVE_DATA_1M",
    now()
  ).run();

  // Manage existing positions
  await closeTrades(env, analysis.price);

  const open = await db.prepare(`
    SELECT COUNT(*) total
    FROM trades
    WHERE status='OPEN'
    AND symbol='XAUUSD'
  `).first();

  const openCount = open?.total || 0;
  const maxOpen = Math.min(
    Number(settings.max_trades) || 25,
    25
  );

  if (openCount >= maxOpen) {
    return {
      status: "MAX_OPEN_TRADES",
      open: openCount,
      max_open: maxOpen,
      analysis
    };
  }

  // Daily loss protection
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);

  const daily = await db.prepare(`
    SELECT COALESCE(SUM(pnl),0) pnl
    FROM trades
    WHERE status='CLOSED'
    AND closed_at>=?
  `).bind(day.toISOString()).first();

  const account = await db.prepare(`
    SELECT *
    FROM accounts
    WHERE id='DEMO-001'
  `).first();

  const dailyLimit = account.balance * 0.03;

  if ((daily?.pnl || 0) <= -dailyLimit) {
    await log(db, "Daily loss cap reached; DEMO entries paused");

    return {
      status: "DAILY_LOSS_LIMIT",
      analysis
    };
  }

  // BUY / SELL direction
  const side =
    analysis.signal === "BUY"
      ? "BUY"
      : analysis.signal === "SELL"
      ? "SELL"
      : analysis.trend;

  if (side === "WAIT") {
    await log(
      db,
      "No entry: neutral market; BUY and SELL are both enabled"
    );

    return {
      status: "NO_SIGNAL",
      side: "WAIT",
      analysis,
      allowed_sides: ["BUY", "SELL"]
    };
  }

  if (
    (side === "BUY" && Number(settings.allow_buy) === 0) ||
    (side === "SELL" && Number(settings.allow_sell) === 0)
  ) {
    return {
      status: "DIRECTION_DISABLED",
      side,
      analysis
    };
  }

  // DEMO trade configuration
  const lot = 0.02;
  const distance = 0.80;

  const stopLoss =
    side === "BUY"
      ? analysis.price - distance
      : analysis.price + distance;

  const takeProfit =
    side === "BUY"
      ? analysis.price + distance
      : analysis.price - distance;

  const riskPerTrade =
    distance * lot * 100;

  const batchCount = Math.min(
    5,
    maxOpen - openCount
  );

  const batchRisk =
    riskPerTrade * batchCount;

  const maxRisk =
    account.balance * 0.005;

  if (batchRisk > maxRisk) {
    return {
      status: "RISK_LIMIT",
      batchRisk,
      maxRisk,
      analysis
    };
  }

  // Open simulated positions
  const ids = [];

  for (let i = 0; i < batchCount; i++) {

    const id = crypto.randomUUID();

    await db.prepare(`
      INSERT INTO trades
      (
        id,
        symbol,
        side,
        lot,
        entry,
        stop_loss,
        take_profit,
        status,
        pnl,
        opened_at
      )
      VALUES(?,?,?,?,?,?,?,'OPEN',0,?)
    `).bind(
      id,
      "XAUUSD",
      side,
      lot,
      analysis.price,
      stopLoss,
      takeProfit,
      now()
    ).run();

    ids.push(id);
  }

  await log(
    db,
    `DEMO batch: opened ${batchCount} ${side} XAUUSD positions`
  );

  return {
    status: "DEMO_BATCH_OPENED",
    trade_ids: ids,
    count: batchCount,
    side,
    entry: analysis.price,
    tp: takeProfit,
    sl: stopLoss,
    lot,
    allowed_sides: ["BUY", "SELL"],
    batch_risk_estimate_usd: +batchRisk.toFixed(2),
    max_open: maxOpen,

    note:
      "Simulated positions only. Browser must remain open for 2-second requested cycles."
  };
}

// ==========================================
// CLOUDFLARE WORKER API
// ==========================================

export default {

  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    try {

      if (!env.DB) {
        return json({
          success: false,
          error: "DB binding missing"
        }, 500);
      }

      await initDB(env.DB);

      const url = new URL(request.url);
      const path = url.pathname;

      // HEALTH
      if (
        path === "/" ||
        path === "/api/health"
      ) {
        return json({
          success: true,
          name: "HS4GH TITAN",
          version: "6.0.0",
          status: "ONLINE",
          mode: "DEMO_ONLY",
          database: "CONNECTED",
          timestamp: now()
        });
      }

      // ACCOUNT
      if (
        path === "/api/account" &&
        request.method === "GET"
      ) {
        const account = await env.DB.prepare(`
          SELECT *
          FROM accounts
          WHERE id='DEMO-001'
        `).first();

        const open = await env.DB.prepare(`
          SELECT COALESCE(SUM(pnl),0) pnl
          FROM trades
          WHERE status='OPEN'
        `).first();

        return json({
          success: true,
          account,
          equity: account.balance + (open?.pnl || 0)
        });
      }

      // TRADES
      if (
        path === "/api/trades" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(`
          SELECT *
          FROM trades
          ORDER BY opened_at DESC
          LIMIT 100
        `).all();

        return json({
          success: true,
          trades: result.results || []
        });
      }

      // ANALYSES
      if (
        path === "/api/analyses" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(`
          SELECT *
          FROM analyses
          ORDER BY id DESC
          LIMIT 50
        `).all();

        return json({
          success: true,
          analyses: result.results || []
        });
      }

      // BOT STATUS
      if (
        (path === "/api/bot" || path === "/api/status") &&
        request.method === "GET"
      ) {
        const settings = await env.DB.prepare(`
          SELECT *
          FROM auto_settings
          WHERE id=1
        `).first();

        const events = await env.DB.prepare(`
          SELECT *
          FROM bot_events
          ORDER BY id DESC
          LIMIT 20
        `).all();

        return json({
          success: true,
          autoEnabled: settings.enabled === 1,
          settings,
          events: events.results || [],
          cronExpected: "once per minute"
        });
      }

      // MARKET DATA
      if (
        path === "/api/market" &&
        request.method === "GET"
      ) {
        const candles = await goldCandles(env);

        return json({
          success: true,
          symbol: "XAUUSD",
          timeframe: "1m",
          candles
        });
      }

      // START / STOP BOT
      if (
        path === "/api/bot" &&
        request.method === "POST"
      ) {
        if (!authorized(request, env)) {
          return json({
            success: false,
            error: "Unauthorized"
          }, 401);
        }

        const body = await request.json();

        const lot = Number(body.lot ?? 0.02);
        const tp = Number(body.take_profit ?? 0.80);
        const sl = Number(body.stop_loss ?? 0.80);

        if (
          body.symbol !== "XAUUSD" ||
          body.mode !== "DEMO_ONLY" ||
          lot !== 0.02 ||
          tp !== 0.80 ||
          sl !== 0.80
        ) {
          return json({
            success: false,
            error: "Locked profile: XAUUSD DEMO_ONLY, lot 0.02, TP/SL distance 0.80"
          }, 400);
        }

        await env.DB.prepare(`
          UPDATE auto_settings
          SET enabled=?,
              mode='DEMO_ONLY',
              symbol='XAUUSD',
              lot=?,
              max_trades=25,
              tp_distance=0.80,
              sl_distance=0.80,
              target_trades_per_minute=150,
              allow_buy=1,
              allow_sell=1,
              updated_at=?
          WHERE id=1
        `).bind(
          body.enabled === true ? 1 : 0,
          lot,
          now()
        ).run();

        return json({
          success: true,
          autoEnabled: body.enabled === true,
          mode: "DEMO_ONLY",
          symbol: "XAUUSD",
          lot,
          tp_distance: 0.80,
          sl_distance: 0.80,
          batch_size: 5,
          interval_ms: 2000,
          max_open: 25,
          allowed_sides: ["BUY", "SELL"],

          note:
            "Simulated positions only."
        });
      }

      // RUN TRADING CYCLE
      if (
        path === "/api/run-cycle" &&
        request.method === "POST"
      ) {
        if (!authorized(request, env)) {
          return json({
            success: false,
            error: "Unauthorized"
          }, 401);
        }

        const result = await runCycle(env);

        return json({
          success: true,
          result
        });
      }

      return json({
        success: false,
        error: "Route not found"
      }, 404);

    } catch (error) {

      return json({
        success: false,
        error: String(error.message || error)
      }, 500);
    }
  },

  // CRON - once per minute
  async scheduled(controller, env, ctx) {

    ctx.waitUntil((async () => {

      try {

        await initDB(env.DB);

        const settings = await env.DB.prepare(`
          SELECT enabled,mode
          FROM auto_settings
          WHERE id=1
        `).first();

        if (
          settings?.enabled === 1 &&
          settings?.mode === "DEMO_ONLY"
        ) {
          const candles = await goldCandles(env);

          await closeTrades(
            env,
            candles[candles.length - 1].close
          );
        }

      } catch (error) {

        try {
          await log(env.DB, error.message || error);
        } catch (_) {}

      }

    })());
  }
};
