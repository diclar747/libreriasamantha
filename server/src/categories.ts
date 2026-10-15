// Categorías de la librería, en el orden en que se muestran en la tienda y en los formularios.
// Una categoría nueva escrita en un producto también funciona: aparece después de estas.
export const STORE_CATEGORIES = [
  'Biblias', 'Devocionales', 'Niños', 'Adolescentes', 'Jóvenes', 'Mujeres', 'Hombres', 'Matrimonios',
  'Agendas', 'Libros', 'Regalos', 'Útiles escolares', 'Oficina',
]

const rank = (name: string) => { const i = STORE_CATEGORIES.indexOf(name); return i < 0 ? STORE_CATEGORIES.length : i }

/** Ordena por la lista fija; las categorías que no están en ella van al final, por orden alfabético. */
export function sortCategories<T>(rows: T[], name: (r: T) => string): T[] {
  return [...rows].sort((a, b) => rank(name(a)) - rank(name(b)) || name(a).localeCompare(name(b), 'es'))
}

/** Lista fija + las categorías que ya usan los productos. */
export function allCategories(used: string[]): string[] {
  return sortCategories([...new Set([...STORE_CATEGORIES, ...used.filter(Boolean)])], (s) => s)
}
