import type { Db } from './client.js'

// Catálogo oficial de municipios (distritos) de Paraguay: 17 departamentos + Distrito Capital (Asunción) = 263.
// Fuente: listado de municipios de Paraguay (Wikipedia, «Anexo:Municipios de Paraguay»), verificado contra el total oficial de 263.
// El local puede agregar o desactivar ciudades desde el módulo Delivery; este catálogo solo agrega las que falten.
export const GEO: Record<string, string[]> = {
  'Capital': ['Asunción'],
  'Central': ['Areguá', 'Capiatá', 'Fernando de la Mora', 'Guarambaré', 'Itauguá', 'Itá', 'Julián Augusto Saldívar', 'Lambaré', 'Limpio', 'Luque', 'Mariano Roque Alonso', 'Nueva Italia', 'San Antonio', 'San Lorenzo', 'Villa Elisa', 'Villeta', 'Ypacaraí', 'Ypané', 'Ñemby'],
  'Concepción': ['Arroyito', 'Azotey', 'Belén', 'Concepción', 'Horqueta', 'Itacuá', 'Loreto', 'Paso Barreto', 'Paso Horqueta', 'San Alfredo', 'San Carlos del Apa', 'San Lázaro', 'Sargento José Félix López', 'Yby Yaú'],
  'San Pedro': ['Antequera', 'Capiibary', 'Choré', 'General Elizardo Aquino', 'General Isidoro Resquín', 'Guayaibí', 'Itacurubí del Rosario', 'Liberación', 'Lima', 'Nueva Germania', 'San Estanislao', 'San José del Rosario', 'San Pablo', 'San Pedro de Ycuamandiyú', 'San Vicente Pancholo', 'Santa Rosa del Aguaray', 'Tacuatí', 'Unión', 'Veinticinco de Diciembre', 'Villa del Rosario', 'Yataity del Norte', 'Yrybucuá'],
  'Cordillera': ['Altos', 'Arroyos y Esteros', 'Atyrá', 'Caacupé', 'Caraguatay', 'Emboscada', 'Eusebio Ayala', 'Isla Pucú', 'Itacurubí de la Cordillera', 'Juan de Mena', 'Loma Grande', 'Mbocayaty del Yhaguy', 'Nueva Colombia', 'Piribebuy', 'Primero de Marzo', 'San Bernardino', 'San José Obrero', 'Santa Elena', 'Tobatí', 'Valenzuela'],
  'Guairá': ['Borja', 'Capitán Mauricio José Troche', 'Coronel Martínez', 'Doctor Botrell', 'Félix Pérez Cardozo', 'General Eugenio Alejandrino Garay', 'Independencia', 'Itapé', 'Iturbe', 'José A. Fassardi', 'Mbocayaty del Guairá', 'Natalicio Talavera', 'Paso Yobái', 'San Salvador', 'Tebicuary', 'Villarrica', 'Yataity del Guairá', 'Ñumí'],
  'Caaguazú': ['Caaguazú', 'Carayaó', 'Coronel Oviedo', 'Doctor Cecilio Báez', 'Doctor Juan Eulogio Estigarribia', 'Doctor Juan Manuel Frutos', 'José Domingo Ocampos', 'La Pastora', 'Mariscal Francisco Solano López', 'Nueva Londres', 'Nueva Toledo', 'Raúl Arsenio Oviedo', 'Regimiento de Infantería Tres Corrales', 'Repatriación', 'San Joaquín', 'San José de los Arroyos', 'Santa Rosa del Mbutuy', 'Simón Bolívar', 'Tembiaporá', 'Tres de Febrero', 'Vaquería', 'Yhú'],
  'Caazapá': ['Abaí', 'Buena Vista', 'Caazapá', 'Doctor Moisés Santiago Bertoni', 'Fulgencio Yegros', 'General Higinio Morínigo', 'Maciel', 'San Juan Nepomuceno', 'Tavaí', 'Tres de Mayo', 'Yuty'],
  'Itapúa': ['Alto Verá', 'Bella Vista', 'Cambyretá', 'Capitán Meza', 'Capitán Miranda', 'Carlos Antonio López', 'Carmen del Paraná', 'Coronel José Félix Bogado', 'Edelira', 'Encarnación', 'Fram', 'General Artigas', 'General Delgado', 'Hohenau', 'Itapúa Poty', 'Jesús de Tavarangüé', 'José Leandro Oviedo', 'La Paz', 'Mayor Julio Dionisio Otaño', 'Natalio', 'Nueva Alborada', 'Obligado', 'Pirapó', 'San Cosme y Damián', 'San Juan del Paraná', 'San Pedro del Paraná', 'San Rafael del Paraná', 'Tomás Romero Pereira', 'Trinidad', 'Yatytay'],
  'Misiones': ['Ayolas', 'San Ignacio Guazú', 'San Juan Bautista', 'San Miguel', 'San Patricio', 'Santa María de Fe', 'Santa Rosa de Lima', 'Santiago', 'Villa Florida', 'Yabebyry'],
  'Paraguarí': ['Acahay', 'Caapucú', 'Carapeguá', 'Escobar', 'General Bernardino Caballero', 'La Colmena', 'María Antonia', 'Mbuyapey', 'Paraguarí', 'Pirayú', 'Quiindy', 'Quyquyhó', 'San Roque González de Santa Cruz', 'Sapucai', 'Tebicuarymí', 'Yaguarón', 'Ybycuí', 'Ybytymí'],
  'Alto Paraná': ['Ciudad del Este', 'Doctor Juan León Mallorquín', 'Doctor Raúl Peña', 'Domingo Martínez de Irala', 'Hernandarias', 'Iruña', 'Itakyry', 'Juan Emiliano O\'Leary', 'Los Cedrales', 'Mbaracayú', 'Minga Guazú', 'Minga Porá', 'Naranjal', 'Presidente Franco', 'San Alberto', 'San Cristóbal', 'Santa Fe del Paraná', 'Santa Rita', 'Santa Rosa del Monday', 'Tavapy', 'Yguazú', 'Ñacunday'],
  'Ñeembucú': ['Alberdi', 'Cerrito', 'Desmochados', 'General José Eduvigis Díaz', 'Guazú Cuá', 'Humaitá', 'Isla Umbú', 'Laureles', 'Mayor José Martínez', 'Paso de Patria', 'Pilar', 'San Juan Bautista de Ñeembucú', 'Tacuaras', 'Villa Franca', 'Villa Oliva', 'Villalbín'],
  'Amambay': ['Bella Vista Norte', 'Capitán Bado', 'Cerro Corá', 'Karapaí', 'Pedro Juan Caballero', 'Zanja Pytá'],
  'Canindeyú': ['Corpus Christi', 'Curuguaty', 'General Francisco Caballero Álvarez', 'Itanará', 'Katueté', 'La Paloma del Espíritu Santo', 'Laurel', 'Maracaná', 'Nueva Esperanza', 'Puerto Adela', 'Salto del Guairá', 'Villa Ygatimí', 'Yasy Cañy', 'Yby Pytá', 'Ybyrarobaná', 'Ypejhú'],
  'Presidente Hayes': ['Benjamín Aceval', 'Campo Aceval', 'General José María Bruguez', 'José Falcón', 'Nanawa', 'Nueva Asunción', 'Puerto Pinasco', 'Teniente Esteban Martínez', 'Teniente Primero Manuel Irala Fernández', 'Villa Hayes'],
  'Boquerón': ['Boquerón', 'Filadelfia', 'Loma Plata', 'Mariscal José Félix Estigarribia'],
  'Alto Paraguay': ['Bahía Negra', 'Capitán Carmelo Peralta', 'Fuerte Olimpo', 'Puerto Casado'],
}

