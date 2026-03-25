// scripts/generate-qz-private-key-b64.mjs
// Genera el base64 de la clave privada PEM limpia para QZ_PRIVATE_KEY_B64 en Supabase
//
// ⚠️ IMPORTANTE:
// - El archivo PEM debe contener SOLO el bloque BEGIN/END PRIVATE KEY
// - NO debe incluir "Bag Attributes" ni metadata del PKCS12
// - Si el PEM tiene "Bag Attributes", extraer solo el bloque BEGIN/END
//
// Uso:
//   node scripts/generate-qz-private-key-b64.mjs [ruta-al-pem]
//
// Si no se especifica ruta, busca en este orden:
//   1. qz-private-key.pem
//   2. qz-private-from-p12.pem

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

// Archivos a buscar (en orden de prioridad)
const PEM_CANDIDATES = [
  path.join(PROJECT_ROOT, 'qz-private-key.pem'),
  path.join(PROJECT_ROOT, 'qz-private-from-p12.pem'),
];

/**
 * Detecta y extrae bloques PEM de private key desde un archivo
 * @param {string} content - Contenido del archivo
 * @returns {{blocks: Array<{type: string, content: string}>, count: number}}
 */
function detectPrivateKeyBlocks(content) {
  if (!content || typeof content !== 'string') {
    return { blocks: [], count: 0 };
  }

  const blocks = [];
  
  // Buscar todos los bloques BEGIN PRIVATE KEY (PKCS#8)
  const pkcs8Regex = /-----BEGIN\s+PRIVATE\s+KEY-----[\s\S]+?-----END\s+PRIVATE\s+KEY-----/g;
  let match;
  while ((match = pkcs8Regex.exec(content)) !== null) {
    blocks.push({ type: 'PRIVATE KEY (PKCS#8)', content: match[0] });
  }
  
  // Buscar todos los bloques BEGIN RSA PRIVATE KEY (PKCS#1)
  const pkcs1Regex = /-----BEGIN\s+RSA\s+PRIVATE\s+KEY-----[\s\S]+?-----END\s+RSA\s+PRIVATE\s+KEY-----/g;
  while ((match = pkcs1Regex.exec(content)) !== null) {
    blocks.push({ type: 'RSA PRIVATE KEY (PKCS#1)', content: match[0] });
  }

  return { blocks, count: blocks.length };
}

/**
 * Extrae el bloque PEM limpio desde un archivo que puede contener metadata
 * @param {string} content - Contenido del archivo
 * @returns {{success: boolean, pem?: string, error?: string, blockCount?: number, blockTypes?: string[]}}
 */
function extractCleanPEM(content) {
  if (!content || typeof content !== 'string') {
    return { success: false, error: 'Contenido vacío o no es string' };
  }

  // Detectar todos los bloques de private key
  const { blocks, count } = detectPrivateKeyBlocks(content);

  // Validar cantidad de bloques
  if (count === 0) {
    return { 
      success: false, 
      error: 'No se encontró ningún bloque de private key válido.\n' +
             'El archivo debe contener exactamente UN bloque:\n' +
             '  - -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----\n' +
             '  - -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----'
    };
  }

  if (count > 1) {
    const types = blocks.map(b => b.type);
    const typesList = types.map((t, i) => `   ${i + 1}. ${t}`).join('\n');
    return {
      success: false,
      error: `Se encontraron ${count} bloques de private key (debe haber exactamente 1).\n\n` +
             `Bloques encontrados:\n${typesList}\n\n` +
             `Solución: El archivo debe contener SOLO un bloque BEGIN/END PRIVATE KEY.`,
      blockCount: count,
      blockTypes: types
    };
  }

  // Exactamente 1 bloque - retornarlo
  return { 
    success: true, 
    pem: blocks[0].content,
    blockType: blocks[0].type
  };
}

/**
 * Valida que el PEM sea válido para crypto.subtle.importKey
 * @param {string} pem - Contenido PEM
 * @returns {{valid: boolean, reason?: string, type?: string}}
 */
function validatePEM(pem) {
  if (!pem || typeof pem !== 'string') {
    return { valid: false, reason: 'PEM es null o no es string' };
  }

  const trimmed = pem.trim();

  // Verificar que comience con BEGIN
  if (!trimmed.startsWith('-----BEGIN')) {
    return { valid: false, reason: 'PEM no comienza con -----BEGIN' };
  }

  // Verificar que termine con END
  if (!trimmed.endsWith('-----')) {
    return { valid: false, reason: 'PEM no termina con -----END' };
  }

  // Verificar que NO contenga "Bag Attributes" (metadata de PKCS12)
  if (trimmed.includes('Bag Attributes') || trimmed.includes('localKeyID')) {
    return { 
      valid: false, 
      reason: 'PEM contiene metadata de PKCS12 (Bag Attributes). Debe extraerse solo el bloque BEGIN/END PRIVATE KEY' 
    };
  }

  // Determinar tipo de clave
  let type = 'unknown';
  if (trimmed.includes('BEGIN RSA PRIVATE KEY')) {
    type = 'RSA (PKCS#1)';
  } else if (trimmed.includes('BEGIN PRIVATE KEY')) {
    type = 'PKCS#8';
  }

  // Verificar que tenga contenido base64 entre BEGIN y END
  const base64Match = trimmed.match(/-----BEGIN[^-]+-----([\s\S]+?)-----END[^-]+-----/);
  if (!base64Match || !base64Match[1] || base64Match[1].trim().length === 0) {
    return { valid: false, reason: 'PEM no contiene contenido base64 válido entre BEGIN y END' };
  }

  return { valid: true, type };
}

