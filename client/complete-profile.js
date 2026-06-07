import { supabase } from "../scripts/supabase-client.js?v=m260607";
import { ARGENTINA_PROVINCES, PROVINCE_CITIES } from "../scripts/argentina-locations-data.js?v=m260607";

const form = document.getElementById("form");
const emailInput = document.getElementById("email");
const errorMessage = document.getElementById("error-message");
const submitBtn = document.getElementById("submit-btn");

// Verificar autenticación y si ya tiene perfil completo
async function checkAuthAndRedirect() {
  try {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    
    if (sessionError || !session) {
      console.log("👤 No hay sesión activa, redirigiendo a login");
      window.location.replace("./login.html");
      return null;
    }

    // Prellenar email
    if (emailInput && session.user?.email) {
      emailInput.value = session.user.email;
    }

    // Verificar si ya tiene perfil completo
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("full_name, phone, dni, province, city, address")
      .eq("id", session.user.id)
      .single();

    if (!customerError && customer) {
      // Verificar si tiene todos los campos requeridos
      const hasCompleteProfile = 
        customer.full_name && 
        customer.phone && 
        customer.dni && 
        customer.province && 
        customer.city &&
        customer.address &&
        String(customer.address).trim() !== "";

      if (hasCompleteProfile) {
        console.log("✅ Usuario ya tiene perfil completo, redirigiendo a dashboard");
        window.location.replace("./dashboard.html");
        return null;
      }
    }

    return session.user;
  } catch (error) {
    console.error("❌ Error verificando autenticación:", error);
    window.location.replace("./login.html");
    return null;
  }
}

// Inicializar autocomplete de provincias y ciudades
function initializeAutocomplete() {
  const provinceInput = document.getElementById("province");
  const provinceDropdown = document.getElementById("province-dropdown");
  const cityInput = document.getElementById("city");
  const cityDropdown = document.getElementById("city-dropdown");
  
  if (!provinceInput || !provinceDropdown || !cityInput || !cityDropdown) return;
  
  // Event listener para provincia
  provinceInput.addEventListener("input", (e) => {
    handleProvinceInput(e.target.value);
  });
  
  provinceInput.addEventListener("focus", () => {
    if (provinceInput.value.length > 0) {
      handleProvinceInput(provinceInput.value);
    }
  });
  
  // Event listener para ciudad
  cityInput.addEventListener("input", (e) => {
    if (!cityInput.disabled) {
      handleCityInput(e.target.value);
    }
  });
  
  cityInput.addEventListener("focus", () => {
    if (!cityInput.disabled && cityInput.value.length > 0) {
      handleCityInput(cityInput.value);
    }
  });
  
  // Cerrar dropdowns al hacer clic fuera
  document.addEventListener("click", (e) => {
    if (provinceInput && !provinceInput.contains(e.target) && provinceDropdown && !provinceDropdown.contains(e.target)) {
      provinceDropdown.style.display = "none";
    }
    if (cityInput && !cityInput.contains(e.target) && cityDropdown && !cityDropdown.contains(e.target)) {
      cityDropdown.style.display = "none";
    }
  });
}

function handleProvinceInput(value) {
  const provinceInput = document.getElementById("province");
  const provinceDropdown = document.getElementById("province-dropdown");
  const cityInput = document.getElementById("city");
  
  if (!provinceInput || !provinceDropdown || !cityInput) return;
  
  const query = value.toLowerCase().trim();
  
  if (query.length === 0) {
    provinceDropdown.style.display = "none";
    return;
  }
  
  const matches = ARGENTINA_PROVINCES.filter(p => 
    p.toLowerCase().includes(query)
  );
  
  if (matches.length === 0) {
    provinceDropdown.style.display = "none";
    return;
  }
  
  provinceDropdown.innerHTML = matches.map(province => `
    <div class="custom-dropdown-item" data-value="${province}">${province}</div>
  `).join("");
  
  provinceDropdown.style.display = "block";
  
  // Event listeners para items del dropdown
  provinceDropdown.querySelectorAll(".custom-dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
      provinceInput.value = item.dataset.value;
      provinceDropdown.style.display = "none";
      updateCitiesList(item.dataset.value);
      cityInput.disabled = false;
      cityInput.placeholder = "Escribí la localidad o elegí de la lista…";
      cityInput.value = "";
    });
  });
}

