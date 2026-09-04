"use client";

import { useEffect, useMemo, useState } from "react";
import {
  canonicalizeTransportName,
  getTransporte,
  getTransportesDisponibles,
  guardarTransporteElegido,
} from "@/lib/transport";
import {
  getFormaPagoTextForTransport,
  resolveShippingOptions,
} from "@/lib/transport/shipping-helpers";
import { rpcSetMyTransport } from "@/lib/transport/rpc";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import DropdownSelect from "@/components/ui/DropdownSelect";

interface ProfileShippingBlockProps {
  province?: string | null;
  city?: string | null;
  /** Nombre desde customers.transport_id (BD). Tiene prioridad sobre localStorage. */
  assignedTransportName?: string | null;
  /** Se llama cuando el cliente elige otro transporte y se guardó en BD. */
  onTransportChange?: (transporte: string, transportId?: string | null) => void;
}

export default function ProfileShippingBlock({
  province,
  city,
  assignedTransportName,
  onTransportChange,
}: ProfileShippingBlockProps) {
  const provinceTrim = (province || "").trim();
  const cityTrim = (city || "").trim();
  const hasLocation = Boolean(provinceTrim && cityTrim);

  const shipping = useMemo(() => {
    if (!hasLocation) {
      return {
        opciones: [] as string[],
        efectivo: "—",
        soloSedeUnico: false,
      };
    }
    const raw = getTransportesDisponibles(provinceTrim, cityTrim);
    const resolved = resolveShippingOptions(provinceTrim, cityTrim, raw);
    const assigned = canonicalizeTransportName(assignedTransportName || "");
    if (assigned) {
      const opciones = resolved.opciones.includes(assigned)
        ? resolved.opciones
        : [assigned, ...resolved.opciones];
      return { ...resolved, opciones, efectivo: assigned };
    }
    // No leer localStorage acá: en SSR no existe y rompe la hidratación.
    return { ...resolved, efectivo: resolved.opciones[0] ?? "—" };
  }, [assignedTransportName, hasLocation, provinceTrim, cityTrim]);

  const { opciones, efectivo, soloSedeUnico } = shipping;

  const [selected, setSelected] = useState(efectivo);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(efectivo);
  }, [efectivo]);

  useEffect(() => {
    if (!hasLocation || assignedTransportName) return;
    const fromStorage = canonicalizeTransportName(getTransporte(provinceTrim, cityTrim));
    if (fromStorage && fromStorage !== "—" && opciones.includes(fromStorage)) {
      setSelected(fromStorage);
    }
  }, [hasLocation, assignedTransportName, provinceTrim, cityTrim, opciones]);

  const effective = opciones.includes(selected) ? selected : (opciones[0] ?? "—");
  const showSelect = hasLocation && !soloSedeUnico && opciones.length > 0;
  const showCorreo = canonicalizeTransportName(effective) === "Correo Argentino";
  const transportOptions = useMemo(
    () => opciones.map((t) => ({ value: t, label: t })),
    [opciones]
  );

  async function handleChange(value: string) {
    const transporte = canonicalizeTransportName(value);
    const previous = selected;
    setSelected(transporte);
    setSaveError(null);
    if (!provinceTrim || !cityTrim || !transporte) return;

    setSaving(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const result = await rpcSetMyTransport(supabase, transporte);
      guardarTransporteElegido(provinceTrim, cityTrim, transporte);
      onTransportChange?.(
        canonicalizeTransportName(result.transport_name || transporte),
        result.transport_id ?? null
      );
    } catch (err) {
      setSelected(previous);
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message?: string }).message || "")
          : "";
      setSaveError(
        msg.includes("WhatsApp")
          ? msg
          : "No se pudo guardar el transporte. Intentá de nuevo."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888", lineHeight: 1.45 }}>
        Según tu provincia y localidad se asigna el transporte. Si hay más de uno disponible, podés elegirlo.
      </p>

      {!hasLocation ? (
        <p style={{ margin: 0, fontSize: 13, color: "#b45309" }}>
          Completá provincia y localidad en tu perfil para ver las opciones de retiro o envío.
        </p>
      ) : (
        <>
          <label
            id="profile-transport-label"
            style={{ display: "block", fontSize: 12, color: "#888", marginBottom: 6 }}
          >
            Retiro/envío asignado
          </label>

          {showSelect ? (
            <DropdownSelect
              labelledBy="profile-transport-label"
              value={effective}
              options={transportOptions}
              disabled={saving}
              onChange={(value) => {
                if (value === effective || saving) return;
                void handleChange(value);
              }}
            />
          ) : (
            <div className="fyl-dropdown__readonly">
              {opciones.length ? opciones[0] : "—"}
            </div>
          )}

          {saveError ? (
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "#b91c1c" }}>{saveError}</p>
          ) : null}

          {effective !== "—" ? (
            <div style={{
              marginTop: 12, padding: 12, borderRadius: 10,
              background: "#fafafa", border: "1px solid #eee",
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#333", marginBottom: 4 }}>
                Forma de pago
              </div>
              <p style={{ margin: 0, fontSize: 12, color: "#666", lineHeight: 1.45 }}>
                {getFormaPagoTextForTransport(effective)}
              </p>
            </div>
          ) : null}

          {showCorreo ? (
            <div style={{
              marginTop: 12, padding: 12, borderRadius: 10,
              background: "#fafafa", border: "1px solid #eee",
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#333", marginBottom: 4 }}>
                Correo Argentino
              </div>
              <p style={{ margin: 0, fontSize: 12, color: "#666", lineHeight: 1.45 }}>
                Te informaremos el costo total (pedido + envío) para abonarlo por transferencia antes del despacho.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
