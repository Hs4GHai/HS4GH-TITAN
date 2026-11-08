const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });

const now = () => new Date().toISOString();

async function initDB(db) {
  const sql = [
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
      lot REAL NOT NULL DEFAULT 0.05,
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

  for (const q of sql) await db.prepare(q).run();

  await db.prepare(`
    INSERT OR IGNORE INTO accounts
    (id,balance,equity,currency,created_at)
    VALUES ('DEMO-001',25000,25000,'USD',?)
  `).bind(now()).run();

  await db.prepare(`
    INSERT OR IGNORE INTO auto_settings (id) VALUES (1)
  `).run();
}

function isAuthorized(request, env) {
  return Boolean(env.API_SECRET) &&
    request.headers.get("Authorization") === `Bearer ${env.API_SECRET}`;
}

async function getGoldCandles(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is not configured");
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error("Market data provider unavailable");

  const data = await r.json();
  if (!data.values || !Array.isArray(data.values)) {
    throw new Error(data.message || "No XAUUSD market data");
  }

  return data.values.reverse().map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function analyze(candles) {
  const closes = candles.map(c => c.close);
  if (closes.length < 30) throw new Error("Not enough candles");

  const fast = ema(closes.slice(-30), 9);
  const slow = ema(closes.slice(-30), 21);
  const last = closes[closes.length - 1];
  const previous = closes[closes.length - 2];

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - 15; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const rs = gains / Math.max(losses, 0.000001);
  const rsi = 100 - 100 / (1 + rs);

  let signal = "WAIT";
  if (fast > slow && last > previous && rsi >= 50 && rsi <= 68) {
    signal = "BUY";
  } else if (fast < slow && last < previous && rsi >= 32 && rsi <= 50) {
    signal = "SELL";
  }

  return {
    symbol: "XAUUSD",
    signal,
    price: last,
    rsi: Number(rsi.toFixed(2)),
    ema9: Number(fast.toFixed(3)),
    ema21: Number(slow.toFixed(3)),
    reason: "EMA 9/21 + RSI 14 + 1-minute price direction"
  };
}

async function logEvent(db, message) {
  await db.prepare(
    "INSERT INTO bot_events (message,created_at) VALUES (?,?)"
  ).bind(String(message).slice(0,500), now()).run();
}

async function runCycle(env) {
  await initDB(env.DB);

  const settings = await env.DB.prepare(
    "SELECT * FROM auto_settings WHERE id=1"
  ).first();

  if (!settings || settings.enabled !== 1 ||
      settings.mode !== "DEMO_ONLY") {
    return { status: "DISABLED" };
  }

  const candles = await getGoldCandles(env);
  const analysis = analyze(candles);

  await env.DB.prepare(`
    INSERT INTO analyses
    (symbol,signal,reason,price,provider,created_at)
    VALUES (?,?,?,?,?,?)
  `).bind(
    "XAUUSD",
    analysis.signal,
    analysis.reason,
    analysis.price,
    "TWELVE_DATA",
    now()
  ).run();

  const openCount = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM trades WHERE status='OPEN'"
  ).first();

  if ((openCount?.total || 0) >= Math.min(settings.max_trades,25)) {
    await logEvent(env.DB, "Maximum open trades reached");
    return { status: "MAX_TRADES", analysis };
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM trades WHERE symbol='XAUUSD' AND status='OPEN' LIMIT 1"
  ).first();

  if (existing || analysis.signal === "WAIT") {
    return { status: "NO_NEW_TRADE", analysis };
  }

  const account = await env.DB.prepare(
    "SELECT * FROM accounts WHERE id='DEMO-001'"
  ).first();

  const dayStart = new Date();
  dayStart.setUTCHours(0,0,0,0);

  const daily = await env.DB.prepare(`
    SELECT COALESCE(SUM(pnl),0) AS pnl
    FROM trades
    WHERE status='CLOSED' AND closed_at >= ?
  `).bind(dayStart.toISOString()).first();

  const dailyLimit = account.balance *
    (Math.min(settings.daily_loss_limit,3) / 100);

  if ((daily?.pnl || 0) <= -dailyLimit) {
    await logEvent(env.DB, "Daily loss limit reached; entries paused");
    return { status: "DAILY_LOSS_LIMIT", analysis };
  }

  const entry = analysis.price;
  const stopDistance = entry * 0.003;
  const stop = analysis.signal === "BUY"
    ? entry - stopDistance : entry + stopDistance;
  const target = analysis.signal === "BUY"
    ? entry + stopDistance * 1.5 : entry - stopDistance * 1.5;

  // XAUUSD standard contract assumption: 100 oz per 1.00 lot.
  // 0.05 lot therefore represents 5 oz in this paper simulation.
  const lot = 0.05;
  const estimatedRisk = stopDistance * lot * 100;
  const maxRisk = account.balance *
    (Math.min(settings.risk_percent,0.5) / 100);

  if (estimatedRisk > maxRisk) {
    await logEvent(env.DB, "Trade skipped: estimated risk exceeds limit");
    return { status: "RISK_LIMIT", analysis, estimatedRisk, maxRisk };
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO trades
    (id,symbol,side,lot,entry,stop_loss,take_profit,status,pnl,opened_at)
    VALUES (?,?,?,?,?,?,?,'OPEN',0,?)
  `).bind(
    id,"XAUUSD",analysis.signal,lot,entry,stop,target,now()
  ).run();

  await logEvent(env.DB, `DEMO ${analysis.signal} XAUUSD opened: ${id}`);

  return { status: "DEMO_TRADE_OPENED", trade_id: id, analysis };
}

async function manageOpenTrades(env) {
  const candles = await getGoldCandles(env);
  const price = candles[candles.length - 1].close;

  const result = await env.DB.prepare(
    "SELECT * FROM trades WHERE status='OPEN' AND symbol='XAUUSD'"
  ).all();

  for (const trade of (result.results || [])) {
    let exit = null;

    if (trade.side === "BUY") {
      if (price <= trade.stop_loss) exit = trade.stop_loss;
      else if (price >= trade.take_profit) exit = trade.take_profit;
    } else {
      if (price >= trade.stop_loss) exit = trade.stop_loss;
      else if (price <= trade.take_profit) exit = trade.take_profit;
    }

    if (exit === null) continue;

    const pnl = (trade.side === "BUY"
      ? exit - trade.entry
      : trade.entry - exit) * trade.lot * 100;

    const update = await env.DB.prepare(`
      UPDATE trades SET status='CLOSED',pnl=?,closed_at=?
      WHERE id=? AND status='OPEN'
    `).bind(pnl,now(),trade.id).run();

    if (update.meta?.changes === 1) {
      await env.DB.prepare(`
        UPDATE accounts SET balance=balance+?,equity=balance+?
        WHERE id='DEMO-001'
      `).bind(pnl,pnl).run();

      await logEvent(env.DB, `Trade closed. PnL: ${pnl.toFixed(2)} USD`);
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null,{status:204,headers:CORS});
    }

    try {
      if (!env.DB) return response({success:false,error:"DB binding missing"},500);
      await initDB(env.DB);

      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/" || path === "/api/health") {
        return response({
          success:true,
          name:"HS4GH TITAN",
          version:"3.0.0",
          status:"ONLINE",
          mode:"DEMO_ONLY",
          database:"CONNECTED",
          timestamp:now()
        });
      }

      if (path === "/api/account" && request.method === "GET") {
        const account = await env.DB.prepare(
          "SELECT * FROM accounts WHERE id='DEMO-001'"
        ).first();
        return response({success:true,account});
      }

      if (path === "/api/trades" && request.method === "GET") {
        const trades = await env.DB.prepare(
          "SELECT * FROM trades ORDER BY opened_at DESC LIMIT 100"
        ).all();
        return response({success:true,trades:trades.results || []});
      }

      if (path === "/api/analyses" && request.method === "GET") {
        const analyses = await env.DB.prepare(
          "SELECT * FROM analyses ORDER BY id DESC LIMIT 50"
        ).all();
        return response({success:true,analyses:analyses.results || []});
      }

      if (path === "/api/bot" && request.method === "GET") {
        const settings = await env.DB.prepare(
          "SELECT * FROM auto_settings WHERE id=1"
        ).first();
        const events = await env.DB.prepare(
          "SELECT * FROM bot_events ORDER BY id DESC LIMIT 20"
        ).all();
        return response({
          success:true,
          autoEnabled:settings.enabled === 1,
          settings,
          events:events.results || []
        });
      }

      if (path === "/api/market" && request.method === "GET") {
        const candles = await getGoldCandles(env);
        return response({
          success:true,
          symbol:"XAUUSD",
          timeframe:"1m",
          candles
        });
      }

      if (!isAuthorized(request,env)) {
        return response({success:false,error:"Unauthorized"},401);
      }

      if (path === "/api/bot" && request.method === "POST") {
        const body = await request.json();
        const enabled = body.enabled === true ? 1 : 0;

        await env.DB.prepare(`
          UPDATE auto_settings
          SET enabled=?,mode='DEMO_ONLY',updated_at=?
          WHERE id=1
        `).bind(enabled,now()).run();

        return response({
          success:true,
          autoEnabled:enabled === 1,
          mode:"DEMO_ONLY"
        });
      }

      if (path === "/api/run-cycle" && request.method === "POST") {
        const result = await runCycle(env);
        return response({success:true,result});
      }

      return response({success:false,error:"Route not found"},404);

    } catch (error) {
      return response({
        success:false,
        error:String(error.message || error)
      },500);
    }
  },

  async scheduled(controller,env,ctx) {
    ctx.waitUntil((async () => {
      try {
        await initDB(env.DB);
        await manageOpenTrades(env);
        await runCycle(env);
      } catch (error) {
        await logEvent(env.DB,String(error.message || error));
      }
    })());
  }
};
