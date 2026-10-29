import { randomInt } from 'node:crypto';

const DEFAULT_PASSWORD_LENGTH = 16;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 30;
const CHARACTER_SETS = {
  uppercase: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lowercase: 'abcdefghijkmnopqrstuvwxyz',
  numbers: '23456789',
  special: '!@#$%^&*()-_=+[]{}:,.?',
} as const;

function pickRandomCharacter(characters: string) {
  return characters[randomInt(0, characters.length)];
}

function shuffleCharacters(value: string[]) {
  for (let index = value.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index + 1);
    const current = value[index];

    value[index] = value[swapIndex];
    value[swapIndex] = current;
  }

  return value;
}

function normalizePasswordLength(length: number) {
  if (!Number.isFinite(length)) {
    return DEFAULT_PASSWORD_LENGTH;
  }

  return Math.trunc(length);
}

function generatePassword(length: number, special: string, minimumLength: number) {
  const normalizedLength = Math.min(
    Math.max(normalizePasswordLength(length), minimumLength),
    MAX_PASSWORD_LENGTH,
  );
  const requiredSets = [CHARACTER_SETS.uppercase, CHARACTER_SETS.lowercase, CHARACTER_SETS.numbers];
  const allCharacters = [...requiredSets, special].join('');
  const passwordCharacters = requiredSets.map((characters) => pickRandomCharacter(characters));

  while (passwordCharacters.length < normalizedLength) {
    passwordCharacters.push(pickRandomCharacter(allCharacters));
  }

  return shuffleCharacters(passwordCharacters).join('');
}

export function generateAliyunEcsPassword(length = DEFAULT_PASSWORD_LENGTH) {
  return generatePassword(length, CHARACTER_SETS.special, MIN_PASSWORD_LENGTH);
}

/** Generated Tencent defaults satisfy both Linux and Windows RunInstances policies. */
export function generateCloudInstancePassword(provider: 'alibaba_cloud' | 'tencent_cloud', length = DEFAULT_PASSWORD_LENGTH) {
  if (provider === 'alibaba_cloud') return generateAliyunEcsPassword(length);
  // LoginSettings excludes underscore/angle brackets even though the console guide lists them.
  let password: string;
  do { password = generatePassword(length, CHARACTER_SETS.special.replace('_', ''), 12); }
  while (/administrator/i.test(password));
  return password;
}
