# Instrucciones para Importar Clientes desde CSV

Hay **3 métodos** para importar clientes. Elige el que prefieras:

## Método 1: Script Node.js que genera SQL (RECOMENDADO)

Este método genera un archivo SQL que puedes ejecutar directamente en Supabase.

### Pasos:

1. **Abre la terminal** en la carpeta del proyecto

2. **Ejecuta el script:**
   ```bash
   node scripts/generate-customers-sql.js "C:\Users\gonzi\Downloads\Clientes3.csv" > import-customers.sql
   ```
   
   Ejemplo:
   ```bash
   node scripts/generate-customers-sql.js "Clientes3 - Clientes3.csv.csv" > import-customers.sql
   ```

3. **Abre el archivo generado** `import-customers.sql`

4. **Copia todo el contenido** y pégalo en Supabase SQL Editor

5. **Ejecuta el script** en Supabase

### Ventajas:
- ✅ No requiere autenticación
- ✅ Puedes revisar el SQL antes de ejecutarlo
- ✅ Funciona con cualquier formato de CSV
- ✅ Muestra errores claros

---

## Método 2: Interfaz Web (si funciona)

1. Ve a `http://localhost:5500/admin/import-customers.html`
2. Sube tu archivo CSV o pega los datos
3. Haz clic en "Analizar CSV"
4. Revisa el preview
5. Haz clic en "Importar Clientes"

### Si no funciona:
- Abre la consola del navegador (F12)
- Revisa los mensajes de error
- Comparte los errores para diagnosticar

---

## Método 3: Script Node.js con Supabase (requiere autenticación)

Este método se conecta directamente a Supabase pero requiere estar autenticado.

### Pasos:

1. **Instala la dependencia de Supabase:**
   ```bash
   npm install @supabase/supabase-js
   ```

2. **Asegúrate de tener configurado** `scripts/config.local.js` con tus credenciales

3. **Ejecuta el script:**
   ```bash
   node scripts/import-customers.js "ruta/a/tu/archivo.csv"
   ```

### Nota:
Este método requiere que estés autenticado como admin. Si no funciona, usa el Método 1.

---

## Formato del CSV

El CSV debe tener estas columnas (en orden A-E):

- **Columna A**: Nombre y apellido
- **Columna B**: Telefono
- **Columna C**: LOCALIDAD (ciudad)
- **Columna D**: PROVINCIA
- **Columna E**: Direccion

Ejemplo:
```csv
Nombre y apellido,Telefono,LOCALIDAD,PROVINCIA,Direccion
BARRAZA CLARA GABRIELA,3705025138,LAS LOMITAS,FORMOSA,B° EMISORA RUTA 81
CABALLERO MARIA ANA,3644234289,PRESIDENCIA ROQUE SAENZ PEÑA,CHACO,ANTONIO ZAFRA QUINT. 61
```

---

## Recomendación

**Usa el Método 1** (generar SQL) porque:
- Es el más confiable
- No depende del navegador
- Puedes revisar los datos antes de importar
- Funciona siempre

