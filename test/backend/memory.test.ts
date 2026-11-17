// The conformance suite on the in-memory backend.
import { MemoryBackend } from '../../src/backend/memory.ts';
import { runBackendConformance } from '../../src/backend/conformance.ts';

runBackendConformance('MemoryBackend', () => new MemoryBackend());
