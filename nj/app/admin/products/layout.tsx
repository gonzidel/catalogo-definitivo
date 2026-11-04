/**
 * Variables de tipografía del admin de productos.
 * No usa next/font/google: el fetch a Google Fonts rompe `next build`
 * en Windows (certificado) y no debe ser dependencia de compile.
 * El catálogo ya carga Poppins; acá se reutiliza como display/body.
 */
export default function ProductsAdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="admin-products-fonts"
      style={{
        ["--font-display" as string]: "Poppins, Georgia, serif",
        ["--font-body" as string]: "Poppins, system-ui, sans-serif",
        ["--font-mono" as string]: "ui-monospace, Consolas, monospace",
      }}
    >
      {children}
    </div>
  );
}
