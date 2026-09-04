/**
 * Asignación de transporte por provincia y localidad.
 * Transportes: SEDE, Expreso Norte, Credifin, Transporte Snaider, Via Cargo, Correo Argentino, Retiro de Local, MyM (solo Corrientes Capital).
 */
import { viaCargoLocalities } from "./data/via-cargo-localidades.js?v=m260607";
import { snaiderLocalities } from "./data/snaider-localidades.js?v=m260607";
import { canonicalizeTransportName } from "../scripts/transport-canonical.js?v=m260607";

/** Via Cargo y Transporte Snaider: listados generados con scripts/import-viacargo-xlsx.mjs e import-snaider-xlsx.mjs */

const retiro_del_local = [
  { provincia: "Chaco", localidad: "Resistencia", transporte: "Retiro de Local" },
  { provincia: "Chaco", localidad: "Barranqueras", transporte: "Retiro de Local" },
  { provincia: "Chaco", localidad: "Fontana", transporte: "Retiro de Local" },
  { provincia: "Chaco", localidad: "Margarita Belén", transporte: "Retiro de Local" },
  { provincia: "Chaco", localidad: "Colonia Benítez", transporte: "Retiro de Local" },
  { provincia: "Corrientes", localidad: "Corrientes", transporte: "Retiro de Local" },
];

// Expreso Norte — Corrientes (si también hay SEDE en destinos_transporte, SEDE va primero en la lista)
const expreso_norte = [
  { provincia: "Corrientes", localidad: "Empedrado", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "San Lorenzo", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Saladas", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Bella Vista", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Santa Lucía", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Lavalle", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Monte Caseros", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Esquina", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "9 de Julio", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "San Roque", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Chavarría", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Paso de los Libres", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Mercedes", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Mariano I. Loza", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Curuzú Cuatiá", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Goya", transporte: "Expreso Norte" },
  { provincia: "Corrientes", localidad: "Felipe Yofre", transporte: "Expreso Norte" },
];

