import Link from "next/link";

export default function NotFound() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        padding: "32px 16px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, color: "#333" }}>
        Página no encontrada
      </h2>
      <p style={{ fontSize: 14, color: "#888", marginBottom: 24 }}>
        La página que buscás no existe o fue movida.
      </p>
      <Link href="/" className="btn btn-primary">
        Ir al catálogo
      </Link>
    </div>
  );
}
