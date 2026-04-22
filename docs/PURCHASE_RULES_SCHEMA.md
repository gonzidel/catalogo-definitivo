# Contrato: reglas de compras (`purchase_supplier_rule_versions.rules`)

Este documento describe el JSON versionado que consume **`purchase_compute_lines`**. El cálculo de pares, brutos, descuentos y netos ocurre **solo en Postgres**; OpenAI y n8n no deben inventar montos ni `normalized_unit_code`.

## Rol de cada capa

| Capa | Responsabilidad |
|------|-----------------|
| **OpenAI** | Extracción mínima: `supplier_hint`, ítems con `unit_text`, `quantity`, `unit_price`, `price_basis_hint` (`per_par` \| `per_tarea` \| `unknown`), flags `needs_review`. Sin totales ni pares. |
| **n8n** | Ingest → OpenAI → validar JSON → **`purchase_resolve_supplier`** → cargar regla activa → **`purchase_compute_lines`** → persistir `purchase_orders` / `purchase_order_lines`. Sin fórmulas de negocio en nodos Code. |
| **RPC** | Resolución de unidad contra `rules.units`, `price_basis`, descuento global, totales. Errores explícitos en `errors[]` sin defaults silenciosos. |

## Esquema `rules` (objeto raíz)

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `currency` | string | no | Moneda por defecto de líneas (ej. `ARS`). |
| `default_discount_pct` | number | no | Descuento 0–100 aplicado al bruto de cada línea con importe. |
| `units` | object | **sí** | Mapa `codigo_canonico` → definición de unidad (ver abajo). |
| `size_mix_per_unit` | object | no | Metadata opcional para composición de talles (fase 2; no altera el cálculo por línea salvo evolución explícita). |

### Objeto `units.<code>`

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `pairs_per_unit` | number | **sí** | Pares equivalentes por unidad pedida (ej. `tarea` → 24). |
| `default_price_basis` | string | **sí** | `per_par`, `per_tarea` o `per_unit` (alias interno de “por unidad de pedido”). |
| `allowed_price_bases` | string[] | no | Si se omite o está vacío, se asume solo `default_price_basis`. Controla qué valores de `price_basis_hint` del extractor son válidos. |
| `match` | string[] | no | Etiquetas en lenguaje natural que se normalizan con **`purchase_normalize_hint`** (misma lógica que aliases de proveedor: `lower` + `unaccent` + espacios colapsados) y se comparan con `unit_text` del mensaje. |

La clave del objeto (`tarea`, `par`, …) es el **`normalized_unit_code`** que persiste la línea tras un match exitoso.

## Resolución de proveedor (`purchase_resolve_supplier`)

- Entrada: `p_hint` (texto libre, p. ej. lo que devolvió OpenAI en `supplier_hint`).
- Normalización: función SQL **`public.purchase_normalize_hint(text)`** → `lower` + **`extensions.unaccent`** + trim + colapsar espacios.
- Se compara contra `slug`, `display_name` y cada elemento de **`purchase_suppliers.aliases`**.
- Salida: `{ ok: true, supplier_id, normalized_hint }` o `{ ok: false, reason: 'empty_hint' \| 'not_found' \| 'ambiguous', ... }`.

## Ejemplo “Cara Regina” (referencia)

Tras la migración `181_purchase_suppliers_module.sql`, el proveedor semilla incluye reglas equivalentes a:

```json
{
  "currency": "ARS",
  "default_discount_pct": 20,
  "units": {
    "par": {
      "pairs_per_unit": 1,
      "default_price_basis": "per_par",
      "match": ["par", "pares", "prs"]
    },
    "tarea": {
      "pairs_per_unit": 24,
      "default_price_basis": "per_tarea",
      "allowed_price_bases": ["per_tarea", "per_par"],
      "match": ["tarea", "tareas", "tar"]
    }
  },
  "size_mix_per_unit": {
    "tarea": { "36": 3, "37": 4, "38": 5, "39": 5, "40": 4, "41": 3 }
  }
}
```

Mensaje típico: proveedor “Cara Regina” o “CR”, cantidad en “tareas”, precio por tarea o por par según texto; el extractor marca `price_basis_hint` solo si el mensaje lo respalda; si no, `unknown` y el RPC usa `default_price_basis` de la unidad.

## `needs_review` (tres capas)

| Origen | `needs_review_source` sugerido | Ejemplos |
|--------|-------------------------------|----------|
| A — OpenAI | `openai` | Unidad o precio ambiguos, proveedor no claro. |
| B — Orquestador | `orchestrator` | JSON inválido, HTTP OpenAI vacío, proveedor no resuelto, sin regla activa. |
| C — RPC | `rpc` | Unidad no en `rules`, `price_basis` incompatible, errores en `errors[]`; líneas sin importe cuando falta precio. |

En cabecera `purchase_orders` y por línea `purchase_order_lines` se persisten `needs_review` y `needs_review_source` según el resultado del pipeline y del RPC.

## Referencias en código

- Migración: `supabase/canonical/181_purchase_suppliers_module.sql`
- Workflow Telegram / n8n: `docs/n8n-proveedores-ingest.workflow.json` (generado por `node scripts/build-n8n-proveedores-workflow.mjs`)
