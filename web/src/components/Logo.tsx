/** Marca de Samantha: la S dorada sobre verde (ícono), el nombre con el libro abierto y el logo completo con el lema. */
export function LogoMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img className={'logo-mark ' + className} src="/icons/samantha-192-v2.png" width={size} height={size} alt="" decoding="async" />
}
/** SAMANTHA en letras doradas con el libro abierto. */
export function LogoWord({ height = 64, className = '' }: { height?: number; className?: string }) {
  return <img className={'logo-word ' + className} src="/brand/samantha-wordmark.png" height={height} alt="Samantha — Libros y regalos" decoding="async" style={{ height, width: 'auto' }} />
}
/** Logo completo: nombre, libro, «Libros y regalos» y el lema. */
export function LogoLockup({ width = 260, className = '' }: { width?: number; className?: string }) {
  return <img className={'logo-lockup ' + className} src="/brand/samantha-lockup.png" width={width} alt="Samantha — Libros y regalos. Historias que transforman vidas" decoding="async" style={{ width, height: 'auto' }} />
}
