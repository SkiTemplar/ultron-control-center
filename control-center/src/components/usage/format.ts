// usage/format.ts — helpers de formato compartidos por Usage.tsx y StatParts.
// Extraídos LITERALES de Usage.tsx (2026-08-16, límite 800 líneas).
//
// 2026-10-18: la interfaz vuelve al español, así que las cifras van en es-ES.
// es-ES no agrupa por defecto los números de 4 cifras («1840» junto a
// «96.000»): `useGrouping: "always"` lo fuerza. La notación compacta de es-ES
// no tiene «mil millones» (1,06e9 sale «1060 M»), así que se compone a mano.
const GROUPING_ALWAYS = { useGrouping: "always" } as unknown as Intl.NumberFormatOptions;
const INT_FMT = new Intl.NumberFormat("es-ES", {
  ...GROUPING_ALWAYS,
  maximumFractionDigits: 0,
});
const DEC_FMT = new Intl.NumberFormat("es-ES", {
  ...GROUPING_ALWAYS,
  maximumFractionDigits: 1,
});

/** Enteros con separador de miles: 1.840 · 96.000. */
export function formatInt(n: number): string {
  return INT_FMT.format(n);
}

/** Tokens en notación compacta con 1 decimal: 11,4 mil · 48 M · 1,1 mil M. */
export function formatNum(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return formatInt(n);
  if (abs < 1_000_000) return `${DEC_FMT.format(n / 1_000)} mil`;
  if (abs < 1_000_000_000) return `${DEC_FMT.format(n / 1_000_000)} M`;
  return `${DEC_FMT.format(n / 1_000_000_000)} mil M`;
}

/** claude-opus-5-5 → «Opus 5.5»; claude-sonnet-4-5-20250929 → «Sonnet 4.5». */
export function shortModel(m: string): string {
  const name = m
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}
