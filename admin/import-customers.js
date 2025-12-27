// admin/import-customers.js
// Importación masiva de clientes desde CSV

import { supabase as supabaseClient } from "../scripts/supabase-client.js";
import { requireAdminAuth, isAdmin } from "./permissions-helper.js";

let supabase = supabaseClient;
let parsedCustomers = [];
let validatedCustomers = [];

// Provincias argentinas para validación
const ARGENTINA_PROVINCES = [
  "Buenos Aires", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes",
  "Entre Ríos", "Formosa", "Jujuy", "La Pampa", "La Rioja", "Mendoza",
  "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis",
  "Santa Cruz", "Santa Fe", "Santiago del Estero", "Tierra del Fuego",
  "Tucumán", "CABA"
];

// Función para obtener supabase
async function getSupabase() {
  if (supabase) return supabase;
  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }
  
  let attempts = 0;
  const maxAttempts = 50;
  while (!window.supabase && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }
  
  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }
  
  try {
    const module = await import("../scripts/supabase-client.js");
    supabase = module.supabase || window.supabase;
    if (!supabase) {
      await new Promise(resolve => setTimeout(resolve, 500));
      supabase = module.supabase || window.supabase;
    }
    if (supabase && !window.supabase) {
      window.supabase = supabase;
    }
    return supabase;
  } catch (error) {
    console.error("❌ Error importando supabase-client:", error);
    return null;
  }
}

// Parser de CSV simple - Solo lee columnas A, B, C, D, E
function parseCSV(text) {
  console.log("🔍 Iniciando parseo de CSV...");
  console.log("📄 Texto recibido (primeros 500 chars):", text.substring(0, 500));
  
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  console.log("📊 Líneas encontradas:", lines.length);
  
  if (lines.length < 2) {
    console.warn("⚠️ CSV tiene menos de 2 líneas");
    return [];
  }
  
  // Parsear headers - solo las primeras 5 columnas (A, B, C, D, E)
  const headersOriginal = lines[0].split(',').slice(0, 5).map(h => h.trim().replace(/"/g, ''));
  const headers = headersOriginal.map(h => h.toLowerCase());
  console.log("📋 Headers encontrados (solo A-E):", headers);
  
  // Mapeo fijo según posición:
  // A (índice 0): Nombre y apellido
  // B (índice 1): Telefono
  // C (índice 2): LOCALIDAD (ciudad)
  // D (índice 3): PROVINCIA
  // E (índice 4): Direccion
  
  const indices = {
    nombre_completo: 0,  // Columna A
    telefono: 1,         // Columna B
    ciudad: 2,           // Columna C
    provincia: 3,        // Columna D
    direccion: 4         // Columna E
  };
  
  console.log("📊 Índices de columnas (fijos):", indices);
  
  // Parsear filas - solo las primeras 5 columnas (A, B, C, D, E)
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    
    // Parsear valores (manejar comas dentro de comillas) - solo primeras 5 columnas
    const values = [];
    let current = '';
    let inQuotes = false;
    let columnCount = 0;
    
    for (let j = 0; j < line.length && columnCount < 5; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
        columnCount++;
      } else {
        current += char;
      }
    }
    // Agregar la última columna si no llegamos a 5 columnas
    if (columnCount < 5) {
      values.push(current.trim().replace(/^"|"$/g, ''));
    }
    
    // Solo procesar si tenemos al menos algunas columnas con datos
    if (values.length === 0 || values.every(v => !v)) continue;
    
    // Mapear valores según índices fijos
    const row = {
      nombre_completo: values[0] || '',      // Columna A
      telefono: values[1] || '',            // Columna B
      ciudad: values[2] || '',              // Columna C
      provincia: values[3] || '',           // Columna D
      direccion: values[4] || ''            // Columna E
    };
    
    // Nombre completo viene directamente de la columna A
    row.full_name = row.nombre_completo.trim();
    
    // Limpiar y normalizar valores
    row.telefono = row.telefono.trim();
    row.direccion = row.direccion.trim();
    row.provincia = row.provincia.trim();
    row.ciudad = row.ciudad.trim();
    
    // Solo agregar si tiene nombre completo
    if (row.full_name && row.full_name.length > 0) {
      rows.push(row);
    }
  }
  
  console.log(`✅ Parseados ${rows.length} clientes`);
  if (rows.length > 0) {
    console.log("📋 Primer cliente parseado:", rows[0]);
  }
  return rows;
}

