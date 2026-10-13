import type { Db } from './client.js'

// Departamentos y distritos principales de Paraguay. El local puede activar/desactivar ciudades y fijar su tarifa.
export const GEO: Record<string, string[]> = {
  'Capital': ['Asunción'],
  'Central': ['Areguá', 'Capiatá', 'Fernando de la Mora', 'Guarambaré', 'Itá', 'Itauguá', 'J. Augusto Saldívar', 'Lambaré', 'Limpio', 'Luque', 'Mariano Roque Alonso', 'Ñemby', 'Nueva Italia', 'San Antonio', 'San Lorenzo', 'Villa Elisa', 'Villeta', 'Ypacaraí', 'Ypané'],
  'Concepción': ['Concepción', 'Horqueta', 'Loreto', 'Belén', 'Yby Yaú', 'Azotey', 'Sargento José Félix López'],
  'San Pedro': ['San Pedro del Ycuamandiyú', 'Santa Rosa del Aguaray', 'Choré', 'General Resquín', 'Lima', 'San Estanislao', 'Capiibary', 'Liberación'],
  'Cordillera': ['Caacupé', 'Altos', 'Atyrá', 'Eusebio Ayala', 'Piribebuy', 'Tobatí', 'Valenzuela', 'Caraguatay', 'San Bernardino', 'Isla Pucú'],
  'Guairá': ['Villarrica', 'Colonia Independencia', 'Mbocayaty', 'Iturbe', 'Paso Yobái', 'Capitán Mauricio José Troche'],
  'Caaguazú': ['Coronel Oviedo', 'Caaguazú', 'Repatriación', 'Doctor Juan Eulogio Estigarribia', 'Yhú', 'San José de los Arroyos', 'Carayaó', 'Mcal. Francisco Solano López'],
  'Caazapá': ['Caazapá', 'Yuty', 'San Juan Nepomuceno', 'Abaí', 'Tavaí', 'Buena Vista'],
  'Itapúa': ['Encarnación', 'Cambyretá', 'Capitán Miranda', 'Fram', 'Hohenau', 'Obligado', 'Bella Vista', 'San Juan del Paraná', 'Natalio', 'Pirapó', 'Jesús', 'Trinidad', 'Mayor Otaño', 'Carlos Antonio López'],
  'Misiones': ['San Juan Bautista', 'Ayolas', 'San Ignacio', 'Santa Rosa', 'San Patricio', 'Santiago', 'Villa Florida'],
  'Paraguarí': ['Paraguarí', 'Carapeguá', 'Yaguarón', 'Quiindy', 'Acahay', 'Sapucai', 'Pirayú', 'Ybycuí', 'La Colmena'],
  'Alto Paraná': ['Ciudad del Este', 'Presidente Franco', 'Hernandarias', 'Minga Guazú', 'Santa Rita', 'Juan León Mallorquín', 'Los Cedrales', 'Naranjal', 'Santa Rosa del Monday', 'Juan E. O\'Leary', 'Yguazú'],
  'Ñeembucú': ['Pilar', 'Alberdi', 'Humaitá', 'Villa Franca', 'Mayor José J. Martínez'],
  'Amambay': ['Pedro Juan Caballero', 'Capitán Bado', 'Bella Vista Norte', 'Zanja Pytá'],
  'Canindeyú': ['Salto del Guairá', 'Curuguaty', 'Katueté', 'Villa Ygatimí', 'Ypejhú', 'La Paloma', 'Corpus Christi'],
  'Presidente Hayes': ['Villa Hayes', 'Benjamín Aceval', 'Nanawa', 'Pozo Colorado', 'Puerto Pinasco', 'José Falcón'],
  'Boquerón': ['Filadelfia', 'Loma Plata', 'Mariscal Estigarribia', 'Neu-Halbstadt'],
  'Alto Paraguay': ['Fuerte Olimpo', 'Bahía Negra', 'Carmelo Peralta', 'Puerto Casado'],
}

// Zona donde el local reparte por defecto: Asunción y el área metropolitana, con la tarifa base.
export const DEFAULT_COVERED = ['Asunción', 'Fernando de la Mora', 'Lambaré', 'Luque', 'San Lorenzo', 'Capiatá', 'Ñemby', 'Mariano Roque Alonso', 'Limpio', 'Villa Elisa']

export async function seedGeo(db: Db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM geo_cities')
  if (rows[0].n > 0) return
  for (const [dep, cities] of Object.entries(GEO)) {
    for (const name of cities) {
      const { rows: c } = await db.query('INSERT INTO geo_cities (department, name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [dep, name])
      if (c[0] && DEFAULT_COVERED.includes(name)) await db.query('INSERT INTO delivery_rates (city_id, covered) VALUES ($1, true) ON CONFLICT DO NOTHING', [c[0].id])
    }
  }
}
