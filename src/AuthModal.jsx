import React, { useState } from "react";
import { auth } from "./firebase";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";

export default function AuthModal({ onClose, onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("login"); // login | register
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
      onSuccess();
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="auth-modal">
      <div className="auth-box">
        <h2>{mode === "login" ? "Sign In" : "Create Account"}</h2>

        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <input
            type="password"
            placeholder="Password (6+ chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          {error && <p className="auth-error">{error}</p>}

          <button type="submit">
            {mode === "login" ? "Sign In" : "Register"}
          </button>
        </form>

        <p onClick={() => setMode(mode === "login" ? "register" : "login")}
           className="auth-toggle">
          {mode === "login" ? "Create account" : "Already have an account?"}
        </p>

        <button className="auth-close" onClick={onClose}>X</button>
      </div>
    </div>
  );
}
