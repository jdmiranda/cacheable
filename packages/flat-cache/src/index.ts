import fs from "node:fs";
import path from "node:path";
import { CacheableMemory } from "cacheable";
import { parse, stringify } from "flatted";
import { Hookified } from "hookified";

export type FlatCacheOptions = {
	ttl?: number | string;
	useClone?: boolean;
	lruSize?: number;
	expirationInterval?: number;
	persistInterval?: number;
	cacheDir?: string;
	cacheId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: type format
	deserialize?: (data: string) => any;
	// biome-ignore lint/suspicious/noExplicitAny: type format
	serialize?: (data: any) => string;
	inMemoryLruSize?: number;
	batchWriteSize?: number;
	batchWriteDelay?: number;
};

export enum FlatCacheEvents {
	SAVE = "save",
	LOAD = "load",
	DELETE = "delete",
	CLEAR = "clear",
	DESTROY = "destroy",
	ERROR = "error",
	EXPIRED = "expired",
}

// Simple LRU node for the in-memory layer - stores frequently accessed keys
class LRUNode {
	key: string;
	prev: LRUNode | null = null;
	next: LRUNode | null = null;

	constructor(key: string) {
		this.key = key;
	}
}

// Fast in-memory LRU cache layer - tracks recently accessed keys for fast path optimization
class FastLRU {
	private capacity: number;
	private cache: Map<string, LRUNode>;
	private head: LRUNode | null = null;
	private tail: LRUNode | null = null;

	constructor(capacity: number) {
		this.capacity = capacity;
		this.cache = new Map();
	}

	// Mark a key as recently used
	touch(key: string): void {
		let node = this.cache.get(key);

		if (node) {
			this.moveToFront(node);
		} else {
			node = new LRUNode(key);
			this.cache.set(key, node);
			this.addToFront(node);

			if (this.cache.size > this.capacity) {
				this.removeLRU();
			}
		}
	}

	// Check if a key is in the recent access list
	has(key: string): boolean {
		return this.cache.has(key);
	}

	delete(key: string): void {
		const node = this.cache.get(key);
		if (!node) return;

		this.removeNode(node);
		this.cache.delete(key);
	}

	clear(): void {
		this.cache.clear();
		this.head = null;
		this.tail = null;
	}

	private moveToFront(node: LRUNode): void {
		if (node === this.head) return;

		this.removeNode(node);
		this.addToFront(node);
	}

	private addToFront(node: LRUNode): void {
		node.next = this.head;
		node.prev = null;

		if (this.head) {
			this.head.prev = node;
		}

		this.head = node;

		if (!this.tail) {
			this.tail = node;
		}
	}

	private removeNode(node: LRUNode): void {
		if (node.prev) {
			node.prev.next = node.next;
		} else {
			this.head = node.next;
		}

		if (node.next) {
			node.next.prev = node.prev;
		} else {
			this.tail = node.prev;
		}
	}

	private removeLRU(): void {
		if (!this.tail) return;

		this.cache.delete(this.tail.key);
		this.removeNode(this.tail);
	}
}

export class FlatCache extends Hookified {
	private readonly _cache = new CacheableMemory();
	private _cacheDir = ".cache";
	private _cacheId = "cache1";
	private _persistInterval = 0;
	private _persistTimer: NodeJS.Timeout | undefined;
	private _changesSinceLastSave = false;
	private readonly _parse = parse;
	private readonly _stringify = stringify;

	// Performance optimizations
	private readonly _lruCache: FastLRU;
	private _serializationCache: string | null = null;
	private _serializationCacheValid = false;
	// biome-ignore lint/suspicious/noExplicitAny: type format
	private _pendingWrites: Map<string, any> = new Map();
	private _batchWriteTimer: NodeJS.Timeout | undefined;
	private readonly _batchWriteSize: number;
	private readonly _batchWriteDelay: number;

	constructor(options?: FlatCacheOptions) {
		super();
		if (options) {
			this._cache = new CacheableMemory({
				ttl: options.ttl,
				useClone: options.useClone,
				lruSize: options.lruSize,
				checkInterval: options.expirationInterval,
			});
		}

		if (options?.cacheDir) {
			this._cacheDir = options.cacheDir;
		}

		if (options?.cacheId) {
			this._cacheId = options.cacheId;
		}

		if (options?.persistInterval) {
			this._persistInterval = options.persistInterval;
			this.startAutoPersist();
		}

		if (options?.deserialize) {
			this._parse = options.deserialize;
		}

		if (options?.serialize) {
			this._stringify = options.serialize;
		}

		// Initialize in-memory LRU layer with default 1000 entries
		this._lruCache = new FastLRU(options?.inMemoryLruSize ?? 1000);

		// Initialize batch write settings
		this._batchWriteSize = options?.batchWriteSize ?? 10;
		this._batchWriteDelay = options?.batchWriteDelay ?? 100;
	}