// Nombres que el catálogo anterior tenía abreviados o incompletos: se renombran conservando el id (pedidos y direcciones guardadas no se pierden).
const RENAMES: [string, string, string][] = [
  ['Alto Paraguay', 'Carmelo Peralta', 'Capitán Carmelo Peralta'],
  ['Alto Paraná', 'Juan E. O\'Leary', 'Juan Emiliano O\'Leary'],
  ['Alto Paraná', 'Juan León Mallorquín', 'Doctor Juan León Mallorquín'],
  ['Boquerón', 'Mariscal Estigarribia', 'Mariscal José Félix Estigarribia'],
  ['Caaguazú', 'Mcal. Francisco Solano López', 'Mariscal Francisco Solano López'],
  ['Canindeyú', 'La Paloma', 'La Paloma del Espíritu Santo'],
  ['Central', 'J. Augusto Saldívar', 'Julián Augusto Saldívar'],
  ['Guairá', 'Colonia Independencia', 'Independencia'],
  ['Guairá', 'Mbocayaty', 'Mbocayaty del Guairá'],
  ['Itapúa', 'Jesús', 'Jesús de Tavarangüé'],
  ['Itapúa', 'Mayor Otaño', 'Mayor Julio Dionisio Otaño'],
  ['Misiones', 'San Ignacio', 'San Ignacio Guazú'],
  ['Misiones', 'Santa Rosa', 'Santa Rosa de Lima'],
  ['Ñeembucú', 'Mayor José J. Martínez', 'Mayor José Martínez'],
  ['Presidente Hayes', 'Pozo Colorado', 'General José María Bruguez'],
  ['San Pedro', 'General Resquín', 'General Isidoro Resquín'],
  ['San Pedro', 'San Pedro del Ycuamandiyú', 'San Pedro de Ycuamandiyú'],
]
// Localidades que no son municipios: se ocultan (no se borran, por si algún pedido las usó).
const HIDE: [string, string][] = [['Boquerón', 'Neu-Halbstadt']]

export async function syncGeo(db: Db) {
  const { rows: done } = await db.query("SELECT 1 FROM settings WHERE key = 'geo_catalog_v2'")
  if (done[0]) return
  for (const [dep, from, to] of RENAMES) {
    await db.query('UPDATE geo_cities SET name = $3 WHERE department = $1 AND name = $2 AND NOT EXISTS (SELECT 1 FROM geo_cities WHERE department = $1 AND name = $3)', [dep, from, to])
  }
  for (const [dep, names] of Object.entries(GEO)) {
    for (const name of names) await db.query('INSERT INTO geo_cities (department, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [dep, name])
  }
  for (const [dep, name] of HIDE) await db.query('UPDATE geo_cities SET active = false WHERE department = $1 AND name = $2', [dep, name])
  await db.query("INSERT INTO settings (key, value) VALUES ('geo_catalog_v2', '{\"total\": 263}'::jsonb) ON CONFLICT (key) DO NOTHING")
}