/**
 * Lee y valida el archivo PEM
 * @param {string} filePath - Ruta al archivo PEM
 * @returns {{success: boolean, pem?: string, error?: string}}
 */
function readAndValidatePEM(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Archivo no encontrado: ${filePath}` };
    }

    const rawContent = fs.readFileSync(filePath, 'utf8');
    
    // Extraer PEM limpio (puede tener metadata)
    const extractResult = extractCleanPEM(rawContent);
    
    if (!extractResult.success) {
      return { 
        success: false, 
        error: extractResult.error || `No se pudo extraer bloque PEM válido desde: ${filePath}`
      };
    }

    // Validar el PEM extraído
    const validation = validatePEM(extractResult.pem);
    
    if (!validation.valid) {
      return { 
        success: false, 
        error: `PEM inválido: ${validation.reason}\n` +
               `Archivo: ${filePath}\n` +
               `Tipo de bloque detectado: ${extractResult.blockType}\n` +
               `Contenido extraído (primeros 200 chars):\n${extractResult.pem.substring(0, 200)}...` 
      };
    }

    return { 
      success: true, 
      pem: extractResult.pem,
      type: validation.type,
      blockType: extractResult.blockType
    };
  } catch (error) {
    return { 
      success: false, 
      error: `Error leyendo archivo: ${error.message}` 
    };
  }
}

/**
 * Normaliza un PEM para comparación (normaliza saltos de línea, trimEnd)
 * @param {string} pem - Contenido PEM
 * @returns {string} - PEM normalizado
 */
function normalizePEM(pem) {
  if (!pem || typeof pem !== 'string') {
    return '';
  }
  
  // Normalizar: \r\n -> \n, luego trimEnd (quitar espacios/saltos finales)
  return pem.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

/**
 * Convierte PEM a base64 y valida que decodifique correctamente
 * @param {string} pem - Contenido PEM
 * @returns {{success: boolean, base64?: string, error?: string}}
 */
function pemToBase64(pem) {
  try {
    // Normalizar PEM original para comparación
    const normalizedOriginal = normalizePEM(pem);
    
    // Convertir PEM a base64
    const base64 = Buffer.from(pem, 'utf8').toString('base64');

    // Validar que el base64 sea una sola línea (sin saltos)
    if (base64.includes('\n') || base64.includes('\r')) {
      return {
        success: false,
        error: 'El base64 generado contiene saltos de línea. Debe ser una sola línea continua.'
      };
    }

    // Validar que el base64 decodificado sea correcto
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    
    // Verificar que decodifique a un PEM válido
    if (!decoded.startsWith('-----BEGIN')) {
      return {
        success: false,
        error: 'El base64 generado NO decodifica a un PEM válido.\n' +
               `El contenido decodificado no comienza con -----BEGIN\n` +
               `Contenido decodificado (primeros 100 chars): ${decoded.substring(0, 100)}`
      };
    }

    // Normalizar PEM decodificado para comparación
    const normalizedDecoded = normalizePEM(decoded);

    // Verificar que el PEM decodificado sea igual al original (después de normalizar)
    if (normalizedDecoded !== normalizedOriginal) {
      const originalPreview = normalizedOriginal.substring(0, 100);
      const decodedPreview = normalizedDecoded.substring(0, 100);
      return {
        success: false,
        error: 'El base64 generado NO decodifica correctamente.\n' +
               'El contenido decodificado difiere del PEM original después de normalizar.\n' +
               `Original (primeros 100 chars): ${originalPreview}\n` +
               `Decodificado (primeros 100 chars): ${decodedPreview}`
      };
    }

    return { success: true, base64 };
  } catch (error) {
    return {
      success: false,
      error: `Error convirtiendo a base64: ${error.message}`
    };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('🔐 Generador de Base64 para QZ_PRIVATE_KEY_B64\n');

  // Determinar archivo PEM a usar
  const pemPath = process.argv[2] || null;
  let targetFile = null;

  if (pemPath) {
    targetFile = path.isAbsolute(pemPath) ? pemPath : path.join(PROJECT_ROOT, pemPath);
  } else {
    // Buscar en candidatos
    for (const candidate of PEM_CANDIDATES) {
      if (fs.existsSync(candidate)) {
        targetFile = candidate;
        break;
      }
    }
  }

  if (!targetFile) {
    console.error('❌ No se encontró archivo PEM válido.');
    console.error('\n📋 Archivos buscados:');
    PEM_CANDIDATES.forEach(f => console.error(`   - ${f}`));
    console.error('\n💡 Soluciones:');
    console.error('   1. Especificar ruta: node scripts/generate-qz-private-key-b64.mjs ruta/al/archivo.pem');
    console.error('   2. Extraer desde .p12:');
    console.error('      openssl pkcs12 -in C:\\qz\\qz-certificate.p12 -nocerts -nodes -out qz-private-key.pem -passin pass:changeit');
    process.exit(1);
  }

  console.log(`📄 Leyendo archivo: ${targetFile}\n`);

  // Leer y validar PEM
  const pemResult = readAndValidatePEM(targetFile);
  
  if (!pemResult.success) {
    console.error('❌ Error validando PEM:');
    console.error(pemResult.error);
    process.exit(1);
  }

  console.log('✅ PEM válido detectado');
  console.log(`   Tipo: ${pemResult.type}`);
  console.log(`   Bloque detectado: ${pemResult.blockType}`);
  console.log(`   Longitud: ${pemResult.pem.length} caracteres`);
  console.log(`   Primeras líneas:`);
  pemResult.pem.split('\n').slice(0, 3).forEach(line => {
    console.log(`   ${line}`);
  });
  console.log('   ...');
  console.log(`   Últimas líneas:`);
  pemResult.pem.split('\n').slice(-3).forEach(line => {
    console.log(`   ${line}`);
  });
  console.log('');
  
  // Verificar que NO contenga "Bag Attributes" (doble verificación)
  if (pemResult.pem.includes('Bag Attributes') || pemResult.pem.includes('localKeyID')) {
    console.error('❌ VALIDACIÓN FALLIDA:');
    console.error('   El PEM extraído contiene metadata de PKCS12 (Bag Attributes)');
    console.error('   Esto no debería ocurrir si extractCleanPEM funcionó correctamente');
    process.exit(1);
  }

  // Convertir a base64
  const b64Result = pemToBase64(pemResult.pem);
  
  if (!b64Result.success) {
    console.error('❌ Error generando base64:');
    console.error(b64Result.error);
    process.exit(1);
  }

  // Validación final: decodificar y verificar
  const finalDecoded = Buffer.from(b64Result.base64, 'base64').toString('utf8');
  const normalizedFinal = normalizePEM(finalDecoded);
  const normalizedOriginal = normalizePEM(pemResult.pem);
  
  // CHECK: decoded starts with -----BEGIN PRIVATE KEY----- (o RSA)
  if (!normalizedFinal.startsWith('-----BEGIN')) {
    console.error('❌ VALIDACIÓN FINAL FALLIDA:');
    console.error('   CHECK decoded starts with: FALLÓ');
    console.error(`   Contenido decodificado (primeros 100 chars): ${normalizedFinal.substring(0, 100)}`);
    process.exit(1);
  }
  
  // Verificar que el tipo de BEGIN coincida
  const beginType = normalizedFinal.match(/-----BEGIN\s+([^-]+)\s+KEY-----/);
  if (beginType) {
    console.log(`   CHECK decoded starts with: -----BEGIN ${beginType[1]} KEY----- ✅`);
  }
  
  // Verificar que NO contenga "Bag Attributes" en el decodificado
  if (normalizedFinal.includes('Bag Attributes') || normalizedFinal.includes('localKeyID')) {
    console.error('❌ VALIDACIÓN FINAL FALLIDA:');
    console.error('   El base64 decodificado contiene "Bag Attributes" o "localKeyID"');
    console.error('   Esto indica que el base64 original incluía metadata');
    process.exit(1);
  }
  
  // Verificar round-trip (normalizado)
  if (normalizedFinal !== normalizedOriginal) {
    console.error('❌ VALIDACIÓN ROUND-TRIP FALLIDA:');
    console.error('   El PEM decodificado (normalizado) difiere del original (normalizado)');
    console.error(`   Original (primeros 100): ${normalizedOriginal.substring(0, 100)}`);
    console.error(`   Decodificado (primeros 100): ${normalizedFinal.substring(0, 100)}`);
    process.exit(1);
  }

  console.log('✅ Base64 generado y validado correctamente');
  console.log(`   Longitud base64: ${b64Result.base64.length} caracteres`);
  console.log(`   CHECK decoded starts with: -----BEGIN ✅`);
  console.log(`   CHECK sin "Bag Attributes": ✅`);
  console.log(`   CHECK round-trip (normalizado): ✅`);
  console.log(`   CHECK base64 es una sola línea: ${!b64Result.base64.includes('\n') && !b64Result.base64.includes('\r') ? '✅' : '❌'}\n`);

  console.log('📋 Copia este valor y pégalo en Supabase Secrets como QZ_PRIVATE_KEY_B64:\n');
  console.log('─'.repeat(80));
  console.log(b64Result.base64);
  console.log('─'.repeat(80));
  console.log('');

  console.log('📝 Pasos siguientes:');
  console.log('   1. Ir a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions');
  console.log('   2. Buscar o crear QZ_PRIVATE_KEY_B64 en Secrets');
  console.log('   3. Pegar el base64 de arriba (sin saltos de línea)');
  console.log('   4. Guardar');
  console.log('   5. Redeployar: supabase functions deploy qz-sign');
  console.log('');
}

main().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});