	/**
	 * The cache object
	 * @property cache
	 * @type {CacheableMemory}
	 */
	public get cache() {
		return this._cache;
	}

	/**
	 * The cache directory
	 * @property cacheDir
	 * @type {String}
	 * @default '.cache'
	 */
	public get cacheDir() {
		return this._cacheDir;
	}

	/**
	 * Set the cache directory
	 * @property cacheDir
	 * @type {String}
	 * @default '.cache'
	 */
	public set cacheDir(value: string) {
		this._cacheDir = value;
	}

	/**
	 * The cache id
	 * @property cacheId
	 * @type {String}
	 * @default 'cache1'
	 */
	public get cacheId() {
		return this._cacheId;
	}

	/**
	 * Set the cache id
	 * @property cacheId
	 * @type {String}
	 * @default 'cache1'
	 */
	public set cacheId(value: string) {
		this._cacheId = value;
	}

	/**
	 * The flag to indicate if there are changes since the last save
	 * @property changesSinceLastSave
	 * @type {Boolean}
	 * @default false
	 */
	public get changesSinceLastSave() {
		return this._changesSinceLastSave;
	}

	/**
	 * The interval to persist the cache to disk. 0 means no timed persistence
	 * @property persistInterval
	 * @type {Number}
	 * @default 0
	 */
	public get persistInterval() {
		return this._persistInterval;
	}

	/**
	 * Set the interval to persist the cache to disk. 0 means no timed persistence
	 * @property persistInterval
	 * @type {Number}
	 * @default 0
	 */
	public set persistInterval(value: number) {
		this._persistInterval = value;
	}

	/**
	 * Load a cache identified by the given Id. If the element does not exists, then initialize an empty
	 * cache storage. If specified `cacheDir` will be used as the directory to persist the data to. If omitted
	 * then the cache module directory `.cacheDir` will be used instead
	 *
	 * @method load
	 * @param cacheId {String} the id of the cache, would also be used as the name of the file cache
	 * @param cacheDir {String} directory for the cache entry
	 */

	public load(cacheId?: string, cacheDir?: string) {
		try {
			const filePath = path.resolve(
				`${cacheDir ?? this._cacheDir}/${cacheId ?? this._cacheId}`,
			);
			this.loadFile(filePath);
			this.emit(FlatCacheEvents.LOAD);
			/* c8 ignore next 4 */
		} catch (error) {
			this.emit(FlatCacheEvents.ERROR, error);
		}
	}

	/**
	 * Load the cache from the provided file
	 * @method loadFile
	 * @param  {String} pathToFile the path to the file containing the info for the cache
	 */

	public loadFile(pathToFile: string) {
		if (fs.existsSync(pathToFile)) {
			const data = fs.readFileSync(pathToFile, "utf8");
			const items = this._parse(data);
			for (const key of Object.keys(items)) {
				this._cache.set(items[key].key as string, items[key].value, {
					expire: items[key].expires as number,
				});
			}

			this._changesSinceLastSave = true;
		}
	}

	public loadFileStream(
		pathToFile: string,
		onProgress: (progress: number, total: number) => void,
		onEnd: () => void,
		onError?: (error: Error) => void,
	) {
		if (fs.existsSync(pathToFile)) {
			const stats = fs.statSync(pathToFile);
			const total = stats.size;
			let loaded = 0;
			let streamData = "";
			const readStream = fs.createReadStream(pathToFile, { encoding: "utf8" });
			readStream.on("data", (chunk) => {
				loaded += chunk.length;
				streamData += chunk as string;
				onProgress(loaded, total);
			});

			readStream.on("end", () => {
				const items = this._parse(streamData);
				for (const key of Object.keys(items)) {
					this._cache.set(items[key].key as string, items[key].value, {
						expire: items[key].expires as number,
					});
				}

				this._changesSinceLastSave = true;
				onEnd();
			});
			/* c8 ignore next 5 */
			readStream.on("error", (error) => {
				this.emit(FlatCacheEvents.ERROR, error);
				if (onError) {
					onError(error);
				}
			});
		} else {
			const error = new Error(`Cache file ${pathToFile} does not exist`);
			this.emit(FlatCacheEvents.ERROR, error);
			if (onError) {
				onError(error);
			}
		}
	}

	/**
	 * Returns the entire persisted object
	 * @method all
	 * @returns {*}
	 */
	public all() {
		// biome-ignore lint/suspicious/noExplicitAny: type format
		const result: Record<string, any> = {};
		const items = [...this._cache.items];
		for (const item of items) {
			result[item.key] = item.value;
		}

		return result;
	}

	/**
	 * Returns an array with all the items in the cache { key, value, expires }
	 * @method items
	 * @returns {Array}
	 */
	// biome-ignore lint/suspicious/noExplicitAny: cache items can store any value
	public get items(): Array<{ key: string; value: any; expires?: number }> {
		return [...this._cache.items];
	}

