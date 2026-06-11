"use client";

import type { ReactNode } from "react";

export function formatItemARS(n: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(n);
}

interface StatusChip {
  label: string;
  color: string;
  bg: string;
}

interface LineItemRowProps {
  imagen?: string;
  productName: string;
  color?: string;
  size?: string;
  quantity: number;
  unitPrice: number;
  status?: StatusChip;
  highlight?: "missing" | "outOfStock" | null;
  strikePrice?: boolean;
  line2?: ReactNode;
  trailing?: ReactNode;
  below?: ReactNode;
}

function buildTitle(productName: string, color?: string, size?: string) {
  const parts = [productName];
  if (color) parts.push(color);
  if (size) parts.push(`T. ${size}`);
  return parts.join(" · ");
}

export default function LineItemRow({
  imagen,
  productName,
  color,
  size,
  quantity,
  unitPrice,
  status,
  highlight = null,
  strikePrice = false,
  line2,
  trailing,
  below,
}: LineItemRowProps) {
  const isWarn = highlight === "missing" || highlight === "outOfStock";
  const lineTotal = unitPrice * quantity;

  return (
    <div>
      <div style={{
        display: "flex",
        gap: 10,
        padding: "10px 12px",
        alignItems: "center",
        background: isWarn ? "#fff5f5" : "transparent",
        borderLeft: isWarn ? "3px solid #fca5a5" : "3px solid transparent",
      }}>
        {imagen ? (
          <img
            src={imagen}
            alt={productName}
            style={{
              width: 48,
              height: 48,
              borderRadius: 8,
              objectFit: "cover",
              flexShrink: 0,
              background: "#f5f5f5",
              opacity: isWarn ? 0.55 : 1,
              filter: isWarn ? "grayscale(0.25)" : "none",
            }}
          />
        ) : (
          <div style={{
            width: 48,
            height: 48,
            borderRadius: 8,
            flexShrink: 0,
            background: "#f0f0f0",
          }} />
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13,
            fontWeight: 600,
            color: isWarn ? "#991b1b" : "#222",
            lineHeight: 1.25,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {buildTitle(productName, color, size)}
          </div>
          <div style={{
            fontSize: 11,
            color: "#888",
            marginTop: 3,
            lineHeight: 1.3,
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}>
            {line2 ?? (
              <span>{quantity} uni · {formatItemARS(unitPrice)} c/u</span>
            )}
          </div>
        </div>

        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexShrink: 0,
          alignSelf: "center",
        }}>
          {status && (
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              padding: "2px 6px",
              borderRadius: 20,
              color: status.color,
              background: status.bg,
              whiteSpace: "nowrap",
            }}>
              {status.label}
            </span>
          )}
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: strikePrice ? "#ccc" : "#555",
            textDecoration: strikePrice ? "line-through" : "none",
            whiteSpace: "nowrap",
          }}>
            {formatItemARS(lineTotal)}
          </span>
          {trailing}
        </div>
      </div>
      {below && (
        <div style={{ padding: "0 12px 8px 70px" }}>
          {below}
        </div>
      )}
    </div>
  );
}
