// scripts/import-customers.js
// Script Node.js para importar clientes desde CSV directamente a Supabase
// Uso: node scripts/import-customers.js ruta/al/archivo.csv
// IMPORTANTE: Requiere SUPABASE_SERVICE_ROLE_KEY en config.local.js

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Provincias argentinas para validación
const ARGENTINA_PROVINCES = [
  "Buenos Aires", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes",
  "Entre Ríos", "Formosa", "Jujuy", "La Pampa", "La Rioja", "Mendoza",
  "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis",
  "Santa Cruz", "Santa Fe", "Santiago del Estero", "Tierra del Fuego",
  "Tucumán", "CABA"
];

// Función para normalizar provincia
function normalizeProvince(province) {
  if (!province) return null;
  const normalized = province.trim().toUpperCase();
  
  // Mapeo de variaciones comunes
  const provinceMap = {
    'BUENOS AIRES': 'Buenos Aires',
    'CAPITAL FEDERAL': 'CABA',
    'CIUDAD AUTONOMA DE BUENOS AIRES': 'CABA',
    'C.A.B.A.': 'CABA',
    'CABA': 'CABA',
    'CATAMARCA': 'Catamarca',
    'CHACO': 'Chaco',
    'CHUBUT': 'Chubut',
    'CORDOBA': 'Córdoba',
    'CÓRDOBA': 'Córdoba',
    'CORRIENTES': 'Corrientes',
    'ENTRE RIOS': 'Entre Ríos',
    'ENTRE RÍOS': 'Entre Ríos',
    'FORMOSA': 'Formosa',
    'JUJUY': 'Jujuy',
    'LA PAMPA': 'La Pampa',
    'LA RIOJA': 'La Rioja',
    'MENDOZA': 'Mendoza',
    'MISIONES': 'Misiones',
    'NEUQUEN': 'Neuquén',
    'NEUQUÉN': 'Neuquén',
    'RIO NEGRO': 'Río Negro',
    'RÍO NEGRO': 'Río Negro',
    'SALTA': 'Salta',
    'SAN JUAN': 'San Juan',
    'SAN LUIS': 'San Luis',
    'SANTA CRUZ': 'Santa Cruz',
    'SANTA FE': 'Santa Fe',
    'SANTIAGO DEL ESTERO': 'Santiago del Estero',
    'TIERRA DEL FUEGO': 'Tierra del Fuego',
    'TUCUMAN': 'Tucumán',
    'TUCUMÁN': 'Tucumán'
  };
  
  return provinceMap[normalized] || province;
}

// Cargar configuración
let SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY;

try {
  // Intentar cargar config.local.js primero
  const configLocalPath = join(__dirname, 'config.local.js');
  const configLocalUrl = `file://${configLocalPath.replace(/\\/g, '/')}`;
  const configLocal = await import(configLocalUrl);
  SUPABASE_URL = configLocal.SUPABASE_URL;
  SUPABASE_SERVICE_ROLE_KEY = configLocal.SUPABASE_SERVICE_ROLE_KEY;
} catch (e) {
  // Si no existe, usar config.js
  const configPath = join(__dirname, 'config.js');
  const configUrl = `file://${configPath.replace(/\\/g, '/')}`;
  const config = await import(configUrl);
  SUPABASE_URL = config.SUPABASE_URL;
  SUPABASE_SERVICE_ROLE_KEY = config.SUPABASE_SERVICE_ROLE_KEY;
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Error: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY deben estar configurados');
  console.error('💡 Crea scripts/config.local.js con tus credenciales de Supabase');
  console.error('💡 Obtén la SERVICE_ROLE_KEY en: Supabase Dashboard → Settings → API → service_role (secret)');
  process.exit(1);
}

// Crear cliente de Supabase con service_role (bypass RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Función para parsear CSV simple
function parseCSV(content) {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  
  const rows = [];
  
  // Saltar header (línea 0) y procesar desde línea 1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Parsear valores (manejar comas dentro de comillas)
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
    // Agregar la última columna
    if (columnCount < 5) {
      values.push(current.trim().replace(/^"|"$/g, ''));
    }
    
    // Solo procesar si tenemos datos
    if (values.length === 0 || values.every(v => !v)) continue;
    
    // Mapear según columnas A-E:
    // A: Nombre y apellido
    // B: Telefono
    // C: LOCALIDAD (ciudad)
    // D: PROVINCIA
    // E: Direccion
    const customer = {
      full_name: (values[0] || '').trim(),
      phone: (values[1] || '').trim(),
      city: (values[2] || '').trim(),
      province: (values[3] || '').trim(),
      address: (values[4] || '').trim()
    };
    
    // Solo agregar si tiene nombre
    if (customer.full_name) {
      rows.push(customer);
    }
  }
  
  return rows;
}

