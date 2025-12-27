// scripts/generate-customers-sql.js
// Script Node.js para generar SQL INSERT desde CSV
// Uso: node scripts/generate-customers-sql.js ruta/al/archivo.csv > output.sql

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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

// Función para escapar strings SQL
function escapeSQL(str) {
  if (!str) return 'NULL';
  return "'" + str.replace(/'/g, "''").replace(/\\/g, '\\\\') + "'";
}

// Función para normalizar provincia
function normalizeProvince(province) {
  if (!province) return null;
  const normalized = province.trim();
  const match = ARGENTINA_PROVINCES.find(p => 
    p.toLowerCase() === normalized.toLowerCase()
  );
  return match || normalized;
}

// Función para generar número de cliente (secuencial)
let customerNumberCounter = 1;
function generateCustomerNumber() {
  const num = customerNumberCounter.toString().padStart(4, '0');
  customerNumberCounter++;
  return num;
}

// Función para parsear CSV
function parseCSV(content) {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
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
    if (columnCount < 5) {
      values.push(current.trim().replace(/^"|"$/g, ''));
    }
    
    if (values.length === 0 || values.every(v => !v)) continue;
    
    const customer = {
      full_name: (values[0] || '').trim(),
      phone: (values[1] || '').trim(),
      city: (values[2] || '').trim(),
      province: (values[3] || '').trim(),
      address: (values[4] || '').trim()
    };
    
    if (customer.full_name) {
      rows.push(customer);
    }
  }
  
  return rows;
}

// Función principal
function generateSQL(csvPath) {
  try {
    console.error('📁 Leyendo archivo:', csvPath);
    const csvContent = readFileSync(csvPath, 'utf-8');
    
    console.error('🔍 Parseando CSV...');
    const customers = parseCSV(csvContent);
    console.error(`✅ ${customers.length} clientes encontrados\n`);
    
    if (customers.length === 0) {
      console.error('❌ No se encontraron clientes');
      process.exit(1);
    }
    
    // Filtrar y validar clientes
    const validCustomers = [];
    let errorCount = 0;
    
    customers.forEach((customer, index) => {
      if (!customer.full_name || !customer.phone || !customer.address || !customer.city || !customer.province) {
        console.error(`⚠️  Fila ${index + 2}: Datos incompletos - omitida`);
        errorCount++;
        return;
      }
      
      const province = normalizeProvince(customer.province);
      validCustomers.push({
        ...customer,
        province: province
      });
    });
    
    console.error(`✅ ${validCustomers.length} clientes válidos`);
    if (errorCount > 0) {
      console.error(`⚠️  ${errorCount} clientes omitidos por datos incompletos\n`);
    }
    
    // Generar SQL usando función RPC en un solo bloque DO $$
    // Esto procesará todos los lotes automáticamente en una sola ejecución
    const batchSize = 100; // Procesar de 100 en 100
    const totalBatches = Math.ceil(validCustomers.length / batchSize);
    
    console.log('-- Script SQL generado automáticamente desde CSV');
    console.log('-- Este script procesa TODOS los clientes automáticamente en una sola ejecución');
    console.log(`-- Total de clientes: ${validCustomers.length}`);
    console.log(`-- Total de lotes: ${totalBatches} (${batchSize} clientes por lote)\n`);
    
    console.log('DO $$');
    console.log('DECLARE');
    console.log('  v_result json;');
    console.log('  v_total_created integer := 0;');
    console.log('  v_total_errors integer := 0;');
    console.log('  v_batch_num integer := 0;');
    console.log('BEGIN');
    console.log(`  RAISE NOTICE 'Iniciando importación de ${validCustomers.length} clientes en ${totalBatches} lotes...';\n`);
    
    // Generar lotes dentro del bloque DO $$
    for (let i = 0; i < validCustomers.length; i += batchSize) {
      const batch = validCustomers.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      
      // Convertir batch a JSON para la función RPC
      const jsonArray = batch.map(c => ({
        full_name: c.full_name,
        phone: c.phone,
        address: c.address,
        city: c.city,
        province: c.province,
        dni: null,
        email: null
      }));
      
      // Convertir a JSON string y escapar comillas simples para SQL
      let jsonString = JSON.stringify(jsonArray);
      // Escapar comillas simples para SQL (doble comilla simple)
      jsonString = jsonString.replace(/'/g, "''");
      
      console.log(`  -- Lote ${batchNum}/${totalBatches} (${batch.length} clientes)`);
      console.log(`  v_batch_num := ${batchNum};`);
      console.log(`  v_result := public.rpc_bulk_create_customers('${jsonString}'::jsonb);`);
      console.log(`  v_total_created := v_total_created + (v_result->>'created')::integer;`);
      console.log(`  v_total_errors := v_total_errors + (v_result->>'errors')::integer;`);
      console.log(`  RAISE NOTICE 'Lote %/% completado: % creados, % errores', v_batch_num, ${totalBatches}, (v_result->>'created')::integer, (v_result->>'errors')::integer;\n`);
    }
    
    console.log(`  RAISE NOTICE 'Importación completada: % clientes creados, % errores', v_total_created, v_total_errors;`);
    console.log('END $$;');
    
    console.error(`\n✅ Script generado con ${totalBatches} lotes`);
    console.error(`💡 Ejecuta TODO el script en Supabase SQL Editor (una sola vez)`);
    console.error(`💡 El script procesará automáticamente todos los ${totalBatches} lotes`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Ejecutar
const csvPath = process.argv[2];

if (!csvPath) {
  console.error('❌ Error: Debes proporcionar la ruta al archivo CSV');
  console.error('💡 Uso: node scripts/generate-customers-sql.js ruta/al/archivo.csv > output.sql');
  console.error('💡 Ejemplo: node scripts/generate-customers-sql.js "Clientes3.csv" > import.sql');
  process.exit(1);
}

generateSQL(csvPath);

