import { MemoryBackend } from '../../src/backend/memory.ts';
import { runBackendConformance } from '../../src/backend/conformance.ts';

runBackendConformance('MemoryBackend', () => new MemoryBackend());
