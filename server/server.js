// server/server.js
// ✅ RPS64 Backend — Stripe + (Firebase OR Fake DB) + Queue + Stripe Connect

import express from "express";
import cors from "cors";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

/* ============================================================
   CONFIG / FLAGS
============================================================ */
const USE_FAKE = String(process.env.USE_FAKE_BACKEND || "").trim() === "1";
const FRONTEND = process.env.FRONTEND_URL || "*";
const PORT = process.env.PORT || 8080;

// Stripe
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("⚠️ STRIPE_SECRET_KEY not set");
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
});

/* ============================================================
   DATA LAYER (Firebase Admin OR Fake)
============================================================ */

let db;   // must expose .collection(name): { doc(id): { set(), get() }, get(), orderBy().limit().get() }
let auth; // must expose verifyIdToken(), getUser()

if (!USE_FAKE) {
  // --- REAL FIREBASE ADMIN ---
  let admin;
  try {
    const mod = await import("firebase-admin");
    admin = mod.default;
  } catch (e) {
    console.error("❌ Failed to import firebase-admin:", e);
  }

  // Try JSON string via FIREBASE_ADMIN_KEY (Render/Env)
  let initialized = false;
  if (admin && !admin.apps.length) {
    const svcJson = process.env.FIREBASE_ADMIN_KEY;
    if (svcJson) {
      try {
        const serviceAccount = JSON.parse(svcJson);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        initialized = true;
        console.log("✅ Firebase initialized from FIREBASE_ADMIN_KEY");
      } catch (err) {
        console.error("❌ FIREBASE_ADMIN_KEY JSON parse error:", err);
      }
    }
  }

  // Fallback to GOOGLE_APPLICATION_CREDENTIALS (local file path)
  if (admin && !admin.apps.length) {
    try {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
      initialized = true;
      console.log("✅ Firebase initialized from GOOGLE_APPLICATION_CREDENTIALS");
    } catch (err) {
      console.error("❌ Firebase applicationDefault init failed:", err);
    }
  }

  if (!admin || !initialized) {
    console.error("❌ Firebase not initialized. Set USE_FAKE_BACKEND=1 to proceed without Firebase.");
  }

  db = admin?.firestore ? admin.firestore() : undefined;
  auth = admin?.auth ? admin.auth() : undefined;
} else {
  // --- FAKE (IN-MEMORY) ---
  console.log("🧪 Using FAKE backend (no Firebase). Set USE_FAKE_BACKEND=0 to use real Firebase.");

  const mem = {
    queue: new Map(),           // uid -> {uid, paid, joinedAt, ...}
    stripeAccounts: new Map(),  // uid -> {uid, accountId, createdAt}
  };

  db = {
    collection: (name) => {
      if (name === "queue") {
        return {
          doc: (id) => ({
            async set(data, opts) {
              const prev = mem.queue.get(id) || {};
              mem.queue.set(id, { ...prev, ...data });
            },
            async get() {
              const v = mem.queue.get(id);
              return { exists: !!v, data: () => v };
            },
          }),
          async get() {
            const docs = Array.from(mem.queue.values()).map((v) => ({ data: () => v }));
            return { docs, size: docs.length };
          },
          orderBy() {
            return {
              limit(n) {
                return {
                  async get() {
                    const docs = Array.from(mem.queue.values())
                      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))
                      .slice(0, n)
                      .map((v) => ({ data: () => v }));
                    return { docs, size: docs.length };
                  },
                };
              },
            };
          },
        };
      }
      if (name === "stripeAccounts") {
        return {
          doc: (id) => ({
            async set(data, opts) {
              const prev = mem.stripeAccounts.get(id) || {};
              mem.stripeAccounts.set(id, { ...prev, ...data });
            },
            async get() {
              const v = mem.stripeAccounts.get(id);
              return { exists: !!v, data: () => v };
            },
          }),
        };
      }
      // empty shape
      return {
        doc: () => ({ async set() {}, async get() { return { exists: false, data: () => null }; } }),
        async get() { return { docs: [], size: 0 }; },
        orderBy() { return { limit() { return { async get() { return { docs: [], size: 0 }; } }; } }; },
      };
    },
  };

  auth = {
    async verifyIdToken() {
      return { uid: "test-user" };
    },
    async getUser(uid) {
      return { email: "test@example.com", uid };
    },
  };
}

/* ============================================================
   AUTH HELPERS
============================================================ */
async function verifyUser(req) {
  if (!auth) throw new Error("Auth not available");
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) throw new Error("No auth token");
  return await auth.verifyIdToken(token);
}

