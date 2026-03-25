# Provincias y localidades de Argentina — Fuentes de datos

Para asignar **Correo Argentino** y **Via Cargo** (y otros transportes) por provincia y localidad se necesitan listas de referencia. Estos repositorios en GitHub ofrecen datos abiertos en JSON.

---

## Repositorios recomendados

### 1. **Wolox/arg-localities** (más completo)

- **URL:** https://github.com/Wolox/arg-localities  
- **Formato:** JSON por provincia y un archivo global con todas las localidades.  
- **Estructura:** Cada provincia tiene un array `localities` con objetos `{ id, name, cp }` (código postal).  
- **Archivos útiles:**
  - `arg-localities.json` — Todas las provincias y localidades en un solo JSON (~2 MB).  
  - `by-province/BuenosAires.json`, `by-province/Salta.json`, etc. — Un JSON por provincia.  
- **Uso:** Ideal para cobertura máxima (miles de localidades con CP).  
- **Raw (ejemplo):**  
  `https://raw.githubusercontent.com/Wolox/arg-localities/master/arg-localities.json`

### 2. **zokeber/argentina-json** (compacto, por provincia)

- **URL:** https://github.com/zokeber/argentina-json  
- **Formato:** Un array de provincias, cada una con `provincia`, `capital` y `localidad` (array de strings).  
- **Estructura:** `[{ "provincia": "Salta", "capital": "Salta", "localidad": ["Salta", "Cafayate", ...] }, ...]`  
- **Tamaño:** ~40 KB.  
- **Uso:** Bueno para listas por provincia sin códigos postales.  
- **Raw:**  
  `https://raw.githubusercontent.com/zokeber/argentina-json/master/argentina.json`

### 3. **neousr/localidades-cpa**

- **URL:** https://github.com/neousr/localidades-cpa  
- **Formato:** Base SQLite (`db/db.db`) y scripts PHP.  
- **Uso:** Si preferís consultar por base de datos en lugar de JSON.

### 4. **juanifioren/argentina-states-cities**

- **URL:** https://github.com/juanifioren/argentina-states-cities  
- **Formato:** `argentina_states.json`, `argentina_localities.json` con códigos Alfa-3.  
- **Uso:** Útil si necesitás códigos de estado/ciudad estandarizados.

### 5. **lbanchio/localidades_argentinas**

- **URL:** https://github.com/lbanchio/localidades_argentinas  
- **Formato:** Base de datos con localidades agrupadas en departamentos y provincias.  
- **Uso:** Referencia alternativa de cobertura nacional.

---

## Uso en este proyecto

- **Correo Argentino:** En `client/transportes-data.js` todo destino que no esté en Retiro de Local, Expreso Norte, Credifin, SEDE ni Via Cargo se considera **Correo Argentino** por defecto. No hace falta listar todas las localidades.  
- **Via Cargo:** En `transportes-data.js` existe el array `via_cargo`. Cuando tengas la lista de (provincia, localidad) para Via Cargo, se puede cargar ahí (o desde un JSON generado a partir de uno de los repos de arriba).  
- **Datos de referencia:** El script `scripts/fetch-argentina-localidades.mjs` descarga el JSON de **zokeber/argentina-json**, lo aplana a `{ provincia, localidad }` y guarda `client/data/argentina-localidades.json`. Podés usar ese archivo para:
  - Validar provincia/localidad en el perfil, o  
  - Armar listas para Via Cargo o Correo Argentino y pegarlas en `transportes-data.js`.

---

## Cómo generar la lista de referencia local

Desde la raíz del proyecto:

```bash
node scripts/fetch-argentina-localidades.mjs
```

Se crea (o actualiza) `client/data/argentina-localidades.json` con un array de `{ provincia, localidad }` para todas las entradas del dataset de zokeber.
