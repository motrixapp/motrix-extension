export type {
  MediaFormatEntry,
  MediaFormatsParams,
  MediaFormatsResult,
} from '@motrix/mdxp'

/** The only quality tokens the desktop parser accepts from a submit. */
export const QUALITY_LABEL_PATTERN = /^(auto|\d{3,4}p|mp3)$/i

/** `meta.qualityLabel` vocabulary for a quality-picker submit. */
export type QualityLabel = 'auto' | 'mp3' | `${number}p`

/** Validate + lowercase a client-supplied label; anything else → 'auto'. */
export function normalizeQualityLabel(value: unknown): QualityLabel {
  if (typeof value !== 'string') return 'auto'
  const trimmed = value.trim().toLowerCase()
  return QUALITY_LABEL_PATTERN.test(trimmed)
    ? (trimmed as QualityLabel)
    : 'auto'
}
