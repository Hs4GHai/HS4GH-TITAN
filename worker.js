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
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n)));

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
    )`
  ];

  for (const s of statements) {
    await db.prepare(s).run();
  }

  for (const s of [
    "ALTER TABLE auto_settings ADD COLUMN tp_distance REAL NOT NULL DEFAULT 0.40",
    "ALTER TABLE auto_settings ADD COLUMN sl_distance REAL NOT NULL DEFAULT 0.40",
    "ALTER TABLE auto_settings ADD COLUMN target_trades_per_minute INTEGER NOT NULL DEFAULT 5"
  ]) {
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
}

function authorized(req, env) {
  return !!env.API_SECRET &&
    req.headers.get("Authorization") === `Bearer ${env.API_SECRET}`;
}

async function log(db, message) {
  await db.prepare(
    "INSERT INTO bot_events(message,created_at) VALUES(?,?)"
  ).bind(String(message).slice(0,500), now()).run();
}

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

function ema(v, p) {
  const k = 2 / (p + 1);
  let out = v[0];

  for (let i = 1; i < v.length; i++) {
    out = v[i] * k + out * (1 - k);
  }

  return out;
}

function analyze(c) {
  const v = c.map(x => x.close);

  if (v.length < 30) {
    throw new Error("Not enough candles for analysis");
  }

  const fast = ema(v.slice(-30), 9);
  const slow = ema(v.slice(-30), 21);

  const last = v.at(-1);
  const prev = v.at(-2);

  let up = 0;
  let down = 0;

  for (let i = v.length - 14; i < v.length; i++) {
    const d = v[i] - v[i - 1];

    if (d > 0) {
      up += d;
    } else {
      down -= d;
    }
  }

  const rs = up / Math.max(down, 1e-8);
  const rsi = 100 - 100 / (1 + rs);

  let signal = "WAIT";

  if (fast > slow && last > prev && rsi >= 50 && rsi <= 68) {
    signal = "BUY";
  }

  if (fast < slow && last < prev && rsi >= 32 && rsi <= 50) {
    signal = "SELL";
  }

  return {
    symbol: "XAUUSD",
    signal,
    price: last,
    rsi: +rsi.toFixed(2),
    ema9: +fast.toFixed(3),
    ema21: +slow.toFixed(3),
    reason: "EMA 9/21 + RSI 14 + 1-minute direction (paper demo)"
  };
}

async function closeTrades(env, price) {
  const db = env.DB;

  const rows = await db.prepare(
    "SELECT * FROM trades WHERE status='OPEN' AND symbol='XAUUSD'"
  ).all();

  for (const t of rows.results || []) {
    const hit = t.side === "BUY"
      ? (
          price <= t.stop_loss ? t.stop_loss :
          price >= t.take_profit ? t.take_profit :
          null
        )
      : (
          price >= t.stop_loss ? t.stop_loss :
          price <= t.take_profit ? t.take_profit :
          null
        );

    if (hit === null) continue;

    const pnl = (
      t.side === "BUY"
        ? hit - t.entry
        : t.entry - hit
    ) * t.lot * 100;

    const changed = await db.prepare(`
      UPDATE trades
      SET status='CLOSED', pnl=?, closed_at=?
      WHERE id=? AND status='OPEN'
    `).bind(pnl, now(), t.id).run();

    if (changed.meta?.changes === 1) {
      await db.prepare(`
        UPDATE accounts
        SET balance=balance+?, equity=balance+?
        WHERE id='DEMO-001'
      `).bind(pnl, pnl).run();

      await log(
        db,
        `DEMO trade ${t.id} closed at ${hit}; P/L ${pnl.toFixed(2)} USD`
      );
    }
  }
}

async function runCycle(env) {
  const db = env.DB;

  const s = await db.prepare(
    "SELECT * FROM auto_settings WHERE id=1"
  ).first();

  if (!s || s.enabled !== 1 || s.mode !== "DEMO_ONLY") {
    return { status: "DISABLED" };
  }

  const candles = await goldCandles(env);
  const a = analyze(candles);

  await db.prepare(`
    INSERT INTO analyses
    (symbol,signal,reason,price,provider,created_at)
    VALUES(?,?,?,?,?,?)
  `).bind(
    "XAUUSD",
    a.signal,
    a.reason,
    a.price,
    "TWELVE_DATA",
    now()
  ).run();

  await closeTrades(env, a.price);

  const open = await db.prepare(
    "SELECT COUNT(*) total FROM trades WHERE status='OPEN' AND symbol='XAUUSD'"
  ).first();

  const openCount = open?.total || 0;
  const maxOpen = Math.min(Number(s.max_trades) || 25, 25);

  if (openCount >= maxOpen) {
    return {
      status: "MAX_OPEN_TRADES",
      open: openCount,
      analysis: a
    };
  }

  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);

  const daily = await db.prepare(`
    SELECT COALESCE(SUM(pnl),0) pnl
    FROM trades
    WHERE status='CLOSED' AND closed_at>=?
  `).bind(day.toISOString()).first();

  const account = await db.prepare(
    "SELECT * FROM accounts WHERE id='DEMO-001'"
  ).first();

  if ((daily?.pnl || 0) <= -(account.balance * 0.03)) {
    await log(db, "Daily loss cap reached; DEMO entries paused");

    return {
      status: "DAILY_LOSS_LIMIT",
      analysis: a
    };
  }

  // DEMO stress-test mode.
  // WAIT is replaced with EMA direction for simulation only.
  const side = a.signal === "BUY"
    ? "BUY"
    : a.signal === "SELL"
      ? "SELL"
      : (a.ema9 >= a.ema21 ? "BUY" : "SELL");

  const lot = clamp(s.lot, 0.01, 0.05);
  const dist = 0.40;

  const sl = side === "BUY"
    ? a.price - dist
    : a.price + dist;

  const tp = side === "BUY"
    ? a.price + dist
    : a.price - dist;

  const risk = dist * lot * 100;
  const maxRisk = account.balance * 0.005;

  if (risk > maxRisk) {
    return {
      status: "RISK_LIMIT",
      risk,
      maxRisk,
      analysis: a
    };
  }

  const count = Math.min(2, maxOpen - openCount);
  const ids = [];

  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();

    await db.prepare(`
      INSERT INTO trades
      (id,symbol,side,lot,entry,stop_loss,take_profit,status,pnl,opened_at)
      VALUES(?,?,?,?,?,?,?,'OPEN',0,?)
    `).bind(
      id,
      "XAUUSD",
      side,
      lot,
      a.price,
      sl,
      tp,
      now()
    ).run();

    ids.push(id);
  }

  await log(
    db,
    `DEMO stress cycle: opened ${count} ${side} XAUUSD trade(s), lot ${lot}, TP/SL 0.40`
  );

  return {
    status: "DEMO_BATCH_OPENED",
    trade_ids: ids,
    count,
    side,
    entry: a.price,
    tp,
    sl,
    lot,
    note: "Two paper trades per browser-triggered cycle; only while dashboard is open."
  };
}

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

      const u = new URL(request.url);
      const p = u.pathname;

      if (p === "/" || p === "/api/health") {
        return json({
          success: true,
          name: "HS4GH TITAN",
          version: "4.0.0",
          status: "ONLINE",
          mode: "DEMO_ONLY",
          database: "CONNECTED",
          timestamp: now()
        });
      }

      if (p === "/api/account" && request.method === "GET") {
        const account = await env.DB.prepare(
          "SELECT * FROM accounts WHERE id='DEMO-001'"
        ).first();

        const open = await env.DB.prepare(
          "SELECT COALESCE(SUM(pnl),0) pnl FROM trades WHERE status='OPEN'"
        ).first();

        return json({
          success: true,
          account,
          equity: account.balance + (open?.pnl || 0)
        });
      }

      if (p === "/api/trades" && request.method === "GET") {
        const x = await env.DB.prepare(
          "SELECT * FROM trades ORDER BY opened_at DESC LIMIT 100"
        ).all();

        return json({
          success: true,
          trades: x.results || []
        });
      }

      if (p === "/api/analyses" && request.method === "GET") {
        const x = await env.DB.prepare(
          "SELECT * FROM analyses ORDER BY id DESC LIMIT 50"
        ).all();

        return json({
          success: true,
          analyses: x.results || []
        });
      }

      if (
        (p === "/api/bot" || p === "/api/status") &&
        request.method === "GET"
      ) {
        const settings = await env.DB.prepare(
          "SELECT * FROM auto_settings WHERE id=1"
        ).first();

        const x = await env.DB.prepare(
          "SELECT * FROM bot_events ORDER BY id DESC LIMIT 20"
        ).all();

        return json({
          success: true,
          autoEnabled: settings.enabled === 1,
          settings,
          events: x.results || [],
          cronExpected: "once per minute"
        });
      }

      if (p === "/api/market" && request.method === "GET") {
        const c = await goldCandles(env);

        return json({
          success: true,
          symbol: "XAUUSD",
          timeframe: "1m",
          candles: c
        });
      }

      if (p === "/api/bot" && request.method === "POST") {
        if (!authorized(request, env)) {
          return json({
            success: false,
            error: "Unauthorized"
          }, 401);
        }

        const b = await request.json();

        const lot = clamp(b.lot ?? 0.01, 0.01, 0.05);
        const tp = Number(b.take_profit ?? 0.40);
        const sl = Number(b.stop_loss ?? 0.40);

        if (
          b.symbol !== "XAUUSD" ||
          b.mode !== "DEMO_ONLY" ||
          tp !== 0.40 ||
          sl !== 0.40
        ) {
          return json({
            success: false,
            error: "Only XAUUSD DEMO_ONLY with TP/SL distance 0.40 is allowed"
          }, 400);
        }

        await env.DB.prepare(`
          UPDATE auto_settings SET
          enabled=?,
          mode='DEMO_ONLY',
          symbol='XAUUSD',
          lot=?,
          tp_distance=0.40,
          sl_distance=0.40,
          target_trades_per_minute=40,
          updated_at=?
          WHERE id=1
        `).bind(
          b.enabled === true ? 1 : 0,
          lot,
          now()
        ).run();

        return json({
          success: true,
          autoEnabled: b.enabled === true,
          mode: "DEMO_ONLY",
          symbol: "XAUUSD",
          lot,
          tp_distance: 0.40,
          sl_distance: 0.40,
          note: "Two simulated trades are opened per cycle when the dashboard requests a cycle; browser must remain open."
        });
      }

      if (p === "/api/run-cycle" && request.method === "POST") {
        if (!authorized(request, env)) {
          return json({
            success: false,
            error: "Unauthorized"
          }, 401);
        }

        return json({
          success: true,
          result: await runCycle(env)
        });
      }

      return json({
        success: false,
        error: "Route not found"
      }, 404);

    } catch (e) {
      return json({
        success: false,
        error: String(e.message || e)
      }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await initDB(env.DB);

        const s = await env.DB.prepare(
          "SELECT enabled,mode FROM auto_settings WHERE id=1"
        ).first();

        if (s?.enabled === 1 && s?.mode === "DEMO_ONLY") {
          const c = await goldCandles(env);
          await closeTrades(env, c[c.length - 1].close);
        }

      } catch (e) {
        try {
          await log(env.DB, e.message || e);
        } catch (_) {}
      }
    })());
  }
};
