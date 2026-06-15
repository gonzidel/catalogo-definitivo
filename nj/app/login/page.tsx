import { Suspense } from "react";
import type { Metadata } from "next";
import LoginClient from "./LoginClient";

export const metadata: Metadata = {
  title: "Acceso clientes — FYL Catálogo",
  description: "Ingresá a tu cuenta para ver tus pedidos y acceder al catálogo mayorista.",
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginClient />
    </Suspense>
  );
}
