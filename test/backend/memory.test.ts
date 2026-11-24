// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: Apache-2.0

import { MemoryBackend } from '../../src/backend/memory.ts';
import { runBackendConformance } from '../../src/backend/conformance.ts';

runBackendConformance('MemoryBackend', () => new MemoryBackend());