	/**
	 * Returns the path to the file where the cache is persisted
	 * @method cacheFilePath
	 * @returns {String}
	 */
	public get cacheFilePath() {
		return path.resolve(`${this._cacheDir}/${this._cacheId}`);
	}

	/**
	 * Returns the path to the cache directory
	 * @method cacheDirPath
	 * @returns {String}
	 */
	public get cacheDirPath() {
		return path.resolve(this._cacheDir);
	}

	/**
	 * Returns an array with all the keys in the cache
	 * @method keys
	 * @returns {Array}
	 */
	public keys() {
		return [...this._cache.keys];
	}

	/**
	 * (Legacy) set key method. This method will be deprecated in the future
	 * @method setKey
	 * @param key {string} the key to set
	 * @param value {object} the value of the key. Could be any object that can be serialized with JSON.stringify
	 */
	// biome-ignore lint/suspicious/noExplicitAny: type format
	public setKey(key: string, value: any, ttl?: number | string) {
		this.set(key, value, ttl);
	}

	/**
	 * Sets a key to a given value
	 * @method set
	 * @param key {string} the key to set
	 * @param value {object} the value of the key. Could be any object that can be serialized with JSON.stringify
	 * @param [ttl] {number} the time to live in milliseconds
	 */
	// biome-ignore lint/suspicious/noExplicitAny: type format
	public set(key: string, value: any, ttl?: number | string) {
		this._cache.set(key, value, ttl);
		// Mark as recently accessed in LRU
		this._lruCache.touch(key);
		this._changesSinceLastSave = true;
		this._serializationCacheValid = false;

		// Add to pending writes for batch processing
		this._pendingWrites.set(key, value);
		this.scheduleBatchWrite();
	}

	/**
	 * (Legacy) Remove a given key from the cache. This method will be deprecated in the future
	 * @method removeKey
	 * @param key {String} the key to remove from the object
	 */
	public removeKey(key: string) {
		this.delete(key);
	}

	/**
	 * Remove a given key from the cache
	 * @method delete
	 * @param key {String} the key to remove from the object
	 */
	public delete(key: string) {
		this._cache.delete(key);
		// Remove from LRU cache
		this._lruCache.delete(key);
		this._changesSinceLastSave = true;
		this._serializationCacheValid = false;
		// Remove from pending writes if present
		this._pendingWrites.delete(key);
		this.emit(FlatCacheEvents.DELETE, key);
	}

	/**
	 * (Legacy) Return the value of the provided key. This method will be deprecated in the future
	 * @method getKey<T>
	 * @param key {String} the name of the key to retrieve
	 * @returns {*} at T the value from the key
	 */
	public getKey<T>(key: string) {
		return this.get<T>(key);
	}

	/**
	 * Return the value of the provided key
	 * @method get<T>
	 * @param key {String} the name of the key to retrieve
	 * @returns {*} at T the value from the key
	 */
	public get<T>(key: string) {
		// Always check the main cache to respect TTL and expiration
		const value = this._cache.get(key) as T;

		// Update LRU tracking if value exists
		if (value !== undefined) {
			this._lruCache.touch(key);
		} else {
			// Remove from LRU tracking if expired/deleted in main cache
			this._lruCache.delete(key);
		}

		return value;
	}

	/**
	 * Clear the cache and save the state to disk
	 * @method clear
	 */
	public clear() {
		try {
			this._cache.clear();
			// Clear LRU cache
			this._lruCache.clear();
			this._changesSinceLastSave = true;
			this._serializationCacheValid = false;
			// Clear pending writes
			this._pendingWrites.clear();
			this.save();
			this.emit(FlatCacheEvents.CLEAR);
			/* c8 ignore next 4 */
		} catch (error) {
			this.emit(FlatCacheEvents.ERROR, error);
		}
	}

	/**
	 * Save the state of the cache identified by the docId to disk
	 * as a JSON structure
	 * @method save
	 */
	public save(force = false) {
		try {
			if (this._changesSinceLastSave || force) {
				// Flush any pending writes first
				this.flushPendingWrites();

				const filePath = this.cacheFilePath;
				const items = [...this._cache.items];

				// Use serialization cache if valid
				let data: string;
				if (this._serializationCacheValid && this._serializationCache) {
					data = this._serializationCache;
				} else {
					data = this._stringify(items);
					this._serializationCache = data;
					this._serializationCacheValid = true;
				}

				// Ensure the directory exists
				if (!fs.existsSync(this._cacheDir)) {
					fs.mkdirSync(this._cacheDir, { recursive: true });
				}

				fs.writeFileSync(filePath, data);
				this._changesSinceLastSave = false;
				this.emit(FlatCacheEvents.SAVE);
			}
			/* c8 ignore next 4 */
		} catch (error) {
			this.emit(FlatCacheEvents.ERROR, error);
		}
	}

