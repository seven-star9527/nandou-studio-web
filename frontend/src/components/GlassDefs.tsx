/** Distorts highlights only. Text, controls and product pixels never pass through this filter. */
export default function GlassDefs() {
  return <svg className="glass-defs" width="0" height="0" aria-hidden focusable="false"><defs>
    <filter id="nandou-glass-rim" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency=".012 .018" numOctaves="2" seed="7" result="grain" />
      <feGaussianBlur in="grain" stdDeviation="2" result="soft" />
      <feDisplacementMap in="SourceGraphic" in2="soft" scale="7" xChannelSelector="R" yChannelSelector="G" />
    </filter>
  </defs></svg>;
}
