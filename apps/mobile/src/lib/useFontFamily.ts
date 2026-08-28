// apps/mobile/src/lib/useFontFamily.ts
// manage font family through a React hook

const FONT_FAMILIES = {
  regular: 'DMSans-Regular',
  medium: 'DMSans-Medium',
  bold: 'DMSans-Bold',
} as const

// resolves a font family for APIs that require a style object or native prop.
// prefer Uniwind font classes when the target component accepts `className`.
export function useFontFamily(weight: keyof typeof FONT_FAMILIES): string
{
  return FONT_FAMILIES[weight]
}
