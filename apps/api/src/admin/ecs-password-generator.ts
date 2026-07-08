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

export function generateAliyunEcsPassword(length = DEFAULT_PASSWORD_LENGTH) {
  const normalizedLength = Math.min(
    Math.max(normalizePasswordLength(length), MIN_PASSWORD_LENGTH),
    MAX_PASSWORD_LENGTH,
  );
  const requiredSets = [CHARACTER_SETS.uppercase, CHARACTER_SETS.lowercase, CHARACTER_SETS.numbers];
  const allCharacters = Object.values(CHARACTER_SETS).join('');
  const passwordCharacters = requiredSets.map((characters) => pickRandomCharacter(characters));

  while (passwordCharacters.length < normalizedLength) {
    passwordCharacters.push(pickRandomCharacter(allCharacters));
  }

  return shuffleCharacters(passwordCharacters).join('');
}