// Credifin — por provincia y lista de localidades (se aplana a array para la búsqueda)
const CREDIFIN_PROVINCIAS = {
  "Buenos Aires": [
    "11 de Septiembre", "Abasto", "Acassuso", "Adrogue", "Aldo Bonzi", "Alejandro Korn", "Almirante Brown", "Arana", "Arrecifes", "Arturo Segui", "Avellaneda", "Azul", "Bahia Blanca", "Banfield", "Baradero", "Barrio San Jose", "Beccar", "Belen de Escobar", "Bella Vista", "Benavidez", "Berazategui", "Berisso", "Bernal", "Bosques", "Boulogne Sur Mer", "Burzaco", "Cabildo", "Campana", "Canning", "Capital Federal", "Carapachay", "Carlos Keen", "Carlos Spegazzini", "Carmen de Areco", "Caseros", "Castelar", "Chilavert", "Chivilcoy", "Churruca", "City Bell", "Ciudadela", "Ciudad Jardin", "Claypole", "Cortines", "Crucecita", "Cruce de Florencio Varela", "Del Viso", "Dock Sud", "Don Bosco", "Don Orione", "Don Torcuato", "El Jaguel", "El Libertador", "El Palomar", "El Pato", "El Talar", "Ensenada", "Escobar", "Ezeiza", "Ezpeleta", "Fatima", "Florencio Varela", "Florida Este", "Florida Oeste", "Francisco Alvarez", "Garin", "General Rodriguez", "Gerli", "Gernica", "Glew", "Gonnet", "Gorina", "General Daniel Cerri", "General Pacheco", "Grand Bourg", "Guillermo Hudson", "Gutierrez", "Haedo", "Hurlingham", "Ingeniero Maschwitz", "Ingeniero White", "Isidro Casanova", "Ituzaingo", "Jauregui", "Jose C Paz", "Jose Ingenieros", "Jose Leon Suarez", "Jose Marmol", "Junin", "La Emilia", "La Lonja", "La Lucila", "La Plata", "La Reja", "La Union", "Lanus", "Lavallol", "Lima", "Lisandro Olmos", "Loma Hermosa", "Loma Verde", "Lomas de Zamora", "Lomas del Mirador", "Longchamps", "Los Hornos", "Los Polvorines", "Los Troncos del Talar", "Luis Guillon", "Lujan", "Malaver", "Manuel Alberti", "Manzanares", "Mar del Plata", "Martin Coronado", "Martinez", "Matheu", "Melchor Romero", "Mercedes", "Merlo", "Miguelete", "Ministro Rivadavia", "Monte Chingolo", "Monte Grande", "Moreno", "Moron", "Munro", "Muñiz", "Olavarria", "Olivera", "Olivos", "Open Door", "Pablo Nogues", "Paso del Rey", "Pablo Podesta", "Pereyra", "Pergamino", "Pilar", "Piñeyro", "Platanos", "Presidente Derqui", "Punta Alta", "Punta Lara", "Quilmes", "Remedios de Escalada", "Rafael Calzada", "Ramallo", "Ramos Mejia", "Ranelagh", "Ricardo Rojas", "Rincon de Milberg", "Saenz Peña", "Salto", "San Andres", "San Andres de Giles", "San Antonio de Areco", "San Antonio de Padua", "San Fernando", "San Francisco Solano", "San Isidro", "San Justo", "San Martin", "San Miguel", "San Nicolas", "San Pedro", "San Vicente", "Santos Lugares", "Sarandi", "Sourigues", "Tablada", "Tandil", "Tapiales", "Temperley", "Tigre", "Tolosa", "Tortuguitas", "Tres Arroyos", "Tristan Suarez", "Turdera", "Valentin Alsina", "Vicente Lopez", "Victoria", "Villa Adelina", "Villa Ballester", "Villa Bosch", "Villa Celina", "Villa Dominico", "Villa Elisa", "Villa España", "Villa Insuperable", "Villa La Florida", "Villa Luzuriaga", "Villa Lynch", "Villa Madero", "Villa Maipu", "Villa Martelli", "Villa Raffo", "Villa Ramallo", "Villa Rosa", "Villa Santos Tesei", "Villa Sarmiento", "Virreyes", "Wilde", "Zarate",
  ],
  "Chaco": [
    "Barranqueras", "Charata", "Colonias Unidas", "Coronel Du Graty", "Corzuela", "Fontana", "General Jose de San Martin", "General Pinedo", "Hermoso Campo", "Las Breñas", "Machagai", "Presidencia Roque Saenz Peña", "Puerto Tirol", "Puerto Vilelas", "Quitilipi", "Resistencia", "Santa Sylvina", "Villa Angela", "Gancedo",
  ],
  "Corrientes": [
    "Corrientes", "Colonia Carolina", "Goya", "Lavalle", "Santa Lucia", "Paso de los Libres",
  ],
  "Formosa": [
    "Formosa", "Clorinda", "El Colorado", "Ibarreta", "Laguna Naineck", "Laguna Blanca", "Espinillo", "General Belgrano", "Pirane", "Villa 213",
  ],
  "Entre Ríos": [
    "Colon", "Concepcion del Uruguay", "Concordia", "Crespo", "Diamante", "General Ramirez", "Gualeguaychu", "Parana", "San Jose", "Villa Elisa",
  ],
  "Córdoba": [
    "Alta Gracia", "Arroyito", "Bell Ville", "Cordoba", "General Deheza", "Jesus Maria", "La Carlota", "La Falda", "Las Varillas", "Marcos Juarez", "Monte Cristo", "Morteros", "Oncativo", "Rio Cuarto", "Rio Primero", "Rio Segundo", "Rio Tercero", "San Francisco", "Villa Allende", "Villa Carlos Paz", "Villa General Belgrano", "Villa Maria",
  ],
  "Santa Fe": [
    "Avellaneda", "Calchaqui", "Cañada de Gomez", "Casilda", "Ceres", "Chabas", "El Trebol", "Esperanza", "Firmat", "Franck", "Granadero Baigorria", "Las Toscas", "Rafaela", "Reconquista", "Rosario", "San Jorge", "San Justo", "San Lorenzo", "Santa Fe", "Santo Tome", "Sunchales", "Tostado", "Venado Tuerto", "Vera", "Villa Constitucion", "Villa Gobernador Galvez",
  ],
  "Santiago del Estero": [
    "Bandera", "Juries", "La Banda", "Quimili", "Santiago del Estero",
  ],
  "Tucumán": [
    "Alderetes", "Banda del Rio Sali", "Cevil Redondo", "El Manantial", "Las Talitas", "Lastenia", "Los Pocitos", "San Andres", "San Pablo", "Tafi Viejo", "Villa Carmela", "Yerba Buena", "San Miguel de Tucuman",
  ],
  "Misiones": [
    "Posadas",
  ],
  "Mendoza": [
    "Godoy Cruz", "Guaymallen", "Las Heras", "Lujan de Cuyo", "Maipu", "Palmira", "San Rafael", "Tunuyan",
  ],
  "San Juan": [
    "San Juan", "Pocito", "Santa Lucia",
  ],
  "San Luis": [
    "San Luis",
  ],
  "La Rioja": [
    "La Rioja",
  ],
};

