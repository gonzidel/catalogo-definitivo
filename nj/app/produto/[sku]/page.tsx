// Note: this file is at app/produto/[sku] — maps to /produto/[sku]
// The primary PDP route is /producto/[sku] (correct Spanish spelling)
// This file exists as a redirect stub only — see app/producto/[sku]/page.tsx
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ sku: string }>;
}

export default async function PdpRedirect({ params }: PageProps) {
  const { sku } = await params;
  redirect(`/producto/${sku}`);
}
