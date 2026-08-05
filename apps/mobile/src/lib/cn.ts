// apps/mobile/src/lib/cn.ts
// merge conditional mobile class names

import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[])
{
  return twMerge(clsx(inputs))
}