const credifin = [];
for (const [provincia, localidades] of Object.entries(CREDIFIN_PROVINCIAS)) {
  for (const localidad of localidades) {
    credifin.push({ provincia, localidad, transporte: "Credifin" });
  }
}

/** Listado completo generado desde Excel: scripts/import-viacargo-xlsx.mjs */
const via_cargo = viaCargoLocalities;

/** Listado Transporte Snaider: scripts/import-snaider-xlsx.mjs */
const snaider_cobertura = snaiderLocalities;

// MyM — por ahora solo cubre Corrientes Capital.
const mym_cobertura = [
  { provincia: "Corrientes", localidad: "Corrientes", transporte: "MyM" },
];

const destinos_transporte = [
  { provincia: "Chaco", localidad: "Presidencia Roque Sáenz Peña", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Juan José Castelli", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Miraflores", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Río Bermejo", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Hermoso Campo", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Quimilí", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "San Bernardo", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "La Tigra", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "La Clotilde", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Charata", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Villa Ángela", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Las Breñas", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Corzuela", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Campo Largo", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Tres Isletas", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Gancedo", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "General San Martín", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Pampa del Infierno", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Concepción del Bermejo", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Los Frentones", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Napenay", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Avia Terai", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Villa Berthet", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Santa Sylvina", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Coronel Du Graty", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Machagai", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Quitilipi", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "Makallé", transporte: "SEDE" },
  { provincia: "Chaco", localidad: "La Verde", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Formosa", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "General Mansilla", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "San Martín II", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Clorinda", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Niclis", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Ingeniero Juárez", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Pozo del Tigre", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Pirané", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Las Lomitas", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Ibarreta", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "El Colorado", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Palo Santo", transporte: "SEDE" },
  { provincia: "Formosa", localidad: "Comandante Fontana", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Mercedes", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Mariano I. Loza", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Chavarría", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Felipe Yofre", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Alvear", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "La Cruz", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Yapeyú", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "San Roque", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "9 de Julio", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Paso de los Libres", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Curuzú Cuatiá", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Monte Caseros", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Esquina", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Santa Lucía", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Bella Vista", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Saladas", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Goya", transporte: "SEDE" },
  { provincia: "Corrientes", localidad: "Lavalle", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Apóstoles", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Oberá", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "San Vicente", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "2 de Mayo", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Aristóbulo del Valle", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Leandro N. Alem", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Montecarlo", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Jardín América", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Puerto Rico", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Puerto Iguazú", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Wanda", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Comandante Andresito", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Eldorado", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "San Pedro", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Puerto Esperanza", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Capioví", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "San Javier", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Candelaria", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Bernardo de Irigoyen", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "El Soberbio", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "San Ignacio", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Santa Ana", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Gobernador Roca", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "San Antonio", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Campo Viera", transporte: "SEDE" },
  { provincia: "Misiones", localidad: "Campo Grande", transporte: "SEDE" },
];

function normalize(str) {
  if (typeof str !== "string") return "";
  return str
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\u0301/g, "")
    .replace(/\u0300/g, "")
    .replace(/[\u0300-\u036f]/g, "");
}

function matchTransporte(lista, p, l) {
  return lista.find(
    (item) => normalize(item.provincia) === p && normalize(item.localidad) === l
  );
}