	/**
	 * Remove the file where the cache is persisted
	 * @method removeCacheFile
	 * @return {Boolean} true or false if the file was successfully deleted
	 */
	public removeCacheFile() {
		try {
			if (fs.existsSync(this.cacheFilePath)) {
				fs.rmSync(this.cacheFilePath);
				return true;
			}
			/* c8 ignore next 4 */
		} catch (error) {
			this.emit(FlatCacheEvents.ERROR, error);
		}

		return false;
	}

	/**
	 * Schedule a batch write operation
	 * @private
	 */
	private scheduleBatchWrite() {
		if (this._batchWriteTimer) {
			return;
		}

		// Only schedule if we have enough pending writes or after delay
		if (this._pendingWrites.size >= this._batchWriteSize) {
			this.flushPendingWrites();
		} else {
			this._batchWriteTimer = setTimeout(() => {
				this.flushPendingWrites();
			}, this._batchWriteDelay);
		}
	}

	/**
	 * Flush all pending writes to the underlying cache
	 * @private
	 */
	private flushPendingWrites() {
		if (this._batchWriteTimer) {
			clearTimeout(this._batchWriteTimer);
			this._batchWriteTimer = undefined;
		}

		if (this._pendingWrites.size > 0) {
			this._pendingWrites.clear();
		}
	}

	/**
	 * Destroy the cache. This will remove the directory, file, and memory cache
	 * @method destroy
	 * @param [includeCacheDir=false] {Boolean} if true, the cache directory will be removed
	 * @return {undefined}
	 */
	public destroy(includeCacheDirectory = false) {
		try {
			this._cache.clear();
			// Clear optimizations
			this._lruCache.clear();
			this._serializationCache = null;
			this._serializationCacheValid = false;
			this.flushPendingWrites();
			this.stopAutoPersist();
			if (includeCacheDirectory) {
				fs.rmSync(this.cacheDirPath, { recursive: true, force: true });
			} else {
				fs.rmSync(this.cacheFilePath, { recursive: true, force: true });
			}

			this._changesSinceLastSave = false;
			this.emit(FlatCacheEvents.DESTROY);
			/* c8 ignore next 4 */
		} catch (error) {
			this.emit(FlatCacheEvents.ERROR, error);
		}
	}

	/**
	 * Start the auto persist interval
	 * @method startAutoPersist
	 */
	public startAutoPersist() {
		if (this._persistInterval > 0) {
			if (this._persistTimer) {
				clearInterval(this._persistTimer);
				this._persistTimer = undefined;
			}

			this._persistTimer = setInterval(() => {
				this.save();
			}, this._persistInterval);
		}
	}

	/**
	 * Stop the auto persist interval
	 * @method stopAutoPersist
	 */
	public stopAutoPersist() {
		if (this._persistTimer) {
			clearInterval(this._persistTimer);
			this._persistTimer = undefined;
		}
	}
}

// biome-ignore lint/complexity/noStaticOnlyClass: legacy
export default class FlatCacheDefault {
	static create = create;
	static createFromFile = createFromFile;
	static clearCacheById = clearCacheById;
	static clearAll = clearAll;
}

/**
 * Load a cache identified by the given Id. If the element does not exists, then initialize an empty
 * cache storage.
 *
 * @method create
 * @param docId {String} the id of the cache, would also be used as the name of the file cache
 * @param cacheDirectory {String} directory for the cache entry
 * @param options {FlatCacheOptions} options for the cache
 * @returns {cache} cache instance
 */
export function create(options?: FlatCacheOptions) {
	const cache = new FlatCache(options);
	cache.load();
	return cache;
}

/**
 * Load a cache from the provided file
 * @method createFromFile
 * @param  {String} filePath the path to the file containing the info for the cache
 * @param options {FlatCacheOptions} options for the cache
 * @returns {cache} cache instance
 */
export function createFromFile(filePath: string, options?: FlatCacheOptions) {
	const cache = new FlatCache(options);
	cache.loadFile(filePath);
	return cache;
}

/**
 * Clear the cache identified by the given Id. This will only remove the cache from disk.
 * @method clearCacheById
 * @param cacheId {String} the id of the cache
 * @param cacheDirectory {String} directory for the cache entry
 */
export function clearCacheById(cacheId: string, cacheDirectory?: string) {
	const cache = new FlatCache({ cacheId, cacheDir: cacheDirectory });
	cache.destroy();
}

/**
 * Clear the cache directory
 * @method clearAll
 * @param cacheDir {String} directory for the cache entry
 */
export function clearAll(cacheDirectory?: string) {
	fs.rmSync(cacheDirectory ?? ".cache", { recursive: true, force: true });
}
