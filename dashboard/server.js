const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ── Analytics store (in-memory only) ──────────────────────────────────────────
let analyticsData = { sessions: {}, events: [] };

function getISTTime() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function trackVisit(req) {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim();
  const ua = req.headers["user-agent"] || "unknown";
  const now = getISTTime();
  const nowISO = now.toISOString();
  const dateStr = now.toISOString().slice(0, 10);

  let browser = "Other";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";
  else if (/curl|axios|node/i.test(ua)) browser = "Bot/API";

  if (!analyticsData.sessions[ip]) {
    analyticsData.sessions[ip] = { ip, browser, ua, firstSeen: nowISO, lastSeen: nowISO, totalVisits: 0, refreshes: 0, days: {} };
  }
  const s = analyticsData.sessions[ip];
  s.lastSeen = nowISO;
  s.browser = browser;
  s.totalVisits += 1;
  s.days[dateStr] = (s.days[dateStr] || 0) + 1;

  analyticsData.events.push({ ip, browser, path: req.path, time: nowISO, dateStr });
  if (analyticsData.events.length > 500) analyticsData.events = analyticsData.events.slice(-500);
}

app.use((req, res, next) => {
  const skip = /\.(js|css|png|ico|map|woff|ttf|svg)$/i.test(req.path) || req.path === "/api/status";
  if (!skip) trackVisit(req);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

const APP_URL = "https://lsn.retool.com/app/amazonquick-store-portal";
const QUERY_URL = "https://lsn.retool.com/api/pages/uuids/644f7cc8-a1c9-11ef-8d91-fbdebd641690/query?queryName=get_order_details";
const RETOOL_EMAIL = process.env.RETOOL_EMAIL || "ls-bto-dashboard@amazon.com";
const RETOOL_PASSWORD = process.env.RETOOL_PASSWORD || "lsbto@Amazon";

const STORE_IDS = [
  2734, 4099, 2736, 4101, 3494, 3491, 3495, 3712, 3812, 3813,
  3822, 4042, 4003, 4054, 4123, 4135, 3992, 3997, 3826, 4140,
  4146, 4176, 4092, 4093, 3838, 4049, 4035, 4078, 4215, 4204,
  4033, 4081, 4224
];

let cachedData = null;
let lastFetched = null;
let isFetching = false;
let fetchError = null;

function getTodayIST() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const yyyy = ist.getFullYear();
  const mm = String(ist.getMonth() + 1).padStart(2, "0");
  const dd = String(ist.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildCookieString(setCookieHeader) {
  if (Array.isArray(setCookieHeader)) {
    return setCookieHeader.map(c => c.split(";")[0]).join("; ");
  }
  return String(setCookieHeader)
    .split(/,(?=\s*[^;]+=)/)
    .map(c => c.split(";")[0].trim())
    .join("; ");
}

function getCookieValue(cookie, name) {
  const match = cookie.match(new RegExp(name + "=([^;]+)"));
  return match ? match[1] : "";
}

async function loginRetool() {
  const loginRes = await axios.post(
    "https://lsn.retool.com/api/login",
    { email: RETOOL_EMAIL, password: RETOOL_PASSWORD },
    {
      headers: {
        accept: "*/*",
        origin: "https://lsn.retool.com",
        referer: APP_URL,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "content-type": "application/json"
      }
    }
  );

  const { authUrl, authorizationToken } = loginRes.data;
  if (!authUrl || !authorizationToken) throw new Error("Retool login failed: missing auth data.");

  const authRes = await axios.post(
    authUrl,
    { authorizationToken },
    {
      headers: {
        accept: "*/*",
        origin: "https://lsn.retool.com",
        referer: APP_URL,
        "user-agent": "Mozilla/5.0",
        "content-type": "application/json"
      },
      maxRedirects: 0,
      validateStatus: s => s < 400
    }
  );

  const rawCookie = authRes.headers["set-cookie"];
  if (!rawCookie) throw new Error("No cookies received from Retool auth.");

  const cookie = buildCookieString(rawCookie);
  const accessToken = getCookieValue(cookie, "accessToken");
  const xsrfToken = getCookieValue(cookie, "xsrfToken");

  return { cookie, accessToken, xsrfToken };
}

function extractRows(json) {
  if (!json) return [];
  if (Array.isArray(json.data)) return json.data;
  if (json.data && Array.isArray(json.data.result)) return json.data.result;
  if (Array.isArray(json.queryResult?.data)) return json.queryResult.data;
  if (Array.isArray(json.result?.data)) return json.result.data;
  if (Array.isArray(json.data?.data)) return json.data.data;
  if (Array.isArray(json.queryResult?.data?.rows)) return json.queryResult.data.rows;

  if (json.__retoolWrappedQuery__ === true && json.queryData) {
    const queryData = json.queryData;
    const headers = Object.keys(queryData);
    if (headers.length === 0) return [];
    const rowCount = queryData[headers[0]].length;
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const row = {};
      headers.forEach(h => { row[h] = queryData[h][i]; });
      rows.push(row);
    }
    return rows;
  }
  return [];
}

function getValue(row, keys) {
  const normRow = {};
  for (const k in row) {
    normRow[k.toLowerCase().replace(/[\s_\-]/g, "")] = row[k];
  }
  for (const key of keys) {
    const nk = key.toLowerCase().replace(/[\s_\-]/g, "");
    if (normRow[nk] !== undefined && normRow[nk] !== null && normRow[nk] !== "") {
      return normRow[nk];
    }
  }
  return "";
}

function parseAnyDate(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value.getTime())) return value;

  if (typeof value === "number" || (!isNaN(value) && !String(value).includes("-") && !String(value).includes("/"))) {
    let num = Number(value);
    if (num < 10000000000) num = num * 1000;
    return new Date(num);
  }

  let text = String(value).trim();

  if (text.includes("T") || text.includes("Z")) {
    if (text.endsWith("Z")) text = text.slice(0, -1);
    if (!text.includes("+")) text = text + "+05:30";
    const d = new Date(text);
    if (!isNaN(d.getTime())) return d;
  }

  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (slashMatch) {
    const [, dd, mm, yyyy, hh, min, ss] = slashMatch;
    return new Date(`${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}T${hh.padStart(2,"0")}:${min.padStart(2,"0")}:${ss.padStart(2,"0")}.000+05:30`);
  }

  const dashMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (dashMatch) {
    const [, yyyy, mm, dd, hh, min, ss] = dashMatch;
    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.000+05:30`);
  }

  const fb = new Date(text);
  return !isNaN(fb.getTime()) ? fb : null;
}

function processRows(rows, dateStr) {
  const summary = {};

  rows.forEach(row => {
    if (!row) return;

    const store = getValue(row, ["store_name", "storeName", "Store", "warehouse_name"]) || "UNKNOWN";
    const orderId = getValue(row, ["lsn_order_id", "amazon_order_id", "order_id", "orderId", "id"]) || "";

    const createdAtRaw  = getValue(row, ["created_time", "created_at", "createdAt", "order_created_at"]);
    const packagedAtRaw = getValue(row, ["staged_time", "staged_at", "stagedAt", "packaged_time", "packaged_at", "packed_at"]);
    const acceptedAtRaw = getValue(row, [
      "accepted_time", "accepted_at", "acceptedAt",
      "picking_started_at", "pick_started_at", "picker_accepted_at",
      "assignment_time", "assigned_at", "assignedAt"
    ]);

    const total     = Number(getValue(row, ["total", "total_amount", "amount"]) || 0);
    const itemCount = Number(getValue(row, [
      "item_count", "itemCount", "items_count", "total_items",
      "quantity", "total_quantity", "units", "u2o"
    ]) || 0);

    const createdAt  = parseAnyDate(createdAtRaw);
    const packagedAt = parseAnyDate(packagedAtRaw);
    const acceptedAt = parseAnyDate(acceptedAtRaw);

    let instoreMinutes = null;
    if (createdAt && packagedAt) {
      const diffMs = packagedAt.getTime() - createdAt.getTime();
      instoreMinutes = diffMs / 1000 / 60;
    }

    let packingSeconds = null;
    if (acceptedAt && packagedAt) {
      const diffMs = packagedAt.getTime() - acceptedAt.getTime();
      if (diffMs >= 0) packingSeconds = diffMs / 1000;
    }

    const key = `${dateStr}_${store}`;
    let patMinutes = null;
    if (createdAt && acceptedAt) {
      const diffMs = acceptedAt.getTime() - createdAt.getTime();
      if (diffMs >= 0) patMinutes = diffMs / 1000 / 60;
    }

    if (!summary[key]) {
      summary[key] = {
        date: dateStr, storeName: store,
        orderIds: {}, orderCount: 0,
        instoreTotal: 0, instoreCount: 0,
        packingTotal: 0, packingCount: 0,
        totalAmount: 0, totalCount: 0,
        itemTotal: 0, itemCount: 0,
        patTotal: 0, patCount: 0
      };
    }

    const g = summary[key];
    if (orderId) g.orderIds[orderId] = true;
    else g.orderCount += 1;

    if (instoreMinutes !== null && !isNaN(instoreMinutes) && instoreMinutes >= 0) {
      g.instoreTotal += instoreMinutes;
      g.instoreCount += 1;
    }
    if (packingSeconds !== null && !isNaN(packingSeconds)) {
      g.packingTotal += packingSeconds;
      g.packingCount += 1;
    }
    if (patMinutes !== null && !isNaN(patMinutes)) {
      g.patTotal += patMinutes;
      g.patCount += 1;
    }
    if (total > 0) {
      g.totalAmount += total;
      g.totalCount += 1;
    }
    if (itemCount > 0) {
      g.itemTotal += itemCount;
      g.itemCount += 1;
    }
  });

  return Object.values(summary)
    .map(s => {
      const completedOrders = Object.keys(s.orderIds).length > 0 ? Object.keys(s.orderIds).length : s.orderCount;
      const avgInstoreTime  = s.instoreCount > 0  ? parseFloat((s.instoreTotal / s.instoreCount).toFixed(2)) : 0;
      const avgU2O          = s.totalCount > 0    ? parseFloat((s.totalAmount  / s.totalCount).toFixed(2))   : 0;
      const avgPackingTime  = s.packingCount > 0  ? s.packingTotal / s.packingCount : 0;
      const avgItemsPerOrder= s.itemCount > 0     ? s.itemTotal    / s.itemCount    : (avgU2O || 1);
      const ppi             = avgItemsPerOrder > 0 ? parseFloat((avgPackingTime / avgItemsPerOrder).toFixed(2)) : 0;
      const avgPat          = s.patCount > 0      ? parseFloat((s.patTotal / s.patCount).toFixed(2)) : 0;

      return { date: s.date, storeName: s.storeName, completedOrders, avgInstoreTime, avgU2O, ppi, avgPat };
    })
    .sort((a, b) => b.completedOrders - a.completedOrders);
}

async function fetchAllData() {
  if (isFetching) return;
  isFetching = true;
  fetchError = null;

  try {
    console.log("[Fetch] Starting Retool login...");
    const auth = await loginRetool();
    console.log("[Fetch] Login successful. Fetching store data...");

    const dateStr = getTodayIST();
    const allRows = [];
    const batchSize = 5;

    for (let i = 0; i < STORE_IDS.length; i += batchSize) {
      const storeBatch = STORE_IDS.slice(i, i + batchSize);
      console.log(`[Fetch] Batch ${Math.floor(i / batchSize) + 1}: stores ${storeBatch.join(", ")}`);

      const payload = {
        userParams: {
          queryParams: {
            0: 582576,
            1: 22411,
            2: dateStr,
            3: dateStr,
            4: false,
            5: storeBatch,
            6: true,
            7: "",
            length: 8
          },
          databaseNameOverrideParams: { length: 0 },
          databaseHostOverrideParams: { length: 0 },
          databaseUsernameOverrideParams: { length: 0 },
          databasePasswordOverrideParams: { length: 0 }
        },
        queryType: "SqlQueryUnified",
        environment: "production",
        showLatest: false,
        isEditorMode: false,
        frontendVersion: "1",
        releaseVersion: null,
        includeQueryExecutionMetadata: true,
        streamResponse: false,
        isEmbedded: false
      };

      try {
        const res = await axios.post(QUERY_URL, payload, {
          headers: {
            accept: "*/*",
            origin: "https://lsn.retool.com",
            referer: APP_URL,
            cookie: auth.cookie,
            "x-xsrf-token": auth.xsrfToken,
            authorization: "Bearer " + auth.accessToken,
            timestamp: String(Date.now()),
            "x-retool-client-version": "3.391.0-8ce84d7 (Build 337755)",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
            "content-type": "application/json"
          }
        });

        const rows = extractRows(res.data);
        rows.forEach(r => { r.report_date = dateStr; allRows.push(r); });
        console.log(`[Fetch] Batch ${Math.floor(i / batchSize) + 1} returned ${rows.length} rows.`);
      } catch (batchErr) {
        console.error(`[Fetch] Batch ${Math.floor(i / batchSize) + 1} failed:`, batchErr.message);
      }

      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[Fetch] Total rows collected: ${allRows.length}`);
    cachedData = processRows(allRows, dateStr);
    lastFetched = new Date();
    console.log(`[Fetch] Done. ${cachedData.length} store summaries processed.`);
  } catch (err) {
    console.error("[Fetch] Fatal error:", err.message);
    fetchError = err.message;
  } finally {
    isFetching = false;
  }
}

