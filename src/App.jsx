// src/App.jsx — RPS64 (Production: Stripe + Real Queue Only, No Bots)

import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/* === AUTH (Firebase) === */
import { auth } from "./firebase";
import { onAuthStateChanged, getIdToken } from "firebase/auth";

/* === API helper (attaches Firebase ID token automatically) === */
import { api } from "./api";

/* =========================
   CONSTANTS
========================= */
const TOTAL_PLAYERS = 64;
const START_LIVES = 3;
const TURN_SECONDS = 30;
const PRE_TIMER = 30;
const MOVES = ["rock", "paper", "scissors"];
const BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };

// Backend base URL (Render or local). Example: https://rps64.onrender.com

// Editable Terms/Disclaimer HTML (you can modify freely)
const TERMS_HTML = `
  <h2>Terms & Agreements</h2>
  <p><strong>Disclaimer:</strong> This is a skill-based tournament experience with cash prizes. 
  No purchase is required to play. Free entry is available by mailed request as outlined in the official rules.
  Prizes may vary. Players must comply with all applicable laws in their jurisdiction.</p>
  <p>By participating, you agree to the site rules, code of conduct, and payout timelines. 
  Misconduct may result in disqualification without refund.</p>
`;

/* =========================
   HELPERS
========================= */
const resolve = (a, b) => {
  if (!a || !b) return null;
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : 2;
};

function pairStrict(list) {
  const out = [];
  const evenLen = list.length - (list.length % 2);
  for (let i = 0; i < evenLen; i += 2) out.push([list[i], list[i + 1]]);
  return out;
}

function notifyCountdownStart() {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      new Notification("RPS64", {
        body: "Game starts in 30 Seconds! Find your seat!",
      });
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((perm) => {
        if (perm === "granted") {
          new Notification("RPS64", {
            body: "Game starts in 30 Seconds! Find your seat!",
          });
        }
      });
    }
  } catch (_e) {
    // ignore
  }
}

