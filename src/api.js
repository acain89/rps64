// src/api.js
import { auth } from "./firebase";

export async function api(path, options = {}) {
  const token = auth.currentUser
    ? await auth.currentUser.getIdToken()
    : null;

  options.headers = {
    ...(options.headers || {}),
    "Content-Type": "application/json",
    Authorization: token ? `Bearer ${token}` : ""
  };

  const base =
    import.meta.env.VITE_BACKEND_URL ||
    import.meta.env.VITE_SERVER_URL ||
    "http://localhost:8080"; // fallback for local dev

  const res = await fetch(base + path, options);

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
