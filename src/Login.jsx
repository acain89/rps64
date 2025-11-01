import React, { useState } from "react";
import { registerUser, loginUser } from "./auth";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("login");
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    try {
      if (mode === "login") {
        const res = await loginUser(email, password);
        onLogin(res.user);
      } else {
        const res = await registerUser(email, password);
        onLogin(res.user);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="login-screen">
      <h2>RPS64 Login</h2
