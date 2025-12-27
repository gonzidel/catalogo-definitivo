// scripts/generate-customers-sql-batches.js
// Script Node.js para generar múltiples archivos SQL en lotes
// Uso: node scripts/generate-customers-sql-batches.js ruta/al/archivo.csv

import { readFileSync, writeFileSync } from 'fs';
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
  const normalized = province.trim();
  const match = ARGENTINA_PROVINCES.find(p => 
    p.toLowerCase() === normalized.toLowerCase()
  );
  return match || normalized;
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
function generateSQLBatches(csvPath) {
  try {
    console.log('📁 Leyendo archivo:', csvPath);
    const csvContent = readFileSync(csvPath, 'utf-8');
    
    console.log('🔍 Parseando CSV...');
    const customers = parseCSV(csvContent);
    console.log(`✅ ${customers.length} clientes encontrados\n`);
    
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
    
    console.log(`✅ ${validCustomers.length} clientes válidos`);
    if (errorCount > 0) {
      console.log(`⚠️  ${errorCount} clientes omitidos por datos incompletos\n`);
    }
    
    // Generar archivos SQL en lotes usando RPC
    const batchSize = 50; // 50 clientes por archivo
    const totalBatches = Math.ceil(validCustomers.length / batchSize);
    const outputDir = join(process.cwd(), 'import-customers-batches');
    
    console.log(`\n📦 Generando ${totalBatches} archivos SQL en lotes de ${batchSize} clientes...\n`);
    
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
      jsonString = jsonString.replace(/'/g, "''");
      
      // Generar contenido SQL
      const sqlContent = `-- Archivo ${batchNum} de ${totalBatches}
-- Lote ${batchNum}: ${batch.length} clientes
-- Ejecutar este archivo en Supabase SQL Editor

SELECT public.rpc_bulk_create_customers('${jsonString}'::jsonb) as resultado_lote_${batchNum};
`;
      
      // Guardar archivo
      const fileName = `import-customers-batch-${String(batchNum).padStart(4, '0')}.sql`;
      const filePath = join(process.cwd(), fileName);
      writeFileSync(filePath, sqlContent, 'utf-8');
      
      console.log(`✅ Generado: ${fileName} (${batch.length} clientes)`);
    }
    
    console.log(`\n✅ ${totalBatches} archivos SQL generados exitosamente`);
    console.log(`\n💡 INSTRUCCIONES:`);
    console.log(`   1. Ejecuta los archivos en Supabase SQL Editor en orden:`);
    console.log(`      import-customers-batch-0001.sql`);
    console.log(`      import-customers-batch-0002.sql`);
    console.log(`      ... y así sucesivamente`);
    console.log(`   2. O ejecuta todos a la vez copiando y pegando el contenido de cada archivo`);
    console.log(`   3. Cada archivo procesa un lote de hasta ${batchSize} clientes\n`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Ejecutar
const csvPath = process.argv[2];

if (!csvPath) {
  console.error('❌ Error: Debes proporcionar la ruta al archivo CSV');
  console.error('💡 Uso: node scripts/generate-customers-sql-batches.js ruta/al/archivo.csv');
  console.error('💡 Ejemplo: node scripts/generate-customers-sql-batches.js "Clientes3.csv"');
  process.exit(1);
}

generateSQLBatches(csvPath);