// Validar un cliente
function validateCustomer(customer, index) {
  const errors = [];
  
  // Validar nombre completo
  if (!customer.full_name || !customer.full_name.trim()) {
    errors.push('Nombre completo requerido');
  }
  
  // Validar teléfono
  if (!customer.telefono || !customer.telefono.trim()) {
    errors.push('Teléfono requerido');
  } else {
    const phone = customer.telefono.replace(/[\s\-\(\)]/g, '');
    if (!/^\d{8,15}$/.test(phone)) {
      errors.push('Teléfono inválido (debe tener entre 8 y 15 dígitos)');
    }
  }
  
  // Validar dirección
  if (!customer.direccion || !customer.direccion.trim()) {
    errors.push('Dirección requerida');
  }
  
  // Validar provincia (case-insensitive)
  if (!customer.provincia || !customer.provincia.trim()) {
    errors.push('Provincia requerida');
  } else {
    const provinciaNormalized = customer.provincia.trim();
    const provinciaMatch = ARGENTINA_PROVINCES.find(p => 
      p.toLowerCase() === provinciaNormalized.toLowerCase()
    );
    if (!provinciaMatch) {
      errors.push(`Provincia inválida: "${customer.provincia}"`);
    } else {
      // Normalizar a la forma correcta (primera letra mayúscula)
      customer.provincia = provinciaMatch;
    }
  }
  
  // Validar ciudad
  if (!customer.ciudad || !customer.ciudad.trim()) {
    errors.push('Ciudad requerida');
  }
  
  // Validar DNI (opcional)
  if (customer.dni && customer.dni.trim()) {
    const dni = customer.dni.replace(/\D/g, '');
    if (dni.length < 7 || dni.length > 8) {
      errors.push('DNI inválido (debe tener 7 u 8 dígitos)');
    }
  }
  
  // Validar email (opcional)
  if (customer.email && customer.email.trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customer.email)) {
      errors.push('Email inválido');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors: errors
  };
}

// Mostrar mensaje
function showMessage(message, type = "success") {
  const container = document.getElementById("message-container");
  if (!container) return;
  
  container.innerHTML = `<div class="message ${type}">${message}</div>`;
  
  if (type === "success") {
    setTimeout(() => {
      container.innerHTML = "";
    }, 5000);
  }
}

// Renderizar preview
function renderPreview(customers) {
  const previewSection = document.getElementById("preview-section");
  const previewContainer = document.getElementById("preview-container");
  const statsContainer = document.getElementById("stats-container");
  const validationErrors = document.getElementById("validation-errors");
  
  if (!previewSection || !previewContainer) return;
  
  // Validar todos los clientes
  validatedCustomers = customers.map((customer, index) => {
    const validation = validateCustomer(customer, index);
    return {
      ...customer,
      validation,
      index: index + 1
    };
  });
  
  const validCount = validatedCustomers.filter(c => c.validation.valid).length;
  const errorCount = validatedCustomers.filter(c => !c.validation.valid).length;
  
  // Mostrar estadísticas
  statsContainer.innerHTML = `
    <div class="stat-item">
      <strong>${customers.length}</strong>
      <span>Total de clientes</span>
    </div>
    <div class="stat-item" style="border-left-color: #4CAF50;">
      <strong>${validCount}</strong>
      <span>Válidos</span>
    </div>
    <div class="stat-item" style="border-left-color: #F44336;">
      <strong>${errorCount}</strong>
      <span>Con errores</span>
    </div>
  `;
  
  // Mostrar tabla de preview
  const tableRows = validatedCustomers.slice(0, 50).map(customer => {
    const rowClass = customer.validation.valid ? '' : 'error-row';
    const errorCell = customer.validation.valid 
      ? '' 
      : `<td class="error-cell">${customer.validation.errors.join(', ')}</td>`;
    
    return `
      <tr class="${rowClass}">
        <td>${customer.index}</td>
        <td>${customer.full_name || 'N/A'}</td>
        <td>${customer.telefono || 'N/A'}</td>
        <td>${customer.direccion || 'N/A'}</td>
        <td>${customer.ciudad || 'N/A'}, ${customer.provincia || 'N/A'}</td>
        <td>${customer.dni || '-'}</td>
        <td>${customer.email || '-'}</td>
        ${errorCell}
      </tr>
    `;
  }).join('');
  
  previewContainer.innerHTML = `
    <table class="preview-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Nombre</th>
          <th>Teléfono</th>
          <th>Dirección</th>
          <th>Ciudad, Provincia</th>
          <th>DNI</th>
          <th>Email</th>
          ${errorCount > 0 ? '<th>Errores</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
    ${validatedCustomers.length > 50 ? `<p style="margin-top: 12px; color: #666;">Mostrando primeros 50 de ${validatedCustomers.length} clientes</p>` : ''}
  `;
  
  // Mostrar errores si los hay
  if (errorCount > 0) {
    const errorList = validatedCustomers
      .filter(c => !c.validation.valid)
      .map(c => `<li>Fila ${c.index}: ${c.validation.errors.join(', ')}</li>`)
      .join('');
    
    validationErrors.innerHTML = `<ul>${errorList}</ul>`;
    validationErrors.style.display = 'block';
  } else {
    validationErrors.style.display = 'none';
  }
  
  previewSection.style.display = 'block';
  
  // Habilitar/deshabilitar botón de importar
  const importBtn = document.getElementById("import-btn");
  if (importBtn) {
    importBtn.disabled = validCount === 0;
  }
}

