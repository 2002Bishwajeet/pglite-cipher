// Copyright 2026 Bishwajeet Parhi
// SPDX-License-Identifier: FSL-1.1-ALv2

import { MemoryBackend } from '../../src/backend/memory.ts';
import { runBackendConformance } from '../../src/backend/conformance.ts';

runBackendConformance('MemoryBackend', () => new MemoryBackend());
