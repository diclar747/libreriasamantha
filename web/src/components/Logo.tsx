/** Isotipo de Librería Samantha: libro abierto con una chispa de luz sobre el amanecer. */
export function LogoMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img className={'logo-mark ' + className} src="/logo-mark.svg" width={size} height={size} alt="" decoding="async" />
}