/* =========================
   INLINE AUTH MODAL (email+password)
========================= */
function AuthModal({ onClose, onSuccess }) {
  const [mode, setMode] = useState("login"); // login | register
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    try {
      if (mode === "login") {
        const { signInWithEmailAndPassword } = await import("firebase/auth");
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const { createUserWithEmailAndPassword, updateProfile } = await import("firebase/auth");
        const u = await createUserWithEmailAndPassword(auth, email, password);
        // ✅ Option 3: set username to email prefix
        const prefix = email.split("@")[0];
        try { await updateProfile(u.user, { displayName: prefix }); } catch {}
      }
      onSuccess?.();
      onClose();
    } catch (e) {
      setErr(e?.message || "Login failed");
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
          {err && <p className="auth-error">{err}</p>}
          <button type="submit">{mode === "login" ? "Sign In" : "Register"}</button>
        </form>
        <p
          className="auth-toggle"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Create account" : "Already have an account?"}
        </p>
        <button className="auth-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/* =========================
   LOGO
========================= */
function LogoTri() {
  return (
    <div className="logo-tri" aria-label="RPS64 Logo">
      <div className="blob orange" />
      <div className="blob blue" />
      <div className="blob green" />
    </div>
  );
}

/* =========================
   MAIN APP (Production)
========================= */
export default function App() {
  // Phase: 'pregame' | 'round' | 'complete'
  const [phase, setPhase] = useState("pregame");
  const [round, setRound] = useState(1); // 1..6

  // We mirror the backend queue count. We do NOT create bots.
  const [participants, setParticipants] = useState([]); // array of {id,name}
  const [queueCount, setQueueCount] = useState(0);

  const [matches, setMatches] = useState([]);
  const [roundBanner, setRoundBanner] = useState("Round 1");
  const [tieMatch, setTieMatch] = useState(null);
  const [preTime, setPreTime] = useState(PRE_TIMER);
  const [champion, setChampion] = useState(null);

  const [termsOpen, setTermsOpen] = useState(false);
  const [rowToast, setRowToast] = useState(null);
  const toastTimer = useRef(null);

  // Auth
  const [user, setUser] = useState(null);
  const [showAuth, setShowAuth] = useState(false);

  // ✅ Mobile “My Match” system
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const myMatchRef = useRef(null);

  // ============================
  // ✅ STRIPE CONNECT ADDITIONS (client-side triggers; no public UI)
  // ============================
  async function ensureStripeConnectAccount() {
    if (!user) return;
    try {
      await api(`/create-winner-account`, { method: "POST" });
    } catch (e) {
      // Non-blocking; onboarding link handled by backend if needed
      console.warn("Connect setup skipped:", e?.message || e);
    }
  }

  async function triggerWinnerPayout(uid, prizeUSD = 600) {
    try {
      await api(`/pay-winner`, {
        method: "POST",
        body: JSON.stringify({ winnerUid: uid, amount: prizeUSD }),
      });
    } catch (e) {
      console.error("Payout trigger failed:", e?.message || e);
    }
  }

  // Ensure winner has a Connect account as we enter the finals (Round 6)
  useEffect(() => {
    if (phase === "round" && round === 6 && user) {
      ensureStripeConnectAccount();
    }
  }, [phase, round, user]);

  // After champion decided, fire payout (if this logged-in user is the winner)
  useEffect(() => {
    if (phase === "complete" && champion && user) {
      // NOTE: This relies on champion.name matching the authenticated user's displayName
      if (champion?.name && user?.displayName && champion.name === user.displayName) {
        triggerWinnerPayout(user.uid, 600);
      }
    }
  }, [phase, champion, user]);
  // ============================
  // ✅ END STRIPE CONNECT ADDITIONS
  // ============================

  // ===== Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      // ✅ Ensure displayName exists (email prefix) for matching
      if (u && !u.displayName && u.email) {
        try {
          const { updateProfile } = await import("firebase/auth");
          await updateProfile(u, { displayName: u.email.split("@")[0] });
        } catch {}
      }
      setUser(u);
    });
    return () => unsub();
  }, []);

  // ===== Handle Stripe success redirect (?session_id & ?joined=true)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");

    // If returned from Stripe success, add player to server-side queue
    if (params.get("joined") === "true") {
      (async () => {
        try {
          if (!user) return; // wait for user
          const res = await api(`/join-queue`, { method: "POST" });
          if (res?.ok || res?.success) {
            alert("✅ You're in! Waiting for 64 players…");
          } else {
            alert("Error joining queue. Please try again.");
          }
        } catch (e) {
          console.error("Queue join failed:", e);
          alert("Error joining queue");
        }
      })();
    }

    // If we had a session_id (seat lookup), try to fetch seat row
    if (sessionId) {
      (async () => {
        try {
          const data = await api(`/seat?session_id=${encodeURIComponent(sessionId)}`);
          if (data?.row) showRowToast(data.row);
        } catch (_e) {
          // ignore
        }
      })();
    }

    // Clean URL
    if (params.size > 0) {
      const url = new URL(window.location.href);
      ["session_id", "joined", "cancel"].forEach((k) =>
        url.searchParams.delete(k)
      );
      window.history.replaceState({}, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ===== Poll backend queue count every 5s while pregame
  useEffect(() => {
    let timer;
    async function poll() {
      try {
        const data = await api(`/queue-count`);
        const count = Number(data?.count || 0);
        setQueueCount(count);

        // Build a placeholder participants list up to count (max 64) for the UI
        const useCount = Math.min(count, TOTAL_PLAYERS);
        const list = Array.from({ length: useCount }, (_, i) => ({
          id: i + 1,
          name: `Player ${i + 1}`,
        }));
        setParticipants(list);

        // If we just reached 64 in pregame and countdown hasn't started, start it
        if (
          phase === "pregame" &&
          round === 1 &&
          count >= TOTAL_PLAYERS &&
          preTime === PRE_TIMER
        ) {
          notifyCountdownStart();
          // start 30s countdown
          let t = PRE_TIMER;
          setPreTime(t);
          const interval = setInterval(() => {
            t -= 1;
            if (t <= 0) {
              clearInterval(interval);
              setPreTime(0);
              // lock 64 entrants and start round
              const first64 = Array.from({ length: TOTAL_PLAYERS }, (_, i) => ({
                id: i + 1,
                name: `Player ${i + 1}`,
              }));
              setParticipants(first64);
              setPhase("round");
            } else {
              setPreTime(t);
            }
          }, 1000);
        }
      } catch (_e) {
        // ignore polling errors
      } finally {
        timer = setTimeout(poll, 5000);
      }
    }

    if (phase === "pregame") {
      poll();
      return () => clearTimeout(timer);
    }
  }, [phase, round, preTime]);

  // ===== Build matches at start of each round (fixed until round ends)
  useEffect(() => {
    if (phase !== "round") return;

    const entrants = participants.slice(0, TOTAL_PLAYERS);
    const ms = pairStrict(entrants).map((pair, i) => ({
      id: `r${round}m${i + 1}`,
      a: { ...pair[0], lives: START_LIVES },
      b: { ...pair[1], lives: START_LIVES },
      aMove: null,
      bMove: null,
      aTime: TURN_SECONDS,
      bTime: TURN_SECONDS,
      finished: false,
      winner: null,
      lifePopupA: false,
      lifePopupB: false,
      pending: false,
      pendingAt: 0,
      reveal: false,
    }));
    setMatches(ms);

    setRoundBanner(`Round ${round}`);
    const t = setTimeout(() => setRoundBanner(""), 5000);
    // ✅ auto-scroll to my match on mobile after render attaches refs
    setTimeout(() => {
      if (myMatchRef.current && typeof window !== "undefined" && window.innerWidth < 900) {
        myMatchRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 800);

    return () => clearTimeout(t);
  }, [phase, round, participants]);

  // ===== Timer + Resolution Engine
  useEffect(() => {
    if (phase !== "round") return;

    const tick = setInterval(() => {
      const now = Date.now();
      setMatches((prev) =>
        prev.map((m) => {
          if (m.finished) return m;

          let { aTime, bTime, aMove, bMove, pending, pendingAt } = m;

          // countdown if not yet chosen
          if (!aMove) aTime = Math.max(0, aTime - 1);
          if (!bMove) bTime = Math.max(0, bTime - 1);

          const aTimedOut = aTime === 0 && !m.aMove;
          const bTimedOut = bTime === 0 && !m.bMove;

          // Handle timeouts immediately (no reveal for timeout)
          if (aTimedOut || bTimedOut) {
            let outcome;
            if (aTimedOut && bTimedOut) outcome = "bothTimeout";
            else outcome = aTimedOut ? "aTimeout" : "bTimeout";
            return applyOutcome(
              { ...m, aTime, bTime, aMove, bMove, pending: false, reveal: false },
              outcome,
              aTime,
              bTime
            );
          }

          // If both have moves and not staged yet, start reveal window
          if (aMove && bMove && !pending) {
            return {
              ...m,
              aTime,
              bTime,
              aMove,
              bMove,
              pending: true,
              pendingAt: now,
              reveal: true, // drive the shake & un-blur
            };
          }

          // If staged and reveal window elapsed, resolve RPS outcome now
          if (pending && now - pendingAt >= 400) {
            const r = resolve(aMove, bMove);
            const outcome = r === 0 ? "tie" : r === 1 ? "aWins" : "bWins";
            return applyOutcome(
              { ...m, aTime, bTime, aMove, bMove, pending: false, reveal: false },
              outcome,
              aTime,
              bTime
            );
          }

          return { ...m, aTime, bTime, aMove, bMove, pending, pendingAt, reveal: m.reveal };
        })
      );
    }, 1000);

    return () => clearInterval(tick);
  }, [phase]);

  function applyOutcome(m, outcome, aTime, bTime) {
    let a = { ...m.a };
    let b = { ...m.b };
    let finished = m.finished;
    let winner = m.winner;
    let lifePopupA = false;
    let lifePopupB = false;

    switch (outcome) {
      case "aWins":
        b.lives = Math.max(0, b.lives - 1);
        lifePopupB = true;
        break;
      case "bWins":
        a.lives = Math.max(0, a.lives - 1);
        lifePopupA = true;
        break;
      case "aTimeout":
        a.lives = Math.max(0, a.lives - 1);
        lifePopupA = true;
        break;
      case "bTimeout":
        b.lives = Math.max(0, b.lives - 1);
        lifePopupB = true;
        break;
      case "bothTimeout":
        a.lives = Math.max(0, a.lives - 1);
        b.lives = Math.max(0, b.lives - 1);
        lifePopupA = true;
        lifePopupB = true;
        break;
      case "tie":
        setTieMatch(m.id);
        setTimeout(() => setTieMatch(null), 1000);
        break;
      default:
        break;
    }

    // End match as soon as someone (or both) hit 0 lives
    if (a.lives === 0 && b.lives === 0) {
      finished = true;
      winner = Math.random() < 0.5 ? "a" : "b"; // keep bracket size correct
    } else if (a.lives === 0) {
      finished = true;
      winner = "b";
    } else if (b.lives === 0) {
      finished = true;
      winner = "a";
    }

    const updated = {
      ...m,
      a,
      b,
      aMove: null,
      bMove: null,
      aTime: finished ? aTime : TURN_SECONDS,
      bTime: finished ? bTime : TURN_SECONDS,
      finished,
      winner,
      lifePopupA,
      lifePopupB,
      pending: false,
      reveal: false,
    };

    // hide −1 after 2s
    if (lifePopupA || lifePopupB) {
      setTimeout(() => {
        setMatches((prev) =>
          prev.map((mm) =>
            mm.id === m.id ? { ...mm, lifePopupA: false, lifePopupB: false } : mm
          )
        );
      }, 2000);
    }

    return updated;
  }

  // ===== Round advance when all matches finished
  useEffect(() => {
    if (phase !== "round" || matches.length === 0) return;

    const allFinished = matches.every((m) => m.finished);
    if (!allFinished) return;

    const winners = matches.map((m) => (m.winner === "a" ? m.a : m.b)).filter(Boolean);
    const expectedNext = participants.length / 2;
    const nextEntrants = winners.slice(0, expectedNext);

    if (round >= 6) {
      setChampion(nextEntrants[0] || winners[0] || null);
      setPhase("complete");
      return;
    }

    setParticipants(nextEntrants);
    setRound((r) => r + 1);
  }, [phase, matches, participants.length, round]);

  // ===== After winner: show banner then reset to pregame (no bots, wait for queue)
  useEffect(() => {
    if (phase !== "complete") return;
    const t = setTimeout(() => {
      setParticipants([]); // wait for real queue again
      setRound(1);
      setPreTime(PRE_TIMER);
      setChampion(null);
      setPhase("pregame");
    }, 30000);
    return () => clearTimeout(t);
  }, [phase]);

  // ===== Choosing a move
  const choose = (matchId, side, move) => {
    if (phase !== "round") return;
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId || m.finished) return m;
        if (side === "a" && !m.aMove) return { ...m, aMove: move };
        if (side === "b" && !m.bMove) return { ...m, bMove: move };
        return m;
      })
    );
  };

  // ===== Live player count (for header)
  const aliveCount = useMemo(() => {
    if (phase !== "round" || matches.length === 0) return participants.length;
    const finished = matches.filter((m) => m.finished).length;
    const allFinished = finished === matches.length;
    return allFinished ? Math.max(1, participants.length / 2) : participants.length - finished;
  }, [phase, matches, participants.length]);

  // ===== Stripe Checkout flow (production)
  async function handlePlayNow() {
    // Require login first
    if (!user) {
      setShowAuth(true);
      return;
    }

    try {
      const data = await api(`/create-checkout-session`, {
        method: "POST",
        body: JSON.stringify({
          success_url: `${window.location.origin}/?joined=true`,
          cancel_url: `${window.location.origin}/?cancel=true`,
        }),
      });

      if (data?.url) {
        window.location.href = data.url; // Stripe hosted checkout
        return;
      }

      alert("Could not start checkout. Try again.");
    } catch (e) {
      console.error(e);
      alert("Payment failed. Please try again.");
    }
  }

  function showRowToast(rowNum) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setRowToast(`You're on Row #${rowNum}`);
    toastTimer.current = setTimeout(() => setRowToast(null), 3000);
  }

  // ===== Determine if there is a match for this user (by displayName)
  const username = user?.displayName || "";
  const hasMyMatch = useMemo(
    () =>
      !!username &&
      matches.some((m) => m?.a?.name === username || m?.b?.name === username),
    [matches, username]
  );

  return (
    <div className="app-root">
      {/* Header: logo left, big centered prize, stats right */}
      <header className="rps-header">
        <div className="header-left">
          <LogoTri />
        </div>

        <div className="header-center">
          <div className="prize-box">Prize: $600</div>
        </div>

        <div className="header-right">
          <div className="top-box">Players: {aliveCount}</div>
          <div className="top-box">
            {phase === "pregame" ? "Waiting…" : `Round: ${round}`}
          </div>
        </div>
      </header>

      {/* Play Now & subtext */}
      <div className="play-wrapper">
        <button className="play-btn" onClick={handlePlayNow}>Play Now</button>
        <div className="subtext">
          {phase === "pregame"
            ? `Waiting for players (${queueCount}/64). Game starts when 64 players join.`
            : "Good luck!"}
        </div>

        {/* ✅ My Match / Full Bracket toggle (shows only during rounds and if we know your match) */}
        {phase === "round" && hasMyMatch && (
          <button
            className="play-btn"
            onClick={() => setShowOnlyMine((v) => !v)}
            style={{ marginTop: 10 }}
          >
            {showOnlyMine ? "Show Full Bracket" : "Show My Match"}
          </button>
        )}
      </div>

      {/* Pregame 30s countdown (only when we actually hit 64) */}
      {phase === "pregame" && preTime > 0 && queueCount >= 64 && (
        <div className="pregame-banner">
          <div className="pregame-text">Tournament starts in: {preTime}s</div>
        </div>
      )}

      {/* Round banner (5s each round) */}
      {!!roundBanner && phase === "round" && (
        <div className="round-banner">{roundBanner}</div>
      )}

      {/* Winner overlay (visible 30s, then auto-reset to 64) */}
      {phase === "complete" && champion && (
        <div className="round-banner">
          Congratulations {champion.name}! You won $600!
        </div>
      )}

      {/* Matches grid */}
      <main className="grid-wrap">
        {matches.map((m, idx) => {
          // ✅ mark my match (by displayName)
          const isMine =
            !!username && (m?.a?.name === username || m?.b?.name === username);

          return (
            <div
              key={m.id}
              ref={isMine ? myMatchRef : null}
              className={`match ${m.finished ? "match-finished" : ""}`}
              // ✅ hide non-mine when toggled
              style={showOnlyMine && !isMine ? { display: "none" } : undefined}
            >
              <div className="match-number">{idx + 1}</div>

              <PlayerCard
                who="a"
                match={m}
                time={m.aTime}
                // keep your original prop contract: choose takes ("rock"|"paper"|"scissors")
                choose={(mv) => choose(m.id, "a", mv)}
                lifePopup={m.lifePopupA}
              />

              <div className="vs-wrap">
                <div className="vs">VS</div>
                {tieMatch === m.id && <div className="tie-overlay">TIE</div>}
              </div>

              <PlayerCard
                who="b"
                match={m}
                time={m.bTime}
                choose={(mv) => choose(m.id, "b", mv)}
                lifePopup={m.lifePopupB}
              />
            </div>
          );
        })}
      </main>

      {/* Bottom-right Terms button */}
      <button className="terms-fab" onClick={() => setTermsOpen(true)}>
        Terms & Agreements
      </button>

      {/* Terms Modal */}
      {termsOpen && (
        <div className="terms-modal">
          <div className="terms-card">
            <div
              className="terms-content"
              dangerouslySetInnerHTML={{ __html: TERMS_HTML }}
            />
            <button className="terms-close" onClick={() => setTermsOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* Row toast */}
      {rowToast && <div className="row-toast">{rowToast}</div>}

      {/* Auth modal */}
      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onSuccess={() => {}}
        />
      )}
    </div>
  );
}

