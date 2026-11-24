// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0

let n = 0;
export const freshName = (): string => `t${String(++n)}-${Math.random().toString(36).slice(2)}`;
