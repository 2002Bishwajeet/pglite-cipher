// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2
export interface Timing { writeMs: number; openMs: number; count: number }
export function newKey(): Promise<CryptoKey>;
export function reset(): Promise<void>;
export function speed(key: CryptoKey, rows: number, word: string): Promise<{ plain: Timing; encrypted: Timing }>;
export interface View {
  records: number;
  found: boolean;
  /** The record shown, its size, and `bytes` taken from offset `start`. */
  key: string;
  size: number;
  start: number;
  bytes: Uint8Array;
  /** The word's [from, to) offsets in the record, when found. */
  match: [number, number] | null;
}
export function proof(word: string): Promise<{ plain: View; encrypted: View }>;
export function storeKeys(n?: number): Promise<{ plain: string[]; encrypted: string[] }>;
export function tamper(
  key: CryptoKey,
): Promise<{ key: string; size: number; offset: number; before: number; after: number; error: string }>;
