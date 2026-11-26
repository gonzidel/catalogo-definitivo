"use client";

import { useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Props = {
  initialPlaylistId: string | null;
  initialPlaylistUrl: string | null;
  initialUpdatedAt: string | null;
};

function isRadioMixId(id: string) {
  // RD… = radio/mix; PLRD… = mixes de YouTube Music (suelen fallar en IFrame API / Smart TV)
  return /^(RD|PLRD)/i.test(id);
}

function parsePlaylistFromInput(raw: string): {
  ok: true;
  id: string;
  url: string;
  radio: boolean;
} | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: "Pegá un link o un ID de playlist." };

  if (/^(PL|OL|UU|LL|FL|RD)[A-Za-z0-9_-]+$/i.test(text)) {
    return { ok: true, id: text, url: text, radio: isRadioMixId(text) };
  }

  const listMatch = text.match(/[?&]list=([A-Za-z0-9_-]+)/i);
  if (listMatch?.[1]) {
    return {
      ok: true,
      id: listMatch[1],
      url: text,
      radio: isRadioMixId(listMatch[1]),
    };
  }

  return {
    ok: false,
    error:
      "No encontré una playlist. Usá un link con list=… (playlist propia, idealmente PL…).",
  };
}

export default function TvSettingsForm({
  initialPlaylistId,
  initialPlaylistUrl,
  initialUpdatedAt,
}: Props) {
  const [url, setUrl] = useState(
    initialPlaylistUrl || initialPlaylistId || ""
  );
  const [playlistId, setPlaylistId] = useState(initialPlaylistId);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [status, setStatus] = useState<{
    kind: "" | "ok" | "warn" | "err";
    msg: string;
  }>({ kind: "", msg: "" });
  const [busy, setBusy] = useState(false);

  const meta = useMemo(() => {
    if (!playlistId) {
      return "Sin playlist. La TV no tendrá música hasta que guardes una.";
    }
    const when = updatedAt
      ? new Date(updatedAt).toLocaleString("es-AR", {
          timeZone: "America/Argentina/Buenos_Aires",
        })
      : "—";
    const warn = isRadioMixId(playlistId)
      ? " (mix/radio RD…: puede fallar en TV)"
      : "";
    return `Activa: ${playlistId}${warn} · Actualizada: ${when}`;
  }, [playlistId, updatedAt]);

  async function save(clear: boolean) {
    setBusy(true);
    setStatus({ kind: "", msg: "" });
    try {
      let nextId: string | null = null;
      let nextUrl: string | null = null;
      let radio = false;

      if (!clear) {
        const parsed = parsePlaylistFromInput(url);
        if (!parsed.ok) {
          setStatus({ kind: "err", msg: parsed.error });
          return;
        }
        nextId = parsed.id;
        nextUrl = parsed.url;
        radio = parsed.radio;
      }

      const supabase = getSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const payload = {
        id: 1,
        youtube_playlist_id: nextId,
        youtube_playlist_url: nextUrl,
        updated_at: new Date().toISOString(),
        updated_by: user?.id ?? null,
      };

      const { error } = await supabase
        .from("tv_local_settings")
        .upsert(payload, { onConflict: "id" });

      if (error) {
        setStatus({
          kind: "err",
          msg: "Error al guardar: " + (error.message || String(error)),
        });
        return;
      }

      setPlaylistId(nextId);
      setUpdatedAt(payload.updated_at);
      if (clear) setUrl("");
      else if (nextUrl) setUrl(nextUrl);

      if (clear) {
        setStatus({
          kind: "ok",
          msg: "Música quitada. La TV deja de tener playlist en el próximo refresh.",
        });
      } else if (radio) {
        setStatus({
          kind: "warn",
          msg: "Guardada, pero es un mix/radio (RD…). Puede no sonar en Smart TV. Mejor una playlist PL…",
        });
      } else {
        setStatus({
          kind: "ok",
          msg: "Playlist guardada. La TV la toma en hasta ~5 min (o recargá la TV).",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>
        Link de la playlist
      </label>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://www.youtube.com/playlist?list=PL…"
        disabled={busy}
        style={{
          width: "100%",
          padding: "12px 14px",
          borderRadius: 8,
          border: "1px solid #ddd",
          fontSize: 15,
          boxSizing: "border-box",
          marginBottom: 14,
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save(false);
          }
        }}
      />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save(false)}
          style={{
            padding: "10px 18px",
            borderRadius: 8,
            border: "none",
            background: "#CD844D",
            color: "#fff",
            fontWeight: 700,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Guardar playlist
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (confirm("¿Quitar la playlist de la TV?")) void save(true);
          }}
          style={{
            padding: "10px 18px",
            borderRadius: 8,
            border: "1px solid #ddd",
            background: "#f5f5f5",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Quitar música
        </button>
        <a
          href="/tv-fyl-7k3q/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: "10px 18px",
            borderRadius: 8,
            border: "1px solid #ddd",
            background: "#fff",
            textDecoration: "none",
            color: "#333",
          }}
        >
          Abrir TV
        </a>
      </div>
      <p
        style={{
          marginTop: 14,
          color:
            status.kind === "err"
              ? "#b91c1c"
              : status.kind === "warn"
                ? "#9a3412"
                : status.kind === "ok"
                  ? "#166534"
                  : "#555",
          minHeight: "1.3em",
        }}
      >
        {status.msg}
      </p>
      <p style={{ marginTop: 8, color: "#777", fontSize: 13 }}>{meta}</p>
    </div>
  );
}