async function requireAuth(req, res, next) {
  try {
    if (USE_FAKE) {
      req.user = { uid: "test-user" }; // always authed in FAKE mode
    } else {
      req.user = await verifyUser(req);
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function ensureAdmin(uid) {
  if (USE_FAKE) return true; // everything is admin in fake mode
  const ADMINS = (process.env.ADMIN_UIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ADMINS.includes(uid);
}

/* ============================================================
   EXPRESS INIT
============================================================ */
const app = express();
app.set("trust proxy", 1);

// Stripe webhooks need RAW body; everything else can be JSON
const RAW_PATHS = new Set(["/stripe-webhook", "/connect-webhook"]);
app.use((req, res, next) => {
  if (RAW_PATHS.has(req.originalUrl)) return next();
  return express.json()(req, res, next);
});

app.use(
  cors({
    origin: FRONTEND,
    credentials: true,
  })
);

// Health
app.get("/", (req, res) => {
  res.json({
    ok: true,
    mode: USE_FAKE ? "FAKE" : "FIREBASE",
    status: "Backend running ✅",
  });
});

/* ============================================================
   QUEUE / PLAYERS
============================================================ */
app.post("/join-queue", requireAuth, async (req, res) => {
  try {
    if (!db) throw new Error("DB not available");
    const uid = req.user.uid;
    await db.collection("queue").doc(uid).set(
      {
        uid,
        joinedAt: Date.now(),
        paid: true, // also set by webhook
      },
      { merge: true }
    );
    res.json({ ok: true, uid });
  } catch (err) {
    console.error("join-queue error:", err);
    res.status(500).json({ error: "join-queue failed" });
  }
});

app.get("/get-players", async (req, res) => {
  try {
    if (!db) throw new Error("DB not available");
    const snap = await db.collection("queue").orderBy("joinedAt").limit(64).get();
    const players = snap.docs.map((d) => d.data());
    res.json(players);
  } catch (err) {
    console.error("get-players error:", err);
    res.status(500).json({ error: "get-players failed" });
  }
});

app.get("/queue-count", async (req, res) => {
  try {
    if (!db) throw new Error("DB not available");
    const snap = await db.collection("queue").get();
    res.json({ count: snap.size });
  } catch (err) {
    console.error("queue-count error:", err);
    res.status(500).json({ error: "Failed to get queue count" });
  }
});

// Optional: seat lookup
app.get("/seat", async (req, res) => {
  const sessionId = req.query.session_id || null;
  res.json({ row: null, sessionId });
});

/* ============================================================
   STRIPE CHECKOUT
============================================================ */
app.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const successUrl = req.body?.success_url;
    const cancelUrl = req.body?.cancel_url;

    if (!successUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing success_url or cancel_url" });
    }

    const lineItems = process.env.STRIPE_PRICE_ID
      ? [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }]
      : [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "RPS64 Entry" },
              unit_amount: Number(process.env.ENTRY_AMOUNT_CENTS || 500), // default $5
            },
            quantity: 1,
          },
        ];

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: `${successUrl}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: { uid },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    res.status(500).json({ error: "Checkout session failed" });
  }
});

/* ============================================================
   STRIPE WEBHOOK (Standard)
============================================================ */
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("❌ Webhook verify failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const uid = session?.metadata?.uid;
        if (uid && db) {
          await db.collection("queue").doc(uid).set(
            {
              uid,
              paid: true,
              joinedAt: Date.now(),
              checkoutSessionId: session.id,
              customer: session.customer || null,
              payment_intent: session.payment_intent || null,
            },
            { merge: true }
          );
        }
        break;
      }
      default:
        break;
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).send("Webhook handler failed");
  }
});

/* ============================================================
   STRIPE CONNECT WEBHOOK (optional)
============================================================ */
app.post("/connect-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET_CONNECT || "";
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("❌ Connect webhook verify failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // react to account.updated, payout.*, etc. if desired
    res.sendStatus(200);
  } catch (err) {
    console.error("Connect webhook handler error:", err);
    res.status(500).send("Connect webhook handler failed");
  }
});

/* ============================================================
   STRIPE CONNECT — Create winner account + payout
============================================================ */
app.post("/create-winner-account", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const user = USE_FAKE ? await auth.getUser(uid) : await auth.getUser(uid);
    const email = user?.email;

    const account = await stripe.accounts.create({
      type: "express",
      email,
      capabilities: { transfers: { requested: true } },
      metadata: { uid },
    });

    if (db) {
      await db.collection("stripeAccounts").doc(uid).set(
        {
          uid,
          accountId: account.id,
          createdAt: Date.now(),
        },
        { merge: true }
      );
    }

    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: process.env.PLATFORM_DOMAIN || process.env.FRONTEND_URL || "https://example.com",
      return_url: process.env.PLATFORM_DOMAIN || process.env.FRONTEND_URL || "https://example.com",
      type: "account_onboarding",
    });

    res.json({ url: link.url, accountId: account.id });
  } catch (err) {
    console.error("create-winner-account error:", err);
    res.status(500).json({ error: "Create account failed" });
  }
});

app.post("/pay-winner", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    if (!ensureAdmin(uid)) return res.status(403).json({ error: "Admin only" });

    const { winnerUid, amount } = req.body || {};
    if (!winnerUid || !amount) {
      return res.status(400).json({ error: "Missing winnerUid or amount" });
    }

    const doc = db ? await db.collection("stripeAccounts").doc(winnerUid).get() : null;
    if (!doc || !doc.exists) return res.status(400).json({ error: "Winner has no Stripe account" });

    const { accountId } = doc.data();
    if (!accountId) return res.status(400).json({ error: "Winner accountId missing" });

    const transfer = await stripe.transfers.create({
      amount: Math.round(Number(amount) * 100),
      currency: "usd",
      destination: accountId,
      description: `RPS64 prize payout to ${winnerUid}`,
    });

    res.json({ ok: true, transferId: transfer.id });
  } catch (err) {
    console.error("pay-winner error:", err);
    res.status(500).json({ error: "Payout failed" });
  }
});

/* ============================================================
   START SERVER
============================================================ */
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`   Mode: ${USE_FAKE ? "FAKE (no Firebase)" : "FIREBASE"}`);
});