app.get("/api/data", (req, res) => {
  res.json({
    data: cachedData,
    lastFetched: lastFetched ? lastFetched.toISOString() : null,
    isFetching,
    error: fetchError
  });
});

app.post("/api/refresh", async (req, res) => {
  if (isFetching) {
    return res.json({ message: "Fetch already in progress.", isFetching: true });
  }
  fetchAllData();
  res.json({ message: "Refresh started.", isFetching: true });
});

app.get("/api/status", (req, res) => {
  res.json({ isFetching, lastFetched: lastFetched ? lastFetched.toISOString() : null, error: fetchError });
});

app.get("/api/analytics", (req, res) => {
  const sessions = Object.values(analyticsData.sessions);
  const now = getISTTime();
  const todayStr = now.toISOString().slice(0, 10);

  const todayEvents = analyticsData.events.filter(e => e.dateStr === todayStr);
  const todayIPs = [...new Set(todayEvents.map(e => e.ip))];

  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const activeNow = sessions.filter(s => s.lastSeen >= tenMinAgo);

  res.json({
    totalUniqueVisitors: sessions.length,
    todayUniqueVisitors: todayIPs.length,
    todayPageViews: todayEvents.length,
    activeNow: activeNow.length,
    sessions: sessions.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    recentEvents: analyticsData.events.slice(-100).reverse()
  });
});

app.get("/analytics", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "analytics.html"));
});

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  fetchAllData();
});
