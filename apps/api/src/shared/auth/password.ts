import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const keyLength = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derivedKey = (await scrypt(password, salt, keyLength)) as Buffer

  return `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, encodedSalt, encodedKey] = storedHash.split('$')
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedKey) return false

  try {
    const salt = Buffer.from(encodedSalt, 'base64url')
    const expectedKey = Buffer.from(encodedKey, 'base64url')
    const actualKey = (await scrypt(password, salt, expectedKey.length)) as Buffer

    return expectedKey.length === actualKey.length && timingSafeEqual(expectedKey, actualKey)
  } catch {
    return false
  }
}
