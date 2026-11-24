// admin/tv.js — playlist YouTube de la TV del local (requiere admin)
import { requireAuth } from "./admin-auth.js?v=m260607";
import { supabase } from "../scripts/supabase-client.js?v=m260607";

const SETTINGS_ID = 1;

function setStatus(msg, kind) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "status" + (kind ? ` ${kind}` : "");
}

function setMeta(html) {
  const el = document.getElementById("meta");
  if (el) el.innerHTML = html;
}

function isRadioMixId(id) {
  return /^RD/i.test(String(id || ""));
}

function parsePlaylistFromInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "Pegá un link o un ID de playlist." };

  if (/^(PL|OL|UU|LL|FL|RD)[A-Za-z0-9_-]+$/i.test(text)) {
    return { ok: true, id: text, url: text, radio: isRadioMixId(text) };
  }

  const listMatch = text.match(/[?&]list=([A-Za-z0-9_-]+)/i);
  if (listMatch && listMatch[1]) {
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
      "No encontré una playlist. Usá un link con list=… (playlist creada por vos, idealmente PL…).",
  };
}

function formatWhen(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
    });
  } catch {
    return String(iso);
  }
}

async function loadSettings() {
  const { data, error } = await supabase
    .from("tv_local_settings")
    .select("youtube_playlist_id, youtube_playlist_url, updated_at, updated_by")
    .eq("id", SETTINGS_ID)
    .maybeSingle();

  if (error) {
    setStatus(
      "No se pudo leer la config. ¿Está aplicada la migración 383 en Supabase? " +
        (error.message || ""),
      "err"
    );
    setMeta("Error de lectura.");
    return null;
  }

  const input = document.getElementById("playlist-url");
  if (input) {
    input.value = data?.youtube_playlist_url || data?.youtube_playlist_id || "";
  }

  if (!data?.youtube_playlist_id) {
    setMeta("Sin playlist configurada. La TV no reproducirá música hasta que guardes una.");
    setStatus("");
  } else {
    const warn = isRadioMixId(data.youtube_playlist_id)
      ? " <span style=\"color:#9a3412\">(mix/radio RD…: puede fallar en TV)</span>"
      : "";
    setMeta(
      `Activa: <code>${data.youtube_playlist_id}</code>${warn}<br>` +
        `Actualizada: ${formatWhen(data.updated_at)}`
    );
    setStatus("Configuración cargada.", "ok");
  }
  return data;
}

async function savePlaylist(clear) {
  const saveBtn = document.getElementById("save-btn");
  const clearBtn = document.getElementById("clear-btn");
  if (saveBtn) saveBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;

  try {
    let playlistId = null;
    let playlistUrl = null;

    if (!clear) {
      const raw = document.getElementById("playlist-url")?.value || "";
      const parsed = parsePlaylistFromInput(raw);
      if (!parsed.ok) {
        setStatus(parsed.error, "err");
        return;
      }
      playlistId = parsed.id;
      playlistUrl = parsed.url;
      if (parsed.radio) {
        setStatus(
          "Ojo: ese ID es un mix/radio (RD…). Puede no sonar en Smart TV. Mejor una playlist PL…",
          "warn"
        );
      }
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const payload = {
      id: SETTINGS_ID,
      youtube_playlist_id: playlistId,
      youtube_playlist_url: playlistUrl,
      updated_at: new Date().toISOString(),
      updated_by: user?.id || null,
    };

    const { error } = await supabase
      .from("tv_local_settings")
      .upsert(payload, { onConflict: "id" });

    if (error) {
      setStatus("Error al guardar: " + (error.message || error), "err");
      return;
    }

    setStatus(
      clear ? "Música quitada. La TV dejará de tener playlist." : "Playlist guardada. La TV la toma en el próximo refresh (hasta 5 min).",
      "ok"
    );
    await loadSettings();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
  }
}

async function init() {
  const user = await requireAuth();
  if (!user) return;

  document.getElementById("save-btn")?.addEventListener("click", () => savePlaylist(false));
  document.getElementById("clear-btn")?.addEventListener("click", () => {
    if (confirm("¿Quitar la playlist de la TV?")) savePlaylist(true);
  });
  document.getElementById("playlist-url")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      savePlaylist(false);
    }
  });

  await loadSettings();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    init().catch((err) => console.error("[admin/tv]", err));
  });
} else {
  init().catch((err) => console.error("[admin/tv]", err));
}