function updateCitiesList(province) {
  const cityInput = document.getElementById("city");
  const cityDropdown = document.getElementById("city-dropdown");
  
  if (!cityInput || !cityDropdown) return;
  
  const cities = PROVINCE_CITIES[province] || [];
  // Guardar ciudades para usar en el autocomplete
  cityInput.dataset.availableCities = JSON.stringify(cities);
}

function handleCityInput(value) {
  const cityInput = document.getElementById("city");
  const cityDropdown = document.getElementById("city-dropdown");
  
  if (!cityInput || !cityDropdown || cityInput.disabled) return;
  
  const availableCitiesStr = cityInput.dataset.availableCities;
  if (!availableCitiesStr) {
    cityDropdown.style.display = "none";
    return;
  }
  
  const availableCities = JSON.parse(availableCitiesStr);
  const query = value.toLowerCase().trim();
  
  if (query.length === 0) {
    cityDropdown.style.display = "none";
    return;
  }
  
  const matches = availableCities.filter(city => 
    city.toLowerCase().includes(query)
  );
  
  if (matches.length === 0) {
    cityDropdown.style.display = "none";
    return;
  }
  
  cityDropdown.innerHTML = matches.map(city => `
    <div class="custom-dropdown-item" data-value="${city}">${city}</div>
  `).join("");
  
  cityDropdown.style.display = "block";
  
  // Event listeners para items del dropdown
  cityDropdown.querySelectorAll(".custom-dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
      cityInput.value = item.dataset.value;
      cityDropdown.style.display = "none";
    });
  });
}

// Validar formato de teléfono argentino
function validatePhone(phone) {
  if (!phone) return false;
  // Remover espacios, guiones y cualquier carácter no numérico
  let cleaned = phone.replace(/[\s\-\(\)]/g, "");
  // El 9 ya está fijo en el prefijo, así que solo validamos los dígitos restantes
  // Debe tener entre 8 y 10 dígitos (código de área + número, sin el 9)
  return /^\d{8,10}$/.test(cleaned);
}

// Formatear teléfono para guardar (formato WhatsApp: +54 9 362 472-0762)
function formatPhone(phone) {
  if (!phone) return "";
  
  // Remover espacios, guiones y cualquier carácter no numérico
  let cleaned = phone.replace(/[\s\-\(\)]/g, "");
  
  // El 9 ya está fijo en el prefijo, así que agregarlo siempre
  if (cleaned.length >= 8) {
    cleaned = "9" + cleaned;
  }
  
  // Formatear como WhatsApp: +54 9 362 472-0762
  // Estructura: +54 9 [código área 2-4 dígitos] [número 6-8 dígitos]
  if (cleaned.length >= 10) {
    // Número con código de área
    const match = cleaned.match(/^9(\d{2,4})(\d{6,8})$/);
    if (match) {
      const areaCode = match[1];
      const number = match[2];
      // Formatear número con guión antes de los últimos 4 dígitos
      const formattedNumber = number.length > 4 
        ? `${number.slice(0, -4)}-${number.slice(-4)}`
        : number;
      return `+54 9 ${areaCode} ${formattedNumber}`;
    }
  }
  
  // Si no coincide el formato, devolver con prefijo +54 9
  return `+54 9 ${cleaned}`;
}