function canonicalizeTransportList(values) {
  const unique = [];
  const seen = new Set();
  for (const value of values || []) {
    const canonical = canonicalizeTransportName(value);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(canonical);
  }
  return unique;
}

/** Corrientes Capital: solo Retira local + MyM (no Credifin / Snaider / Via Cargo / Correo). */
function isCorrientesCapital(p, l) {
  return p === "corrientes" && (l === "corrientes" || l === "corrientes capital");
}

/**
 * Transportes para (provincia, localidad).
 * - Si la localidad está en destinos_transporte (cobertura SEDE), solo se envía por SEDE: no se mezclan otros transportes.
 * - Corrientes Capital: solo Retira local + MyM.
 * - Orden fijo en el resto: Retiro → Expreso → Credifin → Transporte Snaider → Via Cargo → Correo Argentino.
 * - Si no hay SEDE en las opciones, se agrega Correo Argentino como alternativa para que el cliente pueda elegir (p. ej. Credifin + Correo).
 */
export function getTransportesDisponibles(provincia, localidad) {
  const p = normalize(provincia);
  const l = normalize(localidad);
  if (!p || !l) return [];

  const sedeRule = matchTransporte(destinos_transporte, p, l);
  if (sedeRule) {
    return ["SEDE"];
  }

  // Corrientes Capital: aunque Credifin/Snaider/Via Cargo listan la ciudad, no aplican acá.
  if (isCorrientesCapital(p, l)) {
    return canonicalizeTransportList(["Retira local", "MyM"]);
  }

  const retiro = matchTransporte(retiro_del_local, p, l);
  const expreso = matchTransporte(expreso_norte, p, l);
  const credifinMatch = matchTransporte(credifin, p, l);
  const snaider = matchTransporte(snaider_cobertura, p, l);
  const via = matchTransporte(via_cargo, p, l);
  const mym = matchTransporte(mym_cobertura, p, l);

  const opciones = [];
  if (retiro) opciones.push(canonicalizeTransportName(retiro.transporte));
  if (expreso) opciones.push(canonicalizeTransportName(expreso.transporte));
  if (credifinMatch) opciones.push(canonicalizeTransportName(credifinMatch.transporte));
  const snaiderName = canonicalizeTransportName(snaider?.transporte);
  if (snaiderName && !opciones.includes(snaiderName)) {
    opciones.push(snaiderName);
  }
  const viaName = canonicalizeTransportName(via?.transporte);
  if (viaName && !opciones.includes(viaName)) {
    opciones.push(viaName);
  }
  const mymName = canonicalizeTransportName(mym?.transporte);
  if (mymName && !opciones.includes(mymName)) {
    opciones.push(mymName);
  }
  if (opciones.length === 0) opciones.push("Correo Argentino");

  const canonicalOptions = canonicalizeTransportList(opciones);
  const incluyeSede = canonicalOptions.includes("SEDE");
  if (
    !incluyeSede &&
    canonicalOptions.length > 0 &&
    !canonicalOptions.includes("Correo Argentino")
  ) {
    canonicalOptions.push("Correo Argentino");
  }
  return canonicalOptions;
}

const STORAGE_KEY_PREFIX = "fyl_transporte_";

function getStorageKey(provincia, localidad) {
  return STORAGE_KEY_PREFIX + normalize(provincia) + "_" + normalize(localidad);
}

/** Devuelve el transporte efectivo: el elegido por el cliente si guardó uno y sigue disponible; si no, el primero disponible. */
export function getTransporte(provincia, localidad) {
  const opciones = getTransportesDisponibles(provincia, localidad);
  if (opciones.length === 0) return "—";
  if (typeof localStorage !== "undefined") {
    const key = getStorageKey(provincia, localidad);
    const guardado = canonicalizeTransportName(localStorage.getItem(key));
    if (guardado && opciones.includes(guardado)) return guardado;
  }
  return opciones[0];
}

/** Guarda la elección del cliente para (provincia, localidad). */
export function guardarTransporteElegido(provincia, localidad, transporte) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    getStorageKey(provincia, localidad),
    canonicalizeTransportName(transporte)
  );
}