// Importar clientes
async function importCustomers() {
  const db = await getSupabase();
  if (!db) {
    showMessage("Error: No se pudo conectar con la base de datos", "error");
    return;
  }
  
  // Verificar permisos
  const isUserAdmin = await isAdmin();
  if (!isUserAdmin) {
    showMessage("Error: No tienes permisos de administrador", "error");
    return;
  }
  
  // Filtrar solo clientes válidos
  const validCustomers = validatedCustomers
    .filter(c => c.validation.valid)
    .map(c => ({
      full_name: c.full_name.trim(),
      phone: c.telefono.trim(),
      address: c.direccion.trim(),
      city: c.ciudad.trim(),
      province: c.provincia.trim(),
      dni: c.dni ? c.dni.trim() : null,
      email: c.email ? c.email.trim() : null
    }));
  
  if (validCustomers.length === 0) {
    showMessage("No hay clientes válidos para importar", "error");
    return;
  }
  
  const resultsSection = document.getElementById("results-section");
  const resultsContainer = document.getElementById("results-container");
  const progressBar = document.getElementById("progress-bar");
  const progressFill = document.getElementById("progress-fill");
  
  if (resultsSection) resultsSection.style.display = 'block';
  if (progressBar) progressBar.classList.add('active');
  if (resultsContainer) resultsContainer.innerHTML = '<p>Importando clientes...</p>';
  
  try {
    // Llamar a la función RPC
    const { data, error } = await db.rpc('rpc_bulk_create_customers', {
      p_customers: validCustomers
    });
    
    if (error) throw error;
    
    if (!data || !data.success) {
      throw new Error(data?.message || 'Error desconocido');
    }
    
    // Mostrar resultados
    const successCount = data.created || 0;
    const errorCount = data.errors || 0;
    const total = data.total || 0;
    
    let resultsHTML = `
      <div class="stats">
        <div class="stat-item" style="border-left-color: #4CAF50;">
          <strong>${successCount}</strong>
          <span>Clientes creados</span>
        </div>
        <div class="stat-item" style="border-left-color: #F44336;">
          <strong>${errorCount}</strong>
          <span>Errores</span>
        </div>
        <div class="stat-item">
          <strong>${total}</strong>
          <span>Total procesados</span>
        </div>
      </div>
    `;
    
    if (errorCount > 0 && data.error_details && data.error_details.length > 0) {
      const errorList = data.error_details
        .slice(0, 20)
        .map(err => `<li>${err.customer?.full_name || 'Cliente'}: ${err.error}</li>`)
        .join('');
      
      resultsHTML += `
        <div class="error-list" style="margin-top: 20px;">
          <strong>Detalles de errores:</strong>
          <ul>${errorList}</ul>
          ${data.error_details.length > 20 ? `<p>... y ${data.error_details.length - 20} errores más</p>` : ''}
        </div>
      `;
    }
    
    if (resultsContainer) resultsContainer.innerHTML = resultsHTML;
    if (progressFill) {
      progressFill.style.width = '100%';
      progressFill.textContent = '100%';
    }
    
    showMessage(`Importación completada: ${successCount} clientes creados, ${errorCount} errores`, "success");
    
    // Redirigir a la lista de clientes después de 3 segundos
    setTimeout(() => {
      window.location.href = './customers.html';
    }, 3000);
    
  } catch (error) {
    console.error("Error importando clientes:", error);
    if (resultsContainer) {
      resultsContainer.innerHTML = `<div class="message error">Error: ${error.message}</div>`;
    }
    showMessage(`Error al importar: ${error.message}`, "error");
  } finally {
    if (progressBar) progressBar.classList.remove('active');
  }
}

