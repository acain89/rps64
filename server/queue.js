// queue.js
import { db } from "./firebaseAdmin.js"; // we will create this
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function addPlayerToQueue(uid, email, name) {
  await db.collection("queue").add({
    uid,
    email,
    name,
    stripePaid: true,
    queuedAt: Date.now()
  });
}

export async function popNext64Players() {
  const snap = await db.collection("queue")
    .orderBy("queuedAt", "asc")
    .limit(64)
    .get();

  if (snap.empty || snap.size < 64) return [];

  const players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // remove them from queue
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  return players;
}
