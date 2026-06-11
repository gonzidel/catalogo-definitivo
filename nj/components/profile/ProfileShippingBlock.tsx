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

interface ProfileShippingBlockProps {
  province?: string | null;
  city?: string | null;
}

export default function ProfileShippingBlock({ province, city }: ProfileShippingBlockProps) {
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
    let efectivo = canonicalizeTransportName(getTransporte(provinceTrim, cityTrim));
    if (resolved.opciones.includes(efectivo)) {
      return { ...resolved, efectivo };
    }
    return { ...resolved, efectivo: resolved.opciones[0] ?? "—" };
  }, [hasLocation, provinceTrim, cityTrim]);

  const { opciones, efectivo, soloSedeUnico } = shipping;

  const [selected, setSelected] = useState(efectivo);

  useEffect(() => {
    setSelected(efectivo);
  }, [efectivo]);

  const effective = opciones.includes(selected) ? selected : (opciones[0] ?? "—");
  const showSelect = hasLocation && !soloSedeUnico && opciones.length > 0;
  const showCorreo = canonicalizeTransportName(effective) === "Correo Argentino";

  function handleChange(value: string) {
    const transporte = canonicalizeTransportName(value);
    setSelected(transporte);
    if (provinceTrim && cityTrim && transporte) {
      guardarTransporteElegido(provinceTrim, cityTrim, transporte);
    }
  }

  return (
    <div style={{
      marginTop: 20, paddingTop: 16, borderTop: "1px solid #eee",
    }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#222" }}>
        Método de envío
      </h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888", lineHeight: 1.45 }}>
        Según tu provincia y localidad se asigna el transporte. Si hay más de uno disponible, podés elegirlo.
      </p>

      {!hasLocation ? (
        <p style={{ margin: 0, fontSize: 13, color: "#b45309" }}>
          Completá provincia y localidad en tu perfil para ver las opciones de envío.
        </p>
      ) : (
        <>
          <label style={{ display: "block", fontSize: 12, color: "#888", marginBottom: 6 }}>
            Transporte asignado
          </label>

          {showSelect ? (
            <select
              value={effective}
              onChange={(e) => handleChange(e.target.value)}
              aria-label="Elegir transporte"
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 10,
                border: "1px solid #ddd", fontSize: 14, color: "#333",
                background: "#fff", appearance: "auto",
              }}
            >
              {opciones.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <div style={{
              padding: "10px 12px", borderRadius: 10,
              background: "#f8f8f8", border: "1px solid #eee",
              fontSize: 14, fontWeight: 500, color: "#333",
            }}>
              {opciones.length ? opciones[0] : "—"}
            </div>
          )}

          {showCorreo ? (
            <div style={{
              marginTop: 12, padding: 12, borderRadius: 10,
              background: "#fafafa", border: "1px solid #eee",
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#333", marginBottom: 4 }}>
                Correo Argentino
              </div>
              <p style={{ margin: 0, fontSize: 12, color: "#666", lineHeight: 1.45 }}>
                Si elegís Correo Argentino, te informaremos el costo total (pedido + envío) para abonarlo antes del despacho.
              </p>
            </div>
          ) : effective !== "—" ? (
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
        </>
      )}
    </div>
  );
}