// Inicializar cuando el DOM esté listo
document.addEventListener("DOMContentLoaded", async () => {
  console.log("🚀 Inicializando módulo de importación de clientes...");
  
  try {
    const db = await getSupabase();
    if (!db) {
      showMessage("Error: No se pudo conectar con Supabase", "error");
      return;
    }
    
    // Verificar autenticación
    const { data: { user }, error: authError } = await db.auth.getUser();
    
    if (authError || !user) {
      console.error("❌ Usuario no autenticado:", authError);
      window.location.href = "./index.html";
      return;
    }
    
    // Verificar permisos de admin
    const isUserAdmin = await isAdmin();
    if (!isUserAdmin) {
      showMessage("Error: No tienes permisos de administrador", "error");
      return;
    }
    
    console.log("✅ Permisos de admin verificados");
    
    // Event listeners
    const parseBtn = document.getElementById("parse-btn");
    const importBtn = document.getElementById("import-btn");
    const cancelBtn = document.getElementById("cancel-btn");
    const csvFile = document.getElementById("csv-file");
    const csvText = document.getElementById("csv-text");
    
    if (parseBtn) {
      parseBtn.addEventListener("click", async () => {
        console.log("🔍 Botón Analizar CSV clickeado");
        
        try {
          let csvContent = '';
          
          // Intentar obtener del archivo primero
          if (csvFile && csvFile.files && csvFile.files.length > 0) {
            const file = csvFile.files[0];
            console.log("📁 Archivo seleccionado:", file.name);
            console.log("📁 Tipo MIME:", file.type);
            console.log("📁 Tamaño:", file.size, "bytes");
            
            // Leer el archivo - intentar con diferentes encodings si es necesario
            try {
              csvContent = await file.text();
              console.log("📄 Contenido del archivo leído correctamente");
              console.log("📄 Primeros 500 chars:", csvContent.substring(0, 500));
            } catch (readError) {
              console.error("❌ Error leyendo archivo:", readError);
              showMessage(`Error al leer el archivo: ${readError.message}`, "error");
              return;
            }
          } else if (csvText && csvText.value.trim()) {
            console.log("📋 Usando texto pegado");
            csvContent = csvText.value.trim();
          } else {
            showMessage("Por favor, selecciona un archivo CSV o pega los datos", "error");
            return;
          }
          
          if (!csvContent || csvContent.trim() === '') {
            showMessage("El CSV está vacío", "error");
            return;
          }
          
          // Verificar que el contenido parece un CSV
          if (!csvContent.includes(',')) {
            showMessage("El archivo no parece ser un CSV válido (no contiene comas). Verifica el formato.", "error");
            return;
          }
          
          console.log("🔍 Parseando CSV...");
          parsedCustomers = parseCSV(csvContent);
          console.log("✅ Clientes parseados:", parsedCustomers.length);
          
          if (parsedCustomers.length > 0) {
            console.log("📋 Primer cliente parseado:", parsedCustomers[0]);
          }
          
          if (parsedCustomers.length === 0) {
            showMessage("No se pudieron parsear clientes del CSV. Verifica que el formato sea correcto (columnas A-E: Nombre, Teléfono, Localidad, Provincia, Dirección).", "error");
            return;
          }
          
          showMessage(`Se encontraron ${parsedCustomers.length} clientes en el CSV`, "success");
          renderPreview(parsedCustomers);
        } catch (error) {
          console.error("❌ Error al analizar CSV:", error);
          console.error("❌ Stack:", error.stack);
          showMessage(`Error al analizar CSV: ${error.message}`, "error");
        }
      });
    } else {
      console.error("❌ No se encontró el botón parse-btn");
    }
    
    if (importBtn) {
      importBtn.addEventListener("click", importCustomers);
    }
    
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        const previewSection = document.getElementById("preview-section");
        const resultsSection = document.getElementById("results-section");
        if (previewSection) previewSection.style.display = 'none';
        if (resultsSection) resultsSection.style.display = 'none';
        parsedCustomers = [];
        validatedCustomers = [];
        if (csvFile) csvFile.value = '';
        if (csvText) csvText.value = '';
      });
    }
    
    console.log("✅ Módulo de importación inicializado");
    
  } catch (error) {
    console.error("❌ Error en inicialización:", error);
    showMessage(`Error al inicializar: ${error.message}`, "error");
  }
});

