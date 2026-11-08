import argon2 from 'argon2';

const options = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
let dummyHash: Promise<string> | undefined;
export function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 128) throw new Error('Hasło musi mieć od 12 do 128 znaków.');
  return argon2.hash(password, options);
}
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  dummyHash ??= argon2.hash('dummy-account-password-not-a-real-user', options);
  const candidate = hash ?? await dummyHash;
  try { return await argon2.verify(candidate, password) && hash !== null; }
  catch { return false; }
}
