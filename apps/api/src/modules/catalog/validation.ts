export const maxImageBytes = 5_242_880

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])

const extensionsByMime: Record<string, Set<string>> = {
  'image/jpeg': new Set(['jpg', 'jpeg']),
  'image/png': new Set(['png']),
  'image/webp': new Set(['webp']),
}

export type ImageValidationCode =
  | 'IMAGE_TYPE_NOT_SUPPORTED'
  | 'IMAGE_EXTENSION_MISMATCH'
  | 'IMAGE_CONTENT_INVALID'
  | 'IMAGE_EMPTY'
  | 'IMAGE_TOO_LARGE'

export type ImageValidation = { ok: true; mimeType: string } | { ok: false; code: ImageValidationCode }

export function sniffImageMime(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

export function validateImage(input: { bytes: Buffer; declaredMimeType: string; fileName: string }): ImageValidation {
  const { bytes, declaredMimeType, fileName } = input
  if (!allowedMimeTypes.has(declaredMimeType)) {
    return { ok: false, code: 'IMAGE_TYPE_NOT_SUPPORTED' }
  }
  if (bytes.length === 0) {
    return { ok: false, code: 'IMAGE_EMPTY' }
  }
  if (bytes.length > maxImageBytes) {
    return { ok: false, code: 'IMAGE_TOO_LARGE' }
  }
  const extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  if (extension === '' || !extensionsByMime[declaredMimeType]?.has(extension)) {
    return { ok: false, code: 'IMAGE_EXTENSION_MISMATCH' }
  }
  if (sniffImageMime(bytes) !== declaredMimeType) {
    return { ok: false, code: 'IMAGE_CONTENT_INVALID' }
  }
  return { ok: true, mimeType: declaredMimeType }
}

/** Nome seguro para Content-Disposition: sem aspas, quebras ou traversal. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w .()-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
    .trim()
  return cleaned === '' ? 'imagem' : cleaned
}