// Validar cliente
function validateCustomer(customer, index) {
  const errors = [];
  
  if (!customer.full_name || !customer.full_name.trim()) {
    errors.push('Nombre requerido');
  }
  if (!customer.phone || !customer.phone.trim()) {
    errors.push('Teléfono requerido');
  }
  if (!customer.address || !customer.address.trim()) {
    errors.push('Dirección requerida');
  }
  if (!customer.city || !customer.city.trim()) {
    errors.push('Ciudad requerida');
  }
  if (!customer.province || !customer.province.trim()) {
    errors.push('Provincia requerida');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// Función principal
async function importCustomers(csvPath) {
  console.log('🚀 Iniciando importación de clientes...\n');
  
  try {
    // Leer archivo CSV
    console.log(`📁 Leyendo archivo: ${csvPath}`);
    const csvContent = readFileSync(csvPath, 'utf-8');
    console.log(`✅ Archivo leído (${csvContent.length} caracteres)\n`);
    
    // Parsear CSV
    console.log('🔍 Parseando CSV...');
    const customers = parseCSV(csvContent);
    console.log(`✅ ${customers.length} clientes encontrados en el CSV\n`);
    
    if (customers.length === 0) {
      console.error('❌ No se encontraron clientes en el CSV');
      return;
    }
    
    // Validar clientes
    console.log('🔍 Validando clientes...');
    const validCustomers = [];
    const invalidCustomers = [];
    
    customers.forEach((customer, index) => {
      const validation = validateCustomer(customer, index);
      if (validation.valid) {
        validCustomers.push(customer);
      } else {
        invalidCustomers.push({ ...customer, index: index + 2, errors: validation.errors });
      }
    });
    
    console.log(`✅ ${validCustomers.length} clientes válidos`);
    if (invalidCustomers.length > 0) {
      console.log(`⚠️  ${invalidCustomers.length} clientes con errores:\n`);
      invalidCustomers.slice(0, 10).forEach(c => {
        console.log(`   Fila ${c.index}: ${c.full_name || 'Sin nombre'} - ${c.errors.join(', ')}`);
      });
      if (invalidCustomers.length > 10) {
        console.log(`   ... y ${invalidCustomers.length - 10} más`);
      }
      console.log('');
    }
    
    if (validCustomers.length === 0) {
      console.error('❌ No hay clientes válidos para importar');
      return;
    }
    
    // Confirmar importación
    console.log(`\n📊 Resumen:`);
    console.log(`   Total en CSV: ${customers.length}`);
    console.log(`   Válidos: ${validCustomers.length}`);
    console.log(`   Con errores: ${invalidCustomers.length}\n`);
    
    // Normalizar provincias
    console.log('🔍 Normalizando provincias...');
    const customersForRPC = validCustomers.map(c => {
      const province = normalizeProvince(c.province);
      return {
        full_name: c.full_name,
        phone: c.phone,
        address: c.address,
        city: c.city,
        province: province,
        dni: null,
        email: null
      };
    });
    
    console.log('✅ Datos preparados para importación\n');
    
    // Importar en lotes (máximo 100 por vez para evitar timeouts)
    const batchSize = 100;
    let totalCreated = 0;
    let totalErrors = 0;
    
    console.log(`📦 Importando en lotes de ${batchSize}...\n`);
    
    for (let i = 0; i < customersForRPC.length; i += batchSize) {
      const batch = customersForRPC.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(customersForRPC.length / batchSize);
      
      console.log(`📦 Procesando lote ${batchNum}/${totalBatches} (${batch.length} clientes)...`);
      
      const { data, error } = await supabase.rpc('rpc_bulk_create_customers', {
        p_customers: batch
      });
      
      if (error) {
        console.error(`❌ Error en lote ${batchNum}:`, error.message);
        console.error(`   Detalles:`, error);
        totalErrors += batch.length;
      } else if (data) {
        // La función RPC retorna un objeto con created, errors, processed, etc.
        const created = parseInt(data.created || 0);
        const errors = parseInt(data.errors || 0);
        const processed = parseInt(data.processed || 0);
        
        totalCreated += created;
        totalErrors += errors;
        
        console.log(`   ✅ ${created} creados, ${errors} errores, ${processed} procesados`);
        
        if (errors > 0 && data.error_details && Array.isArray(data.error_details)) {
          console.log(`   ⚠️  Primeros errores:`);
          data.error_details.slice(0, 5).forEach((err, idx) => {
            const customerName = err.customer?.full_name || err.full_name || 'Cliente desconocido';
            const errorMsg = err.error || err.message || 'Error desconocido';
            console.log(`      ${idx + 1}. ${customerName}: ${errorMsg}`);
          });
        }
      } else {
        console.error(`❌ Error: No se recibió respuesta del servidor en lote ${batchNum}`);
        totalErrors += batch.length;
      }
      
      // Pequeña pausa entre lotes para no sobrecargar el servidor
      if (i + batchSize < customersForRPC.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log(`\n✅ Importación completada:`);
    console.log(`   Total creados: ${totalCreated}`);
    console.log(`   Total errores: ${totalErrors}`);
    console.log(`   Total procesados: ${customersForRPC.length}\n`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Ejecutar si se llama directamente
const csvPath = process.argv[2];

if (!csvPath) {
  console.error('❌ Error: Debes proporcionar la ruta al archivo CSV');
  console.error('💡 Uso: node scripts/import-customers.js ruta/al/archivo.csv');
  console.error('💡 Ejemplo: node scripts/import-customers.js "C:\\Users\\gonzi\\Downloads\\Clientes3.csv"');
  console.error('');
  console.error('📝 IMPORTANTE: Necesitas configurar SUPABASE_SERVICE_ROLE_KEY en scripts/config.local.js');
  console.error('   Obtén la key en: Supabase Dashboard → Settings → API → service_role (secret)');
  process.exit(1);
}

importCustomers(csvPath);

