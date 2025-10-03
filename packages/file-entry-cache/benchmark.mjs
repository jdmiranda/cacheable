import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { FileEntryCache } from './dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create a temporary directory with test files
const tempDir = path.join(__dirname, '.benchmark-temp');
const cacheDir = path.join(__dirname, '.benchmark-cache');

function setup() {
  // Clean up
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  // Create test files of various sizes
  const fileSizes = {
    small: 1024, // 1KB
    medium: 100 * 1024, // 100KB
    large: 1024 * 1024, // 1MB
    xlarge: 5 * 1024 * 1024, // 5MB
  };

  const files = [];

  for (const [size, bytes] of Object.entries(fileSizes)) {
    for (let i = 0; i < 10; i++) {
      const filename = path.join(tempDir, `${size}-${i}.txt`);
      const content = Buffer.alloc(bytes, 'a');
      fs.writeFileSync(filename, content);
      files.push(filename);
    }
  }

  return files;
}

function cleanup() {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function formatTime(ms) {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(2)} μs`;
  }
  return `${ms.toFixed(2)} ms`;
}

async function benchmark() {
  console.log('File Entry Cache - Performance Benchmarks');
  console.log('==========================================\n');

  const files = setup();

  try {
    // Benchmark 1: Initial file descriptor creation
    console.log('1. Initial file descriptor creation (cold cache)');
    console.log('   Testing with 40 files of various sizes...');

    const cache1 = new FileEntryCache({
      useModifiedTime: true,
      useCheckSum: false,
      cache: {
        cacheId: 'bench1',
        cacheDir: cacheDir,
      },
    });

    const start1 = performance.now();
    for (const file of files) {
      cache1.getFileDescriptor(file);
    }
    const end1 = performance.now();
    const time1 = end1 - start1;

    console.log(`   Time: ${formatTime(time1)}`);
    console.log(`   Avg per file: ${formatTime(time1 / files.length)}`);
    console.log(`   Files/sec: ${Math.round((files.length / time1) * 1000)}\n`);

    // Benchmark 2: Cached file descriptor retrieval
    console.log('2. Cached file descriptor retrieval (warm cache)');
    console.log('   Testing with 40 files...');

    const start2 = performance.now();
    for (const file of files) {
      cache1.getFileDescriptor(file);
    }
    const end2 = performance.now();
    const time2 = end2 - start2;

    console.log(`   Time: ${formatTime(time2)}`);
    console.log(`   Avg per file: ${formatTime(time2 / files.length)}`);
    console.log(`   Files/sec: ${Math.round((files.length / time2) * 1000)}`);
    console.log(`   Speedup: ${(time1 / time2).toFixed(2)}x faster\n`);

    // Benchmark 3: With checksum enabled
    console.log('3. Initial file descriptor with checksums');
    console.log('   Testing with 40 files of various sizes...');

    const cache2 = new FileEntryCache({
      useModifiedTime: true,
      useCheckSum: true,
      cache: {
        cacheId: 'bench2',
        cacheDir: cacheDir,
      },
    });

    const start3 = performance.now();
    for (const file of files) {
      cache2.getFileDescriptor(file);
    }
    const end3 = performance.now();
    const time3 = end3 - start3;

    console.log(`   Time: ${formatTime(time3)}`);
    console.log(`   Avg per file: ${formatTime(time3 / files.length)}`);
    console.log(`   Files/sec: ${Math.round((files.length / time3) * 1000)}\n`);

    // Benchmark 4: Cached with checksums
    console.log('4. Cached file descriptor with checksums');
    console.log('   Testing with 40 files...');

    const start4 = performance.now();
    for (const file of files) {
      cache2.getFileDescriptor(file);
    }
    const end4 = performance.now();
    const time4 = end4 - start4;

    console.log(`   Time: ${formatTime(time4)}`);
    console.log(`   Avg per file: ${formatTime(time4 / files.length)}`);
    console.log(`   Files/sec: ${Math.round((files.length / time4) * 1000)}`);
    console.log(`   Speedup: ${(time3 / time4).toFixed(2)}x faster\n`);

    // Benchmark 5: Large file hashing optimization
    console.log('5. Large file hashing optimization');
    const largeFile = path.join(tempDir, 'very-large.txt');
    const largeContent = Buffer.alloc(10 * 1024 * 1024, 'x'); // 10MB
    fs.writeFileSync(largeFile, largeContent);

    const cache3 = new FileEntryCache({
      useCheckSum: true,
      cache: {
        cacheId: 'bench3',
        cacheDir: cacheDir,
      },
    });

    const start5 = performance.now();
    cache3.getFileDescriptor(largeFile);
    const end5 = performance.now();
    const time5 = end5 - start5;

    console.log(`   10MB file hashing time: ${formatTime(time5)}`);
    console.log(`   Throughput: ${formatBytes((10 * 1024 * 1024) / (time5 / 1000))}/sec\n`);

    // Benchmark 6: Cache save/load performance
    console.log('6. Cache persistence performance');

    const cache4 = new FileEntryCache({
      useModifiedTime: true,
      cache: {
        cacheId: 'bench4',
        cacheDir: cacheDir,
      },
    });

    // Populate cache
    for (const file of files) {
      cache4.getFileDescriptor(file);
    }

    const startSave = performance.now();
    cache4.reconcile();
    const endSave = performance.now();
    const timeSave = endSave - startSave;

    console.log(`   Save time (40 entries): ${formatTime(timeSave)}`);

    // Load cache
    const cache5 = new FileEntryCache({
      useModifiedTime: true,
      cache: {
        cacheId: 'bench4',
        cacheDir: cacheDir,
      },
    });

    const startLoad = performance.now();
    cache5.cache.load('bench4', cacheDir);
    const endLoad = performance.now();
    const timeLoad = endLoad - startLoad;

    console.log(`   Load time (40 entries): ${formatTime(timeLoad)}\n`);

    // Summary
    console.log('Summary of Optimizations');
    console.log('========================');
    console.log('1. Optimized file stat operations using mtimeMs');
    console.log('2. Efficient change detection with combined boolean operations');
    console.log('3. Streaming hash for large files (>1MB) with 64KB chunks');
    console.log('4. Map-based cache storage via underlying CacheableMemory');
    console.log('5. LRU eviction available via cache configuration\n');

    console.log('Performance Metrics');
    console.log('===================');
    console.log(`Cold cache performance: ${Math.round((files.length / time1) * 1000)} files/sec`);
    console.log(`Warm cache performance: ${Math.round((files.length / time2) * 1000)} files/sec`);
    console.log(`Cache hit speedup: ${(time1 / time2).toFixed(2)}x`);
    console.log(`Checksum overhead: ${((time3 - time1) / time1 * 100).toFixed(2)}%`);
    console.log(`Large file hashing: ${formatBytes((10 * 1024 * 1024) / (time5 / 1000))}/sec`);

  } finally {
    cleanup();
  }
}

benchmark().catch(console.error);