// Formatear teléfono mientras se escribe (agregar espacios y guiones automáticamente)
function formatPhoneInput(value) {
  if (!value) return "";
  
  // Remover todo excepto dígitos
  let digits = value.replace(/\D/g, "");
  
  // Limitar a 10 dígitos (código de área + número, sin el 9 que está fijo)
  if (digits.length > 10) {
    digits = digits.substring(0, 10);
  }
  
  // Formatear: 3624720762 -> 362 472-0762
  if (digits.length === 0) return "";
  
  if (digits.length <= 3) {
    return digits;
  } else if (digits.length <= 6) {
    return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  } else {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  
  // Ocultar mensajes anteriores
  if (errorMessage) errorMessage.classList.remove("show");

  try {
    const user = await checkAuthAndRedirect();
    if (!user) return;

    // Sanitizar y validar campos de entrada
    function sanitizeText(text, maxLength = 255) {
      if (!text) return "";
      // Remover caracteres de control y limitar longitud
      return text
        .replace(/[\x00-\x1F\x7F]/g, "") // Remover caracteres de control
        .trim()
        .substring(0, maxLength);
    }
    
    const firstName = sanitizeText(document.getElementById("first_name").value, 100);
    const lastName = sanitizeText(document.getElementById("last_name").value, 100);
    // Obtener teléfono sin espacios ni guiones para validar
    const phoneRaw = document.getElementById("phone").value.replace(/\s|-/g, "");
    const phone = phoneRaw.trim();
    const dni = document.getElementById("dni").value.trim().replace(/\D/g, ""); // Solo dígitos
    const city = sanitizeText(document.getElementById("city").value, 100);
    const province = sanitizeText(document.getElementById("province").value, 100);
    const address = sanitizeText(document.getElementById("address")?.value || "", 500);

    // Validaciones
    if (!firstName || firstName.length < 2) {
      throw new Error("El nombre debe tener al menos 2 caracteres");
    }
    
    if (firstName.length > 100) {
      throw new Error("El nombre no puede tener más de 100 caracteres");
    }

    if (!lastName || lastName.length < 2) {
      throw new Error("El apellido debe tener al menos 2 caracteres");
    }
    
    if (lastName.length > 100) {
      throw new Error("El apellido no puede tener más de 100 caracteres");
    }
    
    if (city.length > 100) {
      throw new Error("La ciudad no puede tener más de 100 caracteres");
    }
    
    if (province.length > 100) {
      throw new Error("La provincia no puede tener más de 100 caracteres");
    }

    if (!dni) {
      throw new Error("El DNI es obligatorio");
    }

    if (dni.length < 7 || dni.length > 8 || !/^\d+$/.test(dni)) {
      throw new Error("El DNI debe tener entre 7 y 8 dígitos numéricos");
    }

    if (!phone) {
      throw new Error("El teléfono es obligatorio");
    }

    if (!validatePhone(phone)) {
      throw new Error("El teléfono debe tener entre 8 y 10 dígitos (código de área + número)");
    }

    if (!province) {
      throw new Error("La provincia es obligatoria");
    }

    if (!ARGENTINA_PROVINCES.includes(province)) {
      throw new Error("La provincia seleccionada no es válida");
    }

    if (!city || city.length < 2) {
      throw new Error("La localidad es obligatoria (podés escribirla aunque no esté en la lista)");
    }

    if (!address || address.length < 4) {
      throw new Error("La dirección es obligatoria (calle y número, mínimo 4 caracteres)");
    }

    if (address.length > 500) {
      throw new Error("La dirección no puede superar los 500 caracteres");
    }

    // Deshabilitar botón durante el guardado
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Guardando...";
    }

    const formattedPhone = formatPhone(phone);
    
    // Buscar si existe un registro previo en public_sales_customers o customers (admin)
    let customerNumber = null;
    let qrCode = null;
    let publicSalesCustomerId = null;
    
    const { data: linkResult, error: linkError } = await supabase.rpc('rpc_link_public_sales_customer', {
      p_user_id: user.id,
      p_email: user.email,
      p_dni: dni,
      p_phone: formattedPhone,
      p_province: province,
      p_city: city
    });

    if (linkError) {
      console.warn("⚠️ Error al buscar vinculación con registros de admin:", linkError);
      // Continuar con el flujo normal si hay error en la búsqueda
    } else if (linkResult?.found) {
      // Encontró coincidencia, usar datos del admin
      customerNumber = linkResult.customer_number;
      
      if (linkResult.source === 'public_sales') {
        // Registro de public_sales_customers
        qrCode = linkResult.qr_code;
        publicSalesCustomerId = linkResult.public_sales_customer_id;
        console.log("✅ Cliente vinculado con registro de public-sales:", customerNumber);
      } else if (linkResult.source === 'admin_orders') {
        // Registro de customers con created_by_admin = true
        console.log("✅ Cliente vinculado con registro de admin/orders:", customerNumber);
      }
    }

    // Construir payload
    const payload = {
      id: user.id,
      full_name: `${firstName} ${lastName}`.trim(),
      phone: formattedPhone,
      dni: dni,
      province: province,
      city: city,
      email: user.email,
      address,
    };

    // Si se encontró coincidencia en admin_orders, preservar address admin si el usuario no cargó una
    if (linkResult?.found && linkResult.source === 'admin_orders' && linkResult.address && !address) {
      payload.address = linkResult.address;
    }

    // Si se encontró coincidencia, agregar customer_number, qr_code y public_sales_customer_id
    if (customerNumber) {
      payload.customer_number = customerNumber;
      if (qrCode) {
        payload.qr_code = qrCode;
      }
      if (publicSalesCustomerId) {
        payload.public_sales_customer_id = publicSalesCustomerId;
      }
    }

    // Usar función RPC para evitar problemas de RLS con upsert
    const { data: rpcResult, error: rpcError } = await supabase.rpc('rpc_upsert_customer', {
      p_full_name: payload.full_name,
      p_address: payload.address || null,
      p_city: payload.city,
      p_province: payload.province,
      p_phone: payload.phone,
      p_dni: payload.dni,
      p_email: payload.email,
      p_customer_number: payload.customer_number || null,
      p_qr_code: payload.qr_code || null,
      p_public_sales_customer_id: payload.public_sales_customer_id || null
    });

    if (rpcError) {
      console.error("❌ Error en RPC:", rpcError);
      throw new Error(rpcError.message || "Error al guardar el perfil");
    }

    if (!rpcResult || !rpcResult.success) {
      throw new Error(rpcResult?.error || "Error al guardar el perfil");
    }

    // Mostrar mensaje de éxito
    console.log("✅ Perfil completado correctamente");
    
    // Mantener al usuario en dashboard luego de completar el perfil
    window.location.href = "./dashboard.html";
  } catch (e) {
    console.error("❌ Error:", e);
    // Mostrar mensaje de error
    if (errorMessage) {
      errorMessage.textContent = `Error: ${e.message}`;
      errorMessage.classList.add("show");
    }

    // Rehabilitar botón
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Completar Registro";
    }
  }
});

