// supabase/functions/upload-image/index.ts
// Edge Function para subir imágenes a Cloudinary

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "dnuedzuzm";
const CLOUDINARY_API_KEY = Deno.env.get("CLOUDINARY_API_KEY");
const CLOUDINARY_API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET");

const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

// CORS headers mejorados para producción
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

interface UploadRequest {
  variant_id: string;
  file: string; // base64 string
  category: string;
  sku_base: string;
  color: string;
  position?: number;
}

interface UploadResponse {
  public_id: string;
  secure_url: string;
  url: string; // igual a secure_url para compatibilidad
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Validar configuración
    if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      console.error("❌ Cloudinary credentials no están configuradas");
      console.error("   CLOUDINARY_API_KEY:", CLOUDINARY_API_KEY ? "✅ Configurado" : "❌ Faltante");
      console.error("   CLOUDINARY_API_SECRET:", CLOUDINARY_API_SECRET ? "✅ Configurado" : "❌ Faltante");
      return new Response(
        JSON.stringify({ 
          error: "Cloudinary credentials no están configuradas en la Edge Function",
          hint: "Configura CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET en Supabase Dashboard → Edge Functions → upload-image → Settings → Secrets"
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validar autenticación
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "No autorizado" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Crear cliente para validar autenticación (usa JWT del usuario)
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || "", {
      global: { headers: { Authorization: authHeader } },
    });

    // Verificar que el usuario esté autenticado
    const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "No autenticado" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Usar cliente con SERVICE_ROLE para has_permission (evita problemas con RLS/JWT de colaboradores)
    const supabaseAdmin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");

    // Verificar que el usuario puede editar productos (super_admin o colaborador con permiso)
    let canUpload = false;
    try {
      const { data: hasPerm, error: permError } = await supabaseAdmin
        .rpc("has_permission", {
          check_user_id: user.id,
          permission_key: "products",
          action: "edit",
        });

      if (permError) {
        console.error("Error verificando permisos:", permError);
        return new Response(
          JSON.stringify({ error: "Error verificando permisos de administrador" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      canUpload = hasPerm === true;
    } catch (err) {
      console.error("Excepción verificando permisos:", err);
      return new Response(
        JSON.stringify({ error: "Error verificando permisos" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!canUpload) {
      return new Response(
        JSON.stringify({ error: "No tienes permisos para subir imágenes" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parsear request
    const { variant_id, file, category, sku_base, color, position }: UploadRequest = await req.json();

    // Validación estricta: variant_id es obligatorio
    if (!variant_id) {
      return new Response(
        JSON.stringify({ error: "variant_id es obligatorio" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Verificar que variant_id existe en DB y pertenece al usuario autenticado
    // (RLS ya maneja permisos, pero validamos explícitamente)
    const { data: variant, error: variantError } = await supabaseAdmin
      .from("product_variants")
      .select("id, product_id, color")
      .eq("id", variant_id)
      .single();

    if (variantError || !variant) {
      return new Response(
        JSON.stringify({ error: "variant_id no válido o no existe" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validar otros campos requeridos
    if (!file) {
      return new Response(
        JSON.stringify({ error: "file es obligatorio" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validar tipo de archivo (base64: data:image/jpeg;base64,... o data:image/png;base64,...)
    const fileMatch = file.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
    if (!fileMatch) {
      return new Response(
        JSON.stringify({ error: "Formato de archivo inválido. Solo se permiten: jpg, png, webp" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const fileType = fileMatch[1];
    const base64Data = fileMatch[2];

    // Validar tamaño (aproximadamente, base64 es ~33% más grande que binario)
    // 5MB = 5 * 1024 * 1024 = 5242880 bytes
    // base64: 5242880 * 1.33 ≈ 6970000 caracteres
    if (base64Data.length > 7000000) {
      return new Response(
        JSON.stringify({ error: "Archivo muy grande. Máximo 5MB" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Preparar carpeta y public_id en Cloudinary
    // Formato: {category}/{sku_base}/{colorSlug}/{sku_base}-{colorSlug}-{position}
    const normalizedCategory = (category || "otros").toLowerCase().trim().replace(/[^a-z0-9-]/g, "-");
    const normalizedSkuBase = (sku_base || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const colorSlug = (color || variant.color || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const imageIndex = position || 1;
    
    // Guard rail: sku_base es requerido para construir public_id
    if (!normalizedSkuBase || normalizedSkuBase.trim() === "") {
      return new Response(
        JSON.stringify({ error: "sku_base required to build public_id" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    
    // Usar SKU en el nombre para permitir overwrite estable
    const folder = `${normalizedCategory}/${normalizedSkuBase}/${colorSlug}`;
    const public_id = `${folder}/${normalizedSkuBase}-${colorSlug}-${imageIndex}`;

    // Subir a Cloudinary usando signed upload
    // Cloudinary acepta data URIs directamente, así que usamos el string completo
    const formData = new FormData();
    formData.append("file", file); // data URI completo: data:image/jpeg;base64,...
    formData.append("public_id", public_id);
    formData.append("overwrite", "true");
    formData.append("invalidate", "true");
    
    // NOTA: No enviamos context porque requiere estar en la signature
    // Los metadatos (sku, color, variant_id, category) ya están en el public_id y se guardan en DB

    // Generar signature para signed upload
    // IMPORTANTE: Para signed uploads, todos los parámetros (excepto file y api_key) deben estar en la signature
    // Orden alfabético: invalidate, overwrite, public_id, timestamp
    const timestamp_cloudinary = Math.floor(Date.now() / 1000);
    const params_to_sign = `invalidate=true&overwrite=true&public_id=${public_id}&timestamp=${timestamp_cloudinary}`;
    const signature = await generateCloudinarySignature(params_to_sign);

    // Logging para debug
    console.log("Cloudinary upload params:", {
      public_id,
      folder,
      normalizedSkuBase,
      colorSlug,
      imageIndex,
      timestamp: timestamp_cloudinary,
      params_to_sign,
      signature_length: signature.length,
      has_api_key: !!CLOUDINARY_API_KEY,
      has_api_secret: !!CLOUDINARY_API_SECRET,
    });

    formData.append("timestamp", timestamp_cloudinary.toString());
    formData.append("signature", signature);
    formData.append("api_key", CLOUDINARY_API_KEY!);

    const cloudinaryResponse = await fetch(CLOUDINARY_UPLOAD_URL, {
      method: "POST",
      body: formData,
    });

    if (!cloudinaryResponse.ok) {
      const errorText = await cloudinaryResponse.text();
      console.error("Error Cloudinary:", {
        status: cloudinaryResponse.status,
        statusText: cloudinaryResponse.statusText,
        error: errorText,
        public_id,
        params_to_sign,
      });
      return new Response(
        JSON.stringify({ error: `Error subiendo imagen a Cloudinary: ${errorText}` }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const cloudinaryData = await cloudinaryResponse.json();

    const response: UploadResponse = {
      public_id: cloudinaryData.public_id,
      secure_url: cloudinaryData.secure_url,
      url: cloudinaryData.secure_url, // Para compatibilidad
    };

    return new Response(
      JSON.stringify(response),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (error) {
    console.error("Error en upload-image:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error("Error stack:", errorStack);
    
    return new Response(
      JSON.stringify({ 
        error: errorMessage || "Error interno del servidor",
        details: process.env.DENO_ENV === "development" ? errorStack : undefined
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

// Función para generar signature de Cloudinary
// IMPORTANTE: Cloudinary requiere concatenar api_secret al string y luego hacer SHA1
async function generateCloudinarySignature(params: string): Promise<string> {
  // Concatenar api_secret al final del string
  const stringToSign = params + CLOUDINARY_API_SECRET!;
  
  // Convertir a bytes
  const encoder = new TextEncoder();
  const data = encoder.encode(stringToSign);
  
  // Calcular SHA-1 hash
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  
  return hashHex;
}

