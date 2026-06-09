"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginClient() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [magicSent, setMagicSent] = useState(false);
  const [loading, setLoading] = useState<"google" | "magic" | null>(null);
  const [error, setError] = useState("");

  const supabase = getSupabaseBrowserClient();

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const callbackUrl = `${origin}/nj/auth/callback?next=${encodeURIComponent(next)}`;

  async function loginWithGoogle() {
    setError("");
    setLoading("google");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callbackUrl,
        queryParams: { prompt: "select_account", access_type: "offline" },
      },
    });
    if (error) {
      setError(error.message);
      setLoading(null);
    }
    // On success, browser redirects to Google — no need to setLoading(null)
  }

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError("");
    setLoading("magic");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl },
    });
    setLoading(null);
    if (error) {
      setError(error.message);
    } else {
      setMagicSent(true);
    }
  }

  return (
    <div style={{
      minHeight: "100svh",
      background: "#E5E1DC",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px 16px",
    }}>
      <div style={{
        width: "100%",
        maxWidth: 400,
        background: "#fff",
        borderRadius: 20,
        padding: "36px 28px 32px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
        textAlign: "center",
      }}>
        {/* Logo */}
        <div style={{ marginBottom: 24 }}>
          <img src="/nj/logo.png" alt="FYL" style={{ height: 48, objectFit: "contain" }} />
        </div>

        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#222", marginBottom: 6 }}>
          Acceso clientes
        </h1>
        <p style={{ fontSize: 14, color: "#888", marginBottom: 28, margin: "0 0 28px" }}>
          Ingresá para ver tus pedidos y acceder al catálogo mayorista.
        </p>

        {/* Google button */}
        <button
          onClick={loginWithGoogle}
          disabled={loading !== null}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "13px 16px",
            borderRadius: 12,
            border: "1.5px solid #ddd",
            background: loading === "google" ? "#f5f5f5" : "#fff",
            cursor: loading !== null ? "not-allowed" : "pointer",
            fontSize: 15,
            fontWeight: 600,
            color: "#333",
            transition: "all 0.15s",
            marginBottom: 20,
          }}
        >
          {loading === "google" ? (
            "Redirigiendo..."
          ) : (
            <>
              <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                <path fill="none" d="M0 0h48v48H0z"/>
              </svg>
              Continuar con Google
            </>
          )}
        </button>

        {/* Divider */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12, marginBottom: 20,
        }}>
          <div style={{ flex: 1, height: 1, background: "#eee" }} />
          <span style={{ fontSize: 12, color: "#aaa" }}>o con email</span>
          <div style={{ flex: 1, height: 1, background: "#eee" }} />
        </div>

        {/* Magic link */}
        {magicSent ? (
          <div style={{
            padding: "16px", borderRadius: 12, background: "#f0fdf4",
            border: "1px solid #86efac", color: "#166534", fontSize: 14,
          }}>
            ✅ Te enviamos un link a <strong>{email}</strong>. Revisá tu bandeja de entrada.
          </div>
        ) : (
          <form onSubmit={sendMagicLink} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              required
              disabled={loading !== null}
              style={{
                width: "100%",
                padding: "13px 14px",
                borderRadius: 12,
                border: "1.5px solid #ddd",
                fontSize: 15,
                outline: "none",
                boxSizing: "border-box",
                background: loading !== null ? "#f9f9f9" : "#fff",
              }}
            />
            <button
              type="submit"
              disabled={loading !== null || !email.trim()}
              style={{
                padding: "13px 16px",
                borderRadius: 12,
                border: "none",
                background: loading === "magic" ? "#e8a96b" : "#CD844D",
                color: "#fff",
                fontSize: 15,
                fontWeight: 600,
                cursor: loading !== null ? "not-allowed" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {loading === "magic" ? "Enviando..." : "Enviar link de acceso"}
            </button>
          </form>
        )}

        {/* Error */}
        {error && (
          <div style={{
            marginTop: 16, padding: "12px 14px", borderRadius: 10,
            background: "#fef2f2", border: "1px solid #fca5a5",
            color: "#991b1b", fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {/* Back to catalog */}
        <div style={{ marginTop: 24 }}>
          <a href="/" style={{ fontSize: 13, color: "#aaa", textDecoration: "none" }}>
            ← Volver al catálogo
          </a>
        </div>
      </div>
    </div>
  );
}
