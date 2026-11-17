// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
export interface Timing { writeMs: number; openMs: number; count: number }
export function newKey(): Promise<CryptoKey>;
export function reset(): Promise<void>;
export function speed(key: CryptoKey, rows: number, word: string): Promise<{ plain: Timing; encrypted: Timing }>;
export function proof(word: string): Promise<{
  plain: { records: number; found: boolean };
  encrypted: { records: number; found: boolean; sample: string };
}>;
export function tamper(key: CryptoKey): Promise<string>;
