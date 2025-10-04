import { performance } from "node:perf_hooks";
import { FlatCache } from "./src/index.js";

interface BenchmarkResult {
	name: string;
	opsPerSecond: number;
	avgTimeMs: number;
	totalTimeMs: number;
}

function benchmark(name: string, fn: () => void, iterations = 10000): BenchmarkResult {
	// Warmup
	for (let i = 0; i < 100; i++) {
		fn();
	}

	// Actual benchmark
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		fn();
	}
	const end = performance.now();

	const totalTime = end - start;
	const avgTime = totalTime / iterations;
	const opsPerSecond = (iterations / totalTime) * 1000;

	return {
		name,
		opsPerSecond: Math.round(opsPerSecond),
		avgTimeMs: Number(avgTime.toFixed(6)),
		totalTimeMs: Number(totalTime.toFixed(2)),
	};
}

async function runBenchmarks() {
	console.log("=".repeat(80));
	console.log("Flat-Cache Performance Benchmark");
	console.log("=".repeat(80));
	console.log();

	const results: BenchmarkResult[] = [];

	// Initialize cache
	const cache = new FlatCache({
		cacheDir: ".cache-benchmark",
		cacheId: "benchmark-test",
		inMemoryLruSize: 1000,
	});

	// Benchmark 1: Set operations (cold cache)
	let counter = 0;
	results.push(
		benchmark("set() - cold cache", () => {
			cache.set(`key-${counter++}`, { data: `value-${counter}` });
		}),
	);

	// Benchmark 2: Get operations (warm LRU cache - recent hits)
	counter = 0;
	results.push(
		benchmark("get() - LRU warm (fast path)", () => {
			cache.get(`key-${counter++ % 100}`); // Access same 100 keys repeatedly
		}),
	);

	// Benchmark 3: Get operations (LRU miss, main cache hit)
	counter = 0;
	results.push(
		benchmark("get() - LRU miss (slow path)", () => {
			cache.get(`key-${counter++ + 5000}`); // Access keys beyond LRU capacity
		}),
	);

	// Benchmark 4: Mixed operations (70% reads, 30% writes)
	counter = 0;
	results.push(
		benchmark("mixed operations (70/30 read/write)", () => {
			const n = counter++;
			if (n % 10 < 7) {
				cache.get(`key-${n % 500}`);
			} else {
				cache.set(`key-${n}`, { data: `value-${n}` });
			}
		}),
	);

	// Benchmark 5: Delete operations
	counter = 0;
	results.push(
		benchmark("delete()", () => {
			cache.delete(`key-${counter++}`);
		}, 5000),
	);

	// Benchmark 6: Batch set operations
	results.push(
		benchmark("batch set (10 items)", () => {
			for (let i = 0; i < 10; i++) {
				cache.set(`batch-key-${counter++}`, { data: `value-${counter}` });
			}
		}, 1000),
	);

	// Benchmark 7: Serialization (save)
	cache.clear();
	for (let i = 0; i < 1000; i++) {
		cache.set(`save-key-${i}`, { data: `value-${i}`, timestamp: Date.now() });
	}
	results.push(
		benchmark(
			"save() - 1000 items",
			() => {
				cache.save(true);
			},
			100,
		),
	);

	// Benchmark 8: Deserialization (load)
	cache.save(true);
	results.push(
		benchmark(
			"load() - 1000 items",
			() => {
				cache.load("benchmark-test", ".cache-benchmark");
			},
			100,
		),
	);

	// Benchmark 9: LRU eviction performance
	const lruCache = new FlatCache({
		cacheDir: ".cache-lru-test",
		cacheId: "lru-test",
		inMemoryLruSize: 100,
	});
	counter = 0;
	results.push(
		benchmark("LRU eviction (100 capacity)", () => {
			lruCache.set(`evict-key-${counter++}`, { data: `value-${counter}` });
		}),
	);

	// Print results
	console.log("Results:");
	console.log("-".repeat(80));
	console.log(
		`${"Operation".padEnd(40)} ${"Ops/sec".padStart(12)} ${"Avg (ms)".padStart(12)} ${"Total (ms)".padStart(12)}`,
	);
	console.log("-".repeat(80));

	for (const result of results) {
		console.log(
			`${result.name.padEnd(40)} ${result.opsPerSecond.toLocaleString().padStart(12)} ${result.avgTimeMs.toString().padStart(12)} ${result.totalTimeMs.toString().padStart(12)}`,
		);
	}

	console.log("-".repeat(80));
	console.log();

	// Cleanup
	cache.destroy(true);
	lruCache.destroy(true);

	// Performance summary
	const avgOps =
		results.reduce((sum, r) => sum + r.opsPerSecond, 0) / results.length;
	console.log("Summary:");
	console.log(`  Average throughput: ${Math.round(avgOps).toLocaleString()} ops/sec`);
	console.log(`  Total benchmarks: ${results.length}`);
	console.log();

	// Key optimizations summary
	console.log("Optimizations Implemented:");
	console.log("  1. In-memory LRU layer (1000 entries default) for fast path");
	console.log("  2. Serialization result caching to avoid re-serializing");
	console.log("  3. Batch write optimization with configurable size/delay");
	console.log("  4. Fast paths for recent cache hits via LRU");
	console.log();

	console.log("=".repeat(80));
}

runBenchmarks().catch(console.error);
