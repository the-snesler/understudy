import fs from 'node:fs';
import path from 'node:path';

/**
 * A JSON document on disk. Reads are from memory; writes are atomic (temp file + rename), serialised,
 * and private to the owner (mode 600) because the files hold API keys and OAuth tokens.
 */
export class JsonStore<T> {
  private value: T;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    defaults: () => T,
  ) {
    this.value = JsonStore.read(file) ?? defaults();
  }

  private static read<T>(file: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`Could not read ${file}: ${(err as Error).message}`);
    }
  }

  get(): T {
    return this.value;
  }

  /** Replace the document via `fn` and persist it. Resolves once written. */
  update(fn: (current: T) => T): Promise<void> {
    this.value = fn(this.value);
    const snapshot = JSON.stringify(this.value, null, 2) + '\n';
    this.writing = this.writing.then(() => this.write(snapshot));
    return this.writing;
  }

  private async write(contents: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, contents, { mode: 0o600 });
    await fs.promises.rename(tmp, this.file);
  }
}

/** A per-instance slice of a shared store, keyed by instance id. */
export class ScopedState<T> {
  constructor(
    private readonly store: JsonStore<Record<string, unknown>>,
    private readonly key: string,
  ) {}

  get(): T | undefined {
    return this.store.get()[this.key] as T | undefined;
  }

  set(value: T | undefined): Promise<void> {
    return this.store.update((all) => {
      const next = { ...all };
      if (value === undefined) delete next[this.key];
      else next[this.key] = value;
      return next;
    });
  }
}
