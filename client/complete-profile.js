import { supabase } from "../scripts/supabase-client.js";
import { checkPasskeySupport, hasRegisteredPasskeys, registerPasskey } from "../scripts/passkeys.js";

// Provincias y ciudades argentinas para autocomplete
const ARGENTINA_PROVINCES = [
  "Buenos Aires", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes",
  "Entre Ríos", "Formosa", "Jujuy", "La Pampa", "La Rioja", "Mendoza",
  "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis",
  "Santa Cruz", "Santa Fe", "Santiago del Estero", "Tierra del Fuego",
  "Tucumán", "CABA"
];

const PROVINCE_CITIES = {
  "Buenos Aires": ["La Plata", "Mar del Plata", "Bahía Blanca", "Tandil", "Quilmes", "Lanús", "Banfield", "Lomas de Zamora", "Avellaneda", "Merlo", "San Miguel", "Moreno", "Morón", "Florencio Varela", "Berazategui", "San Isidro", "Tigre", "Pilar", "Malvinas Argentinas", "Esteban Echeverría"],
  "Catamarca": ["San Fernando del Valle de Catamarca", "Valle Viejo", "Fray Mamerto Esquiú", "San Isidro"],
  "Chaco": ["Resistencia", "Barranqueras", "Villa Ángela", "Presidencia Roque Sáenz Peña", "Charata", "General San Martín", "Juan José Castelli", "Machagai", "Quitilipi", "Villa Berthet"],
  "Chubut": ["Rawson", "Comodoro Rivadavia", "Trelew", "Puerto Madryn", "Esquel", "Sarmiento", "Gaiman"],
  "Córdoba": ["Córdoba", "Villa Carlos Paz", "Río Cuarto", "Villa María", "San Francisco", "Villa Allende", "Jesús María", "Unquillo", "La Calera", "Marcos Juárez"],
  "Corrientes": ["Corrientes", "Goya", "Mercedes", "Curuzú Cuatiá", "Bella Vista", "Paso de los Libres", "Monte Caseros", "Esquina"],
  "Entre Ríos": ["Paraná", "Concordia", "Gualeguaychú", "Concepción del Uruguay", "Villaguay", "Colón", "Nogoyá", "Federación"],
  "Formosa": ["Formosa", "Clorinda", "Pirané", "El Colorado", "Comandante Fontana", "Laguna Naick Neck"],
  "Jujuy": ["San Salvador de Jujuy", "Palpalá", "Perico", "San Pedro de Jujuy", "La Quiaca", "Humahuaca"],
  "La Pampa": ["Santa Rosa", "General Pico", "Toay", "Realicó", "Eduardo Castex", "General Acha"],
  "La Rioja": ["La Rioja", "Chilecito", "Arauco", "Aminga", "Chamical"],
  "Mendoza": ["Mendoza", "San Rafael", "Godoy Cruz", "Luján de Cuyo", "Maipú", "Guaymallén", "Las Heras", "Rivadavia", "Tunuyán", "San Martín"],
  "Misiones": ["Posadas", "Oberá", "Eldorado", "Puerto Iguazú", "Leandro N. Alem", "Apóstoles", "Montecarlo"],
  "Neuquén": ["Neuquén", "Cutral Có", "Plottier", "Zapala", "San Martín de los Andes", "Villa La Angostura"],
  "Río Negro": ["Viedma", "Bariloche", "General Roca", "Cipolletti", "Allen", "Cinco Saltos", "Villa Regina"],
  "Salta": ["Salta", "San Salvador de Jujuy", "Orán", "Tartagal", "Cafayate", "Metán", "Rosario de la Frontera"],
  "San Juan": ["San Juan", "Rawson", "Rivadavia", "Santa Lucía", "Pocito", "Chimbas", "Caucete"],
  "San Luis": ["San Luis", "Villa Mercedes", "Merlo", "La Toma", "Justo Daract"],
  "Santa Cruz": ["Río Gallegos", "Caleta Olivia", "El Calafate", "Puerto Deseado", "Pico Truncado"],
  "Santa Fe": ["Santa Fe", "Rosario", "Venado Tuerto", "Rafaela", "Reconquista", "Santo Tomé", "Villa Gobernador Gálvez", "San Lorenzo"],
  "Santiago del Estero": ["Santiago del Estero", "La Banda", "Fernández", "Frías", "Termas de Río Hondo"],
  "Tierra del Fuego": ["Ushuaia", "Río Grande", "Tolhuin"],
  "Tucumán": ["San Miguel de Tucumán", "Yerba Buena", "Tafí Viejo", "Concepción", "Banda del Río Salí", "Alderetes"],
  "CABA": ["Ciudad Autónoma de Buenos Aires"]
};

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
      .select("full_name, phone, dni, province, city")
      .eq("id", session.user.id)
      .single();

    if (!customerError && customer) {
      // Verificar si tiene todos los campos requeridos
      const hasCompleteProfile = 
        customer.full_name && 
        customer.phone && 
        customer.dni && 
        customer.province && 
        customer.city;

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
      cityInput.placeholder = "Escriba para buscar ciudad...";
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

    if (!city) {
      throw new Error("La ciudad es obligatoria");
    }

    const cities = PROVINCE_CITIES[province] || [];
    if (!cities.includes(city)) {
      throw new Error("La ciudad seleccionada no es válida para la provincia elegida");
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
    };

    // Si se encontró coincidencia en admin_orders, preservar address si existe
    if (linkResult?.found && linkResult.source === 'admin_orders' && linkResult.address) {
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
    
    // Verificar si el cliente es de Resistencia-Chaco
    const isResistenciaChaco = 
      city.toLowerCase().trim() === "resistencia" &&
      province.toLowerCase().trim() === "chaco";
    
    if (isResistenciaChaco) {
      console.log("📍 Cliente de Resistencia-Chaco detectado, redirigiendo a customer.html");
      
      // Si ya tenemos customer_number de la vinculación, usarlo directamente
      if (!customerNumber) {
        // Si no se vinculó, obtener customer_number (puede que necesite generarse por el trigger)
        // Esperar un momento para que el trigger genere el customer_number
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Intentar obtener el customer_number
        const { data: updatedCustomer, error: fetchError } = await supabase
          .from("customers")
          .select("customer_number")
          .eq("id", user.id)
          .single();
        
        if (!fetchError && updatedCustomer?.customer_number) {
          customerNumber = updatedCustomer.customer_number;
        } else {
          // Si aún no tiene, esperar un poco más y reintentar
          console.log("⏳ Esperando generación de customer_number...");
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const { data: retryCustomer } = await supabase
            .from("customers")
            .select("customer_number")
            .eq("id", user.id)
            .single();
          
          if (retryCustomer?.customer_number) {
            customerNumber = retryCustomer.customer_number;
          }
        }
      }
      
      if (customerNumber) {
        console.log("✅ Redirigiendo a customer.html con código:", customerNumber);
        window.location.href = `../customer.html?code=${encodeURIComponent(customerNumber)}`;
        return;
      } else {
        console.error("❌ No se pudo obtener customer_number, redirigiendo a dashboard como fallback");
        window.location.href = "./dashboard.html";
        return;
      }
    }
    
    // Si no es de Resistencia-Chaco, continuar con el flujo normal
    // Verificar si debe mostrar modal de passkey
    await checkAndShowPasskeyModal();
    
    // Si no se muestra el modal, redirigir directamente
    const passkeyModal = document.getElementById("passkey-modal");
    if (!passkeyModal || passkeyModal.style.display === "none") {
      window.location.href = "./dashboard.html";
    }
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

// Función para verificar y mostrar modal de passkey
async function checkAndShowPasskeyModal() {
  try {
    // Verificar soporte WebAuthn
    if (!checkPasskeySupport()) {
      return; // No mostrar modal si no hay soporte
    }

    // Verificar si ya eligió "omitir" recientemente
    const dismissedAt = localStorage.getItem("passkeys_prompt_dismissed_at");
    if (dismissedAt) {
      const dismissedDate = new Date(dismissedAt);
      const daysSinceDismissed = (Date.now() - dismissedDate.getTime()) / (1000 * 60 * 60 * 24);
      
      // No mostrar si pasaron menos de 7 días
      if (daysSinceDismissed < 7) {
        console.log("Modal de passkey omitido recientemente");
        return;
      }
    }

    // Obtener sesión
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      return; // No hay sesión
    }

    // Verificar si ya tiene passkey registrada
    const hasPasskey = await hasRegisteredPasskeys(session.user.id);
    if (hasPasskey) {
      return; // Ya tiene passkey, no mostrar modal
    }

    // Mostrar modal
    const passkeyModal = document.getElementById("passkey-modal");
    if (passkeyModal) {
      passkeyModal.style.display = "flex";
    }
  } catch (error) {
    console.error("Error verificando passkey:", error);
  }
}

// Función para cerrar modal de passkey
function closePasskeyModal() {
  const passkeyModal = document.getElementById("passkey-modal");
  if (passkeyModal) {
    passkeyModal.style.display = "none";
  }
}

// Función para activar passkey
async function activatePasskey() {
  const activateBtn = document.getElementById("activate-passkey-btn");
  const skipBtn = document.getElementById("skip-passkey-btn");
  const msgDiv = document.getElementById("passkey-modal-msg");

  if (!activateBtn || !msgDiv) return;

  activateBtn.disabled = true;
  activateBtn.textContent = "Registrando...";
  if (skipBtn) skipBtn.disabled = true;
  msgDiv.style.display = "none";
  msgDiv.className = "";

  try {
    await registerPasskey();
    
    // Éxito
    msgDiv.textContent = "✅ Acceso biométrico activado correctamente";
    msgDiv.style.display = "block";
    msgDiv.style.background = "#d4edda";
    msgDiv.style.color = "#155724";
    msgDiv.style.border = "1px solid #c3e6cb";
    
    // Redirigir al dashboard después de 1.5 segundos
    setTimeout(() => {
      window.location.href = "./dashboard.html";
    }, 1500);
  } catch (error) {
    console.error("Error activando passkey:", error);
    msgDiv.textContent = `❌ Error: ${error.message || "No se pudo activar el acceso biométrico"}`;
    msgDiv.style.display = "block";
    msgDiv.style.background = "#f8d7da";
    msgDiv.style.color = "#721c24";
    msgDiv.style.border = "1px solid #f5c6cb";
    
    activateBtn.disabled = false;
    activateBtn.textContent = "🔐 Activar Acceso Biométrico";
    if (skipBtn) skipBtn.disabled = false;
  }
}

// Función para omitir passkey
function skipPasskey() {
  // Guardar timestamp de cuando se omitió
  localStorage.setItem("passkeys_prompt_dismissed_at", new Date().toISOString());
  
  // Cerrar modal y redirigir
  closePasskeyModal();
  window.location.href = "./dashboard.html";
}

// Inicializar event listeners para el modal de passkey
function initPasskeyModal() {
  const activateBtn = document.getElementById("activate-passkey-btn");
  const skipBtn = document.getElementById("skip-passkey-btn");
  const closeBtn = document.getElementById("passkey-modal-close");
  const modal = document.getElementById("passkey-modal");

  activateBtn?.addEventListener("click", activatePasskey);
  skipBtn?.addEventListener("click", skipPasskey);
  closeBtn?.addEventListener("click", skipPasskey);

  // Cerrar al hacer clic fuera del modal
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) {
      skipPasskey();
    }
  });
}

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
    initPasskeyModal();
    setupPhoneInputFormatting();
  } else {
    setupPhoneInputFormatting();
  }
})();