/* =========================
   PLAYER CARD
========================= */
function PlayerCard({ match, who, time, choose, lifePopup }) {
  const p = match[who];
  if (!p) return <div className="player-card empty">Waiting…</div>;

  const isLoser = match.finished && match.winner && match.winner !== who;

  // Moves
  const myMove = who === "a" ? match.aMove : match.bMove;

  // Enlarge 1.5× while waiting for reveal; shake on reveal (both players)
  const waitingForReveal = !!myMove && !match.reveal;
  const revealingNow = !!match.reveal;

  // Obscure the chosen emoji until reveal so opponent cannot read it
  const isObscured = !!myMove && !match.reveal;

  const btnStyle = (move) => {
    const isChosen = myMove === move;
    const scale =
      isChosen && waitingForReveal ? "scale(1.5)" : isChosen && revealingNow ? "scale(1.25)" : "scale(1)";
    return {
      transform: scale,
      transition: "transform 180ms ease",
      animation: isChosen && revealingNow ? "rps-shake 380ms ease" : "none",
    };
  };

  return (
    <div className={`player-card ${isLoser ? "loser-fade" : ""}`}>
      {isLoser && <div className="eliminated-stamp">ELIMINATED</div>}

      <div className="pc-head">
        <div className="pc-name">{p.name}</div>
        <div className="pc-timer" data-low={time <= 5}>{time}s</div>
      </div>

      <div className="pc-lives">
        {Array.from({ length: START_LIVES }, (_, i) => (
          <span key={i} className={i < START_LIVES - p.lives ? "life lost" : "life"} />
        ))}
        {lifePopup && <span className="life-popup">−1</span>}
      </div>

      <div className="pc-controls">
        {/* keep original behavior: choose is provided by parent with match id + side bound */}
        <button className="rps-btn" style={btnStyle("rock")} onClick={() => choose("rock")}>
          <span className={`btn-emoji ${isObscured && myMove === "rock" ? "obscure" : ""}`}>✊</span>
        </button>
        <button className="rps-btn" style={btnStyle("paper")} onClick={() => choose("paper")}>
          <span className={`btn-emoji ${isObscured && myMove === "paper" ? "obscure" : ""}`}>✋</span>
        </button>
        <button className="rps-btn" style={btnStyle("scissors")} onClick={() => choose("scissors")}>
          <span className={`btn-emoji ${isObscured && myMove === "scissors" ? "obscure" : ""}`}>✌️</span>
        </button>
      </div>

      <style>{`
        @keyframes rps-shake {
          0% { transform: scale(1.25) rotate(0deg); }
          25% { transform: scale(1.25) rotate(-6deg); }
          50% { transform: scale(1.25) rotate(6deg); }
          75% { transform: scale(1.25) rotate(-4deg); }
          100% { transform: scale(1.25) rotate(0deg); }
        }
      `}</style>
    </div>
  );
}