// Agregar formateo automático mientras se escribe
function setupPhoneInputFormatting() {
  const phoneInput = document.getElementById("phone");
  if (!phoneInput) return;
  
  phoneInput.addEventListener("input", (e) => {
    const cursorPosition = e.target.selectionStart;
    const oldValue = e.target.value;
    const newValue = formatPhoneInput(e.target.value);
    
    if (oldValue !== newValue) {
      e.target.value = newValue;
      // Restaurar posición del cursor
      const lengthDiff = newValue.length - oldValue.length;
      e.target.setSelectionRange(cursorPosition + lengthDiff, cursorPosition + lengthDiff);
    }
  });
  
  // Prevenir que se pegue texto con formato incorrecto
  phoneInput.addEventListener("paste", (e) => {
    e.preventDefault();
    const pastedText = (e.clipboardData || window.clipboardData).getData("text");
    const digits = pastedText.replace(/\D/g, "");
    if (digits.length > 10) {
      e.target.value = formatPhoneInput(digits.substring(0, 10));
    } else {
      e.target.value = formatPhoneInput(digits);
    }
  });
}

// Inicializar
(async () => {
  const user = await checkAuthAndRedirect();
  if (user) {
    initializeAutocomplete();
    setupPhoneInputFormatting();
  } else {
    setupPhoneInputFormatting();
  }
})();

